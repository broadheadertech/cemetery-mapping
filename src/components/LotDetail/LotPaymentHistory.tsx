"use client";

/**
 * What has been paid against this lot.
 *
 * Replaces a panel that reserved the space and rendered "Payments
 * coming in Epic 3" into it. Epic 3 shipped. The payments existed, the
 * indexes existed, and the page went on telling staff that a working
 * part of the system was unbuilt while the money it disclaimed sat one
 * screen away.
 *
 * Reached through the lot's contracts, because a payment belongs to a
 * contract rather than to a plot. A lot resold after a cancellation has
 * more than one, and both belong here: the question at the counter is
 * "what has been paid on this lot", not "on this contract".
 *
 * @gated-route-only — mounts on `/lots/[lotId]`; the query admits admin
 * and office staff only, so a field worker sees the panel's empty state
 * rather than somebody's payment history.
 */

import { type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface LotPaymentRow {
  _id: string;
  contractId: string;
  contractNumber: string;
  amountCents: number;
  paymentMethod: string;
  receivedAt: number;
  isVoided: boolean;
  reference: string | null;
}

const listRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotPaymentRow[]
>("payments:listLotPayments");

export interface LotPaymentHistoryProps {
  lotId: string;
}

export function LotPaymentHistory({
  lotId,
}: LotPaymentHistoryProps): ReactElement {
  const payments = useQuery(listRef, { lotId });

  const settled = (payments ?? []).filter((p) => !p.isVoided);
  const total = settled.reduce((n, p) => n + p.amountCents, 0);

  return (
    <section
      aria-labelledby="payments-heading"
      data-testid="lot-payment-history"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="payments-heading"
          className="text-base font-semibold text-slate-900"
        >
          Payment history
        </h2>
        {payments !== undefined && settled.length > 0 && (
          <span data-testid="lot-payment-total" className="text-sm text-slate-600">
            {peso(total)} received
          </span>
        )}
      </div>

      {payments === undefined ? (
        <p className="text-sm text-slate-500">Loading&hellip;</p>
      ) : payments.length === 0 ? (
        <p data-testid="lot-payments-empty" className="text-sm text-slate-500">
          Nothing has been paid against this lot.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {payments.map((p) => (
            <li
              key={p._id}
              data-testid="lot-payment-row"
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
                {/*
                  A voided payment is SHOWN, struck through, never
                  hidden. A receipt exists in the world with that number
                  on it, and a history that quietly omits it cannot be
                  reconciled against the drawer.
                */}
                {p.isVoided && (
                  <span
                    data-testid="lot-payment-voided"
                    className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500"
                  >
                    Voided
                  </span>
                )}
                {p.reference !== null && (
                  <span className="ml-2 font-mono text-[11px] text-slate-400">
                    {p.reference}
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">
                  {formatDay(p.receivedAt)}
                </div>
                <Link
                  href={`/contracts/${p.contractId}`}
                  className="font-mono text-[11px] text-slate-500 underline hover:text-slate-900"
                >
                  {p.contractNumber}
                </Link>
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
