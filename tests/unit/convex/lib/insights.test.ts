/**
 * Four levels of analysis, and the discipline that keeps them honest.
 *
 * The findings themselves are the easy part. What this file mostly
 * tests is what the module REFUSES to say: no league table off two
 * sales, no diagnosis presented as a fact, no twelve-month projection
 * from one good month. A memorial park has a handful of agents and a
 * few hundred contracts, and at that scale a confident-looking number
 * is the dangerous output — somebody prices a garden off it.
 *
 * Every finding carries the level it belongs to, how far it can be
 * trusted, and what it was computed from. Those three are asserted as
 * hard as the sentences are.
 */

import { describe, it, expect } from "vitest";

import {
  analyseAgents,
  analysePhases,
  buyRate,
  MATERIAL_GAP_RATIO,
  MIN_AGENTS_TO_RANK,
  MIN_MONTHS_TO_PROJECT,
  MIN_SALES_TO_RANK,
  type AgentFacts,
  type Insight,
  type PhaseFacts,
} from "../../../../convex/lib/insights";

function agent(over: Partial<AgentFacts> = {}): AgentFacts {
  return {
    agentId: "salesAgents:a",
    name: "Agent A",
    isSystem: false,
    salesCount: 10,
    soldValueCents: 1_000_000_00,
    commissionCents: 100_000_00,
    commissionDueCents: 100_000_00,
    commissionNotDueCents: 0,
    activeMonths: 12,
    ...over,
  };
}

function phase(over: Partial<PhaseFacts> = {}): PhaseFacts {
  return {
    phaseId: "phases:1",
    number: 1,
    name: "Phase 1",
    stage: "live",
    totalLots: 100,
    availableLots: 40,
    soldLots: 60,
    soldInWindow: 12,
    windowMonths: 12,
    averagePriceCents: 100_000_00,
    ...over,
  };
}

const at = (insights: Insight[], level: Insight["level"]): Insight[] =>
  insights.filter((i) => i.level === level);

// --- the discipline ----------------------------------------------------

describe("the rules that hold across every finding", () => {
  const everything = [
    ...analyseAgents([
      agent({ agentId: "a", name: "Ana", commissionCents: 200_000_00 }),
      agent({
        agentId: "b",
        name: "Ben",
        commissionCents: 20_000_00,
        salesCount: 4,
        soldValueCents: 200_000_00,
      }),
    ]),
    ...analysePhases([
      phase(),
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 5,
        availableLots: 95,
        soldInWindow: 1,
        averagePriceCents: 160_000_00,
      }),
    ]),
  ];

  it("produces findings at every level", () => {
    // A silent zero at any level would make the assertions below
    // vacuous — this is the guard on the guards.
    for (const level of [
      "descriptive",
      "diagnostic",
      "predictive",
      "prescriptive",
    ] as const) {
      expect(at(everything, level).length, level).toBeGreaterThan(0);
    }
  });

  it("NEVER presents a diagnosis as an observed fact", () => {
    // A diagnostic is an explanation, and there is always another one.
    // Calling it observed is how a lead becomes a cause on the way to a
    // decision.
    for (const i of at(everything, "diagnostic")) {
      expect(i.confidence, i.headline).not.toBe("observed");
    }
  });

  it("NEVER presents a projection as better than indicative", () => {
    for (const i of at(everything, "predictive")) {
      expect(i.confidence, i.headline).not.toBe("observed");
    }
  });

  it("gives every finding something to check it against", () => {
    for (const i of everything) {
      expect(i.basis.length, i.headline).toBeGreaterThan(10);
    }
  });

  it("gives every prescription something to actually do", () => {
    for (const i of at(everything, "prescriptive")) {
      expect(i.action, i.headline).toBeDefined();
      expect((i.action ?? "").length).toBeGreaterThan(10);
    }
  });

  it("never leaves an action on a finding that is not a prescription", () => {
    // An "action" on a descriptive line reads as an instruction the
    // data did not earn.
    for (const i of everything) {
      if (i.level === "prescriptive") continue;
      expect(i.action, i.headline).toBeUndefined();
    }
  });
});

// --- agents ------------------------------------------------------------

