"use client";

/**
 * ConditionLogsPanel — Story 1.11 (AC1g).
 *
 * Renders the last few `lotConditionLogs` entries for a given lot via
 * the reactive `conditionLogs:listLotConditionLogs` query (Story 1.14).
 *
 * The Convex query is reactive: when Junior posts a new observation
 * from his phone, Maria's open detail page receives the new row and
 * `<ReactiveHighlight>` flashes the entry amber for 600ms (UX-DR25).
 * The first render never flashes — Story 1.4's component handles that
 * invariant.
 *
 * Why the panel queries on its own (rather than receiving an
 * already-fetched array): the parent detail page composes the panels
 * but keeps each one independently subscribed so a new condition log
 * does not trigger a re-render of the lot facts panel above. Avoids
 * cascading flashes on unrelated sections.
 */

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import type { ListedLotConditionLog } from "@/types/lot-condition-log";

const DEFAULT_LIMIT = 5;

const listLotConditionLogsRef = makeFunctionReference<
  "query",
  { lotId: string; limit?: number },
  ListedLotConditionLog[]
>("conditionLogs:listLotConditionLogs");

export interface ConditionLogsPanelProps {
  lotId: string;
  /** Maximum number of rows shown. Defaults to 5 (per AC1g). */
  limit?: number;
}

export function ConditionLogsPanel({
  lotId,
  limit = DEFAULT_LIMIT,
}: ConditionLogsPanelProps) {
  const logs = useQuery(listLotConditionLogsRef, { lotId, limit });

  return (
    <section
      aria-labelledby="conditions-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2
          id="conditions-heading"
          className="text-base font-semibold text-slate-900"
        >
          Recent condition logs
        </h2>
        <Link
          href={`/lots/${lotId}/conditions`}
          className="text-sm font-medium text-slate-700 hover:underline"
        >
          View all condition logs
        </Link>
      </div>
      <ConditionLogList logs={logs} />
    </section>
  );
}

function ConditionLogList({
  logs,
}: {
  logs: ListedLotConditionLog[] | undefined;
}) {
  if (logs === undefined) {
    return (
      <p
        className="text-sm text-slate-500"
        data-testid="conditions-loading"
      >
        Loading observations…
      </p>
    );
  }
  if (logs.length === 0) {
    return (
      <p
        className="text-sm text-slate-600"
        data-testid="conditions-empty"
      >
        No condition reports yet.
      </p>
    );
  }
  return (
    <ul
      className="divide-y divide-slate-100"
      data-testid="conditions-list"
    >
      {logs.map((log) => (
        <li key={log._id} className="py-3">
          <ReactiveHighlight
            watch={log._creationTime}
            className="block w-full"
          >
            <ConditionLogRow log={log} />
          </ReactiveHighlight>
        </li>
      ))}
    </ul>
  );
}

function ConditionLogRow({ log }: { log: ListedLotConditionLog }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-700">
          {log.loggedByName ?? "Field worker"}
        </span>
        <time
          dateTime={new Date(log.loggedAt).toISOString()}
          className="tabular-nums"
        >
          {formatRelative(log.loggedAt)}
        </time>
      </div>
      <p className="whitespace-pre-line text-sm text-slate-900">
        {log.note}
      </p>
      {log.photoStorageId !== undefined && (
        <p className="text-xs text-slate-500">Photo attached</p>
      )}
    </div>
  );
}

/**
 * Minimal relative-time formatter (just-now / minutes / hours / days).
 * Mirrors the helper in `(staff)/lots/[lotId]/conditions/page.tsx`;
 * duplication is deliberate — Story 1.11 must not modify Story 1.14's
 * page, and centralising the helper is a follow-up.
 */
function formatRelative(epochMs: number): string {
  const deltaMs = Date.now() - epochMs;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
