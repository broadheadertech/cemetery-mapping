"use client";

/**
 * /interments — Office Staff scheduling list (Story 7.1).
 *
 * Coordination view for office staff to see what's scheduled and find
 * the lot to schedule a new interment from. Story 7.3 will replace
 * this with a richer calendar view; this page lands the entry point +
 * basic upcoming-list so Story 7.1 ships visibly.
 *
 * The "Schedule interment" CTA lives on the lot detail page per the
 * story spec — the workflow is "open a lot → schedule". This page
 * surfaces the latest scheduled interments and links to the
 * /interments/new helper, which prompts the operator to pick a lot.
 *
 * Auth: the (staff) layout's `requireAuth` gate (Story 1.1 + 1.2)
 * protects this route. Per-role enforcement (`office_staff` / `admin`)
 * lives inside the underlying Convex queries.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { StatusPill } from "@/components/ui/StatusPill";

const FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

type IntermentStatus = "scheduled" | "completed" | "cancelled";

interface IntermentRow {
  intermentId: string;
  scheduledAt: number;
  status: IntermentStatus;
  occupantId: string;
  occupantName: string;
  notes: string | undefined;
  scheduledByName: string;
  scheduledAt_createdAt: number;
}

const listIntermentsRef = makeFunctionReference<
  "query",
  { statusFilter?: IntermentStatus; limit?: number },
  IntermentRow[]
>("interments:listInterments");

const STATUS_LABEL: Record<IntermentStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
};

// HIGH-F (Story 5.9 sweep): the prior raw Tailwind STATUS_CLASS map
// has been removed. Interment-status pills now render through
// `<StatusPill>`.

export default function IntermentsListPage() {
  const [statusFilter, setStatusFilter] = useState<IntermentStatus>(
    "scheduled",
  );

  const queryArgs = useMemo(() => {
    return { statusFilter, limit: 200 };
  }, [statusFilter]);

  const rows = useQuery(listIntermentsRef, queryArgs);
  const isLoading = rows === undefined;
  const isEmpty = rows !== undefined && rows.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Interments</h1>
        <div className="flex items-center gap-2">
          <Link
            href="/interments/calendar"
            data-testid="interments-calendar-link"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Calendar view
          </Link>
          <Link
            href="/interments/new"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Schedule interment
          </Link>
        </div>
      </div>

      <p className="text-sm text-slate-600">
        Coordination view of cemetery interments. Schedule a new interment from
        a lot’s detail page (or use the helper above to pick a lot first). The
        calendar view ships in Story 7.3.
      </p>

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by status"
      >
        {(["scheduled", "completed", "cancelled"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            aria-pressed={statusFilter === s}
            className={chipClass(statusFilter === s)}
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {isLoading && (
        <div
          data-testid="interments-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading interments…
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
          <p className="text-sm text-slate-600">
            No {STATUS_LABEL[statusFilter].toLowerCase()} interments. Use
            “Schedule interment” to add one.
          </p>
        </div>
      )}

      {rows !== undefined && rows.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Occupant</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Scheduled by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.intermentId} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {FORMATTER.format(new Date(r.scheduledAt))}
                  </td>
                  <td className="px-4 py-3 text-slate-700">{r.occupantName}</td>
                  <td className="px-4 py-3">
                    <span data-testid={`interment-status-${r.intermentId}`}>
                      <StatusPill status={r.status} size="sm" />
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.scheduledByName}
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
    "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium",
    active
      ? "border-slate-900 bg-slate-900 text-white"
      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ].join(" ");
}
