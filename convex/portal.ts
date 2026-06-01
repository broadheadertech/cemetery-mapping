/**
 * Customer portal domain (Story 9.1, FR5 / NFR-S4 / NFR-S5).
 *
 * Public surface for customer-self-service queries / mutations. This
 * file is the single entry point for the `(customer)/` route group;
 * staff queries continue to live in `customers.ts`, `contracts.ts`,
 * `payments.ts`, etc. and are NEVER called from the customer surface.
 *
 * Story 9.1 ships the AUTHENTICATION skeleton only:
 *   - `getCurrentCustomer` — self-read, returns the customer's display
 *     fields (no PII beyond name) so the portal landing page can greet
 *     them by name. Used by `src/app/(customer)/portal/page.tsx`.
 *   - `myProfile` — same data as `getCurrentCustomer` but explicitly
 *     gated on the `customer` role for downstream callers.
 *
 * Stories 9.2+ extend this file:
 *   - 9.2 (own contracts): `getMyContracts`, `getMyContract`.
 *   - 9.3 (receipt PDFs): `getReceiptDownloadUrl` with signed-URL gen.
 *   - 9.4 (contact-info edit): `updateMyContactInfo`.
 *
 * Conventions every handler obeys:
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, ["customer"])`
 *      (or `requireAuth(ctx)` for self-read queries that pre-existed
 *      role assignment — none in Story 9.1). The ESLint rule
 *      `local-rules/require-role-first-line` enforces this at build
 *      time.
 *
 *   2. **Ownership scoping** is the Phase 3 second-line defense beyond
 *      role gating (see Story 9.1 § Disaster prevention). Role check
 *      answers "are you a customer?"; ownership check answers "is this
 *      YOUR contract?". Both are required. Every query that reads
 *      contract / payment / receipt data MUST filter by
 *      `customerId === (the customer linked to this auth user)`.
 *      Story 9.1's `getCurrentCustomer` already enforces this because
 *      it returns only the self-customer; Stories 9.2+ implement the
 *      scoping pattern for cross-document queries.
 *
 *   3. Customer-auth-user linkage: a customer record in the `customers`
 *      table is linked to an authenticated `users` row by matching the
 *      auth user's email to `customers.email` (Phase 3 simple link).
 *      A richer link (`customerAuthLink` table or `userRoles.customerId`
 *      field) is a possible follow-up; Story 9.1 chose the email-match
 *      path because the `customers.email` column already exists from
 *      Story 2.1, and the auth user's email is the natural identity
 *      anchor for portal-initiated logins.
 *
 *   4. Customer queries return ONLY contract / payment / receipt /
 *      profile data. They MUST NOT expose `users` rows, `userRoles`
 *      rows, audit log rows, or any other staff-internal collection.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { postFinancialEvent } from "./lib/postFinancialEvent";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import {
  type GatewayId,
  type NormalizedGatewayWebhookEvent,
} from "./lib/paymentGateways/types";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CustomerDoc = DataModel["customers"]["document"];
type CustomerId = CustomerDoc["_id"];
type ContractDoc = DataModel["contracts"]["document"];
type ContractId = ContractDoc["_id"];
type LotDoc = DataModel["lots"]["document"];
type LotId = LotDoc["_id"];
type InstallmentDoc = DataModel["installments"]["document"];
type InstallmentId = InstallmentDoc["_id"];
type PaymentDoc = DataModel["payments"]["document"];
type PaymentId = PaymentDoc["_id"];
type ReceiptDoc = DataModel["receipts"]["document"];
type ReceiptId = ReceiptDoc["_id"];
type UserId = DataModel["users"]["document"]["_id"];

/**
 * Shape returned by `getCurrentCustomer` / `myProfile`. Intentionally
 * narrow: name + email + customer id only. The portal greets the
 * customer by name; richer profile data lands in Story 9.4's
 * `updateMyContactInfo` flow.
 *
 * Note: `email` is included because the customer already knows their
 * own email; returning it does NOT broaden the PII surface. `phone`
 * and `address` deliberately ARE NOT included in Story 9.1 — Story 9.4
 * is the read+write surface for those.
 */
export interface CurrentCustomerProfile {
  customerId: CustomerId;
  fullName: string;
  email: string;
}

/**
 * Resolves the `customers` row that corresponds to the currently
 * authenticated user. The linkage is by email: every customer record
 * created by Story 2.1's `customers.create` may have an `email` field,
 * and Convex Auth's `users` table also carries `email`. When the two
 * match (case-insensitive), we treat the auth user as that customer.
 *
 * Returns null when:
 *   - The auth user has no `email` field.
 *   - No `customers` row matches that email.
 *   - Multiple `customers` rows match the email (ambiguous link — fail
 *     closed rather than guess; this is the "two customers share a
 *     household email" case Phase 3 will need to disambiguate via the
 *     dedicated `customerAuthLink` table).
 *
 * Why a helper (not inline): Stories 9.2+ will reuse this exact
 * resolution to scope their `contracts.customerId === ...` filters.
 * Centralising here means the email-link policy lives in one place.
 *
 * @internal — not exported as a Convex function; callers wrap this in
 * a public query/mutation that has already called requireRole.
 */
async function resolveCurrentCustomer(
  ctx: QueryCtx,
  authEmail: string | undefined,
): Promise<CustomerDoc | null> {
  if (authEmail === undefined) return null;
  const needle = authEmail.trim().toLowerCase();
  if (needle.length === 0) return null;
  // No `customers.by_email` index exists (Story 2.1 did not add one —
  // staff lookups use `by_fullName_lowercased` + `by_govIdNumber`).
  // Phase 3 portal traffic is bounded (~2,000 customers); a full scan
  // with an in-memory filter is acceptable for Story 9.1. Stories 9.2+
  // may add a dedicated index if profiling justifies it.
  const rows = await ctx.db.query("customers").collect();
  const matches = rows.filter(
    (r) => (r.email ?? "").trim().toLowerCase() === needle,
  );
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

/**
 * Public query: returns the current customer's profile (name + email).
 *
 * Used by `src/app/(customer)/portal/page.tsx` to greet the customer
 * by name and confirm they are signed into the correct account.
 *
 * Authorization: `requireRole(ctx, ["customer"])` — strictly customer
 * role only. Staff users hitting this endpoint receive FORBIDDEN; the
 * staff-side equivalent is `customers.getCustomerDetail`.
 *
 * Failure modes:
 *   - UNAUTHENTICATED — no session (handled by `requireRole`).
 *   - FORBIDDEN — caller does not hold the `customer` role.
 *   - NOT_FOUND — caller has the role but no `customers` row links to
 *     their auth email. This is the "customer was role-granted but the
 *     customer record was deleted or has no email" edge case; the
 *     portal UI surfaces a generic "Profile unavailable — please
 *     contact the cemetery office" message.
 */
export const getCurrentCustomer = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<CurrentCustomerProfile> => {
    const auth = await requireRole(ctx, ["customer"]);
    const customer = await resolveCurrentCustomer(ctx, auth.user.email);
    if (customer === null) {
      throwError(
        ErrorCode.NOT_FOUND,
        "We couldn't find a customer record linked to your account. Please contact the cemetery office.",
        { entity: "customer" },
      );
    }
    return {
      customerId: customer._id,
      fullName: customer.fullName,
      email: customer.email ?? auth.user.email ?? "",
    };
  },
});

// ---------------------------------------------------------------------------
// Story 9.2 — customer's own contracts, contract detail, and payments.
//
// All three queries below are gated on `requireRole(ctx, ["customer"])` AND
// hard-scoped to the resolved current customer's `_id`. The role check
// answers "are you a customer?"; the scope check (`customerId === current
// customer's id`) answers "is this YOUR contract?". Both layers are
// mandatory — see Story 9.1 § "ownership scoping" + Dev Notes.
//
// Cross-customer-access defense: handlers never accept a `customerId` from
// the client. The customer id is derived server-side from the auth email
// linkage. For non-owned contract reads, handlers return `null` (the page
// renders 404) — NOT `throw FORBIDDEN`, which would leak existence.
// ---------------------------------------------------------------------------

/**
 * Lightweight lot reference embedded in customer-portal contract rows.
 *
 * Intentionally narrow: code + section / block / row + the lot's centroid
 * (lat/lng) only. The full polygon vertex array is deliberately omitted —
 * customers don't need it for the dashboard list, and exposing surveyed
 * lot polygons through the portal would broaden the spatial data surface
 * beyond Story 8.3 AC4's owner-visible-polygon scope. The staff-side
 * lot-detail query continues to return the full geometry.
 */
export interface CustomerLotRef {
  lotId: LotId;
  code: string;
  section: string;
  block: string;
  row: string;
  centroid: { lat: number; lng: number };
}

/**
 * One row in the customer dashboard's contract list.
 *
 * Money columns are integer centavos (ADR-0007); the client formats via
 * `formatPeso`. `outstandingBalanceCents` is computed in-handler from the
 * contract total minus the sum of non-voided payments — Phase 1 does NOT
 * carry a denormalised balance column on `contracts`, so the computation
 * lives here (small N: typical customer has 1–3 contracts × ≤ 36
 * payments each).
 *
 * `nextDueDate` and `remainingInstallments` are derived from the
 * installment schedule for installment-kind contracts; both are
 * `undefined` for full-payment contracts (single lump sum, no schedule).
 */
export interface CustomerContractListRow {
  contractId: ContractId;
  contractNumber: string;
  kind: "full_payment" | "installment";
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  totalPriceCents: number;
  outstandingBalanceCents: number;
  nextDueDate?: number;
  remainingInstallments?: number;
  totalInstallments?: number;
  createdAt: number;
  lot: CustomerLotRef | null;
}

/**
 * Builds the narrow `CustomerLotRef` from a lot doc, scrubbing the
 * polygon vertex array. Returns `null` when the lot row has been
 * deleted (defensive — should never happen given lot rows are never
 * hard-deleted in Phase 1, but the customer-facing path renders
 * defensively rather than throwing).
 */
function toCustomerLotRef(lot: LotDoc | null): CustomerLotRef | null {
  if (lot === null) return null;
  return {
    lotId: lot._id,
    code: lot.code,
    section: lot.section,
    block: lot.block,
    row: lot.row,
    centroid: { ...lot.geometry.centroid },
  };
}

/**
 * Resolves the auth-linked customer once per call. Throws NOT_FOUND when
 * the resolution fails (caller has the customer role but no matching
 * `customers` row). Keeps the three Story 9.2 handlers DRY without
 * leaking the email-linkage policy out of this file.
 *
 * P1-1 (Story 9.7) — exported so the reminder engine's
 * `updateMyReminderOptOut` mutation can resolve the calling customer
 * through the canonical email-link path instead of an unindexed
 * `createdByUserId === auth.userId` scan. Exporting (rather than
 * duplicating) keeps the linkage policy in one place — Stories 9.2+
 * already rely on this exact resolution path; sharing it means a
 * future tweak (richer link table, case-folding rules) hits every
 * customer-self-service surface uniformly.
 */
