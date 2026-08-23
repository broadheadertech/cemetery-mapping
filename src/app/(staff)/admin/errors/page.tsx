"use client";

/**
 * /admin/errors — server-side error log.
 *
 * The page that answers "did anything break overnight?" without
 * anyone having to open a terminal. Before this existed, a failed
 * cron or a rejected payment webhook left a line in `npx convex logs`
 * with short retention and no reader, and the cemetery found out when
 * a customer asked where their receipt was.
 *
 * Admin-only — middleware gates `/admin/*` and every function in
 * `convex/errorLog.ts` re-checks `requireRole(["admin"])` server-side
 * per NFR-S4.
 *
 * Rows are GROUPS, not occurrences: one row per distinct failure with
 * an occurrence count and a first/last-seen window. A cron failing
 * every ten minutes all weekend is one row at 288, which is what an
 * operator needs to see — not 288 rows burying everything else.
 *
 * Resolving a row is an acknowledgement, not a fix. If the same
 * failure happens again the row reopens by itself; see `captureError`.
 * That is deliberate — "I looked at this" and "it came back" are
 * different facts and the second one has to be visible.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
import { formatDate } from "@/lib/time";

interface ErrorGroupRow {
  id: string;
  source: string;
  severity: "error" | "warning";
  message: string;
  stack: string | null;
  context: unknown;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  isResolved: boolean;
  resolvedAt: number | null;
}

const listErrorGroupsRef = makeFunctionReference<
  "query",
  { includeResolved?: boolean; limit?: number },
  ErrorGroupRow[]
>("errorLog:listErrorGroups");

const resolveErrorRef = makeFunctionReference<
  "mutation",
  { errorLogId: string },
  { resolved: boolean }
>("errorLog:resolveError");

export default function AdminErrorsPage(): ReactElement {
  const [includeResolved, setIncludeResolved] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const groups = useQuery(listErrorGroupsRef, { includeResolved });
  const resolveError = useMutation(resolveErrorRef);

  const handleResolve = useCallback(
    async (id: string): Promise<void> => {
      setActionError(null);
      try {
        await resolveError({ errorLogId: id });
      } catch (err) {
        setActionError(translateError(err).detail);
      }
    },
    [resolveError],
  );

  const isLoading = groups === undefined;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Error log
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Failures recorded by the server — scheduled jobs, payment
          webhooks, document generation. Repeats of the same failure are
          grouped into one entry with a count. Marking an entry resolved is
          an acknowledgement; if it happens again the entry reopens on its
          own.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <input
          id="include-resolved"
          type="checkbox"
          checked={includeResolved}
          onChange={(e) => setIncludeResolved(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300"
        />
        <label htmlFor="include-resolved" className="text-sm text-slate-700">
          Show resolved entries
        </label>
      </div>

      {actionError !== null && (
        <div
          role="alert"
          data-testid="error-log-action-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {actionError}
        </div>
      )}

      {isLoading && (
        <div className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600">
          Loading…
        </div>
      )}

      {!isLoading && groups.length === 0 && (
        <div
          data-testid="error-log-empty"
          className="rounded-md border border-emerald-300 bg-emerald-50 p-5"
        >
          <h2 className="text-lg font-semibold text-emerald-900">All clear</h2>
          <p className="mt-1 text-sm text-emerald-900">
            {includeResolved
              ? "Nothing has been recorded."
              : "No unresolved errors. Tick “Show resolved entries” to review what has been handled."}
          </p>
        </div>
      )}

      {!isLoading && groups.length > 0 && (
        <ul className="space-y-3" data-testid="error-log-list">
          {groups.map((group) => (
            <ErrorGroupCard
              key={group.id}
              group={group}
              expanded={expanded === group.id}
              onToggle={() =>
                setExpanded((cur) => (cur === group.id ? null : group.id))
              }
              onResolve={() => void handleResolve(group.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ErrorGroupCard({
  group,
  expanded,
  onToggle,
  onResolve,
}: {
  group: ErrorGroupRow;
  expanded: boolean;
  onToggle: () => void;
  onResolve: () => void;
}): ReactElement {
  const isError = group.severity === "error";
  return (
    <li
      data-testid="error-log-row"
      className={`rounded-md border bg-white p-4 ${
        group.isResolved
          ? "border-slate-200 opacity-70"
          : isError
            ? "border-red-300"
            : "border-amber-300"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                isError
                  ? "bg-red-100 text-red-800"
                  : "bg-amber-100 text-amber-900"
              }`}
            >
              {isError ? "Error" : "Warning"}
            </span>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
              {group.source}
            </code>
            {group.count > 1 && (
              <span className="text-xs font-medium text-slate-600">
                ×{group.count}
              </span>
            )}
            {group.isResolved && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                Resolved
              </span>
            )}
          </div>

          <p className="mt-2 break-words text-sm text-slate-900">
            {group.message}
          </p>

          <p className="mt-1 text-xs text-slate-500">
            Last seen {formatDate(group.lastSeenAt, "datetime")}
            {group.count > 1 && (
              <> · first seen {formatDate(group.firstSeenAt, "datetime")}</>
            )}
          </p>
        </div>

        <div className="flex shrink-0 gap-2">
          {(group.stack !== null || group.context !== null) && (
            <button
              type="button"
              onClick={onToggle}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {expanded ? "Hide detail" : "Detail"}
            </button>
          )}
          {!group.isResolved && (
            <button
              type="button"
              onClick={onResolve}
              data-testid="error-log-resolve"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Mark resolved
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3">
          {group.context !== null && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Context
              </h3>
              <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-3 text-xs text-slate-700">
                {JSON.stringify(group.context, null, 2)}
              </pre>
            </div>
          )}
          {group.stack !== null && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Stack
              </h3>
              <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-3 text-xs text-slate-700">
                {group.stack}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
