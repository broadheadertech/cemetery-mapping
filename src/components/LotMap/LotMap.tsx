"use client";

import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { DEFAULT_CEMETERY_BBOX, type Bbox } from "@/lib/geometry";
import { useLotsInViewport } from "@/hooks/useLotsInViewport";
import type { LotStatus } from "@/types/lot-status";
import { SvgRenderer } from "./SvgRenderer";

/**
 * LotMap — orchestrator (Story 1.12, extended in Story 8.2).
 *
 * Owns the viewport bbox + filter state lifecycle and dispatches to a
 * renderer. Phase 1 ships `SvgRenderer`; Phase 2 (Story 8.2) adds
 * `LeafletRenderer` as a second implementation chosen at runtime.
 *
 * Renderer selection rules:
 *   - `forceRenderer` prop (if provided) wins — staff override at the
 *     `/map` page lets users toggle.
 *   - Otherwise: if ANY lot in the current viewport has
 *     `geometryStatus === "surveyed"`, switch to Leaflet so the real
 *     GPS context (roads / aerial) is shown. Until the first surveyed
 *     lot lands the SVG renderer is the right call — Leaflet would
 *     just show placeholder markers stacked at the cemetery centroid.
 *
 * The component contract is intentionally stable across the swap:
 * `bbox` / `statusFilters` / `onLotClick` remain the primary inputs;
 * only the internal renderer changes.
 *
 * Bundle discipline (NFR-P6 — 250KB gz initial budget):
 *   - `LeafletRenderer` is referenced ONLY via `next/dynamic` with
 *     `{ ssr: false }`. The 50–70KB Leaflet chunk is fetched on demand
 *     the first time a surveyed lot is visible.
 *   - There is no static `import "leaflet"` anywhere in this file or
 *     in `SvgRenderer`. If you add one, you defeat the lazy-load.
 *
 * Loading / empty states are rendered here (not inside the renderers)
 * so the renderers stay pure presentational components — easier to
 * unit-test, easier to swap.
 */

const LeafletRenderer = dynamic(
  () => import("./LeafletRenderer").then((m) => m.LeafletRenderer),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        data-testid="leaflet-loading"
        aria-busy="true"
        aria-label="Loading interactive map"
        className="flex w-full items-center justify-center rounded-md border border-surface-border bg-surface-muted text-sm text-text-muted"
        style={{ height: "600px" }}
      >
        Loading map…
      </div>
    ),
  },
);

export type LotMapRenderer = "svg" | "leaflet";

export interface LotMapProps {
  /** Initial viewport. Defaults to the cemetery-wide bbox. */
  bbox?: Bbox;
  /** Multi-select status filter. Empty array / undefined = show all. */
  statusFilters?: ReadonlyArray<LotStatus>;
  /** Click handler — typically a router push to /lots/{lotId}. */
  onLotClick: (lotId: string) => void;
  /** Map canvas height in CSS pixels. Default 600. */
  height?: number;
  /** Highlight the currently-selected lot. */
  selectedLotId?: string;
  /**
   * Optional staff override. When set, bypasses the auto-detect
   * (any-surveyed-lot triggers Leaflet) and forces the chosen renderer.
   * Story 8.2 ships a manual toggle on `/map` for power users who want
   * the geographic context regardless of survey state.
   */
  forceRenderer?: LotMapRenderer;
  /** Fly the (Leaflet) map to this point — find-a-grave jump target. */
  focusPoint?: { lat: number; lng: number } | null;
}

export function LotMap({
  bbox,
  statusFilters,
  onLotClick,
  height = 600,
  selectedLotId,
  forceRenderer,
  focusPoint,
}: LotMapProps) {
  // Memoise the parent-supplied initial bbox so a parent re-render
  // without a viewport change doesn't restart the debounce.
  const initialBbox = useMemo<Bbox>(
    () => bbox ?? DEFAULT_CEMETERY_BBOX,
    [bbox],
  );
  // Story 8.2 (HIGH-fix) — track the Leaflet-reported viewport bbox
  // so panning/zooming the map drives `useLotsInViewport` (AC3).
  // The SVG renderer is static (no `moveend`); when only SVG is in
  // play the state stays at `initialBbox`. When the parent passes a
  // new `bbox` prop (e.g. a "reset view" button), the `initialBbox`
  // identity changes and the lazy initializer below is bypassed,
  // but the existing `liveBbox` state is preserved — that's the
  // right call for the typical flow (parent sets initial centre,
  // user pans freely from there).
  const [liveBbox, setLiveBbox] = useState<Bbox>(initialBbox);
  const effectiveBbox = liveBbox;

  const handleLeafletBboxChange = useCallback((next: Bbox) => {
    setLiveBbox(next);
  }, []);

  const { lots, isLoading } = useLotsInViewport({
    bbox: effectiveBbox,
    statusFilters,
  });

  if (isLoading) {
    return (
      <div
        role="status"
        data-testid="map-loading"
        aria-busy="true"
        aria-label="Loading map"
        className="flex w-full items-center justify-center rounded-md border border-surface-border bg-surface-muted text-sm text-text-muted"
        style={{ height: `${height}px` }}
      >
        Loading map…
      </div>
    );
  }

  // `lots` is defined here. Empty viewport → empty state.
  if (lots !== undefined && lots.length === 0) {
    return (
      <div
        role="status"
        data-testid="map-empty"
        className="flex w-full flex-col items-center justify-center gap-2 rounded-md border border-surface-border bg-surface-muted p-6 text-center"
        style={{ height: `${height}px` }}
      >
        <p className="text-sm font-medium text-text-default">
          No lots in this view.
        </p>
        <p className="text-xs text-text-muted">
          Adjust the status filters or wait for lots to be added.
        </p>
      </div>
    );
  }

  const safeLots = lots ?? [];
  const hasSurveyed = safeLots.some((l) => l.geometryStatus === "surveyed");
  const renderer: LotMapRenderer =
    forceRenderer ?? (hasSurveyed ? "leaflet" : "svg");

  const svgFallback = (
    <SvgRenderer
      bbox={effectiveBbox}
      lots={safeLots}
      onLotClick={onLotClick}
      height={height}
      selectedLotId={selectedLotId}
    />
  );

  if (renderer === "leaflet") {
    return (
      <LeafletErrorBoundary fallback={svgFallback}>
        <LeafletRenderer
          bbox={effectiveBbox}
          lots={safeLots}
          onLotClick={onLotClick}
          height={height}
          selectedLotId={selectedLotId}
          onBboxChange={handleLeafletBboxChange}
          focusPoint={focusPoint}
        />
      </LeafletErrorBoundary>
    );
  }

  return svgFallback;
}

/**
 * Story 8.2 (HIGH-fix) — Leaflet runtime ErrorBoundary.
 *
 * Catches any render-time error thrown by `LeafletRenderer` (most
 * commonly the `LeafletLoadFailureError` raised when the dynamic
 * `import("leaflet")` chunk fails) and renders the SVG fallback in
 * place. Without this boundary, a chunk-load failure left the user
 * staring at an inert amber box — the SVG renderer at least shows
 * lot positions even with no tile context.
 *
 * Boundaries MUST be class components per the React docs; this is
 * the only class in the LotMap subtree.
 */
interface LeafletErrorBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface LeafletErrorBoundaryState {
  hasError: boolean;
}

class LeafletErrorBoundary extends Component<
  LeafletErrorBoundaryProps,
  LeafletErrorBoundaryState
> {
  override state: LeafletErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): LeafletErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error("LeafletErrorBoundary: falling back to SVG", error);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}
