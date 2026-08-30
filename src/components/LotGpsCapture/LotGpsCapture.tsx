"use client";

/**
 * Capturing a lot's position by standing at it.
 *
 * The thing a field worker actually holds. No map to pan, no
 * coordinates to type: walk to the grave, press a button, keep still
 * for fifteen seconds, save.
 *
 * The whole design problem is that a phone is not accurate enough for
 * what it is being asked to do. A grave is 2.5m wide; a phone reports
 * 3–10m under open sky and worse beside a wall. So this screen spends
 * most of its space on the ONE number that decides whether the reading
 * is worth keeping, expressed in the unit the person is standing in —
 * graves, not metres — and refuses to save what it cannot support.
 *
 * The arithmetic lives in `@/lib/gpsCapture`, where it can be checked
 * against numbers. This is the part that talks to the device and to the
 * person.
 *
 * @gated-route-only — mounts on `/lots/[lotId]`, which field workers
 * use; `lots:setLotLocation` admits them for `gps` captures only and
 * re-checks the accuracy server-side.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  blockedReason,
  canSave,
  MAX_USABLE_ACCURACY_M,
  qualityOf,
  SAMPLE_WINDOW_MS,
  summarise,
  type GpsFix,
  type GpsSample,
} from "@/lib/gpsCapture";
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

export interface LotGpsCaptureProps {
  lotId: string;
  lotCode: string;
  /** True when the lot already has a position, whatever its source. */
  alreadyPlaced?: boolean;
}

type Phase = "idle" | "sampling" | "done" | "saved";

export function LotGpsCapture({
  lotId,
  lotCode,
  alreadyPlaced = false,
}: LotGpsCaptureProps): ReactElement {
  const setLocation = useMutation(setLocationRef);

  const [phase, setPhase] = useState<Phase>("idle");
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [remainingMs, setRemainingMs] = useState(SAMPLE_WINDOW_MS);

  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopWatching(): void {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // A watch left running drains a field worker's battery for the rest
  // of their shift.
  useEffect(() => stopWatching, []);

  function start(): void {
    setError(null);
    setSamples([]);
    setRemainingMs(SAMPLE_WINDOW_MS);

    if (
      typeof navigator === "undefined" ||
      navigator.geolocation === undefined
    ) {
      setError(
        "This device cannot report its position. On a phone, check that location is switched on — and that the site is opened over https, which the browser requires before it will share a position at all.",
      );
      return;
    }

    setPhase("sampling");
    const startedAt = Date.now();

    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setSamples((prev) => [
          ...prev,
          {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: pos.coords.accuracy,
            at: pos.timestamp,
          },
        ]);
      },
      (err) => {
        stopWatching();
        setPhase("idle");
        setError(messageForGeolocationError(err));
      },
      // The whole point is the accurate fix; a cached one from an hour
      // ago is worse than useless when the question is which grave.
      { enableHighAccuracy: true, maximumAge: 0, timeout: SAMPLE_WINDOW_MS },
    );

    timerRef.current = setInterval(() => {
      const left = SAMPLE_WINDOW_MS - (Date.now() - startedAt);
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        stopWatching();
        setPhase("done");
      }
    }, 250);
  }

  const fix: GpsFix | null = summarise(samples);
  const band = fix === null ? null : qualityOf(fix.accuracyM);
  const saveable = phase !== "sampling" && canSave(fix);
  const blocked = phase === "done" ? blockedReason(fix) : null;

  async function handleSave(): Promise<void> {
    if (fix === null) return;
    setSaving(true);
    setError(null);
    try {
      await setLocation({
        lotId,
        lat: fix.lat,
        lng: fix.lng,
        source: "gps",
        accuracyM: fix.accuracyM,
      });
      setPhase("saved");
    } catch (e: unknown) {
      setError(translateError(e).detail);
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
        {Math.round(SAMPLE_WINDOW_MS / 1000)} seconds.
      </p>

      {alreadyPlaced && phase === "idle" && (
        <p className="mt-2 text-xs text-slate-500">
          This lot already has a position. Capturing replaces it.
        </p>
      )}

      {phase === "idle" && (
        <button
          type="button"
          data-testid="gps-start"
          onClick={start}
          className="mt-4 min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Use my location
        </button>
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
            onClick={() => {
              stopWatching();
              setPhase("done");
            }}
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
            onClick={start}
            className="min-h-[44px] rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
          >
            Try again
          </button>
        </div>
      )}

      {phase === "saved" && fix !== null && (
        <p
          role="status"
          data-testid="gps-saved"
          className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Saved, accurate to about {Math.round(fix.accuracyM)}m. The map
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

      <p className="mt-3 text-[11px] leading-snug text-slate-500">
        A phone is accurate to a few metres at best and a grave is 2.5m
        wide, so this places the lot in roughly the right spot — not
        exactly. Anything rougher than {MAX_USABLE_ACCURACY_M}m is
        refused.
      </p>
    </section>
  );
}

/** The browser's failures, in words that say what to do about them. */
function messageForGeolocationError(err: GeolocationPositionError): string {
  switch (err.code) {
    case 1: // PERMISSION_DENIED
      return "Location permission was refused. Allow it for this site in your browser settings, then try again.";
    case 2: // POSITION_UNAVAILABLE
      return "The phone could not get a fix. Step into the open, away from walls and trees, and try again.";
    case 3: // TIMEOUT
      return "The phone took too long to find a position. Try again in the open.";
    default:
      return "Could not read a position from this device.";
  }
}
