/**
 * Colouring the park by how well its positions are known.
 *
 * The failure this guards is overstatement. Every one of these lots is
 * drawn as a solid box at a real coordinate, so the map already looks
 * authoritative; the palette's whole job is to say which of those boxes
 * anybody actually measured. A band that flatters — counting a drawn
 * row as surveyed, or quietly dropping a source it does not recognise —
 * turns an auditing view into a reassuring one.
 */

import { describe, expect, it } from "vitest";
import {
  placementBand,
  placementSummary,
  PLACEMENT_BANDS,
  uncertaintyRadiusM,
} from "@/lib/placementPalette";

describe("which band a lot falls into", () => {
  it("classifies each source the app can write", () => {
    for (const source of ["imported", "gps", "drawn", "clicked"]) {
      expect(placementBand(source).kind).toBe(source);
    }
  });

  it("treats a missing source as unrecorded, not as surveyed", () => {
    // Records predating the field. Defaulting them to anything better
    // would claim a provenance nobody wrote down.
    expect(placementBand(null).kind).toBe("unknown");
  });

  it("makes an UNRECOGNISED source conspicuous rather than invisible", () => {
    // A lot the map cannot classify is exactly the lot somebody needs
    // to look at. Dropping it would hide the one thing worth finding.
    expect(placementBand("teleported").kind).toBe("unknown");
  });

  it("gives every band a colour and a plain-language meaning", () => {
    for (const band of PLACEMENT_BANDS) {
      expect(band.color).toBeGreaterThan(0);
      expect(band.label.length).toBeGreaterThan(0);
      expect(band.meaning.length).toBeGreaterThan(10);
    }
  });

  it("uses colours distinct from one another", () => {
    // Two bands the same colour is a legend that cannot be read.
    const colours = PLACEMENT_BANDS.map((b) => b.color);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it("reads best-known first", () => {
    expect(PLACEMENT_BANDS[0]!.kind).toBe("imported");
    expect(PLACEMENT_BANDS[PLACEMENT_BANDS.length - 1]!.kind).toBe("unknown");
  });
});

describe("the uncertainty ring", () => {
  it("sizes a phone fix by what the phone claimed", () => {
    expect(uncertaintyRadiusM("gps", 7)).toBe(7);
  });

  it("draws NO ring for a survey, a drawn row or a click", () => {
    // None of those recorded an uncertainty. A ring would invent a
    // number nobody measured, on the screen whose point is not doing
    // that.
    for (const source of ["imported", "drawn", "clicked", null]) {
      expect(uncertaintyRadiusM(source, 7)).toBeNull();
    }
  });

  it("draws no ring when the accuracy is missing or nonsense", () => {
    expect(uncertaintyRadiusM("gps", null)).toBeNull();
    expect(uncertaintyRadiusM("gps", 0)).toBeNull();
    expect(uncertaintyRadiusM("gps", Number.NaN)).toBeNull();
  });
});

describe("how much of the park is measured", () => {
  it("counts each band", () => {
    const s = placementSummary([
      { source: "imported" },
      { source: "gps" },
      { source: "gps" },
      { source: null },
    ]);
    expect(s.total).toBe(4);
    expect(s.counts.gps).toBe(2);
    expect(s.counts.unknown).toBe(1);
  });

  it("counts ONLY a real survey as measured", () => {
    // A drawn row has a true bearing and no measured plot. Calling it
    // measured is the exact overstatement this palette exists to stop.
    const s = placementSummary([
      { source: "drawn" },
      { source: "drawn" },
      { source: "imported" },
      { source: "gps" },
    ]);
    expect(s.measuredShare).toBeCloseTo(0.25, 6);
  });

  it("says nothing is measured when nothing is", () => {
    expect(placementSummary([]).measuredShare).toBe(0);
    expect(placementSummary([{ source: "gps" }]).measuredShare).toBe(0);
  });
});
