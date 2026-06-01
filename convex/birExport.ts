/**
 * Monthly archival export for BIR 10-year retention (Story 5.7 — FR62,
 * NFR-R3 / NFR-C2).
 *
 * Convex-runtime action that produces a CSV archive of every receipt
 * issued in a calendar month, stores the blob in Convex File Storage,
 * and inserts a `birExports` row indexing the archive for the admin UI.
 * The cron registered in `convex/crons.ts` invokes
 * `generateMonthlyBirExport` once per month — see that file for the
 * timezone discipline (1 AM Manila ≈ 17:00 UTC, with the action always
 * deriving "prior month" rather than trusting the cron's wall-clock).
 *
 * Why a single file (vs. the longer-form story spec's `convex/actions/
 * archivalExport.ts` + `convex/lib/archivalPeriods.ts` + `convex/lib/
 * archivalQueries.ts` split): the user's narrowed Phase-1 brief scoped
 * the implementation to `convex/birExport.ts` only. The internal
 * helpers (period bounds, period query, file-storage writeback) live
 * inline as private TS functions / internal Convex functions in this
 * same file — they don't need a separate `lib/` boundary at Phase 1
 * volume, and consolidating keeps the file-ownership story sharp.
 *
 * Why CSV (not JSON or compressed gzip per the longer story spec):
 *   - BIR examiners are spreadsheet-literate; CSV opens in Excel /
 *     Numbers without any tooling. JSON opens-readable, but the
 *     auditor's workflow is "scan rows, sum amount column" — CSV is
 *     the lowest-friction format for that.
 *   - Phase-1 receipt volume is ~2,000 receipts per month at peak;
 *     the uncompressed CSV is well under 1MB. Gzip is unnecessary.
 *   - The columns are the BIR-required fields per the user's brief:
 *     receipt_number, series, issued_at, customer_name (REDACTED to
 *     first + last initial), tin, amount_cents, vat_cents,
 *     payment_method, voided.
 *
 * PII handling:
 *   - Customer name is redacted at export time to first name + last
 *     initial (e.g. "Juan D."). This satisfies the BIR audit need
 *     (identify the payer) without bundling unredacted PII into a
 *     long-lived archive blob.
 *   - The TIN field is the cemetery's BIR-registered TIN (one value
 *     per row, from the `birFormat` placeholder config), not the
 *     customer's TIN. This is what BIR cares about on the issuer
 *     side; customer TINs are not in scope for archival.
 *   - `govIdNumber` is NEVER included in the export — even redacted,
 *     it has no BIR-audit purpose at the receipt-level surface.
 *
 * Idempotency:
 *   - `generateMonthlyBirExport({ year, month })` checks the
 *     `birExports.by_period` index. If a `ready` row already exists,
 *     the action no-ops and returns the existing storageId — same
 *     period, same data, same archive. The cron's "prior month" path
 *     therefore can't double-write.
 *   - If a `failed` row exists, the action re-runs (the prior failure
 *     is overwritten with the fresh attempt).
 *
 * Auth:
 *   - `generateMonthlyBirExport` is an `action` (not internal) gated
 *     with `requireRole(["admin"])` at the entry point so the
 *     `/admin/bir-exports` "Re-run for period" affordance can call it
 *     directly. The cron path also calls it; the cron has no caller
 *     identity, so we additionally accept an internal-only escape via
 *     the cron registration in `convex/crons.ts` (the cron's scheduled
 *     invocation provides no `getAuthUserId`, which `requireRole`
 *     would reject — we therefore expose a paired `internalAction`
 *     wrapper that skips the auth gate for the cron path only).
 *
 * Failure model: any throw inside the action propagates to Convex's
 * action-error log AND updates the `birExports` row's `status` field
 * to `"failed"` with `errorMessage` so the admin sees the failure in
 * the listing page and can retry from the UI.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  actionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  makeFunctionReference,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { PLACEHOLDER_BIR_CONFIG, splitForVat } from "./lib/birFormat";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type PaymentDoc = DataModel["payments"]["document"];
type CustomerDoc = DataModel["customers"]["document"];
type BirExportId = DataModel["birExports"]["document"]["_id"];
type StorageId = DataModel["receipts"]["document"]["pdfStorageId"];

/**
 * Function path string the cron registration references. Mirrors the
 * pattern used by `convex/actions/generateContractPdf.ts` — the repo
 * deliberately does not check in `convex/_generated/api`, so cron
 * registration goes through dynamic resolution + a path string.
 */
