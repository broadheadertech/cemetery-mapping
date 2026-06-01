/**
 * Geometry helpers — Stories 1.8 + 1.9.
 *
 * Story 1.8 introduced this module with the placeholder centroid
 * constant and `defaultPlaceholderGeometry()` so the `lots` schema
 * could carry a `geometry` slot from day one. Story 1.9 extends it
 * with:
 *
 *   - Geometry type exports (`LatLng`, `Polygon`, `Bbox`,
 *     `LotGeometry`) — the canonical shape every downstream consumer
 *     imports.
 *   - `getDefaultPlaceholderGeometry({ section? })` — superseding
 *     `defaultPlaceholderGeometry()` (kept as a backward-compatible
 *     alias so Story 1.8's existing call site keeps compiling). New
 *     code should call the underscored, opts-accepting variant.
 *   - `bboxFromPolygon(polygon, fallback?)` — recompute the four bbox
 *     scalars from a polygon's vertices. Empty polygon collapses to
 *     a zero-area bbox at the fallback centroid (or the cemetery
 *     placeholder centroid when no fallback is supplied).
 *   - `polygonCentroid(polygon, fallback?)` — vertex-average centroid.
 *     For Phase 1 placeholder polygons and Phase 2 rectangular
 *     surveyed lots, the vertex average is within centimetre of the
 *     geometric centroid; for irregular polygons in later phases we
 *     would swap in the shoelace-formula centroid.
 *   - `validatePolygon(polygon)` — invariants: empty OR ≥ 3 vertices,
 *     no two consecutive duplicates, all coords finite + within the
 *     Manila sanity range. Returns a discriminated `ok` / error code
 *     payload rather than throwing — callers (typically Convex
 *     mutations) decide how to surface the failure (most will route
 *     through `throwError(ErrorCode.INVARIANT_VIOLATION, ...)`).
 *
 * Cross-references:
 *
 *   - Story 1.10 (search) — no direct dependency, but search-result
 *     previews may render a tiny marker based on `geometryStatus`.
 *   - Story 1.11 (lot detail) — renders the `geometryStatus` pill.
 *   - Story 1.12 (SVG map) — `useLotsInViewport` calls
 *     `api.lots.listInBbox` (this story's new query), and a separate
 *     `src/lib/geometry.ts` client mirror extends these types for the
 *     map renderer. Server module stays Convex-only.
 *   - Story 1.13 (offline) — caches `listInBbox` responses with a 24h
 *     TTL; the bbox keys come from this module's types.
 *   - Epic 5+ GPS import flow — calls the internal
 *     `updateLotGeometry` mutation (in `convex/lots.ts`) which delegates
 *     bbox + centroid computation back to this module.
 *
 * Architectural commitments (ADR-0008):
 *
 *   1. No projection-aware geospatial library (`turf`, `proj4`, etc.).
 *      Manila is far from the poles and the antimeridian; native
 *      `Math.min/max` over `lat` and `lng` is correct for Phase 1.
 *      Adding a dependency for this layer would be bundle weight +
 *      supply-chain risk for zero benefit.
 *   2. Vertex coords keep native `number` precision. Rounding to
 *      5 decimal places (~1m at Manila latitude) loses centimetre-
 *      level survey accuracy; Convex's `v.number()` validator already
 *      accepts the full precision.
 *   3. The `bboxMinLat / bboxMaxLat` index lives on the `geometry.*`
 *      dotted paths (`convex/schema.ts → lots.by_bbox_lat`). Convex
 *      indexes support dotted paths for nested objects; that lets the
 *      geometry object stay encapsulated rather than spilling four
 *      scalars onto the top level of every lot row.
 */

import { ErrorCode, throwError } from "./errors";

/** A single geographic point — latitude / longitude pair. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Back-compat alias for Story 1.8's `GeoPoint`. New code should import
 * `LatLng`. This alias stays exported so older imports — and possibly
 * Story 1.12's client mirror under `src/lib/geometry.ts` — continue to
 * compile without a rename PR.
 */
export type GeoPoint = LatLng;

