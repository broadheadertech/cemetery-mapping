/**
 * Whether the families an agent sold to actually pay.
 *
 * This is the number a commission ranking hides: an agent can sell ₱2M
 * and be the park's most expensive employee if none of it arrives.
 *
 * Two things had to be got right or the whole section is unfair.
 *
 * AGE. The measure is money already DUE against money paid. A raw
 * "share collected" would punish whoever sold most recently — a
 * contract signed last month has collected less than one signed two
 * years ago, and that is the calendar, not the agent.
 *
 * CASH. A full-payment sale collects in full by construction. Rating it
 * would put a perfect record against somebody carrying no collection
 * risk at all, above whoever is carrying the park's instalment book.
 */

import { describe, it, expect } from "vitest";

import {
  analyseCollections,
  collectionRate,
  MIN_DUE_TO_RATE_CENTS,
  MIN_TERM_CONTRACTS_TO_JUDGE,
  type CollectionFacts,
  type CollectionLine,
  type Insight,
} from "../../../../convex/lib/insights";

function line(over: Partial<CollectionLine> = {}): CollectionLine {
  return {
    key: "a",
    label: "Ana",
    termContracts: 10,
    cashContracts: 2,
    dueToDateCents: 1_000_000_00,
    paidToDateCents: 900_000_00, // 90%
    behindContracts: 1,
    defaultedContracts: 0,
    outstandingCents: 2_000_000_00,
    ...over,
  };
}

function facts(over: Partial<CollectionFacts> = {}): CollectionFacts {
  const byAgent = over.byAgent ?? [line()];
  return {
    windowMonths: 12,
    byAgent,
    overall: over.overall ?? line({ key: "all", label: "All" }),
    ...over,
  };
}

const at = (rows: Insight[], level: Insight["level"]): Insight[] =>
  rows.filter((i) => i.level === level);

const text = (rows: Insight[]): string =>
  rows.map((i) => `${i.headline} ${i.detail} ${i.action ?? ""}`).join(" ");

describe("the measure itself", () => {
  it("is money paid against money already due", () => {
    expect(collectionRate(line({ dueToDateCents: 100, paidToDateCents: 75 }))).toBe(
      75,
    );
  });

  it("does not divide by zero on a book with nothing due", () => {
    expect(collectionRate(line({ dueToDateCents: 0, paidToDateCents: 0 }))).toBe(
      0,
    );
  });

  it("caps at 100 when a family pays ahead", () => {
    // Paying early is not a 140% collection rate.
    expect(
      collectionRate(line({ dueToDateCents: 100, paidToDateCents: 140 })),
    ).toBe(100);
  });
});

describe("a book too young to judge", () => {
  it("says so rather than reporting a rate that swings on one payment", () => {
    const young = line({
      termContracts: 20,
      dueToDateCents: 10_000_00,
      paidToDateCents: 5_000_00,
    });
    const out = analyseCollections(facts({ overall: young, byAgent: [young] }));
    expect(out[0]?.headline).toContain("too young to rate");
    // And it stops there — no diagnosis, no prediction off a rate it
    // has just said it cannot compute.
    expect(at(out, "diagnostic")).toHaveLength(0);
    expect(at(out, "predictive")).toHaveLength(0);
  });

  it("uses a floor of real money, not a contract count", () => {
    // Twenty contracts signed last month have almost nothing due.
    expect(MIN_DUE_TO_RATE_CENTS).toBe(50_000_00);
  });
});

describe("a park that sells no terms at all", () => {
  it("has nothing to measure and says so", () => {
    const cashOnly = line({
      termContracts: 0,
      cashContracts: 30,
      dueToDateCents: 0,
      paidToDateCents: 0,
      outstandingCents: 0,
    });
    const out = analyseCollections(
      facts({ overall: cashOnly, byAgent: [cashOnly] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.headline).toContain("paid in full at signing");
  });
});

describe("cash sellers are never rated", () => {
  it("names them and takes them out of the comparison", () => {
    // A perfect record for carrying no risk would sit above whoever is
    // carrying the park's instalment book.
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana" }),
          line({ key: "b", label: "Ben", termContracts: 20, paidToDateCents: 500_000_00 }),
          line({
            key: "c",
            label: "Carmen",
            termContracts: 0,
            cashContracts: 15,
            dueToDateCents: 0,
            paidToDateCents: 0,
          }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Carmen");
    expect(t).toContain("cash only");
    // Carmen must not be the best collector.
    expect(t).not.toContain("Carmen's book collects worst");
    expect(t).not.toContain("against Carmen's");
  });
});

describe("naming a book that collects badly", () => {
  it("REFUSES on too few instalment contracts", () => {
    expect(MIN_TERM_CONTRACTS_TO_JUDGE).toBe(5);
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", termContracts: 3 }),
          line({ key: "b", label: "Ben", termContracts: 2 }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Not enough of a book per seller");
    expect(t).not.toContain("collects worst");
  });

  it("names it once the books are big enough", () => {
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", paidToDateCents: 950_000_00 }),
          line({
            key: "b",
            label: "Ben",
            paidToDateCents: 600_000_00, // 60%
            behindContracts: 6,
          }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("Ben's book collects worst");
    expect(t).toContain("60");
  });

  it("frames it as a question before an accusation", () => {
    // Selling and collecting are different skills, and a gap is usually
    // about who was sold to.
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", paidToDateCents: 950_000_00 }),
          line({ key: "b", label: "Ben", paidToDateCents: 600_000_00 }),
        ],
      }),
    );
    expect(text(out)).toContain("before it is an accusation");
  });

  it("does not call a small gap a difference", () => {
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", paidToDateCents: 900_000_00 }),
          line({ key: "b", label: "Ben", paidToDateCents: 850_000_00 }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("about as well as every other");
    expect(t).not.toContain("collects worst");
  });

  it("reads an even spread as terms rather than judgement", () => {
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana" }),
          line({ key: "b", label: "Ben" }),
        ],
      }),
    );
    expect(text(out)).toContain("rather than at anybody's judgement");
  });
});