export const GENERATE_MONTHLY_BIR_EXPORT_INTERNAL_PATH =
  "birExport:internal_generateMonthlyBirExport";

/**
 * Row shape returned by `listBirExports`. Narrow on purpose — the
 * admin list view only needs enough to render the table.
 */
export interface BirExportRow {
  _id: BirExportId;
  _creationTime: number;
  year: number;
  month: number;
  generatedAt: number;
  status: "pending" | "ready" | "failed";
  receiptCount: number | null;
  paymentCount: number | null;
  sizeBytes: number | null;
  errorMessage: string | null;
  hasStorage: boolean;
}

/**
 * Manila-tz month boundary helper. Given a (year, month) pair where
 * `month` is 1..12, return the unix-ms `[startMs, endMs)` range that
 * covers the calendar month in Asia/Manila time.
 *
 * Manila is UTC+8 year-round with no DST. The start of the month in
 * Manila therefore equals `Date.UTC(year, month-1, 1, 0, 0) - 8h`.
 *
 *   getManilaMonthBounds(2026, 5)
 *   → startMs: 2026-04-30 16:00 UTC == 2026-05-01 00:00 Manila
 *     endMs:   2026-05-31 16:00 UTC == 2026-06-01 00:00 Manila
 *
 * Exported for unit testing.
 */
export function getManilaMonthBounds(
  year: number,
  month: number,
): { startMs: number; endMs: number } {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  // `month - 1` because Date.UTC is 0-indexed by month. Computing in
  // UTC then subtracting the offset gives the unix ms at the start of
  // that day in Manila.
  const startMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - MANILA_OFFSET_MS;
  // End is start of the NEXT Manila month — Date constructor handles
  // year/month rollover (month 12 + 1 → next year, month 1).
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endMs =
    Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0, 0) - MANILA_OFFSET_MS;
  return { startMs, endMs };
}

/**
 * Compute the prior calendar month relative to a given "now" instant,
 * with the month boundary resolved in Manila tz. Used by the cron
 * path to derive "last month's archive" without trusting the cron's
 * UTC firing wall-clock.
 *
 *   getPriorMonthInManila(new Date("2026-06-15T08:00+08:00").getTime())
 *   → { year: 2026, month: 5 }
 *   getPriorMonthInManila(new Date("2026-01-05T08:00+08:00").getTime())
 *   → { year: 2025, month: 12 }
 *
 * Exported for unit testing.
 */
export function getPriorMonthInManila(
  nowMs: number,
): { year: number; month: number } {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  // Shift `now` by the Manila offset, then read year + month from the
  // resulting UTC fields. This gives Manila's wall-clock components.
  const manilaWall = new Date(nowMs + MANILA_OFFSET_MS);
  const manilaYear = manilaWall.getUTCFullYear();
  const manilaMonth = manilaWall.getUTCMonth() + 1; // 1..12
  // Roll back by one calendar month.
  if (manilaMonth === 1) {
    return { year: manilaYear - 1, month: 12 };
  }
  return { year: manilaYear, month: manilaMonth - 1 };
}

/**
 * Redact a customer's full name to "First L." form. The first
 * whitespace-separated token stays verbatim; the last token (if
 * distinct) is truncated to its first initial + period. Tokens in
 * between are dropped — the BIR audit only needs enough to identify
 * the payer, not a full PII transcript.
 *
 *   redactCustomerName("Juan Dela Cruz")  → "Juan C."
 *   redactCustomerName("Maria Santos")     → "Maria S."
 *   redactCustomerName("Pedro")             → "Pedro"
 *   redactCustomerName("")                  → ""
 *
 * Exported for unit testing.
 */
