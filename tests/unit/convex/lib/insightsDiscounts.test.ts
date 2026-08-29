/**
 * Money given away at the desk.
 *
 * This is the section of the analytics that puts a person's name
 * against money the park did not collect, so the tests are mostly about
 * restraint:
 *
 *   - a plan's cash terms and a promotion are POLICY. Counting them as
 *     leakage would report a staffer for a decision the park made.
 *   - nobody is named on fewer than five contracts. One generous sale
 *     looks exactly like a habit at that sample size.
 *   - a repeated reason is read as a policy nobody wrote down, not as
 *     somebody cheating.
 *
 * The useful finding here is the last one: a discount typed the same
 * way twenty times belongs in the price book, where it is capped and
 * reported. That is worth more than any ranking.
 */

import { describe, it, expect } from "vitest";

import {
  analyseDiscounts,
  MIN_CONTRACTS_TO_JUDGE_DISCOUNTS,
  REPEATED_REASON_THRESHOLD,
  type DiscountFacts,
  type DiscountLine,
  type Insight,
} from "../../../../convex/lib/insights";

function line(over: Partial<DiscountLine> = {}): DiscountLine {
  return {
    key: "a",
    label: "Ana",
    contracts: 10,
    discountedContracts: 5,
    listCents: 500_000_00,
    discountCents: 25_000_00, // 5%
    ...over,
  };
}

function facts(over: Partial<DiscountFacts> = {}): DiscountFacts {
  return {
    windowMonths: 12,
    totalContracts: 40,
    discountedContracts: 12,
    totalDiscountCents: 120_000_00,
    discountedListCents: 1_200_000_00, // 10%
    byAgent: [line()],
    bySection: [],
    reasons: [],
    policyContracts: 5,
    ...over,
  };
}

const at = (rows: Insight[], level: Insight["level"]): Insight[] =>
  rows.filter((i) => i.level === level);

const text = (rows: Insight[]): string =>
  rows.map((i) => `${i.headline} ${i.detail} ${i.action ?? ""}`).join(" ");

