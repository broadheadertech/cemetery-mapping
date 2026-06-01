"use client";

/**
 * ExpenseApprovalQueue — Story 6.7 (FR41).
 *
 * Admin-only queue surface for the pending-approval rows produced by
 * Story 6.6's `convex/expenses.ts → listPendingApprovals` query.
 *
 * Design:
 *   - Component is Convex-free: the parent (`/admin/expense-approvals`)
 *     owns the `useQuery` / `useMutation` wiring and hands the rows +
 *     async action callbacks down. Same testability pattern as
 *     `FlagContractDialog` (Story 5.4) — keeps component tests pure
 *     React without a Convex provider.
 *   - One row per pending expense. Inline Approve / Reject buttons.
 *     Reject opens a Dialog that requires a non-empty reason
 *     (mirroring the server's `rejectExpense` validation in
 *     `convex/expenses.ts`).
 *   - No bulk-select in this iteration. The original Story 6.7 spec
 *     contemplated `bulkApproveExpenses` / `bulkRejectExpenses`
 *     mutations, but Story 6.6 shipped only per-row `approveExpense`
 *     / `rejectExpense`. Per-row actions remain the single source of
 *     truth; bulk affordances can layer on later once the Convex
 *     surface is extended.
 *
 * Reactive: the upstream `useQuery(api.expenses.listPendingApprovals)`
 * keeps the table live. After a successful Approve / Reject the row
 * disappears on the next reactive tick (the index filter drops
 * `pending_approval` rows once the mutation patches the status).
 *
 * Accessibility:
 *   - `<table>` with proper `<th scope="col">` headers.
 *   - Reject Dialog labels its textarea + surfaces validation errors
 *     via `aria-invalid` + `aria-describedby`.
 *   - Approve / Reject buttons carry a `data-testid` plus a labelled
 *     accessible name including the vendor for screen-reader context.
 */

import { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { translateError } from "@/lib/errors";

/**
 * Row shape — mirrors the projection returned by
 * `convex/expenses.ts → listPendingApprovals`. Kept local (not
 * imported from convex) so the component never reaches into the
 * server module graph.
 */
export interface PendingApprovalRow {
  _id: string;
  paidAt: number;
  amountCents: number;
  vendor: string;
  category: string;
  recordedByName: string | null;
}

export interface ExpenseApprovalQueueProps {
  /** Live rows from `listPendingApprovals`. `undefined` while loading. */
  rows: ReadonlyArray<PendingApprovalRow> | undefined;
  /**
   * Per-row approve callback. Parent calls `useMutation(api.expenses.
   * approveExpense)` and hands the bound mutation in. Returning a
   * promise lets the component disable the button during the
   * round-trip.
   */
  onApprove: (expenseId: string) => Promise<void>;
  /**
   * Per-row reject callback. Parent calls `useMutation(api.expenses.
   * rejectExpense)`. The reason is enforced non-empty by both the
   * dialog and the server.
   */
  onReject: (expenseId: string, reason: string) => Promise<void>;
}

const MIN_REASON_LENGTH = 1;
const MAX_REASON_LENGTH = 500;

function formatPeso(cents: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", { dateStyle: "medium" }).format(
    new Date(ms),
  );
}