export function redactCustomerName(fullName: string): string {
  const trimmed = fullName.trim();
  if (trimmed.length === 0) return "";
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0]!;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const lastInitial = last.charAt(0).toUpperCase();
  return `${first} ${lastInitial}.`;
}

/**
 * Escape a single CSV cell value per RFC-4180 conventions. Wraps the
 * value in double quotes when it contains a comma / quote / newline,
 * doubling any embedded quotes. Always returns a string suitable for
 * direct concatenation into a CSV row.
 *
 * Exported for unit testing.
 */
export function csvEscape(value: string | number | boolean | null): string {
  if (value === null) return "";
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build the CSV body from a set of receipts + payments + customers.
 * Pure function — no DB / storage / time side effects. Exported so
 * the unit tests can assert column ordering + redaction without
 * standing up the action plumbing.
 *
 * Column order (fixed — auditors expect a stable header):
 *   receipt_number, series, issued_at, customer_name, tin,
 *   amount_cents, vat_cents, payment_method, voided
 *
 *   - `issued_at` is the receipt's `issuedAt` field formatted as
 *     ISO-8601 with Manila offset (e.g. `2026-05-15T14:30:00+08:00`).
 *   - `customer_name` is redacted per `redactCustomerName`.
 *   - `tin` is the cemetery's BIR-registered TIN — one constant value
 *     per row, sourced from the BIR config (placeholder until §10 Q3).
 *   - `vat_cents` is derived via `splitForVat` when the cemetery is
 *     VAT-registered; `0` otherwise. The placeholder config flags
 *     `isVatRegistered: false`, so Phase-1 rows ship with `vat_cents: 0`.
 *   - `voided` is the boolean serialised as `true` / `false`.
 */
export function buildBirExportCsv(args: {
  receipts: Array<{
    receiptNumber: string;
    receiptSeries: string;
    issuedAt: number;
    customerFullName: string | null;
    amountCents: number;
    paymentMethod: PaymentDoc["paymentMethod"] | null;
    isVoided: boolean;
  }>;
  tin: string;
  isVatRegistered: boolean;
}): string {
  const headers = [
    "receipt_number",
    "series",
    "issued_at",
    "customer_name",
    "tin",
    "amount_cents",
    "vat_cents",
    "payment_method",
    "voided",
  ];
  const lines: string[] = [headers.join(",")];
  for (const r of args.receipts) {
    const redactedName = redactCustomerName(r.customerFullName ?? "");
    const issuedAtIso = formatIssuedAtManila(r.issuedAt);
    const vatCents = args.isVatRegistered
      ? splitForVat(r.amountCents).vatCents
      : 0;
    const cells = [
      csvEscape(r.receiptNumber),
      csvEscape(r.receiptSeries),
      csvEscape(issuedAtIso),
      csvEscape(redactedName),
      csvEscape(args.tin),
      csvEscape(r.amountCents),
      csvEscape(vatCents),
      csvEscape(r.paymentMethod ?? ""),
      csvEscape(r.isVoided),
    ];
    lines.push(cells.join(","));
  }
  // Trailing newline matches the convention spreadsheets expect.
  return `${lines.join("\n")}\n`;
}

/**
 * Format a unix-ms timestamp as ISO-8601 with the Manila offset.
 * Manila is UTC+8 with no DST so the offset is stable.
 *
 *   formatIssuedAtManila(new Date("2026-05-15T14:30:00+08:00").getTime())
 *   → "2026-05-15T14:30:00+08:00"
 */
function formatIssuedAtManila(ms: number): string {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const manila = new Date(ms + MANILA_OFFSET_MS);
  const yyyy = manila.getUTCFullYear().toString().padStart(4, "0");
  const mm = (manila.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = manila.getUTCDate().toString().padStart(2, "0");
  const hh = manila.getUTCHours().toString().padStart(2, "0");
  const mi = manila.getUTCMinutes().toString().padStart(2, "0");
  const ss = manila.getUTCSeconds().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}

/**
 * Internal query — load every receipt + the customer-name lookup for
 * the period. Returns a denormalised row set the action then renders
 * into CSV.
 *
 * Reads happen here (not in the action) because Convex queries are
 * the transactional read primitive — actions can't directly query
 * the DB. The internal query is invoked via `ctx.runQuery` from the
 * action.
 *
 * Auth: internal — no `requireRole` (the caller is the action, which
 * has already authenticated via the public entry point or is the
 * cron's internal trigger).
 */
export const _getReceiptsForPeriod = internalQueryGeneric({
  args: { startMs: v.number(), endMs: v.number() },
  handler: async (
    ctx: QueryCtx,
    args: { startMs: number; endMs: number },
  ): Promise<{
    receipts: Array<{
      receiptNumber: string;
      receiptSeries: string;
      issuedAt: number;
      customerFullName: string | null;
      amountCents: number;
      paymentMethod: PaymentDoc["paymentMethod"] | null;
      isVoided: boolean;
    }>;
    paymentCount: number;
  }> => {
    // Pull every receipt whose issuedAt falls in `[startMs, endMs)`.
    // The `by_issuedAt` index supports the range scan directly.
    const receiptRows = await ctx.db
      .query("receipts")
      .withIndex("by_issuedAt", (q) =>
        q.gte("issuedAt", args.startMs).lt("issuedAt", args.endMs),
      )
      .collect();

    // Hydrate customer names + payment method per row. We resolve
    // these lazily so the export is single-pass and avoids loading
    // the full customers table.
    const customerCache = new Map<string, CustomerDoc | null>();
    const paymentCache = new Map<string, PaymentDoc | null>();

    const out: Array<{
      receiptNumber: string;
      receiptSeries: string;
      issuedAt: number;
      customerFullName: string | null;
      amountCents: number;
      paymentMethod: PaymentDoc["paymentMethod"] | null;
      isVoided: boolean;
    }> = [];

    for (const r of receiptRows) {
      let customerFullName: string | null = null;
      if (r.customerId !== undefined) {
        const cid = r.customerId as string;
        if (!customerCache.has(cid)) {
          const c = await ctx.db.get(
            cid as DataModel["customers"]["document"]["_id"],
          );
          customerCache.set(cid, c);
        }
        const c = customerCache.get(cid) ?? null;
        customerFullName = c?.fullName ?? null;
      }

      let paymentMethod: PaymentDoc["paymentMethod"] | null = null;
      const pid = r.paymentId as unknown as string;
      if (!paymentCache.has(pid)) {
        const p = await ctx.db.get(r.paymentId);
        paymentCache.set(pid, p);
      }
      const p = paymentCache.get(pid) ?? null;
      paymentMethod = p?.paymentMethod ?? null;

      out.push({
        receiptNumber: r.receiptNumber,
        receiptSeries: r.receiptSeries,
        issuedAt: r.issuedAt,
        customerFullName,
        amountCents: r.amountCents,
        paymentMethod,
        isVoided: r.isVoided,
      });
    }

    // Also count payments in the period — separate from receipts
    // (every receipt has a payment, but the count is surfaced
    // independently so the audit row can show both).
    const paymentRows = await ctx.db
      .query("payments")
      .withIndex("by_receivedAt", (q) =>
        q.gte("receivedAt", args.startMs).lt("receivedAt", args.endMs),
      )
      .collect();

    return { receipts: out, paymentCount: paymentRows.length };
  },
});

/**
 * Internal query — look up the existing `birExports` row for a
 * (year, month) period, if any. Used by the action for the
 * idempotent-rerun check.
 */
export const _findExistingExport = internalQueryGeneric({
  args: { year: v.number(), month: v.number() },
  handler: async (
    ctx: QueryCtx,
    args: { year: number; month: number },
  ): Promise<{
    _id: BirExportId;
    status: "pending" | "ready" | "failed";
    storageId: StorageId | undefined;
  } | null> => {
    const row = await ctx.db
      .query("birExports")
      .withIndex("by_period", (q) =>
        q.eq("year", args.year).eq("month", args.month),
      )
      .unique();
    if (row === null) return null;
    return {
      _id: row._id,
      status: row.status,
      storageId: row.storageId,
    };
  },
});

/**
 * Internal mutation — upsert the `birExports` row. Insert when the
 * (year, month) is new; patch when re-running. Always sets
 * `generatedAt` to the current invocation's clock.
 */
export const _upsertExportRow = internalMutationGeneric({
  args: {
    year: v.number(),
    month: v.number(),
    storageId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    receiptCount: v.optional(v.number()),
    paymentCount: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      year: number;
      month: number;
      storageId?: DataModel["birExports"]["document"]["storageId"];
      status: "pending" | "ready" | "failed";
      receiptCount?: number;
      paymentCount?: number;
      sizeBytes?: number;
      errorMessage?: string;
    },
  ): Promise<BirExportId> => {
    const existing = await ctx.db
      .query("birExports")
      .withIndex("by_period", (q) =>
        q.eq("year", args.year).eq("month", args.month),
      )
      .unique();
    const generatedAt = Date.now();
    if (existing !== null) {
      const patch: Record<string, unknown> = {
        generatedAt,
        status: args.status,
      };
      if (args.storageId !== undefined) patch.storageId = args.storageId;
      if (args.receiptCount !== undefined)
        patch.receiptCount = args.receiptCount;
      if (args.paymentCount !== undefined)
        patch.paymentCount = args.paymentCount;
      if (args.sizeBytes !== undefined) patch.sizeBytes = args.sizeBytes;
      if (args.errorMessage !== undefined)
        patch.errorMessage = args.errorMessage;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    const insert: Record<string, unknown> = {
      year: args.year,
      month: args.month,
      generatedAt,
      status: args.status,
    };
    if (args.storageId !== undefined) insert.storageId = args.storageId;
    if (args.receiptCount !== undefined)
      insert.receiptCount = args.receiptCount;
    if (args.paymentCount !== undefined)
      insert.paymentCount = args.paymentCount;
    if (args.sizeBytes !== undefined) insert.sizeBytes = args.sizeBytes;
    if (args.errorMessage !== undefined) insert.errorMessage = args.errorMessage;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await ctx.db.insert("birExports", insert as any);
    return id;
  },
});

/**
 * Shared body for the action — invoked by both the public entry
 * point (admin-gated) and the internal entry point (cron-gated).
 * Encapsulates the storage write + idempotency check + CSV build.
 */
async function runMonthlyExport(
  ctx: ActionCtx,
  year: number,
  month: number,
): Promise<{
  storageId: string;
  receiptCount: number;
  paymentCount: number;
  sizeBytes: number;
  status: "ready" | "skipped";
}> {
  // Step 1: idempotency check. If an existing `ready` row exists for
  // the period, return without rewriting. A `failed` or `pending`
  // row triggers a fresh run that overwrites.
  const findRef = makeFunctionReference<
    "query",
    { year: number; month: number },
    {
      _id: BirExportId;
      status: "pending" | "ready" | "failed";
      storageId: StorageId | undefined;
    } | null
  >("birExport:_findExistingExport");
  const existing = await ctx.runQuery(findRef, { year, month });
  if (
    existing !== null &&
    existing.status === "ready" &&
    existing.storageId !== undefined
  ) {
    return {
      storageId: existing.storageId as unknown as string,
      receiptCount: 0,
      paymentCount: 0,
      sizeBytes: 0,
      status: "skipped",
    };
  }

  // Step 2: compute Manila-tz month bounds + load the receipts +
  // payment count via the internal query.
  const { startMs, endMs } = getManilaMonthBounds(year, month);
  const queryRef = makeFunctionReference<
    "query",
    { startMs: number; endMs: number },
    {
      receipts: Array<{
        receiptNumber: string;
        receiptSeries: string;
        issuedAt: number;
        customerFullName: string | null;
        amountCents: number;
        paymentMethod: PaymentDoc["paymentMethod"] | null;
        isVoided: boolean;
      }>;
      paymentCount: number;
    }
  >("birExport:_getReceiptsForPeriod");
  const { receipts, paymentCount } = await ctx.runQuery(queryRef, {
    startMs,
    endMs,
  });

  // Step 3: render the CSV.
  const csv = buildBirExportCsv({
    receipts,
    tin: PLACEHOLDER_BIR_CONFIG.tin,
    isVatRegistered: PLACEHOLDER_BIR_CONFIG.isVatRegistered,
  });
  const csvBytes = new TextEncoder().encode(csv);

  // Step 4: store the CSV blob in Convex File Storage.
  const blob = new Blob([csvBytes], { type: "text/csv" });
  const storageId = await ctx.storage.store(blob);

  // Step 5: insert / patch the `birExports` row with the ready
  // metadata.
  const upsertRef = makeFunctionReference<
    "mutation",
    {
      year: number;
      month: number;
      storageId?: DataModel["birExports"]["document"]["storageId"];
      status: "pending" | "ready" | "failed";
      receiptCount?: number;
      paymentCount?: number;
      sizeBytes?: number;
      errorMessage?: string;
    },
    BirExportId
  >("birExport:_upsertExportRow");
  await ctx.runMutation(upsertRef, {
    year,
    month,
    storageId: storageId as DataModel["birExports"]["document"]["storageId"],
    status: "ready",
    receiptCount: receipts.length,
    paymentCount,
    sizeBytes: csvBytes.byteLength,
  });

  return {
    storageId: storageId as unknown as string,
    receiptCount: receipts.length,
    paymentCount,
    sizeBytes: csvBytes.byteLength,
    status: "ready",
  };
}

/**
 * Public action — Admin-only entry point for the "Re-run for period"
 * button on `/admin/bir-exports`. Also invocable via the CLI for
 * backfills.
 *
 * Auth: `requireRole(["admin"])` on the action context. Convex
 * actions can call `requireRole` because the helper only depends on
 * `getAuthUserId` / `ctx.runQuery` shapes that are present on action
 * contexts too — see the same pattern in
 * `convex/actions/generateContractPdf.ts` (where the public mutation
 * gates first then the action runs without an inner re-gate; here we
 * gate inline because the action IS the public entry).
 *
 * Idempotent: a re-call for the same (year, month) with an existing
 * `ready` row returns the cached storageId without rewriting.
 *
 * Failure path: any thrown error is patched onto the `birExports`
 * row's `status: "failed"` + `errorMessage` so the admin UI surfaces
 * the failure for manual retry.
 */
export const generateMonthlyBirExport = actionGeneric({
  args: { year: v.number(), month: v.number() },
  handler: async (
    ctx: ActionCtx,
    args: { year: number; month: number },
  ): Promise<{
    storageId: string;
    receiptCount: number;
    paymentCount: number;
    sizeBytes: number;
    status: "ready" | "skipped";
  }> => {
    // Auth gate — admin only. Actions have a Convex ctx with the
    // auth surface; `requireRole` reads `getAuthUserId` from the
    // session. Field workers / office staff hit FORBIDDEN here even
    // though this surface is otherwise mutation-equivalent.
    await requireRole(
      ctx as unknown as QueryCtx,
      ["admin"],
    );

    // Defensive validation of the period arguments. Production
    // callers from the UI pass parsed integers, but a malformed
    // `npx convex run` invocation could ship floats / out-of-range
    // values.
    if (
      !Number.isInteger(args.year) ||
      args.year < 1970 ||
      args.year > 9999
    ) {
      throwError(ErrorCode.VALIDATION, "Year is out of range.", {
        year: args.year,
      });
    }
    if (
      !Number.isInteger(args.month) ||
      args.month < 1 ||
      args.month > 12
    ) {
      throwError(ErrorCode.VALIDATION, "Month must be 1..12.", {
        month: args.month,
      });
    }

    try {
      return await runMonthlyExport(ctx, args.year, args.month);
    } catch (err) {
      // Persist the failure on the `birExports` row so the admin UI
      // surfaces it. Re-throw so Convex's action-error log captures
      // the trace.
      const message = err instanceof Error ? err.message : String(err);
      const upsertRef = makeFunctionReference<
        "mutation",
        {
          year: number;
          month: number;
          status: "pending" | "ready" | "failed";
          errorMessage?: string;
        },
        BirExportId
      >("birExport:_upsertExportRow");
      try {
        await ctx.runMutation(upsertRef, {
          year: args.year,
          month: args.month,
          status: "failed",
          errorMessage: message,
        });
      } catch {
        // Even the failure-recorder failed — swallow and let the
        // outer throw propagate. The admin UI will show "no row"
        // and the admin can re-trigger.
      }
      throw err;
    }
  },
});

/**
 * Internal action — invoked by the monthly cron in
 * `convex/crons.ts`. Computes "prior month in Manila tz" from
 * `Date.now()` and delegates to `runMonthlyExport`. No auth gate
 * (the cron has no caller); the function is `internalAction` so
 * clients cannot reach it.
 */
export const internal_generateMonthlyBirExport = internalActionGeneric({
  args: {},
  handler: async (
    ctx: ActionCtx,
  ): Promise<{
    year: number;
    month: number;
    storageId: string;
    receiptCount: number;
    paymentCount: number;
    sizeBytes: number;
    status: "ready" | "skipped";
  }> => {
    const { year, month } = getPriorMonthInManila(Date.now());
    try {
      const result = await runMonthlyExport(ctx, year, month);
      return { year, month, ...result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const upsertRef = makeFunctionReference<
        "mutation",
        {
          year: number;
          month: number;
          status: "pending" | "ready" | "failed";
          errorMessage?: string;
        },
        BirExportId
      >("birExport:_upsertExportRow");
      try {
        await ctx.runMutation(upsertRef, {
          year,
          month,
          status: "failed",
          errorMessage: message,
        });
      } catch {
        // Failure-recorder failed — swallow + let the outer throw
        // propagate to Convex's action-error log.
      }
      throw err;
    }
  },
});

/**
 * Admin list query — drives the `/admin/bir-exports` page. Returns
 * every `birExports` row ordered by `generatedAt` descending so the
 * latest export is at the top of the list.
 *
 * Auth: `requireRole(["admin"])` — same posture as every other
 * `/admin/*` surface.
 */
export const listBirExports = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<BirExportRow[]> => {
    await requireRole(ctx, ["admin"]);
    const rows = await ctx.db
      .query("birExports")
      .withIndex("by_generatedAt")
      .order("desc")
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      year: r.year,
      month: r.month,
      generatedAt: r.generatedAt,
      status: r.status,
      receiptCount: r.receiptCount ?? null,
      paymentCount: r.paymentCount ?? null,
      sizeBytes: r.sizeBytes ?? null,
      errorMessage: r.errorMessage ?? null,
      hasStorage: r.storageId !== undefined,
    }));
  },
});

