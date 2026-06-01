/**
 * Internal queries for the monthly archival export (Story 5.7,
 * FR62 / NFR-R3 / NFR-C2).
 *
 * Hosts the period-bounded reads against `receipts`, `payments`,
 * `customers`, and `contracts` that the `monthlyArchivalExport`
 * action consumes. Server-internal only — `internalQueryGeneric` is
 * not callable from the client and bypasses `requireRole` (the
 * caller is the cron-driven action which has no user context).
 *
 * Why these are in `convex/lib/` (vs. inline in the action file):
 *   - The architecture's repo tree commits to this split
 *     (`convex/lib/archivalQueries.ts` is listed alongside
 *     `convex/lib/archivalPeriods.ts`).
 *   - Convex actions live in a Node-runtime file (`"use node";`);
 *     internal queries do NOT need the Node runtime and split out
 *     for cleaner lint coverage.
 *   - `convex/lib/**` is exempt from the `require-role-first-line`
 *     rule per `eslint.config.mjs` — internal helpers belong here.
 *
 * PII redaction posture (Story 1.6 § Redaction policy):
 *   - `govIdNumber` is redacted to the last-4 alphanumeric chars
 *     before it leaves this module. The BIR audit only needs the
 *     last-4 (per Story 1.6's pattern); the full ID has no archival
 *     purpose at the receipt-level surface.
 *   - `fullName`, `phone`, `email`, `address` are PRESERVED in the
 *     export — these are BIR-required fields for the audit surface.
 *     The archival blob's S3 bucket inherits Convex's at-rest
 *     encryption posture (ADR-0007) plus whatever encryption-at-rest
 *     the cemetery's S3 provider offers.
 *
 * Common LLM-developer mistakes this module guards against:
 *   - Leaving full `govIdNumber` in the export — the BIR audit needs
 *     LAST-4; the full number is sensitive PII and out of scope.
 *   - Looking up customers / contracts one at a time instead of
 *     batching — the `getCustomersForPeriod` / `getContractsForPeriod`
 *     queries collect unique id sets first then batch-read via
 *     `ctx.db.get` to keep round-trip count bounded.
 */