describe("defaults", () => {
  it("says what a default actually cost the park", () => {
    // The commission was paid once the family passed the threshold, and
    // the lot has to be sold again. The sale cost the park twice.
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana" }),
          line({
            key: "b",
            label: "Ben",
            termContracts: 10,
            defaultedContracts: 3,
            paidToDateCents: 600_000_00,
          }),
        ],
      }),
    );
    const t = text(out);
    expect(t).toContain("gone into default");
    expect(t).toContain("cost the park twice");
  });

  it("stays quiet below a fifth of the book", () => {
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana" }),
          line({ key: "b", label: "Ben", termContracts: 20, defaultedContracts: 1 }),
        ],
      }),
    );
    expect(text(out)).not.toContain("gone into default");
  });
});

describe("projecting the exposure", () => {
  it("applies the rate to what is still owed", () => {
    const out = analyseCollections(facts());
    const p = at(out, "predictive")[0];
    expect(p?.headline).toContain("still owed");
  });

  it("is always speculative, and says why", () => {
    // It applies today's rate to money that has not fallen due. That is
    // the crudest possible assumption and it must not read as a
    // write-off.
    const out = analyseCollections(facts());
    const p = at(out, "predictive")[0];
    expect(p?.confidence).toBe("speculative");
    expect(p?.detail).toContain("crudest possible assumption");
    expect(p?.detail).toContain("not as a write-off");
  });

  it("says nothing when nothing is outstanding", () => {
    const settled = line({ outstandingCents: 0 });
    const out = analyseCollections(
      facts({ overall: settled, byAgent: [settled] }),
    );
    expect(at(out, "predictive")).toHaveLength(0);
  });
});

describe("what to do", () => {
  it("puts the overdue contracts first", () => {
    const out = analyseCollections(facts());
    const p = at(out, "prescriptive");
    expect(p[0]?.headline).toContain("behind");
    expect(p[0]?.action).toContain("ageing");
  });

  it("points at the terms being written, not at effort", () => {
    const out = analyseCollections(
      facts({
        byAgent: [
          line({ key: "a", label: "Ana", paidToDateCents: 950_000_00 }),
          line({ key: "b", label: "Ben", paidToDateCents: 600_000_00 }),
        ],
      }),
    );
    const t = text(at(out, "prescriptive"));
    expect(t).toContain("what terms Ben is writing");
    expect(t).toContain("deposit");
  });

  it("connects defaults back to the commission threshold", () => {
    // If commission was paid on contracts that later defaulted, the
    // threshold is set too low for the terms being written.
    const withDefaults = line({ defaultedContracts: 2 });
    const out = analyseCollections(
      facts({ overall: withDefaults, byAgent: [withDefaults] }),
    );
    const t = text(at(out, "prescriptive"));
    expect(t).toContain("commission threshold");
  });

  it("gives every prescription something to do", () => {
    const out = analyseCollections(
      facts({
        overall: line({ defaultedContracts: 2 }),
        byAgent: [
          line({ key: "a", label: "Ana", paidToDateCents: 950_000_00 }),
          line({ key: "b", label: "Ben", paidToDateCents: 600_000_00 }),
        ],
      }),
    );
    const p = at(out, "prescriptive");
    expect(p.length).toBeGreaterThan(1);
    for (const i of p) {
      expect(i.action, i.headline).toBeDefined();
    }
  });
});

describe("the shared discipline holds here too", () => {
  const everything = analyseCollections(
    facts({
      overall: line({ defaultedContracts: 2 }),
      byAgent: [
        line({ key: "a", label: "Ana", paidToDateCents: 950_000_00 }),
        line({ key: "b", label: "Ben", paidToDateCents: 600_000_00, defaultedContracts: 3 }),
        line({ key: "c", label: "Carmen", termContracts: 0, cashContracts: 9, dueToDateCents: 0 }),
      ],
    }),
  );

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

  it("never calls a comparison between people an observed fact", () => {
    for (const i of at(everything, "diagnostic")) {
      // The refusals and the cash-only note ARE facts about the sample
      // rather than explanations of behaviour.
      if (i.headline.includes("Not enough")) continue;
      if (i.headline.includes("cash only")) continue;
      expect(i.confidence, i.headline).not.toBe("observed");
    }
  });

  it("gives every finding a basis", () => {
    for (const i of everything) {
      expect(i.basis.length, i.headline).toBeGreaterThan(10);
    }
  });
});
