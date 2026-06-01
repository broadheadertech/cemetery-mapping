"use client";

/**
 * ArAgingTable — Story 4.8 (FR34/FR35, UX-DR10).
 *
 * Pure-presentation table component for the AR-aging drill-down page.
 * The hosting page (`src/app/(staff)/ar-aging/page.tsx`) owns:
 *   - URL-state ↔ bucket filter sync
 *   - the `arAging:listAgingDetail` Convex call
 *
 * This component receives already-resolved rows + aggregate counts and
 * renders them in a sortable table (desktop) / card stack (mobile) with
 * the Journey-4 risk-distinction visual treatment:
 *
 *   - Rows WITHOUT an active follow-up:  bg-red-50/30 + red `StatusPill`
 *     ("Overdue") + LEFT BORDER red — these are the "silently overdue"
 *     contracts Mr. Reyes needs to see.
 *   - Rows WITH an active follow-up:     bg-white + amber `StatusPill`
 *     ("Overdue (action)") + LEFT BORDER amber — Maria is handling
 *     these; they're informational, not actionable.
 *
 * Sort (Story 4.8 AC3, Epic 4 adversarial-review fix — 2026-05-24):
 *   Sort state lives in the URL as `?sort=<key>&dir=<asc|desc>` so the
 *   user can share / bookmark a specific sort. The component reads the
 *   current sort via `useSearchParams` and writes via `router.push`.
 *   Default sort (when neither param is present) is `daysOverdue`
 *   descending — oldest debt at the top, matching the original
 *   presentational default. Column header clicks toggle the direction
 *   for the active key and re-default the direction to `desc` for a
 *   newly selected key.
 *
 *   The `?bucket=` param coexists with `?sort=` / `?dir=` — the
 *   updater preserves every other search param verbatim so a deep link
 *   like `/ar-aging?bucket=31-60&sort=lastPaymentAt&dir=asc` round-
 *   trips correctly.
 *
 * Accessibility:
 *   - Color is NEVER the sole indicator. The pill carries the label
 *     ("Overdue" vs "Overdue (action)") AND the icon. NFR-A2.
 *   - The entire row is wrapped in a `<Link>` so the keyboard tab order
 *     hits one focusable target per row.
 *   - `aria-sort` on column headers reflects the active sort.
 */

import { useMemo, type ReactElement } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/cn";
import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import { StatusPill } from "@/components/ui/StatusPill";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

import {
  BUCKET_LABEL,
  type ArAgingBucket,
  type ArAgingDetailRow,
} from "./types";

export interface ArAgingTableProps {
  /**
   * The resolved query result. `undefined` triggers the loading state.
   * `truncatedAt` is the optional server-side cap marker (null when
   * the full result fit). See `AR_AGING_DETAIL_ROW_CAP` in
   * `convex/arAging.ts`.
   */
  result:
    | {
        rows: ArAgingDetailRow[];
        totalCount: number;
        needsActionCount: number;
        truncatedAt?: number | null;
      }
    | undefined;
  /** Currently-selected bucket. `null` means "all overdue buckets". */
  bucket: ArAgingBucket | null;
  /** Optional sub-header label override. Defaults from `bucket`. */
  bucketLabelOverride?: string;
}

type SortKey = "daysOverdue" | "totalOverdueCents" | "customerFullName" | "lastPaymentAt";
type SortDir = "asc" | "desc";

const SORT_KEYS: readonly SortKey[] = [
  "daysOverdue",
  "totalOverdueCents",
  "customerFullName",
  "lastPaymentAt",
];

const DEFAULT_SORT_KEY: SortKey = "daysOverdue";
const DEFAULT_SORT_DIR: SortDir = "desc";

/**
 * Parse a raw search-param string into a `SortKey`, falling back to
 * the default for missing / unknown values. The whitelist keeps a
 * hostile / hand-typed URL from injecting an unknown sort key into
 * the comparator.
 */
