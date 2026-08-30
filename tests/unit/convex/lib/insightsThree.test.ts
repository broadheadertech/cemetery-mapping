/**
 * Three more readings: how gardens are bought, how long lots sit empty,
 * and whether enquiries turn into sales.
 *
 * The one that needed the most care is the last. Linking an enquiry to
 * its contract is done BY HAND, so a sale nobody linked looks exactly
 * like an enquiry that went nowhere. A park reading that rate as a
 * truth concludes its marketing is failing when its desk is simply not
 * ticking a box — an expensive misreading, and the module says so
 * rather than letting the number speak for itself.
 */

import { describe, it, expect } from "vitest";

import {
  analyseEnquiries,
  analyseIntermentTiming,
  analysePlanMix,
  AT_NEED_DAYS,
  MIN_CONTRACTS_FOR_MIX,
  TERM_HEAVY_SHARE,
  type EnquiryFacts,
  type Insight,
  type IntermentTimingFacts,
  type PlanMixFacts,
  type PlanMixLine,
} from "../../../../convex/lib/insights";

const at = (rows: Insight[], level: Insight["level"]): Insight[] =>
  rows.filter((i) => i.level === level);

const text = (rows: Insight[]): string =>
  rows.map((i) => `${i.headline} ${i.detail} ${i.action ?? ""}`).join(" ");

// --- plan mix ----------------------------------------------------------

function mixLine(over: Partial<PlanMixLine> = {}): PlanMixLine {
  return {
    key: "faith",
    label: "Garden of Faith",
    cashContracts: 5,
    termContracts: 5,
    averageTermMonths: 24,
    averageDepositPercent: 20,
    outstandingCents: 500_000_00,
    behindContracts: 0,
    ...over,
  };
}

function mix(rows: PlanMixLine[]): PlanMixFacts {
  return { windowMonths: 12, bySection: rows };
}

describe("how a garden is being bought", () => {
  it("says nothing when there are no sales", () => {
    const out = analysePlanMix(mix([]));
    expect(out).toHaveLength(1);
    expect(out[0]?.headline).toContain("No sales");
  });

  it("separates what has gone from what is paid for", () => {
    // A sell-through number treats every sale the same. It should not.
    const out = analysePlanMix(mix([mixLine()]));
    expect(at(out, "descriptive")[0]?.detail).toContain(
      "how much of it is actually paid for",
    );
  });

  it("reports no exposure when everything was cash", () => {
    const out = analysePlanMix(
      mix([mixLine({ termContracts: 0, outstandingCents: 0 })]),
    );
    expect(text(out)).toContain("no instalment exposure at all");
    expect(at(out, "diagnostic")).toHaveLength(0);
  });

  it("REFUSES to call a mix a pattern on too few contracts", () => {
    expect(MIN_CONTRACTS_FOR_MIX).toBe(5);
    const out = analysePlanMix(
      mix([mixLine({ cashContracts: 1, termContracts: 2 })]),
    );
    expect(text(out)).toContain("enough sales to call its mix a pattern");
  });

  it("flags a garden the park has effectively lent against", () => {
    expect(TERM_HEAVY_SHARE).toBe(0.7);
    const out = analysePlanMix(
      mix([
        mixLine({
          label: "Garden of Peace",
          cashContracts: 2,
          termContracts: 18,
          outstandingCents: 3_000_000_00,
        }),
      ]),
    );
    const t = text(out);
    expect(t).toContain("Garden of Peace is 90% sold on terms");
    expect(t).toContain("cannot be resold, but the money is years away");
  });

  it("says when those contracts are already falling behind", () => {
    const out = analysePlanMix(
      mix([
        mixLine({
          cashContracts: 2,
          termContracts: 18,
          behindContracts: 6,
          outstandingCents: 3_000_000_00,
        }),
      ]),
    );
    expect(text(out)).toContain("sell twice");
  });

  it("flags deposits that differ sharply between gardens", () => {
    // The deposit is the best single predictor of whether a contract is
    // honoured, so a garden sold on thin ones is being lent to hardest.
    const out = analysePlanMix(
      mix([
        mixLine({ key: "a", label: "Garden A", averageDepositPercent: 10 }),
        mixLine({ key: "b", label: "Garden B", averageDepositPercent: 35 }),
      ]),
    );
    expect(text(out)).toContain("Deposits differ sharply by garden");
  });

  it("stays quiet when deposits are similar", () => {
    const out = analysePlanMix(
      mix([
        mixLine({ key: "a", label: "Garden A", averageDepositPercent: 20 }),
        mixLine({ key: "b", label: "Garden B", averageDepositPercent: 25 }),
      ]),
    );
    expect(text(out)).not.toContain("Deposits differ sharply");
  });

  it("prescribes a deposit rather than a price cut", () => {
    const out = analysePlanMix(
      mix([
        mixLine({
          cashContracts: 1,
          termContracts: 19,
          outstandingCents: 3_000_000_00,
        }),
      ]),
    );
    const p = at(out, "prescriptive");
    expect(text(p)).toContain("higher deposit");
    expect(p[0]?.action).toContain("Payment plans");
  });
});

