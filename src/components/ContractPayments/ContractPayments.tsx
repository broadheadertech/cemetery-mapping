"use client";

/**
 * What has been paid against this contract.
 *
 * Replaces a sentence reading "Full timeline view (payments,
 * transitions, void / cancel) ships in Story 3.6" — printed directly
 * beneath the mark-in-default and reclaim-lot controls it claimed were
 * missing, on a page whose query for these payments had existed all
 * along.
 *
 * The list is the contract's financial history in one place: what
 * arrived, how, when, and which receipt it produced. A page about a
 * contract that cannot say what has been paid on it sends somebody to
 * the payments screen to filter for the contract they were already
 * looking at.
 *
 * @gated-route-only — mounts on `/contracts/[contractId]`;
 * `payments:listContractPayments` admits admin and office staff only.
 */

import { type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface ContractPaymentRow {
  paymentId: string;
  paymentNumber: string;
  amountCents: number;
  paymentMethod: string;
  reference?: string;
  receivedAt: number;
  isVoided: boolean;
  receiptId?: string;
  receiptNumber?: string;
}

const listRef = makeFunctionReference<
  "query",
  { contractId: string; limit?: number },
  ContractPaymentRow[]
>("payments:listContractPayments");

export interface ContractPaymentsProps {
  contractId: string;
  /** The contract's agreed total, so the panel can show what remains. */
  totalPriceCents: number;
}

export function ContractPayments({
  contractId,
  totalPriceCents,
}: ContractPaymentsProps): ReactElement {
  const payments = useQuery(listRef, { contractId, limit: 100 });

  /*
   * Voided payments count for nothing.
   *
   * They are still SHOWN — a receipt exists in the world with that
   * number on it, and a history that quietly omits one cannot be
   * reconciled against the drawer — but a voided payment is not money
   * the customer paid, and including it in the total would overstate
   * what has been settled.
   */
  const settled = (payments ?? []).filter((p) => !p.isVoided);
  const paidCents = settled.reduce((n, p) => n + p.amountCents, 0);
  /*
   * Not clamped to zero here.
   *
   * An overpayment is a real thing at a counter, and clamping AND
   * branching on `> 0` below meant two mechanisms produced the same
   * screen — so a test for "an overpayment must not read -₱5,000.00
   * outstanding" could not fail however it was broken. One guard, in
   * the branch that renders, is a guard that can be tested.
   */
  const outstandingCents = totalPriceCents - paidCents;

  return (
    <section
      aria-labelledby="contract-payments-heading"
      data-testid="contract-payments"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="contract-payments-heading"
          className="text-lg font-semibold text-slate-900"
        >
          Payments
        </h2>
        {payments !== undefined && (
          <span
            data-testid="contract-payments-summary"
            className="text-sm text-slate-600"
          >
            {peso(paidCents)} of {peso(totalPriceCents)} &middot;{" "}
            <span
              className={
                outstandingCents > 0
                  ? "font-medium text-amber-700"
                  : "font-medium text-emerald-700"
              }
            >
              {outstandingCents > 0
                ? `${peso(outstandingCents)} outstanding`
                : "Settled"}
            </span>
          </span>
        )}
      </div>

      {payments === undefined ? (
        <p className="text-sm text-slate-500">Loading&hellip;</p>
      ) : payments.length === 0 ? (
        <p
          data-testid="contract-payments-empty"
          className="text-sm text-slate-500"
        >
          No payment has been recorded against this contract yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {payments.map((p) => (
            <li
              key={p.paymentId}
              data-testid="contract-payment-row"
              className="flex flex-wrap items-baseline justify-between gap-2 py-2.5"
            >
              <div>
                <span
                  className={
                    p.isVoided
                      ? "text-sm text-slate-400 line-through"
                      : "text-sm font-medium text-slate-900"
                  }
                >
                  {peso(p.amountCents)}
                </span>
                <span className="ml-2 text-xs capitalize text-slate-500">
                  {p.paymentMethod.replace(/_/g, " ")}
                </span>
                {p.isVoided && (
                  <span
                    data-testid="contract-payment-voided"
                    className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500"
                  >
                    Voided
                  </span>
                )}
                {p.reference !== undefined && p.reference !== "" && (
                  <span className="ml-2 font-mono text-[11px] text-slate-400">
                    {p.reference}
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">
                  {formatDay(p.receivedAt)}
                </div>
                {/*
                  The receipt number, linked. It is the thing a family
                  arrives holding, and the only bridge from a piece of
                  paper back into the system.
                */}
                {p.receiptId !== undefined ? (
                  <Link
                    href={`/receipts/${p.receiptId}`}
                    className="font-mono text-[11px] text-slate-500 underline hover:text-slate-900"
                  >
                    {p.receiptNumber ?? "Receipt"}
                  </Link>
                ) : (
                  <span className="font-mono text-[11px] text-slate-400">
                    {p.paymentNumber}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function peso(cents: number): string {
  return "₱" + (cents / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}
