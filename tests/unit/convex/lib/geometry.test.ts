/**
 * Story 1.9 — `convex/lib/geometry.ts` unit tests.
 *
 * Coverage target: 100% line. This is foundation code that Stories
 * 1.10 (search), 1.11 (lot detail), 1.12 (SVG map), 1.13 (offline
 * cache), and Epic 5+ (GPS import) build on. Every branch — empty
 * polygon, n-vertex polygon, fallback supplied / omitted, every
 * validation failure code — has an explicit test below.
 */

import { ConvexError, type Value } from "convex/values";
import { describe, expect, it } from "vitest";

import {
  assertPolygonValid,
  bboxFromPolygon,
  DEFAULT_PLACEHOLDER_CENTROID,
  defaultPlaceholderGeometry,
  getDefaultPlaceholderGeometry,
  type LatLng,
  type Polygon,
  polygonCentroid,
  validatePolygon,
} from "../../../../convex/lib/geometry";
import { ErrorCode, type ErrorPayload } from "../../../../convex/lib/errors";

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

// In-range vertices used across the tests. Picked so every vertex is
// inside the coordinate sanity range (lat 13.5–17.0, lng 119.5–122.0,
// covering Metro Manila up through La Union).
const V1: LatLng = { lat: 14.676, lng: 121.04 };
const V2: LatLng = { lat: 14.677, lng: 121.04 };
const V3: LatLng = { lat: 14.677, lng: 121.05 };
const V4: LatLng = { lat: 14.676, lng: 121.05 };

describe("DEFAULT_PLACEHOLDER_CENTROID", () => {
  it("matches the cemetery placeholder coordinate", () => {
    expect(DEFAULT_PLACEHOLDER_CENTROID).toEqual({
      lat: 14.676,
      lng: 121.0437,
    });
  });
});

describe("getDefaultPlaceholderGeometry", () => {
  it("returns centroid + empty polygon + zero-area bbox at centroid", () => {
    const g = getDefaultPlaceholderGeometry();
    expect(g.centroid).toEqual(DEFAULT_PLACEHOLDER_CENTROID);
    expect(g.polygon).toEqual([]);
    expect(g.bboxMinLat).toBe(DEFAULT_PLACEHOLDER_CENTROID.lat);
    expect(g.bboxMaxLat).toBe(DEFAULT_PLACEHOLDER_CENTROID.lat);
    expect(g.bboxMinLng).toBe(DEFAULT_PLACEHOLDER_CENTROID.lng);
    expect(g.bboxMaxLng).toBe(DEFAULT_PLACEHOLDER_CENTROID.lng);
  });

  it("accepts an opts.section forward-compat argument", () => {
    // Section-specific centroids land in Story 1.12; until then,
    // every section maps to the cemetery default. The test asserts
    // the contract, not the (future) wiring.
    const g = getDefaultPlaceholderGeometry({ section: "D" });
    expect(g.centroid).toEqual(DEFAULT_PLACEHOLDER_CENTROID);
  });

  it("returns a fresh centroid object (caller mutation isolation)", () => {
    const g1 = getDefaultPlaceholderGeometry();
    g1.centroid.lat = 999;
    const g2 = getDefaultPlaceholderGeometry();
    expect(g2.centroid.lat).toBe(DEFAULT_PLACEHOLDER_CENTROID.lat);
  });
});

describe("defaultPlaceholderGeometry (back-compat alias)", () => {
  it("delegates to getDefaultPlaceholderGeometry", () => {
    const a = defaultPlaceholderGeometry();
    const b = getDefaultPlaceholderGeometry();
    expect(a).toEqual(b);
  });
});

describe("bboxFromPolygon", () => {
  it("returns the placeholder-centred zero-area bbox for an empty polygon", () => {
    const bbox = bboxFromPolygon([]);
    expect(bbox).toEqual({
      bboxMinLat: DEFAULT_PLACEHOLDER_CENTROID.lat,
      bboxMaxLat: DEFAULT_PLACEHOLDER_CENTROID.lat,
      bboxMinLng: DEFAULT_PLACEHOLDER_CENTROID.lng,
      bboxMaxLng: DEFAULT_PLACEHOLDER_CENTROID.lng,
    });
  });

  it("uses the supplied fallback for an empty polygon", () => {
    const fallback: LatLng = { lat: 14.5, lng: 121.0 };
    const bbox = bboxFromPolygon([], fallback);
    expect(bbox).toEqual({
      bboxMinLat: 14.5,
      bboxMaxLat: 14.5,
      bboxMinLng: 121.0,
      bboxMaxLng: 121.0,
    });
  });

  it("computes min/max across a 3-vertex triangle", () => {
    const tri: Polygon = [
      { lat: 14.676, lng: 121.04 },
      { lat: 14.678, lng: 121.05 },
      { lat: 14.677, lng: 121.06 },
    ];
    expect(bboxFromPolygon(tri)).toEqual({
      bboxMinLat: 14.676,
      bboxMaxLat: 14.678,
      bboxMinLng: 121.04,
      bboxMaxLng: 121.06,
    });
  });

  it("computes min/max across a 4-vertex rectangle", () => {
    expect(bboxFromPolygon([V1, V2, V3, V4])).toEqual({
      bboxMinLat: 14.676,
      bboxMaxLat: 14.677,
      bboxMinLng: 121.04,
      bboxMaxLng: 121.05,
    });
  });

  it("handles a single-vertex polygon (degenerate, but well-defined)", () => {
    // `bboxFromPolygon` does NOT validate vertex count — that's
    // `validatePolygon`'s job. A 1-vertex polygon collapses to a
    // zero-area bbox at the vertex.
    const bbox = bboxFromPolygon([{ lat: 14.677, lng: 121.05 }]);
    expect(bbox).toEqual({
      bboxMinLat: 14.677,
      bboxMaxLat: 14.677,
      bboxMinLng: 121.05,
      bboxMaxLng: 121.05,
    });
  });
});