export async function requireCurrentCustomer(
  ctx: QueryCtx,
): Promise<CustomerDoc> {
  const auth = await requireRole(ctx, ["customer"]);
  const customer = await resolveCurrentCustomer(ctx, auth.user.email);
  if (customer === null) {
    throwError(
      ErrorCode.NOT_FOUND,
      "We couldn't find a customer record linked to your account. Please contact the cemetery office.",
      { entity: "customer" },
    );
  }
  return customer;
}

/**
 * Sum of non-voided payment amounts targeting the given contract.
 * Phase 1 stores `payments.contractId` as an OPTIONAL string (see
 * `convex/schema.ts` — payments are polymorphic across full-payment and
 * installment contracts). The `by_contract` index expects the contract
 * id as a string; we cast through `string` to satisfy TypeScript while
 * mirroring how `convex/payments.ts:listContractPayments` queries the
 * same index.
 */
async function sumPaidCents(
  ctx: QueryCtx,
  contractId: ContractId,
): Promise<number> {
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_contract", (q) =>
      q.eq("contractId", contractId as unknown as string),
    )
    .collect();
  let total = 0;
  for (const payment of payments) {
    if (payment.isVoided) continue;
    total += payment.amountCents;
  }
  return total;
}

/**
 * Loads installment rows for an installment-kind contract, sorted by
 * `installmentNumber` ascending. Returns an empty array for full-payment
 * contracts (no schedule). The customer-facing payload mirrors
 * `convex/installments.ts:InstallmentRow` so the UI's schedule renderer
 * can consume the same shape regardless of which surface fetched it.
 */
async function loadSchedule(
  ctx: QueryCtx,
  contract: ContractDoc,
): Promise<CustomerInstallmentRow[]> {
  if (contract.kind !== "installment") return [];
  const rows = await ctx.db
    .query("installments")
    .withIndex("by_contract", (q) => q.eq("contractId", contract._id))
    .collect();
  const sorted = [...rows].sort(
    (a, b) => a.installmentNumber - b.installmentNumber,
  );
  return sorted.map((row) => {
    const out: CustomerInstallmentRow = {
      installmentId: row._id,
      contractId: row.contractId,
      installmentNumber: row.installmentNumber,
      dueDate: row.dueDate,
      principalCents: row.principalCents,
      paidCents: row.paidCents,
      status: row.status,
    };
    if (row.paidAt !== undefined) out.paidAt = row.paidAt;
    return out;
  });
}

/**
 * Returns the customer's active contracts (filters out `voided` rows so
 * the dashboard doesn't display historical noise). Each row carries the
 * lot reference, current outstanding balance, and — for installment
 * contracts — the next due date and the count of remaining (unpaid)
 * installments.
 *
 * Ordering: descending by `createdAt` so the most-recent contract is at
 * the top.
 *
 * Auth: `requireRole(ctx, ["customer"])` then ownership-scope via the
 * resolved current customer's `_id`. The `by_customer` contracts index
 * is the scoping filter; we do NOT `.collect()` the whole contracts
 * table.
 */
export const listCustomerContracts = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<CustomerContractListRow[]> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` is the canonical customer-portal wrapper; it calls `await requireRole(ctx, ["customer"])` then resolves the email-linked customer row. See `requireCurrentCustomer` in this file.
    const customer = await requireCurrentCustomer(ctx);
    const contracts = await ctx.db
      .query("contracts")
      .withIndex("by_customer", (q) => q.eq("customerId", customer._id))
      .collect();
    // Strip voided contracts so the customer dashboard reflects the
    // active universe only. Cancelled and in_default rows DO surface —
    // they're still meaningful to the customer (the balance + state
    // tell the story).
    const visible = contracts.filter((c) => c.state !== "voided");
    const sorted = [...visible].sort((a, b) => b.createdAt - a.createdAt);
    const out: CustomerContractListRow[] = [];
    for (const contract of sorted) {
      const paidCents = await sumPaidCents(ctx, contract._id);
      const outstandingBalanceCents = Math.max(
        0,
        contract.totalPriceCents - paidCents,
      );
      const row: CustomerContractListRow = {
        contractId: contract._id,
        contractNumber: contract.contractNumber,
        kind: contract.kind,
        state: contract.state,
        totalPriceCents: contract.totalPriceCents,
        outstandingBalanceCents,
        createdAt: contract.createdAt,
        lot: toCustomerLotRef(await ctx.db.get(contract.lotId)),
      };
      if (contract.kind === "installment") {
        const schedule = await ctx.db
          .query("installments")
          .withIndex("by_contract", (q) => q.eq("contractId", contract._id))
          .collect();
        const sortedSchedule = [...schedule].sort(
          (a, b) => a.installmentNumber - b.installmentNumber,
        );
        const remaining = sortedSchedule.filter((s) => s.status !== "paid");
        row.totalInstallments = sortedSchedule.length;
        row.remainingInstallments = remaining.length;
        // Next due date: the first un-paid installment by schedule
        // order. If every installment is paid, omit the field — the
        // contract should be in `paid_in_full` state in that case.
        const next = remaining[0];
        if (next !== undefined) {
          row.nextDueDate = next.dueDate;
        }
      }
      out.push(row);
    }
    return out;
  },
});

/**
 * Public arg shape for `getCustomerContractDetail`.
 */
export interface GetCustomerContractDetailArgs {
  contractId: ContractId;
}

/**
 * One row in the customer-facing installment schedule, mirroring
 * `convex/installments.ts:InstallmentRow` so the UI consumes a stable
 * shape regardless of caller.
 */
export interface CustomerInstallmentRow {
  installmentId: InstallmentId;
  contractId: ContractId;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
  paidAt?: number;
}

/**
 * Header shape for the customer contract detail page.
 *
 * Intentionally omits the cornerstone's internal fields (`paymentId`,
 * `receiptId` pointers — those become the lump-sum links via the
 * payment list — and the staff-internal `createdBy`).
 */
export interface CustomerContractHeader {
  contractId: ContractId;
  contractNumber: string;
  kind: "full_payment" | "installment";
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  totalPriceCents: number;
  outstandingBalanceCents: number;
  createdAt: number;
  termMonths?: number;
  monthlyAmountCents?: number;
  downPaymentCents?: number;
  firstDueDate?: number;
}

/**
 * Detail payload returned by `getCustomerContractDetail`. Returns `null`
 * when:
 *   - the contract id does not resolve, OR
 *   - the contract belongs to a different customer (ownership-scope
 *     miss; the page renders 404 to avoid existence enumeration per
 *     Story 9.1 ADR).
 */
export interface CustomerContractDetail {
  contract: CustomerContractHeader;
  lot: CustomerLotRef | null;
  schedule: CustomerInstallmentRow[];
}

/**
 * Returns the contract header + lot + schedule for a single contract,
 * scoped to the calling customer. Payments are intentionally NOT
 * included here — the UI fetches them via `listCustomerPayments` so the
 * payment-history list can re-fetch / paginate independently of the
 * header.
 *
 * Authorization: `requireRole(ctx, ["customer"])` then ownership check.
 * When the contract's `customerId !== currentCustomer._id` we return
 * `null` (NOT throw FORBIDDEN). This is the deliberate 404-over-403
 * policy from Story 9.1.
 */
export const getCustomerContractDetail = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: GetCustomerContractDetailArgs,
  ): Promise<CustomerContractDetail | null> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) return null;
    if (contract.customerId !== customer._id) return null;
    const paidCents = await sumPaidCents(ctx, contract._id);
    const outstandingBalanceCents = Math.max(
      0,
      contract.totalPriceCents - paidCents,
    );
    const header: CustomerContractHeader = {
      contractId: contract._id,
      contractNumber: contract.contractNumber,
      kind: contract.kind,
      state: contract.state,
      totalPriceCents: contract.totalPriceCents,
      outstandingBalanceCents,
      createdAt: contract.createdAt,
    };
    if (contract.termMonths !== undefined) {
      header.termMonths = contract.termMonths;
    }
    if (contract.monthlyAmountCents !== undefined) {
      header.monthlyAmountCents = contract.monthlyAmountCents;
    }
    if (contract.downPaymentCents !== undefined) {
      header.downPaymentCents = contract.downPaymentCents;
    }
    if (contract.firstDueDate !== undefined) {
      header.firstDueDate = contract.firstDueDate;
    }
    const lot = toCustomerLotRef(await ctx.db.get(contract.lotId));
    const schedule = await loadSchedule(ctx, contract);
    return { contract: header, lot, schedule };
  },
});

/**
 * Public arg shape for `listCustomerPayments`.
 */
export interface ListCustomerPaymentsArgs {
  contractId: ContractId;
  limit?: number;
}

/**
 * One row in the customer-facing payment history table. Mirrors the
 * staff-side `convex/payments.ts:ContractPaymentRow` but omits the
 * staff-internal `receivedByUserId` (the customer doesn't need to know
 * which clerk keyed in the payment) and surfaces only the receipt
 * pointer fields needed for Story 9.3's signed-URL fetch.
 */
export interface CustomerPaymentRow {
  paymentId: PaymentId;
  paymentNumber: string;
  amountCents: number;
  paymentMethod:
    | "cash"
    | "check"
    | "bank_transfer"
    | "gcash"
    | "maya"
    | "card";
  reference?: string;
  receivedAt: number;
  isVoided: boolean;
  receiptId?: ReceiptId;
  receiptNumber?: string;
}

/**
 * Lists payments for a contract, scoped to the calling customer.
 * Returns an empty array when the contract is not owned by the caller
 * (NOT a throw — the dashboard wraps this query alongside
 * `getCustomerContractDetail`, which already handles the 404 case;
 * silently empty is the right fallback when, e.g., the customer's
 * detail-page tab is open and they hit refresh after a session change).
 *
 * Default limit is 20; max is 100. Phase 1 customers have ≤ 36
 * payments per contract; pagination beyond the cap is a Phase 2 story.
 */
export const listCustomerPayments = queryGeneric({
  args: {
    contractId: v.id("contracts"),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: ListCustomerPaymentsArgs,
  ): Promise<CustomerPaymentRow[]> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) return [];
    if (contract.customerId !== customer._id) return [];
    const limit = Math.min(args.limit ?? 20, 100);
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_contract", (q) =>
        q.eq("contractId", args.contractId as unknown as string),
      )
      .collect();
    // Latest-first by `_creationTime` (the canonical row-insert
    // timestamp). The cornerstone never replaces a payment row, so
    // `_creationTime` is stable for sort.
    const sorted = [...rows].sort(
      (a, b) => b._creationTime - a._creationTime,
    );
    const capped = sorted.slice(0, limit);
    const out: CustomerPaymentRow[] = [];
    for (const row of capped) {
      const receipt = await ctx.db
        .query("receipts")
        .withIndex("by_payment", (q) => q.eq("paymentId", row._id))
        .unique();
      const entry: CustomerPaymentRow = {
        paymentId: row._id,
        paymentNumber: row.paymentNumber,
        amountCents: row.amountCents,
        paymentMethod: row.paymentMethod,
        receivedAt: row.receivedAt,
        isVoided: row.isVoided,
      };
      if (row.reference !== undefined) entry.reference = row.reference;
      if (receipt !== null) {
        entry.receiptId = receipt._id;
        entry.receiptNumber = receipt.receiptNumber;
      }
      out.push(entry);
    }
    return out;
  },
});

// ---------------------------------------------------------------------------
// Story 9.3 — customer-portal receipt downloads (FR56).
//
// Two surfaces:
//
//   1. `listCustomerReceipts` — scope: every receipt whose underlying payment
//      belongs to one of the calling customer's contracts. Returns a narrow
//      list shape (no PII beyond what the customer already knows about
//      themselves) suitable for the `/portal/receipts` index page.
//
//   2. `getCustomerReceiptPdfUrl` — ownership-gated bridge to Story 3.13's
//      `pdfStorageId`. Verifies the receipt belongs to the calling customer
//      BEFORE minting the signed URL, then returns
//      `{ url, generatedAt, ready }`. While the PDF is still being rendered
//      (the Story 3.13 action has not landed yet), `ready: false` is
//      returned and the client subscribes / polls until it flips.
//
// Both handlers obey the customer-portal conventions:
//   - first awaited statement is `await requireRole(ctx, ["customer"])`
//     (lint rule `local-rules/require-role-first-line`);
//   - ownership-scope via `requireCurrentCustomer` — role check + email-link
//     resolution;
//   - non-ownership → null / [] (NEVER throw FORBIDDEN — Story 9.1 ADR's
//     existence-enumeration defence);
//   - no audit-emission write path here. Story 9.3's spec discussed an
//     audit row per URL issuance (NFR-S8), but emitting audit from a query
//     is a category error and the file-ownership policy for this slice
//     keeps `convex/lib/**` read-only. The receipt-download audit pattern
//     becomes a follow-up the moment the codegen `_generated/api` exists
//     and `emitAudit` can transit via an internal mutation (see
//     `convex/lib/audit.ts`'s `emitAuditFromAction` placeholder).
// ---------------------------------------------------------------------------

/**
 * One row in the customer-portal receipts index. Intentionally narrow:
 * the customer needs the receipt's serial-formatted number, the date it
 * was issued, the amount, whether it has a PDF available yet, and the
 * contract / payment back-references so the row can deep-link into the
 * detail page.
 *
 * `isVoided` is surfaced so the list can show a "voided" badge — voided
 * receipts remain part of the customer's history and downloadable for
 * audit purposes (the PDF carries the watermark from Story 3.13). The
 * `voidedAt` timestamp is included so the row can show "voided on …"
 * inline.
 *
 * `pdfReady` is a derived boolean: `true` when `pdfStorageId` is set
 * (the Story 3.13 action has landed); `false` otherwise. Customers
 * tapping a row before the PDF is ready see a "Receipt is being
 * generated" message rather than an opaque error.
 */