describe("reading the agent register", () => {
  it("says so plainly when nobody is credited", () => {
    const out = analyseAgents([]);
    expect(out).toHaveLength(1);
    expect(out[0]?.headline).toContain("No sales are credited");
  });

  it("EXCLUDES the park's own row from every comparison", () => {
    // It is not a person, it earns nothing, and leaving it in makes it
    // the biggest seller and the worst earner at the same time.
    const out = analyseAgents([
      agent({ agentId: "platform", name: "Online transaction", isSystem: true, salesCount: 500, commissionCents: 0 }),
      agent({ agentId: "a", name: "Ana" }),
      agent({ agentId: "b", name: "Ben", commissionCents: 10_000_00, salesCount: 5, soldValueCents: 100_000_00 }),
    ]);
    const text = out.map((i) => `${i.headline} ${i.detail}`).join(" ");
    expect(text).not.toContain("Online transaction");
  });

  it("names the highest and the lowest earner", () => {
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", commissionCents: 200_000_00 }),
      agent({ agentId: "b", name: "Ben", commissionCents: 20_000_00, salesCount: 4, soldValueCents: 200_000_00 }),
    ]);
    const d = at(out, "descriptive").map((i) => i.headline).join(" ");
    expect(d).toContain("Ana");
    const all = out.map((i) => `${i.headline} ${i.detail}`).join(" ");
    expect(all).toContain("Ben");
  });
});

describe("refusing to rank on too little", () => {
  it("will not rank a single agent against nobody", () => {
    const out = analyseAgents([agent({ name: "Ana" })]);
    expect(
      out.some((i) => i.headline.includes("Not enough history")),
    ).toBe(true);
  });

  it("will not rank agents with fewer than three sales each", () => {
    // Two sales apiece is not a league table, and the first ranking a
    // park sees is the one it remembers.
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", salesCount: 2 }),
      agent({ agentId: "b", name: "Ben", salesCount: 1 }),
    ]);
    expect(
      out.some((i) => i.headline.includes("Not enough history")),
    ).toBe(true);
    expect(at(out, "predictive")).toHaveLength(0);
  });

  it("ranks once the thresholds are met", () => {
    expect(MIN_SALES_TO_RANK).toBe(3);
    expect(MIN_AGENTS_TO_RANK).toBe(2);
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", salesCount: 3 }),
      agent({ agentId: "b", name: "Ben", salesCount: 3, commissionCents: 10_000_00 }),
    ]);
    expect(out.some((i) => i.headline.includes("Not enough history"))).toBe(
      false,
    );
  });
});

describe("why one agent is ahead", () => {
  const top = agent({
    agentId: "a",
    name: "Ana",
    salesCount: 20,
    soldValueCents: 2_000_000_00,
    commissionCents: 200_000_00,
    activeMonths: 10,
  });

  it("separates closing more often from closing bigger", () => {
    const slowButBig = agent({
      agentId: "b",
      name: "Ben",
      salesCount: 5,
      soldValueCents: 500_000_00,
      commissionCents: 50_000_00,
      activeMonths: 10,
    });
    const out = analyseAgents([top, slowButBig]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).toContain("closes more often");
  });

  it("spots a difference in deal size", () => {
    const sameVolumeSmallerDeals = agent({
      agentId: "b",
      name: "Ben",
      salesCount: 20,
      soldValueCents: 800_000_00,
      commissionCents: 80_000_00,
      activeMonths: 10,
    });
    const out = analyseAgents([top, sameVolumeSmallerDeals]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).toContain("sales are larger");
  });

  it("says when part of the gap is just the rate", () => {
    // Comparing what two agents earned without comparing what they sold
    // reads the agreement as effort.
    const sameWorkLowerRate = agent({
      agentId: "b",
      name: "Ben",
      salesCount: 20,
      soldValueCents: 2_000_000_00,
      commissionCents: 100_000_00, // 5% against Ana's 10%
      activeMonths: 10,
    });
    const out = analyseAgents([top, sameWorkLowerRate]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).toContain("not on the same rate");
  });

  it("admits when it cannot explain the gap", () => {
    // Better than inventing a cause. The honest answer is to go and ask.
    const nearlyIdentical = agent({
      agentId: "b",
      name: "Ben",
      salesCount: 19,
      soldValueCents: 1_900_000_00,
      commissionCents: 190_000_00,
      activeMonths: 10,
    });
    const out = analyseAgents([top, nearlyIdentical]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).toContain("no single obvious cause");
  });

  it("does not call a small difference a finding", () => {
    // Two agents within a quarter of each other are doing the same job,
    // and flagging that teaches people to ignore the flags.
    expect(MATERIAL_GAP_RATIO).toBe(1.25);
    const out = analyseAgents([
      top,
      agent({
        agentId: "b",
        name: "Ben",
        salesCount: 18,
        soldValueCents: 1_800_000_00,
        commissionCents: 180_000_00,
        activeMonths: 10,
      }),
    ]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).not.toContain("closes more often");
    expect(diag).not.toContain("sales are larger");
  });
});