describe("polygonCentroid", () => {
  it("returns the placeholder centroid for an empty polygon", () => {
    expect(polygonCentroid([])).toEqual(DEFAULT_PLACEHOLDER_CENTROID);
  });

  it("returns the fallback when one is supplied", () => {
    const fallback: LatLng = { lat: 14.5, lng: 121.0 };
    expect(polygonCentroid([], fallback)).toEqual(fallback);
  });

  it("vertex-averages a 4-vertex rectangle to the geometric centre", () => {
    const c = polygonCentroid([V1, V2, V3, V4]);
    // Centroid of unit rectangle's corners is the geometric centre.
    expect(c.lat).toBeCloseTo(14.6765, 10);
    expect(c.lng).toBeCloseTo(121.045, 10);
  });

  it("vertex-averages a 3-vertex triangle to the centroid of its vertices", () => {
    const tri: Polygon = [
      { lat: 0, lng: 0 },
      { lat: 3, lng: 0 },
      { lat: 0, lng: 3 },
    ];
    expect(polygonCentroid(tri)).toEqual({ lat: 1, lng: 1 });
  });
});

describe("validatePolygon", () => {
  it("accepts an empty polygon (placeholder unsurveyed state)", () => {
    expect(validatePolygon([])).toEqual({ ok: true });
  });

  it("rejects a 1-vertex polygon with TOO_FEW_VERTICES", () => {
    const result = validatePolygon([V1]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TOO_FEW_VERTICES");
      expect(result.details).toMatch(/at least 3 vertices/);
    }
  });

  it("rejects a 2-vertex polygon with TOO_FEW_VERTICES", () => {
    const result = validatePolygon([V1, V2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TOO_FEW_VERTICES");
    }
  });

  it("accepts a valid 3-vertex polygon", () => {
    expect(validatePolygon([V1, V2, V3])).toEqual({ ok: true });
  });

  it("accepts a valid 4-vertex rectangle", () => {
    expect(validatePolygon([V1, V2, V3, V4])).toEqual({ ok: true });
  });

  it("rejects consecutive duplicate vertices with DUPLICATE_VERTICES", () => {
    const result = validatePolygon([V1, V1, V2]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("DUPLICATE_VERTICES");
      expect(result.details).toMatch(/indices 0 and 1/);
    }
  });

  it("allows non-consecutive vertex repeats (L-shaped revisit)", () => {
    // V1 appears at index 0 and index 3 — non-consecutive. The
    // validator allows this (legitimate polygon shape).
    expect(validatePolygon([V1, V2, V3, V1])).toEqual({ ok: true });
  });

  it("rejects NaN coords with INVALID_COORD", () => {
    const result = validatePolygon([
      { lat: Number.NaN, lng: 121.04 },
      V2,
      V3,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_COORD");
      expect(result.details).toMatch(/non-finite/);
    }
  });

  it("rejects Infinity coords with INVALID_COORD", () => {
    const result = validatePolygon([
      { lat: Number.POSITIVE_INFINITY, lng: 121.04 },
      V2,
      V3,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_COORD");
    }
  });

  it("rejects out-of-range lat with INVALID_COORD", () => {
    // 0,0 is finite but well outside the Manila sanity range.
    const result = validatePolygon([{ lat: 0, lng: 0 }, V2, V3]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_COORD");
      expect(result.details).toMatch(/sanity range/);
    }
  });

  it("rejects out-of-range lng (above max) with INVALID_COORD", () => {
    // Lat is in range; lng is over the upper bound (122.0).
    const result = validatePolygon([
      { lat: 14.676, lng: 130 },
      V2,
      V3,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_COORD");
    }
  });

  it("rejects out-of-range lat (above max) with INVALID_COORD", () => {
    const result = validatePolygon([
      { lat: 50, lng: 121.04 },
      V2,
      V3,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_COORD");
    }
  });

  it("reports the FIRST failure when multiple are present", () => {
    // Both vertex 0 (NaN) and vertex 2/3 (consecutive duplicate) are
    // bad. The function should report the NaN first because the
    // finite-check loop runs before the duplicate-check loop.
    const result = validatePolygon([
      { lat: Number.NaN, lng: 121.04 },
      V2,
      V3,
      V3,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_COORD");
    }
  });
});

describe("assertPolygonValid", () => {
  it("returns silently for a valid polygon", () => {
    expect(() => {
      assertPolygonValid([V1, V2, V3, V4]);
    }).not.toThrow();
  });

  it("returns silently for an empty polygon", () => {
    expect(() => {
      assertPolygonValid([]);
    }).not.toThrow();
  });

  it("throws INVARIANT_VIOLATION with the polygon error code for a 2-vertex polygon", () => {
    let thrown: unknown;
    try {
      assertPolygonValid([V1, V2]);
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(thrown).toBeInstanceOf(ConvexError);
    if (thrown instanceof ConvexError) {
      const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
      expect(data.details).toMatchObject({
        polygonErrorCode: "TOO_FEW_VERTICES",
      });
    }
  });

  it("throws INVARIANT_VIOLATION for duplicate consecutive vertices", () => {
    let thrown: unknown;
    try {
      assertPolygonValid([V1, V1, V2]);
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});
