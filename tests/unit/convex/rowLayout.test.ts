/**
 * Laying a row of graves along a drawn line.
 *
 * Every failure here produces a row that looks completely plausible.
 * Width and depth swapped gives a tidy row turned ninety degrees from
 * the truth. Stretching the plots to fill the line gives a row that
 * always fits and quietly misstates how big a grave is — the number
 * families are quoted, and the number that decides whether a family
 * plot fits where somebody thinks it does.
 *
 * So these check metres, not shapes.
 */

import { describe, expect, it } from "vitest";
import {
  FIT_TOLERANCE,
  fitRatio,
  fitWarning,
  layoutRow,
  type LatLng,
  type LotSize,
} from "../../../convex/lib/rowLayout";

// Aringay, La Union.
const START: LatLng = { lat: 16.3959, lng: 120.3556 };

const M_PER_DEG_LAT = 110_574;
function metresPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/** A point `m` metres due east of START. */
function east(m: number): LatLng {
  return { lat: START.lat, lng: START.lng + m / metresPerDegLng(START.lat) };
}

/** A point `m` metres due north of START. */
function north(m: number): LatLng {
  return { lat: START.lat + m / M_PER_DEG_LAT, lng: START.lng };
}

function metresBetween(a: LatLng, b: LatLng): number {
  const e = (b.lng - a.lng) * metresPerDegLng(a.lat);
  const n = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.sqrt(e * e + n * n);
}

/** Twelve standard singles. */
function singles(n: number): LotSize[] {
  return Array.from({ length: n }, () => ({ widthM: 2.5, depthM: 1.2 }));
}

describe("spacing the lots", () => {
  it("puts the first lot's centre half a width in, not on the start point", () => {
    // The click marks the row's EDGE. Centring the first grave on it
    // would push the whole row half a plot back down the path.
    const { placements } = layoutRow(START, east(30), singles(4));
    expect(metresBetween(START, placements[0]!.centroid)).toBeCloseTo(1.25, 1);
  });

  it("stands the lots shoulder to shoulder at their real width", () => {
    const { placements } = layoutRow(START, east(30), singles(4));
    for (let i = 1; i < placements.length; i++) {
      expect(
        metresBetween(placements[i - 1]!.centroid, placements[i]!.centroid),
      ).toBeCloseTo(2.5, 1);
    }
  });

  it("does NOT stretch the lots to fill the line", () => {
    // The flattering bug: a row that always fits, and always lies about
    // how big a grave is.
    const { placements, rowLengthM } = layoutRow(START, east(100), singles(4));
    expect(rowLengthM).toBeCloseTo(10, 5);
    expect(
      metresBetween(placements[0]!.centroid, placements[1]!.centroid),
    ).toBeCloseTo(2.5, 1);
  });

  it("gives a wide family plot the ground it actually needs", () => {
    // Even spacing would overlap it with its neighbour.
    const sizes: LotSize[] = [
      { widthM: 2.5, depthM: 1.2 },
      { widthM: 5, depthM: 2.5 },
      { widthM: 2.5, depthM: 1.2 },
    ];
    const { placements, rowLengthM } = layoutRow(START, east(30), sizes);
    expect(rowLengthM).toBeCloseTo(10, 5);
    // Centres: 1.25, 2.5+2.5=5, 7.5+1.25=8.75
    expect(metresBetween(START, placements[1]!.centroid)).toBeCloseTo(5, 1);
    expect(metresBetween(START, placements[2]!.centroid)).toBeCloseTo(8.75, 1);
  });
});

describe("which way the row runs", () => {
  it("follows the drawn line east", () => {
    const { placements } = layoutRow(START, east(30), singles(3));
    for (const p of placements) {
      expect(p.centroid.lat).toBeCloseTo(START.lat, 6);
      expect(p.centroid.lng).toBeGreaterThan(START.lng);
    }
  });

  it("follows the drawn line north", () => {
    const { placements } = layoutRow(START, north(30), singles(3));
    for (const p of placements) {
      expect(p.centroid.lng).toBeCloseTo(START.lng, 6);
      expect(p.centroid.lat).toBeGreaterThan(START.lat);
    }
  });

  it("follows a row that runs at an angle", () => {
    // The reason this exists. An irregular park's rows do not run north
    // to south, and no grid can express that.
    const diagonal: LatLng = {
      lat: north(30).lat,
      lng: east(30).lng,
    };
    const { placements, bearingRad } = layoutRow(START, diagonal, singles(4));
    expect(bearingRad).toBeCloseTo(Math.PI / 4, 2);
    // Each successive centre moves both north and east.
    for (let i = 1; i < placements.length; i++) {
      expect(placements[i]!.centroid.lat).toBeGreaterThan(
        placements[i - 1]!.centroid.lat,
      );
      expect(placements[i]!.centroid.lng).toBeGreaterThan(
        placements[i - 1]!.centroid.lng,
      );
    }
  });
});