import {
  type DataModelFromSchemaDefinition,
  internalQueryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "../schema";
import type { QueryCtx } from "./auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ReceiptDoc = DataModel["receipts"]["document"];
type PaymentDoc = DataModel["payments"]["document"];
type CustomerDoc = DataModel["customers"]["document"];
type ContractDoc = DataModel["contracts"]["document"];

/**
 * Redact a customer's `govIdNumber` to the last-4 alphanumeric chars.
 * Mirrors the policy in `convex/actions/generateContractPdf.ts` and
 * `convex/customers.ts:searchByName`. Empty / short IDs render as
 * the unmasked digits (defense against losing identifying info when
 * the source is malformed); production IDs are always > 4 chars.
 *
 *   redactGovIdLast4("123456789") → "6789"
 *   redactGovIdLast4("ABC")        → "ABC"
 *   redactGovIdLast4("")           → ""
 */
export function redactGovIdLast4(govIdNumber: string): string {
  const digits = govIdNumber.replace(/[^A-Za-z0-9]/g, "");
  if (digits.length <= 4) return digits;
  return digits.slice(-4);
}

/**
 * Shape of a receipt row as it appears in the archival JSON. Distinct
 * from `ReceiptDoc` so the export contract is decoupled from any
 * future schema additions that are not BIR-archival relevant.
 */
export interface ArchivalReceiptRow {
  _id: string;
  paymentId: string;
  receiptSeries: string;
  receiptNumber: string;
  receiptSerial: number;
  contractId: string | null;
  customerId: string | null;
  amountCents: number;
  issuedAt: number;
  issuedByUserId: string;
  isVoided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  voidedByUserId: string | null;
}

export interface ArchivalPaymentRow {
  _id: string;
  paymentNumber: string;
  contractId: string | null;
  customerId: string | null;
  amountCents: number;
  paymentMethod: PaymentDoc["paymentMethod"];
  reference: string | null;
  receivedAt: number;
  receivedByUserId: string;
  isVoided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  voidedByUserId: string | null;
}

export interface ArchivalCustomerRow {
  _id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: CustomerDoc["address"];
  govIdType: CustomerDoc["govIdType"];
  govIdNumberLast4: string;
  relationshipToOccupant: string | null;
  hasConsent: boolean;
  createdAt: number;
}

export interface ArchivalContractRow {
  _id: string;
  contractNumber: string;
  lotId: string;
  customerId: string;
  kind: ContractDoc["kind"];
  totalPriceCents: number;
  state: ContractDoc["state"];
  createdAt: number;
  basePriceCents: number | null;
  discountCents: number | null;
  perpetualCareCents: number | null;
  perpetualCarePaidCents: number | null;
}

function toReceiptRow(r: ReceiptDoc): ArchivalReceiptRow {
  return {
    _id: r._id as unknown as string,
    paymentId: r.paymentId as unknown as string,
    receiptSeries: r.receiptSeries,
    receiptNumber: r.receiptNumber,
    receiptSerial: r.receiptSerial,
    contractId: (r.contractId as string | undefined) ?? null,
    customerId: (r.customerId as string | undefined) ?? null,
    amountCents: r.amountCents,
    issuedAt: r.issuedAt,
    issuedByUserId: r.issuedByUserId as unknown as string,
    isVoided: r.isVoided,
    voidedAt: r.voidedAt ?? null,
    voidReason: r.voidReason ?? null,
    voidedByUserId:
      (r.voidedByUserId as unknown as string | undefined) ?? null,
  };
}

function toPaymentRow(p: PaymentDoc): ArchivalPaymentRow {
  return {
    _id: p._id as unknown as string,
    paymentNumber: p.paymentNumber,
    contractId: p.contractId ?? null,
    customerId: p.customerId ?? null,
    amountCents: p.amountCents,
    paymentMethod: p.paymentMethod,
    reference: p.reference ?? null,
    receivedAt: p.receivedAt,
    receivedByUserId: p.receivedByUserId as unknown as string,
    isVoided: p.isVoided,
    voidedAt: p.voidedAt ?? null,
    voidReason: p.voidReason ?? null,
    voidedByUserId:
      (p.voidedByUserId as unknown as string | undefined) ?? null,
  };
}

function toCustomerRow(c: CustomerDoc): ArchivalCustomerRow {
  return {
    _id: c._id as unknown as string,
    fullName: c.fullName,
    phone: c.phone ?? null,
    email: c.email ?? null,
    address: c.address,
    govIdType: c.govIdType,
    govIdNumberLast4: redactGovIdLast4(c.govIdNumber),
    relationshipToOccupant: c.relationshipToOccupant ?? null,
    hasConsent: c.hasConsent,
    createdAt: c.createdAt,
  };
}

function toContractRow(c: ContractDoc): ArchivalContractRow {
  return {
    _id: c._id as unknown as string,
    contractNumber: c.contractNumber,
    lotId: c.lotId as unknown as string,
    customerId: c.customerId as unknown as string,
    kind: c.kind,
    totalPriceCents: c.totalPriceCents,
    state: c.state,
    createdAt: c.createdAt,
    basePriceCents: c.basePriceCents ?? null,
    discountCents: c.discountCents ?? null,
    perpetualCareCents: c.perpetualCareCents ?? null,
    perpetualCarePaidCents: c.perpetualCarePaidCents ?? null,
  };
}

/**
 * Internal query — every receipt whose `issuedAt` falls in
 * `[startMs, endMs)`. Half-open interval — `issuedAt === endMs` is
 * the FIRST millisecond of the next period and excluded.
 *
 * Uses the `by_issuedAt` index for a bounded range scan.
 */
export const getReceiptsInPeriod = internalQueryGeneric({
  args: { startMs: v.number(), endMs: v.number() },
  handler: async (
    ctx: QueryCtx,
    args: { startMs: number; endMs: number },
  ): Promise<ArchivalReceiptRow[]> => {
    const rows = await ctx.db
      .query("receipts")
      .withIndex("by_issuedAt", (q) =>
        q.gte("issuedAt", args.startMs).lt("issuedAt", args.endMs),
      )
      .collect();
    return rows.map(toReceiptRow);
  },
});

/**
 * Internal query — every payment whose `receivedAt` falls in
 * `[startMs, endMs)`.
 *
 * Half-open interval, same boundary convention as receipts. Uses the
 * `by_receivedAt` index.
 */
export const getPaymentsInPeriod = internalQueryGeneric({
  args: { startMs: v.number(), endMs: v.number() },
  handler: async (
    ctx: QueryCtx,
    args: { startMs: number; endMs: number },
  ): Promise<ArchivalPaymentRow[]> => {
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_receivedAt", (q) =>
        q.gte("receivedAt", args.startMs).lt("receivedAt", args.endMs),
      )
      .collect();
    return rows.map(toPaymentRow);
  },
});

