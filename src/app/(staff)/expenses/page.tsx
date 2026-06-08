"use client";

/**
 * /expenses — operating-expense list (Story 4.6).
 *
 * Reactive table of the most-recent 50 expenses, ordered by `paidAt`
 * desc. Each row is wrapped in `<ReactiveHighlight>` so a fresh row
 * arriving via the Convex subscription flashes amber for 600ms — the
 * calm-reactive primitive (Story 1.4) applied to ops data.
 *
 * Mobile (< 768px): the table collapses to a card-per-row pattern per
 * UX § Responsive Design (tables → cards on mobile).
 *
 * Auth: the (staff) layout protects the route. Per-role enforcement
 * (`office_staff` / `admin`) lives in the Convex query.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { periodBoundsManila, type DashboardPeriod } from "@/lib/time";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

type DrillPeriod = DashboardPeriod;

/**
 * Compute the period bounds for the drill-down filter. Manila-tz
 * anchored via `periodBoundsManila` so the boundary cannot drift to
 * the operator's local system timezone (HIGH-D, Epic 5 review).
 */
function periodBoundsMs(period: DrillPeriod | null): {
  startMs: number;
  endMs: number;
  label: string;
} | null {
  if (period !== "mtd" && period !== "ytd") return null;
  return periodBoundsManila(period);
}

interface ExpenseRow {
  _id: string;
  _creationTime: number;
  paidAt: number;
  amountCents: number;
  vendor: string;
  category: string;
  photoStorageId?: string;
  recordedBy: string;
  recordedByName: string | null;
  recordedAt: number;
}

const listRecentExpensesRef = makeFunctionReference<
  "query",
  { limit?: number; fromMs?: number; toMs?: number },
  ExpenseRow[]
>("expenses:listRecentExpenses");

const getExpensePhotoUrlRef = makeFunctionReference<
  "query",
  { expenseId: string },
  string | null
>("expenses:getExpensePhotoUrl");

const DATE_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatPaidDate(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return DATE_FORMATTER.format(new Date(ms));
}

export default function ExpensesListPage() {
  const searchParams = useSearchParams();
  const periodParam = searchParams.get("period");
  const period: DrillPeriod | null =
    periodParam === "mtd" || periodParam === "ytd" ? periodParam : null;
  const bounds = useMemo(() => periodBoundsMs(period), [period]);

  // HIGH-D (Epic 5 review): the period filter is pushed into the
  // server query via the `fromMs` / `toMs` args added on
  // `expenses:listRecentExpenses`. The index walks
  // `expenses.by_paidAt` with the bounds applied, so we no longer
  // need the previous "widen fetch + client `.filter()`" hack that
  // could silently drop expenses outside the visible window.
  const queryArgs = useMemo<{
    limit?: number;
    fromMs?: number;
    toMs?: number;
  }>(() => {
    const base: { limit?: number; fromMs?: number; toMs?: number } = {
      limit: bounds !== null ? 100 : 50,
    };
    if (bounds !== null) {
      base.fromMs = bounds.startMs;
      base.toMs = bounds.endMs;
    }
    return base;
  }, [bounds]);
  const expenses = useQuery(listRecentExpensesRef, queryArgs);
  const [photoExpenseId, setPhotoExpenseId] = useState<string | null>(null);
  const photoUrl = useQuery(
    getExpensePhotoUrlRef,
    photoExpenseId === null ? "skip" : { expenseId: photoExpenseId },
  );

  const filteredExpenses = expenses;
  const isLoading = filteredExpenses === undefined;
  const isEmpty =
    filteredExpenses !== undefined && filteredExpenses.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          {bounds !== null ? `Expenses — ${bounds.label}` : "Expenses"}
        </h1>
        <Link
          href="/expenses/new"
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437]"
          data-testid="expenses-new-link"
        >
          Record expense
        </Link>
      </div>

      <p
        className="text-sm text-slate-600"
        data-testid="expenses-period-banner"
      >
        {bounds !== null
          ? `Filtered to expenses paid in the current ${period === "ytd" ? "year" : "month"}. Click a photo thumbnail to view the attached receipt.`
          : "Recent operating expenses. Click a photo thumbnail to view the attached receipt."}
      </p>

      {isLoading && (
        <div
          data-testid="expenses-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading expenses…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="expenses-empty"
        >
          {bounds !== null ? (
            <p className="text-sm text-slate-600">
              No expenses in this {period === "ytd" ? "year" : "month"}.
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              No expenses recorded yet. Click &ldquo;Record expense&rdquo; above
              to log the first one.
            </p>
          )}
        </div>
      )}

      {filteredExpenses !== undefined && filteredExpenses.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-md border border-slate-200 bg-white md:block">
            <table className="w-full text-sm">
              <thead className="bg-[#F6F2EA] text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8E8C85]">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Recorded by</th>
                  <th className="px-4 py-3">Photo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredExpenses.map((row) => (
                  <tr
                    key={row._id}
                    data-testid={`expense-row-${row._id}`}
                    className="hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <ReactiveHighlight watch={row._creationTime}>
                        {formatPaidDate(row.paidAt)}
                      </ReactiveHighlight>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{row.vendor}</td>
                    <td className="px-4 py-3 text-slate-600">{row.category}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900">
                      {formatPeso(row.amountCents)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.recordedByName ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {row.photoStorageId !== undefined ? (
                        <button
                          type="button"
                          onClick={() => setPhotoExpenseId(row._id)}
                          className="text-xs font-medium text-slate-900 underline"
                          data-testid={`expense-photo-link-${row._id}`}
                        >
                          View
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {filteredExpenses.map((row) => (
              <div
                key={row._id}
                className="rounded-md border border-slate-200 bg-white p-4"
                data-testid={`expense-card-${row._id}`}
              >
                <ReactiveHighlight
                  watch={row._creationTime}
                  className="block w-full"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">
                        {row.vendor}
                      </p>
                      <p className="text-xs text-slate-500">{row.category}</p>
                    </div>
                    <p className="text-sm font-medium tabular-nums text-slate-900">
                      {formatPeso(row.amountCents)}
                    </p>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {formatPaidDate(row.paidAt)} • Recorded by{" "}
                    {row.recordedByName ?? "—"}
                  </p>
                  {row.photoStorageId !== undefined && (
                    <button
                      type="button"
                      onClick={() => setPhotoExpenseId(row._id)}
                      className="mt-2 text-xs font-medium text-slate-900 underline"
                    >
                      View receipt
                    </button>
                  )}
                </ReactiveHighlight>
              </div>
            ))}
          </div>
        </>
      )}

      {photoExpenseId !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Receipt preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPhotoExpenseId(null)}
        >
          <div
            className="max-h-full max-w-3xl overflow-hidden rounded-md bg-white p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {photoUrl === undefined && (
              <p className="p-6 text-sm text-slate-500">Loading photo…</p>
            )}
            {photoUrl === null && (
              <p className="p-6 text-sm text-slate-500">
                No photo attached to this expense.
              </p>
            )}
            {typeof photoUrl === "string" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoUrl}
                alt="Expense receipt"
                className="max-h-[80vh] w-auto rounded"
              />
            )}
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setPhotoExpenseId(null)}
                className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
