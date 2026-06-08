import { describe, it, expect } from "vitest";
import {
  DEFAULT_CEMETERY_BBOX,
  bboxToSvgViewBox,
  intersectsBbox,
  latLngToSvgPoint,
  placeholderRadiusForBbox,
  polygonToSvgPoints,
  strokeWidthForBbox,
  type Bbox,
  type LatLng,
} from "@/lib/geometry";

/**
 * Story 1.12 — pure-function geometry helpers. The client mirror has
 * no Convex / React dependency so every test runs in plain Vitest.
 *
 * Coverage targets:
 *   - `bboxToSvgViewBox` produces a usable `viewBox` string and respects
 *     padding.
 *   - `latLngToSvgPoint` inverts Y (lat grows up; SVG Y grows down).
 *   - `polygonToSvgPoints` produces a comma-separated `x,y` list and
 *     returns `null` for empty polygons.
 *   - `intersectsBbox` covers overlap / disjoint / touching / contained.
 *   - `strokeWidthForBbox` + `placeholderRadiusForBbox` scale with bbox
 *     width and never return zero / negative.
 *   - `DEFAULT_CEMETERY_BBOX` sane (positive area, centred on the real
 *     cemetery in Aringay, La Union, and containing the seeded lots).
 */

// Apostle Paul Memorial Park, Aringay, La Union — the base coordinate the
// demo seed (`convex/seed.ts`) places lots around. The default viewport
// MUST contain this point, or the map renders empty (regression guard).
const ARINGAY_BASE = { lat: 16.3955, lng: 120.3585 };

describe("DEFAULT_CEMETERY_BBOX", () => {
  it("is centred on the cemetery in Aringay, La Union", () => {
    expect(DEFAULT_CEMETERY_BBOX.bboxMinLat).toBeLessThan(16.4);
    expect(DEFAULT_CEMETERY_BBOX.bboxMaxLat).toBeGreaterThan(16.39);
    expect(DEFAULT_CEMETERY_BBOX.bboxMinLng).toBeLessThan(120.36);
    expect(DEFAULT_CEMETERY_BBOX.bboxMaxLng).toBeGreaterThan(120.355);
  });
  it("contains the seeded lot base coordinate", () => {
    expect(ARINGAY_BASE.lat).toBeGreaterThan(DEFAULT_CEMETERY_BBOX.bboxMinLat);
    expect(ARINGAY_BASE.lat).toBeLessThan(DEFAULT_CEMETERY_BBOX.bboxMaxLat);
    expect(ARINGAY_BASE.lng).toBeGreaterThan(DEFAULT_CEMETERY_BBOX.bboxMinLng);
    expect(ARINGAY_BASE.lng).toBeLessThan(DEFAULT_CEMETERY_BBOX.bboxMaxLng);
  });
  it("has a positive area", () => {
    expect(DEFAULT_CEMETERY_BBOX.bboxMaxLat).toBeGreaterThan(
      DEFAULT_CEMETERY_BBOX.bboxMinLat,
    );
    expect(DEFAULT_CEMETERY_BBOX.bboxMaxLng).toBeGreaterThan(
      DEFAULT_CEMETERY_BBOX.bboxMinLng,
    );
  });
});

describe("bboxToSvgViewBox", () => {
  it("returns a viewBox sized as (maxLng - minLng + 2*padding) wide", () => {
    const bbox: Bbox = {
      bboxMinLat: 14.0,
      bboxMaxLat: 14.1,
      bboxMinLng: 121.0,
      bboxMaxLng: 121.2,
    };
    const padding = 0.01;
    const vb = bboxToSvgViewBox(bbox, padding);
    const parts = vb.split(" ").map(Number);
    expect(parts).toHaveLength(4);
    const [, , width, height] = parts;
    // Width = (121.2 - 121.0) + 2*0.01 = 0.22
    expect(width).toBeCloseTo(0.22, 5);
    // Height = (14.1 - 14.0) + 2*0.01 = 0.12
    expect(height).toBeCloseTo(0.12, 5);
  });

  it("uses a default padding when not supplied", () => {
    const bbox: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 1,
      bboxMinLng: 0,
      bboxMaxLng: 1,
    };
    const vb = bboxToSvgViewBox(bbox);
    const parts = vb.split(" ").map(Number);
    // Default padding > 0 so the width is strictly > 1.
    expect(parts[2]).toBeGreaterThan(1);
  });

  it("returns a four-number space-separated string", () => {
    const vb = bboxToSvgViewBox(DEFAULT_CEMETERY_BBOX);
    expect(vb.split(" ")).toHaveLength(4);
    vb.split(" ").forEach((s) => {
      expect(Number.isFinite(Number(s))).toBe(true);
    });
  });
});

