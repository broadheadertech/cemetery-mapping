/**
 * The plan shared by the flat map and the 3D view.
 *
 * This model exists to stop the two renderers disagreeing. A visitor
 * can toggle between Plan and 3D on `/find-a-grave`, and if the views
 * derived their own lots or statuses they would drift — plots would
 * appear to change hands as someone flipped back and forth. These tests
 * pin the properties that make the shared model worth having.
 */

import { describe, it, expect } from "vitest";

import {
  allLots,
  gridOf,
  lotCountOf,
  lotsOf,
  PLAN_HEIGHT,
  PLAN_WIDTH,
  SECTIONS,
  STATUS_COLOR,
} from "@/components/marketing/cemetery-model";

describe("the plan", () => {
  it("has the six named gardens the page advertises", () => {
    expect(SECTIONS.map((s) => s.label)).toEqual([
      "GARDEN OF GRACE",
      "GARDEN OF FAITH",
      "GARDEN OF HOPE",
      "COLUMBARIUM EAST",
      "GARDEN OF PEACE",
      "MAUSOLEUM ROW",
    ]);
  });

  it("keeps every garden inside the plan bounds", () => {
    for (const s of SECTIONS) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(PLAN_WIDTH);
      expect(s.y + s.h).toBeLessThanOrEqual(PLAN_HEIGHT);
    }
  });

  it("gives every garden a distinct section key", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("lots", () => {
  it("issues a unique code for every lot in the park", () => {
    const codes = allLots().map((l) => l.id);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("codes a lot with its section's key", () => {
    for (const s of SECTIONS) {
      for (const lot of lotsOf(s)) {
        expect(lot.id.startsWith(`${s.id}-`)).toBe(true);
        expect(lot.sectionLabel).toBe(s.label);
      }
    }
  });

  it("fills each garden with the lots its rectangle has room for", () => {
    // The count is derived from the garden's size, not declared — a
    // hand-picked number left most of every plot empty, which the 3D
    // view made obvious.
    for (const s of SECTIONS) {
      const { columns, rows } = gridOf(s);
      expect(lotsOf(s)).toHaveLength(columns * rows);
      expect(lotsOf(s)).toHaveLength(lotCountOf(s));
    }
  });

  it("gives a bigger garden more lots than a smaller one", () => {
    const peace = SECTIONS.find((s) => s.id === "E")!;
    const mausoleum = SECTIONS.find((s) => s.id === "F")!;
    expect(peace.w * peace.h).toBeGreaterThan(mausoleum.w * mausoleum.h);
    expect(lotCountOf(peace)).toBeGreaterThan(lotCountOf(mausoleum));
  });

  it("uses more than the top rows of every garden", () => {
    // The defect this replaced: lots clustered in one corner while the
    // rest of the plot sat blank.
    for (const s of SECTIONS) {
      expect(gridOf(s).rows).toBeGreaterThanOrEqual(4);
    }
  });

  it("keeps every lot inside its own garden", () => {
    for (const s of SECTIONS) {
      for (const lot of lotsOf(s)) {
        expect(lot.x).toBeGreaterThanOrEqual(s.x);
        expect(lot.y).toBeGreaterThanOrEqual(s.y);
        expect(lot.x + lot.w).toBeLessThanOrEqual(s.x + s.w);
        expect(lot.y + lot.h).toBeLessThanOrEqual(s.y + s.h);
      }
    }
  });

  it("never overlaps two lots in the same garden", () => {
    for (const s of SECTIONS) {
      const lots = lotsOf(s);
      for (let i = 0; i < lots.length; i++) {
        for (let j = i + 1; j < lots.length; j++) {
          const a = lots[i]!;
          const b = lots[j]!;
          const apart =
            a.x + a.w <= b.x ||
            b.x + b.w <= a.x ||
            a.y + a.h <= b.y ||
            b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      }
    }
  });
});

describe("determinism", () => {
  it("returns the same plan on every call", () => {
    // Both views call these independently, and the page renders on the
    // server before hydrating. Anything random here would desynchronise
    // the two views and mismatch the server markup.
    expect(allLots()).toEqual(allLots());
  });

  it("gives a lot code one status, whichever view asks", () => {
    const first = new Map(allLots().map((l) => [l.id, l.status]));
    for (const lot of allLots()) {
      expect(lot.status).toBe(first.get(lot.id));
    }
  });

  it("never fills a whole column with one status", () => {
    // Keying status on the running index let the pattern's period line
    // up with a garden's column count, marking every row of column zero
    // occupied — which the 3D view drew as a solid wall of headstones
    // down one edge instead of a scatter of plots.
    for (const s of SECTIONS) {
      const { columns, rows } = gridOf(s);
      const lots = lotsOf(s);
      for (let c = 0; c < columns; c++) {
        const inColumn = lots.filter((l) => l.column === c);
        const occupied = inColumn.filter((l) => l.status === "occupied");
        expect(occupied.length).toBeLessThan(rows);
      }
    }
  });

  it("leaves most of the park available, as a park selling plots would", () => {
    const lots = allLots();
    const available = lots.filter((l) => l.status === "available").length;
    expect(available / lots.length).toBeGreaterThan(0.5);
    expect(available / lots.length).toBeLessThan(0.95);
  });

  it("offers a spread of all three statuses to show", () => {
    const statuses = new Set(allLots().map((l) => l.status));
    expect(statuses).toEqual(new Set(["available", "reserved", "occupied"]));
  });

  it("has B-104 available — the lot the page opens on", () => {
    const b104 = allLots().find((l) => l.id === "B-104");
    expect(b104).toBeDefined();
    expect(b104!.status).toBe("available");
    expect(b104!.sectionLabel).toBe("GARDEN OF FAITH");
  });
});

describe("status colours", () => {
  it("gives each status its own colour", () => {
    const values = Object.values(STATUS_COLOR);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses the brand emerald for occupied and gold for reserved", () => {
    expect(STATUS_COLOR.occupied).toBe("#1D5C4D");
    expect(STATUS_COLOR.reserved).toBe("#C9A96B");
  });
});
