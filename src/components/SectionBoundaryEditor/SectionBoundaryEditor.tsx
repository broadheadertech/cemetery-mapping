"use client";

/**
 * Tracing a garden's outline.
 *
 * Click each corner in order and the shape closes itself. Or, standing
 * at a corner, take the position from the phone — walking the perimeter
 * is how somebody with no survey and no drone actually gets an outline,
 * and a corner is the one place a phone's few metres of error matters
 * least: a garden is fifty metres across, not two and a half.
 *
 * Deliberately not derived from the lots. A hull drawn around four
 * placed lots out of eighty is a confident drawing of the wrong shape,
 * and the whole point of an irregular park is that its edges are not
 * implied by its contents.
 *
 * @gated-route-only — mounts under `/admin`; `sections:setSectionBoundary`
 * re-checks for admin server-side.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
import {
  blockedReason,
  canSave as fixIsUsable,
  qualityOf,
  SAMPLE_WINDOW_MS,
  summarise,
  type GpsSample,
} from "@/lib/gpsCapture";

interface Point {
  lat: number;
  lng: number;
}

const setBoundaryRef = makeFunctionReference<
  "mutation",
  { sectionId: string; boundary: Point[] },
  { sectionId: string }
>("sections:setSectionBoundary");

const clearBoundaryRef = makeFunctionReference<
  "mutation",
  { sectionId: string },
  { sectionId: string }
>("sections:clearSectionBoundary");

/** Matches the server. Two points are a line, not an area. */
const MIN_CORNERS = 3;

export interface SectionBoundaryEditorProps {
  sectionId: string;
  displayName: string;
  /** The outline as it stands, or null when none has been traced. */
  initial: Point[] | null;
  /** Where to centre the map when there is no outline yet. */
  fallbackCentre: Point;
}

