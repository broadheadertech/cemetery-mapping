"use client";

/**
 * /interments/today — Field Worker's burial-day list (Story 7.4 AC1).
 *
 * Mobile-first single-column list of today's scheduled interments
 * (Manila tz). Each row carries enough context for Junior to walk
 * up to the right plot and tap "Mark complete" with a gloved hand:
 *   - Occupant name (large, bold)
 *   - Lot code + section/block/row (secondary)
 *   - Scheduled time (large, time-prominent)
 *   - "Mark complete" tap target (≥ 44px tall, full-width)
 *
 * The list is reactively bound to `listTodayForFieldWorker`; when an
 * interment completes, its row drops off this list (the server query
 * filters `status === "scheduled"`) and the office staff calendar
 * (Story 7.3) flips its color. No client-side refresh needed.
 *
 * Auth: the (staff) layout protects this route; per-role checks live
 * inside `listTodayForFieldWorker` (admin / office_staff /
 * field_worker). The route is accessible to all three but designed
 * for the field worker workflow.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface TodayRow {
  intermentId: string;
  scheduledAt: number;
  occupantId: string;
  occupantName: string;
  lotId: string;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  notes: string | undefined;
}

const listTodayRef = makeFunctionReference<
  "query",
  Record<string, never>,
  TodayRow[]
>("interments:listTodayForFieldWorker");

const TIME_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

const DATE_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "full",
  timeZone: "Asia/Manila",
});

export default function TodayIntermentsPage() {
  const rows = useQuery(listTodayRef, {});
  const today = useMemo(() => DATE_FORMATTER.format(new Date()), []);
  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  return (
    <div className="mx-auto max-w-xl space-y-4 px-4 pb-12 pt-2">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">
          Today’s interments
        </h1>
        <p className="text-sm text-slate-600">{today} (Manila)</p>
      </header>

      {isLoading && (
        <div
          className="rounded-md border border-slate-200 bg-white p-6 text-center text-sm text-slate-500"
          data-testid="today-loading"
        >
          Loading today’s interments…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="today-empty"
        >
          <p className="text-base font-medium text-slate-700">
            No interments scheduled for today.
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Check the calendar for upcoming days.
          </p>
          <Link
            href="/interments/calendar"
            className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            View calendar
          </Link>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <ul
          className="flex flex-col gap-3"
          data-testid="today-list"
          aria-label="Today's scheduled interments"
        >
          {rows.map((r) => (
            <li
              key={r.intermentId}
              className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              data-testid={`today-row-${r.intermentId}`}
            >
              <div className="space-y-1">
                <p className="text-lg font-semibold text-slate-900">
                  {r.occupantName}
                </p>
                <p className="text-sm text-slate-600">
                  Lot {r.lotCode}
                  {r.lotSection.length > 0 && (
                    <span className="text-slate-400">
                      {" "}
                      — {r.lotSection}/{r.lotBlock}/{r.lotRow}
                    </span>
                  )}
                </p>
                <p
                  className="text-base font-medium tabular-nums text-slate-900"
                  data-testid={`today-time-${r.intermentId}`}
                >
                  {TIME_FORMATTER.format(new Date(r.scheduledAt))}
                </p>
                {r.notes !== undefined && r.notes.trim().length > 0 && (
                  <p className="text-sm italic text-slate-600">{r.notes}</p>
                )}
              </div>
              <Link
                href={`/interments/${r.intermentId}/complete`}
                className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-md bg-[#1D5C4D] px-4 py-2 text-base font-medium text-white hover:bg-[#144437]"
                data-testid={`today-mark-complete-${r.intermentId}`}
              >
                Mark complete
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
