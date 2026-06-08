"use client";

/**
 * /lots/[lotId]/conditions — Story 1.14.
 *
 * Field-worker entry point for "log a lot's current condition with a
 * note + photo + timestamp." Also the read view for Office Staff who
 * wants to see the operational chatter on a single lot.
 *
 * Why a dedicated route (not just a Sheet on the detail page):
 *   - Story 1.11 owns `src/app/(staff)/lots/[lotId]/page.tsx`. That
 *     story isn't done yet, and Story 1.14 must not modify the
 *     placeholder it left. A dedicated route gives Junior a working
 *     URL — `/lots/<id>/conditions` — that he can bookmark or hit
 *     from the Cmd-K palette (Story 1.10).
 *   - When Story 1.11 lands the full detail page, that page can
 *     EITHER link here OR inline the same primitives (the
 *     `LogConditionForm` + the reactive list below). The mutation /
 *     query surface is the same.
 *
 * Reactive cross-role behaviour (AC3):
 *   - `useQuery(listLotConditionLogs, { lotId })` subscribes to the
 *     server's reactive query. When Junior submits from his phone,
 *     Maria's open browser tab on this same lot receives the new
 *     entry without a refresh.
 *   - `<ReactiveHighlight watch={log._creationTime}>` wraps each row.
 *     The first render does NOT flash; subsequent value changes (new
 *     row arriving, or its creation timestamp differing) do.
 *
 * Offline-write blocking (AC4):
 *   - `useOnlineStatus` reports `navigator.onLine`. The form's
 *     submit button stays disabled while offline; an inline note
 *     replaces the "post" CTA. We DO NOT queue offline writes —
 *     architecture invariant from Story 1.13.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import {
  LogConditionForm,
  type LogConditionSubmitPayload,
} from "@/components/LogConditionForm";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import type { ListedLotConditionLog } from "@/types/lot-condition-log";

interface LotDoc {
  _id: string;
  code: string;
  isRetired: boolean;
}

const getLotRef = makeFunctionReference<
  "query",
  { lotId: string },
  LotDoc | null
>("lots:getLot");

const listLotConditionLogsRef = makeFunctionReference<
  "query",
  { lotId: string; limit?: number },
  ListedLotConditionLog[]
>("conditionLogs:listLotConditionLogs");

const logLotConditionRef = makeFunctionReference<
  "mutation",
  {
    lotId: string;
    note: string;
    photoStorageId?: string;
    idempotencyKey: string;
  },
  string
>("conditionLogs:logLotCondition");

const generateUploadUrlRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  string
>("conditionLogs:generateLotConditionPhotoUploadUrl");

export default function LotConditionsPage() {
  const params = useParams<{ lotId: string }>();
  const lotId = params.lotId;
  const isOnline = useOnlineStatus();

  const lot = useQuery(getLotRef, { lotId });
  const logs = useQuery(listLotConditionLogsRef, { lotId, limit: 10 });
  const logLotCondition = useMutation(logLotConditionRef);
  const generateUploadUrl = useMutation(generateUploadUrlRef);

  const heading =
    lot === undefined
      ? "Loading…"
      : lot === null
        ? "Lot not found"
        : `Condition log — ${lot.code}`;

  async function handleSubmit(payload: LogConditionSubmitPayload) {
    const args: {
      lotId: string;
      note: string;
      photoStorageId?: string;
      idempotencyKey: string;
    } = {
      lotId,
      note: payload.note,
      idempotencyKey: payload.idempotencyKey,
    };
    if (payload.photoStorageId !== undefined) {
      args.photoStorageId = payload.photoStorageId;
    }
    await logLotCondition(args);
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-4xl font-semibold tracking-tight">{heading}</h1>
        {lot !== undefined && lot !== null && (
          <Link
            href={`/lots/${lot._id}`}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to lot
          </Link>
        )}
      </div>

      {lot === undefined && (
        <p className="text-sm text-slate-500">Loading lot…</p>
      )}
      {lot === null && (
        <p className="text-sm text-slate-600">
          That lot does not exist or has been deleted.
        </p>
      )}

      {lot !== undefined && lot !== null && (
        <>
          {lot.isRetired ? (
            <div
              role="status"
              className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              This lot has been retired. New condition logs cannot be posted.
            </div>
          ) : (
            <section
              aria-labelledby="post-heading"
              className="rounded-md border border-slate-200 bg-white p-5"
            >
              <h2
                id="post-heading"
                className="mb-3 text-base font-semibold text-slate-900"
              >
                Post an observation
              </h2>
              <LogConditionForm
                isOnline={isOnline}
                generateUploadUrl={generateUploadUrl}
                onSubmit={handleSubmit}
              />
            </section>
          )}

          <section
            aria-labelledby="log-heading"
            className="rounded-md border border-slate-200 bg-white p-5"
          >
            <h2
              id="log-heading"
              className="mb-3 text-base font-semibold text-slate-900"
            >
              Recent observations
            </h2>
            <ConditionLogList logs={logs} />
          </section>
        </>
      )}
    </div>
  );
}

function ConditionLogList({
  logs,
}: {
  logs: ListedLotConditionLog[] | undefined;
}) {
  if (logs === undefined) {
    return <p className="text-sm text-slate-500">Loading observations…</p>;
  }
  if (logs.length === 0) {
    return (
      <p className="text-sm text-slate-600" data-testid="condition-log-empty">
        No condition logs yet. Field workers can post the first one from this
        lot&apos;s detail page.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-slate-100" data-testid="condition-log-list">
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
      <p className="whitespace-pre-line text-sm text-slate-900">{log.note}</p>
      {log.photoStorageId !== undefined && (
        <p className="text-xs text-slate-500">Photo attached</p>
      )}
    </div>
  );
}

/**
 * Tiny relative-time formatter (minutes / hours / days). Avoids a
 * third-party date-fns dependency for one helper. Anchored on the
 * caller's local clock; the timestamps coming back from the server
 * are absolute epoch ms so this is safe.
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