export interface CustomerReceiptListRow {
  receiptId: ReceiptId;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  paymentId: PaymentId;
  contractId: ContractId | null;
  contractNumber: string | null;
  isVoided: boolean;
  voidedAt: number | null;
  pdfReady: boolean;
}

/**
 * Lists every receipt that belongs to the calling customer's contracts.
 *
 * Resolution path:
 *   1. Resolve the calling customer via the email link (`requireCurrentCustomer`).
 *   2. Load all the customer's contracts (`by_customer` index).
 *   3. For each contract, load its payments (`by_contract` index); for
 *      each payment, look up the one-to-one receipt (`by_payment` index).
 *   4. Hydrate the contract number on each row so the UI can show
 *      "Receipt OR-0000123 · Contract CN-0001" without a second query.
 *
 * Why traverse via contracts → payments → receipts rather than scanning
 * receipts directly: the `receipts` table has no `by_customer` index, and
 * `customerId` is an optional string field (not a typed reference). The
 * contracts→payments→receipts join is the same shape `listCustomerPayments`
 * already uses, so the query plan is bounded by the customer's contract
 * count (Phase 1 customer fixtures: ≤ 3 contracts, ≤ 36 payments per
 * contract → ≤ ~108 receipt lookups, all index-driven).
 *
 * Voided contracts are filtered out (parity with `listCustomerContracts`
 * — a customer doesn't need historical-noise receipts from contracts that
 * were voided wholesale; void-of-a-single-receipt is a different path
 * and DOES surface).
 *
 * Sort order: newest receipt first by `issuedAt` (the BIR-relevant
 * timestamp; `_creationTime` would order by row-insert which is
 * equivalent in Phase 1 since the cornerstone inserts the receipt at
 * the same instant as the payment).
 */
export const listCustomerReceipts = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<CustomerReceiptListRow[]> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const contracts = await ctx.db
      .query("contracts")
      .withIndex("by_customer", (q) => q.eq("customerId", customer._id))
      .collect();
    const visibleContracts = contracts.filter((c) => c.state !== "voided");
    if (visibleContracts.length === 0) return [];

    const contractById = new Map<ContractId, ContractDoc>();
    for (const contract of visibleContracts) {
      contractById.set(contract._id, contract);
    }

    const rows: CustomerReceiptListRow[] = [];
    for (const contract of visibleContracts) {
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_contract", (q) =>
          q.eq("contractId", contract._id as unknown as string),
        )
        .collect();
      for (const payment of payments) {
        const receipt = await ctx.db
          .query("receipts")
          .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
          .unique();
        if (receipt === null) continue;
        rows.push({
          receiptId: receipt._id,
          receiptNumber: receipt.receiptNumber,
          receiptSerial: receipt.receiptSerial,
          issuedAt: receipt.issuedAt,
          amountCents: receipt.amountCents,
          paymentId: payment._id,
          contractId: contract._id,
          contractNumber: contract.contractNumber,
          isVoided: receipt.isVoided,
          voidedAt: receipt.voidedAt ?? null,
          pdfReady: receipt.pdfStorageId !== undefined,
        });
      }
    }
    // Newest-first by `issuedAt` (BIR-canonical issuance instant). Stable
    // tiebreak on `receiptSerial` so two receipts issued in the same
    // millisecond — rare but possible if the cornerstone batches —
    // surface in a deterministic order.
    rows.sort((a, b) => {
      if (b.issuedAt !== a.issuedAt) return b.issuedAt - a.issuedAt;
      return b.receiptSerial - a.receiptSerial;
    });
    return rows;
  },
});

/**
 * Public arg shape for `getCustomerReceiptPdfUrl`.
 */
export interface GetCustomerReceiptPdfUrlArgs {
  receiptId: ReceiptId;
}

/**
 * Return shape for `getCustomerReceiptPdfUrl`.
 *
 *   - `ready: true` + `url: string` — PDF is generated and the signed URL
 *     is ready for the browser to fetch / save.
 *   - `ready: false` + `url: null` — receipt belongs to the customer but
 *     the PDF has not been generated yet (Story 3.13's action hasn't
 *     landed). Client should show "Receipt is being generated, please
 *     refresh in a few seconds" and resubscribe.
 *   - `null` — receipt does NOT belong to the calling customer OR does
 *     not exist. The page renders a 404 panel (existence-enumeration
 *     defence per Story 9.1 ADR — both branches collapse to the same UI).
 */
export interface CustomerReceiptPdfUrlResult {
  url: string | null;
  ready: boolean;
  generatedAt: number | null;
  receiptNumber: string;
}

/**
 * Returns the signed-URL download bundle for a single receipt PDF,
 * scoped to the calling customer.
 *
 * Story 9.3 NFR-S8 fix (Epic-9 adversarial review): the handler was
 * originally a `queryGeneric` for reactive subscription. The Phase 1
 * implementation gap was that PII / receipt reads cannot emit
 * `auditLog` rows from a query context — every download therefore
 * landed in the customer's hands with no breach-impact trail. We
 * convert the URL-issuance to a MUTATION so the same transaction:
 *
 *   1. Re-validates ownership (receipt → payment → contract → customer).
 *   2. Bumps the receipt's `downloadCount` for operational visibility
 *      (denormalised aggregate; the audit log remains the canonical
 *      access set).
 *   3. Calls `emitAudit({ action: "read_pii", entityType: "receipt" })`
 *      — the auditable surface the NFR demands.
 *   4. Mints the signed URL via `ctx.storage.getUrl(...)`.
 *
 * The reactive-subscription story is preserved at the page layer: the
 * customer-portal UI subscribes to `listCustomerReceipts` for the
 * `pdfReady` flag, then fires THIS mutation imperatively on the
 * Download click. The pre-fix "subscribe to the URL itself and watch
 * `ready` flip" pattern is intentionally retired — that pattern is the
 * reason audit emission was structurally impossible in the original
 * design.
 *
 * Authorization layers:
 *   1. `requireRole(ctx, ["customer"])` — role gate (staff users hitting
 *      this endpoint receive FORBIDDEN; the staff equivalent is
 *      `receipts:getReceiptPdfUrl`).
 *   2. `resolveCurrentCustomer` via `requireCurrentCustomer` — translates
 *      the auth identity to a `customers` row id.
 *   3. Ownership check — the receipt's payment's contract MUST have
 *      `customerId === currentCustomer._id`. Failing this returns
 *      `null` (NOT throw FORBIDDEN — 404-over-403, Story 9.1 ADR). No
 *      audit row is emitted for the non-ownership case — emitting one
 *      would leak existence of other customers' receipts via the
 *      audit-log surface.
 *
 * The signed URL is minted ONLY AFTER the ownership check passes.
 * NFR-S3: the raw `pdfStorageId` is never returned —
 * `ctx.storage.getUrl(...)` produces a short-lived signed URL bound to
 * Convex File Storage's auth window.
 */