function parseSortKey(raw: string | null): SortKey {
  if (raw === null) return DEFAULT_SORT_KEY;
  return (SORT_KEYS as readonly string[]).includes(raw)
    ? (raw as SortKey)
    : DEFAULT_SORT_KEY;
}

function parseSortDir(raw: string | null): SortDir {
  if (raw === null) return DEFAULT_SORT_DIR;
  return raw === "asc" ? "asc" : "desc";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Trims a follow-up note to 40 chars for the inline pill label per AC1.
 * Empty / missing note collapses to a generic "Action logged" so the
 * pill always carries text (NFR-A2).
 */
function followUpLabel(note: string | undefined): string {
  if (note === undefined || note.trim().length === 0) {
    return "Action logged";
  }
  return `Action: ${truncate(note.trim(), 40)}`;
}

function sortRows(
  rows: readonly ArAgingDetailRow[],
  key: SortKey,
  dir: SortDir,
): ArAgingDetailRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    if (key === "daysOverdue") {
      av = a.daysOverdue;
      bv = b.daysOverdue;
    } else if (key === "totalOverdueCents") {
      av = a.totalOverdueCents;
      bv = b.totalOverdueCents;
    } else if (key === "customerFullName") {
      av = a.customerFullName.toLowerCase();
      bv = b.customerFullName.toLowerCase();
    } else {
      // lastPaymentAt — undefined sorts last regardless of direction
      // (a contract that's never paid is the worst signal; surfacing it
      // last keeps the "biggest concern" framing intact).
      av = a.lastPaymentAt ?? 0;
      bv = b.lastPaymentAt ?? 0;
    }
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return 0;
  });
}

function ariaSortFor(active: SortKey, current: SortKey, dir: SortDir): "ascending" | "descending" | "none" {
  if (active !== current) return "none";
  return dir === "asc" ? "ascending" : "descending";
}