describe("latLngToSvgPoint", () => {
  it("inverts the Y axis (higher lat → smaller y)", () => {
    const lower = latLngToSvgPoint({ lat: 14.0, lng: 121.0 });
    const upper = latLngToSvgPoint({ lat: 14.1, lng: 121.0 });
    expect(upper.y).toBeLessThan(lower.y);
  });

  it("preserves longitude as x without inversion", () => {
    const west = latLngToSvgPoint({ lat: 14.0, lng: 121.0 });
    const east = latLngToSvgPoint({ lat: 14.0, lng: 121.1 });
    expect(east.x).toBeGreaterThan(west.x);
  });

  it("is idempotent for the same input", () => {
    const p = { lat: 14.6760, lng: 121.0437 };
    expect(latLngToSvgPoint(p)).toEqual(latLngToSvgPoint(p));
  });
});

describe("polygonToSvgPoints", () => {
  it("returns null for an empty polygon", () => {
    expect(polygonToSvgPoints([])).toBeNull();
  });

  it("formats a 3-vertex polygon as space-separated x,y pairs", () => {
    const polygon: LatLng[] = [
      { lat: 14.0, lng: 121.0 },
      { lat: 14.1, lng: 121.0 },
      { lat: 14.05, lng: 121.1 },
    ];
    const out = polygonToSvgPoints(polygon);
    expect(out).not.toBeNull();
    const pairs = out!.split(" ");
    expect(pairs).toHaveLength(3);
    pairs.forEach((pair) => {
      const [x, y] = pair.split(",").map(Number);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    });
  });

  it("inverts Y consistently across all vertices", () => {
    const polygon: LatLng[] = [
      { lat: 14.0, lng: 121.0 },
      { lat: 14.1, lng: 121.0 },
    ];
    const out = polygonToSvgPoints([...polygon, { lat: 14.05, lng: 121.1 }])!;
    const ys = out.split(" ").map((pair) => Number(pair.split(",")[1]));
    // All Ys should be negative (since lat is positive and we invert).
    ys.forEach((y) => expect(y).toBeLessThan(0));
  });
});

describe("intersectsBbox", () => {
  const base: Bbox = {
    bboxMinLat: 0,
    bboxMaxLat: 1,
    bboxMinLng: 0,
    bboxMaxLng: 1,
  };

  it("returns true for fully-overlapping bboxes", () => {
    const other: Bbox = {
      bboxMinLat: 0.25,
      bboxMaxLat: 0.75,
      bboxMinLng: 0.25,
      bboxMaxLng: 0.75,
    };
    expect(intersectsBbox(base, other)).toBe(true);
  });

  it("returns true for partial overlap", () => {
    const other: Bbox = {
      bboxMinLat: 0.5,
      bboxMaxLat: 1.5,
      bboxMinLng: 0.5,
      bboxMaxLng: 1.5,
    };
    expect(intersectsBbox(base, other)).toBe(true);
  });

  it("returns true for edge-touching bboxes", () => {
    const other: Bbox = {
      bboxMinLat: 1,
      bboxMaxLat: 2,
      bboxMinLng: 0,
      bboxMaxLng: 1,
    };
    expect(intersectsBbox(base, other)).toBe(true);
  });

  it("returns false for disjoint bboxes — vertical", () => {
    const other: Bbox = {
      bboxMinLat: 2,
      bboxMaxLat: 3,
      bboxMinLng: 0,
      bboxMaxLng: 1,
    };
    expect(intersectsBbox(base, other)).toBe(false);
  });

  it("returns false for disjoint bboxes — horizontal", () => {
    const other: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 1,
      bboxMinLng: 2,
      bboxMaxLng: 3,
    };
    expect(intersectsBbox(base, other)).toBe(false);
  });

  it("is symmetric — a∩b iff b∩a", () => {
    const other: Bbox = {
      bboxMinLat: 0.5,
      bboxMaxLat: 1.5,
      bboxMinLng: 0.5,
      bboxMaxLng: 1.5,
    };
    expect(intersectsBbox(base, other)).toBe(intersectsBbox(other, base));
  });
});

describe("strokeWidthForBbox & placeholderRadiusForBbox", () => {
  it("strokeWidthForBbox scales with bbox width", () => {
    const small: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 0.001,
      bboxMinLng: 0,
      bboxMaxLng: 0.001,
    };
    const big: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 1,
      bboxMinLng: 0,
      bboxMaxLng: 1,
    };
    expect(strokeWidthForBbox(big)).toBeGreaterThan(strokeWidthForBbox(small));
  });

  it("strokeWidthForBbox never returns zero or negative", () => {
    const collapsed: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 0,
      bboxMinLng: 0,
      bboxMaxLng: 0,
    };
    expect(strokeWidthForBbox(collapsed)).toBeGreaterThan(0);
  });

  it("placeholderRadiusForBbox scales with bbox width", () => {
    const small: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 0.001,
      bboxMinLng: 0,
      bboxMaxLng: 0.001,
    };
    const big: Bbox = {
      bboxMinLat: 0,
      bboxMaxLat: 1,
      bboxMinLng: 0,
      bboxMaxLng: 1,
    };
    expect(placeholderRadiusForBbox(big)).toBeGreaterThan(
      placeholderRadiusForBbox(small),
    );
  });
});