/** A polygon — a list of vertices. Empty list = no surveyed shape. */
export type Polygon = LatLng[];

/**
 * Bounding-box scalars on a lot. Stored flat on the `geometry` object
 * (not nested in a `bbox` sub-object) so they can be indexed via
 * `geometry.bboxMinLat` etc. — Convex indexes support dotted paths but
 * cannot reach into a sibling object at query time.
 */
export interface Bbox {
  bboxMinLat: number;
  bboxMaxLat: number;
  bboxMinLng: number;
  bboxMaxLng: number;
}

/**
 * The full geometry payload stored on every `lots` row. Type union
 * mirrors the schema validator exactly — keeping them in sync is a
 * runtime invariant; a Vitest assertion in `geometry.test.ts` covers
 * the shape parity.
 */
export type LotGeometry = {
  centroid: LatLng;
  polygon: Polygon;
} & Bbox;

/**
 * Cemetery centroid placeholder — approximate Manila coordinate. This
 * matches the inline constant Story 1.8 used inside `createLot` so the
 * Story 1.9 refactor is a behaviourless rename, not a data shift.
 *
 * Future stories (Epic 5+ GPS import) will replace this default with a
 * per-cemetery-profile lookup driven by config; the constant lives in
 * exactly one place so swapping it out is a one-line change.
 */
export const DEFAULT_PLACEHOLDER_CENTROID: LatLng = {
  lat: 14.6760,
  lng: 121.0437,
};

/**
 * Manila sanity-range envelope used by `validatePolygon`. NOT the
 * cemetery boundary — a deliberately loose 0.4° × 0.2° box (≈ 44 km
 * × 22 km) around the Manila metro region. The check exists to catch
 * "the surveyor punched the coordinate in degrees-minutes-seconds and
 * got a value in the 14400-range" class of mistake, not to enforce the
 * cemetery footprint. A future story can tighten this when we know the
 * cemetery's actual GeoJSON outline.
 */
const MANILA_LAT_MIN = 14.4;
const MANILA_LAT_MAX = 14.8;
const MANILA_LNG_MIN = 120.9;
const MANILA_LNG_MAX = 121.1;

function inManilaSanityRange(p: LatLng): boolean {
  return (
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= MANILA_LAT_MIN &&
    p.lat <= MANILA_LAT_MAX &&
    p.lng >= MANILA_LNG_MIN &&
    p.lng <= MANILA_LNG_MAX
  );
}

/**
 * Exported coordinate sanity check (Epic 8 H1). `validatePolygon`
 * applies this to every vertex, but an operator-supplied `centroid`
 * OVERRIDE bypasses the polygon validator entirely. The GPS import +
 * `updateLotGeometry` server paths use this to reject a bad/swapped
 * centroid before it is stored and later drives field-worker GPS
 * navigation. Same range + finiteness rule as the vertex check.
 */
export function isCoordInManilaSanityRange(p: LatLng): boolean {
  return inManilaSanityRange(p);
}

/**
 * Builds the placeholder geometry every newly-created lot starts with.
 * The polygon is intentionally EMPTY (not a 1-vertex collapse — Story
 * 1.8 inlined a 1-vertex polygon, which `validatePolygon` would reject
 * as `TOO_FEW_VERTICES`). The bbox collapses to the centroid (zero
 * area). Once Epic 5+ GPS import lands, `updateLotGeometry` replaces
 * this with a real polygon and a real bbox in a single mutation.
 *
 * `opts.section` is accepted for forward compatibility — Story 1.12
 * will wire section-specific centroids via the SVG overlay metadata.
 * For now every section resolves to `DEFAULT_PLACEHOLDER_CENTROID`.
 */
export function getDefaultPlaceholderGeometry(opts?: {
  section?: string;
}): LotGeometry {
  // Section override comes online in Story 1.12 when SVG section overlay
  // metadata is authored; until then every section maps to the cemetery
  // centroid. Reading `opts.section` here keeps the call site honest —
  // `createLot` always passes it so the future wire-up is a one-liner.
  const _section = opts?.section;
  const centroid: LatLng = { ...DEFAULT_PLACEHOLDER_CENTROID };
  return {
    centroid,
    polygon: [],
    bboxMinLat: centroid.lat,
    bboxMaxLat: centroid.lat,
    bboxMinLng: centroid.lng,
    bboxMaxLng: centroid.lng,
  };
}