export const getCustomerReceiptPdfUrl = mutationGeneric({
  args: { receiptId: v.id("receipts") },
  handler: async (
    ctx: MutationCtx,
    args: GetCustomerReceiptPdfUrlArgs,
  ): Promise<CustomerReceiptPdfUrlResult | null> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) return null;

    // Walk the receipt → payment → contract → customer chain. The
    // `payments.contractId` field is optional + stored as a string in
    // the schema, so we resolve it through a typed cast that mirrors
    // the rest of this file's payments accesses.
    const payment = await ctx.db.get(receipt.paymentId);
    if (payment === null) return null;
    if (payment.contractId === undefined) return null;
    const contract = await ctx.db.get(
      payment.contractId as unknown as ContractId,
    );
    if (contract === null) return null;
    if (contract.customerId !== customer._id) return null;

    // Ownership confirmed. Now decide between "ready" and
    // "not-yet-generated" — both belong to the same customer, but only
    // the former produces a non-null URL.
    if (receipt.pdfStorageId === undefined) {
      // PDF not generated yet. Still audit the attempt (a download
      // click on a not-yet-rendered receipt IS a PII-access event in
      // the breach-response sense — the customer is asking the system
      // for receipt material at this timestamp). Skip the download-
      // count bump; the metric only counts successful downloads.
      await emitAudit(ctx, {
        action: "read_pii",
        entityType: "receipt",
        entityId: receipt._id,
        after: {
          kind: "receipt_pdf_download_attempt",
          ready: false,
          receiptNumber: receipt.receiptNumber,
        },
      });
      return {
        url: null,
        ready: false,
        generatedAt: null,
        receiptNumber: receipt.receiptNumber,
      };
    }
    const url = await ctx.storage.getUrl(receipt.pdfStorageId);
    // Bump the download counter (denormalised aggregate — the audit
    // log row below is the canonical access set). `undefined → 1` keeps
    // pre-fix rows schema-valid without backfill.
    const previousCount = receipt.downloadCount ?? 0;
    await ctx.db.patch(receipt._id, {
      downloadCount: previousCount + 1,
    });
    await emitAudit(ctx, {
      action: "read_pii",
      entityType: "receipt",
      entityId: receipt._id,
      after: {
        kind: "receipt_pdf_download",
        ready: url !== null,
        receiptNumber: receipt.receiptNumber,
        downloadCount: previousCount + 1,
      },
    });
    return {
      url: url ?? null,
      ready: url !== null,
      generatedAt: receipt.pdfGeneratedAt ?? null,
      receiptNumber: receipt.receiptNumber,
    };
  },
});

/**
 * Function ref to the staff-side mutation that schedules the receipt
 * PDF generation action. Customers don't get a separate scheduler —
 * Story 3.13's `generateReceiptPdfRequest` is idempotent (returns
 * `"ready"` immediately when `pdfStorageId` is already set, or
 * `"scheduled"` when it queues a fresh action invocation). We delegate
 * to it so customer-triggered generation reuses the same render path
 * staff use.
 *
 * Why a separate customer-side wrapper (this `requestCustomerReceiptPdf`)
 * rather than letting the customer-portal client call the staff
 * mutation directly: the staff mutation is gated on
 * `["admin", "office_staff"]`. A customer caller would receive
 * FORBIDDEN. The wrapper here re-runs the ownership check on the
 * customer's side, then schedules the action via the same internal
 * function ref.
 */
const staffGenerateReceiptPdfRequestRef = makeFunctionReference<
  "mutation",
  { receiptId: ReceiptId },
  { receiptId: ReceiptId; status: "ready" | "scheduled" | "not_found" }
>("receipts:generateReceiptPdfRequest");

/**
 * Action ref for the underlying `generateReceiptPdf` action — see
 * `convex/actions/generateReceiptPdf.ts`. Used directly here because
 * the staff mutation's role gate would reject a customer caller, so
 * we cannot delegate via `runMutation`. Instead we replicate the
 * mutation's "if already ready, no-op; else schedule" semantics
 * inline, with the customer role gate + ownership check in front.
 */
const generateReceiptPdfActionRef = makeFunctionReference<
  "action",
  { receiptId: ReceiptId },
  { storageId: string; generatedAt: number } | null
>("actions/generateReceiptPdf:generateReceiptPdf");

/**
 * Action ref for the account-email-change security notification
 * (Epic 9 H1). Scheduled fire-and-forget from `updateCustomerContact`
 * when a customer changes their portal email; emails the PREVIOUS
 * address so an unauthorized change is visible to the real owner.
 */
const sendAccountEmailChangedRef = makeFunctionReference<
  "action",
  { previousEmail: string; newEmail: string; customerName: string },
  { sent: boolean }
>("actions/sendAccountEmailChanged:send");

/**
 * Public arg shape for `requestCustomerReceiptPdf`.
 */
export interface RequestCustomerReceiptPdfArgs {
  receiptId: ReceiptId;
}

/**
 * Return shape for `requestCustomerReceiptPdf`.
 *
 *   - `"ready"`     — `pdfStorageId` already set; client can call
 *                     `getCustomerReceiptPdfUrl` immediately.
 *   - `"scheduled"` — fresh action invocation queued. Client subscribes
 *                     to `getCustomerReceiptPdfUrl` and waits for
 *                     `ready: true`.
 *   - `"not_found"` — receipt does not exist OR does not belong to the
 *                     calling customer. Surface as a 404 panel client-side.
 */
export interface RequestCustomerReceiptPdfResult {
  receiptId: ReceiptId;
  status: "ready" | "scheduled" | "not_found";
}

/**
 * Public mutation: schedule the receipt-PDF generation action for a
 * receipt the customer owns. The mutation:
 *
 *   1. Role-gates the caller (`customer`).
 *   2. Resolves the calling customer.
 *   3. Verifies the receipt belongs to the customer via the payment →
 *      contract → customer chain (same logic as
 *      `getCustomerReceiptPdfUrl`).
 *   4. Short-circuits with `"ready"` when `pdfStorageId` is already set.
 *   5. Otherwise schedules the Story 3.13 action via
 *      `ctx.scheduler.runAfter(0, ...)` and returns `"scheduled"`.
 *
 * Idempotency: a second call while the action is already in flight will
 * see `pdfStorageId === undefined` and schedule a SECOND action. The
 * Story 3.13 action handles this gracefully (the second run overwrites
 * `pdfStorageId` to its blob); the cost is one redundant PDF render.
 * Acceptable for Phase 1 — Phase 2 may add an in-flight marker if the
 * cost becomes noticeable.
 *
 * Non-ownership returns `"not_found"` (NOT throw FORBIDDEN — 404-over-
 * 403, Story 9.1 ADR).
 */
export const requestCustomerReceiptPdf = mutationGeneric({
  args: { receiptId: v.id("receipts") },
  handler: async (
    ctx: MutationCtx,
    args: RequestCustomerReceiptPdfArgs,
  ): Promise<RequestCustomerReceiptPdfResult> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const receipt = await ctx.db.get(args.receiptId);
    if (receipt === null) {
      return { receiptId: args.receiptId, status: "not_found" };
    }
    const payment = await ctx.db.get(receipt.paymentId);
    if (payment === null) {
      return { receiptId: args.receiptId, status: "not_found" };
    }
    if (payment.contractId === undefined) {
      return { receiptId: args.receiptId, status: "not_found" };
    }
    const contract = await ctx.db.get(
      payment.contractId as unknown as ContractId,
    );
    if (contract === null) {
      return { receiptId: args.receiptId, status: "not_found" };
    }
    if (contract.customerId !== customer._id) {
      return { receiptId: args.receiptId, status: "not_found" };
    }

    if (receipt.pdfStorageId !== undefined) {
      // Story 9.3 NFR-S8 fix: audit the no-op "ready" branch too. A
      // customer asking for a PDF render IS an audit-worthy event
      // regardless of whether a render is actually scheduled — the
      // request reflects intent to access PII material at this
      // timestamp. The kind discriminator distinguishes the "already
      // ready" branch from the "freshly scheduled" branch below.
      await emitAudit(ctx, {
        action: "create",
        entityType: "receipt",
        entityId: receipt._id,
        after: {
          kind: "receipt_pdf_render_requested",
          status: "ready",
          receiptNumber: receipt.receiptNumber,
        },
      });
      return { receiptId: args.receiptId, status: "ready" };
    }
    await ctx.scheduler.runAfter(0, generateReceiptPdfActionRef, {
      receiptId: args.receiptId,
    });
    // Story 9.3 NFR-S8 fix: emit a create audit row capturing the
    // render request. `entityType: "receipt"` + `action: "create"`
    // matches the cornerstone's audit vocabulary for "new related
    // artefact about this entity is being prepared." The audit row
    // lands inside the same mutation transaction as the scheduler
    // call, so a failed audit-write rolls the schedule back too.
    await emitAudit(ctx, {
      action: "create",
      entityType: "receipt",
      entityId: receipt._id,
      after: {
        kind: "receipt_pdf_render_requested",
        status: "scheduled",
        receiptNumber: receipt.receiptNumber,
      },
    });
    return { receiptId: args.receiptId, status: "scheduled" };
  },
});

// Re-export of the staff-side mutation ref so a future story that adds
// admin-impersonation flows can pick up the same handle without
// duplicating the lookup string. The wrapper above never calls it (the
// staff mutation rejects a customer caller); this is a documentation
// anchor only.
void staffGenerateReceiptPdfRequestRef;

// ---------------------------------------------------------------------------
// Story 9.4 — customer updates own contact info (FR58).
//
// First WRITE path through the customer portal. Stories 9.1–9.3 are
// read-only; this mutation introduces the customer-write pattern that
// Stories 9.5 / 9.6 (payment-initiation) will reuse:
//
//   1. The mutation does NOT accept a `customerId` argument from the
//      client. The target row id is derived server-side via
//      `requireCurrentCustomer(ctx)` (role gate + email-link resolution).
//      Cross-customer writes are impossible by construction — the type
//      system forbids the client from naming another customer's row.
//
//   2. Allow-list patch fields: only `phone`, `email`, and `address` are
//      mutable. The patch object is built field-by-field from a fixed
//      set — never `{ ...args }` spread — so a tampered client cannot
//      sneak `name` / `govIdNumber` / `_id` / `hasConsent` through.
//      Identity fields (`fullName`, `govIdNumber`, `govIdType`) require
//      staff verification per FR58 and remain read-only from the portal.
//
//   3. Audit diff: every successful patch emits a single `update` row
//      capturing the before/after of the changed contact fields only —
//      never the full customer document (keeps the audit log lean and
//      avoids re-leaking gov-ID through the audit trail). The
//      `emitAudit` helper's `redactPii` redacts `address` to per-token
//      initials at write time (NFR-S8 breach-response trail without
//      re-exposing full PII to audit readers).
//
//   4. PH-only phone format: launch scope per the brief targets Twilio
//      PH numbers (FR57). The validator accepts `+639XXXXXXXXX` and
//      `09XXXXXXXXX`; both are normalised to the `+63` form on write so
//      downstream SMS callers see a single canonical shape. Overseas
//      customers are a Phase 4 widening.
// ---------------------------------------------------------------------------

/**
 * Shape returned by `getCurrentCustomerAccount` — the read surface for
 * the Story 9.4 account form. Narrower than the staff-side
 * `getCustomerDetail` (which is gated on admin/office_staff):
 *
 *   - `govIdLast4` is the redacted form; the full gov-ID is NEVER
 *     returned to the portal (FR58: identity-field changes require
 *     staff verification, so the customer never needs the full ID
 *     via the portal).
 *   - `address` is returned in full because the customer already knows
 *     their own address and the editable form must pre-fill it.
 *   - The full email is returned (the customer's own auth email) so
 *     the form can display "currently we email you at …".
 *
 * Why a dedicated read query (instead of widening `getCurrentCustomer`
 * from Story 9.1): the Story 9.1 surface is the lightweight greeting
 * payload used by the dashboard header. Widening it to carry the full
 * address + gov-ID-last4 would broaden every page's PII surface for
 * the sake of one screen. The account page is the only place that
 * needs this richer shape, so the read lives in a dedicated query.
 */
