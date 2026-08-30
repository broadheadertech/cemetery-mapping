/**
 * The number that decides when to develop the next parcel.
 *
 * `phasePlanning` computes a runway from a hand-entered
 * `monthlyAbsorption`. This module measures the same thing from real
 * contracts, so the two can be compared — and the comparison is the
 * point: a plan assuming twelve lots a month in a park that sells four
 * schedules the next parcel three years late.
 *
 * Most of these tests are about what the module refuses to claim. A
 * confident rate measured from two months of data, or an `Infinity`
 * runway from a zero sales rate, is worse than no answer, because
 * someone will plan against it.
 */

import { describe, it, expect } from "vitest";

import {
  comparePlanToMeasured,
  computeRunway,
  measureAbsorption,
  sellThroughPercent,
  MIN_MONTHS_FOR_CONFIDENCE,
} from "../../../../convex/lib/absorption";

/** A full year at a steady rate. */
const steady = (n: number): number[] => Array.from({ length: 12 }, () => n);

describe("measuring the rate", () => {
  it("averages a steady year", () => {
    const r = measureAbsorption(steady(5));
    expect(r.perMonth).toBe(5);
    expect(r.totalSold).toBe(60);
    expect(r.monthsObserved).toBe(12);
    expect(r.confidence).toBe("good");
  });

  it("counts only from the first sale, not the whole window", () => {
    // A park that opened four months ago has four months of history.
    // Averaging across twelve divides its rate by three and makes the
    // ground look like it lasts forever.
    const r = measureAbsorption([0, 0, 0, 0, 0, 0, 0, 0, 6, 6, 6, 6]);
    expect(r.monthsObserved).toBe(4);
    expect(r.perMonth).toBe(6);
  });

  it("treats a gap after the first sale as a real month of zero", () => {
    // A quiet month IS the business. Skipping it would flatter the rate.
    const r = measureAbsorption([4, 0, 0, 4]);
    expect(r.monthsObserved).toBe(4);
    expect(r.perMonth).toBe(2);
  });

  it("reports no rate at all when nothing sold", () => {
    const r = measureAbsorption(steady(0));
    expect(r.perMonth).toBe(0);
    expect(r.confidence).toBe("insufficient");
    expect(r.caveat).toContain("not infinite");
  });

  it("ignores negative and non-finite entries", () => {
    const r = measureAbsorption([5, -3, Number.NaN, 5]);
    expect(r.totalSold).toBe(10);
  });
});

describe("what the rate admits about itself", () => {
  it("calls two months insufficient", () => {
    const r = measureAbsorption([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8]);
    expect(r.confidence).toBe("insufficient");
    expect(r.caveat).toContain("not a planning figure");
  });

  it("calls four months thin", () => {
    const r = measureAbsorption([0, 0, 0, 0, 0, 0, 0, 0, 5, 5, 5, 5]);
    expect(r.confidence).toBe("thin");
    expect(r.caveat).toContain("development budget");
  });

  it("is confident at six months", () => {
    const r = measureAbsorption([0, 0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 5]);
    expect(r.monthsObserved).toBe(MIN_MONTHS_FOR_CONFIDENCE);
    expect(r.confidence).toBe("good");
  });
});

describe("trend", () => {
  it("calls a flat year steady", () => {
    expect(measureAbsorption(steady(6)).trend).toBe("steady");
  });

  it("does not call ordinary month-to-month wobble a trend", () => {
    // Eight a month, six in a slow one. Nothing has changed, and a
    // flag here would train people to ignore the flag.
    const r = measureAbsorption([8, 7, 8, 9, 8, 7, 8, 8, 7, 8, 7, 8]);
    expect(r.trend).toBe("steady");
  });

  it("spots a genuine slowdown", () => {
    const r = measureAbsorption([10, 10, 10, 10, 10, 10, 3, 3, 3, 3, 3, 3]);
    expect(r.trend).toBe("slowing");
    expect(r.caveat).toContain("behind");
  });

  it("spots a genuine acceleration", () => {
    const r = measureAbsorption([2, 2, 2, 2, 2, 2, 9, 9, 9, 9, 9, 9]);
    expect(r.trend).toBe("accelerating");
  });

  it("says which figure the runway used", () => {
    // Otherwise a reader cannot tell whether the runway already
    // accounts for the slowdown they were just told about.
    const r = measureAbsorption([10, 10, 10, 10, 10, 10, 3, 3, 3, 3, 3, 3]);
    expect(r.caveat).toContain("full-year figure");
  });
});

