"use client";

/**
 * Taking a settled position from the device, without the three ways
 * that quietly never works.
 *
 * Both places that capture a position — a lot's own panel and the
 * garden-outline editor — had their own copy of this lifecycle, and
 * both copies had the same three bugs. One copy now, so they cannot
 * drift and cannot be fixed in only one place.
 *
 *   1. `timeout` is PER ACQUISITION, not for the whole capture. It was
 *      set to the sampling window, fifteen seconds, and a cold GPS
 *      routinely takes thirty to sixty to produce its first fix —
 *      longer indoors or on first use. So the error callback fired
 *      before a single reading arrived, the watch was torn down, and
 *      the screen said the phone took too long. On a cold start it
 *      could not succeed at all.
 *
 *   2. The countdown began when the button was pressed rather than when
 *      the first reading landed, so twenty seconds of waiting for a fix
 *      ate the entire window and left nothing to average.
 *
 *   3. ANY error ended the capture, including the routine ones. GPS
 *      drops readings; a single failure after ten good ones threw all
 *      ten away.
 *
 * And the cause that is not a bug at all but looks like one: browsers
 * refuse to share a position outside a secure context. Over
 * `http://192.168.1.x` — which is exactly how somebody tests on their
 * phone — the call fails with PERMISSION_DENIED, and "check your
 * browser permissions" is advice that cannot possibly work. That case
 * is now named.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  SAMPLE_WINDOW_MS,
  summarise,
  type GpsFix,
  type GpsSample,
} from "@/lib/gpsCapture";

/**
 * How long to wait for the FIRST reading before giving up.
 *
 * Generous on purpose: a cold GPS with no recent almanac can take the
 * better part of a minute, and the old fifteen-second limit turned that
 * ordinary wait into a failure.
 */
export const FIRST_FIX_TIMEOUT_MS = 60_000;

export type GpsPhase = "idle" | "locating" | "sampling" | "done";

export interface UseGpsCaptureResult {
  phase: GpsPhase;
  samples: GpsSample[];
  /** The best position the readings support, or null. */
  fix: GpsFix | null;
  /** Milliseconds left in the sampling window. */
  remainingMs: number;
  /** How long we have been waiting for the first reading. */
  waitedMs: number;
  error: string | null;
  start: () => void;
  /** Finish now and keep what has arrived. */
  finish: () => void;
  reset: () => void;
}

export function useGpsCapture(): UseGpsCaptureResult {
  const [phase, setPhase] = useState<GpsPhase>("idle");
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(SAMPLE_WINDOW_MS);
  const [waitedMs, setWaitedMs] = useState(0);

  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  /** When the first reading landed. The window is measured from here. */
  const windowStartRef = useRef<number | null>(null);
  const sampleCountRef = useRef(0);

  const stopWatching = useCallback(() => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // A watch left running drains a field worker's battery for the rest
  // of their shift, with nothing on screen to explain it.
  useEffect(() => stopWatching, [stopWatching]);

  const finish = useCallback(() => {
    stopWatching();
    setPhase("done");
  }, [stopWatching]);

  const reset = useCallback(() => {
    stopWatching();
    setPhase("idle");
    setSamples([]);
    setError(null);
    setRemainingMs(SAMPLE_WINDOW_MS);
    setWaitedMs(0);
    windowStartRef.current = null;
    sampleCountRef.current = 0;
  }, [stopWatching]);

  const start = useCallback(() => {
    setError(null);
    setSamples([]);
    setRemainingMs(SAMPLE_WINDOW_MS);
    setWaitedMs(0);
    windowStartRef.current = null;
    sampleCountRef.current = 0;

    if (
      typeof navigator === "undefined" ||
      navigator.geolocation === undefined
    ) {
      setError(
        "This device cannot report its position at all. On a phone, check that location services are switched on.",
      );
      return;
    }

    /*
     * The commonest real failure, and the one whose symptom lies.
     *
     * Browsers only share a position in a secure context. Opened over
     * plain http on anything but localhost — which is exactly how a
     * phone reaches a dev server on the office wi-fi — the call comes
     * back as PERMISSION_DENIED, and telling somebody to check their
     * browser permissions sends them somewhere that cannot fix it.
     */
    if (
      typeof window !== "undefined" &&
      window.isSecureContext === false
    ) {
      setError(
        "This page is not on a secure connection, and browsers will not share a location over plain http. Open the site over https (or on localhost) and it will work — there is nothing to change in your phone's settings.",
      );
      return;
    }

    setPhase("locating");
    startedAtRef.current = Date.now();

    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (windowStartRef.current === null) {
          // The window starts at the FIRST reading, not at the button.
          // Otherwise a long cold start eats it and leaves nothing to
          // average.
          windowStartRef.current = Date.now();
          setPhase("sampling");
        }
        sampleCountRef.current += 1;
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
        // Permission is final: retrying cannot help and the watch is
        // dead anyway.
        if (err.code === 1) {
          stopWatching();
          setPhase("idle");
          setError(
            "Location permission was refused for this site. Allow it in your browser settings, then try again.",
          );
          return;
        }
        // Everything else is routine. GPS drops readings constantly;
        // throwing away ten good ones because the eleventh failed is
        // how a capture that was working suddenly is not.
        if (sampleCountRef.current > 0) return;
        // Nothing yet — let the first-fix deadline decide, so a slow
        // start is a wait rather than a failure.
      },
      {
        enableHighAccuracy: true,
        // A cached fix from an hour ago is worse than useless when the
        // question is which grave.
        maximumAge: 0,
        // Per acquisition, and generous: this is not the sampling
        // window, and conflating the two was the bug.
        timeout: FIRST_FIX_TIMEOUT_MS,
      },
    );

    timerRef.current = setInterval(() => {
      const now = Date.now();

      if (windowStartRef.current === null) {
        const waited = now - startedAtRef.current;
        setWaitedMs(waited);
        if (waited >= FIRST_FIX_TIMEOUT_MS) {
          stopWatching();
          setPhase("idle");
          setError(
            "No position after a minute. Step into the open, away from walls and roofs — a phone cannot see the satellites indoors.",
          );
        }
        return;
      }

      const left = SAMPLE_WINDOW_MS - (now - windowStartRef.current);
      setRemainingMs(Math.max(0, left));
      if (left <= 0) {
        stopWatching();
        setPhase("done");
      }
    }, 250);
  }, [stopWatching]);

  return {
    phase,
    samples,
    fix: summarise(samples),
    remainingMs,
    waitedMs,
    error,
    start,
    finish,
    reset,
  };
}
