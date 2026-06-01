"use client";

/**
 * /payments — cross-contract collections list (Story 5.3 AC1 / AC5,
 * HIGH-A fix from the Epic 5 adversarial review).
 *
 * Drill-down destination from the dashboard's MTD / YTD Collections
 * tile. Each row links to (a) the receipt PDF and (b) the source
 * contract. The query is server-side filtered + Manila-tz anchored:
 *
 *   - URL params: `?period=mtd|ytd` (default `mtd`) or `?from=ms&to=ms`
 *     for explicit windows. The dashboard always supplies `period`; the
 *     Sales-by-dimension report (Story 6.3) supplies `from` / `to`.
 *   - `payments:listPaymentsInPeriod` walks `payments.by_receivedAt`
 *     with the bounds applied at the index level — no client-side
 *     `.filter()`, no 100-row cap masking the data.
 *
 * Auth: layout-level (staff) gate + server-side `requireRole` on the
 * underlying query (admin / office_staff).
 */

import Link from "next/link";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import {
  formatDate,
  formatPeriodRangeLabel,
  periodBoundsManila,
  type DashboardPeriod,
} from "@/lib/time";

interface PaymentsListRow {
  paymentId: string;
  paymentNumber: string;
  receiptId?: string;
  receiptNumber?: string;
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
  contractId?: string;
  contractNumber?: string;
  customerId?: string;
  customerFullName?: string;
}

const listPaymentsInPeriodRef = makeFunctionReference<
  "query",
  {
    period?: DashboardPeriod;
    from?: number;
    to?: number;
    limit?: number;
  },
  PaymentsListRow[]
>("payments:listPaymentsInPeriod");

const PAYMENT_METHOD_LABEL: Record<PaymentsListRow["paymentMethod"], string> = {
  cash: "Cash",
  check: "Cheque",
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
};

export default function PaymentsListPage() {
  const searchParams = useSearchParams();
  const periodParam = searchParams.get("period");
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");

  const period: DashboardPeriod =
    periodParam === "ytd" ? "ytd" : "mtd";
  const fromMs = useMemo(() => {
    const n = fromParam !== null ? Number(fromParam) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }, [fromParam]);
  const toMs = useMemo(() => {
    const n = toParam !== null ? Number(toParam) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }, [toParam]);

  // Compute the bounds banner. Explicit from/to wins over period.
  const bounds = useMemo(() => {
    if (fromMs !== null && toMs !== null) {
      return { startMs: fromMs, endMs: toMs, label: "Custom window" };
    }
    return periodBoundsManila(period);
  }, [fromMs, toMs, period]);
  const rangeLabel = useMemo(() => formatPeriodRangeLabel(bounds), [bounds]);

  // Query args — pass the explicit window through when supplied so the
  // server scans exactly the operator's selected slice; otherwise hand
  // the server the `period` literal and let it anchor at "now" (which
  // matches the dashboard tile's behaviour).
  const queryArgs = useMemo<{
    period?: DashboardPeriod;
    from?: number;
    to?: number;
    limit?: number;
  }>(() => {
    const base: {
      period?: DashboardPeriod;
      from?: number;
      to?: number;
      limit?: number;
    } = { limit: 200 };
    if (fromMs !== null) base.from = fromMs;
    if (toMs !== null) base.to = toMs;
    if (fromMs === null && toMs === null) base.period = period;
    return base;
  }, [fromMs, toMs, period]);

  const rows = useQuery(listPaymentsInPeriodRef, queryArgs);
  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  const totalCents = useMemo(() => {
    if (rows === undefined) return 0;
    let sum = 0;
    for (const r of rows) {
      if (r.isVoided) continue;
      sum += r.amountCents;
    }
    return sum;
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">
          Payments — {bounds.label}
        </h1>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
          data-testid="payments-back-to-dashboard"
        >
          ← Back to dashboard
        </Link>
      </div>

      <p
        className="text-sm text-slate-600"
        data-testid="payments-period-banner"
      >
        Collections received in <strong>{rangeLabel}</strong>. The list
        updates live as payments are posted from other tabs; voided
        receipts remain visible (grey) so totals reconcile against the
        dashboard tile.
      </p>

      {isLoading && (
        <div
          data-testid="payments-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading payments…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="payments-empty"
        >
          <p className="text-sm text-slate-600">
            No payments recorded in this window.
          </p>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <>
          <div className="rounded-md border border-slate-200 bg-surface-muted px-4 py-3 text-sm">
            <strong>{rows.length}</strong> payment
            {rows.length === 1 ? "" : "s"} ·{" "}
            <strong data-testid="payments-total">
              {formatPeso(totalCents)}
            </strong>{" "}
            collected (excludes voided)
          </div>

          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Receipt #</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Contract</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr
                    key={r.paymentId}
                    data-testid={`payment-row-${r.paymentId}`}
                    className={
                      r.isVoided
                        ? "bg-slate-50 text-slate-400"
                        : "hover:bg-slate-50"
                    }
                  >
                    <td className="px-4 py-3 font-medium">
                      {r.receiptId !== undefined &&
                      r.receiptNumber !== undefined ? (
                        <Link
                          href={`/receipts/${r.receiptId}`}
                          className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                          data-testid={`payment-receipt-link-${r.paymentId}`}
                        >
                          {r.receiptNumber}
                          {r.isVoided && (
                            <span className="ml-2 text-[10px] uppercase tracking-wide">
                              voided
                            </span>
                          )}
                        </Link>
                      ) : (
                        <span>{r.paymentNumber}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.customerId !== undefined &&
                      r.customerFullName !== undefined ? (
                        <Link
                          href={`/customers/${r.customerId}`}
                          className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                        >
                          {r.customerFullName}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.contractId !== undefined &&
                      r.contractNumber !== undefined ? (
                        <Link
                          href={`/contracts/${r.contractId}`}
                          className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                        >
                          {r.contractNumber}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {formatPeso(r.amountCents)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {PAYMENT_METHOD_LABEL[r.paymentMethod]}
                      {r.reference !== undefined && (
                        <span className="ml-1 text-xs text-slate-400">
                          ({r.reference})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {formatDate(r.receivedAt, "short")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
