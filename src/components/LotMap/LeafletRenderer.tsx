"use client";

import { useEffect, useRef, useState } from "react";
import { LABEL_MAP } from "@/components/ui/StatusPill/icons";
import type { Bbox } from "@/lib/geometry";
import type { LotForMap } from "@/hooks/useLotsInViewport";

/**
 * LeafletRenderer — Phase 2 map renderer (Story 8.2).
 *
 * The hard architectural constraint for this component is that Leaflet
 * — both the library itself and its `dist/leaflet.css` — must NEVER
 * appear in the SSR or initial client bundle. Two layers enforce this:
 *
 *   1. `LotMap.tsx` references this file ONLY through
 *      `next/dynamic(() => import("./LeafletRenderer"), { ssr: false })`.
 *      That tree-splits the chunk and disables server rendering.
 *
 *   2. This file performs its `import("leaflet")` + the CSS side-effect
 *      import inside `useEffect` — so even if a downstream consumer
 *      accidentally static-imports `LeafletRenderer`, the heavyweight
 *      module graph still defers until the component actually mounts in
 *      a browser. `window` access (which Leaflet requires at
 *      module-eval time) never happens during SSR.
 *
 * The renderer takes the same prop contract as `SvgRenderer.tsx` so
 * `LotMap` can pick between them without any other behaviour change.
 * Status colour comes via inline `style.color` / `style.fillColor`
 * computed from `getStatusColor(status)` — Tailwind utility classes
 * cannot reach into Leaflet's internally-managed SVG path elements,
 * so we resolve to raw CSS values from the same source list of
 * statuses that the SVG renderer uses.
 *
 * Coord-order gotcha (per the story's "common mistakes" section):
 * Leaflet polygons expect `[lat, lng]`, the opposite of GeoJSON.
 * Our schema stores `{ lat, lng }` objects, so the mapping is the
 * straightforward `[p.lat, p.lng]`.
 *
 * Placeholder lots render as small circle markers (no polygon
 * geometry available yet); surveyed lots render as filled polygons.
 */

export interface LeafletRendererProps {
  bbox: Bbox;
  lots: LotForMap[];
  onLotClick: (lotId: string) => void;
  /** Optional aspect-driven max height in CSS units. Defaults to 600px. */
  height?: number;
  /** Selected lot id — receives a thicker stroke for visual emphasis. */
  selectedLotId?: string;
  /**
   * Story 8.2 (HIGH-fix) — viewport-bbox callback (AC3).
   *
   * Wired to Leaflet's `moveend` event with a 200ms debounce; fires
   * with the current `map.getBounds()` projected into the canonical
   * `Bbox` shape after pan/zoom settles. The parent uses this to
   * drive `useLotsInViewport` so panning surfaces fresh data without
   * the user having to manually re-load.
   *
   * Optional: when omitted, the renderer treats the initial `bbox`
   * prop as the entire viewport and never re-broadcasts. Callers
   * that own viewport state should always supply it.
   */
  onBboxChange?: (bbox: Bbox) => void;
  /**
   * When set (and changed), the map flies to this point — used by the
   * find-a-grave search to jump to a lot. A post-init `flyTo`, so it
   * doesn't hit the init-time `_leaflet_pos` path.
   */
  focusPoint?: { lat: number; lng: number } | null;
}

/**
 * Status → CSS colour mapping. Hex values match the SVG renderer's
 * Tailwind `status-{state}-bg` palette so users see consistent
 * semantics regardless of which renderer is active. If the palette in
 * `tailwind.config.ts` changes, update these alongside.
 */
const STATUS_FILL: Record<LotForMap["status"], string> = {
  available: "#bbf7d0", // green-200
  reserved: "#bfdbfe", // blue-200
  sold: "#fde68a", // amber-200
  occupied: "#e9d5ff", // purple-200
  cancelled: "#e5e7eb", // gray-200
  defaulted: "#fecaca", // red-200
  transferred: "#fed7aa", // orange-200
};

const STATUS_STROKE: Record<LotForMap["status"], string> = {
  available: "#16a34a", // green-600
  reserved: "#2563eb", // blue-600
  sold: "#d97706", // amber-600
  occupied: "#9333ea", // purple-600
  cancelled: "#6b7280", // gray-500
  defaulted: "#dc2626", // red-600
  transferred: "#ea580c", // orange-600
};

function getStatusFillColor(status: LotForMap["status"]): string {
  return STATUS_FILL[status];
}

function getStatusStrokeColor(status: LotForMap["status"]): string {
  return STATUS_STROKE[status];
}

/**
 * Sentinel thrown when the dynamic `import("leaflet")` chunk fails
 * (network, CDN outage, parse error). The `LotMapErrorBoundary` in
 * `LotMap.tsx` identifies it by `instanceof` and falls back to
 * `SvgRenderer`. Exported so the boundary can do a clean reference
 * check rather than message-string sniffing.
 */