/**
 * Internal query — every customer referenced by a receipt or payment
 * in the period. Walks both arrays for unique customer ids then
 * batch-reads the customer rows via `ctx.db.get`. Customers whose
 * row was deleted between the period and the export are skipped
 * (defensive — Phase 1 does not delete customers, but the read path
 * tolerates missing rows).
 *
 * Returns customer rows with `govIdNumber` REDACTED to last-4.
 */
export const getCustomersForPeriod = internalQueryGeneric({
  args: {
    customerIds: v.array(v.string()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { customerIds: string[] },
  ): Promise<ArchivalCustomerRow[]> => {
    // De-dupe in case the caller passes the same id twice.
    const unique = Array.from(new Set(args.customerIds));
    const out: ArchivalCustomerRow[] = [];
    for (const id of unique) {
      const c = (await ctx.db.get(
        id as unknown as CustomerDoc["_id"],
      )) as CustomerDoc | null;
      if (c === null) continue;
      out.push(toCustomerRow(c));
    }
    return out;
  },
});

/**
 * Internal query — every contract referenced by a payment in the
 * period. Walks the payment array for unique contract ids then
 * batch-reads the contract rows via `ctx.db.get`. Missing rows are
 * skipped (defensive).
 */
export const getContractsForPeriod = internalQueryGeneric({
  args: {
    contractIds: v.array(v.string()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { contractIds: string[] },
  ): Promise<ArchivalContractRow[]> => {
    const unique = Array.from(new Set(args.contractIds));
    const out: ArchivalContractRow[] = [];
    for (const id of unique) {
      const c = (await ctx.db.get(
        id as unknown as ContractDoc["_id"],
      )) as ContractDoc | null;
      if (c === null) continue;
      out.push(toContractRow(c));
    }
    return out;
  },
});

/**
 * Internal query — look up an existing `archivalExports` row for a
 * period, if any. Used by the action's idempotency guard.
 *
 * Returns `recordCounts` alongside the bookkeeping fields so the
 * action's short-circuit branch can echo the ORIGINAL counts back to
 * the admin UI (Story 5.7 P1 fix — previously the action returned
 * `{0,0,0,0}` on the skip path which surfaced as a misleading
 * "0 records archived" toast on the "Re-run" button).
 */
export const findExistingArchivalExport = internalQueryGeneric({
  args: { period: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: { period: string },
  ): Promise<{
    _id: DataModel["archivalExports"]["document"]["_id"];
    period: string;
    storageId: DataModel["archivalExports"]["document"]["storageId"];
    s3Status:
      | DataModel["archivalExports"]["document"]["s3Status"]
      | undefined;
    recordCounts: DataModel["archivalExports"]["document"]["recordCounts"];
  } | null> => {
    const row = await ctx.db
      .query("archivalExports")
      .withIndex("by_period", (q) => q.eq("period", args.period))
      .unique();
    if (row === null) return null;
    return {
      _id: row._id,
      period: row.period,
      storageId: row.storageId,
      s3Status: row.s3Status,
      recordCounts: row.recordCounts,
    };
  },
});

/**
 * Test surface — re-exports the pure helpers for unit tests without
 * round-tripping through the action plumbing.
 */
export const __testing = {
  redactGovIdLast4,
  toReceiptRow,
  toPaymentRow,
  toCustomerRow,
  toContractRow,
};