describe("runway", () => {
  it("divides inventory by the rate", () => {
    const r = computeRunway(120, 5);
    expect(r.months).toBe(24);
    expect(r.years).toBe(2);
  });

  it("NEVER returns infinity for a zero rate", () => {
    // "∞ years of inventory" renders perfectly well on a screen
    // somebody plans a development budget against.
    const r = computeRunway(500, 0);
    expect(r.months).toBeNull();
    expect(r.years).toBeNull();
    expect(Number.isFinite(r.months as number)).toBe(false);
    expect(r.label).toContain("Not measurable");
  });

  it("says sold out when nothing is left", () => {
    const r = computeRunway(0, 5);
    expect(r.months).toBe(0);
    expect(r.label).toContain("Sold out");
    expect(r.isUrgent).toBe(true);
  });

  it("speaks in months under a year and years above", () => {
    expect(computeRunway(30, 5).label).toContain("month");
    expect(computeRunway(300, 5).label).toContain("year");
  });

  it("flags two years or less as urgent", () => {
    // Survey, permits and development do not fit inside a shorter
    // window, so this is the point a plan becomes a deadline.
    expect(computeRunway(120, 5).isUrgent).toBe(true);
    expect(computeRunway(125, 5).isUrgent).toBe(false);
  });

  it("treats a fractional lot count as whole lots", () => {
    expect(computeRunway(10.9, 1).months).toBe(10);
  });
});

describe("checking the phase plan against reality", () => {
  const measured = (perMonth: number) => measureAbsorption(steady(perMonth));

  it("agrees when the plan is close", () => {
    const v = comparePlanToMeasured(5, measured(5));
    expect(v.verdict).toBe("agrees");
    expect(v.percentOfPlan).toBe(100);
  });

  it("tolerates a quarter either way without crying wolf", () => {
    expect(comparePlanToMeasured(4, measured(5)).verdict).toBe("agrees");
    expect(comparePlanToMeasured(6, measured(5)).verdict).toBe("agrees");
  });

  it("flags selling ABOVE plan as the risk", () => {
    // The dangerous direction, and the one worth interrupting someone
    // for. The plan assumes three a month; nine are going out. The
    // ground runs out in a third of the planned time, and survey and
    // permits cannot be compressed to catch up.
    const v = comparePlanToMeasured(3, measured(9));
    expect(v.verdict).toBe("sales_above_plan");
    expect(v.isRisk).toBe(true);
    expect(v.message).toContain("run out sooner");
    expect(v.message).toContain("survey and permits");
  });

  it("flags selling below plan, but not as a risk", () => {
    // Capital committed early is a real cost — worth reporting, not
    // worth alarming anyone about.
    const v = comparePlanToMeasured(12, measured(4));
    expect(v.verdict).toBe("sales_below_plan");
    expect(v.isRisk).toBe(false);
    expect(v.message).toContain("earlier than it needs to be");
  });

  it("refuses to judge on insufficient history", () => {
    const thin = measureAbsorption([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8]);
    const v = comparePlanToMeasured(5, thin);
    expect(v.verdict).toBe("unknown");
    expect(v.isRisk).toBe(false);
    expect(v.message).toContain("Not enough sales history");
  });

  it("refuses to judge a phase with no assumed rate", () => {
    const v = comparePlanToMeasured(0, measured(5));
    expect(v.verdict).toBe("unknown");
  });
});

describe("sell-through", () => {
  it("is the share no longer available", () => {
    expect(sellThroughPercent(100, 25)).toBe(75);
  });

  it("is zero for an empty section rather than NaN", () => {
    expect(sellThroughPercent(0, 0)).toBe(0);
  });

  it("clamps a nonsense available count", () => {
    expect(sellThroughPercent(100, 150)).toBe(0);
    expect(sellThroughPercent(100, -5)).toBe(100);
  });
});