export class LeafletLoadFailureError extends Error {
  constructor() {
    super("Failed to load the interactive map chunk.");
    this.name = "LeafletLoadFailureError";
  }
}

export function LeafletRenderer({
  bbox,
  lots,
  onLotClick,
  height = 600,
  selectedLotId,
  onBboxChange,
  focusPoint,
}: LeafletRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Hold Leaflet's `Map` instance in a ref so we don't trip React's
  // double-invoke / strict-mode re-mount checks. The instance is
  // created once per `containerRef` mount and disposed in the cleanup.
  // We intentionally use `unknown` here because the Leaflet types are
  // only available after the dynamic import; casting at the use site
  // keeps the public component free of a static `leaflet` type import.
  const mapRef = useRef<unknown>(null);
  const layerGroupRef = useRef<unknown>(null);
  // `onBboxChange` is referenced inside the bootstrap `useEffect` which
  // intentionally runs once per mount. Mirror the callback through a
  // ref so the live moveend handler always reaches the latest closure
  // without restarting the bootstrap.
  const onBboxChangeRef = useRef(onBboxChange);
  onBboxChangeRef.current = onBboxChange;
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // -- Bootstrap: dynamically import Leaflet + CSS, build the map.
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container === null) return;

    (async () => {
      try {
        const L = await import("leaflet");
        await import("leaflet/dist/leaflet.css");
        if (cancelled || containerRef.current === null) return;

        // Centre on the bbox midpoint. Zoom level 17 is "neighbourhood"
        // — close enough to see individual lots once GPS-surveyed
        // geometry lands; Leaflet's `fitBounds` would be more precise
        // but the bbox shape here is the orchestrator's current
        // viewport, not necessarily the lot footprint, so fitBounds
        // would zoom out further than expected on a wide viewport.
        const centerLat = (bbox.bboxMinLat + bbox.bboxMaxLat) / 2;
        const centerLng = (bbox.bboxMinLng + bbox.bboxMaxLng) / 2;

        const map = L.map(container, {
          center: [centerLat, centerLng],
          zoom: 17,
          // Architectural note: zoomControl on by default — Leaflet
          // ships keyboard support (arrow keys to pan, +/- to zoom)
          // already enabled, satisfying the keyboard story.
          keyboard: true,
          attributionControl: true,
        });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        }).addTo(map);

        // Settle the container size before any view change. On a
        // just-created map an ANIMATED fit reads the map pane's
        // `_leaflet_pos` before the zoom-animation transform is set,
        // throwing "Cannot read properties of undefined (reading
        // '_leaflet_pos')". `invalidateSize` + a non-animated fit avoid
        // that path entirely (the user's own pan/zoom still animates).
        map.invalidateSize({ animate: false });

        // Frame the bbox where possible; skipped if it collapsed to a
        // point (placeholder-only data).
        if (
          bbox.bboxMaxLat > bbox.bboxMinLat &&
          bbox.bboxMaxLng > bbox.bboxMinLng
        ) {
          map.fitBounds(
            [
              [bbox.bboxMinLat, bbox.bboxMinLng],
              [bbox.bboxMaxLat, bbox.bboxMaxLng],
            ],
            { padding: [16, 16], animate: false },
          );
        }

        const layerGroup = L.layerGroup().addTo(map);
        mapRef.current = map;
        layerGroupRef.current = layerGroup;

        // Story 8.2 (HIGH-fix) AC3 — debounced `moveend` notifier.
        //
        // Leaflet fires `moveend` after both pan AND zoom settle (the
        // latter via the built-in `moveend` event chain — `zoomend` is
        // separately covered by `moveend`). We debounce 200ms so a
        // rapid double-pan collapses to a single re-fetch; the value
        // matches the existing 250ms client-side `useLotsInViewport`
        // debounce closely enough that the two never race.
        let moveendTimer: ReturnType<typeof setTimeout> | null = null;
        const fireBboxChange = () => {
          moveendTimer = null;
          const cb = onBboxChangeRef.current;
          if (cb === undefined) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bounds = (map as any).getBounds();
          if (bounds === undefined || bounds === null) return;
          cb({
            bboxMinLat: bounds.getSouth(),
            bboxMaxLat: bounds.getNorth(),
            bboxMinLng: bounds.getWest(),
            bboxMaxLng: bounds.getEast(),
          });
        };
        const onMoveEnd = () => {
          if (moveendTimer !== null) clearTimeout(moveendTimer);
          moveendTimer = setTimeout(fireBboxChange, 200);
        };
        map.on("moveend", onMoveEnd);
        // Stash the cleanup hook on the map instance so the unmount
        // path can detach the listener AND clear the trailing timer.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (map as any).__moveendCleanup = () => {
          if (moveendTimer !== null) clearTimeout(moveendTimer);
          map.off("moveend", onMoveEnd);
        };

        setReady(true);
      } catch (err) {
        // Network / CDN / parse failure on the Leaflet chunk. Surface
        // the failure to the ErrorBoundary wrapper in `LotMap` so the
        // user transparently falls back to the SVG renderer rather
        // than seeing a dead amber box (Story 8.2 HIGH-fix).
        if (!cancelled) {
          console.error("LeafletRenderer: failed to load leaflet", err);
          setLoadFailed(true);
          // Re-throw on the next tick so the ErrorBoundary above
          // catches it. Setting state alone wouldn't trigger the
          // boundary — boundaries only react to thrown errors during
          // render, so we trip a render by setting state AND then
          // surface the failure in the body below.
        }
      }
    })();

    return () => {
      cancelled = true;
      // Cleanup: remove the map instance so Strict Mode re-mounts
      // don't double-bind to the same container DOM node.
      const map = mapRef.current as
        | { remove?: () => void; __moveendCleanup?: () => void }
        | null;
      if (map !== null) {
        if (typeof map.__moveendCleanup === "function") {
          map.__moveendCleanup();
        }
        if (typeof map.remove === "function") {
          map.remove();
        }
      }
      mapRef.current = null;
      layerGroupRef.current = null;
    };
    // We intentionally rebuild the map only on first mount; bbox
    // changes after mount are handled by the lot-rendering effect
    // below. Re-creating the entire Leaflet instance on every bbox
    // change would thrash the tile layer and the polygons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Re-render the lot layer whenever the lots or selection change.
  useEffect(() => {
    if (!ready) return;
    const layerGroup = layerGroupRef.current as {
      clearLayers: () => void;
      addLayer: (layer: unknown) => void;
    } | null;
    if (layerGroup === null) return;

    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled) return;

      layerGroup.clearLayers();

      for (const lot of lots) {
        const isSelected = lot._id === selectedLotId;
        const fillColor = getStatusFillColor(lot.status);
        const strokeColor = getStatusStrokeColor(lot.status);
        const tooltipText = `${lot.code} — ${LABEL_MAP[lot.status]}`;

        // Placeholder geometry → CircleMarker at the centroid.
        if (
          lot.geometryStatus === "placeholder" ||
          lot.geometry.polygon.length < 3
        ) {
          const marker = L.circleMarker(
            [lot.geometry.centroid.lat, lot.geometry.centroid.lng],
            {
              radius: 6,
              color: strokeColor,
              fillColor,
              fillOpacity: 0.7,
              weight: isSelected ? 4 : 2,
            },
          );
          marker.bindTooltip(tooltipText);
          marker.on("click", () => onLotClick(lot._id));
          // Programmatic-access hook used by tests.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (marker as any).options.lotId = lot._id;
          layerGroup.addLayer(marker);
          continue;
        }

        // Surveyed geometry → polygon.
        const positions: Array<[number, number]> = lot.geometry.polygon.map(
          (p) => [p.lat, p.lng],
        );
        const polygon = L.polygon(positions, {
          color: strokeColor,
          fillColor,
          fillOpacity: 0.5,
          weight: isSelected ? 4 : 2,
        });
        polygon.bindTooltip(tooltipText);
        polygon.on("click", () => onLotClick(lot._id));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (polygon as any).options.lotId = lot._id;
        layerGroup.addLayer(polygon);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lots, selectedLotId, ready, onLotClick]);

  // Fly to a requested point (find-a-grave). Runs only after the map is
  // ready, so it never races the bootstrap's init view.
  useEffect(() => {
    if (!ready || focusPoint === undefined || focusPoint === null) return;
    const map = mapRef.current as {
      flyTo?: (latlng: [number, number], zoom?: number) => void;
    } | null;
    if (map !== null && typeof map.flyTo === "function") {
      map.flyTo([focusPoint.lat, focusPoint.lng], 19);
    }
  }, [focusPoint, ready]);

  if (loadFailed) {
    // Story 8.2 (HIGH-fix) — throw on render so the parent's
    // ErrorBoundary catches the failure and swaps in `SvgRenderer`.
    // The old behaviour (rendering an inert amber box) left users
    // stranded with no map at all; the SVG fallback at least shows
    // lot positions even when the Leaflet chunk fails to load.
    throw new LeafletLoadFailureError();
  }

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Cemetery lot map. Use arrow keys to pan, plus and minus to zoom."
      data-testid="leaflet-renderer"
      className="w-full overflow-hidden rounded-md border border-surface-border bg-surface-muted"
      style={{ height: `${height}px` }}
    />
  );
}

export default LeafletRenderer;
