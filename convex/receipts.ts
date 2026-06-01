/**
 * Receipt queries — Story 3.11 (FR28, NFR-C1).
 *
 * Read-side surface for the BIR-compliant receipt display. The
 * Story 3.2 cornerstone (`convex/lib/postFinancialEvent.ts`) is the
 * single writer of the `receipts` table — this file is the
 * single reader for the UI's needs. No mutations live here.
 *
 * Why a dedicated `receipts.ts` instead of folding into `contracts.ts`:
 *   - Receipts are the BIR-facing legal artifact; their access policy
 *     is more conservative than contracts (admin + office_staff only;
 *     no field_worker access — field workers don't see money).
 *   - The list view paginates by `_creationTime`, not by `createdAt`,
 *     because receipts have no `createdAt` field (the cornerstone
 *     uses `issuedAt` as the time-of-record). Keeping the index/sort
 *     concerns isolated from contracts simplifies the read path.
 *   - The Phase-1 story focuses on display; future stories
 *     (3.12 void receipt UI, 3.13 PDF render + email) will extend
 *     this file rather than touching `contracts.ts`. Better module
 *     boundary.
 *
 * Auth contract: every public handler calls `requireRole(ctx, ["admin",
 * "office_staff"])` as its first awaited statement (the
 * `require-role-first-line` ESLint rule enforces this). The cornerstone
 * is the auth-checked writer of receipts; reads must match its
 * privilege gate or stricter.
 *
 * Format contract: the receipt row carries the `receiptNumber`
 * (formatted `OR-0000123`) and the integer `receiptSerial`. This file
 * NEVER re-formats from the integer — `formatSerial` is called only
 * inside the cornerstone (Story 3.1's `convex/lib/receiptCounter.ts`),
 * and downstream consumers read the pre-formatted string. AC4 of the
 * parent story locks this; the rule extends to the display layer
 * here.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import {
  requireRole,
  type MutationCtx,
  type QueryCtx,
} from "./lib/auth";
import {
  BIR_CONFIG_IS_PLACEHOLDER,
  PLACEHOLDER_BIR_CONFIG,
  loadBirReceiptConfig,
  type BirReceiptConfig,
  type BirReceiptConfigRow,
} from "./lib/birFormat";
import { ErrorCode, throwError } from "./lib/errors";
import { postFinancialEvent } from "./lib/postFinancialEvent";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ReceiptDoc = DataModel["receipts"]["document"];
type ReceiptId = ReceiptDoc["_id"];
type PaymentDoc = DataModel["payments"]["document"];
type PaymentAllocationDoc = DataModel["paymentAllocations"]["document"];

/** Default + ceiling for `listReceipts` pagination. */
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/**
 * Row shape returned by `listReceipts`. Intentionally narrow — the
 * list view shows the receipt number, issued-at, amount, customer
 * name, and void state; the detail page (`getReceipt`) hydrates the
 * rest (payment method, line-item allocations, BIR template, etc.).
 */
export interface ReceiptListRow {
  receiptId: ReceiptId;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  customerId: string | null;
  customerFullName: string | null;
  contractId: string | null;
  contractNumber: string | null;
  isVoided: boolean;
  voidedAt: number | null;
}

/**
 * Detail shape returned by `getReceipt`. Carries everything the
 * `ReceiptDisplay` component needs to render the BIR-formatted OR:
 *
 *   - the receipt's own fields (serial, amount, issued-at, void state)
 *   - the payment that issued it (method, reference, received-by user
 *     name)
 *   - the customer it was issued to (full name + address)
 *   - the contract it relates to (number + lot code via a hop)
 *   - the per-row allocations (line items)
 *   - the BIR template config (placeholder until §10 Q3 lands)
 *
 * One round-trip on the client; the query collects everything in a
 * single Convex transaction.
 */
export interface ReceiptDetail {
  receiptId: ReceiptId;
  receiptSeries: string;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  isVoided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  voidedByName: string | null;

  customer: {
    customerId: string | null;
    fullName: string | null;
    addressLine1: string | null;
    addressBarangay: string | null;
    addressCityMunicipality: string | null;
    addressProvince: string | null;
    addressPostalCode: string | null;
  };

  payment: {
    paymentId: string;
    paymentMethod: PaymentDoc["paymentMethod"];
    reference: string | null;
    receivedAt: number;
    receivedByName: string | null;
  };

  contract: {
    contractId: string | null;
    contractNumber: string | null;
    lotCode: string | null;
  };

  allocations: Array<{
    targetType: PaymentAllocationDoc["targetType"];
    targetId: string;
    amountCents: number;
    sequence: number;
    note: string | null;
  }>;

  template: BirReceiptConfig;
  templateIsPlaceholder: boolean;
}

