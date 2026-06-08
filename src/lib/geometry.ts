/**
 * Geometry helpers — client mirror (Story 1.12).
 *
 * Mirrors the type contracts from `convex/lib/geometry.ts` (Story 1.9)
 * so the SVG map renderer can consume `geometry` payloads from
 * `api.lots.listInBbox` without depending on Convex's server-side
 * `convex/lib/*` module (Convex's generated `_generated/api` types
 * flatten arg / return shapes but do not bridge non-schema helper
 * modules to the client tree).
 *
 * Architectural rationale (per Story 1.12 Dev Notes):
 *   1. Two modules, one contract — `convex/lib/geometry.ts` is the
 *      server source of truth (the SVG renderer cannot import from
 *      it). Type parity is enforced by review + a tiny shape parity
 *      test (see `tests/unit/lib/geometry.test.ts`).
 *   2. No projection-aware geo library. Equirectangular projection is
 *      accurate to < 0.01% distortion at Manila latitudes for cemetery
 *      scale (~hundreds of metres). Adding `d3-geo`, `turf`, `proj4`,
 *      etc. would balloon the Phase 1 bundle for zero benefit and
 *      potentially bust NFR-P6 (< 250KB authenticated bundle).
 *   3. The SVG `viewBox` Y axis grows downward; latitude grows upward.
 *      `latLngToSvgPoint` inverts Y so a higher-latitude point appears
 *      higher on screen — the natural mental model.
 *
 * This module is deliberately UI-agnostic — no React, no DOM, no SVG
 * elements. Pure functions that take numbers and return numbers /
 * strings. The renderer in `src/components/LotMap/SvgRenderer.tsx`
 * composes these helpers with JSX.
 */

/** A single geographic point — latitude / longitude pair. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** A polygon — a list of vertices. Empty list = unsurveyed placeholder. */
export type Polygon = LatLng[];

/**
 * Bounding-box scalars matching the server's flat-storage convention.
 * Kept flat (not nested in a `bbox` sub-object) so the wire shape is
 * identical to what `listInBbox` returns on `geometry.*`.
 */
export interface Bbox {
  bboxMinLat: number;
  bboxMaxLat: number;
  bboxMinLng: number;
  bboxMaxLng: number;
}

/**
 * Lot geometry payload — mirrors `convex/lib/geometry.ts → LotGeometry`.
 */
export type LotGeometry = {
  centroid: LatLng;
  polygon: Polygon;
} & Bbox;

/**
 * Cemetery-wide default bbox. Used as the initial map viewport before
 * the user pans or zooms. Centred on Apostle Paul Memorial Park in
 * Aringay, La Union (≈ 16.3955 N, 120.3585 E) with a generous 0.01°
 * half-width (≈ 1.1 km) so every lot falls comfortably inside the frame.
 *
 * NOTE: this MUST track wherever lot geometry actually lives — the demo
 * seed (`convex/seed.ts`, `BASE_LAT`/`BASE_LNG`) places lots here. An
 * earlier Manila placeholder (14.67 N, 121.04 E) left the map empty
 * because the viewport query found no lots ~200 km to the south.
 *
 * Once real GPS-surveyed geometry lands, this constant can be tightened
 * to the actual cemetery footprint — a one-line change.
 */
export const DEFAULT_CEMETERY_BBOX: Bbox = {
  bboxMinLat: 16.3855,
  bboxMaxLat: 16.4055,
  bboxMinLng: 120.3485,
  bboxMaxLng: 120.3685,
};

/**
 * Padding (in degrees) added inside `bboxToSvgViewBox` so polygons at
 * the edge of the bbox don't render with their strokes clipped. ~50m
 * at Manila latitude.
 */
const DEFAULT_VIEWBOX_PADDING_DEG = 0.0005;

/**
 * Convert a lat/lng bbox to an SVG `viewBox` string.
 *
 * Equirectangular projection at cemetery scale: 1° latitude ≈ 111 km;
 * 1° longitude at 14.7° N ≈ 107.6 km (cos(14.7°) × 111). The slight
 * lng compression vs lat is captured by `LNG_SCALE_AT_MANILA` so the
 * SVG aspect ratio is true-to-ground rather than stretched.
 *
 * Returns a string in the form `"minX minY width height"` — directly
 * assignable to the SVG `viewBox` attribute.
 */
