"use client";

/**
 * /receipts — BIR-compliant receipt list (Story 3.11).
 *
 * Reactive table of the most-recent 50 receipts, ordered by `issuedAt`
 * desc. Each row is wrapped in `<ReactiveHighlight>` so a fresh
 * receipt arriving via the Convex subscription flashes amber for 600ms
 * — the calm-reactive primitive (Story 1.4) applied to the BIR side
 * of the ledger.
 *
 * Mobile (< 768px): the table collapses to a card-per-row pattern per
 * UX § Responsive Design.
 *
 * Auth: the (staff) layout protects the route. Per-role enforcement
 * (`admin` / `office_staff`) lives in the Convex query.
 *
 * A "Voided only" toggle re-issues the query with `voidedOnly: true`
 * to surface the void-audit slice. Voided receipts render with a
 * destructive-toned visual mark and keep their serials (FR29).
 */

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

interface ReceiptListRow {
  receiptId: string;
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

const listReceiptsRef = makeFunctionReference<
  "query",
  { limit?: number; voidedOnly?: boolean },
  ReceiptListRow[]
>("receipts:listReceipts");

const DATE_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

function formatIssuedDate(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return DATE_FORMATTER.format(new Date(ms));
}

export default function ReceiptsListPage() {
  const [voidedOnly, setVoidedOnly] = useState(false);
  const receipts = useQuery(listReceiptsRef, { limit: 50, voidedOnly });

  const isLoading = receipts === undefined;
  const isEmpty = receipts !== undefined && receipts.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight text-text-default">
          Receipts
        </h1>
        <label className="flex items-center gap-2 text-sm text-text-muted">
          <input
            type="checkbox"
            checked={voidedOnly}
            onChange={(e) => setVoidedOnly(e.target.checked)}
            data-testid="receipts-voided-toggle"
            className="h-4 w-4 rounded border-surface-border text-primary focus:ring-focus-ring"
          />
          Voided only
        </label>
      </div>

      <p className="text-sm text-text-muted">
        Most recent BIR-compliant official receipts. Click a row to
        view the full receipt.
      </p>

      {isLoading && (
        <div
          data-testid="receipts-loading"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-sm text-text-muted"
        >
          Loading receipts…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-surface-border bg-surface-base p-8 text-center"
          data-testid="receipts-empty"
        >
          <p className="text-sm text-text-muted">
            {voidedOnly
              ? "No voided receipts."
              : "No receipts issued yet. They appear here as soon as the cornerstone records a payment."}
          </p>
        </div>
      )}

      {receipts !== undefined && receipts.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-md border border-surface-border bg-surface-base md:block">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-xs font-medium uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-4 py-3">Receipt #</th>
                  <th className="px-4 py-3">Issued</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Contract</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {receipts.map((row) => (
                  <tr
                    key={row.receiptId}
                    data-testid={`receipt-row-${row.receiptId}`}
                    className="hover:bg-surface-muted"
                  >
                    <td className="px-4 py-3 font-mono text-sm tabular-nums text-text-default">
                      <ReactiveHighlight watch={row.issuedAt}>
                        <Link
                          href={`/receipts/${row.receiptId}`}
                          className="font-medium underline-offset-2 hover:underline"
                          data-testid={`receipt-link-${row.receiptId}`}
                        >
                          {row.receiptNumber}
                        </Link>
                      </ReactiveHighlight>
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {formatIssuedDate(row.issuedAt)}
                    </td>
                    <td className="px-4 py-3 text-text-default">
                      {row.customerFullName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {row.contractNumber ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-default">
                      {formatPeso(row.amountCents)}
                    </td>
                    <td className="px-4 py-3">
                      {row.isVoided ? (
                        <span
                          className="inline-flex items-center rounded-full bg-status-overdue-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-status-overdue-text"
                          data-testid={`receipt-status-${row.receiptId}`}
                        >
                          Voided
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center rounded-full bg-status-paid-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-status-paid-text"
                          data-testid={`receipt-status-${row.receiptId}`}
                        >
                          Issued
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 md:hidden">
            {receipts.map((row) => (
              <Link
                key={row.receiptId}
                href={`/receipts/${row.receiptId}`}
                data-testid={`receipt-card-${row.receiptId}`}
                className="block rounded-md border border-surface-border bg-surface-base p-4 hover:bg-surface-muted"
              >
                <ReactiveHighlight watch={row.issuedAt} className="block w-full">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-sm font-semibold tabular-nums text-text-default">
                        {row.receiptNumber}
                      </p>
                      <p className="mt-1 text-xs text-text-muted">
                        {row.customerFullName ?? "—"}
                      </p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-text-default">
                      {formatPeso(row.amountCents)}
                    </p>
                  </div>
                  <p className="mt-2 text-xs text-text-muted">
                    {formatIssuedDate(row.issuedAt)}
                    {row.contractNumber !== null &&
                      ` · Contract ${row.contractNumber}`}
                    {row.isVoided && " · VOIDED"}
                  </p>
                </ReactiveHighlight>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
