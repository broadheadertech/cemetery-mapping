"use client";

/**
 * LotLocationPicker — the Map cockpit's "click to place a lot" surface.
 *
 * Shows an OpenStreetMap tile map; the operator clicks where the lot is
 * and the marker moves there. Saving calls `lots:setLotLocation`, which
 * stores the clicked point as the centroid and auto-draws a footprint
 * from the lot's own dimensions. This is the point-at-the-map alternative
 * to typing coordinates / uploading a CSV.
 *
 * Leaflet discipline (mirrors LeafletRenderer):
 *   - `import("leaflet")` + its CSS happen inside `useEffect`, never at
 *     module load, so `window` is never touched during SSR.
 *   - The initial view is non-animated and the container size is settled
 *     with `invalidateSize` first — avoids the `_leaflet_pos` init crash.
 *   - A circle marker (not `L.marker`) sidesteps Leaflet's broken
 *     default-icon asset resolution under bundlers.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
import { LotGpsCapture } from "@/components/LotGpsCapture";

/**
 * The lots already placed around this one.
 *
 * Placing a grave on a blank tile map is guesswork: there is nothing on
 * screen to say which way the rows run or where the garden even starts,
 * so the only reference is a satellite-less road layout a hundred
 * metres away. The neighbours are the reference — put the marker at the
 * end of the row it belongs to, not at a coordinate.
 */
interface NeighbourLot {
  _id: string;
  code: string;
  section: string;
  status: string;
  geometry: { centroid: { lat: number; lng: number } } | null;
  geometryStatus: "placeholder" | "surveyed";
}

const listInBboxRef = makeFunctionReference<
  "query",
  {
    bboxMinLat: number;
    bboxMaxLat: number;
    bboxMinLng: number;
    bboxMaxLng: number;
    limit: number;
  },
  NeighbourLot[]
>("lots:listInBbox");

/** How far around the lot to show, in degrees. Roughly 250m. */
const CONTEXT_SPAN = 0.00225;

/** Brand palette, matching the 3D map's legend. */
const STATUS_COLOUR: Record<string, string> = {
  available: "#8FBF9F",
  reserved: "#C9A96B",
  sold: "#8C9BC4",
  occupied: "#1D5C4D",
  defaulted: "#C46A6A",
};

const setLotLocationRef = makeFunctionReference<
  "mutation",
  { lotId: string; lat: number; lng: number },
  null
>("lots:setLotLocation");

export interface LotLocationPickerProps {
  lotId: string;
  lotCode: string;
  /** Initial map centre + marker — the lot's current centroid, or the
   *  cemetery default when it has none yet. */
  initial: { lat: number; lng: number };
  /** Whether the lot already has surveyed geometry (affects the copy). */
  surveyed: boolean;
}