// --- time to interment -------------------------------------------------

function timing(over: Partial<IntermentTimingFacts> = {}): IntermentTimingFacts {
  return {
    soldEmptyLots: 40,
    longEmptyLots: 0,
    usedLots: 20,
    daysToFirstInterment: [10, 400, 800, 1200, 2000],
    intermentsInWindow: 12,
    windowMonths: 12,
    ...over,
  };
}

describe("how long a lot sits sold and empty", () => {
  it("says nothing when nothing has been sold", () => {
    const out = analyseIntermentTiming(
      timing({ soldEmptyLots: 0, usedLots: 0, daysToFirstInterment: [] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.headline).toContain("No sold lots");
  });

  it("counts the empty lots even before any has been used", () => {
    const out = analyseIntermentTiming(
      timing({ usedLots: 0, daysToFirstInterment: [] }),
    );
    expect(out[0]?.headline).toContain("40 lots are sold and still empty");
    expect(out[0]?.detail).toContain("no waiting time to measure");
    // Nothing further can honestly be said.
    expect(at(out, "diagnostic")).toHaveLength(0);
  });

  it("calls a park that buries within a month an at-need park", () => {
    expect(AT_NEED_DAYS).toBe(30);
    const out = analyseIntermentTiming(
      timing({ daysToFirstInterment: [1, 3, 5, 10, 900] }),
    );
    const t = text(out);
    expect(t).toContain("mostly at need");
    expect(t).toContain("sales follow deaths rather than marketing");
  });

  it("calls a planning park a pre-need one, and names the cost", () => {
    // The better business, but it commits the park to years of
    // maintenance with no interment work.
    const out = analyseIntermentTiming(
      timing({ daysToFirstInterment: [900, 1200, 1500, 2000, 2500] }),
    );
    const t = text(out);
    expect(t).toContain("mostly ahead of need");
    expect(t).toContain("carrying maintenance");
  });

  it("says nothing about the type when the mix is in between", () => {
    const out = analyseIntermentTiming(
      timing({ daysToFirstInterment: [1, 5, 900, 1200] }),
    );
    const t = text(out);
    expect(t).not.toContain("mostly at need");
    expect(t).not.toContain("mostly ahead of need");
  });

  it("raises lots empty for more than five years", () => {
    const out = analyseIntermentTiming(timing({ longEmptyLots: 12 }));
    const t = text(out);
    expect(t).toContain("empty for over five years");
    expect(t).toContain("may have moved, died elsewhere");
  });

  it("prescribes checking the contact details before somebody dies", () => {
    const out = analyseIntermentTiming(timing({ longEmptyLots: 12 }));
    expect(text(at(out, "prescriptive"))).toContain(
      "a problem in front of a grieving family",
    );
  });

  it("connects a pre-need park back to perpetual care", () => {
    // Perpetual care was priced against an assumption about the wait.
    // This is that assumption, measured.
    const out = analyseIntermentTiming(
      timing({ daysToFirstInterment: [900, 1200, 1500, 2000] }),
    );
    expect(text(at(out, "prescriptive"))).toContain("perpetual care");
  });

  it("does not pretend to predict when people will die", () => {
    const out = analyseIntermentTiming(timing());
    const p = at(out, "predictive")[0];
    expect(p?.detail).toContain("depends on when people die");
    expect(p?.detail).toContain("not a projection of the backlog");
  });

  it("is speculative on a handful of interments", () => {
    const out = analyseIntermentTiming(timing({ intermentsInWindow: 3 }));
    expect(at(out, "predictive")[0]?.confidence).toBe("speculative");
  });
});

// --- enquiries ---------------------------------------------------------

function enquiry(over: Partial<EnquiryFacts> = {}): EnquiryFacts {
  return {
    windowMonths: 12,
    total: 100,
    converted: 20,
    untouched: 0,
    open: 10,
    daysToConvert: [5, 10, 14, 21, 30, 45, 60, 90, 120, 150],
    byKind: [
      { kind: "visit", total: 50, converted: 15 },
      { kind: "pricing", total: 50, converted: 5 },
    ],
    unlinkedContracts: 5,
    ...over,
  };
}

describe("whether enquiries turn into sales", () => {
  it("says nothing when there are none", () => {
    const out = analyseEnquiries(enquiry({ total: 0 }));
    expect(out).toHaveLength(1);
  });

  it("reports the rate as a FLOOR, not a truth", () => {
    // The single most important sentence here. Linking is manual, and a
    // sale nobody linked looks like an enquiry that went nowhere.
    const out = analyseEnquiries(enquiry());
    const d = at(out, "descriptive")[0];
    expect(d?.headline).toContain("at least 20%");
    expect(d?.detail).toContain("done by hand");
  });

  it("warns loudly when most contracts carry no enquiry at all", () => {
    // Otherwise the park reads a paperwork habit as a marketing failure.
    const out = analyseEnquiries(
      enquiry({ converted: 5, unlinkedContracts: 60 }),
    );
    const t = text(out);
    expect(t).toContain("probably understating the truth");
    expect(t).toContain("measures the habit rather than the marketing");
  });

  it("does not cry wolf when linking is being done", () => {
    const out = analyseEnquiries(
      enquiry({ converted: 30, unlinkedContracts: 4 }),
    );
    expect(text(out)).not.toContain("understating the truth");
  });

  it("names enquiries nobody ever picked up", () => {
    const out = analyseEnquiries(enquiry({ untouched: 18 }));
    const t = text(out);
    expect(t).toContain("never been picked up");
    expect(t).toContain("nobody answered");
  });

  it("prescribes answering them as the cheapest thing available", () => {
    const out = analyseEnquiries(enquiry({ untouched: 18 }));
    expect(text(at(out, "prescriptive"))).toContain("cheapest thing on this page");
  });

  it("compares the kinds of enquiry when both have enough", () => {
    const out = analyseEnquiries(enquiry());
    const t = text(out);
    expect(t).toContain("visit enquiries convert better");
  });

  it("will not compare a kind with fewer than five", () => {
    const out = analyseEnquiries(
      enquiry({
        byKind: [
          { kind: "visit", total: 50, converted: 25 },
          { kind: "pricing", total: 3, converted: 0 },
        ],
      }),
    );
    expect(text(out)).not.toContain("convert better");
  });

  it("gives the sales cycle a median, and hedges it", () => {
    const out = analyseEnquiries(enquiry());
    const p = at(out, "predictive")[0];
    expect(p?.headline).toContain("takes about");
    expect(p?.detail).toContain("rather than a deadline");
  });

  it("is speculative on a handful of linked sales", () => {
    const out = analyseEnquiries(enquiry({ daysToConvert: [5, 10, 14] }));
    expect(at(out, "predictive")[0]?.confidence).toBe("speculative");
  });

  it("says nothing about timing on fewer than three", () => {
    const out = analyseEnquiries(enquiry({ daysToConvert: [5, 10] }));
    expect(at(out, "predictive")).toHaveLength(0);
  });

  it("asks the desk to start linking", () => {
    const out = analyseEnquiries(
      enquiry({ converted: 2, unlinkedContracts: 40 }),
    );
    const p = at(out, "prescriptive");
    expect(text(p)).toContain("link a sale to its enquiry");
    expect(text(p)).toContain("cannot tell a marketing problem from a paperwork one");
  });
});

// --- the shared discipline ---------------------------------------------

describe("the discipline holds across all three", () => {
  const everything = [
    ...analysePlanMix(
      mix([
        mixLine({ cashContracts: 2, termContracts: 18, behindContracts: 4 }),
        mixLine({ key: "b", label: "Garden B", averageDepositPercent: 40 }),
      ]),
    ),
    ...analyseIntermentTiming(timing({ longEmptyLots: 5 })),
    ...analyseEnquiries(enquiry({ untouched: 5, unlinkedContracts: 60 })),
  ];

  it("produces findings at every level", () => {
    for (const level of [
      "descriptive",
      "diagnostic",
      "predictive",
      "prescriptive",
    ] as const) {
      expect(at(everything, level).length, level).toBeGreaterThan(0);
    }
  });

  it("gives every finding a basis", () => {
    for (const i of everything) {
      expect(i.basis.length, i.headline).toBeGreaterThan(10);
    }
  });

  it("gives every prescription an action", () => {
    for (const i of at(everything, "prescriptive")) {
      expect(i.action, i.headline).toBeDefined();
    }
  });

  it("never puts an action on anything else", () => {
    for (const i of everything) {
      if (i.level === "prescriptive") continue;
      expect(i.action, i.headline).toBeUndefined();
    }
  });

  it("never labels a projection as observed", () => {
    for (const i of at(everything, "predictive")) {
      expect(i.confidence, i.headline).not.toBe("observed");
    }
  });
});
