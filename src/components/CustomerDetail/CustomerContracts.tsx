"use client";

/**
 * This customer's contracts.
 *
 * Replaces a panel that reserved the space and rendered "Contracts
 * coming in Epic 3" into it. Epic 3 shipped, the `by_customer` index
 * has been there all along, and the page went on telling staff that a
 * working part of the system was unbuilt.
 *
 * Shows what has been PAID as well as what was agreed. A contracts list
 * that gives a price without saying how much of it has arrived is the
 * list somebody has to leave in order to answer the only question they
 * had.
 *
 * @gated-route-only — mounts on `/customers/[customerId]`; the query
 * admits admin and office staff only.
 */

import { type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface CustomerContractRow {
  _id: string;
  contractNumber: string;
  lotId: string;
  lotCode: string;
  kind: string;
  state: string;
  totalPriceCents: number;
  paidCents: number;
  createdAt: number;
}

const listRef = makeFunctionReference<
  "query",
  { customerId: string },
  CustomerContractRow[]
>("contracts:listContractsForCustomer");

/** How each state should read, and how loudly. */
const STATE_STYLE: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-800 border-emerald-200",
  paid_in_full: "bg-emerald-50 text-emerald-800 border-emerald-200",
  in_default: "bg-red-50 text-red-800 border-red-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  voided: "bg-slate-100 text-slate-600 border-slate-200",
};

export interface CustomerContractsProps {
  customerId: string;
}

export function CustomerContracts({
  customerId,
}: CustomerContractsProps): ReactElement {
  const contracts = useQuery(listRef, { customerId });

  return (
    <section
      aria-labelledby="contracts-heading"
      data-testid="customer-contracts"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="contracts-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Contracts
      </h2>

      {contracts === undefined ? (
        <p className="text-sm text-slate-500">Loading&hellip;</p>
      ) : contracts.length === 0 ? (
        <p
          data-testid="customer-contracts-empty"
          className="text-sm text-slate-500"
        >
          This customer has no contracts yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {contracts.map((c) => {
            const outstanding = c.totalPriceCents - c.paidCents;
            return (
              <li
                key={c._id}
                data-testid="customer-contract-row"
                className="flex flex-wrap items-baseline justify-between gap-2 py-3"
              >
                <div>
                  <Link
                    href={`/contracts/${c._id}`}
                    className="font-mono text-sm text-slate-900 underline hover:text-slate-600"
                  >
                    {c.contractNumber}
                  </Link>
                  <span className="ml-2 text-sm text-slate-600">
                    Lot {c.lotCode}
                  </span>
                  <span
                    data-testid="customer-contract-state"
                    className={`ml-2 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      STATE_STYLE[c.state] ??
                      "border-slate-200 bg-slate-100 text-slate-600"
                    }`}
                  >
                    {c.state.replace(/_/g, " ")}
                  </span>
                </div>
                <div className="text-right text-xs">
                  <div className="text-slate-900">
                    {peso(c.paidCents)} of {peso(c.totalPriceCents)}
                  </div>
                  {/*
                    The number somebody is actually asking about. A
                    fully-paid contract says so rather than showing a
                    zero that reads like a missing value.
                  */}
                  <div
                    data-testid="customer-contract-outstanding"
                    className={
                      outstanding > 0 ? "text-amber-700" : "text-slate-500"
                    }
                  >
                    {outstanding > 0
                      ? `${peso(outstanding)} outstanding`
                      : "Settled"}
                  </div>
                </div>
              </li>
            );
          })}
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
