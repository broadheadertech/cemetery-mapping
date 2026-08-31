"use client";

/**
 * Capturing a lot's position by standing at it.
 *
 * The thing a field worker actually holds. No map to pan, no
 * coordinates to type: walk to the grave, press a button, keep still,
 * save.
 *
 * The whole design problem is that a phone is not accurate enough for
 * what it is being asked to do. A grave is 2.5m wide; a phone reports
 * 3–10m under open sky and worse beside a wall. So this screen spends
 * most of its space on the ONE number that decides whether the reading
 * is worth keeping, expressed in the unit the person is standing in —
 * graves, not metres — and refuses to save what it cannot support.
 *
 * The device lifecycle lives in `@/hooks/useGpsCapture`, shared with
 * the garden-outline editor: both had their own copy and both copies
 * carried the same three bugs, one of which made a cold GPS start fail
 * every single time.
 *
 * @gated-route-only — mounts on `/lots/[lotId]`, which field workers
 * use; `lots:setLotLocation` admits them for `gps` captures only and
 * re-checks the accuracy server-side.
 */

import { useState, type ReactElement } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  blockedReason,
  canSave,
  MAX_USABLE_ACCURACY_M,
  qualityOf,
  SAMPLE_WINDOW_MS,
} from "@/lib/gpsCapture";
import { useGpsCapture } from "@/hooks/useGpsCapture";
import { translateError } from "@/lib/errors";

const setLocationRef = makeFunctionReference<
  "mutation",
  {
    lotId: string;
    lat: number;
    lng: number;
    source: "gps";
    accuracyM: number;
  },
  null
>("lots:setLotLocation");

const clearLocationRef = makeFunctionReference<
  "mutation",
  { lotId: string },
  null
>("lots:clearLotLocation");

export interface LotGpsCaptureProps {
  lotId: string;
  lotCode: string;
  /** True when the lot already has a position, whatever its source. */
  alreadyPlaced?: boolean;
  /**
   * Whether the reader may withdraw a position outright.
   *
   * Office work, not field work: a field worker whose own reading was
   * poor can simply take another, but deciding the record should say
   * "not surveyed" is a different call.
   */
  canClear?: boolean;
}