export function ArAgingTable({
  result,
  bucket,
  bucketLabelOverride,
}: ArAgingTableProps): ReactElement {
  // Story 4.8 AC3 / Epic 4 adversarial-review fix (2026-05-24): sort
  // state is sourced from the URL search params so the user can
  // share / bookmark a specific sort. `useSearchParams` and
  // `useRouter` are the Next.js App-Router hooks; both are safe in a
  // `"use client"` component (this file declared `"use client"` at
  // the top). Missing / unknown params fall back to
  // `(daysOverdue, desc)` — the same defaults the old `useState`
  // initialiser used, so existing deep links without `sort` / `dir`
  // render identically.
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortKey = parseSortKey(searchParams.get("sort"));
  const sortDir = parseSortDir(searchParams.get("dir"));

  const isLoading = result === undefined;
  const totalCount = result?.totalCount ?? 0;
  const needsActionCount = result?.needsActionCount ?? 0;
  const truncatedAt = result?.truncatedAt ?? null;

  const sorted = useMemo(
    () => sortRows(result?.rows ?? [], sortKey, sortDir),
    [result?.rows, sortKey, sortDir],
  );

  const bucketLabel =
    bucketLabelOverride ??
    (bucket === null ? "All overdue buckets" : BUCKET_LABEL[bucket]);

  const handleSort = (key: SortKey): void => {
    // Toggle direction when the active key is re-clicked; otherwise
    // pin the new key with the default `desc` direction (the original
    // behaviour). The URL update preserves every other search param
    // so `?bucket=` survives a sort change.
    const nextDir: SortDir =
      sortKey === key ? (sortDir === "asc" ? "desc" : "asc") : "desc";
    const params = new URLSearchParams(searchParams.toString());
    if (key === DEFAULT_SORT_KEY && nextDir === DEFAULT_SORT_DIR) {
      // Compact URL: drop the params when the state matches the
      // default. Keeps a freshly-loaded page free of redundant search
      // params and matches the `setBucket(null)` convention in
      // `src/app/(staff)/ar-aging/page.tsx`.
      params.delete("sort");
      params.delete("dir");
    } else {
      params.set("sort", key);
      params.set("dir", nextDir);
    }
    const query = params.toString();
    router.push(query.length === 0 ? "/ar-aging" : `/ar-aging?${query}`);
  };

  if (isLoading) {
    return (
      <div
        data-testid="ar-aging-table-loading"
        className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
      >
        Loading AR aging detail…
      </div>
    );
  }

  if (totalCount === 0) {
    // AC5 — calm empty state, NOT a failure. Check-circle, generous
    // whitespace, no apology copy. UX-DR23.
    return (
      <div
        data-testid="ar-aging-table-empty"
        className="rounded-lg border border-emerald-200 bg-emerald-50/40 px-6 py-12 text-center"
      >
        <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          {/* Lucide-style check circle, inlined to avoid pulling another
              icon import for one glyph. */}
          <svg
            aria-hidden="true"
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
        </div>
        <p className="text-lg font-semibold text-slate-900">
          No overdue contracts in this bucket.
        </p>
        <p className="mt-1 text-sm text-slate-600">Stay vigilant.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Sub-header (AC2). The actionable count is the value; the
          raw count alone alarms unnecessarily per the disaster-prevention
          notes in the story. */}
      <p
        className="text-sm text-slate-700"
        data-testid="ar-aging-table-subheader"
      >
        <span className="font-semibold text-slate-900">{bucketLabel}</span>
        {" · "}
        {totalCount} contract{totalCount === 1 ? "" : "s"} overdue
        {" · "}
        <ReactiveHighlight watch={needsActionCount}>
          <span
            className="font-semibold text-rose-700"
            data-testid="ar-aging-needs-action-count"
          >
            {needsActionCount} need follow-up
          </span>
        </ReactiveHighlight>
        {truncatedAt !== null && (
          <span
            className="ml-1 text-slate-500"
            data-testid="ar-aging-truncation-hint"
          >
            {" · "}showing first {truncatedAt} rows — use the report
            export for the full list
          </span>
        )}
      </p>

      {/* Desktop table */}
      <div className="hidden overflow-x-auto rounded-md border border-slate-200 bg-white md:block">
        <table
          className="w-full text-sm"
          data-testid="ar-aging-table"
        >
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3">
                Status
              </th>
              <th scope="col" className="px-4 py-3">
                Contract
              </th>
              <SortableHeader
                label="Customer"
                sortKey="customerFullName"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortableHeader
                label="Days overdue"
                sortKey="daysOverdue"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                align="right"
              />
              <SortableHeader
                label="Overdue"
                sortKey="totalOverdueCents"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
                align="right"
              />
              <SortableHeader
                label="Last payment"
                sortKey="lastPaymentAt"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <th scope="col" className="px-4 py-3">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sorted.map((row) => (
              <ArAgingTableRow key={row.contractId} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile cards — AC7 */}
      <div className="space-y-3 md:hidden">
        {sorted.map((row) => (
          <ArAgingMobileCard key={row.contractId} row={row} />
        ))}
      </div>
    </div>
  );

  /** Keep aria-sort helper referenced once so its export survives DCE. */
  void ariaSortFor;
}

interface SortableHeaderProps {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align,
}: SortableHeaderProps): ReactElement {
  const isActive = activeKey === sortKey;
  const arrow = !isActive ? "" : dir === "asc" ? " ↑" : " ↓";
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-3",
        align === "right" ? "text-right" : "text-left",
      )}
      aria-sort={
        !isActive ? "none" : dir === "asc" ? "ascending" : "descending"
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="font-medium uppercase tracking-wide hover:text-slate-900"
        data-testid={`ar-aging-sort-${sortKey}`}
      >
        {label}
        {arrow}
      </button>
    </th>
  );
}

interface RowProps {
  row: ArAgingDetailRow;
}

