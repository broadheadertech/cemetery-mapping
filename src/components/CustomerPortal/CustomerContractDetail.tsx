"use client";

import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import { StatusPill } from "@/components/ui/StatusPill/StatusPill";
import type { PillStatus } from "@/components/ui/StatusPill/icons";

/**
 * CustomerContractDetail — Story 9.2 (FR55) AC2 + AC3 + AC4.
 *
 * Renders a single contract's header + read-only schedule + payment
 * history for the calling customer. Two Convex queries drive the
 * surface:
 *
 *   - `portal:getCustomerContractDetail` — header, lot, schedule.
 *     Returns `null` when the contract id is unknown OR is not owned
 *     by the caller. Both cases render the "Contract not found" 404
 *     panel (NOT 403 — Story 9.1 ADR's existence-enumeration defence).
 *   - `portal:listCustomerPayments`        — the payment history rows.
 *     The list is read-only at this point; Story 9.3 wires the
 *     "Download receipt" affordance to a signed-URL fetch.
 *
 * Reactivity (AC3): both queries are reactive; a staff-side payment
 * post updates the balance + payment list + remaining-installments
 * count within ~1–2s. `<ReactiveHighlight watch={...}>` wraps the
 * balance and each schedule row's status so the calm-amber affordance
 * fires on change (UX § 1380).
 *
 * Schedule rendering: this component embeds the read-only schedule
 * inline rather than reusing a staff-only `<SchedulePreview>` — the
 * staff component requires data shapes that include staff-only edit
 * affordances, and the customer view is intentionally narrower.
 */

interface CustomerLotRef {
  lotId: string;
  code: string;
  section: string;
  block: string;
  row: string;
  centroid: { lat: number; lng: number };
}

interface CustomerInstallmentRow {
  installmentId: string;
  contractId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
  paidAt?: number;
}

