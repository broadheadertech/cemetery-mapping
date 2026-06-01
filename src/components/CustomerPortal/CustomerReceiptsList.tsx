"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

/**
 * CustomerReceiptsList — Story 9.3 (FR56).
 *
 * Renders the authenticated customer's BIR-compliant receipts as a
 * mobile-first card list. Each card surfaces:
 *
 *   - the formatted receipt number (`OR-0000123`) and contract number,
 *   - issued-on date (BIR-canonical timestamp),
 *   - peso-formatted amount,
 *   - voided badge when applicable (voided receipts remain visible —
 *     the customer's historical record includes them, and the Story
 *     3.13 PDF carries the VOIDED watermark for downstream re-distribution),
 *   - tappable affordance navigating to
 *     `/portal/receipts/[receiptId]` where the customer can download
 *     the PDF.
 *
 * Data source: a single Convex query (`portal:listCustomerReceipts`).
 * The query is gated on the `customer` role AND hard-scoped to the
 * caller's `_id` (resolved server-side via the email link), so the
 * component does NOT take a `customerId` prop.
 *
 * Reactivity: Convex's `useQuery` re-renders the cards when the
 * subscribed receipt rows change — e.g. when Story 3.13's action lands
 * a `pdfStorageId`, the `pdfReady` flag flips and the row's affordance
 * updates from "Receipt is being generated…" to "Tap to download".
 *
 * Accessibility:
 *   - Touch target ≥ 48px (NFR-A4) — the card's `min-h-[88px]` plus
 *     padding leaves room for the body content while keeping the tap
 *     area comfortable on a mid-Android device.
 *   - The whole card is a `<Link>` so keyboard navigation + screen-
 *     reader linearisation work without `role="link"` overrides.
 *   - Voided badge carries `aria-label="Voided receipt"` so screen
 *     readers announce the state semantic (the visual badge alone is
 *     not enough — NFR-A3 colour-independence).
 */

/**
 * Row shape mirrors `convex/portal.ts:CustomerReceiptListRow`. Kept
 * inline (not imported from `convex/`) so the component can be unit-
 * tested without pulling the Convex server module into the test
 * harness — matches the pattern used by `CustomerContractsList`.
 */
export interface CustomerReceiptListRow {
  receiptId: string;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  paymentId: string;
  contractId: string | null;
  contractNumber: string | null;
  isVoided: boolean;
  voidedAt: number | null;
  pdfReady: boolean;
}

const listCustomerReceipts = makeFunctionReference<
  "query",
  Record<string, never>,
  CustomerReceiptListRow[]
>("portal:listCustomerReceipts");

export interface CustomerReceiptsListProps {
  /**
   * Optional override used by tests + the page wrapper when it has
   * already resolved the receipts list (avoids the inner `useQuery`
   * during SSR-only renders). When omitted, the component subscribes
   * via Convex's reactive query.
   */
  receipts?: CustomerReceiptListRow[] | undefined;
  /**
   * Optional className for the list wrapper. Defaults to spacing
   * appropriate for the portal layout's max-width column.
   */
  className?: string;
}

export function CustomerReceiptsList({
  receipts: receiptsProp,
  className,
}: CustomerReceiptsListProps) {
  // When `receiptsProp` is supplied, skip the inner query — the parent
  // page already has the data. Otherwise subscribe live so the list
  // re-renders when the Story 3.13 action lands a `pdfStorageId` (the
  // `pdfReady` cell flips) or when a new receipt is posted.
  const fromQuery = useQuery(
    listCustomerReceipts,
    receiptsProp === undefined ? {} : "skip",
  );
  const receipts = receiptsProp ?? fromQuery;

  if (receipts === undefined) {
    // Loading skeleton — two placeholder cards mirroring the card
    // height. Total skeleton runtime is bounded by the Convex query's
    // reactive resolution (NFR-P1 / P2 ≤ 1s warm).
    return (
      <ul
        aria-busy="true"
        aria-label="Loading your receipts"
        className={cn("space-y-3", className)}
      >
        {[0, 1].map((i) => (
          <li
            key={i}
            className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm"
          >
            <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
            <div className="mt-3 h-6 w-40 animate-pulse rounded bg-surface-muted" />
            <div className="mt-2 h-4 w-32 animate-pulse rounded bg-surface-muted" />
          </li>
        ))}
      </ul>
    );
  }

  if (receipts.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-dashed border-surface-border bg-surface-muted p-6 text-center",
          className,
        )}
      >
        <p className="text-sm font-medium text-text-default">
          The estate holds no receipts in your name yet.
        </p>
        <p className="mt-1 text-sm text-text-muted">
          Receipts will rest here once the Estate Office records a
          contribution against your contract.
        </p>
      </div>
    );
  }

  return (
    <ul
      aria-label="Receipts held in your name"
      className={cn("space-y-3", className)}
    >
      {receipts.map((receipt) => (
        <li key={receipt.receiptId}>
          <Link
            href={`/portal/receipts/${receipt.receiptId}`}
            aria-label={`Receipt ${receipt.receiptNumber} — ${formatPeso(receipt.amountCents)}${receipt.isVoided ? " (voided)" : ""}`}
            className={cn(
              "block min-h-[88px] rounded-md border border-surface-border bg-surface-base p-4 shadow-sm",
              "transition-colors hover:bg-surface-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
              receipt.isVoided && "opacity-75",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium uppercase tracking-wide text-text-muted">
                  {receipt.receiptNumber}
                </p>
                <p className="mt-1 text-base font-semibold text-text-default">
                  <ReactiveHighlight watch={receipt.amountCents}>
                    {formatPeso(receipt.amountCents)}
                  </ReactiveHighlight>
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  Issued by the estate on {formatDate(receipt.issuedAt, "short")}
                  {receipt.contractNumber !== null ? (
                    <>
                      {" "}
                      · Contract {receipt.contractNumber}
                    </>
                  ) : null}
                </p>
              </div>
              {receipt.isVoided ? (
                <span
                  role="status"
                  aria-label="Voided receipt"
                  className={cn(
                    "inline-flex shrink-0 items-center rounded-full",
                    "border border-status-due-border bg-status-due-bg",
                    "px-2 py-0.5 text-xs font-medium text-status-due-text",
                  )}
                >
                  Voided
                </span>
              ) : null}
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs text-text-muted">
                {receipt.pdfReady ? (
                  <>PDF ready for keeping</>
                ) : (
                  <ReactiveHighlight watch={receipt.pdfReady}>
                    The estate is preparing your receipt…
                  </ReactiveHighlight>
                )}
              </p>
              <p className="text-xs font-medium text-text-link">
                See particulars →
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