describe("what counts as leakage", () => {
  it("counts only what was typed at the desk", () => {
    // The single most important sentence in this feature. A cash plan
    // taking 10% off is the park's decision, made once, by somebody
    // with the authority — reporting it here would put a staffer's name
    // against it.
    const out = analyseDiscounts(facts());
    expect(text(out)).toContain("not in this figure");
  });

  it("says so plainly when nothing was discounted", () => {
    const out = analyseDiscounts(
      facts({
        discountedContracts: 0,
        totalDiscountCents: 0,
        discountedListCents: 0,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.headline).toContain("No discretionary discounts");
    expect(out[0]?.detail).toContain("policy rather than discretion");
  });

  it("reports nothing to read when there are no contracts", () => {
    const out = analyseDiscounts(facts({ totalContracts: 0 }));
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe("observed");
  });

  it("leads with the peso figure, not a percentage", () => {
    // "10% average discount" is a statistic. "₱120,000 was given away"
    // is a number somebody does something about.
    const out = analyseDiscounts(facts());
    expect(at(out, "descriptive")[0]?.headline).toContain("₱120,000");
  });
});

describe("naming who discounts most", () => {
  it("REFUSES to name anybody on a thin sample", () => {
    // One generous sale looks exactly like a habit at four contracts,
    // and this report puts a name against money given away.
    expect(MIN_CONTRACTS_TO_JUDGE_DISCOUNTS).toBe(5);
    const out = analyseDiscounts(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", contracts: 4 }),
          line({ key: "b", label: "Ben", contracts: 3 }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Not enough contracts per seller");
    expect(t).not.toContain("discounts hardest");
  });

  it("names them once the sample supports it", () => {
    const out = analyseDiscounts(
      facts({
        byAgent: [
          line({
            key: "a",
            label: "Ana",
            contracts: 20,
            listCents: 1_000_000_00,
            discountCents: 120_000_00, // 12%
          }),
          line({
            key: "b",
            label: "Ben",
            contracts: 20,
            listCents: 1_000_000_00,
            discountCents: 20_000_00, // 2%
          }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Ana discounts hardest");
    expect(t).toContain("12%");
  });

  it("does not call a two-point spread a difference in habit", () => {
    const out = analyseDiscounts(
      facts({
        byAgent: [
          line({
            key: "a",
            label: "Ana",
            contracts: 20,
            listCents: 1_000_000_00,
            discountCents: 51_000_00,
          }),
          line({
            key: "b",
            label: "Ben",
            contracts: 20,
            listCents: 1_000_000_00,
            discountCents: 50_000_00,
          }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("about the same amount");
    expect(t).not.toContain("discounts hardest");
  });

  it("reads an even spread as a pricing question, not a personnel one", () => {
    const out = analyseDiscounts(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", contracts: 20 }),
          line({ key: "b", label: "Ben", contracts: 20 }),
        ],
      }),
    );
    expect(text(out)).toContain("pricing question rather than a personnel one");
  });

  it("never states a diagnosis as observed fact", () => {
    const out = analyseDiscounts(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", contracts: 20, discountCents: 120_000_00, listCents: 1_000_000_00 }),
          line({ key: "b", label: "Ben", contracts: 20, discountCents: 20_000_00, listCents: 1_000_000_00 }),
        ],
      }),
    );
    for (const i of at(out, "diagnostic")) {
      // The one exception is the refusal-to-judge line, which IS a
      // fact about the sample rather than an explanation.
      if (i.headline.includes("Not enough contracts")) continue;
      expect(i.confidence, i.headline).not.toBe("observed");
    }
  });
});

describe("a garden that only sells with money off", () => {
  it("reads it as a list-price question", () => {
    const out = analyseDiscounts(
      facts({
        bySection: [
          line({
            key: "peace",
            label: "Garden of Peace",
            contracts: 20,
            listCents: 1_000_000_00,
            discountCents: 150_000_00, // 15%
          }),
          line({
            key: "faith",
            label: "Garden of Faith",
            contracts: 20,
            listCents: 1_000_000_00,
            discountCents: 10_000_00, // 1%
          }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Garden of Peace needs the most money off");
    expect(t).toContain("priced above what families think it is worth");
  });

  it("stays quiet when gardens discount alike", () => {
    const out = analyseDiscounts(
      facts({
        bySection: [
          line({ key: "a", label: "Garden A", contracts: 20 }),
          line({ key: "b", label: "Garden B", contracts: 20 }),
        ],
      }),
    );
    expect(text(out)).not.toContain("needs the most money off");
  });
});

describe("a reason typed over and over", () => {
  it("reads it as a policy nobody wrote down", () => {
    // Not as somebody cheating. Three of the same sentence is a habit
    // the park has, and the fix is to write it down.
    expect(REPEATED_REASON_THRESHOLD).toBe(3);
    const out = analyseDiscounts(
      facts({
        reasons: [
          { reason: "Senior citizen discount", count: 14, discountCents: 90_000_00 },
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Senior citizen discount");
    expect(t).toContain("policy nobody has written down");
  });

  it("prescribes moving it into the price book", () => {
    // The most valuable output in this whole section: it turns an
    // invisible habit into a controlled, reported plan.
    const out = analyseDiscounts(
      facts({
        reasons: [
          { reason: "Senior citizen discount", count: 14, discountCents: 90_000_00 },
        ],
      }),
    );
    const p = at(out, "prescriptive");
    expect(p.map((i) => i.headline).join(" ")).toContain(
      "Turn \"Senior citizen discount\" into a payment plan",
    );
    expect(p[0]?.action).toContain("Payment plans");
  });

  it("says nothing about a reason given once", () => {
    // One family's circumstances are not a pattern, and surfacing them
    // as one invites a conversation nobody should be having.
    const out = analyseDiscounts(
      facts({
        reasons: [{ reason: "Hardship — bereaved twice", count: 1, discountCents: 5_000_00 }],
      }),
    );
    expect(text(out)).not.toContain("Hardship");
  });

  it("does not flag two of the same either", () => {
    const out = analyseDiscounts(
      facts({ reasons: [{ reason: "Staff family", count: 2, discountCents: 8_000_00 }] }),
    );
    expect(text(out)).not.toContain("Staff family");
  });
});

describe("what it costs over a year", () => {
  it("extrapolates the run-rate", () => {
    const out = analyseDiscounts(facts());
    expect(at(out, "predictive")[0]?.headline).toContain("a year");
  });

  it("is speculative on a handful of discounted contracts", () => {
    const out = analyseDiscounts(
      facts({ discountedContracts: 2, totalDiscountCents: 10_000_00 }),
    );
    const p = at(out, "predictive")[0];
    expect(p?.confidence).toBe("speculative");
    expect(p?.detail).toContain("order of magnitude");
  });

  it("is never better than indicative", () => {
    const out = analyseDiscounts(facts({ discountedContracts: 200 }));
    expect(at(out, "predictive")[0]?.confidence).toBe("indicative");
  });
});

describe("what to do", () => {
  it("suggests a ceiling once discounts run into double figures", () => {
    const out = analyseDiscounts(facts()); // 10% average
    expect(text(at(out, "prescriptive"))).toContain("worth setting a ceiling");
  });

  it("stays quiet about the ceiling on modest discounting", () => {
    const out = analyseDiscounts(
      facts({ totalDiscountCents: 30_000_00, discountedListCents: 1_200_000_00 }),
    );
    expect(text(at(out, "prescriptive"))).not.toContain("setting a ceiling");
  });

  it("notices when the price book is not being used at all", () => {
    const out = analyseDiscounts(facts({ policyContracts: 0 }));
    expect(text(out)).toContain("typed by hand");
  });

  it("stays quiet about that once plans are in use", () => {
    const out = analyseDiscounts(facts({ policyContracts: 20 }));
    expect(text(out)).not.toContain("typed by hand");
  });

  it("gives every prescription something to do", () => {
    const out = analyseDiscounts(
      facts({
        policyContracts: 0,
        reasons: [{ reason: "Senior citizen discount", count: 9, discountCents: 50_000_00 }],
      }),
    );
    const p = at(out, "prescriptive");
    expect(p.length).toBeGreaterThan(1);
    for (const i of p) {
      expect(i.action, i.headline).toBeDefined();
    }
  });
});
