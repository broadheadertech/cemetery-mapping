/**
 * Installment domain (Story 3.4, FR20 / FR21).
 *
 * Public read surface for the `installments` table — the per-payment
 * schedule that belongs to a `kind: "installment"` contract. The write
 * path (insert) lives in `convex/contracts.ts:recordInstallmentSale`;
 * Epic 4 will own the daily-aging path (`recomputeInstallmentAging`
 * scheduled function flipping `pending → overdue` past the grace
 * window) and Stories 3.9 / 3.10 will own the payment-application path
 * that bumps `paidCents` and transitions `pending → paid`.
 *
 * Conventions every handler obeys (mirrored from `convex/contracts.ts`
 * and `convex/customers.ts`):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this.
 *   2. Financial-table writes (`payments`, `receipts`,
 *      `paymentAllocations`) never happen here — this file owns the
 *      `installments` table's READ surface plus the row-level write
 *      paths that downstream stories (3.9, 4.1) will layer on top.
 *      Story 3.4 ships only the read surface; the row-level write
 *      paths are reserved for future stories and the placeholders are
 *      omitted to keep the surface minimal and accurate.
 *   3. The Story 3.4 system message names `recomputeInstallmentAging`
 *      as "optionally" addressed here and flags Epic 4 as the canonical
 *      owner of that scheduler. We leave the function name claimed in
 *      the docstring above but do NOT implement it in this story — the
 *      aging policy (grace days, penalty rate) lives behind §10 Q1 and
 *      shipping a stub would invite drift.
 */

import {
  type DataModelFromSchemaDefinition,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type InstallmentDoc = DataModel["installments"]["document"];
type InstallmentId = InstallmentDoc["_id"];

/**
 * Public arg shape for `listContractInstallments`.
 */
export interface ListContractInstallmentsArgs {
  contractId: ContractId;
}

/**
 * Shape of each row returned by `listContractInstallments`. Mirrors
 * the table layout 1:1 — the UI's schedule preview / contract detail
 * page consumes this directly without further hydration. Money fields
 * are integer centavos (caller is expected to format via
 * `formatPeso(cents)` at render).
 */
export interface InstallmentRow {
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
 * Loads every installment row for a contract, sorted by
 * `installmentNumber` ascending so the calling UI renders them in
 * schedule order.
 *
 * Auth: admin or office_staff (Phase 1). The customer-portal read path
 * (Epic 9) will wrap this query with a customer-id check; that's a
 * separate function on a separate auth gate, not a special case here.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — auth gate.
 *   - `NOT_FOUND` — contract id does not resolve.
 *   - `INVARIANT_VIOLATION` — contract is not `kind: "installment"`.
 *     Surfacing this loudly catches a category-error caller (e.g. UI
 *     accidentally calling this on a full-payment contract) rather
 *     than returning an empty array that the UI might misinterpret.
 */
export const listContractInstallments = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: ListContractInstallmentsArgs,
  ): Promise<InstallmentRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (contract.kind !== "installment") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Contract is not an installment contract; no installment rows to list.",
        { contractId: args.contractId, kind: contract.kind },
      );
    }
    const rows = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .collect();
    // Sort by installmentNumber ascending. The `by_contract` index does
    // not order by `installmentNumber`, so we re-sort in-handler — the
    // expected row count per contract is small (≤ 60 per the validator
    // in `recordInstallmentSale`).
    const sorted = [...rows].sort(
      (a, b) => a.installmentNumber - b.installmentNumber,
    );
    return sorted.map((row) => {
      const out: InstallmentRow = {
        installmentId: row._id,
        contractId: row.contractId,
        installmentNumber: row.installmentNumber,
        dueDate: row.dueDate,
        principalCents: row.principalCents,
        paidCents: row.paidCents,
        status: row.status,
      };
      if (row.paidAt !== undefined) {
        out.paidAt = row.paidAt;
      }
      return out;
    });
  },
});