/**
 * Lookup a single receipt by id, fully hydrated for the detail
 * surface. Returns `null` when the receipt is not found so the UI can
 * render a graceful "not found" without surfacing an error code.
 *
 * Restricted to admin + office_staff. Field workers never see money;
 * customer access (Epic 9) is a separate query with its own
 * "is-this-receipt-mine" guard.
 */
export const getReceipt = queryGeneric({
  args: { receiptId: v.id("receipts") },
  handler: async (
    ctx: QueryCtx,
    args: { receiptId: ReceiptId },
  ): Promise<ReceiptDetail | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      return null;
    }

    // Hydrate the payment row. The cornerstone wrote them together so
    // the payment is always present; defensive `null` handling stays
    // so a corrupted ledger doesn't crash the UI.
    const payment = await ctx.db.get(receipt.paymentId);

    // Hydrate the customer record. `customerId` is stored as a string
    // on the receipt (the schema field is `v.optional(v.string())`),
    // so the get-by-id call goes through the schema's dynamic
    // resolution — return `null` when the customer was deleted post-
    // issuance (the receipt remains a legal record).
    let customerDoc: DataModel["customers"]["document"] | null = null;
    if (receipt.customerId !== undefined) {
      customerDoc = (await ctx.db.get(
        receipt.customerId as DataModel["customers"]["document"]["_id"],
      )) ?? null;
    }

    // Hydrate the contract row. Same nullable handling as customer.
    let contractDoc: DataModel["contracts"]["document"] | null = null;
    if (receipt.contractId !== undefined) {
      contractDoc = (await ctx.db.get(
        receipt.contractId as DataModel["contracts"]["document"]["_id"],
      )) ?? null;
    }

    // Hydrate the lot off the contract (for the lot code on the
    // receipt — useful audit context).
    let lotCode: string | null = null;
    if (contractDoc !== null) {
      const lot = await ctx.db.get(contractDoc.lotId);
      lotCode = lot?.code ?? null;
    }

    // Hydrate the received-by user (display only — used in the audit
    // sub-section under the OR body).
    let receivedByName: string | null = null;
    if (payment !== null) {
      const u = await ctx.db.get(payment.receivedByUserId);
      receivedByName = userDisplayName(u);
    }

    // Hydrate the voided-by user when present.
    let voidedByName: string | null = null;
    if (receipt.isVoided && receipt.voidedByUserId !== undefined) {
      const u = await ctx.db.get(receipt.voidedByUserId);
      voidedByName = userDisplayName(u);
    }

    // Collect allocations. The `by_payment` index returns them in
    // insertion order; we re-sort defensively on `sequence` so the
    // line items render in the cornerstone-assigned order regardless
    // of how Convex's index iterates.
    const allocations = (
      await ctx.db
        .query("paymentAllocations")
        .withIndex("by_payment", (q) => q.eq("paymentId", receipt.paymentId))
        .collect()
    )
      .slice()
      .sort((a, b) => a.sequence - b.sequence);

    return {
      receiptId: receipt._id,
      receiptSeries: receipt.receiptSeries,
      receiptNumber: receipt.receiptNumber,
      receiptSerial: receipt.receiptSerial,
      issuedAt: receipt.issuedAt,
      amountCents: receipt.amountCents,
      isVoided: receipt.isVoided,
      voidedAt: receipt.voidedAt ?? null,
      voidReason: receipt.voidReason ?? null,
      voidedByName,

      customer: {
        customerId: receipt.customerId ?? null,
        fullName: customerDoc?.fullName ?? null,
        addressLine1: customerDoc?.address.line1 ?? null,
        addressBarangay: customerDoc?.address.barangay ?? null,
        addressCityMunicipality:
          customerDoc?.address.cityMunicipality ?? null,
        addressProvince: customerDoc?.address.province ?? null,
        addressPostalCode: customerDoc?.address.postalCode ?? null,
      },

      payment: {
        paymentId: payment?._id ?? receipt.paymentId,
        paymentMethod: payment?.paymentMethod ?? "cash",
        reference: payment?.reference ?? null,
        receivedAt: payment?.receivedAt ?? receipt.issuedAt,
        receivedByName,
      },

      contract: {
        contractId: receipt.contractId ?? null,
        contractNumber: contractDoc?.contractNumber ?? null,
        lotCode,
      },

      allocations: allocations.map((a) => ({
        targetType: a.targetType,
        targetId: a.targetId,
        amountCents: a.amountCents,
        sequence: a.sequence,
        note: a.note ?? null,
      })),

      template: PLACEHOLDER_BIR_CONFIG,
      templateIsPlaceholder: BIR_CONFIG_IS_PLACEHOLDER,
    };
  },
});

