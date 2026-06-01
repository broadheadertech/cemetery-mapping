"use client";

/**
 * IntermentCalendar — Story 7.3.
 *
 * Month-view grid that renders interments grouped by Manila-tz day.
 * The component is presentational: the parent owns the Convex query
 * (`api.interments.listInRange`) and passes resolved events down.
 * This shape mirrors `IntermentForm` / `OccupantForm` and keeps the
 * grid easy to unit-test without mocking Convex.
 *
 * Dev brief deliberately scopes Story 7.3 to the minimum bar — a
 * month-view grid with day-cell click-through to a drill-in modal
 * listing that day's interments. The richer FullCalendar +
 * filter-bar surface called out in the story file is a Phase 2
 * follow-up.
 *
 * Key design choices:
 *   - All date arithmetic anchors on Manila wall-clock via
 *     `manilaCalendar.ts` helpers — never the browser's local tz.
 *   - The grid is 6×7 (or 5×7) cells; each cell shows the day of the
 *     month and (if events exist) a count badge + up to 3 occupant
 *     names truncated. "+N more" indicator when overflowed.
 *   - Clicking a populated day cell opens a `<Sheet>` listing that
 *     day's interments; each list entry links to `/lots/{lotId}`.
 *     This is the drill-in path called out in the dev brief.
 *   - Cancelled rows are filtered out upstream (the `listInRange`
 *     query default) — defense in depth: we still drop them here in
 *     case a future caller passes `includeCancelled: true`.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import {
  addDays,
  manilaMonthBoundsMs,
  manilaYmd,
  sameYmd,
  ymdKey,
  type ManilaYmd,
} from "./manilaCalendar";

/** Event shape consumed by the calendar — flat / pre-joined by the
 *  Convex `listInRange` projector. Matches the `CalendarInterment`
 *  server type but uses the wire-friendly string id form so the
 *  component is portable across mock fixtures and real Convex calls. */
export interface IntermentCalendarEvent {
  intermentId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: string;
  occupantName: string;
  lotId: string;
  lotCode: string;
  lotSection: string;
}

export interface IntermentCalendarProps {
  /** Calendar focus — defaults to "this month in Manila". */
  year: number;
  month: number; // 1..12
  /** Events for the visible grid range. Parent fetches via
   *  `useQuery(api.interments.listInRange, { fromMs, toMs })`. May be
   *  `undefined` while the query is in flight (renders a skeleton). */
  events: ReadonlyArray<IntermentCalendarEvent> | undefined;
  /** Click handler for the prev-month chevron. Parent owns the
   *  navigation state so URL sync stays a parent concern. */
  onPrevMonth?: () => void;
  /** Click handler for the next-month chevron. */
  onNextMonth?: () => void;
  /** Click handler for the "Today" button. */
  onToday?: () => void;
  /** Override the "today" reference for testing — defaults to
   *  `Date.now()`. */
  todayMs?: number;
}

/** Cap on events rendered inline per day cell — beyond this we render
 *  a "+N more" indicator. The drill-in Sheet always shows all rows. */
const INLINE_EVENT_LIMIT = 3;

const TIME_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeStyle: "short",
  timeZone: "Asia/Manila",
});
const FULL_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "long",
  timeZone: "Asia/Manila",
});

const STATUS_LABEL: Record<IntermentCalendarEvent["status"], string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_DOT: Record<IntermentCalendarEvent["status"], string> = {
  scheduled: "bg-blue-500",
  completed: "bg-emerald-500",
  cancelled: "bg-slate-300",
};

const WEEKDAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function IntermentCalendar({
  year,
  month,
  events,
  onPrevMonth,
  onNextMonth,
  onToday,
  todayMs,
}: IntermentCalendarProps) {
  const bounds = useMemo(() => manilaMonthBoundsMs(year, month), [year, month]);
  const todayYmd = useMemo(
    () => manilaYmd(todayMs ?? Date.now()),
    [todayMs],
  );

  // Build the grid: `weeks * 7` cells, each carrying its YMD + the
  // events whose scheduledAt falls on that day. Filter out cancelled
  // rows defensively (the server already excludes them by default).
  const grid = useMemo(() => {
    const cells: Array<{ ymd: ManilaYmd; events: IntermentCalendarEvent[] }> = [];
    for (let i = 0; i < bounds.weeks * 7; i++) {
      cells.push({ ymd: addDays(bounds.gridStartYmd, i), events: [] });
    }
    if (events !== undefined) {
      for (const ev of events) {
        if (ev.status === "cancelled") continue;
        const eventYmd = manilaYmd(ev.scheduledAt);
        const idx = cells.findIndex((c) => sameYmd(c.ymd, eventYmd));
        if (idx >= 0) cells[idx]!.events.push(ev);
      }
    }
    return cells;
  }, [bounds, events]);

  const [selectedYmd, setSelectedYmd] = useState<ManilaYmd | null>(null);
  const selectedCell =
    selectedYmd === null
      ? null
      : grid.find((c) => sameYmd(c.ymd, selectedYmd)) ?? null;

  const isLoading = events === undefined;

  return (
    <div data-testid="interment-calendar" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold text-slate-900">
          {MONTH_NAMES[month - 1]} {year}
        </h2>
        <div className="flex items-center gap-1" role="group" aria-label="Calendar navigation">
          <button
            type="button"
            onClick={onPrevMonth}
            disabled={onPrevMonth === undefined}
            aria-label="Previous month"
            data-testid="calendar-prev"
            className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={onToday}
            disabled={onToday === undefined}
            data-testid="calendar-today"
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Today
          </button>
          <button
            type="button"
            onClick={onNextMonth}
            disabled={onNextMonth === undefined}
            aria-label="Next month"
            data-testid="calendar-next"
            className="min-h-[44px] min-w-[44px] rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ›
          </button>
        </div>
      </div>

      {isLoading && (
        <div
          data-testid="calendar-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading interments…
        </div>
      )}

      {!isLoading && (
        <div
          role="grid"
          aria-label={`${MONTH_NAMES[month - 1]} ${year} interment calendar`}
          className="overflow-hidden rounded-md border border-slate-200 bg-white"
        >
          <div role="row" className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAY_HEADERS.map((wd) => (
              <div
                key={wd}
                role="columnheader"
                className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wide text-slate-500"
              >
                {wd}
              </div>
            ))}
          </div>
          <div role="rowgroup" className="grid grid-cols-7">
            {grid.map((cell) => {
              const inMonth = cell.ymd.month === month;
              const isToday = sameYmd(cell.ymd, todayYmd);
              const count = cell.events.length;
              const visibleEvents = cell.events.slice(0, INLINE_EVENT_LIMIT);
              const overflow = count - visibleEvents.length;
              const cellKey = ymdKey(cell.ymd);
              const hasEvents = count > 0;
              return (
                <button
                  key={cellKey}
                  type="button"
                  role="gridcell"
                  data-testid={`calendar-cell-${cellKey}`}
                  data-day-count={count}
                  aria-label={`${FULL_FORMATTER.format(
                    new Date(cell.ymd.year, cell.ymd.month - 1, cell.ymd.day),
                  )}${count === 0 ? ", no interments" : `, ${count} interment${count === 1 ? "" : "s"}`}`}
                  onClick={() => hasEvents && setSelectedYmd(cell.ymd)}
                  disabled={!hasEvents}
                  className={cn(
                    "flex min-h-[96px] flex-col items-stretch gap-1 border-b border-r border-slate-100 p-2 text-left transition-colors",
                    inMonth ? "bg-white text-slate-900" : "bg-slate-50 text-slate-400",
                    hasEvents
                      ? "cursor-pointer hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                      : "cursor-default",
                    isToday && "ring-2 ring-inset ring-blue-500",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "text-sm font-medium",
                        isToday && "text-blue-700",
                      )}
                    >
                      {cell.ymd.day}
                    </span>
                    {count > 0 && (
                      <span
                        data-testid={`calendar-count-${cellKey}`}
                        className="inline-flex min-h-[20px] min-w-[20px] items-center justify-center rounded-full bg-blue-100 px-1.5 text-xs font-semibold text-blue-800"
                      >
                        {count}
                      </span>
                    )}
                  </div>
                  <ul className="space-y-0.5 text-xs">
                    {visibleEvents.map((ev) => (
                      <li
                        key={ev.intermentId}
                        data-testid={`calendar-event-${ev.intermentId}`}
                        className="flex items-center gap-1 truncate"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            STATUS_DOT[ev.status],
                          )}
                        />
                        <span className="truncate text-slate-700">
                          {ev.occupantName}
                        </span>
                      </li>
                    ))}
                    {overflow > 0 && (
                      <li className="text-[11px] italic text-slate-500">
                        +{overflow} more
                      </li>
                    )}
                  </ul>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Sheet
        open={selectedCell !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedYmd(null);
        }}
      >
        <SheetContent
          side="right"
          data-testid="calendar-day-sheet"
          className="w-full max-w-md overflow-y-auto"
        >
          {selectedCell !== null && (
            <div className="space-y-4">
              <div className="space-y-1">
                <SheetTitle>
                  Interments on{" "}
                  {FULL_FORMATTER.format(
                    new Date(
                      selectedCell.ymd.year,
                      selectedCell.ymd.month - 1,
                      selectedCell.ymd.day,
                    ),
                  )}
                </SheetTitle>
                <SheetDescription>
                  {selectedCell.events.length === 1
                    ? "1 interment scheduled"
                    : `${selectedCell.events.length} interments scheduled`}
                </SheetDescription>
              </div>
              <ul className="space-y-2">
                {selectedCell.events.map((ev) => (
                  <li
                    key={ev.intermentId}
                    data-testid={`calendar-sheet-event-${ev.intermentId}`}
                    className="rounded-md border border-slate-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {ev.occupantName}
                        </p>
                        <p className="text-xs text-slate-600">
                          Lot {ev.lotCode}
                          {ev.lotSection.length > 0
                            ? ` · Section ${ev.lotSection}`
                            : ""}
                        </p>
                        <p className="text-xs text-slate-500">
                          {TIME_FORMATTER.format(new Date(ev.scheduledAt))}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          ev.status === "scheduled" &&
                            "border-blue-200 bg-blue-50 text-blue-800",
                          ev.status === "completed" &&
                            "border-emerald-200 bg-emerald-50 text-emerald-800",
                          ev.status === "cancelled" &&
                            "border-slate-200 bg-slate-100 text-slate-600",
                        )}
                      >
                        {STATUS_LABEL[ev.status]}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Link
                        href={`/lots/${ev.lotId}`}
                        data-testid={`calendar-sheet-lot-link-${ev.intermentId}`}
                        className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Open lot
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
