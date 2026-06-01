"use client";

/**
 * /sales — sales / contracts list view (Story 3.3).
 *
 * Surfaces the most recent contracts as a coordination view, with a
 * prominent "New sale" CTA that opens the Full Payment flow. The
 * underlying Convex query (`contracts:listContracts`) is reactive — a
 * sale recorded in another tab appears here immediately.
 *
 * Phase 1 simplification:
 *   - Single state filter chip group (mirrors the IntermentsListPage
 *     pattern from Story 7.1). Richer filters (date range, customer
 *     search) land in Story 3.6 when the contract detail page lands.
 *   - No pagination — capped at 100 rows server-side. At Phase 1 scale
 *     this is sufficient.
 *
 * Auth: layout-level (staff) gate + server-side `requireRole` on the
 * underlying query (admin / office_staff).
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import {
  formatDate,
  periodBoundsManila,
  type DashboardPeriod,
} from "@/lib/time";
import { StatusPill } from "@/components/ui/StatusPill";

type ContractState =
  | "active"
  | "paid_in_full"
  | "cancelled"
  | "voided"
  | "in_default";

type DrillPeriod = DashboardPeriod;

type LotType = "single" | "family" | "mausoleum" | "niche";

interface LotDoc {
  _id: string;
  code: string;
  section: string;
  type: LotType;
}

/**
 * Subset of fields on the lots table that the drill-down filters need.
 * We fetch the full list via `lots:listLots` (admin / office_staff
 * gated) and project to this shape on the client. Phase 1 cemetery
 * has ≤ 2,000 lots so an in-memory map is cheap.
 */
const listLotsRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  LotDoc[]
>("lots:listLots");

/**
 * Compute the period bounds for the dashboard drill-down filter
 * (Story 5.3 AC1, AC5). Routed through `periodBoundsManila` so the
 * boundary is anchored to Manila tz, not the operator's local system
 * tz (HIGH-D fix from the Epic 5 adversarial review — the prior
 * `new Date(now.getFullYear(), now.getMonth(), 1)` implementation
 * could mis-date a sale by a day on a workstation outside `+08:00`).
 *
 * The bounds are forwarded into `contracts:listContracts` via the
 * `fromMs` / `toMs` args added by HIGH-D — the query walks
 * `contracts.by_createdAt` server-side rather than loading a 100-row
 * window and filtering on the client.
 */
function periodBoundsMs(period: DrillPeriod | null): {
  startMs: number;
  endMs: number;
  label: string;
} | null {
  if (period !== "mtd" && period !== "ytd") return null;
  return periodBoundsManila(period);
}

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
  {
    stateFilter?: ContractState;
    fromMs?: number;
    toMs?: number;
    limit?: number;
  },
  ContractRow[]
>("contracts:listContracts");

const STATE_LABEL: Record<ContractState | "all", string> = {
  all: "All",
  active: "Active",
  paid_in_full: "Paid in full",
  cancelled: "Cancelled",
  voided: "Voided",
  in_default: "In default",
};

// HIGH-F (Story 5.9 sweep): the prior raw Tailwind STATE_CLASS map has
// been removed. The contract-state pill renders through `<StatusPill>`
// so every state — `active`, `paid_in_full`, `cancelled`, `voided`,
// `in_default` — pulls from the central status palette and icon set.

