"use client";

/**
 * AuditLogTable — admin audit-log browser (Story 6.5, FR47).
 *
 * Pure presentation component. The hosting page
 * (`src/app/(staff)/admin/audit-log/page.tsx`) owns:
 *   - URL-state ↔ filter args sync
 *   - Convex `listRecent / listByEntity / listByActor` calls
 *   - cursor-based pagination state
 *
 * This component receives the resolved rows + filter chips and renders
 * them in a static table. The PII columns (`before` / `after` JSON
 * blobs) are displayed already-redacted — redaction happened at WRITE
 * time inside `emitAudit` (Story 1.6). We never re-redact on read; if
 * a redacted value reaches this component unredacted, that's a Story
 * 1.6 bug, not this one.
 *
 * Entity-id clickthrough:
 *   The `entityId` cell is rendered as a clickable link that routes
 *   to the entity's detail page when one exists in Phase 1 — `lot`,
 *   `customer`, `contract` today. Entity types without a Phase-1
 *   detail page (`payment`, `receipt`, `expense`, `ownership`,
 *   `piiAccess`) fall back to a plain string with a tooltip
 *   explaining the missing destination. The lookup is encoded in
 *   `entityDetailHref` below; adding a destination is a one-line
 *   change.
 */

import { useMemo, type ReactElement } from "react";
import Link from "next/link";

import type {
  AuditEntityType,
  AuditLogFilterChip,
  AuditLogRow,
} from "./types";

export interface AuditLogTableProps {
  rows: AuditLogRow[];
  /** When `true`, render the skeleton/loading rendering instead of empty. */
  isLoading: boolean;
  /** Whether the current page is the last page. */
  isDone: boolean;
  /** Active filter chips. */
  filterChips: AuditLogFilterChip[];
  /** Called when a chip is dismissed (the parent updates URL + filters). */
  onRemoveFilter: (key: string) => void;
  /** Called when the user wants to go to the next page. */
  onNextPage: () => void;
  /** True iff a previous page exists (i.e. a non-empty cursor stack). */
  hasPrevPage: boolean;
  /** Called when the user wants to go back one page. */
  onPrevPage: () => void;
  /** Optional click handler — parent uses this for telemetry. */
  onRowClick?: (row: AuditLogRow) => void;
}

/**
 * Maps each entity type to its Phase-1 detail-page route. Entity
 * types absent from the map (e.g. `payment`, `receipt`) intentionally
 * render as plain text — their detail pages do not exist in Phase 1
 * yet. The fallback is graceful: the id is still copyable; the cell
 * just isn't a hyperlink.
 *
 * The route conventions mirror what `src/components/Sidebar/nav-items.ts`
 * and the existing detail pages use.
 */
const ENTITY_DETAIL_HREFS: Partial<Record<AuditEntityType, (id: string) => string>> = {
  lot: (id) => `/lots/${id}`,
  customer: (id) => `/customers/${id}`,
  contract: (id) => `/contracts/${id}`,
};

const ENTITY_TYPE_LABELS: Record<AuditEntityType, string> = {
  lot: "Lot",
  customer: "Customer",
  contract: "Contract",
  payment: "Payment",
  receipt: "Receipt",
  user: "User",
  expense: "Expense",
  ownership: "Ownership",
  piiAccess: "PII Access",
};

/**
 * Formats an epoch-ms timestamp for the timestamp column. Uses
 * en-PH locale + Asia/Manila per the architecture's timezone rule.
 * We don't import `formatDate` from `src/lib/time.ts` because the
 * existing helper only ships a `"short"` (date-only) variant; the
 * audit log needs both date and time, so we format inline. Adding a
 * `"datetime"` variant to `time.ts` would broaden a Story 2.1 helper;
 * keeping the formatter local keeps the blast radius narrow.
 */
