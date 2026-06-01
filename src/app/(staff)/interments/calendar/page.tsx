"use client";

/**
 * /interments/calendar — Office Staff interment calendar (Story 7.3).
 *
 * Sub-route under the existing `/interments` list view (Story 7.1).
 * Renders a Manila-tz month grid backed by the `listInRange` Convex
 * query. Each day cell shows a count + up to 3 occupant names;
 * clicking a populated cell opens a drill-in `<Sheet>` listing that
 * day's interments with links into the lot detail page.
 *
 * Dev brief scopes Story 7.3 to the minimum bar:
 *   - month-view only (week / day toggle, status / section filters,
 *     URL sync, FullCalendar — all deferred to Phase 2 kickoff).
 *   - viewport-bounded query: never load all interments.
 *
 * Auth is enforced server-side inside `listInRange`
 * (`requireRole(admin / office_staff / field_worker)`). The (staff)
 * layout's auth gate keeps unauthenticated traffic out of this
 * route entirely.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  IntermentCalendar,
  manilaMonthBoundsMs,
  manilaYmd,
  type IntermentCalendarEvent,
} from "@/components/IntermentCalendar";

const listInRangeRef = makeFunctionReference<
  "query",
  { fromMs: number; toMs: number; includeCancelled?: boolean },
  IntermentCalendarEvent[]
>("interments:listInRange");

interface MonthFocus {
  year: number;
  month: number; // 1..12
}

function nowManilaFocus(): MonthFocus {
  const ymd = manilaYmd(Date.now());
  return { year: ymd.year, month: ymd.month };
}

function stepMonth(focus: MonthFocus, delta: number): MonthFocus {
  // Compose via Date.UTC so month over/underflow rolls the year.
  const d = new Date(Date.UTC(focus.year, focus.month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export default function IntermentCalendarPage() {
  const [focus, setFocus] = useState<MonthFocus>(nowManilaFocus);

  const bounds = useMemo(
    () => manilaMonthBoundsMs(focus.year, focus.month),
    [focus.year, focus.month],
  );

  const events = useQuery(listInRangeRef, {
    fromMs: bounds.fromMs,
    toMs: bounds.toMsInclusive,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">
            Interment Calendar
          </h1>
          <p className="text-sm text-slate-600">
            Month-at-a-glance view of scheduled and completed interments.
            Click a day to see the full list.
          </p>
        </div>
        <Link
          href="/interments"
          className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Back to list
        </Link>
      </div>

      <IntermentCalendar
        year={focus.year}
        month={focus.month}
        events={events}
        onPrevMonth={() => setFocus((f) => stepMonth(f, -1))}
        onNextMonth={() => setFocus((f) => stepMonth(f, 1))}
        onToday={() => setFocus(nowManilaFocus())}
      />
    </div>
  );
}
