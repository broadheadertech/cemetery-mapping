"use client";

/**
 * /lots — list view (Story 1.8).
 *
 * Reactive table of all non-retired lots, with status filter chips,
 * "New Lot" CTA, and per-row Edit / Retire actions. Story 1.12 adds a
 * Map toggle on this same page; the disabled-button slot is reserved
 * here so the DOM shape stays stable.
 *
 * Why client component:
 *   - `useQuery` is reactive; the table refreshes automatically when
 *     any mutation lands a new / updated row.
 *   - Filter chips are stateful (selected status) and don't merit a
 *     URL-based filter yet (Story 1.10 may add deep-linkable filters
 *     when the Cmd-K palette lands).
 */

import Link from "next/link";
import { useMemo, useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { StatusPill } from "@/components/ui/StatusPill";
import { StatePillTransition } from "@/components/ui/StatePillTransition";
import { LOT_STATUSES, type LotStatus } from "@/types/lot-status";
import { formatPeso } from "@/lib/money";
import { translateError } from "@/lib/errors";
// Story 1.13 — offline cache + write-block. ServiceWorkerBootstrap is
// rendered once on the staff entry page (this one) so the SW registers
// even though the layout file is owned by another story this sprint.
import { ServiceWorkerBootstrap } from "@/components/NetworkIndicator";
import { useNetworkAwareMutation } from "@/hooks/useNetworkAwareMutation";
import { useNetworkState } from "@/hooks/useNetworkState";

/**
 * Lot row shape returned by `api.lots.listLots`. Mirrored by hand
 * because `convex/_generated/api` is not yet built (architecture §
 * Project Structure — codegen runs interactively via `npx convex dev`).
 */
interface LotRow {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  basePriceCents: number;
  status: LotStatus;
  isRetired: boolean;
}

const listLotsRef = makeFunctionReference<
  "query",
  {
    includeRetired?: boolean;
    statusFilter?: LotStatus;
    sectionFilter?: string;
  },
  LotRow[]
>("lots:listLots");

const retireLotRef = makeFunctionReference<
  "mutation",
  { lotId: string },
  null
>("lots:retireLot");

export default function LotsListPage() {
  // Story 5.3: read the optional `?status=` deep-link from the URL on
  // first render so a dashboard drill-down (or a shared link) lands on
  // the correctly-filtered view. The URL is the source of truth on
  // first load; subsequent clicks on filter chips use local state for
  // responsiveness without polluting browser history.
  const searchParams = useSearchParams();
  const initialStatus = useMemo<LotStatus | null>(() => {
    const param = searchParams.get("status");
    if (param === null) return null;
    return (LOT_STATUSES as readonly string[]).includes(param)
      ? (param as LotStatus)
      : null;
  }, [searchParams]);
  const [statusFilter, setStatusFilter] = useState<LotStatus | null>(
    initialStatus,
  );
  // Re-sync when the URL changes (e.g. back-button after a drill-down).
  useEffect(() => {
    setStatusFilter(initialStatus);
  }, [initialStatus]);
  const [actionError, setActionError] = useState<string | null>(null);

  const queryArgs = useMemo(() => {
    if (statusFilter === null) return {};
    return { statusFilter };
  }, [statusFilter]);

  const lots = useQuery(listLotsRef, queryArgs);
  // Story 1.13: wrap with the network-aware mutation so retiring a lot
  // while offline throws OFFLINE_WRITE_BLOCKED instead of dispatching a
  // doomed request. The wrapper is API-compatible with `useMutation`.
  const retireLot = useNetworkAwareMutation(retireLotRef);
  const network = useNetworkState();

  const isLoading = lots === undefined;
  const isEmpty = lots !== undefined && lots.length === 0;

  const handleRetire = async (lotId: string, code: string): Promise<void> => {
    const ok = window.confirm(
      `Retire lot ${code}? Retired lots disappear from the list but stay in the audit history.`,
    );
    if (!ok) return;
    setActionError(null);
    try {
      await retireLot({ lotId });
    } catch (err) {
      const translated = translateError(err);
      setActionError(translated.detail);
    }
  };

  return (
    <div className="space-y-6">
      {/*
        Story 1.13 — service worker bootstrap. Registers the SW (no-op
        in dev) and renders the freshness pill + offline-state indicator
        portal. Mounted once per page-load; the SW is process-scoped so
        navigating away doesn't tear it down.
      */}
      <ServiceWorkerBootstrap />

      {network === "offline" && (
        <div
          role="status"
          data-testid="lots-offline-banner"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          You&apos;re offline — viewing cached data. Edits and retire actions
          are disabled until you reconnect.
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Lots</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled
            title="Map view ships in Story 1.12"
            aria-label="Map view (coming in Story 1.12)"
            className="rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-medium text-slate-400 cursor-not-allowed"
          >
            Map view
          </button>
          <Link
            href="/lots/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            New lot
          </Link>
        </div>
      </div>

      {/*
        Status filter chips — UX § Search & Filtering Patterns:
        chips select a filter dimension immediately; there is no
        "Apply" button. Click a selected chip again to clear.
      */}
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by status"
      >
        <button
          type="button"
          onClick={() => setStatusFilter(null)}
          aria-pressed={statusFilter === null}
          className={chipClass(statusFilter === null)}
        >
          All
        </button>
        {LOT_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            aria-pressed={statusFilter === s}
            className={chipClass(statusFilter === s)}
          >
            <StatusPill status={s} size="sm" showIcon={false} />
          </button>
        ))}
      </div>

      {actionError !== null && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {actionError}
        </div>
      )}

      {isLoading && (
        <div
          data-testid="lots-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading lots…
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            {statusFilter !== null
              ? "No lots match these filters."
              : "No lots yet. Create your first one to get started."}
          </p>
          {statusFilter !== null && (
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              className="mt-3 text-sm font-medium text-slate-900 underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {lots !== undefined && lots.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Section / Block / Row</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Base price</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lots.map((lot) => (
                <tr key={lot._id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link
                      href={`/lots/${lot._id}`}
                      className="hover:underline"
                    >
                      {lot.code}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {lot.section} / {lot.block} / {lot.row}
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-600">
                    {lot.type}
                  </td>
                  <td className="px-4 py-3">
                    {/* Story 5.9 — per-row status uses the
                     *   StatePillTransition wrapper so a cross-tab
                     *   status change (e.g. another office_staff
                     *   posting a sale) animates both the pill's 300ms
                     *   colour crossfade AND the 600ms amber surround
                     *   flash. The filter-chip pills above stay as
                     *   raw <StatusPill> — they reflect the user's
                     *   chip selection, not an entity state. */}
                    <StatePillTransition status={lot.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-slate-900">
                    {formatPeso(lot.basePriceCents)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-3 text-sm">
                      <Link
                        href={`/lots/${lot._id}/edit`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        Edit
                      </Link>
                      <button
                        type="button"
                        onClick={() => handleRetire(lot._id, lot.code)}
                        className="font-medium text-red-600 hover:underline"
                      >
                        Retire
                      </button>
                    </div>
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
    "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium",
    active
      ? "border-slate-900 bg-slate-900 text-white"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ].join(" ");
}
