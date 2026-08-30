/**
 * The arithmetic behind drawing the park as it actually is.
 *
 * These are the errors that would not look like errors. A park mirrored
 * front to back still renders a tidy map; lots drawn square to north in
 * a garden surveyed on an angle still look deliberate; an unplaced lot
 * drawn on its placeholder centroid puts a grave in the middle of the
 * park with total confidence. Nothing throws in any of those cases,
 * which is why they are checked against numbers here rather than left
 * to the eye.
 */

import { describe, expect, it } from "vitest";
import {
  bearingOf,
  decideMode,
  extentOf,
  footprintOf,
  metresBetween,
  projectToScene,
  type SectionCounts,
} from "@/lib/mapSurvey";

// Aringay, La Union — the park this is for.
const ORIGIN = { lat: 16.3959, lng: 120.3556 };

describe("putting a coordinate in the scene", () => {
  it("puts the origin at the origin", () => {
    const p = projectToScene(ORIGIN, ORIGIN);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });

  it("runs north to NEGATIVE z", () => {
    // The error that mirrors the park front to back. It renders a
    // perfectly tidy map of a cemetery nobody can navigate.
    const north = projectToScene(
      { lat: ORIGIN.lat + 0.001, lng: ORIGIN.lng },
      ORIGIN,
    );
    expect(north.z).toBeLessThan(0);
    expect(north.x).toBeCloseTo(0, 6);
  });

  it("runs east to positive x", () => {
    const east = projectToScene(
      { lat: ORIGIN.lat, lng: ORIGIN.lng + 0.001 },
      ORIGIN,
    );
    expect(east.x).toBeGreaterThan(0);
    expect(east.z).toBeCloseTo(0, 6);
  });

  it("gets the scale right — a thousandth of a degree is about 111m", () => {
    const north = projectToScene(
      { lat: ORIGIN.lat + 0.001, lng: ORIGIN.lng },
      ORIGIN,
    );
    expect(Math.abs(north.z)).toBeGreaterThan(110);
    expect(Math.abs(north.z)).toBeLessThan(112);
  });

  it("narrows longitude by the latitude's cosine", () => {
    // A degree of longitude is shorter away from the equator. Skipping
    // the cosine stretches the park east-west by about four percent at
    // this latitude — enough to make square lots draw as oblongs.
    //
    // Checked against the metres the cosine predicts, not against the
    // north/south ratio: the two metres-per-degree constants are not
    // equal (111_320 at the equator versus 110_574 for latitude), so
    // that ratio is the cosine times 1.0067 and asserting the bare
    // cosine would be testing the wrong number.
    const east = projectToScene(
      { lat: ORIGIN.lat, lng: ORIGIN.lng + 0.001 },
      ORIGIN,
    );
    const north = projectToScene(
      { lat: ORIGIN.lat + 0.001, lng: ORIGIN.lng },
      ORIGIN,
    );
    expect(east.x).toBeLessThan(Math.abs(north.z));

    const cos = Math.cos((ORIGIN.lat * Math.PI) / 180);
    expect(east.x).toBeCloseTo(0.001 * 111_320 * cos, 3);
    // And the cosine is genuinely doing work — without it the park
    // would be about four percent wider than it is.
    expect(east.x).toBeLessThan(0.001 * 111_320 * 0.99);
  });

  it("measures a real lot-sized distance sensibly", () => {
    // 2.5m is a single grave's width. If the projection were out by an
    // order of magnitude this is where it would show.
    const a = ORIGIN;
    const b = { lat: ORIGIN.lat, lng: ORIGIN.lng + 0.0000234 };
    expect(metresBetween(a, b)).toBeGreaterThan(2);
    expect(metresBetween(a, b)).toBeLessThan(3);
  });
});

describe("framing what was measured", () => {
  it("has no extent for nothing", () => {
    expect(extentOf([])).toBeNull();
  });

  it("bounds the points it is given", () => {
    const e = extentOf([
      { x: -5, z: 2 },
      { x: 10, z: -4 },
      { x: 3, z: 8 },
    ]);
    expect(e).toEqual({
      minX: -5,
      maxX: 10,
      minZ: -4,
      maxZ: 8,
      width: 15,
      depth: 12,
    });
  });
});