describe("a gap that is collections, not selling", () => {
  it("says so rather than letting it read as underperformance", () => {
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana" }),
      agent({
        agentId: "b",
        name: "Ben",
        salesCount: 10,
        commissionCents: 100_000_00,
        commissionDueCents: 10_000_00,
        commissionNotDueCents: 90_000_00,
      }),
    ]);
    const text = out.map((i) => `${i.headline} ${i.detail}`).join(" ");
    expect(text).toContain("waiting on collections");
  });

  it("stays quiet when most of it is payable", () => {
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana" }),
      agent({
        agentId: "b",
        name: "Ben",
        salesCount: 10,
        commissionCents: 100_000_00,
        commissionDueCents: 80_000_00,
        commissionNotDueCents: 20_000_00,
      }),
    ]);
    const text = out.map((i) => i.headline).join(" ");
    expect(text).not.toContain("waiting on collections");
  });
});

describe("projecting what agents will earn", () => {
  it("refuses on less than three months of selling", () => {
    // A run-rate off two months is one good month wearing a trend's
    // clothes.
    expect(MIN_MONTHS_TO_PROJECT).toBe(3);
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", activeMonths: 2 }),
      agent({ agentId: "b", name: "Ben", activeMonths: 1, commissionCents: 10_000_00 }),
    ]);
    const pred = at(out, "predictive");
    expect(pred[0]?.headline).toContain("Too early");
    expect(pred[0]?.confidence).toBe("speculative");
  });

  it("is speculative on a short history", () => {
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", activeMonths: 4 }),
      agent({ agentId: "b", name: "Ben", activeMonths: 4, commissionCents: 10_000_00 }),
    ]);
    expect(at(out, "predictive")[0]?.confidence).toBe("speculative");
  });

  it("rises to indicative only with six months behind it", () => {
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", activeMonths: 12 }),
      agent({ agentId: "b", name: "Ben", activeMonths: 8, commissionCents: 10_000_00 }),
    ]);
    expect(at(out, "predictive")[0]?.confidence).toBe("indicative");
  });

  it("says out loud what the projection assumes", () => {
    const out = analyseAgents([
      agent({ agentId: "a", name: "Ana", activeMonths: 12 }),
      agent({ agentId: "b", name: "Ben", activeMonths: 12, commissionCents: 10_000_00 }),
    ]);
    expect(at(out, "predictive")[0]?.detail).toContain("not a forecast");
  });
});

// --- phases ------------------------------------------------------------

describe("reading the phase plan", () => {
  it("says so when no phase has lots against it", () => {
    const out = analysePhases([phase({ totalLots: 0 })]);
    expect(out[0]?.headline).toContain("any lots against it");
  });

  it("names the best and worst buy rate", () => {
    const out = analysePhases([
      phase({ soldLots: 80, availableLots: 20 }),
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 10,
        availableLots: 90,
      }),
    ]);
    expect(out[0]?.headline).toContain("Phase 1");
    expect(out[0]?.detail).toContain("Phase 2");
  });

  it("computes buy rate as the share no longer available", () => {
    expect(buyRate(phase({ totalLots: 100, soldLots: 60 }))).toBe(60);
    expect(buyRate(phase({ totalLots: 0, soldLots: 0 }))).toBe(0);
  });

  it("does not compare a single phase to itself", () => {
    const out = analysePhases([phase()]);
    expect(at(out, "diagnostic")).toHaveLength(0);
    expect(out[0]?.detail).toContain("nothing to compare");
  });
});

