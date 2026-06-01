"use client";

import { useState } from "react";
import {
  bboxToSvgViewBox,
  latLngToSvgPoint,
  placeholderRadiusForBbox,
  polygonToSvgPoints,
  strokeWidthForBbox,
  type Bbox,
} from "@/lib/geometry";
import { LABEL_MAP } from "@/components/ui/StatusPill/icons";
import type { LotForMap } from "@/hooks/useLotsInViewport";

/**
 * SvgRenderer — Phase 1 map renderer (Story 1.12).
 *
 * Pure presentational component. Takes a viewport bbox and a lot list,
 * renders an `<svg>` containing one `<polygon>` (or `<circle>` for
 * placeholder-geometry lots) per lot. Click / Enter / Space on a lot
 * invokes `onLotClick(lotId)`.
 *
 * Phase 1 architectural commitments honoured here:
 *   - No leaflet import. The renderer is pure SVG.
 *   - No d3 / proj4 / turf. Equirectangular projection via
 *     `src/lib/geometry.ts`.
 *   - Polygon fills use the `bg-status-{state}-bg` Tailwind utility from
 *     Story 1.4's palette. Tailwind's JIT keeps the resolved colour in
 *     the CSS bundle; the renderer just attaches the class.
 *   - Placeholder-geometry lots render as a small circle at the
 *     centroid (Phase 2 GPS-survey will replace these with real
 *     polygons). The placeholder aria-label includes "(approximate
 *     location)" so screen-reader users understand the marker is
 *     positional rather than authoritative.
 *
 * Performance:
 *   - Caps rendered lots at `MAX_RENDERED` (200 per architecture). The
 *     server query is also capped, so this is a defence-in-depth
 *     ceiling.
 *   - Hover tooltip is rendered as a single SVG `<g>` overlay rather
 *     than React state per polygon; the alternative (one
 *     `useState` per polygon) would re-render the entire renderer on
 *     every mouseenter.
 */

const MAX_RENDERED = 200;

const STATUS_COLOR_CLASS: Record<LotForMap["status"], string> = {
  // The fill utilities use Tailwind v3 JIT — the resolved colour comes
  // from `tailwind.config.ts → theme.extend.colors.status.{state}.bg`.
  // We use `fill-` (not `bg-`) because these go on SVG elements.
  available: "fill-status-available-bg",
  reserved: "fill-status-reserved-bg",
  sold: "fill-status-sold-bg",
  occupied: "fill-status-occupied-bg",
  cancelled: "fill-status-cancelled-bg",
  defaulted: "fill-status-defaulted-bg",
  transferred: "fill-status-transferred-bg",
};

const STATUS_STROKE_CLASS: Record<LotForMap["status"], string> = {
  available: "stroke-status-available-border",
  reserved: "stroke-status-reserved-border",
  sold: "stroke-status-sold-border",
  occupied: "stroke-status-occupied-border",
  cancelled: "stroke-status-cancelled-border",
  defaulted: "stroke-status-defaulted-border",
  transferred: "stroke-status-transferred-border",
};

export interface SvgRendererProps {
  bbox: Bbox;
  lots: LotForMap[];
  onLotClick: (lotId: string) => void;
  /** Optional aspect-driven max height in CSS units. Defaults to 600px. */
  height?: number;
  /** Selected lot id — receives a thicker stroke for visual emphasis. */
  selectedLotId?: string;
}

interface HoverState {
  lotId: string;
  code: string;
  status: LotForMap["status"];
  // Tooltip anchor coords in SVG user-space (NOT pixel-space).
  x: number;
  y: number;
}