export interface CurrentCustomerAccountProfile {
  customerId: CustomerId;
  fullName: string;
  email: string;
  phone: string | null;
  address: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
  govIdType: string;
  govIdLast4: string;
  /**
   * Whether the customer has opted OUT of payment reminders (Story 9.8).
   * Drives the reminder-preference toggle on `/portal/account`; the
   * customer flips it via `reminders:updateMyReminderOptOut`.
   */
  reminderOptOut: boolean;
}

/**
 * Returns the last 4 alphanumeric characters of `raw` after stripping
 * formatting (dashes / spaces). Mirrors the staff-side `lastFourAlnum`
 * in `convex/customers.ts` — that file is read-only per the Story 9.4
 * file-ownership policy, so we duplicate the four-line helper rather
 * than import across the policy boundary. The function never throws;
 * short inputs degrade gracefully.
 */
function portalLastFourAlnum(raw: string): string {
  const compact = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (compact.length <= 4) return compact;
  return compact.slice(-4);
}

/**
 * Customer-portal read for the account-update screen (Story 9.4).
 *
 * Authorization: `requireRole(ctx, ["customer"])` via
 * `requireCurrentCustomer`. Staff users hit FORBIDDEN — the staff-side
 * equivalent is `customers.getCustomerDetail` which is gated on
 * admin/office_staff and routes through `readPii` for the full gov-ID.
 *
 * PII posture: returns the redacted gov-ID (last-4 only), the full
 * email + phone + address (the customer's own — they already know
 * these), and the structured address sub-object. No `auditLog` write
 * happens here because (a) it's a query and queries cannot emit
 * audit, and (b) the customer reading their OWN data is not a
 * PII-access event in the NFR-S8 sense (the access log captures
 * cross-customer reads by staff).
 */
export const getCurrentCustomerAccount = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<CurrentCustomerAccountProfile> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const result: CurrentCustomerAccountProfile = {
      customerId: customer._id,
      fullName: customer.fullName,
      email: customer.email ?? "",
      phone: customer.phone ?? null,
      address: customer.address,
      govIdType: customer.govIdType,
      govIdLast4: portalLastFourAlnum(customer.govIdNumber),
      reminderOptOut: customer.reminderOptOut ?? false,
    };
    return result;
  },
});

/**
 * Public arg shape for `updateCustomerContact`. Address is the full
 * structured sub-object (matches `customers.address` in `schema.ts` and
 * the staff-side `customers.create` shape). When `address` is supplied,
 * it must include `line1`; the other lines are optional per the table
 * validator. Omitting `address` leaves the existing address untouched.
 *
 * The argument set is intentionally narrow — `fullName`, `govIdNumber`,
 * `govIdType`, and `hasConsent` are NOT accepted. The Convex `args`
 * validator below would reject any extra keys at the wire boundary, but
 * even if a client built a payload that bypassed the validator, the
 * handler's field-by-field allow-list defeats spread tampering.
 */
export interface UpdateCustomerContactArgs {
  phone?: string;
  email?: string;
  address?: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
}

/**
 * Result shape for `updateCustomerContact`. Intentionally narrow — we
 * return only the calling customer's `_id` and a snapshot of the
 * applied fields. Returning the full customer document would defeat
 * the read-side allow-list pattern (`getCurrentCustomer` already
 * decides what the portal sees on read; the mutation must not be a
 * back-door for richer field exposure).
 */
export interface UpdateCustomerContactResult {
  customerId: CustomerId;
  updatedFields: Array<"phone" | "email" | "address">;
}

/**
 * Validator mirror of the structured address sub-object. Matches the
 * `customers.address` validator in `convex/schema.ts` exactly so a
 * tampered client cannot smuggle additional keys (Convex rejects
 * unknown object keys at the wire boundary).
 */
const portalAddressValidator = v.object({
  line1: v.string(),
  barangay: v.optional(v.string()),
  cityMunicipality: v.optional(v.string()),
  province: v.optional(v.string()),
  postalCode: v.optional(v.string()),
});

/**
 * Conservative email-shape check. Mirrors `convex/customers.ts`'s
 * `isPlausibleEmail` rather than importing it (that file is read-only
 * per the Story 9.4 file-ownership policy). The source of truth for
 * deliverability is still the email provider's bounce — this guard
 * exists to reject the obviously-malformed inputs before they reach
 * the audit log.
 */
function isPlausibleCustomerEmail(value: string): boolean {
  if (value.length < 3) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at === value.length - 1) return false;
  if (value.includes(" ")) return false;
  return value.lastIndexOf(".") > at;
}

/**
 * Filipino phone-number shape check + normaliser.
 *
 * Accepts both common consumer forms:
 *   - `+639XXXXXXXXX` (international, e.164)
 *   - `09XXXXXXXXX`   (national, the form most customers type)
 *
 * Returns the normalised `+63` form when the input matches, or
 * `null` when it doesn't. Internal punctuation (spaces, dashes,
 * dots) is stripped before matching so the customer can type
 * `0917-555-1234` without the validator rejecting it; the stored
 * form is always compact (`+639175551234`) so downstream SMS / lookup
 * callers see a single canonical shape (NFR-D2 data uniformity).
 *
 * Returns `null` for anything that doesn't match a PH mobile number;
 * the handler throws `VALIDATION` on null.
 */
function normalizePhPhone(raw: string): string | null {
  const compact = raw.replace(/[\s\-.()]/g, "");
  // `09XXXXXXXXX` — 11 digits starting with 09.
  if (/^09\d{9}$/.test(compact)) {
    return `+63${compact.slice(1)}`;
  }
  // `+639XXXXXXXXX` — 13 chars starting with +639.
  if (/^\+639\d{9}$/.test(compact)) {
    return compact;
  }
  return null;
}

/**
 * Public mutation: update the calling customer's own contact info
 * (FR58). The first customer-write surface in the portal.
 *
 * Authorization:
 *   - `requireRole(ctx, ["customer"])` via `requireCurrentCustomer` —
 *     staff users (admin / office_staff / field_worker) receive
 *     FORBIDDEN. Staff-side contact-info edits live in a separate
 *     mutation under `convex/customers.ts` with the appropriate role
 *     gate; this surface is customer-only.
 *   - Own-record-only guard at the type level — `args` does NOT
 *     include `customerId`. The target row is derived from the auth
 *     identity (`requireCurrentCustomer` resolves the email link).
 *     Cross-customer write is impossible by construction.
 *
 * Allow-list patching:
 *   - Build `patch` from a fixed set of allow-listed keys (`phone`,
 *     `email`, `address`). Never spread `...args` — a tampered client
 *     could otherwise smuggle `fullName`, `govIdNumber`, `govIdType`,
 *     `hasConsent`, etc. into the patch.
 *   - `name` and `govIdNumber` require staff verification (FR58):
 *     name change implies legal documentation; gov-ID change implies
 *     identity-document re-scan. Both stay editable only through the
 *     staff-side surface.
 *
 * Validation:
 *   - Email: trimmed + lowercased; rejected when `isPlausibleEmail`
 *     fails. The validator is conservative — the email provider's
 *     bounce is the source of truth for deliverability.
 *   - Phone: trimmed + normalised to `+63` form via `normalizePhPhone`;
 *     rejected when the input is neither `09XXXXXXXXX` nor
 *     `+639XXXXXXXXX`. PH-only at launch (FR57 SMS reminders); an
 *     overseas-customer widening is a Phase 4 conversation.
 *   - Address: `line1` must be non-empty after trim; the other lines
 *     are optional. Matches the `customers.create` invariants from
 *     Story 2.1 so the staff-edit and portal-edit paths produce the
 *     same shape.
 *
 * Audit:
 *   - Emits a single `update` audit row with `entityType: "customer"`,
 *     `entityId: customerId`, and a before/after diff containing ONLY
 *     the changed contact fields. The `emitAudit` helper's `redactPii`
 *     redacts the address tokens at write time so the audit trail
 *     stores per-token initials rather than the full address string
 *     (NFR-S8 breach-impact queries get the diff signal without
 *     re-exposing full PII in the log).
 *
 * No-op short-circuit:
 *   - If `args` contains zero recognised fields, the mutation returns
 *     `updatedFields: []` and does NOT emit an audit row. A "submit
 *     without changes" UX is harmless and shouldn't pollute the audit
 *     log. The client is still expected to gate the Save button on a
 *     dirty state, but the server's no-op behaviour keeps the audit
 *     trail clean if the dirty-state gate is bypassed.
 */