describe("a lot's measured outline", () => {
  it("projects every vertex", () => {
    const f = footprintOf(
      [
        { lat: ORIGIN.lat, lng: ORIGIN.lng },
        { lat: ORIGIN.lat + 0.00001, lng: ORIGIN.lng },
        { lat: ORIGIN.lat + 0.00001, lng: ORIGIN.lng + 0.00002 },
        { lat: ORIGIN.lat, lng: ORIGIN.lng + 0.00002 },
      ],
      ORIGIN,
    );
    expect(f).toHaveLength(4);
    expect(f?.[0]).toEqual({ x: 0, z: -0 });
  });

  it("refuses a degenerate outline rather than drawing a sliver", () => {
    // Two points are a line, not a plot. The caller falls back to the
    // lot's recorded dimensions, which is a weaker claim honestly made.
    expect(footprintOf([], ORIGIN)).toBeNull();
    expect(footprintOf([ORIGIN], ORIGIN)).toBeNull();
    expect(footprintOf([ORIGIN, ORIGIN], ORIGIN)).toBeNull();
  });
});

describe("which way a lot faces", () => {
  it("finds the bearing of the longest edge", () => {
    // A 4m × 2m plot lying east-west. Its long edge runs along x, so
    // the bearing is zero.
    const b = bearingOf([
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 4, z: 2 },
      { x: 0, z: 2 },
    ]);
    expect(b).toBeCloseTo(0, 6);
  });

  it("reports a lot surveyed on an angle", () => {
    // The whole point. A garden laid out at 45° to north, drawn square
    // to north, looks deliberate and is wrong.
    const b = bearingOf([
      { x: 0, z: 0 },
      { x: 4, z: 4 },
      { x: 3, z: 5 },
      { x: -1, z: 1 },
    ]);
    expect(b).toBeCloseTo(Math.PI / 4, 3);
  });

  it("does not simply take the first edge", () => {
    // A plot whose SHORT edge comes first. Taking edge zero would
    // rotate every lot in the park by ninety degrees.
    const b = bearingOf([
      { x: 0, z: 0 },
      { x: 0, z: 2 },
      { x: 6, z: 2 },
      { x: 6, z: 0 },
    ]);
    expect(Math.abs(Math.sin(b))).toBeLessThan(0.01);
  });
});

// --- which view the data can honestly support -------------------------

function sec(over: Partial<SectionCounts> = {}): SectionCounts {
  return {
    name: "garden-of-faith",
    displayName: "Garden of Faith",
    placedCount: 0,
    unplacedCount: 0,
    ...over,
  };
}

describe("choosing the view", () => {
  it("falls back to the arrangement when nothing is measured", () => {
    const d = decideMode([sec({ unplacedCount: 30 })]);
    expect(d.mode).toBe("arrangement");
    expect(d.canSwitch).toBe(false);
  });

  it("opens on the SURVEY as soon as anything is measured", () => {
    // One measurement beats any amount of arrangement. A stand-in
    // should not win over the real thing on volume.
    const d = decideMode([sec({ placedCount: 1, unplacedCount: 999 })]);
    expect(d.mode).toBe("survey");
  });

  it("still lets a half-surveyed park see its arrangement", () => {
    // Otherwise a park loses its map the day it places its first lot.
    const d = decideMode([sec({ placedCount: 10, unplacedCount: 20 })]);
    expect(d.canSwitch).toBe(true);
    expect(decideMode([sec({ placedCount: 10, unplacedCount: 20 })], "arrangement").mode).toBe(
      "arrangement",
    );
  });

  it("offers no switch once everything is measured", () => {
    // The grid would be a worse drawing of lots we know the real place
    // of. Offering it invites somebody to choose the lie.
    const d = decideMode([sec({ placedCount: 30, unplacedCount: 0 })]);
    expect(d.mode).toBe("survey");
    expect(d.canSwitch).toBe(false);
  });

  it("NAMES the gardens the survey view cannot draw", () => {
    // The silent failure: a garden with nothing placed simply is not
    // there, and the map looks complete.
    const d = decideMode([
      sec({ placedCount: 30 }),
      sec({
        name: "garden-of-hope",
        displayName: "Garden of Hope",
        unplacedCount: 12,
      }),
    ]);
    expect(d.missingSections).toEqual(["Garden of Hope"]);
  });

  it("does not call a garden missing when it has nothing in it at all", () => {
    const d = decideMode([
      sec({ placedCount: 30 }),
      sec({ name: "empty", displayName: "Empty Garden" }),
    ]);
    expect(d.missingSections).toEqual([]);
  });

  it("totals what is placed and what is not", () => {
    const d = decideMode([
      sec({ placedCount: 30, unplacedCount: 2 }),
      sec({ name: "b", displayName: "B", placedCount: 5, unplacedCount: 7 }),
    ]);
    expect(d.placedCount).toBe(35);
    expect(d.unplacedCount).toBe(9);
  });
});