export default function SalesListPage() {
  const searchParams = useSearchParams();
  const periodParam = searchParams.get("period");
  const period: DrillPeriod | null =
    periodParam === "mtd" || periodParam === "ytd" ? periodParam : null;
  const bounds = useMemo(() => periodBoundsMs(period), [period]);

  // Story 6.3 drill-down URL params (FR45 / Story 6.3 AC3). The Sales
  // by dimension report links into this page with `from`, `to`,
  // `lotType`, `section`, `agentId` query-string filters. We honor:
  //   - `from` / `to` (epoch ms) as an explicit date-range window on
  //     `createdAt`. Composes with `period` — if both are present, the
  //     intersection wins.
  //   - `lotType` and `section` against the joined lot document (we
  //     fetch the full lots list once and project a lookup map).
  //   - `agentId` is reserved (§10 Q5 pending — `contracts.agentId`
  //     isn't on the schema yet); the value is read off the contract
  //     row dynamically. When agent tracking is disabled the filter
  //     reduces to a no-op.
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const lotTypeParam = searchParams.get("lotType");
  const sectionParam = searchParams.get("section");
  const agentIdParam = searchParams.get("agentId");
  const fromMs = useMemo(() => {
    const n = fromParam !== null ? Number(fromParam) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }, [fromParam]);
  const toMs = useMemo(() => {
    const n = toParam !== null ? Number(toParam) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  }, [toParam]);
  const lotTypeFilter: LotType | null =
    lotTypeParam === "single" ||
    lotTypeParam === "family" ||
    lotTypeParam === "mausoleum" ||
    lotTypeParam === "niche"
      ? lotTypeParam
      : null;
  const sectionFilter =
    sectionParam !== null && sectionParam.length > 0 ? sectionParam : null;
  const agentIdFilter =
    agentIdParam !== null && agentIdParam.length > 0 ? agentIdParam : null;

  const [filter, setFilter] = useState<ContractState | "all">("all");

  // Resolve the effective `createdAt` window we hand to the query.
  // Precedence: explicit drill-down `from` / `to` URL params win over
  // the period filter (Story 6.3 drill-down). If both are present, the
  // intersection wins via `max` / `min`.
  const effectiveFromMs = useMemo(() => {
    const candidates: number[] = [];
    if (bounds !== null) candidates.push(bounds.startMs);
    if (fromMs !== null) candidates.push(fromMs);
    return candidates.length === 0 ? null : Math.max(...candidates);
  }, [bounds, fromMs]);
  const effectiveToMs = useMemo(() => {
    const candidates: number[] = [];
    if (bounds !== null) candidates.push(bounds.endMs);
    if (toMs !== null) candidates.push(toMs);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }, [bounds, toMs]);

  const queryArgs = useMemo<{
    stateFilter?: ContractState;
    fromMs?: number;
    toMs?: number;
    limit?: number;
  }>(() => {
    const base: {
      stateFilter?: ContractState;
      fromMs?: number;
      toMs?: number;
      limit?: number;
    } = { limit: 100 };
    if (filter !== "all") base.stateFilter = filter;
    if (effectiveFromMs !== null) base.fromMs = effectiveFromMs;
    if (effectiveToMs !== null) base.toMs = effectiveToMs;
    return base;
  }, [filter, effectiveFromMs, effectiveToMs]);

  const allRows = useQuery(listContractsRef, queryArgs);
  // Fetch the lot list once so we can project lotType + section per
  // contract row. The query is gated for admin / office_staff (same
  // as `listContracts`) so reaching this page already implies access.
  const lots = useQuery(
    listLotsRef,
    lotTypeFilter !== null || sectionFilter !== null
      ? { includeRetired: true }
      : "skip",
  );
  const lotsById = useMemo(() => {
    if (lots === undefined) return null;
    const map = new Map<string, LotDoc>();
    for (const lot of lots) map.set(lot._id, lot);
    return map;
  }, [lots]);

  // Period + explicit-range filtering happens server-side now via the
  // `fromMs` / `toMs` args added by HIGH-D (Epic 5 review). What
  // remains in-memory: the `lotType` / `section` / `agentId` joins.
  // `lotType` and `section` need the lot doc — Convex doesn't support
  // index joins, so we project from a pre-fetched lot map. `agentId`
  // is reserved (§10 Q5 pending) and reduces to a no-op when the
  // schema field is absent.
  const rows = useMemo(() => {
    if (allRows === undefined) return undefined;
    let out = allRows;
    if (
      (lotTypeFilter !== null || sectionFilter !== null) &&
      lotsById !== null
    ) {
      out = out.filter((r) => {
        const lot = lotsById.get(r.lotId);
        if (lot === undefined) return false;
        if (lotTypeFilter !== null && lot.type !== lotTypeFilter) return false;
        if (sectionFilter !== null && lot.section !== sectionFilter)
          return false;
        return true;
      });
    } else if (
      (lotTypeFilter !== null || sectionFilter !== null) &&
      lotsById === null
    ) {
      // Lots haven't loaded yet — defer rendering rather than show a
      // misleading "no results" empty state.
      return undefined;
    }
    if (agentIdFilter !== null) {
      out = out.filter(
        (r) =>
          (r as unknown as Record<string, unknown>).agentId === agentIdFilter,
      );
    }
    return out;
  }, [allRows, lotTypeFilter, sectionFilter, agentIdFilter, lotsById]);
  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  const drillDownActive =
    fromMs !== null ||
    toMs !== null ||
    lotTypeFilter !== null ||
    sectionFilter !== null ||
    agentIdFilter !== null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">
          {bounds !== null ? `Sales — ${bounds.label}` : "Sales"}
        </h1>
        <Link
          href="/sales/new"
          data-testid="sales-new-cta"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          New sale
        </Link>
      </div>

      <p className="text-sm text-slate-600" data-testid="sales-period-banner">
        {bounds !== null
          ? `Filtered to contracts created in the current ${period === "ytd" ? "year" : "month"}. The list updates live as sales are posted from other tabs.`
          : "Every contract the cemetery has recorded. The list updates live as sales are posted from other tabs."}
      </p>

      {drillDownActive && (
        <div
          className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900"
          data-testid="sales-drilldown-banner"
        >
          Drill-down filter active:
          {fromMs !== null && (
            <span data-testid="sales-drill-from"> from {fromMs}</span>
          )}
          {toMs !== null && (
            <span data-testid="sales-drill-to"> · to {toMs}</span>
          )}
          {lotTypeFilter !== null && (
            <span data-testid="sales-drill-lotType">
              {" "}
              · lot type <strong>{lotTypeFilter}</strong>
            </span>
          )}
          {sectionFilter !== null && (
            <span data-testid="sales-drill-section">
              {" "}
              · section <strong>{sectionFilter}</strong>
            </span>
          )}
          {agentIdFilter !== null && (
            <span data-testid="sales-drill-agent">
              {" "}
              · agent <strong>{agentIdFilter}</strong>
            </span>
          )}
          <span className="ml-2">
            (
            <Link
              href="/sales"
              className="underline hover:no-underline"
              data-testid="sales-drilldown-clear"
            >
              clear
            </Link>
            )
          </span>
        </div>
      )}

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by state"
      >
        {(
          ["all", "active", "paid_in_full", "cancelled", "in_default", "voided"] as const
        ).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            aria-pressed={filter === s}
            data-testid={`sales-filter-${s}`}
            className={chipClass(filter === s)}
          >
            {STATE_LABEL[s]}
          </button>
        ))}
      </div>

      {isLoading && (
        <div
          data-testid="sales-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading contracts…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="sales-empty"
        >
          {bounds !== null ? (
            <p className="text-sm text-slate-600">
              No sales in this {period === "ytd" ? "year" : "month"}.
            </p>
          ) : (
            <p className="text-sm text-slate-600">
              No contracts to show. Use <strong>New sale</strong> to record the
              first one.
            </p>
          )}
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
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
                <tr key={r.contractId} className="hover:bg-slate-50">
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
                    <span data-testid={`sales-state-${r.contractId}`}>
                      <StatusPill status={r.state} size="sm" />
                    </span>
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

function chipClass(active: boolean): string {
  return [
    "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium",
    active
      ? "border-slate-900 bg-slate-900 text-white"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ].join(" ");
}
