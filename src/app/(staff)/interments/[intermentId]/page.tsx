"use client";

/**
 * /interments/[intermentId] — Interment detail page (Story 7.4).
 *
 * Minimal detail surface: occupant + lot + scheduling context +
 * status. Primary action is "Mark complete" for scheduled rows
 * (links to `/complete` sub-route which mounts the completion sheet).
 *
 * Story 7.4 ships this as the missing piece so the today's list and
 * future calendar drill-ins both have a stable destination. Richer
 * detail (e.g. attached completion photo display, audit history)
 * will land in follow-up stories.
 *
 * Auth: the (staff) layout protects this route; per-role checks live
 * inside `getInterment` (admin / office_staff / field_worker).
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { StatusPill } from "@/components/ui/StatusPill";

interface IntermentDetail {
  intermentId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: string;
  occupantName: string;
  notes: string | undefined;
  scheduledByName: string;
  scheduledAt_createdAt: number;
  lotId: string;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  completedAt: number | undefined;
  completedByName: string | undefined;
  completionNotes: string | undefined;
  cancellationReason: string | undefined;
}

const getIntermentRef = makeFunctionReference<
  "query",
  { intermentId: string },
  IntermentDetail | null
>("interments:getInterment");

const FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

// HIGH-F (Story 5.9 sweep): the prior raw Tailwind STATUS_CLASS map
// and STATUS_LABEL map have both been removed. Interment-status pills
// render through `<StatusPill>`, which pulls its colour + label from
// the centralised status palette.

export default function IntermentDetailPage() {
  const params = useParams<{ intermentId: string }>();
  const intermentId = params?.intermentId ?? "";
  const interment = useQuery(
    getIntermentRef,
    intermentId !== "" ? { intermentId } : "skip",
  );

  if (interment === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-6 text-sm text-slate-500">
        Loading interment…
      </div>
    );
  }

  if (interment === null) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p className="text-sm text-red-700">Interment not found.</p>
        <Link
          href="/interments"
          className="mt-3 inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to interments
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {interment.occupantName}
          </h1>
          <p className="text-sm text-slate-600">
            Lot {interment.lotCode}
            {interment.lotSection.length > 0 && (
              <> — {interment.lotSection}/{interment.lotBlock}/{interment.lotRow}</>
            )}
          </p>
        </div>
        <span
          data-testid={`interment-detail-status-${interment.intermentId}`}
        >
          <StatusPill status={interment.status} size="md" />
        </span>
      </header>

      <dl className="grid grid-cols-1 gap-3 rounded-md border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-slate-700">Scheduled for</dt>
          <dd className="text-slate-900 tabular-nums">
            {FORMATTER.format(new Date(interment.scheduledAt))}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-700">Scheduled by</dt>
          <dd className="text-slate-900">{interment.scheduledByName}</dd>
        </div>
        {interment.notes !== undefined && interment.notes.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="font-medium text-slate-700">Scheduling notes</dt>
            <dd className="text-slate-900">{interment.notes}</dd>
          </div>
        )}
        {interment.status === "completed" &&
          interment.completedAt !== undefined && (
            <>
              <div>
                <dt className="font-medium text-slate-700">Completed at</dt>
                <dd className="text-slate-900 tabular-nums">
                  {FORMATTER.format(new Date(interment.completedAt))}
                </dd>
              </div>
              {interment.completedByName !== undefined && (
                <div>
                  <dt className="font-medium text-slate-700">Completed by</dt>
                  <dd className="text-slate-900">
                    {interment.completedByName}
                  </dd>
                </div>
              )}
              {interment.completionNotes !== undefined &&
                interment.completionNotes.length > 0 && (
                  <div className="sm:col-span-2">
                    <dt className="font-medium text-slate-700">
                      Completion notes
                    </dt>
                    <dd className="text-slate-900">
                      {interment.completionNotes}
                    </dd>
                  </div>
                )}
            </>
          )}
      </dl>

      <div className="flex flex-wrap gap-3">
        <Link
          href={`/lots/${interment.lotId}`}
          className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          View lot
        </Link>
        {interment.status === "scheduled" && (
          <Link
            href={`/interments/${interment.intermentId}/complete`}
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            data-testid="interment-detail-mark-complete"
          >
            Mark complete
          </Link>
        )}
      </div>
    </div>
  );
}
