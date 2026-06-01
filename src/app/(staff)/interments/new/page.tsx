"use client";

/**
 * /interments/new — generic "schedule an interment" entry (Story 7.1).
 *
 * The canonical scheduling affordance lives on the lot detail page
 * (per the story spec — "the button belongs on /lots/[lotId], NOT on
 * a global /schedule page"). This page is a fallback helper for
 * operators who arrived via the sidebar / direct URL:
 *
 *   1. Pick a lot (sold or occupied — interment-eligible).
 *   2. Pick an occupant from that lot (or create one inline via the
 *      lot detail page; we link out for that flow to avoid
 *      duplicating Story 2.6's inline-create UI).
 *   3. Submit the form.
 *
 * The page deliberately stays narrow — Story 7.1's tests cover the
 * mutation + form contract; this surface is a thin orchestration
 * layer.
 *
 * Auth: the (staff) layout's `requireAuth` gate (Story 1.1 + 1.2)
 * protects this route. Per-role enforcement (`office_staff` / `admin`)
 * lives inside `scheduleInterment` itself.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  IntermentForm,
  type IntermentConflictPreview,
  type IntermentSubmitPayload,
  type IntermentOccupantOption,
} from "@/components/IntermentForm";
import { translateError } from "@/lib/errors";
import type { LotStatus } from "@/types/lot-status";

interface LotRow {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  basePriceCents: number;
  status: LotStatus;
  isRetired: boolean;
}

interface OccupantRow {
  occupantId: string;
  name: string;
  dateOfInterment: number | undefined;
  relationshipToOwner: string;
  notes: string | undefined;
  isRemoved: boolean;
  removedReason: string | undefined;
  createdAt: number;
}

const listLotsRef = makeFunctionReference<
  "query",
  { statusFilter?: LotStatus },
  LotRow[]
>("lots:listLots");

const listLotOccupantsRef = makeFunctionReference<
  "query",
  { lotId: string; includeRemoved?: boolean },
  OccupantRow[]
>("occupants:listLotOccupants");

const scheduleIntermentRef = makeFunctionReference<
  "mutation",
  {
    lotId: string;
    occupantId: string;
    scheduledAt: number;
    notes?: string;
  },
  { intermentId: string }
>("interments:scheduleInterment");

interface IntermentConflictRow {
  intermentId: string;
  scheduledAt: number;
  occupantId: string;
  occupantName: string;
  notes?: string;
  scope: "same-lot" | "cross-lot";
  lotCode?: string;
}

const findConflictsRef = makeFunctionReference<
  "query",
  {
    lotId: string;
    scheduledAt: number;
    excludeIntermentId?: string;
  },
  IntermentConflictRow[]
>("interments:findConflicts");

export default function NewIntermentPage() {
  const router = useRouter();
  const [selectedLotId, setSelectedLotId] = useState<string>("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Story 7.2 wiring — the form notifies the parent of its composed
  // `scheduledAt` epoch ms (null while date or time is blank). We
  // drive the `findConflicts` query off this value so the inline
  // banner renders BEFORE submit. The query is skipped until both a
  // lot and a valid timestamp are present.
  const [pendingScheduledAt, setPendingScheduledAt] = useState<number | null>(
    null,
  );

  // Pull sold + occupied lots — interments at unsold lots are flagged
  // as a Phase 2 kickoff question per the story spec. We show both
  // statuses concatenated (with a small per-status sub-query) so the
  // operator can pick from either pool. The single-status query above
  // is what `convex/lots.ts:listLots` accepts; we batch by status in
  // two `useQuery` calls and concatenate client-side.
  const soldLots = useQuery(listLotsRef, { statusFilter: "sold" });
  const occupiedLots = useQuery(listLotsRef, { statusFilter: "occupied" });

  const eligibleLots = useMemo<LotRow[]>(() => {
    if (soldLots === undefined || occupiedLots === undefined) return [];
    const seen = new Set<string>();
    const merged: LotRow[] = [];
    for (const list of [soldLots, occupiedLots]) {
      for (const lot of list) {
        if (seen.has(lot._id)) continue;
        seen.add(lot._id);
        merged.push(lot);
      }
    }
    return merged.sort((a, b) => a.code.localeCompare(b.code));
  }, [soldLots, occupiedLots]);

  const occupants = useQuery(
    listLotOccupantsRef,
    selectedLotId !== "" ? { lotId: selectedLotId } : "skip",
  );
  const occupantOptions = useMemo<IntermentOccupantOption[]>(() => {
    if (occupants === undefined) return [];
    return occupants.map((o) => ({
      occupantId: o.occupantId,
      name: o.name,
      relationshipToOwner: o.relationshipToOwner,
      isRemoved: o.isRemoved,
    }));
  }, [occupants]);

  const scheduleInterment = useMutation(scheduleIntermentRef);

  // Story 7.2 — conflict preview. Skip the query when the operator
  // hasn't picked both a lot AND a valid scheduledAt yet. The server-
  // side `findConflicts` is the read source; this hook keeps the form
  // banner reactive without a manual round-trip on every keystroke.
  const conflictRows = useQuery(
    findConflictsRef,
    selectedLotId !== "" && pendingScheduledAt !== null
      ? { lotId: selectedLotId, scheduledAt: pendingScheduledAt }
      : "skip",
  );
  const conflicts = useMemo<
    IntermentConflictPreview[] | undefined
  >(() => {
    if (conflictRows === undefined) return undefined;
    return conflictRows.map((r) => ({
      intermentId: r.intermentId,
      scheduledAt: r.scheduledAt,
      occupantName: r.occupantName,
      notes: r.notes,
      scope: r.scope,
      lotCode: r.lotCode,
    }));
  }, [conflictRows]);

  const isLoadingLots =
    soldLots === undefined || occupiedLots === undefined;

  async function handleSubmit(payload: IntermentSubmitPayload): Promise<void> {
    setSubmitError(null);
    try {
      await scheduleInterment({
        lotId: selectedLotId,
        occupantId: payload.occupantId,
        scheduledAt: payload.scheduledAt,
        notes: payload.notes,
      });
      router.push(`/lots/${selectedLotId}`);
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
      throw err;
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Schedule interment</h1>
      <p className="text-sm text-slate-600">
        Pick a lot, choose an occupant on that lot, and set the date and time.
        To record a new occupant inline, open the lot’s detail page first.
      </p>

      {submitError !== null && (
        <div
          role="alert"
          data-testid="interments-new-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="interment-lot"
          className="block text-sm font-medium text-slate-700"
        >
          Lot
        </label>
        <select
          id="interment-lot"
          value={selectedLotId}
          onChange={(e) => {
            setSelectedLotId(e.target.value);
            // Reset the pending scheduledAt so the conflict query
            // doesn't briefly fire against the new lot with the
            // previous lot's time. The form re-publishes on its next
            // re-render via `onScheduledAtChange`.
            setPendingScheduledAt(null);
          }}
          disabled={isLoadingLots}
          className="block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:cursor-not-allowed disabled:bg-slate-50"
        >
          <option value="">
            {isLoadingLots
              ? "Loading lots…"
              : eligibleLots.length === 0
                ? "No sold or occupied lots available"
                : "Select a lot…"}
          </option>
          {eligibleLots.map((lot) => (
            <option key={lot._id} value={lot._id}>
              {lot.code} — {lot.section}/{lot.block}/{lot.row} ({lot.status})
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-500">
          Only sold and occupied lots are eligible for scheduling.
        </p>
      </div>

      {selectedLotId !== "" && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          {occupants === undefined && (
            <p className="text-sm text-slate-500">Loading occupants…</p>
          )}
          {occupants !== undefined && occupants.length === 0 && (
            <p className="text-sm text-slate-700">
              This lot has no occupants yet.{" "}
              <Link
                href={`/lots/${selectedLotId}`}
                className="font-medium text-slate-900 underline"
              >
                Add one on the lot detail page
              </Link>
              {" "}before scheduling.
            </p>
          )}
          {occupants !== undefined && occupants.length > 0 && (
            <IntermentForm
              occupants={occupantOptions}
              onSubmit={handleSubmit}
              onCancel={() => router.push("/interments")}
              conflicts={conflicts}
              onScheduledAtChange={setPendingScheduledAt}
            />
          )}
        </div>
      )}
    </div>
  );
}
