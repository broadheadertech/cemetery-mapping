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
} from "@/lib/gpsCapture";
import { useGpsCapture } from "@/hooks/useGpsCapture";

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

  /*
   * Corner capture, on the same shared lifecycle as the lot panel.
   *
   * This screen had its own copy, with the same three bugs: a
   * fifteen-second per-acquisition timeout that a cold GPS cannot
   * meet, a countdown that started before the first fix instead of
   * with it, and an abort on every error including the routine ones.
   */
  const gps = useGpsCapture();
  const [pendingCorner, setPendingCorner] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const shapeLayerRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  const cornersRef = useRef(corners);
  cornersRef.current = corners;

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

  /*
   * A corner from the phone.
   *
   * The capture runs on the shared hook; this only decides what to do
   * with the result. `pendingCorner` marks that a capture in flight is
   * meant to become a corner, so a reading is never silently appended
   * twice or appended after the person moved on.
   */
  function captureCorner(): void {
    setError(null);
    setPendingCorner(true);
    gps.start();
  }

  useEffect(() => {
    if (!pendingCorner || gps.phase !== "done") return;
    setPendingCorner(false);

    const fix = gps.fix;
    if (!fixIsUsable(fix) || fix === null) {
      setError(
        blockedReason(fix) ??
          "That reading was not good enough to place a corner.",
      );
      gps.reset();
      return;
    }

    setCorners((prev) => [...prev, { lat: fix.lat, lng: fix.lng }]);
    setSaved(false);
    const map = mapRef.current as {
      setView?: (c: [number, number], z: number) => void;
    } | null;
    map?.setView?.([fix.lat, fix.lng], 19);
    gps.reset();
  }, [pendingCorner, gps]);

  const liveFix = gps.fix;
  const enough = corners.length >= MIN_CORNERS;
  /** A capture is in flight; every control that would disturb it waits. */
  const busy = gps.phase === "locating" || gps.phase === "sampling";

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
          disabled={corners.length === 0 || busy}
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
          disabled={corners.length === 0 || busy}
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
          disabled={busy}
          data-testid="boundary-gps"
          onClick={captureCorner}
          className="min-h-[38px] rounded-md border border-surface-border px-3 py-1.5 text-sm font-medium text-text-default disabled:text-text-muted"
        >
          {gps.phase === "locating"
            ? `Finding satellites… ${Math.round(gps.waitedMs / 1000)}s`
            : gps.phase === "sampling"
              ? `Holding still… ${Math.ceil(gps.remainingMs / 1000)}s`
              : "Add corner from my location"}
        </button>
      </div>

      {busy && liveFix !== null && (
        <p data-testid="boundary-gps-reading" className="text-xs text-text-muted">
          ±{Math.round(liveFix.accuracyM)}m &middot;{" "}
          {qualityOf(liveFix.accuracyM).quality} &middot; {liveFix.usedCount}{" "}
          reading{liveFix.usedCount === 1 ? "" : "s"}
        </p>
      )}

      {(error ?? gps.error) !== null && (
        <p
          role="alert"
          data-testid="boundary-error"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {error ?? gps.error}
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
          disabled={!enough || saving || busy}
          data-testid="boundary-save"
          onClick={() => void handleSave()}
          className="min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          {saving ? "Saving…" : "Save outline"}
        </button>
        {initial !== null && (
          <button
            type="button"
            disabled={saving || busy}
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