describe("why one phase is behind", () => {
  const best = phase({ soldLots: 80, availableLots: 20, soldInWindow: 20 });

  it("does NOT call an unopened phase a bad performer", () => {
    // It is behind because it is not open. That is a schedule fact, not
    // a demand one, and treating it as demand gets a parcel repriced.
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        stage: "surveying",
        soldLots: 0,
        availableLots: 100,
        soldInWindow: 0,
      }),
    ]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).toContain("not selling badly");
    expect(diag).not.toContain("priced");
  });

  it("flags a price gap as a lead, not a cause", () => {
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 10,
        availableLots: 90,
        soldInWindow: 2,
        averagePriceCents: 200_000_00,
      }),
    ]);
    const priced = at(out, "diagnostic").find((i) =>
      i.headline.includes("priced"),
    );
    expect(priced).toBeDefined();
    expect(priced?.detail).toContain("a lead, not a cause");
    expect(priced?.confidence).toBe("indicative");
  });

  it("distinguishes a stopped phase from a slow one", () => {
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 30,
        availableLots: 70,
        soldInWindow: 0,
      }),
    ]);
    const text = out.map((i) => `${i.headline} ${i.detail}`).join(" ");
    expect(text).toContain("stopped one");
  });

  it("admits when nothing in the data explains it", () => {
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 50,
        availableLots: 50,
        soldInWindow: 10,
      }),
    ]);
    const diag = at(out, "diagnostic").map((i) => i.headline).join(" ");
    expect(diag).toContain("Nothing in this data explains");
  });
});

describe("projecting a phase", () => {
  it("refuses to give a date when nothing is selling", () => {
    // Not "a long time" — an unknown time. Something has to change
    // before the question has an answer at all.
    const out = analysePhases([
      phase({ soldLots: 80, availableLots: 20, soldInWindow: 20 }),
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 0,
        availableLots: 100,
        soldInWindow: 0,
      }),
    ]);
    const pred = at(out, "predictive")[0];
    expect(pred?.headline).toContain("no rate to project from");
    expect(pred?.confidence).toBe("speculative");
  });

  it("gives a span, and says it is not a date", () => {
    const out = analysePhases([
      phase({ soldLots: 80, availableLots: 20, soldInWindow: 20 }),
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 20,
        availableLots: 80,
        soldInWindow: 8,
      }),
    ]);
    const pred = at(out, "predictive")[0];
    expect(pred?.headline).toContain("years");
    expect(pred?.detail).toContain("not a date");
  });
});

describe("what to do about a phase", () => {
  const best = phase({ soldLots: 80, availableLots: 20, soldInWindow: 20 });

  it("suggests a time-boxed promotion before a price cut", () => {
    // It tests whether price is the problem without permanently
    // repricing a garden.
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 10,
        availableLots: 90,
        soldInWindow: 2,
        averagePriceCents: 200_000_00,
      }),
    ]);
    const p = at(out, "prescriptive").map((i) => i.headline).join(" ");
    expect(p).toContain("promotion");
    expect(p).toContain("before cutting its price");
  });

  it("asks about the desk when a phase never sells", () => {
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        soldLots: 0,
        availableLots: 100,
        soldInWindow: 0,
      }),
    ]);
    const p = at(out, "prescriptive").map((i) => `${i.headline} ${i.detail}`).join(" ");
    expect(p).toContain("show a family first");
  });

  it("tells you to leave an unopened phase out of it", () => {
    const out = analysePhases([
      best,
      phase({
        phaseId: "phases:2",
        number: 2,
        name: "Phase 2",
        stage: "planned",
        soldLots: 0,
        availableLots: 100,
        soldInWindow: 0,
      }),
    ]);
    const p = at(out, "prescriptive");
    expect(p[0]?.headline).toContain("Leave");
    // And it must not also be told to discount an unopened parcel.
    expect(p.map((i) => i.headline).join(" ")).not.toContain("promotion");
  });
});