/**
 * Lists the N most-recent receipts by `issuedAt` descending. Reactive
 * by default — the `/receipts` list subscribes via `useQuery` and
 * receives new rows live as the cornerstone issues them.
 *
 * `voidedOnly` filter lets the admin's void-audit workflow page show
 * only voided receipts (Story 3.12 surface — wires through this same
 * query).
 *
 * Customer name is best-effort hydrated for display; `null` when the
 * receipt has no customer (rare — the cornerstone writes `customerId`
 * from the calling mutation, which is required for the sale paths).
 */
export const listReceipts = queryGeneric({
  args: {
    limit: v.optional(v.number()),
    voidedOnly: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number; voidedOnly?: boolean },
  ): Promise<ReceiptListRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const requested = args.limit ?? LIST_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, requested));

    // We fetch a generous window from the `by_issuedAt` index and
    // filter in memory. Phase 1 receipt volume (a few thousand max
    // over the cemetery's lifetime) makes the in-memory filter cheap;
    // when volume grows past ~10k a dedicated `by_voided_issuedAt`
    // composite index becomes worthwhile (deferred).
    const rows = await ctx.db
      .query("receipts")
      .withIndex("by_issuedAt")
      .order("desc")
      .take(limit * (args.voidedOnly === true ? 4 : 1));

    const filtered =
      args.voidedOnly === true
        ? rows.filter((r) => r.isVoided)
        : rows;
    const capped = filtered.slice(0, limit);

    const out: ReceiptListRow[] = [];
    for (const row of capped) {
      let customerFullName: string | null = null;
      if (row.customerId !== undefined) {
        const c = await ctx.db.get(
          row.customerId as DataModel["customers"]["document"]["_id"],
        );
        customerFullName = c?.fullName ?? null;
      }
      let contractNumber: string | null = null;
      if (row.contractId !== undefined) {
        const ctr = await ctx.db.get(
          row.contractId as DataModel["contracts"]["document"]["_id"],
        );
        contractNumber = ctr?.contractNumber ?? null;
      }
      out.push({
        receiptId: row._id,
        receiptNumber: row.receiptNumber,
        receiptSerial: row.receiptSerial,
        issuedAt: row.issuedAt,
        amountCents: row.amountCents,
        customerId: row.customerId ?? null,
        customerFullName,
        contractId: row.contractId ?? null,
        contractNumber,
        isVoided: row.isVoided,
        voidedAt: row.voidedAt ?? null,
      });
    }
    return out;
  },
});

/**
 * Best-effort display name resolution: prefer `name`, fall back to
 * `email`, then to `null`. Mirrors the helper pattern in `expenses.ts`
 * and `contracts.ts`. Kept private to this file because the receipt
 * display is the only consumer.
 */
function userDisplayName(
  user: DataModel["users"]["document"] | null,
): string | null {
  if (user === null) return null;
  const u = user as { name?: string | null; email?: string | null };
  return u.name ?? u.email ?? null;
}

// =====================================================================
// Story 3.13 — PDF rendering + download surface (FR30, FR31, NFR-S3).
//
// Three companion functions to the Node-runtime action in
// `convex/actions/generateReceiptPdf.ts`:
//
//   1. `getReceiptForPdf` (internal query) — hydrates the data the
//      action needs to render. Internal so clients cannot invoke it
//      directly; the action runs in a server-to-server context with
//      no per-caller auth.
//
//   2. `generateReceiptPdfRequest` (public mutation) — client-visible
//      entry point. Role-gates the caller via `requireRole`, then
//      schedules the action via `ctx.scheduler.runAfter(0, ...)`.
//      Returns immediately; the UI subscribes to the reactive
//      `getReceiptPdfUrl` query and gets the signed URL when the
//      action lands.
//
//   3. `storeReceiptPdfBlob` (internal mutation) — the action's
//      writeback handler. Patches `pdfStorageId` + `pdfGeneratedAt`
//      on the receipt row. NEVER touches financial fields.
//
//   4. `getReceiptPdfUrl` (public query) — auth-gated signed URL
//      lookup. Returns `null` while the PDF is still rendering or if
//      the receipt has none. NFR-S3: raw storage IDs are never
//      surfaced; only short-lived signed URLs via `ctx.storage.getUrl`.
// =====================================================================

/**
 * Lean view-model returned by `getReceiptForPdf`. Mirrors the subset
 * of `ReceiptDetail` the renderer needs — no `receiptId` (the
 * caller already has it), no `customerId` / `contractId` (the PDF
 * doesn't surface those raw ids). Keeping the shape narrow lets the
 * action's bundle stay small and the type contract explicit.
 */