describe("the footprint of each lot", () => {
  it("lays WIDTH along the row and DEPTH across it", () => {
    // Swapped, this produces a perfectly tidy row turned ninety degrees
    // from the truth — graves dug across the path instead of along it.
    const { placements } = layoutRow(START, east(30), [
      { widthM: 4, depthM: 1 },
    ]);
    const poly = placements[0]!.polygon;
    expect(poly).toHaveLength(4);

    // Extent east-west should be the width; north-south the depth.
    const lngs = poly.map((p) => p.lng);
    const lats = poly.map((p) => p.lat);
    const widthSpan =
      (Math.max(...lngs) - Math.min(...lngs)) * metresPerDegLng(START.lat);
    const depthSpan = (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT;
    expect(widthSpan).toBeCloseTo(4, 1);
    expect(depthSpan).toBeCloseTo(1, 1);
  });

  it("turns the footprint with the row", () => {
    // A row on the diagonal whose plots are still square to north would
    // be a giveaway that the angle was thrown away.
    const diagonal: LatLng = { lat: north(30).lat, lng: east(30).lng };
    const { placements } = layoutRow(START, diagonal, [
      { widthM: 4, depthM: 1 },
    ]);
    const poly = placements[0]!.polygon;
    const lngs = poly.map((p) => p.lng);
    const lats = poly.map((p) => p.lat);
    const eSpan =
      (Math.max(...lngs) - Math.min(...lngs)) * metresPerDegLng(START.lat);
    const nSpan = (Math.max(...lats) - Math.min(...lats)) * M_PER_DEG_LAT;
    // On a 45° row a 4×1 plot spans about 3.5m each way, not 4 by 1.
    expect(eSpan).toBeCloseTo(nSpan, 1);
    expect(eSpan).toBeGreaterThan(3);
    expect(eSpan).toBeLessThan(4);
  });
});

describe("telling the truth about the fit", () => {
  it("says nothing when the row matches the line", () => {
    // 12 singles at 2.5m is 30m.
    const layout = layoutRow(START, east(30), singles(12));
    expect(fitRatio(layout)).toBeCloseTo(1, 2);
    expect(fitWarning(layout)).toBeNull();
  });

  it("says so when the lots overrun the line", () => {
    const layout = layoutRow(START, east(10), singles(12));
    expect(fitWarning(layout)).toMatch(/runs past/i);
    expect(fitWarning(layout)).toMatch(/30m/);
  });

  it("says so when the lots stop short", () => {
    const layout = layoutRow(START, east(60), singles(12));
    expect(fitWarning(layout)).toMatch(/stops short/i);
  });

  it("tolerates a small mismatch without nagging", () => {
    // Nobody clicks to the metre. Complaining about 5% would train
    // people to ignore the warning that matters.
    const layout = layoutRow(START, east(31), singles(12));
    expect(Math.abs(fitRatio(layout) - 1)).toBeLessThan(FIT_TOLERANCE);
    expect(fitWarning(layout)).toBeNull();
  });

  it("catches a line with no length instead of producing NaN", () => {
    const layout = layoutRow(START, START, singles(4));
    expect(fitWarning(layout)).toMatch(/no length/i);
    for (const p of layout.placements) {
      expect(Number.isFinite(p.centroid.lat)).toBe(true);
      expect(Number.isFinite(p.centroid.lng)).toBe(true);
    }
  });

  it("survives a lot with nonsense dimensions", () => {
    const layout = layoutRow(START, east(30), [
      { widthM: Number.NaN, depthM: -3 },
      { widthM: 2.5, depthM: 1.2 },
    ]);
    for (const p of layout.placements) {
      expect(Number.isFinite(p.centroid.lat)).toBe(true);
    }
    expect(layout.rowLengthM).toBeCloseTo(2.5, 5);
  });
});