/**
 * Backward-compatible alias for Story 1.8's `defaultPlaceholderGeometry`.
 *
 * Story 1.8 shipped with `defaultPlaceholderGeometry()` (no `get`
 * prefix, no opts argument) and a 1-vertex polygon collapse. Story 1.9
 * supersedes the function name AND the polygon shape — the polygon is
 * now empty rather than 1-vertex, so it passes `validatePolygon`. The
 * old export stays to keep Story 1.8's `createLot` compilable during
 * the refactor; Task 3 of Story 1.9 swaps it out for the new name.
 *
 * Behaviour change: returns `polygon: []` instead of
 * `polygon: [centroid]`. This is intentional — Story 1.8's 1-vertex
 * collapse was a placeholder for the empty state, not a real polygon,
 * and would fail this story's `validatePolygon`. Test files that
 * compared against a 1-vertex polygon are updated in this story.
 */
export function defaultPlaceholderGeometry(): LotGeometry {
  return getDefaultPlaceholderGeometry();
}

/**
 * Recompute the bbox scalars from a polygon's vertices.
 *
 * - Empty polygon: returns a zero-area bbox at the fallback centroid
 *   (or the cemetery placeholder centroid when no fallback is given).
 *   This matches the placeholder convention so a lot whose geometry
 *   is "unsurveyed" never has an undefined bbox in the index.
 * - ≥ 1 vertex: returns `Math.min/max` across `lat` and `lng`. The
 *   function does NOT validate vertex count — `validatePolygon` is the
 *   authoritative gatekeeper; this helper computes whatever the input
 *   describes.
 *
 * Anti-meridian note: a polygon that crosses the 180° meridian (lng
 * jumps from +179 to -179) produces a meaningless wrap-around bbox
 * here. Manila sits ~60° west of the antimeridian; we won't hit this
 * in Phase 1. The known limitation is captured in the JSDoc rather
 * than handled in code — adding antimeridian-aware logic would require
 * the projection awareness this module deliberately avoids.
 */