function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Pretty-prints the `before` / `after` JSON blob into a compact
 * inline preview suitable for a table cell. We deliberately bound the
 * length — Convex JSON can be hundreds of lines for a payment
 * allocation row, and the table cell is the wrong place for that.
 * Full details belong in a dedicated detail view (deferred to a
 * future story per the brief's read-only scope).
 */
function summarizeJsonBlob(value: unknown): string {
  if (value === undefined || value === null) return "—";
  try {
    const text = JSON.stringify(value);
    if (text.length <= 80) return text;
    return `${text.slice(0, 77)}…`;
  } catch {
    return "[unserializable]";
  }
}

export function AuditLogTable({
  rows,
  isLoading,
  isDone,
  filterChips,
  onRemoveFilter,
  onNextPage,
  hasPrevPage,
  onPrevPage,
  onRowClick,
}: AuditLogTableProps): ReactElement {
  const isEmpty = !isLoading && rows.length === 0;

  return (
    <div className="space-y-4">
      {filterChips.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="audit-log-filter-chips"
        >
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => onRemoveFilter(chip.key)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-300 bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200"
              aria-label={`Remove filter ${chip.label}`}
            >
              <span>{chip.label}</span>
              <span aria-hidden="true" className="text-slate-500">
                ×
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm" data-testid="audit-log-table">
          <thead className="bg-[#F6F2EA] text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8E8C85]">
            <tr>
              <th scope="col" className="px-4 py-3">
                Timestamp
              </th>
              <th scope="col" className="px-4 py-3">
                Actor
              </th>
              <th scope="col" className="px-4 py-3">
                Action
              </th>
              <th scope="col" className="px-4 py-3">
                Entity type
              </th>
              <th scope="col" className="px-4 py-3">
                Entity id
              </th>
              <th scope="col" className="px-4 py-3">
                Reason
              </th>
              <th scope="col" className="px-4 py-3">
                Details
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading && (
              <tr data-testid="audit-log-loading">
                <td
                  colSpan={7}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  Loading audit entries…
                </td>
              </tr>
            )}
            {isEmpty && (
              <tr data-testid="audit-log-empty">
                <td
                  colSpan={7}
                  className="px-4 py-6 text-center text-sm text-slate-500"
                >
                  No audit entries match these filters.
                </td>
              </tr>
            )}
            {!isLoading &&
              rows.map((row) => (
                <AuditLogRowView
                  key={row._id}
                  row={row}
                  onRowClick={onRowClick}
                />
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">
          {rows.length === 0
            ? null
            : `Showing ${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrevPage}
            disabled={!hasPrevPage}
            data-testid="audit-log-prev"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={onNextPage}
            disabled={isDone || isLoading}
            data-testid="audit-log-next"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function AuditLogRowView({
  row,
  onRowClick,
}: {
  row: AuditLogRow;
  onRowClick?: (row: AuditLogRow) => void;
}): ReactElement {
  const detailHrefBuilder = ENTITY_DETAIL_HREFS[row.entityType];
  const detailHref =
    detailHrefBuilder !== undefined ? detailHrefBuilder(row.entityId) : null;
  const beforeText = useMemo(() => summarizeJsonBlob(row.before), [row.before]);
  const afterText = useMemo(() => summarizeJsonBlob(row.after), [row.after]);
  const handleRowClick = (): void => {
    if (onRowClick !== undefined) onRowClick(row);
  };

  return (
    <tr
      className="hover:bg-slate-50"
      data-testid="audit-log-row"
      data-action={row.action}
      data-entity-type={row.entityType}
      data-entity-id={row.entityId}
      onClick={handleRowClick}
    >
      <td className="px-4 py-3 align-top font-mono text-xs text-slate-700">
        {formatTimestamp(row.timestamp)}
      </td>
      <td className="px-4 py-3 align-top text-slate-700">
        {row.actorName ?? (
          <span className="text-slate-400">(unknown user)</span>
        )}
      </td>
      <td className="px-4 py-3 align-top text-slate-700">{row.action}</td>
      <td className="px-4 py-3 align-top text-slate-700">
        {ENTITY_TYPE_LABELS[row.entityType]}
      </td>
      <td className="px-4 py-3 align-top">
        {detailHref !== null ? (
          <Link
            href={detailHref}
            className="font-mono text-xs text-blue-700 hover:underline"
            data-testid="audit-log-entity-link"
            onClick={(e) => e.stopPropagation()}
          >
            {row.entityId}
          </Link>
        ) : (
          <span
            className="font-mono text-xs text-slate-500"
            title="No detail page for this entity type in Phase 1"
          >
            {row.entityId}
          </span>
        )}
      </td>
      <td className="px-4 py-3 align-top text-slate-600">
        {row.reason !== undefined && row.reason.length > 0 ? (
          row.reason
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <div className="space-y-1 font-mono text-xs text-slate-600">
          {row.before !== undefined && (
            <div data-testid="audit-log-before">
              <span className="font-sans uppercase tracking-wide text-[10px] text-slate-400">
                Before
              </span>{" "}
              {beforeText}
            </div>
          )}
          {row.after !== undefined && (
            <div data-testid="audit-log-after">
              <span className="font-sans uppercase tracking-wide text-[10px] text-slate-400">
                After
              </span>{" "}
              {afterText}
            </div>
          )}
          {row.before === undefined && row.after === undefined && (
            <span className="text-slate-400">—</span>
          )}
        </div>
      </td>
    </tr>
  );
}

export type { AuditEntityType, AuditLogFilterChip, AuditLogRow } from "./types";
