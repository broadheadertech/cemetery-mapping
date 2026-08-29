"use client";

/**
 * /admin/commissions — what the park owes its agents.
 *
 * Whether a commission is payable is DERIVED from what has actually
 * been collected, not stored. A stored flag would drift from the
 * payments it is meant to reflect the first time one was voided.
 *
 * Due first, because the office is here to pay somebody. A row that is
 * not due yet says how much more has to be collected in pesos, which is
 * something the office can chase — "not yet due" ends the conversation.
 */

import { useState, type ReactElement } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";

type CommissionState = "not_due" | "due" | "paid" | "void";

interface CommissionRow {
  contractId: string;
  contractNumber: string;
  agentId: string;
  agentName: string;
  customerName: string;
  lotCode: string;
  contractTotalCents: number;
  commissionCents: number;
  commissionPercent: number;
  state: CommissionState;
  collectedPercent: number;
  shortfallCents: number;
  message: string;
}

interface Ledger {
  rows: CommissionRow[];
  totalDueCents: number;
  totalNotDueCents: number;
  earnedAtPercent: number;
}

const ledgerRef = makeFunctionReference<
  "query",
  { agentId?: string; dueOnly?: boolean },
  Ledger
>("salesAgents:listCommissions");

const payRef = makeFunctionReference<
  "mutation",
  { contractId: string; note?: string },
  { contractId: string; commissionCents: number }
>("salesAgents:markCommissionPaid");

const LABEL: Record<CommissionState, string> = {
  due: "Payable",
  not_due: "Not yet",
  paid: "Paid",
  void: "Cancelled sale",
};

const TONE: Record<CommissionState, string> = {
  due: "border-emerald-300 bg-emerald-50",
  not_due: "border-slate-200 bg-white",
  paid: "border-slate-200 bg-slate-50",
  void: "border-slate-200 bg-slate-50",
};

export default function CommissionsPage(): ReactElement {
  const [dueOnly, setDueOnly] = useState(false);
  const ledger = useQuery(ledgerRef, dueOnly ? { dueOnly: true } : {});
  const pay = useMutation(payRef);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Commissions
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          A commission becomes payable once the family has paid in far
          enough &mdash;{" "}
          {ledger !== undefined ? `${ledger.earnedAtPercent}%` : "a share"} of
          the contract. Paying at signing means paying on money that may
          never arrive.
        </p>
      </header>

      {ledger !== undefined && (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-md border border-emerald-300 bg-emerald-50 p-4">
            <dt className="text-xs text-emerald-900">Payable now</dt>
            <dd
              data-testid="commissions-due-total"
              className="mt-1 font-display text-3xl font-light text-emerald-900"
            >
              {formatPeso(ledger.totalDueCents)}
            </dd>
          </div>
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <dt className="text-xs text-slate-500">
              Recorded, not yet collected far enough
            </dt>
            <dd className="mt-1 font-display text-3xl font-light text-slate-900">
              {formatPeso(ledger.totalNotDueCents)}
            </dd>
          </div>
        </dl>
      )}

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={dueOnly}
          data-testid="commissions-due-only"
          onChange={(e) => setDueOnly(e.target.checked)}
        />
        Only what is payable now
      </label>

      {error !== null && (
        <p
          role="alert"
          data-testid="commissions-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      {ledger === undefined ? (
        <p className="text-sm text-slate-500">Adding up&hellip;</p>
      ) : ledger.rows.length === 0 ? (
        <p
          data-testid="commissions-empty"
          className="rounded-md border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700"
        >
          {dueOnly
            ? "Nothing is payable right now."
            : "No sale has been credited to an agent yet."}
        </p>
      ) : (
        <ul className="space-y-2">
          {ledger.rows.map((r) => (
            <li
              key={r.contractId}
              data-testid="commission-row"
              className={`rounded-md border p-4 ${TONE[r.state]}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">
                      {r.agentName}
                    </span>
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                      {LABEL[r.state]}
                    </span>
                  </div>
                  <p className="mt-1 font-display text-2xl font-light text-slate-900">
                    {formatPeso(r.commissionCents)}
                    <span className="ml-2 text-sm font-normal text-slate-600">
                      {r.commissionPercent}% of{" "}
                      {formatPeso(r.contractTotalCents)}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    {r.customerName} &middot; lot {r.lotCode} &middot;{" "}
                    <Link
                      href={`/contracts/${r.contractId}`}
                      className="font-mono text-xs underline"
                    >
                      {r.contractNumber}
                    </Link>
                  </p>
                  <p className="mt-1 text-xs text-slate-600">{r.message}</p>
                </div>

                {r.state === "due" && (
                  <button
                    type="button"
                    data-testid="commission-pay"
                    onClick={() => {
                      setError(null);
                      void pay({ contractId: r.contractId }).catch(
                        (e: unknown) => setError(messageOf(e)),
                      );
                    }}
                    className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                  >
                    Mark paid
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-slate-500">
        Rates are frozen at the sale. Changing the park&rsquo;s standard
        rate under{" "}
        <Link
          href="/admin/settings/sales-agents"
          className="underline"
        >
          Sales agents
        </Link>{" "}
        affects sales recorded from then on and leaves these alone.
      </p>
    </div>
  );
}

/** The server's own words — "₱12,000 more must be collected" beats a code. */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { message?: unknown } }).data;
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
  }
  return "Something went wrong. Nothing was saved.";
}
