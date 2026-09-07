/**
 * What the flat map draws, and where it points itself.
 *
 * The map opened on a fixed cemetery-wide box, which framed a park a
 * hundred metres across inside a view of the whole town: the thing you
 * came to look at was four pixels near the middle, and a 2.5m grave was
 * well under one. Nothing errored. It just looked like a scatter of
 * specks in an empty field.
 *
 * None of this is checkable by looking at a screenshot either, which is
 * why the framing and the thresholds live here as numbers.
 */

import { describe, expect, it } from "vitest";
import {
  boundsOf,
  detailLevelFor,
  GARDEN_MARKER_MAX_ZOOM,
  LABEL_MIN_ZOOM,
  MAX_LABELLED_LOTS,
  paddedBounds,
  shouldLabelLots,
  summariseGardens,
} from "@/lib/mapDetail";

const AT = { lat: 16.3959, lng: 120.3556 };

describe("choosing what to draw", () => {
  it("shows gardens, not lots, when a grave is under a pixel", () => {
    expect(detailLevelFor(15)).toBe("gardens");
    expect(detailLevelFor(GARDEN_MARKER_MAX_ZOOM)).toBe("gardens");
  });

  it("shows the lots themselves once they are big enough to see", () => {
    expect(detailLevelFor(GARDEN_MARKER_MAX_ZOOM + 1)).toBe("lots");
  });

  it("adds codes only when there is room to read them", () => {
    expect(detailLevelFor(LABEL_MIN_ZOOM)).toBe("labelled");
    expect(detailLevelFor(LABEL_MIN_ZOOM - 1)).not.toBe("labelled");
  });

  it("steps rather than fades", () => {
    // A half-drawn lot or a half-legible label reads as the map
    // struggling rather than as the map deciding.
    const levels = [14, 15, 16, 17, 18, 19, 20].map(detailLevelFor);
    expect(new Set(levels)).toEqual(
      new Set(["gardens", "lots", "labelled"]),
    );
  });

  it("keeps the thresholds in order", () => {
    expect(GARDEN_MARKER_MAX_ZOOM).toBeLessThan(LABEL_MIN_ZOOM);
  });
});

describe("framing what exists", () => {
  it("has no bounds for nothing", () => {
    expect(boundsOf([])).toBeNull();
  });

  it("bounds the points it is given", () => {
    expect(
      boundsOf([
        { lat: 1, lng: 2 },
        { lat: 3, lng: -4 },
      ]),
    ).toEqual({ minLat: 1, maxLat: 3, minLng: -4, maxLng: 2 });
  });

  it("ignores a broken coordinate rather than poisoning the box", () => {
    // One NaN would make every bound NaN, and fitting to that either
    // throws or silently does nothing.
    const b = boundsOf([
      { lat: Number.NaN, lng: 1 },
      { lat: 16.3, lng: 120.3 },
    ]);
    expect(b).toEqual({
      minLat: 16.3,
      maxLat: 16.3,
      minLng: 120.3,
      maxLng: 120.3,
    });
  });

  it("returns null when every coordinate is broken", () => {
    expect(boundsOf([{ lat: Number.NaN, lng: Number.NaN }])).toBeNull();
  });

  it("REFUSES to collapse a single lot to a point", () => {
    // Fitting to a zero-size box either does nothing or zooms to the
    // maximum and fills the screen with tile texture.
    const b = paddedBounds(boundsOf([AT]));
    expect(b!.maxLat).toBeGreaterThan(b!.minLat);
    expect(b!.maxLng).toBeGreaterThan(b!.minLng);
  });

  it("leaves a box that already has size alone", () => {
    const wide = { minLat: 1, maxLat: 2, minLng: 3, maxLng: 4 };
    expect(paddedBounds(wide)).toEqual(wide);
  });

  it("pads a row of lots that share a latitude", () => {
    // A single row is flat in one axis only; padding both would waste
    // half the view.
    const row = boundsOf([
      { lat: AT.lat, lng: AT.lng },
      { lat: AT.lat, lng: AT.lng + 0.001 },
    ]);
    const p = paddedBounds(row)!;
    expect(p.maxLat).toBeGreaterThan(p.minLat);
    expect(p.maxLng - p.minLng).toBeCloseTo(0.001, 9);
  });

  it("passes null through", () => {
    expect(paddedBounds(null)).toBeNull();
  });
});

describe("summarising a garden into one marker", () => {
  function lot(section: string, over: Partial<{ status: string; lat: number; lng: number }> = {}) {
    return {
      section,
      status: over.status ?? "available",
      lat: over.lat ?? AT.lat,
      lng: over.lng ?? AT.lng,
    };
  }

  it("counts the lots and the ones still for sale", () => {
    const [g] = summariseGardens([
      lot("Garden of Faith"),
      lot("Garden of Faith", { status: "occupied" }),
      lot("Garden of Faith", { status: "sold" }),
    ]);
    expect(g!.lotCount).toBe(3);
    expect(g!.availableCount).toBe(1);
  });

  it("puts the marker among the graves, not at an outline's centre", () => {
    // A garden shaped like an L has an outline centre standing in the
    // gap, where there is nothing to point at.
    const [g] = summariseGardens([
      lot("A", { lat: 16.0, lng: 120.0 }),
      lot("A", { lat: 16.2, lng: 120.0 }),
    ]);
    expect(g!.centre.lat).toBeCloseTo(16.1, 6);
  });

  it("keeps gardens apart", () => {
    const out = summariseGardens([
      lot("Garden of Hope"),
      lot("Garden of Faith"),
    ]);
    expect(out.map((g) => g.section)).toEqual([
      "Garden of Faith",
      "Garden of Hope",
    ]);
  });

  it("drops a lot with no usable position instead of dragging the marker", () => {
    // One NaN would move the whole garden's marker to nowhere.
    const [g] = summariseGardens([
      lot("A", { lat: 16.0, lng: 120.0 }),
      lot("A", { lat: Number.NaN, lng: 120.0 }),
    ]);
    expect(g!.lotCount).toBe(1);
    expect(Number.isFinite(g!.centre.lat)).toBe(true);
  });

  it("summarises nothing into nothing", () => {
    expect(summariseGardens([])).toEqual([]);
  });
});

describe("when a lot code may be drawn", () => {
  it("waits for the zoom that makes a code readable", () => {
    expect(shouldLabelLots(LABEL_MIN_ZOOM - 1, 5)).toBe(false);
    expect(shouldLabelLots(LABEL_MIN_ZOOM, 5)).toBe(true);
  });

  it("REFUSES to label a dense garden even when zoomed right in", () => {
    // Leaflet draws every tooltip where its lot is and does nothing
    // about collisions. At 2.5m spacing the codes land on each other
    // AND on the plots they name, which is worse than no codes: the
    // reader loses both the labels and the view of the lots.
    expect(shouldLabelLots(20, MAX_LABELLED_LOTS + 1)).toBe(false);
  });

  it("labels right up to the limit", () => {
    expect(shouldLabelLots(20, MAX_LABELLED_LOTS)).toBe(true);
  });

  it("never labels while gardens are being drawn instead of lots", () => {
    // There are no lot shapes on screen to attach a code to.
    expect(shouldLabelLots(GARDEN_MARKER_MAX_ZOOM, 1)).toBe(false);
  });
});