export function SectionBoundaryEditor({
  sectionId,
  displayName,
  initial,
  fallbackCentre,
}: SectionBoundaryEditorProps): ReactElement {
  const setBoundary = useMutation(setBoundaryRef);
  const clearBoundary = useMutation(clearBoundaryRef);

  const [corners, setCorners] = useState<Point[]>(initial ?? []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // GPS corner capture.
  const [sampling, setSampling] = useState(false);
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [remainingMs, setRemainingMs] = useState(SAMPLE_WINDOW_MS);
  const watchRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const shapeLayerRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  const cornersRef = useRef(corners);
  cornersRef.current = corners;

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
  useEffect(() => stopWatching, []);

  // --- the map ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container === null) return;

    (async () => {
      const L = await import("leaflet");
      await import("leaflet/dist/leaflet.css");
      if (cancelled || containerRef.current === null) return;

      const start = initial?.[0] ?? fallbackCentre;
      const map = L.map(container, {
        center: [start.lat, start.lng],
        zoom: 18,
        keyboard: true,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      map.invalidateSize({ animate: false });

      shapeLayerRef.current = L.layerGroup().addTo(map);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.on("click", (e: any) => {
        setCorners((prev) => [
          ...prev,
          { lat: e.latlng.lat as number, lng: e.latlng.lng as number },
        ]);
        setSaved(false);
      });

      mapRef.current = map;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      const map = mapRef.current as { remove?: () => void } | null;
      if (map !== null && typeof map.remove === "function") map.remove();
      mapRef.current = null;
      shapeLayerRef.current = null;
    };
    // Built once. Corners redraw in their own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- redraw the shape ------------------------------------------------
  useEffect(() => {
    if (!ready) return;
    const layer = shapeLayerRef.current as {
      clearLayers: () => void;
      addLayer: (l: unknown) => void;
    } | null;
    if (layer === null) return;

    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled) return;
      layer.clearLayers();

      const pts = corners.map((c) => [c.lat, c.lng] as [number, number]);
      if (pts.length >= MIN_CORNERS) {
        layer.addLayer(
          L.polygon(pts, {
            color: "#1D5C4D",
            weight: 2,
            fillColor: "#1D5C4D",
            fillOpacity: 0.12,
          }),
        );
      } else if (pts.length === 2) {
        layer.addLayer(L.polyline(pts, { color: "#1D5C4D", weight: 2 }));
      }

      // Numbered corners, so the tracing order is visible — an outline
      // whose points are out of order draws a bow tie, and on a faint
      // fill that is easy to miss.
      corners.forEach((c, i) => {
        const m = L.circleMarker([c.lat, c.lng], {
          radius: 6,
          color: "#ffffff",
          weight: 2,
          fillColor: "#1D5C4D",
          fillOpacity: 1,
        });
        m.bindTooltip(String(i + 1), { permanent: true, direction: "top" });
        layer.addLayer(m);
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [corners, ready]);

  // --- a corner from the phone -----------------------------------------
  function captureCorner(): void {
    setError(null);
    setSamples([]);
    setRemainingMs(SAMPLE_WINDOW_MS);

    if (
      typeof navigator === "undefined" ||
      navigator.geolocation === undefined
    ) {
      setError(
        "This device cannot report its position. On a phone, check location is on — and that the site is opened over https, which the browser requires before it will share one.",
      );
      return;
    }

    setSampling(true);
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
      () => {
        stopWatching();
        setSampling(false);
        setError(
          "The phone could not get a fix. Step into the open, away from walls and trees, and try again.",
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: SAMPLE_WINDOW_MS },
    );

    timerRef.current = setInterval(() => {
      const left = SAMPLE_WINDOW_MS - (Date.now() - startedAt);
      setRemainingMs(Math.max(0, left));
      if (left > 0) return;

      stopWatching();
      setSampling(false);
      // Read through the ref: this closure was made before any sample
      // arrived, so `samples` here would be the empty array it started
      // with.
      setSamples((current) => {
        const fix = summarise(current);
        if (!fixIsUsable(fix) || fix === null) {
          setError(
            blockedReason(fix) ??
              "That reading was not good enough to place a corner.",
          );
          return current;
        }
        setCorners((prev) => [...prev, { lat: fix.lat, lng: fix.lng }]);
        setSaved(false);
        const map = mapRef.current as {
          setView?: (c: [number, number], z: number) => void;
        } | null;
        map?.setView?.([fix.lat, fix.lng], 19);
        return current;
      });
    }, 250);
  }

  const liveFix = summarise(samples);
  const enough = corners.length >= MIN_CORNERS;

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await setBoundary({ sectionId, boundary: corners });
      setSaved(true);
    } catch (e: unknown) {
      setError(translateError(e).detail);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="boundary-editor">
      <div
        role="status"
        className="rounded-md border border-surface-border bg-surface-muted px-4 py-3 text-sm text-text-default"
      >
        Click each corner of <strong>{displayName}</strong> in order, going
        around the edge. The shape closes itself.
        <span className="mt-1 block text-xs text-text-muted">
          Standing at a corner? Take it from the phone instead. A garden is
          tens of metres across, so a few metres of GPS error matters far
          less here than it does on a single grave.
        </span>
      </div>

      <div
        ref={containerRef}
        role="application"
        aria-label={`Click to trace the outline of ${displayName}.`}
        data-testid="boundary-map"
        className="isolate w-full overflow-hidden rounded-md border border-surface-border bg-surface-muted"
        style={{ height: "60vh", minHeight: 360 }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="boundary-corner-count"
          className="text-sm text-text-muted"
        >
          {corners.length} corner{corners.length === 1 ? "" : "s"}
          {!enough && corners.length > 0 && (
            <> &middot; need at least {MIN_CORNERS}</>
          )}
        </span>
        <button
          type="button"
          disabled={corners.length === 0 || sampling}
          data-testid="boundary-undo"
          onClick={() => {
            setCorners((prev) => prev.slice(0, -1));
            setSaved(false);
          }}
          className="min-h-[38px] rounded-md border border-surface-border px-3 py-1.5 text-sm font-medium text-text-default disabled:text-text-muted"
        >
          Undo last corner
        </button>
        <button
          type="button"
          disabled={corners.length === 0 || sampling}
          data-testid="boundary-reset"
          onClick={() => {
            setCorners([]);
            setSaved(false);
          }}
          className="min-h-[38px] rounded-md border border-surface-border px-3 py-1.5 text-sm font-medium text-text-default disabled:text-text-muted"
        >
          Start over
        </button>
        <button
          type="button"
          disabled={sampling}
          data-testid="boundary-gps"
          onClick={captureCorner}
          className="min-h-[38px] rounded-md border border-surface-border px-3 py-1.5 text-sm font-medium text-text-default disabled:text-text-muted"
        >
          {sampling
            ? `Holding still… ${Math.ceil(remainingMs / 1000)}s`
            : "Add corner from my location"}
        </button>
      </div>

      {sampling && liveFix !== null && (
        <p data-testid="boundary-gps-reading" className="text-xs text-text-muted">
          ±{Math.round(liveFix.accuracyM)}m &middot;{" "}
          {qualityOf(liveFix.accuracyM).quality} &middot; {liveFix.usedCount}{" "}
          reading{liveFix.usedCount === 1 ? "" : "s"}
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          data-testid="boundary-error"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {error}
        </p>
      )}

      {saved && (
        <p
          role="status"
          data-testid="boundary-saved"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Outline saved. {displayName} is now drawn on the map.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!enough || saving || sampling}
          data-testid="boundary-save"
          onClick={() => void handleSave()}
          className="min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          {saving ? "Saving…" : "Save outline"}
        </button>
        {initial !== null && (
          <button
            type="button"
            disabled={saving || sampling}
            data-testid="boundary-clear"
            onClick={() => {
              setError(null);
              void clearBoundary({ sectionId })
                .then(() => {
                  setCorners([]);
                  setSaved(false);
                })
                .catch((e: unknown) => setError(translateError(e).detail));
            }}
            className="text-xs font-medium text-text-muted underline hover:text-primary"
          >
            Remove the saved outline
          </button>
        )}
      </div>
    </div>
  );
}
