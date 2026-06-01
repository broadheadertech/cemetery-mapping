"use client";

/**
 * PlaqueDraftHistory — Story 6.8 draft-history rail.
 *
 * Renders every prior `plaqueDrafts` row for the current interment in
 * a vertical timeline. Each row carries:
 *   - `v{N}` badge + status badge (pending / ready / failed)
 *   - generator name + Manila-tz timestamp
 *   - "Download" affordance (when ready)
 *   - "Use as starting point" affordance (calls parent callback to
 *     prefill the form)
 *   - "Retry" affordance (admin-only; when failed)
 *
 * Parent-owned data: the parent component passes the `rows` from
 * `useQuery(api.plaqueDrafts.listForInterment)` along with the
 * download-URL fetcher and the optional admin retry callback. This
 * decoupling keeps the component testable without a Convex provider.
 */

import { useState } from "react";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

import type { PlaqueDraftHistoryRow } from "./types";

export interface PlaqueDraftHistoryProps {
  rows: PlaqueDraftHistoryRow[] | undefined;
  /**
   * Triggered when the operator clicks "Use as starting point" on a
   * historical row. The parent passes this back into PlaqueForm's
   * `initialValues` prop.
   */
  onUseAsStartingPoint: (row: PlaqueDraftHistoryRow) => void;
  /**
   * Triggered when the operator clicks "Download" on a `ready` row.
   * The parent's implementation fetches the signed URL via
   * `getPlaqueUrl` and opens it in a new tab.
   */
  onDownload: (plaqueDraftId: string) => Promise<void>;
  /**
   * When `true`, the "Retry" affordance surfaces on `failed` rows.
   * The parent gates this on the current user's admin role and wires
   * the actual mutation call.
   */
  isAdmin: boolean;
  /**
   * Triggered when the admin clicks "Retry" on a failed row.
   */
  onRetry?: (plaqueDraftId: string) => Promise<void>;
}

const MANILA_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

export function PlaqueDraftHistory({
  rows,
  onUseAsStartingPoint,
  onDownload,
  isAdmin,
  onRetry,
}: PlaqueDraftHistoryProps) {
  if (rows === undefined) {
    return (
      <div
        className="rounded-md border border-slate-200 bg-white p-4"
        data-testid="plaque-draft-history-loading"
      >
        <p className="text-sm text-slate-500">Loading draft history…</p>
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div
        className="rounded-md border border-slate-200 bg-slate-50 p-4"
        data-testid="plaque-draft-history-empty"
      >
        <p className="text-sm text-slate-600">
          No drafts yet. Generate the first plaque PDF on the left.
        </p>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="plaque-draft-history-heading"
      className="rounded-md border border-slate-200 bg-white p-4"
      data-testid="plaque-draft-history"
    >
      <h2
        id="plaque-draft-history-heading"
        className="mb-3 text-base font-semibold text-slate-900"
      >
        Draft history
      </h2>
      <ol className="space-y-3">
        {rows.map((row) => (
          <li
            key={row.plaqueDraftId}
            className="rounded-md border border-slate-100 p-3"
            data-testid={`plaque-draft-row-${row.plaqueDraftId}`}
          >
            <ReactiveHighlight watch={row.pdfStatus}>
              <DraftRow
                row={row}
                onUseAsStartingPoint={onUseAsStartingPoint}
                onDownload={onDownload}
                isAdmin={isAdmin}
                onRetry={onRetry}
              />
            </ReactiveHighlight>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DraftRow({
  row,
  onUseAsStartingPoint,
  onDownload,
  isAdmin,
  onRetry,
}: {
  row: PlaqueDraftHistoryRow;
  onUseAsStartingPoint: (row: PlaqueDraftHistoryRow) => void;
  onDownload: (plaqueDraftId: string) => Promise<void>;
  isAdmin: boolean;
  onRetry?: (plaqueDraftId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDownload(row.plaqueDraftId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetry() {
    if (busy || onRetry === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await onRetry(row.plaqueDraftId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-900">
          v{row.version}
        </span>
        <StatusBadge status={row.pdfStatus} />
        <span className="text-xs text-slate-500">
          {MANILA_FORMATTER.format(new Date(row.generatedAt))} ·{" "}
          {row.generatedByName}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-900" data-testid="plaque-draft-row-name">
        {row.deceasedName}
      </p>
      <p className="text-xs text-slate-500 font-mono">
        {row.bornYear} — {row.diedYear} · {row.dateFormat}
      </p>
      {row.epitaph !== undefined && row.epitaph.length > 0 && (
        <p className="mt-1 text-xs italic text-slate-700">
          &ldquo;{row.epitaph}&rdquo;
        </p>
      )}
      {row.lastError !== undefined && row.pdfStatus === "failed" && (
        <p className="mt-1 text-xs text-red-700">{row.lastError}</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.pdfStatus === "ready" && (
          <button
            type="button"
            onClick={handleDownload}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center rounded-md border border-emerald-800 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-50 disabled:opacity-50"
            data-testid="plaque-draft-row-download"
          >
            {busy ? "Opening…" : "Download"}
          </button>
        )}
        <button
          type="button"
          onClick={() => onUseAsStartingPoint(row)}
          className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          data-testid="plaque-draft-row-prefill"
        >
          Use as starting point
        </button>
        {row.pdfStatus === "failed" && isAdmin && onRetry !== undefined && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={busy}
            className="inline-flex min-h-[44px] items-center rounded-md border border-amber-500 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50"
            data-testid="plaque-draft-row-retry"
          >
            {busy ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "pending" | "ready" | "failed" }) {
  if (status === "pending") {
    return (
      <span
        role="status"
        aria-label="Status: generating"
        data-testid="plaque-draft-status-pending"
        className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900"
      >
        Generating…
      </span>
    );
  }
  if (status === "ready") {
    return (
      <span
        role="status"
        aria-label="Status: ready"
        data-testid="plaque-draft-status-ready"
        className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900"
      >
        Ready
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-label="Status: failed"
      data-testid="plaque-draft-status-failed"
      className="inline-flex items-center rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-900"
    >
      Failed
    </span>
  );
}