export function bboxFromPolygon(polygon: Polygon, fallback?: LatLng): Bbox {
  if (polygon.length === 0) {
    const c = fallback ?? DEFAULT_PLACEHOLDER_CENTROID;
    return {
      bboxMinLat: c.lat,
      bboxMaxLat: c.lat,
      bboxMinLng: c.lng,
      bboxMaxLng: c.lng,
    };
  }
  let minLat = polygon[0]!.lat;
  let maxLat = polygon[0]!.lat;
  let minLng = polygon[0]!.lng;
  let maxLng = polygon[0]!.lng;
  for (let i = 1; i < polygon.length; i++) {
    const p = polygon[i]!;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return {
    bboxMinLat: minLat,
    bboxMaxLat: maxLat,
    bboxMinLng: minLng,
    bboxMaxLng: maxLng,
  };
}

/**
 * Vertex-average centroid. For rectangular / near-rectangular lot
 * footprints (Phase 2 surveyed lots) this is within centimetre of the
 * geometric centroid; for irregular polygons (curved cemetery
 * sections) the geometric centroid (shoelace formula) is closer to the
 * visual centre of mass. The JSDoc warns; do not silently swap the
 * algorithm. If a later story needs the geometric centroid, add it as
 * a sibling function (`polygonGeometricCentroid`) rather than mutating
 * this one's behaviour.
 *
 * Empty polygon: returns `fallback` (or the cemetery placeholder
 * centroid when no fallback is supplied). The function is total —
 * never throws — because callers usually compose it with
 * `bboxFromPolygon` in a single statement.
 */
export function polygonCentroid(
  polygon: Polygon,
  fallback?: LatLng,
): LatLng {
  if (polygon.length === 0) {
    const c = fallback ?? DEFAULT_PLACEHOLDER_CENTROID;
    return { lat: c.lat, lng: c.lng };
  }
  let sumLat = 0;
  let sumLng = 0;
  for (const p of polygon) {
    sumLat += p.lat;
    sumLng += p.lng;
  }
  return {
    lat: sumLat / polygon.length,
    lng: sumLng / polygon.length,
  };
}

/**
 * Error codes returned by `validatePolygon`. Kept as a string-literal
 * union (not a TS enum) so the type is checkable at the call site
 * without an enum import.
 */
export type ValidatePolygonErrorCode =
  | "TOO_FEW_VERTICES"
  | "DUPLICATE_VERTICES"
  | "INVALID_COORD";

export type ValidatePolygonResult =
  | { ok: true }
  | { ok: false; code: ValidatePolygonErrorCode; details: string };

/**
 * Invariants:
 *   1. The polygon is either empty (an unsurveyed placeholder) OR has
 *      at least 3 vertices. A 1-or-2 vertex polygon is meaningless;
 *      Story 1.8 inadvertently shipped a 1-vertex collapse that this
 *      story rejects (and that the new placeholder helper no longer
 *      produces).
 *   2. No two CONSECUTIVE vertices are identical. A polygon may
 *      legitimately revisit a vertex (e.g. an L-shaped lot) but
 *      consecutive duplicates always indicate a data-entry mistake.
 *   3. Every coord is finite (`Number.isFinite` — rules out `NaN`,
 *      `±Infinity`) AND falls within the Manila sanity range
 *      (lat 14.4–14.8, lng 120.9–121.1). The sanity range catches
 *      degree-vs-decimal-degree confusion and clipboard-paste errors;
 *      it is NOT the cemetery boundary.
 *
 * The function returns a result object rather than throwing because
 * callers (Convex mutations) typically want to attach extra context
 * before raising `INVARIANT_VIOLATION`. The result's `details` field
 * is a human-readable message safe to surface in client error toasts
 * via the Story 1.4 error-translation layer.
 *
 * Polygon containment, self-intersection, winding order, and other
 * higher-level geometric invariants are deliberately NOT checked.
 * They require projection-aware geometry; Phase 1 trusts the surveyor
 * (or the placeholder pipeline) to produce well-formed shapes. A
 * future story can layer those checks on top without rewriting this
 * helper.
 */
export function validatePolygon(polygon: Polygon): ValidatePolygonResult {
  if (polygon.length === 0) {
    return { ok: true };
  }
  if (polygon.length < 3) {
    return {
      ok: false,
      code: "TOO_FEW_VERTICES",
      details: `A polygon must have at least 3 vertices (got ${polygon.length}).`,
    };
  }
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      return {
        ok: false,
        code: "INVALID_COORD",
        details: `Vertex ${i} has a non-finite coordinate.`,
      };
    }
    if (!inManilaSanityRange(p)) {
      return {
        ok: false,
        code: "INVALID_COORD",
        details: `Vertex ${i} is outside the Manila sanity range (lat ${p.lat}, lng ${p.lng}).`,
      };
    }
  }
  for (let i = 1; i < polygon.length; i++) {
    const prev = polygon[i - 1]!;
    const cur = polygon[i]!;
    if (prev.lat === cur.lat && prev.lng === cur.lng) {
      return {
        ok: false,
        code: "DUPLICATE_VERTICES",
        details: `Consecutive duplicate vertices at indices ${i - 1} and ${i}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Convenience helper used by `updateLotGeometry` (in `convex/lots.ts`)
 * to route a `validatePolygon` failure through the canonical error
 * pipeline. Kept in this module — rather than inlining the throw at
 * the call site — so any future caller that wants the same "validate
 * or throw" semantics gets the consistent error code + message.
 *
 * Re-exported as a named function (not a default) to keep imports
 * obvious at the call site and lintable by the unused-import rule.
 */
export function assertPolygonValid(polygon: Polygon): void {
  const result = validatePolygon(polygon);
  if (!result.ok) {
    throwError(ErrorCode.INVARIANT_VIOLATION, result.details, {
      polygonErrorCode: result.code,
    });
  }
}