export interface ReceiptForPdfPayload {
  receiptId: string;
  /**
   * Epic-3/4 adversarial-review HIGH fix — deterministic PDF
   * CreationDate. The receipt row's `_creationTime` (Convex's
   * immutable intrinsic field) is byte-stable across regenerations,
   * so the rendered PDF's `info.CreationDate` becomes byte-stable too.
   * The prior code used `new Date()` at render time, which produced
   * non-deterministic output on every regeneration even when the
   * receipt's body content was identical.
   */
  receiptCreationTime: number;
  receiptSeries: string;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  isVoided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  voidedByName: string | null;

  customer: {
    fullName: string | null;
    addressLine1: string | null;
    addressBarangay: string | null;
    addressCityMunicipality: string | null;
    addressProvince: string | null;
    addressPostalCode: string | null;
  };

  payment: {
    paymentMethod: PaymentDoc["paymentMethod"];
    reference: string | null;
    receivedAt: number;
    receivedByName: string | null;
  };

  contract: {
    contractNumber: string | null;
    lotCode: string | null;
  };

  allocations: Array<{
    targetType: PaymentAllocationDoc["targetType"];
    amountCents: number;
    sequence: number;
    note: string | null;
  }>;

  /**
   * BIR template config — the LEGACY display-shape mirrored from the
   * loaded singleton row. Kept for back-compat with `renderReceiptPdf`'s
   * downstream helpers (`drawSignatureBlock`, `formatVersion` footer
   * tag). The full canonical row lives at `birConfig` below; new render
   * code should read from there.
   */
  template: BirReceiptConfig;
  /**
   * The CANONICAL `birReceiptConfig` row the action threads through
   * `formatBirReceiptFooter` + the registered-address render. Loaded
   * via `loadBirReceiptConfig` which throws when the row is missing
   * or `isPlaceholder === true` — so by the time this payload reaches
   * the action, the cemetery's BIR identity is confirmed production-
   * ready.
   */
  birConfig: BirReceiptConfigRow;
  /**
   * Always `false` on this payload — `loadBirReceiptConfig` refuses
   * to return placeholder rows. Retained for type compatibility with
   * the prior contract (`renderReceiptPdf` reads it for an additional
   * defensive footer banner) so existing consumers keep compiling
   * without a coordinated change.
   */
  templateIsPlaceholder: boolean;
}

/**
 * Hydrate the data the PDF action needs. Internal — the action calls
 * this via `ctx.runQuery`; clients do not.
 *
 * Why a dedicated query and not a reuse of `getReceipt`:
 *   - `getReceipt` requires `requireRole(office_staff|admin)` and is
 *     authenticated against the calling user. The action's call is
 *     server-to-server with no propagated identity; reusing
 *     `getReceipt` would force the action to forge an auth context.
 *   - The PDF action only needs a subset of fields. The narrower
 *     shape documents what the renderer actually consumes.
 *
 * Auth: internal queries skip the require-role lint exemption — they
 * are never directly reachable from a client. The mutation that
 * schedules the action (`generateReceiptPdfRequest`) is the gating
 * point.
 */
