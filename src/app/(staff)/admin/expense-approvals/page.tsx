"use client";

/**
 * /admin/expense-approvals — admin reviews + clears the pending
 * expense approval queue (Story 6.7, FR41).
 *
 * Admin-only. Middleware (`src/middleware.ts`) gates `/admin/*` at
 * the edge; `convex/expenses.ts` re-enforces every call server-side
 * via `requireRole(ctx, ["admin"])` (NFR-S4, defense in depth).
 *
 * Reactive queue of `expenses` where `approvalStatus === "pending_
 * approval"`, fetched via `listPendingApprovals` (Story 6.6). Each
 * row carries inline Approve / Reject actions that fire the
 * corresponding Story 6.6 mutations. The reject flow opens a dialog
 * that captures a non-empty reason (server-validated).
 *
 * The Convex `_generated/` ambient module is not committed in this
 * repo — we reference the queries via `makeFunctionReference`, the
 * same pattern used by `/admin/expense-approval-settings` and
 * `/admin/expense-categories`.
 */

import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  ExpenseApprovalQueue,
  type PendingApprovalRow,
} from "@/components/ExpenseApprovalQueue";

/**
 * Row shape returned by `convex/expenses.ts → listPendingApprovals`.
 * Mirrors `ListedExpense` but typed as `string`-id strings to keep
 * the client free of `Id<"expenses">` ambient typings while
 * `convex/_generated/` is absent.
 */
interface ListPendingApprovalRow {
  _id: string;
  paidAt: number;
  amountCents: number;
  vendor: string;
  category: string;
  recordedByName: string | null;
}

const listPendingApprovalsRef = makeFunctionReference<
  "query",
  { limit?: number },
  ListPendingApprovalRow[]
>("expenses:listPendingApprovals");

const approveExpenseRef = makeFunctionReference<
  "mutation",
  { expenseId: string },
  { expenseId: string }
>("expenses:approveExpense");

const rejectExpenseRef = makeFunctionReference<
  "mutation",
  { expenseId: string; reason: string },
  { expenseId: string }
>("expenses:rejectExpense");

export default function AdminExpenseApprovalsPage() {
  const pending = useQuery(listPendingApprovalsRef, {});
  const approveExpense = useMutation(approveExpenseRef);
  const rejectExpense = useMutation(rejectExpenseRef);

  const rows: ReadonlyArray<PendingApprovalRow> | undefined =
    pending === undefined
      ? undefined
      : pending.map((r) => ({
          _id: r._id,
          paidAt: r.paidAt,
          amountCents: r.amountCents,
          vendor: r.vendor,
          category: r.category,
          recordedByName: r.recordedByName,
        }));

  const handleApprove = async (expenseId: string): Promise<void> => {
    await approveExpense({ expenseId });
  };

  const handleReject = async (
    expenseId: string,
    reason: string,
  ): Promise<void> => {
    await rejectExpense({ expenseId, reason });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Expense approvals
        </h1>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        Pending expenses submitted by office staff are listed below.
        Approving moves the expense into the month-to-date totals and
        the reactive dashboard tile updates automatically. Rejecting
        records the supplied reason on the audit log and notifies the
        submitter via their own expense view.
      </p>

      <ExpenseApprovalQueue
        rows={rows}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </div>
  );
}