export function LotGpsCapture({
  lotId,
  lotCode,
  alreadyPlaced = false,
  canClear = false,
}: LotGpsCaptureProps): ReactElement {
  const setLocation = useMutation(setLocationRef);
  const clearLocation = useMutation(clearLocationRef);
  const gps = useGpsCapture();

  const [saving, setSaving] = useState(false);
  const [savedAccuracyM, setSavedAccuracyM] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);

  const { phase, samples, fix, remainingMs, waitedMs } = gps;
  const band = fix === null ? null : qualityOf(fix.accuracyM);
  const saveable = phase === "done" && canSave(fix);
  const blocked = phase === "done" ? blockedReason(fix) : null;
  const error = saveError ?? gps.error;

  async function handleSave(): Promise<void> {
    if (fix === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setLocation({
        lotId,
        lat: fix.lat,
        lng: fix.lng,
        source: "gps",
        accuracyM: fix.accuracyM,
      });
      setSavedAccuracyM(fix.accuracyM);
      gps.reset();
    } catch (e: unknown) {
      setSaveError(translateError(e).detail);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      data-testid="lot-gps-capture"
      className="w-full rounded-md border border-slate-200 bg-white p-5"
    >
      <h2 className="font-display text-xl font-light">Capture position</h2>
      <p className="mt-1 text-sm text-slate-600">
        Stand at lot {lotCode} and hold still. The reading settles over{" "}
        {Math.round(SAMPLE_WINDOW_MS / 1000)} seconds once the phone has
        found itself.
      </p>

      {alreadyPlaced && phase === "idle" && savedAccuracyM === null && (
        <p className="mt-2 text-xs text-slate-500">
          This lot already has a position. Capturing replaces it.
        </p>
      )}

      {phase === "idle" && (
        <button
          type="button"
          data-testid="gps-start"
          onClick={() => {
            setSaveError(null);
            setSavedAccuracyM(null);
            gps.start();
          }}
          className="mt-4 min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Use my location
        </button>
      )}

      {/*
        Waiting for the first fix, which is its own state and not a
        failure. A cold GPS routinely takes half a minute; the previous
        version treated that as a timeout and gave up before a single
        reading had arrived.
      */}
      {phase === "locating" && (
        <div className="mt-4 space-y-2" data-testid="gps-locating">
          <p className="text-sm text-slate-700">
            Finding the satellites&hellip; {Math.round(waitedMs / 1000)}s
          </p>
          <p className="text-xs text-slate-500">
            The first fix can take up to a minute, especially indoors or
            the first time today. Standing in the open makes it much
            faster.
          </p>
        </div>
      )}

      {phase === "sampling" && (
        <div className="mt-4 space-y-2" data-testid="gps-sampling">
          <p className="text-sm text-slate-700">
            Hold still&hellip; {Math.ceil(remainingMs / 1000)}s
          </p>
          <p className="text-xs text-slate-500">
            {samples.length} reading{samples.length === 1 ? "" : "s"} so far.
          </p>
          <button
            type="button"
            data-testid="gps-stop"
            onClick={gps.finish}
            className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
          >
            Stop now
          </button>
        </div>
      )}

      {/*
        The number that decides everything, and what it means in graves.
        A radius is not a fact a field worker can act on; "could be a lot
        or two out either side" is.
      */}
      {fix !== null && band !== null && phase !== "idle" && (
        <div
          data-testid="gps-reading"
          className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span
              data-testid="gps-accuracy"
              className="font-mono text-sm text-slate-800"
            >
              ±{Math.round(fix.accuracyM)}m
            </span>
            <span
              data-testid="gps-quality"
              className={
                band.quality === "good"
                  ? "text-xs font-medium text-emerald-700"
                  : band.quality === "usable"
                    ? "text-xs font-medium text-amber-700"
                    : "text-xs font-medium text-red-700"
              }
            >
              {band.quality === "good"
                ? "Good"
                : band.quality === "usable"
                  ? "Usable"
                  : band.quality === "coarse"
                    ? "Rough"
                    : "Not usable"}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{band.meaning}</p>
          <p className="mt-2 font-mono text-[11px] text-slate-500">
            {fix.lat.toFixed(6)}, {fix.lng.toFixed(6)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {fix.usedCount} reading{fix.usedCount === 1 ? "" : "s"} used
            {fix.rejectedCount > 0 && `, ${fix.rejectedCount} too rough`}.
          </p>
        </div>
      )}

      {blocked !== null && (
        <p
          role="status"
          data-testid="gps-blocked"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {blocked}
        </p>
      )}

      {phase === "done" && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!saveable || saving}
            data-testid="gps-save"
            onClick={() => void handleSave()}
            className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
          >
            {saving ? "Saving…" : "Save this position"}
          </button>
          <button
            type="button"
            data-testid="gps-retry"
            onClick={gps.start}
            className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
          >
            Try again
          </button>
        </div>
      )}

      {savedAccuracyM !== null && (
        <p
          role="status"
          data-testid="gps-saved"
          className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Saved, accurate to about {Math.round(savedAccuracyM)}m. The map
          shows this as a phone reading rather than a survey.
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          data-testid="gps-error"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {error}
        </p>
      )}

      {/*
        Withdrawing a position, which nothing could do before.
        "Not surveyed" beats a coordinate nobody trusts: the map leaves
        the lot out and says so, rather than drawing it confidently in
        the wrong place.
      */}
      {canClear && alreadyPlaced && !cleared && phase === "idle" && (
        <div className="mt-4 border-t border-slate-200 pt-3">
          <button
            type="button"
            disabled={clearing}
            data-testid="gps-clear"
            onClick={() => {
              setClearing(true);
              setSaveError(null);
              void clearLocation({ lotId })
                .then(() => setCleared(true))
                .catch((e: unknown) => setSaveError(translateError(e).detail))
                .finally(() => setClearing(false));
            }}
            className="text-xs font-medium text-slate-600 underline hover:text-slate-900 disabled:text-slate-400"
          >
            {clearing ? "Removing…" : "Remove this position"}
          </button>
          <p className="mt-1 text-[11px] text-slate-500">
            Marks the lot not surveyed. Better than a position nobody
            trusts — the map leaves it out and says how many it is not
            showing.
          </p>
        </div>
      )}

      {cleared && (
        <p
          role="status"
          data-testid="gps-cleared"
          className="mt-4 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700"
        >
          Position removed. This lot is not surveyed.
        </p>
      )}

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        A phone is accurate to a few metres at best and a grave is 2.5m
        wide, so this places the lot in roughly the right spot — not
        exactly. Anything rougher than {MAX_USABLE_ACCURACY_M}m is
        refused.
      </p>
    </section>
  );
}
