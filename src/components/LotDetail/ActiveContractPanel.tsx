"use client";

/**
 * ActiveContractPanel — Story 1.11 (AC1e).
 *
 * Preview of the lot's active contract — serial + remaining balance +
 * next-due-date. Phase 1: the contracts table arrives with Epic 3, so
 * the panel always renders the empty state.
 */

import { formatPeso } from "@/lib/money";

export interface ActiveContract {
  serial: string;
  balanceCents: number;
  nextDueDate?: string;
}

export interface ActiveContractPanelProps {
  contract?: ActiveContract | null;
}

export function ActiveContractPanel({
  contract = null,
}: ActiveContractPanelProps) {
  return (
    <section
      aria-labelledby="contract-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="contract-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Active contract
      </h2>
      {contract === null ? (
        <p
          className="text-sm text-slate-600"
          data-testid="contract-empty"
        >
          No active contract. Contracts will populate with Epic 3.
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Contract serial
            </dt>
            <dd className="mt-1 text-sm font-medium text-slate-900">
              {contract.serial}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Remaining balance
            </dt>
            <dd className="mt-1 text-sm tabular-nums text-slate-900">
              {formatPeso(contract.balanceCents)}
            </dd>
          </div>
          {contract.nextDueDate !== undefined && (
            <div className="flex flex-col">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Next due
              </dt>
              <dd className="mt-1 text-sm text-slate-900">
                {contract.nextDueDate}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