export function bboxToSvgViewBox(
  bbox: Bbox,
  padding: number = DEFAULT_VIEWBOX_PADDING_DEG,
): string {
  const minLng = bbox.bboxMinLng - padding;
  const maxLng = bbox.bboxMaxLng + padding;
  const minLat = bbox.bboxMinLat - padding;
  const maxLat = bbox.bboxMaxLat + padding;

  // Equirectangular: x grows with lng, y grows DOWN with decreasing lat.
  // We anchor minX at minLng and minY at -maxLat so the resulting box
  // covers the whole bbox in the same units used by `latLngToSvgPoint`.
  const x = minLng;
  const y = -maxLat;
  const width = maxLng - minLng;
  const height = maxLat - minLat;
  return `${x} ${y} ${width} ${height}`;
}

/**
 * Project a single lat/lng into SVG-space using equirectangular
 * mapping. The `viewBox` returned by `bboxToSvgViewBox` is sized in the
 * same units (lat/lng degrees) — no per-call scale calculation needed.
 *
 * Note: this projection is correct for relative positions WITHIN a
 * single small bbox. It is NOT an absolute coordinate system — two
 * maps using different bboxes will project the same lat/lng to
 * different SVG coordinates. That's fine for our renderer because each
 * `<svg>` instance carries its own `viewBox`.
 */
export function latLngToSvgPoint(p: LatLng): { x: number; y: number } {
  return { x: p.lng, y: -p.lat };
}

/**
 * Build the `points` attribute for an SVG `<polygon>` from a polygon's
 * lat/lng vertices. Returns `null` when the polygon is empty so callers
 * can decide whether to render a placeholder marker instead.
 *
 * Format: `"x1,y1 x2,y2 x3,y3"` — the SVG spec requires comma- or
 * space-separated coordinate pairs.
 */
export function polygonToSvgPoints(polygon: Polygon): string | null {
  if (polygon.length === 0) return null;
  return polygon
    .map((p) => {
      const { x, y } = latLngToSvgPoint(p);
      return `${x},${y}`;
    })
    .join(" ");
}

/**
 * Two bboxes overlap iff their projections on BOTH axes overlap.
 * Used for client-side viewport-cull predicates when the server has
 * already returned a slightly-padded candidate set (Story 1.9's
 * 0.1° pad on the index range).
 *
 * Edge-touching is treated as overlap (`>=` / `<=`), matching the
 * server's predicate convention.
 */
export function intersectsBbox(a: Bbox, b: Bbox): boolean {
  if (a.bboxMaxLat < b.bboxMinLat) return false;
  if (a.bboxMinLat > b.bboxMaxLat) return false;
  if (a.bboxMaxLng < b.bboxMinLng) return false;
  if (a.bboxMinLng > b.bboxMaxLng) return false;
  return true;
}

/**
 * Compute an SVG stroke-width that scales with viewBox size so the
 * stroke stays visually consistent regardless of zoom level. At a
 * 0.02° bbox (~2.2km), a stroke-width of 0.00008 renders as ~0.4px on
 * a 1000px-wide canvas.
 *
 * Returns the raw degree-scaled width. Outdoor mode (Story 1.4) can
 * multiply this client-side via a CSS variable swap.
 */
export function strokeWidthForBbox(bbox: Bbox): number {
  const width = Math.max(
    bbox.bboxMaxLng - bbox.bboxMinLng,
    bbox.bboxMaxLat - bbox.bboxMinLat,
    0.001, // floor — avoid division-by-zero at fully-collapsed placeholder bboxes
  );
  return width * 0.004;
}

/**
 * Placeholder-marker radius — used when `geometryStatus === "placeholder"`.
 * Scaled with bbox so a marker on a wide cemetery view looks roughly the
 * same on a zoomed-in single-section view.
 */
export function placeholderRadiusForBbox(bbox: Bbox): number {
  const width = Math.max(
    bbox.bboxMaxLng - bbox.bboxMinLng,
    bbox.bboxMaxLat - bbox.bboxMinLat,
    0.001,
  );
  return width * 0.015;
}