interface CustomerContractHeader {
  contractId: string;
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

interface CustomerContractDetailPayload {
  contract: CustomerContractHeader;
  lot: CustomerLotRef | null;
  schedule: CustomerInstallmentRow[];
}

interface CustomerPaymentRow {
  paymentId: string;
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
  receiptId?: string;
  receiptNumber?: string;
}

const getCustomerContractDetail = makeFunctionReference<
  "query",
  { contractId: string },
  CustomerContractDetailPayload | null
>("portal:getCustomerContractDetail");

const listCustomerPayments = makeFunctionReference<
  "query",
  { contractId: string; limit?: number },
  CustomerPaymentRow[]
>("portal:listCustomerPayments");

const PAYMENT_METHOD_LABEL: Record<CustomerPaymentRow["paymentMethod"], string> = {
  cash: "Cash",
  check: "Check",
  bank_transfer: "Bank transfer",
  gcash: "GCash",
  maya: "Maya",
  card: "Card",
};

const INSTALLMENT_STATUS_PILL: Record<
  CustomerInstallmentRow["status"],
  PillStatus
> = {
  pending: "due",
  paid: "paid",
  overdue: "overdue",
  waived: "current",
};

function contractStatePill(
  contract: CustomerContractHeader,
): PillStatus {
  if (contract.state === "paid_in_full") return "paid";
  if (contract.state === "in_default") return "defaulted";
  if (contract.state === "cancelled" || contract.state === "voided") {
    return "cancelled";
  }
  return contract.outstandingBalanceCents === 0 ? "current" : "due";
}

function lotLine(lot: CustomerLotRef | null): string {
  if (lot === null) return "Lot details unavailable";
  return `Lot ${lot.code} · Section ${lot.section} · Block ${lot.block} · Row ${lot.row}`;
}

/**
 * Customer-side relabel of installment status. The underlying
 * `<StatusPill>` maps to its default vocabulary; on the customer
 * portal we soften "overdue" into "due" so the surface remains
 * compassionate rather than alarming (Apostle Paul Memorial Park
 * brand voice — Tier 2 string revision).
 */
function customerInstallmentPill(
  status: CustomerInstallmentRow["status"],
): PillStatus {
  if (status === "overdue") return "due";
  return INSTALLMENT_STATUS_PILL[status];
}

export interface CustomerContractDetailProps {
  contractId: string;
  /**
   * Test-only override letting the harness inject the contract payload
   * without going through Convex. When supplied, both inner
   * `useQuery` calls are skipped.
   */
  detailOverride?: CustomerContractDetailPayload | null;
  paymentsOverride?: CustomerPaymentRow[];
}

export function CustomerContractDetail({
  contractId,
  detailOverride,
  paymentsOverride,
}: CustomerContractDetailProps) {
  const detailFromQuery = useQuery(
    getCustomerContractDetail,
    detailOverride === undefined ? { contractId } : "skip",
  );
  const paymentsFromQuery = useQuery(
    listCustomerPayments,
    paymentsOverride === undefined ? { contractId } : "skip",
  );

  const detail =
    detailOverride !== undefined ? detailOverride : detailFromQuery;
  const payments =
    paymentsOverride !== undefined ? paymentsOverride : paymentsFromQuery;

  // Loading state — show the schedule + payments skeleton until both
  // queries resolve.
  if (detail === undefined) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm">
          <div className="h-4 w-24 animate-pulse rounded bg-surface-muted" />
          <div className="mt-3 h-7 w-48 animate-pulse rounded bg-surface-muted" />
          <div className="mt-2 h-5 w-32 animate-pulse rounded bg-surface-muted" />
        </div>
        <div className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm">
          <div className="h-4 w-32 animate-pulse rounded bg-surface-muted" />
          <div className="mt-3 h-20 w-full animate-pulse rounded bg-surface-muted" />
        </div>
      </div>
    );
  }

  // 404 — contract is missing OR not owned by the caller. Both cases
  // collapse to the same UI so the existence of other customers'
  // contracts is not leakable through page-render timing.
  if (detail === null) {
    return (
      <div
        className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        role="alert"
      >
        <p className="text-base font-semibold text-text-default">
          Contract not found
        </p>
        <p className="mt-2 text-sm text-text-muted">
          The estate does not hold that contract under your name. Should
          this seem in error, please write to the Estate Office.
        </p>
      </div>
    );
  }

  const { contract, lot, schedule } = detail;
  const hasBalance = contract.outstandingBalanceCents > 0;

  return (
    <div className="space-y-4">
      {/* Header — contract number + lot + state pill + outstanding
          balance + "Pay now" call-to-action. */}
      <section
        aria-labelledby="contract-header-heading"
        className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {contract.contractNumber}
            </p>
            <h2
              id="contract-header-heading"
              className="mt-1 truncate text-lg font-semibold text-text-default"
            >
              {lotLine(lot)}
            </h2>
            <p className="mt-1 text-xs text-text-muted">
              The estate has held this contract since {formatDate(contract.createdAt, "short")}
            </p>
          </div>
          <StatusPill status={contractStatePill(contract)} size="md" />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-text-muted">
              Awaiting settlement
            </p>
            <p className="mt-1 text-2xl font-semibold text-text-default">
              <ReactiveHighlight watch={contract.outstandingBalanceCents}>
                {formatPeso(contract.outstandingBalanceCents)}
              </ReactiveHighlight>
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-text-muted">
              Contract in keeping
            </p>
            <p className="mt-1 text-base text-text-default">
              {formatPeso(contract.totalPriceCents)}
            </p>
            {contract.kind === "installment" &&
            contract.termMonths !== undefined &&
            contract.monthlyAmountCents !== undefined ? (
              <p className="mt-0.5 text-xs text-text-muted">
                {formatPeso(contract.monthlyAmountCents)} × {contract.termMonths} months
              </p>
            ) : null}
          </div>
        </div>

        {hasBalance && contract.state === "active" ? (
          <div className="mt-4">
            <a
              href={`/portal/pay?contractId=${contract.contractId}`}
              className={cn(
                "inline-flex min-h-[44px] items-center justify-center rounded-md",
                "bg-accent-primary px-4 py-2 text-sm font-medium text-text-on-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
              )}
            >
              Settle through the Estate Office
            </a>
          </div>
        ) : null}
      </section>

      {/* Read-only schedule — installment-kind contracts only. */}
      {contract.kind === "installment" ? (
        <section
          aria-labelledby="schedule-heading"
          className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm sm:p-6"
        >
          <h2
            id="schedule-heading"
            className="text-base font-semibold text-text-default"
          >
            Contribution schedule
          </h2>
          {schedule.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              The estate is preparing your schedule. It will appear here in due course.
            </p>
          ) : (
            <ol className="mt-3 divide-y divide-surface-border">
              {schedule.map((row) => (
                <li
                  key={row.installmentId}
                  className="flex items-start justify-between gap-3 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-text-default">
                      #{row.installmentNumber} · {formatDate(row.dueDate, "short")}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      Due {formatPeso(row.principalCents)}
                      {row.paidCents > 0 && row.paidCents < row.principalCents ? (
                        <>
                          {" "}
                          · Paid {formatPeso(row.paidCents)}
                        </>
                      ) : null}
                    </p>
                  </div>
                  <ReactiveHighlight watch={row.status}>
                    <StatusPill
                      status={customerInstallmentPill(row.status)}
                      size="sm"
                    />
                  </ReactiveHighlight>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      {/* Payment history. */}
      <section
        aria-labelledby="payment-history-heading"
        className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm sm:p-6"
      >
        <h2
          id="payment-history-heading"
          className="text-base font-semibold text-text-default"
        >
          Record of contributions
        </h2>
        {payments === undefined ? (
          <div
            aria-busy="true"
            aria-label="Loading payment history"
            className="mt-3 h-16 w-full animate-pulse rounded bg-surface-muted"
          />
        ) : payments.length === 0 ? (
          <p className="mt-3 text-sm text-text-muted">
            No contributions have been recorded yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-surface-border">
            {payments.map((payment) => (
              <li
                key={payment.paymentId}
                className={cn(
                  "py-3",
                  payment.isVoided && "opacity-60",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-default">
                      {formatPeso(payment.amountCents)}
                      {payment.isVoided ? (
                        <span className="ml-2 text-xs font-normal text-text-muted">
                          (voided)
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {formatDate(payment.receivedAt, "short")} ·{" "}
                      {PAYMENT_METHOD_LABEL[payment.paymentMethod]}
                      {payment.receiptNumber ? (
                        <>
                          {" "}
                          · Receipt {payment.receiptNumber}
                        </>
                      ) : null}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled
                    aria-label="Download receipt — arriving shortly"
                    title="The estate will surface receipt downloads in a forthcoming release."
                    className={cn(
                      "inline-flex min-h-[36px] items-center justify-center rounded-md",
                      "border border-surface-border bg-surface-muted px-3 py-1.5",
                      "text-xs font-medium text-text-muted",
                      "cursor-not-allowed",
                    )}
                  >
                    Download
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