export const updateCustomerContact = mutationGeneric({
  args: {
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    address: v.optional(portalAddressValidator),
  },
  handler: async (
    ctx: MutationCtx,
    args: UpdateCustomerContactArgs,
  ): Promise<UpdateCustomerContactResult> => {
    // We need the resolved AUTH identity (userId + current login email),
    // not just the customer row, so we can keep the auth account in
    // lockstep when the email changes (see the email-sync block below).
    // `requireCurrentCustomer` would discard `auth`, so we inline its
    // two-step resolution (role gate, then email-link lookup).
    const auth = await requireRole(ctx, ["customer"]);
    const customer = await resolveCurrentCustomer(ctx, auth.user.email);
    if (customer === null) {
      throwError(
        ErrorCode.NOT_FOUND,
        "We couldn't find a customer record linked to your account. Please contact the cemetery office.",
        { entity: "customer" },
      );
    }

    // Build the patch object field-by-field from the allow-list.
    // Never spread `{ ...args }` here — that would re-introduce the
    // tampering hole the own-record-only + allow-list pattern is
    // designed to close.
    const patch: {
      phone?: string;
      email?: string;
      address?: UpdateCustomerContactArgs["address"];
      updatedAt?: number;
    } = {};
    const updatedFields: Array<"phone" | "email" | "address"> = [];

    if (args.phone !== undefined) {
      const trimmed = args.phone.trim();
      if (trimmed.length === 0) {
        throwError(ErrorCode.VALIDATION, "Phone is required.", {
          field: "phone",
        });
      }
      const normalised = normalizePhPhone(trimmed);
      if (normalised === null) {
        throwError(
          ErrorCode.VALIDATION,
          "Phone must be a Philippine mobile number (e.g. 09171234567 or +639171234567).",
          { field: "phone" },
        );
      }
      patch.phone = normalised;
      updatedFields.push("phone");
    }

    if (args.email !== undefined) {
      const trimmed = args.email.trim().toLowerCase();
      if (trimmed.length === 0) {
        throwError(ErrorCode.VALIDATION, "Email is required.", {
          field: "email",
        });
      }
      if (!isPlausibleCustomerEmail(trimmed)) {
        throwError(ErrorCode.VALIDATION, "Email is not a valid address.", {
          field: "email",
        });
      }
      // Email-uniqueness guard (Epic 9 C1 — portal-lockout defence).
      // Portal identity is resolved by matching the auth email against
      // `customers.email`; `resolveCurrentCustomer` fails CLOSED when more
      // than one row matches (returns null → NOT_FOUND on every portal
      // surface). Without this guard a customer could set their email to a
      // value already on another customer's record, producing two matches
      // for that address and locking the *other* customer out of the
      // entire portal. Reject any collision with a different row. Only
      // scan when the value is actually changing (mirrors the bounce-clear
      // diff below); the full-table scan is consistent with
      // `resolveCurrentCustomer`, which also has no `by_email` index.
      if (trimmed !== (customer.email ?? "").trim().toLowerCase()) {
        const allCustomers = await ctx.db.query("customers").collect();
        const collides = allCustomers.some(
          (r) =>
            r._id !== customer._id &&
            (r.email ?? "").trim().toLowerCase() === trimmed,
        );
        if (collides) {
          throwError(
            ErrorCode.VALIDATION,
            "That email is already on file for another account. Contact the cemetery office if this is your address.",
            { field: "email" },
          );
        }
      }
      patch.email = trimmed;
      updatedFields.push("email");
    }

    if (args.address !== undefined) {
      const line1 = args.address.line1.trim();
      if (line1.length === 0) {
        throwError(ErrorCode.VALIDATION, "Address line 1 is required.", {
          field: "addressLine1",
        });
      }
      // Strip optional sub-fields to absence (Convex's optional-field
      // validators reject `""` but accept missing keys). Mirrors the
      // staff-side trimming pattern in `customers.create`.
      const nextAddress: NonNullable<UpdateCustomerContactArgs["address"]> = {
        line1,
      };
      if (args.address.barangay !== undefined) {
        const t = args.address.barangay.trim();
        if (t.length > 0) nextAddress.barangay = t;
      }
      if (args.address.cityMunicipality !== undefined) {
        const t = args.address.cityMunicipality.trim();
        if (t.length > 0) nextAddress.cityMunicipality = t;
      }
      if (args.address.province !== undefined) {
        const t = args.address.province.trim();
        if (t.length > 0) nextAddress.province = t;
      }
      if (args.address.postalCode !== undefined) {
        const t = args.address.postalCode.trim();
        if (t.length > 0) nextAddress.postalCode = t;
      }
      patch.address = nextAddress;
      updatedFields.push("address");
    }

    // No-op short-circuit. The client's dirty-state gate should
    // prevent this, but the server stays clean if it doesn't.
    if (updatedFields.length === 0) {
      return { customerId: customer._id, updatedFields };
    }

    // Stamp `updatedAt` on every write so reporting / breach-response
    // queries can answer "which customers changed contact info since
    // <date>" without scanning the audit log.
    patch.updatedAt = Date.now();

    // Story 9.8 — clearing the email-bounce flag.
    //
    // When the customer updates their email TO A DIFFERENT ADDRESS AND
    // the prior address was hard-bounced, the new address gets a fresh
    // chance. The bounce flag is cleared in the same patch so
    // subsequent reminder scans re-include the customer in the email
    // branch. The bounce metadata fields are flagged for removal by
    // setting them to `undefined` in the patch — Convex's
    // optional-field update semantics treat `undefined` as "clear this
    // field."
    //
    // The auto-clear ONLY applies when `email` is the changed field
    // AND the new email actually differs from the current one; it does
    // not fire for phone or address updates (the bad-email state is
    // orthogonal to those), and a "submit the same address" no-op
    // update MUST NOT clear the bounce — P1-3 (Story 9.8 review). A
    // bounced customer re-entering their already-bad email would
    // otherwise un-pause the deliverability-suicide loop on every save
    // click.
    const willClearBounceState =
      patch.email !== undefined &&
      patch.email !== customer.email &&
      customer.emailBouncedAt !== undefined;
    type WriteablePatch = typeof patch & {
      emailBouncedAt?: undefined;
      emailReminderPausedReason?: undefined;
      emailBounceMessageId?: undefined;
    };
    if (willClearBounceState) {
      (patch as WriteablePatch).emailBouncedAt = undefined;
      (patch as WriteablePatch).emailReminderPausedReason = undefined;
      (patch as WriteablePatch).emailBounceMessageId = undefined;
    }

    // Capture the BEFORE snapshot of ONLY the changed fields. The
    // audit row reflects the customer's actual change, not the full
    // document — keeps the audit log lean (NFR-S8) and avoids
    // re-emitting the full address / gov-ID through the audit trail.
    const before: {
      phone?: string;
      email?: string;
      address?: CustomerDoc["address"];
    } = {};
    const after: {
      phone?: string;
      email?: string;
      address?: CustomerDoc["address"];
    } = {};
    if (patch.phone !== undefined) {
      if (customer.phone !== undefined) before.phone = customer.phone;
      after.phone = patch.phone;
    }
    if (patch.email !== undefined) {
      if (customer.email !== undefined) before.email = customer.email;
      after.email = patch.email;
    }
    if (patch.address !== undefined) {
      before.address = customer.address;
      after.address = patch.address;
    }

    // Epic 9 H1 — keep the AUTH identity in lockstep with the email.
    // Portal ownership resolves by matching the auth user's email
    // (`users.email`, set at invite acceptance) against `customers.email`.
    // Patching only `customers.email` would leave the auth email pointing
    // at the OLD address, so the very next request resolves to ZERO
    // customer matches and the customer is locked out of their own portal.
    // When the email changes we therefore also move the linked `users`
    // row + the password `authAccounts` login handle to the new address,
    // inside this same transaction.
    const emailIsChanging =
      patch.email !== undefined &&
      patch.email !== (customer.email ?? "").trim().toLowerCase();
    if (emailIsChanging) {
      const newEmail = patch.email as string;
      const oldLoginEmail = (auth.user.email ?? "").trim().toLowerCase();
      // Defense in depth on the AUTH surface (the customers-email
      // uniqueness guard above only covers `customers` rows): the new
      // address must not already be a password login for a DIFFERENT
      // user (e.g. a staff account).
      const accountsForNewEmail = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "password").eq("providerAccountId", newEmail),
        )
        .collect();
      if (accountsForNewEmail.some((a) => a.userId !== auth.userId)) {
        throwError(
          ErrorCode.VALIDATION,
          "That email is already in use by another account. Contact the cemetery office if this is your address.",
          { field: "email" },
        );
      }
      // Move the auth user's email so `resolveCurrentCustomer` keeps
      // matching this customer on the next request.
      await ctx.db.patch(auth.userId, { email: newEmail });
      // Move the password account's login handle (providerAccountId) so
      // the customer signs in with the new address going forward.
      const myPasswordAccounts = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "password").eq("providerAccountId", oldLoginEmail),
        )
        .collect();
      for (const acct of myPasswordAccounts) {
        if (acct.userId === auth.userId) {
          await ctx.db.patch(acct._id, { providerAccountId: newEmail });
        }
      }
      // Security notification via Resend (fire-and-forget): tell the
      // PREVIOUS address the login email changed, so a hijacked-session
      // change is visible to the legitimate owner.
      if (oldLoginEmail.length > 0) {
        await ctx.scheduler.runAfter(0, sendAccountEmailChangedRef, {
          previousEmail: oldLoginEmail,
          newEmail,
          customerName: customer.fullName,
        });
      }
    }

    await ctx.db.patch(customer._id, patch);

    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: customer._id,
      before,
      after,
    });

    return { customerId: customer._id, updatedFields };
  },
});

// ---------------------------------------------------------------------------
// Story 9.5 + 9.6 — portal payment intents (GCash, Maya, card) (FR33).
//
// Three surfaces:
//
//   1. `createGatewayPaymentIntent` — customer-role mutation that
//      validates ownership + amount, inserts a `paymentIntents` row in
//      `pending` state, and schedules `actions/gatewayCreateIntent` to
//      call the gateway's hosted-checkout API. Returns the
//      Convex-minted `intentId` to the client; the action patches the
//      row with the gateway-supplied `redirectUrl` + `gatewayIntentId`
//      so the customer can be redirected via a follow-up reactive
//      read on the same row.
//
//   2. `getCustomerPaymentIntent` — customer-role reactive query the
//      `/portal/pay/return` page subscribes to. Returns the narrow
//      shape (status, completedAt, failureReason, paymentId,
//      redirectUrl-on-pending) so the page can render the
//      "confirming…" / "succeeded" / "failed" / "expired" branches
//      without a polling loop.
//
//   3. `handleGatewayWebhook` — INTERNAL mutation invoked from the
//      `convex/http.ts` webhook routes after signature verification.
//      Idempotency anchor = `paymentIntents.completedAt` (terminal
//      state once set). Routes through `postFinancialEvent` for
//      atomic payment + receipt + audit writes. Defers email-receipt
//      delivery to a scheduler callback so the webhook ACK stays
//      inside the NFR-I2 5-second budget.
//
// Conventions inherited from Story 9.1 / 9.2 / 9.4:
//   - role gate first line (`requireCurrentCustomer`).
//   - own-record-only at the type system (no client-supplied
//     `customerId` on the public mutation surface).
//   - 404-over-403 on ownership miss (existence-enumeration defence).
//   - PHP-only currency (NFR architecture); integer centavos.
//   - field-by-field patch (never spread args).
// ---------------------------------------------------------------------------

type _PaymentIntentDoc = DataModel["paymentIntents"]["document"];

/**
 * Shape returned by `createGatewayPaymentIntent`. The client navigates
 * to `redirectUrl` on success; the `paymentIntentId` is the polling
 * key for the return page.
 *
 * `redirectUrl` is intentionally provided synchronously: the calling
 * mutation runs the action via `ctx.scheduler.runAfter(0, ...)` AND
 * pre-computes a `/portal/pay/return?intent=<id>` waiting URL the
 * client can navigate to immediately. The return page reads the
 * `paymentIntents` row reactively; when the action patches
 * `redirectUrl` onto the row, the page kicks the browser to that URL.
 *
 * Phase 1 sandbox / mock path: the adapter's `createIntent` returns a
 * static `/portal/pay/mock-gateway?...` URL, which is also patched
 * onto the row by the action. The same flow works end-to-end without
 * production credentials.
 */
export interface CreateGatewayPaymentIntentResult {
  paymentIntentId: string;
}

export interface CreateGatewayPaymentIntentArgs {
  contractId: ContractId;
  amountCents: number;
  gateway: GatewayId;
}

/**
 * Internal helper — mints a UUID-v4 string using the WebCrypto API.
 * Convex's V8 runtime exposes `crypto.randomUUID()` (standard since
 * Node 19 + modern V8). Centralised here so the call site reads
 * naturally and the casing assumption is one place.
 */
function mintIntentId(): string {
  return crypto.randomUUID();
}