export const getReceiptForPdf = internalQueryGeneric({
  args: { receiptId: v.id("receipts") },
  handler: async (
    ctx: QueryCtx,
    args: { receiptId: ReceiptId },
  ): Promise<ReceiptForPdfPayload | null> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      return null;
    }

    // Load the canonical BIR config FIRST — if the singleton row is
    // missing or in placeholder mode, throw before doing any of the
    // hydration work below. The action that calls this query refuses
    // to render against a placeholder-stamped receipt; surfacing the
    // throw here gives the scheduler a clear failure log entry
    // ("bir_not_configured") rather than letting the action discover
    // the same problem one step later.
    const birConfig = await loadBirReceiptConfig(ctx);

    const payment = await ctx.db.get(receipt.paymentId);
    let customerDoc: DataModel["customers"]["document"] | null = null;
    if (receipt.customerId !== undefined) {
      customerDoc = (await ctx.db.get(
        receipt.customerId as DataModel["customers"]["document"]["_id"],
      )) ?? null;
    }
    let contractDoc: DataModel["contracts"]["document"] | null = null;
    if (receipt.contractId !== undefined) {
      contractDoc = (await ctx.db.get(
        receipt.contractId as DataModel["contracts"]["document"]["_id"],
      )) ?? null;
    }
    let lotCode: string | null = null;
    if (contractDoc !== null) {
      const lot = await ctx.db.get(contractDoc.lotId);
      lotCode = lot?.code ?? null;
    }
    let receivedByName: string | null = null;
    if (payment !== null) {
      const u = await ctx.db.get(payment.receivedByUserId);
      receivedByName = userDisplayName(u);
    }
    let voidedByName: string | null = null;
    if (receipt.isVoided && receipt.voidedByUserId !== undefined) {
      const u = await ctx.db.get(receipt.voidedByUserId);
      voidedByName = userDisplayName(u);
    }
    const allocations = (
      await ctx.db
        .query("paymentAllocations")
        .withIndex("by_payment", (q) => q.eq("paymentId", receipt.paymentId))
        .collect()
    )
      .slice()
      .sort((a, b) => a.sequence - b.sequence);

    return {
      receiptId: receipt._id as unknown as string,
      receiptCreationTime: receipt._creationTime,
      receiptSeries: receipt.receiptSeries,
      receiptNumber: receipt.receiptNumber,
      receiptSerial: receipt.receiptSerial,
      issuedAt: receipt.issuedAt,
      amountCents: receipt.amountCents,
      isVoided: receipt.isVoided,
      voidedAt: receipt.voidedAt ?? null,
      voidReason: receipt.voidReason ?? null,
      voidedByName,
      customer: {
        fullName: customerDoc?.fullName ?? null,
        addressLine1: customerDoc?.address.line1 ?? null,
        addressBarangay: customerDoc?.address.barangay ?? null,
        addressCityMunicipality:
          customerDoc?.address.cityMunicipality ?? null,
        addressProvince: customerDoc?.address.province ?? null,
        addressPostalCode: customerDoc?.address.postalCode ?? null,
      },
      payment: {
        paymentMethod: payment?.paymentMethod ?? "cash",
        reference: payment?.reference ?? null,
        receivedAt: payment?.receivedAt ?? receipt.issuedAt,
        receivedByName,
      },
      contract: {
        contractNumber: contractDoc?.contractNumber ?? null,
        lotCode,
      },
      allocations: allocations.map((a) => ({
        targetType: a.targetType,
        amountCents: a.amountCents,
        sequence: a.sequence,
        note: a.note ?? null,
      })),
      // Display-shape derived from the canonical loaded row. Mirrors
      // the legacy `BirReceiptConfig` interface the renderer's helpers
      // consume (`registeredName`, `tin`, `atpNumber`, `address`,
      // `isVatRegistered`, `signatoryName`, `signatoryTitle`,
      // `formatVersion`). The registered address is joined with
      // newlines for the legacy `formatAddressLines` consumer.
      template: {
        registeredName: birConfig.registeredName,
        tin: birConfig.tin,
        atpNumber: birConfig.atpNumber,
        address: birConfig.registeredAddressLines.join("\n"),
        isVatRegistered: birConfig.isVatRegistered,
        signatoryName: "Authorized Signatory",
        signatoryTitle: "Cemetery Operations",
        formatVersion: "v1",
      },
      birConfig,
      // `loadBirReceiptConfig` filtered out placeholder rows already;
      // always `false` here. Retained on the payload for back-compat
      // with the render path's prior contract.
      templateIsPlaceholder: false,
    };
  },
});

/**
 * Action reference for `generateReceiptPdf` (Story 3.13). Lives in
 * `convex/actions/generateReceiptPdf.ts`; the function is published as
 * `actions/generateReceiptPdf:generateReceiptPdf`. Resolved via
 * `makeFunctionReference` because the codegen `convex/_generated/api`
 * is not checked in (see the architectural note in
 * `convex/lib/audit.ts:emitAuditFromAction`).
 */
const generateReceiptPdfActionRef = makeFunctionReference<
  "action",
  { receiptId: ReceiptId; forceRegenerate?: boolean },
  { storageId: string; generatedAt: number } | null
>("actions/generateReceiptPdf:generateReceiptPdf");

/**
 * Public mutation: schedule the receipt-PDF generation action. The
 * UI calls this when staff click "Download PDF" on a receipt that has
 * no PDF yet (`pdfStorageId === undefined`), or to refresh a stale
 * PDF after a void / regeneration request.
 *
 * Returns the receipt id along with a `status` flag:
 *   - `"already_generating"` — a prior request has scheduled the
 *     action and the PDF is still being rendered (we detect this by
 *     looking at `pdfGeneratedAt`: undefined-but-recently-touched is
 *     not observable here; we use a conservative no-op signal so the
 *     UI doesn't spam-schedule duplicate runs).
 *   - `"scheduled"` — a fresh action invocation was queued. The UI
 *     should subscribe to `getReceiptPdfUrl` and wait for it to
 *     resolve non-null.
 *   - `"ready"` — `pdfStorageId` is already populated. The UI can
 *     proceed to the URL query immediately.
 *
 * The mutation does NOT itself generate the PDF — that work happens
 * in the scheduled action. The reactive contract is: client mutation
 * resolves → client subscribes to the URL query → URL query becomes
 * non-null when the action's writeback mutation lands.
 *
 * Auth: `requireRole(["admin", "office_staff"])` as the first
 * statement (matches the rest of this file's public surface).
 */
