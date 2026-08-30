/**
 * Standing at a lot with a phone.
 *
 * A grave is 2.5m wide and a phone reports 3–10m on a good day. That
 * gap is the whole subject: every function here exists to stop a
 * coordinate being presented as more certain than it is, because a
 * coordinate looks equally precise however it was obtained.
 *
 * The failures worth guarding are the flattering ones. Averaging ten
 * ±8m fixes and reporting ±2.5m is arithmetically defensible and false.
 * Nothing throws; the marker simply lands on the wrong grave, and the
 * office believes it.
 */

import { describe, expect, it } from "vitest";
import {
  blockedReason,
  canSave,
  GRAVE_WIDTH_M,
  MAX_USABLE_ACCURACY_M,
  MIN_SAMPLES,
  qualityOf,
  summarise,
  type GpsSample,
} from "@/lib/gpsCapture";

const AT = { lat: 16.3959, lng: 120.3556 };

function sample(over: Partial<GpsSample> = {}): GpsSample {
  return { lat: AT.lat, lng: AT.lng, accuracyM: 5, at: 0, ...over };
}

/** Metres north of the base point, as a latitude. */
function northOf(m: number): number {
  return AT.lat + m / 110_574;
}

describe("what a radius means in a cemetery", () => {
  it("never calls a phone fix better than one grave", () => {
    // The temptation is to call 3m "precise". It is not — it is about
    // one grave's width, and the person should still read the marker.
    const q = qualityOf(2);
    expect(q.quality).toBe("good");
    expect(q.meaning).toMatch(/grave/i);
  });

  it("says a mid-range fix may be a lot or two out", () => {
    expect(qualityOf(8).quality).toBe("usable");
    expect(qualityOf(8).meaning).toMatch(/lot or two/i);
  });

  it("says a coarse fix gets the block and not the lot", () => {
    expect(qualityOf(18).quality).toBe("coarse");
    expect(qualityOf(18).meaning).toMatch(/block/i);
  });

  it("refuses anything past the usable limit", () => {
    expect(qualityOf(MAX_USABLE_ACCURACY_M + 1).quality).toBe("unusable");
  });

  it("refuses a reading that claims no accuracy at all", () => {
    expect(qualityOf(0).quality).toBe("unusable");
    expect(qualityOf(Number.NaN).quality).toBe("unusable");
    expect(qualityOf(-5).quality).toBe("unusable");
  });

  it("sets its bands against the width of a grave", () => {
    expect(GRAVE_WIDTH_M).toBe(2.5);
    expect(MAX_USABLE_ACCURACY_M).toBe(10 * GRAVE_WIDTH_M);
  });
});

describe("combining what the phone reported", () => {
  it("has nothing to say about nothing", () => {
    expect(summarise([])).toBeNull();
  });

  it("throws out the hopeless readings and counts them", () => {
    const fix = summarise([
      sample({ accuracyM: 4 }),
      sample({ accuracyM: 400 }),
      sample({ accuracyM: 6 }),
    ]);
    expect(fix?.usedCount).toBe(2);
    expect(fix?.rejectedCount).toBe(1);
  });

  it("is null when every reading was hopeless", () => {
    expect(summarise([sample({ accuracyM: 900 })])).toBeNull();
  });

  it("WEIGHTS a tight fix above a loose one", () => {
    // Evenly averaging lets the worst reading drag the answer, which is
    // the opposite of what taking more samples is for. A ±2m fix should
    // pull far harder than a ±20m one.
    const fix = summarise([
      sample({ accuracyM: 2, lat: AT.lat }),
      sample({ accuracyM: 20, lat: northOf(100) }),
    ]);
    // The even mean would be ~50m north. Inverse-variance weighting
    // puts it within a metre or two of the good fix.
    const northM = ((fix!.lat - AT.lat) * 110_574);
    expect(northM).toBeLessThan(2);
  });

  it("does NOT claim precision the samples do not support", () => {
    // The flattering bug. Ten ±8m readings combined the textbook way
    // give ±2.5m, which is tidy and false: GPS error is correlated
    // between readings seconds apart, so ten samples are nothing like
    // ten independent measurements.
    const ten = Array.from({ length: 10 }, (_, i) =>
      sample({ accuracyM: 8, at: i * 1000 }),
    );
    expect(summarise(ten)!.accuracyM).toBeGreaterThanOrEqual(8);
  });

  it("reports the SPREAD when the readings disagree", () => {
    // Two confident fixes forty metres apart are not a confident
    // position. The disagreement is the real error bar.
    const fix = summarise([
      sample({ accuracyM: 3, lat: AT.lat }),
      sample({ accuracyM: 3, lat: northOf(40) }),
    ]);
    expect(fix!.accuracyM).toBeGreaterThan(15);
  });

  it("reports the claimed radius when the readings agree", () => {
    // Samples all at one point cannot make a ±6m phone into a ±0m one.
    const fix = summarise([
      sample({ accuracyM: 6 }),
      sample({ accuracyM: 6 }),
      sample({ accuracyM: 6 }),
    ]);
    expect(fix!.accuracyM).toBeCloseTo(6, 5);
  });
});

describe("whether it may be saved", () => {
  it("will not save a single reading", () => {
    // One tap is the thing this whole module exists to replace.
    const fix = summarise([sample({ accuracyM: 4 })]);
    expect(canSave(fix)).toBe(false);
    expect(blockedReason(fix)).toMatch(/keep still/i);
  });

  it("saves once enough good readings agree", () => {
    const fix = summarise(
      Array.from({ length: MIN_SAMPLES }, (_, i) =>
        sample({ accuracyM: 4, at: i * 1000 }),
      ),
    );
    expect(canSave(fix)).toBe(true);
    expect(blockedReason(fix)).toBeNull();
  });

  it("will not save readings that are spread across a block", () => {
    const fix = summarise([
      sample({ accuracyM: 5, lat: AT.lat }),
      sample({ accuracyM: 5, lat: northOf(60) }),
      sample({ accuracyM: 5, lat: northOf(120) }),
    ]);
    expect(canSave(fix)).toBe(false);
    expect(blockedReason(fix)).toMatch(/spread out/i);
  });

  it("tells somebody with no fix what to actually do", () => {
    expect(canSave(null)).toBe(false);
    expect(blockedReason(null)).toMatch(/walls and trees/i);
  });
});
