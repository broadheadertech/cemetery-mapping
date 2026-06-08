"use client";

/**
 * /ceremonies/[ceremonyId] -- detail page for a single ceremony
 * (Story 7.5 AC4).
 *
 * Renders kind-pill (gold for consecration, stone for interment),
 * scheduling metadata, chapel + pathway reservation indicators, and
 * the office-side completion / cancel actions. The page works for
 * BOTH consecration and interment kinds; for legacy interments
 * stored in the `interments` table (NOT `ceremonies`), the canonical
 * detail page remains `/interments/[intermentId]`.
 *
 * Auth: (staff) layout gates the route; `getCeremony` enforces the
 * read-side role gate (admin / office_staff / field_worker).
 * `completeCeremony` and `cancelCeremony` enforce write gates
 * server-side.
 */

import Link from "next/link";
import { useState, use as usePromise } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

interface CeremonyDetailShape {
  ceremonyId: string;
  kind: "consecration" | "interment" | "memorial_anniversary";
  status: "scheduled" | "completed" | "cancelled";
  contractId: string;
  contractNumber: string;
  customerId: string;
  customerName: string;
  lotId: string;
  lotCode: string;
  lotSection: string;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  consultantUserId: string | undefined;
  consultantName: string | undefined;
  notes: string | undefined;
  scheduledByName: string;
  scheduledAt_createdAt: number;
  completedAt: number | undefined;
  completedByName: string | undefined;
  cancellationReason: string | undefined;
  familyEstateId: string | undefined;
}

const getCeremonyRef = makeFunctionReference<
  "query",
  { ceremonyId: string },
  CeremonyDetailShape | null
>("ceremonies:getCeremony");

const completeCeremonyRef = makeFunctionReference<
  "mutation",
  { ceremonyId: string },
  { ceremonyId: string }
>("ceremonies:completeCeremony");

const cancelCeremonyRef = makeFunctionReference<
  "mutation",
  { ceremonyId: string; reason: string },
  { ceremonyId: string }
>("ceremonies:cancelCeremony");

function formatManila(ms: number): string {
  // Asia/Manila is UTC+8 with no DST -- avoid pulling in a tz lib.
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    shifted.getUTCDay()
  ];
  return `${wd} ${y}-${m}-${d} ${h}:${mm} (Manila)`;
}

interface PageProps {
  params: Promise<{ ceremonyId: string }>;
}