/**
 * Admin download-URL query — returns the short-lived signed URL for
 * a single `birExports` row's stored CSV blob. Returns `null` when
 * the row has no `storageId` (pending / failed state).
 *
 * Auth: `requireRole(["admin"])`. NFR-S3 — only short-lived signed
 * URLs are surfaced; the raw `storageId` is never returned to the
 * client.
 */
export const getBirExportDownloadUrl = queryGeneric({
  args: { exportId: v.id("birExports") },
  handler: async (
    ctx: QueryCtx,
    args: { exportId: BirExportId },
  ): Promise<{ url: string | null }> => {
    await requireRole(ctx, ["admin"]);
    const row = await ctx.db.get(args.exportId);
    if (row === null || row.storageId === undefined) {
      return { url: null };
    }
    const url = await ctx.storage.getUrl(row.storageId);
    return { url: url ?? null };
  },
});

/**
 * Test surface — exports the pure helpers for unit testing without
 * round-tripping through the action plumbing. Not a Convex function;
 * plain TS re-export pattern mirroring `actions/generateContractPdf.ts`.
 */
export const __testing = {
  getManilaMonthBounds,
  getPriorMonthInManila,
  redactCustomerName,
  csvEscape,
  buildBirExportCsv,
  formatIssuedAtManila,
  GENERATE_MONTHLY_BIR_EXPORT_INTERNAL_PATH,
};