export const generateReceiptPdfRequest = mutationGeneric({
  args: {
    receiptId: v.id("receipts"),
    // Epic-3/4 adversarial-review HIGH fix — caller-supplied
    // idempotency key for rapid double-click dedupe. When supplied
    // and the receipt row's stored `pdfIdempotencyKey` matches, the
    // mutation returns the cached status without scheduling another
    // action.
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: { receiptId: ReceiptId; idempotencyKey?: string },
  ): Promise<{
    receiptId: ReceiptId;
    status: "ready" | "scheduled" | "not_found" | "already_generating";
  }> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      return { receiptId: args.receiptId, status: "not_found" };
    }
    if (receipt.pdfStorageId !== undefined) {
      return { receiptId: args.receiptId, status: "ready" };
    }

    // Idempotency short-circuit (Epic-3/4 HIGH fix). Mirrors the
    // contract-PDF mutation: a "pending" status with the same key
    // means another caller has the action in flight; return
    // "already_generating" so the UI doesn't pile up extra schedules.
    const trimmedKey =
      typeof args.idempotencyKey === "string"
        ? args.idempotencyKey.trim()
        : "";
    const idempotencyKey = trimmedKey.length > 0 ? trimmedKey : null;
    if (
      idempotencyKey !== null &&
      receipt.pdfIdempotencyKey === idempotencyKey
    ) {
      if (receipt.pdfStatus === "pending") {
        return { receiptId: args.receiptId, status: "already_generating" };
      }
      // "failed" with the same key falls through — the operator's
      // intent on a retry click is to re-attempt.
    }

    // Patch pending-state bookkeeping BEFORE scheduling. The retry-
    // sweep cron walks rows by `pdfStatus` to decide what to retry.
    await ctx.db.patch(args.receiptId, {
      pdfStatus: "pending",
      pdfRetryCount: 0,
      pdfLastError: undefined,
      pdfIdempotencyKey: idempotencyKey ?? undefined,
    });

    // Run-after-0ms = "as soon as the transaction commits". The
    // mutation returns to the client immediately; the action picks up
    // on the next scheduler tick. The UI subscribes to
    // `getReceiptPdfUrl` and refreshes when the action's writeback
    // mutation lands.
    await ctx.scheduler.runAfter(0, generateReceiptPdfActionRef, {
      receiptId: args.receiptId,
    });
    return { receiptId: args.receiptId, status: "scheduled" };
  },
});

/**
 * Internal mutation: write the freshly-generated PDF's storage id
 * back onto the receipt row. Called only by the
 * `actions/generateReceiptPdf` action. The patch is narrow on
 * purpose — only `pdfStorageId` + `pdfGeneratedAt` move; no financial
 * field is ever touched (FR31 immutability). The
 * `no-direct-financial-write` ESLint rule does not flag
 * `ctx.db.patch` (only insert / replace / delete).
 */
export const storeReceiptPdfBlob = internalMutationGeneric({
  args: {
    receiptId: v.id("receipts"),
    storageId: v.id("_storage"),
    generatedAt: v.number(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      receiptId: ReceiptId;
      storageId: NonNullable<
        DataModel["receipts"]["document"]["pdfStorageId"]
      >;
      generatedAt: number;
    },
  ): Promise<null> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      // The receipt was deleted between the action being scheduled
      // and its writeback. Silently no-op; the orphan blob will be
      // cleaned up by a future maintenance task.
      return null;
    }
    await ctx.db.patch(args.receiptId, {
      pdfStorageId: args.storageId,
      pdfGeneratedAt: args.generatedAt,
      // Epic-3/4 adversarial-review HIGH fix — lifecycle bookkeeping.
      pdfStatus: "ready",
      pdfLastError: undefined,
    });
    return null;
  },
});

/**
 * Internal mutation — records that the receipt PDF generation FAILED.
 * Epic-3/4 adversarial-review HIGH fix: the prior path had no failed-
 * state record; an action crash left the receipt stuck on
 * `pdfStatus: "pending"`. This callback flips the row to "failed" and
 * lets the retry-sweep cron pick it up on the next pass.
 */
export const recordReceiptPdfFailed = internalMutationGeneric({
  args: {
    receiptId: v.id("receipts"),
    errorMessage: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { receiptId: ReceiptId; errorMessage: string },
  ): Promise<void> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      return;
    }
    const truncated =
      args.errorMessage.length > 500
        ? args.errorMessage.slice(0, 500)
        : args.errorMessage;
    await ctx.db.patch(args.receiptId, {
      pdfStatus: "failed",
      pdfLastError: truncated,
    });
  },
});

/**
 * Internal mutation — bumps the receipt PDF retry count. Called by
 * the retry-sweep cron BEFORE rescheduling the action so a row that
 * fails repeatedly stops being re-attempted once the cap (3) is
 * reached. The cap-check + skip lives in the cron itself; this
 * mutation unconditionally bumps + flips status back to "pending".
 */