export function LotLocationPicker({
  lotId,
  lotCode,
  initial,
  surveyed,
}: LotLocationPickerProps) {
  const router = useRouter();
  const setLotLocation = useMutation(setLotLocationRef);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);

  const [point, setPoint] = useState<{ lat: number; lng: number }>(initial);
  const [showContext, setShowContext] = useState(true);

  /*
   * A fixed window around where the lot started, NOT around the marker.
   *
   * Following the marker would re-query on every click and re-draw the
   * neighbours underneath the thing being dragged, which is both
   * distracting and pointless — 250m of context does not meaningfully
   * change when you move a grave three metres.
   */
  const neighbours = useQuery(listInBboxRef, {
    bboxMinLat: initial.lat - CONTEXT_SPAN,
    bboxMaxLat: initial.lat + CONTEXT_SPAN,
    bboxMinLng: initial.lng - CONTEXT_SPAN,
    bboxMaxLng: initial.lng + CONTEXT_SPAN,
    limit: 200,
  });

  /** Only lots somebody actually placed, and never this one. */
  const placedNeighbours = useMemo(
    () =>
      (neighbours ?? []).filter(
        (l) =>
          l._id !== lotId &&
          l.geometryStatus === "surveyed" &&
          l.geometry !== null,
      ),
    [neighbours, lotId],
  );
  const neighboursRef = useRef(placedNeighbours);
  neighboursRef.current = placedNeighbours;
  const contextLayerRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container === null) return;

    (async () => {
      const L = await import("leaflet");
      await import("leaflet/dist/leaflet.css");
      if (cancelled || containerRef.current === null) return;

      const map = L.map(container, {
        center: [initial.lat, initial.lng],
        zoom: 18,
        keyboard: true,
        attributionControl: true,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);
      map.invalidateSize({ animate: false });

      const marker = L.circleMarker([initial.lat, initial.lng], {
        radius: 9,
        color: "#1D5C4D",
        fillColor: "#1D5C4D",
        fillOpacity: 0.7,
        weight: 3,
      }).addTo(map);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.on("click", (e: any) => {
        const lat = e.latlng.lat as number;
        const lng = e.latlng.lng as number;
        marker.setLatLng([lat, lng]);
        setPoint({ lat, lng });
      });

      // Their own layer, so they can be redrawn or hidden without
      // touching the map or the marker being placed.
      contextLayerRef.current = L.layerGroup().addTo(map);

      mapRef.current = map;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      const map = mapRef.current as { remove?: () => void } | null;
      if (map !== null && typeof map.remove === "function") map.remove();
      mapRef.current = null;
    };
  }, [initial.lat, initial.lng]);

  /*
   * Paint the neighbours whenever they arrive or are toggled.
   *
   * A separate effect from the map bootstrap on purpose: the map is
   * built once, and lots loading a moment later must not rebuild it.
   */
  useEffect(() => {
    if (!ready) return;
    const layer = contextLayerRef.current as {
      clearLayers?: () => void;
      addLayer?: (l: unknown) => void;
    } | null;
    if (layer === null || typeof layer.clearLayers !== "function") return;

    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled) return;
      layer.clearLayers?.();
      if (!showContext) return;

      for (const n of neighboursRef.current) {
        const c = n.geometry!.centroid;
        const marker = L.circleMarker([c.lat, c.lng], {
          radius: 5,
          color: "#ffffff",
          weight: 1,
          fillColor: STATUS_COLOUR[n.status] ?? "#8C9BC4",
          fillOpacity: 0.85,
        });
        marker.bindTooltip(`${n.code} · ${n.status}`, { direction: "top" });
        layer.addLayer?.(marker);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, showContext, placedNeighbours]);

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await setLotLocation({ lotId, lat: point.lat, lng: point.lng });
      router.push(`/lots/${lotId}`);
    } catch (err) {
      setError(translateError(err).detail);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        role="status"
        className="rounded-md border border-surface-border bg-surface-muted px-4 py-3 text-sm text-text-default"
      >
        Click the map where lot <strong>{lotCode}</strong> sits. The system
        draws the lot&apos;s footprint from its recorded dimensions around the
        point you choose.
        {surveyed && (
          <span className="mt-1 block text-xs text-text-muted">
            This lot already has a location — clicking sets a new one.
          </span>
        )}
      </div>

      {/*
        What else is out there, and the choice to hide it.

        Placing a grave on a blank tile map is guesswork — there is
        nothing on screen to say which way the rows run. The neighbours
        are the reference. Hiding them matters too: when the lot being
        placed sits under a cluster of others, the marker is the thing
        you need to see.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-border bg-surface-base px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            Nearby lots
          </span>
          {placedNeighbours.length === 0 ? (
            <span
              data-testid="picker-context-empty"
              className="text-xs text-text-muted"
            >
              {neighbours === undefined
                ? "Loading…"
                : "None placed nearby yet — this is the first."}
            </span>
          ) : (
            <span
              data-testid="picker-context-count"
              className="text-xs text-text-muted"
            >
              {placedNeighbours.length} shown
            </span>
          )}
          <span className="flex flex-wrap items-center gap-2">
            {(
              [
                ["available", "Available"],
                ["reserved", "Reserved"],
                ["sold", "Sold"],
                ["occupied", "Occupied"],
              ] as Array<[string, string]>
            ).map(([key, label]) => (
              <span key={key} className="flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ background: STATUS_COLOUR[key] }}
                />
                <span className="text-[11px] text-text-muted">{label}</span>
              </span>
            ))}
          </span>
        </div>
        <button
          type="button"
          data-testid="picker-context-toggle"
          onClick={() => setShowContext((v) => !v)}
          className="text-xs font-medium text-text-muted underline hover:text-primary"
        >
          {showContext ? "Hide nearby lots" : "Show nearby lots"}
        </button>
      </div>

      <div
        ref={containerRef}
        role="application"
        aria-label={`Click to place lot ${lotCode}. Arrow keys pan; plus and minus zoom.`}
        data-testid="lot-location-picker"
      /*
       * `isolate` is load-bearing, not cosmetic.
       *
       * Leaflet's own stylesheet puts `.leaflet-pane` at z-index 400 and
       * its controls at 1000. Without a stacking context here those
       * numbers compete in the ROOT context, against app chrome that
       * sits at z-50 — so the map painted straight over any dialog,
       * popover or tooltip portalled to <body>. Clicking a lot opened
       * its action menu and the menu was drawn behind the map: visible
       * above the map's top edge, gone everywhere else.
       *
       * Isolating contains Leaflet's internal ordering to this element,
       * where it belongs. Raising the dialog's z-index instead would
       * have fixed one dialog and left every other overlay to lose the
       * same fight.
       */
        className="isolate w-full overflow-hidden rounded-md border border-surface-border bg-surface-muted"
        style={{ height: "60vh", minHeight: 360 }}
      />

      {/*
        The other way to answer the same question.

        This screen asks "where is this lot", and until now the only
        answer it accepted was a click — which means being somewhere
        else and pointing. Somebody standing AT the grave has the better
        answer and had to go to a different page to give it.
      */}
      <LotGpsCapture
        lotId={lotId}
        lotCode={lotCode}
        alreadyPlaced={surveyed}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-xs text-text-muted">
          {ready
            ? `Selected: ${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`
            : "Loading map…"}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.push(`/lots/${lotId}`)}
            className="inline-flex min-h-[44px] items-center rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default hover:bg-surface-emphasis"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !ready}
            className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save location"}
          </button>
        </div>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}
    </div>
  );
}

export default LotLocationPicker;
