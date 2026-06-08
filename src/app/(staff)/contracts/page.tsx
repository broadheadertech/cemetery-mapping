"use client";

/**
 * /contracts — contracts list view (Story 5.3 drill-down destination).
 *
 * The dashboard's AR Balance tile (Story 5.2 / Story 5.3 AC1) routes
 * here with `?state=active,in_default` — the point-in-time set of
 * contracts that contribute to outstanding AR.
 *
 * AR Balance is intentionally NOT period-scoped (the dashboard's
 * `getDashboardKpis` returns a point-in-time AR figure). The drill-down
 * therefore takes a `state` filter — a comma-separated list of contract
 * states — and shows every contract in any of those states. Default
 * (no `state` param) shows the universe.
 *
 * Why a new page rather than extending `/sales`:
 *   - `/sales` is the operator's daily list — single-state filter chips,
 *     "New sale" CTA, focused on the sale flow.
 *   - `/contracts` is the financial drill-down — multi-state set,
 *     read-only, no CTA. The two pages share the same `listContracts`
 *     Convex query (Story 3.3) but render different shells.
 *
 * Architecture:
 *   - URL is the source of truth (Story 5.3 AC5). No `useState` for the
 *     filter; the `state` param is read every render.
 *   - One indexed scan per state, concatenated client-side. At Phase 1
 *     volumes (a few hundred contracts per state) this stays inside
 *     NFR-P4. A future pagination story would push the union into a
 *     dedicated Convex query.
 *   - `requireRole(ctx, ["admin", "office_staff"])` is enforced inside
 *     the underlying `contracts:listContracts` Convex query.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { StatusPill } from "@/components/ui/StatusPill";

type ContractState =
  | "active"
  | "paid_in_full"
  | "cancelled"
  | "voided"
  | "in_default";

const ALL_STATES: readonly ContractState[] = [
  "active",
  "paid_in_full",
  "cancelled",
  "voided",
  "in_default",
];

interface ContractRow {
  contractId: string;
  contractNumber: string;
  lotId: string;
  lotCode: string;
  customerId: string;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state: ContractState;
  createdAt: number;
}

const listContractsRef = makeFunctionReference<
  "query",
  { stateFilter?: ContractState; limit?: number },
  ContractRow[]
>("contracts:listContracts");

const STATE_LABEL: Record<ContractState, string> = {
  active: "Active",
  paid_in_full: "Paid in full",
  cancelled: "Cancelled",
  voided: "Voided",
  in_default: "In default",
};

// HIGH-F (Story 5.9 sweep): the prior raw Tailwind STATE_CLASS map has
// been removed. Contract-state pills now render through `<StatusPill>`.

function parseStatesParam(raw: string | null): readonly ContractState[] {
  if (raw === null) return ALL_STATES;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const valid = parts.filter((s): s is ContractState =>
    (ALL_STATES as readonly string[]).includes(s),
  );
  return valid.length === 0 ? ALL_STATES : valid;
}

/**
 * Subcomponent: one indexed query per state. Hooks must run on every
 * render so a fixed-length array is fine here — we always invoke the
 * five `useQuery` calls in canonical order with a `skip` sentinel for
 * states not in the selected set.
 */
export default function ContractsListPage() {
  const searchParams = useSearchParams();
  const selectedStates = useMemo(
    () => parseStatesParam(searchParams.get("state")),
    [searchParams],
  );

  // One useQuery per state — Convex's React adapter requires hook order
  // to be stable, so we always run five queries and discard the ones
  // whose state isn't selected. Each is bounded by the `by_state` index.
  const active = useQuery(
    listContractsRef,
    selectedStates.includes("active")
      ? { stateFilter: "active", limit: 200 }
      : "skip",
  );
  const inDefault = useQuery(
    listContractsRef,
    selectedStates.includes("in_default")
      ? { stateFilter: "in_default", limit: 200 }
      : "skip",
  );
  const paidInFull = useQuery(
    listContractsRef,
    selectedStates.includes("paid_in_full")
      ? { stateFilter: "paid_in_full", limit: 200 }
      : "skip",
  );
  const cancelled = useQuery(
    listContractsRef,
    selectedStates.includes("cancelled")
      ? { stateFilter: "cancelled", limit: 200 }
      : "skip",
  );
  const voided = useQuery(
    listContractsRef,
    selectedStates.includes("voided")
      ? { stateFilter: "voided", limit: 200 }
      : "skip",
  );

  const isLoading =
    (selectedStates.includes("active") && active === undefined) ||
    (selectedStates.includes("in_default") && inDefault === undefined) ||
    (selectedStates.includes("paid_in_full") && paidInFull === undefined) ||
    (selectedStates.includes("cancelled") && cancelled === undefined) ||
    (selectedStates.includes("voided") && voided === undefined);

  const rows = useMemo(() => {
    if (isLoading) return undefined;
    const merged: ContractRow[] = [];
    if (selectedStates.includes("active") && active !== undefined) {
      merged.push(...active);
    }
    if (selectedStates.includes("in_default") && inDefault !== undefined) {
      merged.push(...inDefault);
    }
    if (selectedStates.includes("paid_in_full") && paidInFull !== undefined) {
      merged.push(...paidInFull);
    }
    if (selectedStates.includes("cancelled") && cancelled !== undefined) {
      merged.push(...cancelled);
    }
    if (selectedStates.includes("voided") && voided !== undefined) {
      merged.push(...voided);
    }
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged;
  }, [
    isLoading,
    selectedStates,
    active,
    inDefault,
    paidInFull,
    cancelled,
    voided,
  ]);

  const isEmpty = rows !== undefined && rows.length === 0;

  const headerLabel =
    selectedStates.length === ALL_STATES.length
      ? "All contracts"
      : selectedStates.map((s) => STATE_LABEL[s]).join(" + ");

  const outstandingCount = rows?.length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-4xl font-semibold tracking-tight">Contracts</h1>
        <Link
          href="/dashboard"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
          data-testid="contracts-back-to-dashboard"
        >
          ← Back to dashboard
        </Link>
      </div>

      <p
        className="text-sm text-slate-600"
        data-testid="contracts-filter-banner"
      >
        Showing <strong>{headerLabel}</strong>
        {rows !== undefined ? (
          <> — {outstandingCount} contract{outstandingCount === 1 ? "" : "s"}.</>
        ) : null}
      </p>

      {isLoading && (
        <div
          data-testid="contracts-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading contracts…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="contracts-empty"
        >
          <p className="text-sm text-slate-600">
            No contracts match this filter.
          </p>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-[#F6F2EA] text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8E8C85]">
              <tr>
                <th className="px-4 py-3">Contract</th>
                <th className="px-4 py-3">Lot</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr
                  key={r.contractId}
                  className="hover:bg-slate-50"
                  data-testid={`contracts-row-${r.contractId}`}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link
                      href={`/contracts/${r.contractId}`}
                      className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                    >
                      {r.contractNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{r.lotCode}</td>
                  <td className="px-4 py-3 text-slate-700">
                    {r.customerFullName}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-900">
                    {formatPeso(r.totalPriceCents)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={r.state} size="sm" />
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {formatDate(r.createdAt, "short")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