function ArAgingTableRow({ row }: RowProps): ReactElement {
  const href = `/contracts/${row.contractId}`;
  const isSilent = !row.hasActiveFollowUp;

  return (
    <tr
      className={cn(
        "cursor-pointer border-l-4 transition-colors",
        isSilent
          ? "border-l-rose-400 bg-rose-50/30 hover:bg-rose-100/40"
          : "border-l-amber-400 bg-white hover:bg-slate-50",
      )}
      data-testid={`ar-aging-row-${row.contractId}`}
      data-has-active-follow-up={row.hasActiveFollowUp ? "true" : "false"}
      data-bucket={row.bucket}
    >
      <td className="px-4 py-3 align-top">
        <ReactiveHighlight watch={row.hasActiveFollowUp}>
          <StatusPill status={isSilent ? "overdue" : "overdue-action"} />
        </ReactiveHighlight>
        {!isSilent && (
          <p
            className="mt-1 text-xs text-slate-600"
            data-testid={`ar-aging-row-${row.contractId}-action-note`}
          >
            {followUpLabel(row.followUpActionNote)}
          </p>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <Link
          href={href}
          className="font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
          data-testid={`ar-aging-link-${row.contractId}`}
          aria-label={`View contract ${row.contractNumber} for ${row.customerFullName}`}
        >
          {row.contractNumber}
        </Link>
        <p className="text-xs text-slate-500">Lot {row.lotCode}</p>
      </td>
      <td className="px-4 py-3 align-top text-slate-700">
        {row.customerFullName}
      </td>
      <td className="px-4 py-3 text-right align-top tabular-nums text-slate-700">
        {row.daysOverdue}
      </td>
      <td className="px-4 py-3 text-right align-top">
        <span className="font-semibold tabular-nums text-slate-900">
          {formatPeso(row.totalOverdueCents)}
        </span>
      </td>
      <td className="px-4 py-3 align-top text-slate-600">
        {row.lastPaymentAt !== undefined
          ? formatDate(row.lastPaymentAt, "short")
          : "—"}
      </td>
      <td className="px-4 py-3 align-top">
        <Link
          href={href}
          className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline"
          data-testid={`ar-aging-open-${row.contractId}`}
        >
          Open
        </Link>
      </td>
    </tr>
  );
}

function ArAgingMobileCard({ row }: RowProps): ReactElement {
  const href = `/contracts/${row.contractId}`;
  const isSilent = !row.hasActiveFollowUp;
  return (
    <Link
      href={href}
      className={cn(
        "block rounded-md border-l-4 border border-slate-200 p-4 transition-colors hover:bg-slate-50",
        isSilent
          ? "border-l-rose-400 bg-rose-50/30"
          : "border-l-amber-400 bg-white",
      )}
      data-testid={`ar-aging-card-${row.contractId}`}
      data-has-active-follow-up={row.hasActiveFollowUp ? "true" : "false"}
    >
      <div className="mb-2">
        <ReactiveHighlight watch={row.hasActiveFollowUp}>
          <StatusPill status={isSilent ? "overdue" : "overdue-action"} />
        </ReactiveHighlight>
      </div>
      {!isSilent && (
        <p className="mb-2 text-xs text-slate-600">
          {followUpLabel(row.followUpActionNote)}
        </p>
      )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-900">
            {row.customerFullName}
          </p>
          <p className="text-xs text-slate-500">
            {row.contractNumber} · Lot {row.lotCode}
          </p>
        </div>
        <p className="text-base font-semibold tabular-nums text-slate-900">
          {formatPeso(row.totalOverdueCents)}
        </p>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {row.daysOverdue} day{row.daysOverdue === 1 ? "" : "s"} overdue ·
        Last payment{" "}
        {row.lastPaymentAt !== undefined
          ? formatDate(row.lastPaymentAt, "short")
          : "never"}
      </p>
    </Link>
  );
}