export const bumpReceiptPdfRetryCount = internalMutationGeneric({
  args: { receiptId: v.id("receipts") },
  handler: async (
    ctx: MutationCtx,
    args: { receiptId: ReceiptId },
  ): Promise<{ retryCount: number }> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      return { retryCount: 0 };
    }
    const next = (receipt.pdfRetryCount ?? 0) + 1;
    await ctx.db.patch(args.receiptId, {
      pdfRetryCount: next,
      pdfStatus: "pending",
    });
    return { retryCount: next };
  },
});

/**
 * Public query: return the signed download URL for a receipt's PDF.
 *
 * Reactive: the UI subscribes via `useQuery`; when the action's
 * writeback mutation lands, this query refires and the URL becomes
 * non-null. The "Download PDF" button stays disabled until then.
 *
 * Returns:
 *   - `{ url: string, generatedAt: number }` when the PDF is ready.
 *   - `{ url: null, generatedAt: null }` when:
 *     - the receipt doesn't exist
 *     - the PDF has not been generated yet
 *     - the storage blob is missing (defensive — should never happen,
 *       but a corrupted storage record shouldn't crash the UI)
 *
 * The signed URL is short-lived (Convex's signing window is on the
 * order of minutes). NFR-S3: the raw `pdfStorageId` is never returned.
 */
export const getReceiptPdfUrl = queryGeneric({
  args: { receiptId: v.id("receipts") },
  handler: async (
    ctx: QueryCtx,
    args: { receiptId: ReceiptId },
  ): Promise<{ url: string | null; generatedAt: number | null }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null || receipt.pdfStorageId === undefined) {
      return { url: null, generatedAt: null };
    }
    const url = await ctx.storage.getUrl(receipt.pdfStorageId);
    return {
      url: url ?? null,
      generatedAt: receipt.pdfGeneratedAt ?? null,
    };
  },
});

// =====================================================================
// Story 3.12 — Admin voids a receipt with reason (FR29, FR31, NFR-C1).
//
// `voidReceipt` is the public mutation an Admin invokes from
// `/receipts/[receiptId]`'s "Void receipt" affordance. It is the second
// money-touching surface this file exposes (after Story 3.13's
// `generateReceiptPdfRequest`), and the most consequential one: BIR
// examiners scrutinise voids almost as closely as issuances. The
// architecture commitment is unambiguous — voiding is NOT a delete; it
// is a NEW record that marks the original receipt + its payment as
// invalidated, while preserving everything else (the serial stays
// consumed, the allocations stay, the audit trail tells the full story).
//
// Authorisation is admin-only (defence in depth):
//   - Server: this handler's FIRST awaited statement is
//     `requireRole(ctx, ["admin"])`. The `require-role-first-line`
//     ESLint rule enforces the position; here the role list is the
//     tightest in the file (every other public function allows
//     `office_staff` too).
//   - UI: the receipt detail page hides the button when the caller is
//     not an Admin. The server gate is the load-bearing one — a
//     determined office_staff hitting `useMutation` directly still
//     hits FORBIDDEN.
//
// Routing: the mutation does NOT touch the financial tables itself.
// Every flag flip + audit emission happens inside the Story 3.2
// cornerstone (`postFinancialEvent({ kind: "void", ... })`), which:
//   1. Asserts the receipt exists + is not already voided
//      (`RECEIPT_VOIDED` error code).
//   2. Patches `receipts.{ isVoided, voidedAt, voidReason,
//      voidedByUserId }`.
//   3. Patches the linked `payments` row with the same void-flag
//      bundle (the payment row remains, only its `isVoided` flag flips
//      — FR31 immutability).
//   4. Emits a `void`-action audit row with the receipt as the
//      `entityType: "receipt"` anchor and the operator-supplied
//      reason text in the `reason` field.
//   5. Does NOT allocate a new serial — Story 3.1 AC4 forbids it; the
//      cornerstone's `void` path explicitly skips `allocateNextSerial`.
//
// Policy decision (story Task 3 — domain question on allocation
// reversal): voiding the receipt invalidates the document but the
// underlying payment + its allocations remain intact in this slice.
// The contract's outstanding balance is NOT auto-reversed here; a
// refund / correction flow (Epic 4 / future story) is responsible for
// the customer-facing recovery. Rationale: a compensating-balance
// reversal touches `contracts.outstandingBalanceCents` + may flip
// `contracts.state` from `paid_in_full` back to `active`, and both of
// those mutations live outside this story's file-ownership set.
// Shipping the void-with-reason capability now (admin-only, fully
// audited) unblocks the BIR-compliance milestone; the balance
// reversal lands in a follow-up that owns the right files.
//
// Idempotency: the cornerstone's `void` path reuses the same
// `payments.by_idempotency` index as the create paths. Callers should
// generate a fresh idempotency key per dialog submission (a
// double-click on the destructive button must dedupe). This mutation
// accepts the key from the client unchanged.
//
// Validation (defence in depth — the UI also gates these):
//   - `reason` must trim to at least 10 chars (so the audit trail
//     carries a meaningful explanation, not "asdf").
//   - `reason` must be at most 1000 chars (so a bug in the client
//     cannot smuggle megabytes of text into the audit log).
//
// Throws (ConvexError):
//   - UNAUTHENTICATED / FORBIDDEN — auth gate.
//   - VALIDATION — reason length out of bounds.
//   - NOT_FOUND — receipt id does not resolve (propagated from the
//     cornerstone).
//   - RECEIPT_VOIDED — receipt is already voided (propagated).
//   - IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD — propagated when
//     the same key is reused with a different receiptId.
// =====================================================================