/**
 * Mutation: initiate a portal payment intent against the chosen
 * gateway. Customer-role-gated + ownership-scoped to the calling
 * customer.
 *
 * Validation:
 *   - `amountCents` must be a positive integer ≤ the contract's
 *     outstanding balance (computed in-handler via `sumPaidCents`).
 *   - The contract must exist AND be owned by the calling customer.
 *     Ownership miss returns 404-class via `NOT_FOUND` (the
 *     mutation's args type forbids a client from naming another
 *     customer's contract by id, but defensive checks belong here).
 *   - The contract must be in a state that accepts new payments
 *     (`active`). Closed / cancelled / voided contracts reject.
 *
 * Side effects (in transaction order):
 *   1. Insert the `paymentIntents` row with `status: "pending"` and
 *      the server-minted `intentId`.
 *   2. Schedule `actions/gatewayCreateIntent` to call the gateway's
 *      API. The action patches the row with the gateway-supplied
 *      `redirectUrl` + `gatewayIntentId` when it finishes (the
 *      action runs on the same transaction Convex's scheduler emits
 *      next; the return page subscribes reactively).
 *
 * Audit: payment-intent INITIATION emits a single `create` audit row
 * via the standard helper (operational visibility — Story 9.5 spec
 * § "audit the initiation"). The financial-event audit row is
 * written later by `postFinancialEvent` when the webhook lands.
 *
 * Returns: `{ paymentIntentId }` — the client polls via
 * `getCustomerPaymentIntent` for the `redirectUrl` to land.
 */
export const createGatewayPaymentIntent = mutationGeneric({
  args: {
    contractId: v.id("contracts"),
    amountCents: v.number(),
    gateway: v.union(
      v.literal("gcash"),
      v.literal("maya"),
      v.literal("card"),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: CreateGatewayPaymentIntentArgs,
  ): Promise<CreateGatewayPaymentIntentResult> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.");
    }
    if (contract.customerId !== customer._id) {
      // 404-over-403 — Story 9.1 ADR. We do NOT throw FORBIDDEN here
      // because that would leak existence of other customers'
      // contracts via the error-code discriminator.
      throwError(ErrorCode.NOT_FOUND, "Contract not found.");
    }
    if (contract.state !== "active") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Contract is not active for payments.",
        { contractId: args.contractId, state: contract.state },
      );
    }
    if (
      !Number.isFinite(args.amountCents) ||
      !Number.isInteger(args.amountCents) ||
      args.amountCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Amount must be a positive integer in centavos.",
        { amountCents: args.amountCents },
      );
    }
    const paidCents = await sumPaidCents(ctx, contract._id);
    const outstanding = Math.max(0, contract.totalPriceCents - paidCents);
    if (args.amountCents > outstanding) {
      throwError(
        ErrorCode.VALIDATION,
        "Payment amount exceeds the contract's outstanding balance.",
        {
          amountCents: args.amountCents,
          outstandingBalanceCents: outstanding,
        },
      );
    }

    const intentId = mintIntentId();
    const now = Date.now();
    const insertedId = await ctx.db.insert("paymentIntents", {
      provider: args.gateway,
      intentId,
      customerId: customer._id,
      contractId: args.contractId,
      amountCents: args.amountCents,
      status: "pending",
      createdAt: now,
    });

    // Audit the initiation. Operational visibility per Story 9.5
    // Dev Notes § "audit the initiation" — the financial event
    // proper is audited later by `postFinancialEvent` when the
    // webhook lands.
    await emitAudit(ctx, {
      action: "create",
      entityType: "payment",
      entityId: insertedId,
      after: {
        kind: "payment_intent_initiated",
        provider: args.gateway,
        intentId,
        contractId: args.contractId,
        amountCents: args.amountCents,
      },
    });

    // Schedule the action that calls the gateway. `runAfter(0)` fires
    // immediately after the enclosing mutation commits. The action
    // patches the row with `redirectUrl` + `gatewayIntentId` so the
    // return page can navigate the customer to the gateway's hosted
    // checkout.
    await ctx.scheduler.runAfter(0, gatewayCreateIntentActionRef, {
      paymentIntentId: intentId,
      gateway: args.gateway,
      amountCents: args.amountCents,
      currency: "PHP",
      returnUrl: `/portal/pay/return?intent=${intentId}`,
      contractId: args.contractId as unknown as string,
      customerId: customer._id as unknown as string,
    });

    return { paymentIntentId: intentId };
  },
});

/**
 * Public arg shape for `getCustomerPaymentIntent`.
 */
export interface GetCustomerPaymentIntentArgs {
  paymentIntentId: string;
}

/**
 * Result shape for `getCustomerPaymentIntent`. Narrow projection —
 * the return page only needs status + redirect + receipt-link
 * affordances.
 */
export interface CustomerPaymentIntentView {
  paymentIntentId: string;
  provider: GatewayId;
  status: "pending" | "succeeded" | "failed" | "expired";
  amountCents: number;
  contractId: ContractId;
  createdAt: number;
  completedAt: number | null;
  redirectUrl: string | null;
  gatewayTransactionId: string | null;
  failureReason: string | null;
  paymentId: PaymentId | null;
}

/**
 * Reactive query — the `/portal/pay/return` page subscribes here and
 * re-renders as the webhook lands. No `setInterval` polling: Convex
 * pushes the updated row on patch.
 *
 * Ownership scoping: the row must belong to the calling customer.
 * Non-ownership returns `null` (NOT throw FORBIDDEN — 404-over-403,
 * Story 9.1 ADR).
 *
 * `redirectUrl` is exposed only while `status === "pending"` — once
 * the intent reaches a terminal state, the gateway's checkout URL is
 * no longer actionable (the customer either succeeded, failed, or
 * timed out). Returning null in that case prevents stale navigation.
 */
export const getCustomerPaymentIntent = queryGeneric({
  args: { paymentIntentId: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: GetCustomerPaymentIntentArgs,
  ): Promise<CustomerPaymentIntentView | null> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see helper above.
    const customer = await requireCurrentCustomer(ctx);
    const row = await ctx.db
      .query("paymentIntents")
      .withIndex("by_intentId", (q) => q.eq("intentId", args.paymentIntentId))
      .unique();
    if (row === null) return null;
    if (row.customerId !== customer._id) return null;
    return {
      paymentIntentId: row.intentId,
      provider: row.provider,
      status: row.status,
      amountCents: row.amountCents,
      contractId: row.contractId,
      createdAt: row.createdAt,
      completedAt: row.completedAt ?? null,
      // `redirectUrl` is exposed only while the intent is pending — once
      // the intent reaches a terminal state the gateway's checkout URL
      // is no longer actionable; surfacing it would invite stale
      // navigation.
      redirectUrl: row.status === "pending" ? row.redirectUrl ?? null : null,
      gatewayTransactionId: row.gatewayTransactionId ?? null,
      failureReason: row.failureReason ?? null,
      paymentId: row.paymentId ?? null,
    };
  },
});

/**
 * Internal mutation — the webhook route in `convex/http.ts` calls
 * this AFTER signature verification + payload normalisation. The
 * mutation is the single transaction boundary that:
 *
 *   - looks up the matching `paymentIntents` row by `intentId`
 *     (idempotency anchor),
 *   - returns immediately if the row is already in a terminal state
 *     (`completedAt !== undefined`) — re-delivery is a no-op,
 *   - verifies the gateway-discriminator matches (cross-gateway
 *     defence),
 *   - on `succeeded`: cross-checks the webhook-supplied amount against
 *     the row's `amountCents` (defence against compromised webhook
 *     source) and routes through `postFinancialEvent` for the atomic
 *     payment + receipt + audit write,
 *   - on `failed` / `expired`: patches the row with the terminal
 *     status + failure reason; no financial write,
 *   - on `unknown`: returns without state change (forward-compat —
 *     gateway introducing a new event class doesn't tear down a
 *     valid intent).
 *
 * Email-delivery deferral: the success path enqueues a scheduled
 * action for the receipt email (the Phase 1 stub action). The
 * webhook handler MUST stay inside the NFR-I2 5-second ACK budget —
 * email delivery + PDF rendering live in the scheduled action.
 */