export function SvgRenderer({
  bbox,
  lots,
  onLotClick,
  height = 600,
  selectedLotId,
}: SvgRendererProps) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const viewBox = bboxToSvgViewBox(bbox);
  const strokeWidth = strokeWidthForBbox(bbox);
  const placeholderRadius = placeholderRadiusForBbox(bbox);
  const selectedStrokeWidth = strokeWidth * 3;

  // Cap the rendered list at MAX_RENDERED. The server already enforces
  // this but a defence-in-depth ceiling guards against a future query
  // accidentally raising the limit.
  const visible = lots.slice(0, MAX_RENDERED);
  const truncated = lots.length > MAX_RENDERED;

  return (
    <div className="relative w-full" data-testid="svg-renderer">
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Cemetery map showing ${visible.length} lots`}
        className="w-full select-none rounded-md border border-surface-border bg-surface-muted"
        style={{ height: `${height}px` }}
      >
        {/* Background tile — solid muted fill behind any lot shapes. */}
        <rect
          x={bbox.bboxMinLng - 0.001}
          y={-bbox.bboxMaxLat - 0.001}
          width={bbox.bboxMaxLng - bbox.bboxMinLng + 0.002}
          height={bbox.bboxMaxLat - bbox.bboxMinLat + 0.002}
          className="fill-surface-muted"
        />

        <g data-testid="lots-layer">
          {visible.map((lot) => {
            const isSelected = lot._id === selectedLotId;
            const ariaLabel = `Lot ${lot.code}, ${LABEL_MAP[lot.status]}${
              lot.geometryStatus === "placeholder"
                ? " (approximate location)"
                : ""
            }`;

            const onActivate = () => onLotClick(lot._id);
            const onKeyDown = (e: React.KeyboardEvent<SVGElement>) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate();
              }
            };

            // Placeholder geometry → circle at centroid.
            if (
              lot.geometryStatus === "placeholder" ||
              lot.geometry.polygon.length < 3
            ) {
              const { x, y } = latLngToSvgPoint(lot.geometry.centroid);
              return (
                <circle
                  key={lot._id}
                  cx={x}
                  cy={y}
                  r={placeholderRadius}
                  role="button"
                  tabIndex={0}
                  aria-label={ariaLabel}
                  data-lot-id={lot._id}
                  data-lot-code={lot.code}
                  data-lot-status={lot.status}
                  data-geometry-status={lot.geometryStatus}
                  className={`${STATUS_COLOR_CLASS[lot.status]} ${STATUS_STROKE_CLASS[lot.status]} cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
                  style={{
                    strokeWidth: isSelected
                      ? selectedStrokeWidth
                      : strokeWidth,
                  }}
                  onClick={onActivate}
                  onKeyDown={onKeyDown}
                  onMouseEnter={() =>
                    setHover({
                      lotId: lot._id,
                      code: lot.code,
                      status: lot.status,
                      x,
                      y,
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                  onFocus={() =>
                    setHover({
                      lotId: lot._id,
                      code: lot.code,
                      status: lot.status,
                      x,
                      y,
                    })
                  }
                  onBlur={() => setHover(null)}
                />
              );
            }

            // Surveyed geometry → polygon.
            const points = polygonToSvgPoints(lot.geometry.polygon);
            // Tooltip anchor at the polygon centroid.
            const { x: cx, y: cy } = latLngToSvgPoint(lot.geometry.centroid);
            return (
              <polygon
                key={lot._id}
                points={points ?? ""}
                role="button"
                tabIndex={0}
                aria-label={ariaLabel}
                data-lot-id={lot._id}
                data-lot-code={lot.code}
                data-lot-status={lot.status}
                data-geometry-status={lot.geometryStatus}
                className={`${STATUS_COLOR_CLASS[lot.status]} ${STATUS_STROKE_CLASS[lot.status]} cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
                style={{
                  strokeWidth: isSelected ? selectedStrokeWidth : strokeWidth,
                }}
                onClick={onActivate}
                onKeyDown={onKeyDown}
                onMouseEnter={() =>
                  setHover({
                    lotId: lot._id,
                    code: lot.code,
                    status: lot.status,
                    x: cx,
                    y: cy,
                  })
                }
                onMouseLeave={() => setHover(null)}
                onFocus={() =>
                  setHover({
                    lotId: lot._id,
                    code: lot.code,
                    status: lot.status,
                    x: cx,
                    y: cy,
                  })
                }
                onBlur={() => setHover(null)}
              />
            );
          })}
        </g>
      </svg>

      {/* HTML-overlay tooltip — positioned via the SVG-to-screen
         projection. Using HTML rather than SVG `<text>` lets us reuse
         the Tailwind type tokens and keeps the tooltip legible at any
         zoom level. */}
      {hover !== null && (
        <div
          role="tooltip"
          data-testid="lot-tooltip"
          className="pointer-events-none absolute z-10 rounded-md border border-surface-border bg-surface-base px-2 py-1 text-xs font-medium text-text-default shadow-md"
          style={{
            // Convert the tooltip anchor (lng, -lat) to a percentage of
            // the SVG viewBox so the overlay tracks zoom/pan via CSS.
            left: `${((hover.x - bbox.bboxMinLng) / Math.max(bbox.bboxMaxLng - bbox.bboxMinLng, 0.0001)) * 100}%`,
            top: `${((-hover.y - bbox.bboxMinLat) / Math.max(bbox.bboxMaxLat - bbox.bboxMinLat, 0.0001)) * 100}%`,
            transform: "translate(-50%, calc(-100% - 8px))",
          }}
        >
          <span className="font-semibold">{hover.code}</span>
          <span className="mx-1 text-text-muted">·</span>
          <span>{LABEL_MAP[hover.status]}</span>
        </div>
      )}

      {truncated && (
        <div
          role="status"
          data-testid="renderer-truncation-notice"
          className="absolute right-2 top-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
        >
          Showing first {MAX_RENDERED} lots — narrow the view or apply
          filters to see more.
        </div>
      )}
    </div>
  );
}