const MIN_VOID_REASON_LENGTH = 10;
const MAX_VOID_REASON_LENGTH = 1000;

/**
 * Public mutation: void a previously-issued receipt. Admin-only. Routes
 * the flag flips + audit emission through the Story 3.2 cornerstone so
 * the financial-write boundary stays single-entry. Returns the existing
 * receipt id + receipt number (the serial is NOT re-allocated — FR29).
 */
export const voidReceipt = mutationGeneric({
  args: {
    receiptId: v.id("receipts"),
    reason: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      receiptId: ReceiptId;
      reason: string;
      idempotencyKey?: string;
    },
  ): Promise<{
    receiptId: ReceiptId;
    receiptNumber: string;
    voidedAt: number;
  }> => {
    // Auth — admin-only. Voiding a receipt is high-stakes (BIR-visible);
    // office_staff and field_worker callers hit FORBIDDEN before any
    // read or write happens.
    const auth = await requireRole(ctx, ["admin"]);

    // Validate the reason. The trim removes inadvertent whitespace
    // padding from the textarea; the floor enforces a meaningful
    // audit-grade explanation. Mirrors the `voidContract` (Story 3.7)
    // convention so the operator experience is uniform.
    const trimmedReason =
      typeof args.reason === "string" ? args.reason.trim() : "";
    if (trimmedReason.length < MIN_VOID_REASON_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Void reason is required and must be at least ${MIN_VOID_REASON_LENGTH} characters.`,
        { reasonLength: trimmedReason.length },
      );
    }
    if (trimmedReason.length > MAX_VOID_REASON_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Void reason must be ${MAX_VOID_REASON_LENGTH} characters or fewer.`,
        { reasonLength: trimmedReason.length },
      );
    }

    // Generate a synthetic idempotency key when the caller did not
    // supply one. The cornerstone's `void` path namespaces with
    // `voidReceipt:` so a retried void on the same receipt is a no-op;
    // we mirror that here so test callers that omit the field still
    // get the dedupe semantics.
    const idempotencyKey =
      args.idempotencyKey !== undefined && args.idempotencyKey.length > 0
        ? args.idempotencyKey
        : `voidReceipt:${args.receiptId}`;

    const voidedAt = Date.now();

    // Route every write through the cornerstone. The cornerstone:
    //   - asserts the receipt exists + is not already voided
    //   - patches receipts + payments with the void-flag bundle
    //   - reverses installment paidCents + perpetual-care tallies for
    //     every allocation the original payment posted (Story 3.2 void-
    //     chain fix from the Epic-3/4 adversarial review)
    //   - emits the `void`-action receipt audit row + a separate
    //     `void_compensation` row summarising the reversals
    //   - does NOT allocate a new serial (FR29)
    const result = await postFinancialEvent(ctx, {
      kind: "void",
      idempotencyKey,
      receiptId: args.receiptId,
      voidReason: trimmedReason,
      voidedByUserId: auth.userId,
      voidedAt,
    });

    // Schedule a PDF re-render with the VOIDED watermark — Story 3.13's
    // renderer already paints `drawVoidedBanner` + `drawVoidedWatermark`
    // when `receipts.isVoided === true` (which the cornerstone just
    // set above). The original `pdfStorageId` on the row still points
    // at the pre-void PDF, so the action must run with
    // `forceRegenerate: true` to bypass the "already generated" short-
    // circuit and overwrite the storage pointer with the watermarked
    // version. Scheduled with `runAfter(0, ...)` so the re-render
    // happens immediately on transaction commit — the UI's reactive
    // subscription to `getReceiptPdfUrl` picks up the new blob as soon
    // as the action's writeback mutation lands.
    await ctx.scheduler.runAfter(0, generateReceiptPdfActionRef, {
      receiptId: args.receiptId,
      forceRegenerate: true,
    });

    return {
      receiptId: result.receiptId,
      receiptNumber: result.receiptNumber,
      voidedAt,
    };
  },
});