export function ExpenseApprovalQueue({
  rows,
  onApprove,
  onReject,
}: ExpenseApprovalQueueProps) {
  const [rejectTarget, setRejectTarget] = useState<PendingApprovalRow | null>(
    null,
  );
  // Track which row is currently mid-approve so we can disable the
  // button without freezing the entire table.
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  const handleApprove = async (row: PendingApprovalRow): Promise<void> => {
    setApproveError(null);
    setApprovingId(row._id);
    try {
      await onApprove(row._id);
    } catch (err) {
      const translated = translateError(err);
      setApproveError(translated.detail);
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="space-y-4">
      {approveError !== null && (
        <div
          role="alert"
          data-testid="expense-approval-queue-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {approveError}
        </div>
      )}

      {isLoading && (
        <div
          data-testid="expense-approval-queue-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading pending expenses…
        </div>
      )}

      {isEmpty && (
        <div
          data-testid="expense-approval-queue-empty"
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
        >
          <p className="text-sm text-slate-600">
            No expenses are awaiting approval. Pending submissions will
            appear here as they are recorded.
          </p>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div
          data-testid="expense-approval-queue-table-wrapper"
          className="overflow-x-auto rounded-md border border-slate-200 bg-white"
        >
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Paid
                </th>
                <th scope="col" className="px-4 py-3">
                  Vendor
                </th>
                <th scope="col" className="px-4 py-3">
                  Category
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Amount
                </th>
                <th scope="col" className="px-4 py-3">
                  Recorded by
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr
                  key={row._id}
                  data-testid={`expense-approval-row-${row._id}`}
                  className="hover:bg-slate-50"
                >
                  <td className="px-4 py-3 text-slate-700">
                    {formatDate(row.paidAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {row.vendor}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{row.category}</td>
                  <td className="px-4 py-3 text-right font-medium text-slate-900">
                    {formatPeso(row.amountCents)}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {row.recordedByName ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        data-testid={`expense-approval-approve-${row._id}`}
                        aria-label={`Approve expense from ${row.vendor}`}
                        onClick={() => {
                          void handleApprove(row);
                        }}
                        disabled={approvingId === row._id}
                        className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {approvingId === row._id ? "Approving…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        data-testid={`expense-approval-reject-${row._id}`}
                        aria-label={`Reject expense from ${row.vendor}`}
                        onClick={() => setRejectTarget(row)}
                        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
      >
        <DialogContent data-testid="expense-approval-reject-dialog">
          {rejectTarget !== null && (
            <RejectExpenseDialogBody
              target={rejectTarget}
              onClose={() => setRejectTarget(null)}
              onSubmit={async (reason) => {
                await onReject(rejectTarget._id, reason);
                setRejectTarget(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface RejectDialogBodyProps {
  target: PendingApprovalRow;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}

function RejectExpenseDialogBody({
  target,
  onClose,
  onSubmit,
}: RejectDialogBodyProps) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmed = reason.trim();
  const tooShort = trimmed.length < MIN_REASON_LENGTH;
  const tooLong = reason.length > MAX_REASON_LENGTH;
  const canSubmit = !tooShort && !tooLong && !submitting;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setSubmitting(false);
      const translated = translateError(err);
      setErrorMessage(
        translated.detail.length > 0
          ? translated.detail
          : "Failed to reject this expense. Please try again.",
      );
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Reject expense</DialogTitle>
        <DialogDescription>
          Provide a reason for rejecting the expense from{" "}
          <strong>{target.vendor}</strong>. The reason is saved to the
          audit log and shown to the staff member who recorded it.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2">
        <label
          htmlFor="expense-approval-reject-reason"
          className="text-sm font-medium text-slate-700"
        >
          Reason for rejection
        </label>
        <textarea
          id="expense-approval-reject-reason"
          data-testid="expense-approval-reject-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={submitting}
          rows={3}
          maxLength={MAX_REASON_LENGTH}
          aria-invalid={tooShort || tooLong}
          aria-describedby="expense-approval-reject-reason-counter"
          placeholder="e.g. Receipt photo is unreadable — please rescan and resubmit."
          className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div
          id="expense-approval-reject-reason-counter"
          data-testid="expense-approval-reject-reason-counter"
          aria-live="polite"
          className="flex items-center justify-end text-xs text-slate-500"
        >
          <span>
            {reason.length} / {MAX_REASON_LENGTH}
          </span>
        </div>
      </div>

      {errorMessage !== null && (
        <p
          data-testid="expense-approval-reject-error"
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {errorMessage}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          data-testid="expense-approval-reject-cancel"
          onClick={() => {
            if (!submitting) onClose();
          }}
          disabled={submitting}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="expense-approval-reject-confirm"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={!canSubmit}
          className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Rejecting…" : "Reject expense"}
        </button>
      </div>
    </>
  );
}