export const handleGatewayWebhook = internalMutationGeneric({
  args: {
    gateway: v.union(
      v.literal("gcash"),
      v.literal("maya"),
      v.literal("card"),
    ),
    event: v.object({
      paymentIntentId: v.string(),
      gatewayTransactionId: v.string(),
      status: v.union(
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("expired"),
        v.literal("unknown"),
      ),
      amountCents: v.number(),
      currency: v.string(),
      failureReason: v.optional(v.string()),
      rawEventId: v.optional(v.string()),
    }),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      gateway: GatewayId;
      event: NormalizedGatewayWebhookEvent;
    },
  ): Promise<void> => {
    const row = await ctx.db
      .query("paymentIntents")
      .withIndex("by_intentId", (q) =>
        q.eq("intentId", args.event.paymentIntentId),
      )
      .unique();
    if (row === null) {
      // Unknown intent id. Throw so the gateway sees a 500 and
      // retries — a missing intent could be a delivery-before-create
      // race (unlikely; mutations commit before scheduling actions)
      // or an attacker probing for valid intent ids.
      throwError(ErrorCode.NOT_FOUND, "Unknown payment intent.");
    }
    // Cross-gateway defence: a webhook arriving on the wrong route
    // for a given intent is either a misconfiguration or a replay
    // attack. Reject loudly.
    if (row.provider !== args.gateway) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Gateway mismatch on webhook delivery.",
        {
          intentGateway: row.provider,
          webhookGateway: args.gateway,
        },
      );
    }
    // Idempotency short-circuit. Once `completedAt` is set the intent
    // is in a terminal state; re-delivery is a no-op. This is the
    // single source of truth for "have we processed this webhook?".
    if (row.completedAt !== undefined) {
      return;
    }
    // Unknown status — forward-compat. Log via audit (operational
    // visibility) but do not mutate financial state.
    if (args.event.status === "unknown") {
      await emitAudit(ctx, {
        action: "update",
        entityType: "payment",
        entityId: row._id,
        before: { status: row.status },
        after: {
          kind: "webhook_unknown_status_skipped",
          rawEventId: args.event.rawEventId,
        },
      });
      return;
    }
    // Failure path — patch the row with the terminal status; no
    // financial write.
    if (args.event.status === "failed" || args.event.status === "expired") {
      const failurePatch: {
        status: "failed" | "expired";
        completedAt: number;
        gatewayTransactionId: string;
        failureReason?: string;
      } = {
        status: args.event.status,
        completedAt: Date.now(),
        gatewayTransactionId: args.event.gatewayTransactionId,
      };
      if (args.event.failureReason !== undefined) {
        failurePatch.failureReason = args.event.failureReason;
      }
      await ctx.db.patch(row._id, failurePatch);
      await emitAudit(ctx, {
        action: "update",
        entityType: "payment",
        entityId: row._id,
        before: { status: row.status },
        after: {
          kind: "payment_intent_terminal",
          status: args.event.status,
          gateway: args.gateway,
        },
      });
      return;
    }
    // Success path — cross-check amount, route through the
    // cornerstone, patch the row to terminal.
    if (args.event.amountCents !== row.amountCents) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Webhook-supplied amount does not match the payment intent.",
        {
          intentAmountCents: row.amountCents,
          webhookAmountCents: args.event.amountCents,
        },
      );
    }
    // Look up the customer's auth user to satisfy `receivedByUserId`.
    // The portal-initiated payment is "received" by the customer
    // themselves; we resolve their auth user id via the email link
    // pattern Story 9.1 established.
    //
    // P1-2 adversarial review: the previous "fallback to any user
    // with the customer role" branch was removed. Mis-attributing a
    // financial event to an arbitrary customer breaks the audit
    // trail in the worst possible way (the receipt and audit row
    // carry the wrong `receivedByUserId`). If the email link cannot
    // resolve to a specific user, we now throw INVARIANT_VIOLATION
    // so the gateway sees a 500 and retries while operations is
    // alerted via the throw — far safer than corrupting a permanent
    // financial record.
    // pii-read-ok: webhook-handler lookup — customer fields not returned to gateway; only used to derive the receivedByUserId for postFinancialEvent attribution
    const customer = await ctx.db.get(row.customerId);
    if (customer === null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Payment intent's customer record vanished before webhook delivery.",
      );
    }
    const customerEmail = customer.email ?? "";
    // Resolve the user id by email. The portal user authenticates
    // with the same email the customer record carries (Story 9.1
    // link). When multiple users share the email (legacy data), we
    // pick the first match — the financial event still posts; the
    // audit trail captures the choice.
    let receivedByUserId: UserId | null = null;
    if (customerEmail.length > 0) {
      const users = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", customerEmail))
        .collect();
      if (users.length > 0) {
        receivedByUserId = users[0]!._id;
      }
    }
    if (receivedByUserId === null) {
      // No silent fallback — see header comment. Refuse to post the
      // financial event rather than mis-attribute it.
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot resolve a portal user for the customer linked to this payment intent.",
        {
          customerId: row.customerId as unknown as string,
          intentId: args.event.paymentIntentId,
        },
      );
    }

    // Epic 9 H2 — overpayment guard (TOCTOU defense). The amount was
    // validated against the outstanding balance at INTENT CREATION, but
    // nothing stops two intents (or a stale one) from each being created
    // for up to the full balance and then both completing. Over-applying
    // a contract corrupts the ledger and there is no refund flow to undo
    // it. So we recompute the CURRENT outstanding here (the in-flight
    // payment isn't written yet, so `sumPaidCents` reflects prior
    // payments only) and split the allocation: the contract receives at
    // most its outstanding balance; any excess is booked as a customer
    // `credit` (refundable later) rather than over-applied. This keeps
    // the webhook idempotent + terminal (no 500-retry loop that would
    // strand the customer's money) while never over-crediting a contract.
    const contractDoc = await ctx.db.get(row.contractId as ContractId);
    const priorPaidCents =
      contractDoc !== null ? await sumPaidCents(ctx, contractDoc._id) : 0;
    const outstandingCents =
      contractDoc !== null
        ? Math.max(0, contractDoc.totalPriceCents - priorPaidCents)
        : 0;
    const toContractCents = Math.min(args.event.amountCents, outstandingCents);
    const toCreditCents = args.event.amountCents - toContractCents;
    const webhookAllocations: Array<{
      targetType: "contract" | "credit";
      targetId: string;
      amountCents: number;
    }> = [];
    if (toContractCents > 0) {
      webhookAllocations.push({
        targetType: "contract",
        targetId: row.contractId as unknown as string,
        amountCents: toContractCents,
      });
    }
    if (toCreditCents > 0) {
      // Excess over the contract balance → customer credit balance.
      webhookAllocations.push({
        targetType: "credit",
        targetId: row.customerId as unknown as string,
        amountCents: toCreditCents,
      });
    }

    const result = await postFinancialEvent(ctx, {
      kind: "payment",
      idempotencyKey: `webhook:${args.gateway}:${args.event.paymentIntentId}`,
      payment: {
        amountCents: args.event.amountCents,
        paymentMethod: args.gateway,
        reference: args.event.gatewayTransactionId,
        receivedAt: Date.now(),
        receivedByUserId,
        contractId: row.contractId as unknown as string,
        customerId: row.customerId as unknown as string,
      },
      allocations: webhookAllocations,
    });

    if (result.paymentId === null) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "postFinancialEvent returned null paymentId for a webhook payment.",
      );
    }

    // paymentIntents lifecycle is not state-machine-managed; no transitions table to assert against
    await ctx.db.patch(row._id, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "succeeded",
      completedAt: Date.now(),
      gatewayTransactionId: args.event.gatewayTransactionId,
      paymentId: result.paymentId,
    });

    // Email + PDF rendering happen in a deferred action so the
    // webhook ACK stays inside the NFR-I2 5-second budget. The
    // action's job in Phase 1 is the Story 3.13 PDF render kick;
    // a richer "send the receipt by email" step lands when
    // `convex/actions/lib/sendEmail.ts` graduates beyond the stub.
    await ctx.scheduler.runAfter(0, gatewayWebhookReceiptPdfActionRef, {
      receiptId: result.receiptId,
    });
  },
});

/**
 * Internal mutation — `convex/actions/gatewayCreateIntent.ts`
 * patches the `paymentIntents` row with the gateway-returned
 * `redirectUrl` + `gatewayIntentId`. The action cannot patch the row
 * itself (actions have no `ctx.db`); it invokes this mutation via
 * `ctx.runMutation`.
 *
 * Allowed-list patch: `redirectUrl` + `gatewayIntentId`. Never
 * `status`, `amountCents`, `customerId`, or any other field — the
 * intent-creation action's job is narrowly to record the gateway
 * pointer that lets the return page complete the redirect.
 */
export const patchPaymentIntentRedirect = internalMutationGeneric({
  args: {
    paymentIntentId: v.string(),
    redirectUrl: v.string(),
    gatewayIntentId: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      paymentIntentId: string;
      redirectUrl: string;
      gatewayIntentId: string;
    },
  ): Promise<void> => {
    const row = await ctx.db
      .query("paymentIntents")
      .withIndex("by_intentId", (q) => q.eq("intentId", args.paymentIntentId))
      .unique();
    if (row === null) return;
    if (row.completedAt !== undefined) return;
    await ctx.db.patch(row._id, {
      redirectUrl: args.redirectUrl,
      gatewayIntentId: args.gatewayIntentId,
    });
  },
});

/**
 * Internal mutation — fallback for the action when the gateway's
 * `createIntent` call fails. The action invokes this to mark the
 * `paymentIntents` row as `failed` so the return page renders the
 * retry affordance instead of a perpetual spinner.
 */
export const markPaymentIntentFailed = internalMutationGeneric({
  args: {
    paymentIntentId: v.string(),
    failureReason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { paymentIntentId: string; failureReason: string },
  ): Promise<void> => {
    const row = await ctx.db
      .query("paymentIntents")
      .withIndex("by_intentId", (q) => q.eq("intentId", args.paymentIntentId))
      .unique();
    if (row === null) return;
    if (row.completedAt !== undefined) return;
    await ctx.db.patch(row._id, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "failed",
      completedAt: Date.now(),
      failureReason: args.failureReason,
    });
  },
});

/**
 * Mock-gateway "Cancel" mutation — P1-3 adversarial review.
 *
 * The mock-gateway Cancel button previously navigated straight to the
 * return URL without any state change, leaving the intent stuck in
 * `pending` and making the failure-path UI un-exercisable. This
 * mutation gives the sandbox Cancel button a real semantic action:
 * mark the intent `expired` so the customer's return page renders
 * the "this payment expired" affordance.
 *
 * Hard gates:
 *   - Customer-role only (`requireCurrentCustomer`).
 *   - Sandbox / dev only — refuses to run in production. The real
 *     gateway emits its own webhook on cancellation in production;
 *     we never want the customer's browser to be able to flip an
 *     intent's state directly.
 *   - Ownership-scoped — the intent must belong to the calling
 *     customer.
 *   - No-op on already-terminal rows (idempotency anchor =
 *     `completedAt`).
 *
 * This mutation is the cleanest way to simulate a failure-side
 * webhook for the sandbox flow without forging an HMAC signature
 * from the browser (which would require leaking the webhook secret
 * to the client — never acceptable).
 */
export const cancelSandboxPaymentIntent = mutationGeneric({
  args: {
    paymentIntentId: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { paymentIntentId: string },
  ): Promise<void> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Sandbox-only mutation: the env-gate must run before the customer resolve so this surface refuses to operate in production even with a valid customer session. `requireCurrentCustomer` (wrapping `requireRole(ctx, ["customer"])`) runs immediately below.
    if (process.env.NODE_ENV === "production") {
      throwError(
        ErrorCode.FORBIDDEN,
        "Sandbox cancel is not available in production.",
      );
    }
    const customer = await requireCurrentCustomer(ctx);
    const row = await ctx.db
      .query("paymentIntents")
      .withIndex("by_intentId", (q) => q.eq("intentId", args.paymentIntentId))
      .unique();
    if (row === null) {
      // 404-over-403 per Story 9.1 ADR — silently no-op rather than
      // surface NOT_FOUND that could leak intent-id existence.
      return;
    }
    if (row.customerId !== customer._id) {
      // Same posture — ownership miss is a silent no-op.
      return;
    }
    if (row.completedAt !== undefined) return;
    await ctx.db.patch(row._id, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "expired",
      completedAt: Date.now(),
      failureReason: "unknown",
    });
    await emitAudit(ctx, {
      action: "update",
      entityType: "payment",
      entityId: row._id,
      before: { status: row.status },
      after: {
        kind: "payment_intent_sandbox_cancelled",
        provider: row.provider,
      },
    });
  },
});

/**
 * Action ref for the `gatewayCreateIntent` action — invoked from
 * `createGatewayPaymentIntent` via `ctx.scheduler.runAfter(0, ...)`.
 *
 * Per the architectural pattern in this repo (no Convex codegen
 * during dev — see `convex/lib/audit.ts` comments), we resolve
 * function refs via `makeFunctionReference` rather than the
 * generated `internal.actions.gatewayCreateIntent` proxy.
 */
const gatewayCreateIntentActionRef = makeFunctionReference<
  "action",
  {
    paymentIntentId: string;
    gateway: GatewayId;
    amountCents: number;
    currency: string;
    returnUrl: string;
    contractId: string;
    customerId: string;
  },
  void
>("actions/gatewayCreateIntent:gatewayCreateIntent");

/**
 * Action ref for Story 3.13's receipt-PDF generation. Reused here as
 * the deferred email / PDF kick from the webhook success path. The
 * Story 9.3 file scope already declared `generateReceiptPdfActionRef`
 * earlier in this file; this aliased name avoids the redeclaration
 * while preserving the same target function reference.
 */
const gatewayWebhookReceiptPdfActionRef = makeFunctionReference<
  "action",
  { receiptId: ReceiptId },
  { storageId: string; generatedAt: number } | null
>("actions/generateReceiptPdf:generateReceiptPdf");