export default function CeremonyDetailPage({ params }: PageProps) {
  const { ceremonyId } = usePromise(params);
  const router = useRouter();
  const detail = useQuery(getCeremonyRef, { ceremonyId });
  const completeCeremony = useMutation(completeCeremonyRef);
  const cancelCeremony = useMutation(cancelCeremonyRef);

  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  if (detail === undefined) {
    return <div className="text-sm text-slate-500">Loading…</div>;
  }
  if (detail === null) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-4xl font-semibold tracking-tight">Ceremony not found</h1>
        <p className="text-sm text-slate-600">
          The ceremony you requested does not exist or has been removed.
        </p>
        <Link
          href="/ceremonies/calendar"
          className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to calendar
        </Link>
      </div>
    );
  }

  const kindLabel =
    detail.kind === "consecration"
      ? "Consecration"
      : detail.kind === "interment"
        ? "Interment"
        : "Memorial anniversary";

  const kindBadgeClass =
    detail.kind === "consecration"
      ? "bg-amber-100 text-amber-900 ring-amber-300"
      : detail.kind === "interment"
        ? "bg-stone-100 text-stone-900 ring-stone-300"
        : "bg-emerald-100 text-emerald-900 ring-emerald-300";

  const statusBadgeClass =
    detail.status === "scheduled"
      ? "bg-sky-100 text-sky-900 ring-sky-300"
      : detail.status === "completed"
        ? "bg-emerald-100 text-emerald-900 ring-emerald-300"
        : "bg-rose-100 text-rose-900 ring-rose-300";

  async function handleComplete() {
    setActionBusy(true);
    setActionError(null);
    try {
      await completeCeremony({ ceremonyId });
    } catch (err) {
      const tx = translateError(err);
      setActionError(`${tx.headline}. ${tx.detail}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleCancel() {
    setActionBusy(true);
    setActionError(null);
    try {
      await cancelCeremony({ ceremonyId, reason: cancelReason.trim() });
      setCancelOpen(false);
      setCancelReason("");
      router.push("/ceremonies/calendar");
    } catch (err) {
      const tx = translateError(err);
      setActionError(`${tx.headline}. ${tx.detail}`);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ${kindBadgeClass}`}
          >
            {kindLabel}
          </span>
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ${statusBadgeClass}`}
          >
            {detail.status}
          </span>
          {detail.chapelReserved ? (
            <span className="inline-flex items-center rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-900 ring-1 ring-violet-300">
              Chapel reserved
            </span>
          ) : null}
          {detail.pathwayReserved ? (
            <span className="inline-flex items-center rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-900 ring-1 ring-violet-300">
              Pathway reserved
            </span>
          ) : null}
        </div>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          {kindLabel} for {detail.customerName}
        </h1>
        <p className="text-sm text-slate-600">
          {formatManila(detail.scheduledAt)} &middot; {detail.durationMinutes}{" "}
          minutes &middot; Lot {detail.lotCode}
        </p>
      </header>

      <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:grid-cols-2">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-slate-500">Contract</dt>
            <dd>
              <Link
                href={`/contracts/${detail.contractId}`}
                className="text-amber-800 underline-offset-2 hover:underline"
              >
                {detail.contractNumber}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Customer</dt>
            <dd>{detail.customerName}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Lot</dt>
            <dd>
              <Link
                href={`/lots/${detail.lotId}`}
                className="text-amber-800 underline-offset-2 hover:underline"
              >
                {detail.lotCode}
              </Link>
              {detail.lotSection.length > 0
                ? ` (Section ${detail.lotSection})`
                : null}
            </dd>
          </div>
        </dl>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium text-slate-500">Consultant</dt>
            <dd>{detail.consultantName ?? "(unassigned)"}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Scheduled by</dt>
            <dd>{detail.scheduledByName}</dd>
          </div>
          {detail.completedAt !== undefined ? (
            <div>
              <dt className="font-medium text-slate-500">Completed</dt>
              <dd>
                {formatManila(detail.completedAt)}
                {detail.completedByName !== undefined
                  ? ` by ${detail.completedByName}`
                  : null}
              </dd>
            </div>
          ) : null}
          {detail.cancellationReason !== undefined ? (
            <div>
              <dt className="font-medium text-slate-500">Cancellation reason</dt>
              <dd>{detail.cancellationReason}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {detail.notes !== undefined && detail.notes.length > 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium text-slate-500">Notes</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm">{detail.notes}</p>
        </section>
      ) : null}

      {detail.kind === "interment" ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          Field-worker interment completion lives at{" "}
          <Link
            href={`/interments/${detail.ceremonyId}`}
            className="font-medium text-amber-800 underline-offset-2 hover:underline"
          >
            /interments/{detail.ceremonyId}
          </Link>
          .
        </section>
      ) : null}

      {actionError !== null ? (
        <div
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"
        >
          {actionError}
        </div>
      ) : null}

      {detail.status === "scheduled" ? (
        <section className="flex flex-wrap items-center gap-3">
          {detail.kind === "consecration" ||
          detail.kind === "memorial_anniversary" ? (
            <button
              type="button"
              onClick={handleComplete}
              disabled={actionBusy}
              className="inline-flex min-h-[44px] items-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white shadow hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Mark {kindLabel.toLowerCase()} complete
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setCancelOpen((open) => !open)}
            disabled={actionBusy}
            className="inline-flex min-h-[44px] items-center rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            {cancelOpen ? "Close cancel form" : "Cancel ceremony"}
          </button>
        </section>
      ) : null}

      {cancelOpen ? (
        <section className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-4">
          <label
            htmlFor="cancel-reason"
            className="block text-sm font-medium text-rose-900"
          >
            Cancellation reason (10+ characters)
          </label>
          <textarea
            id="cancel-reason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            rows={3}
            minLength={10}
            maxLength={500}
            className="block w-full rounded-md border border-rose-300 px-3 py-2 text-sm"
          />
          <p className="text-xs text-rose-700">{cancelReason.length}/500</p>
          <button
            type="button"
            onClick={handleCancel}
            disabled={actionBusy || cancelReason.trim().length < 10}
            className="inline-flex min-h-[44px] items-center rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white shadow hover:bg-rose-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Confirm cancellation
          </button>
        </section>
      ) : null}

      <Link
        href="/ceremonies/calendar"
        className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        Back to calendar
      </Link>
    </div>
  );
}
