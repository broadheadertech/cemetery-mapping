/**
 * What an agent is owed, and when the park owes it.
 *
 * The second question is the one with money on it. Paying at signing
 * means paying commission on money that may never arrive — an
 * instalment contract that defaults in month three has cost the park a
 * commission AND left it holding a lot to sell again. The threshold
 * exists to stop that, so most of this file is about the threshold
 * holding.
 *
 * The rest is the frozen rate: what an agent was promised last year
 * must not change because the park changed its default this year.
 */

import { describe, it, expect } from "vitest";

import {
  commissionStatus,
  computeCommissionCents,
  DEFAULT_EARNED_AT_PERCENT,
  MAX_COMMISSION_PERCENT,
  normaliseCommissionPercent,
  normaliseEarnedAtPercent,
  resolveCommissionPercent,
} from "../../../../convex/lib/commission";

const TOTAL = 100_000_00; // ₱100,000

describe("how much", () => {
  it("is a percentage of the contract", () => {
    expect(computeCommissionCents(TOTAL, 10)).toBe(10_000_00);
  });

  it("charges against what the family pays, not the list price", () => {
    // The caller passes the contract total, which is already net of any
    // discount. Commissioning on a price nobody paid would have the
    // park paying out more than it took on a discounted sale.
    const discounted = 90_000_00;
    expect(computeCommissionCents(discounted, 10)).toBe(9_000_00);
  });

  it("returns whole centavos for an awkward rate", () => {
    const c = computeCommissionCents(33_333_33, 7.5);
    expect(Number.isInteger(c)).toBe(true);
  });

  it("is nothing when no rate was agreed", () => {
    expect(computeCommissionCents(TOTAL, 0)).toBe(0);
  });

  it("is nothing on a zero-value contract", () => {
    expect(computeCommissionCents(0, 10)).toBe(0);
  });

  it("caps a rate that must be a typo", () => {
    // 500% is not a commission policy.
    expect(MAX_COMMISSION_PERCENT).toBe(50);
    expect(computeCommissionCents(TOTAL, 500)).toBe(50_000_00);
  });

  it("ignores a negative or nonsense rate", () => {
    expect(computeCommissionCents(TOTAL, -10)).toBe(0);
    expect(computeCommissionCents(TOTAL, Number.NaN)).toBe(0);
  });
});

describe("which rate applies", () => {
  it("prefers a rate agreed at the desk", () => {
    expect(
      resolveCommissionPercent({
        explicitPercent: 12,
        agentPercent: 10,
        defaultPercent: 8,
      }),
    ).toBe(12);
  });

  it("falls back to the agent's own rate", () => {
    expect(
      resolveCommissionPercent({ agentPercent: 10, defaultPercent: 8 }),
    ).toBe(10);
  });

  it("falls back to the park's default", () => {
    expect(resolveCommissionPercent({ defaultPercent: 8 })).toBe(8);
  });

  it("is zero when nothing is set anywhere", () => {
    // Not a hidden default. A park that has configured no rate owes
    // nothing until somebody decides what the rate is.
    expect(resolveCommissionPercent({})).toBe(0);
  });

  it("skips a zero rate rather than treating it as a decision", () => {
    expect(
      resolveCommissionPercent({ agentPercent: 0, defaultPercent: 8 }),
    ).toBe(8);
  });
});

describe("when it becomes payable", () => {
  const base = {
    contractState: "active",
    contractTotalCents: TOTAL,
    commissionCents: 10_000_00,
  };

  it("defaults to twenty per cent collected", () => {
    expect(DEFAULT_EARNED_AT_PERCENT).toBe(20);
  });

  it("is NOT due on a fresh instalment contract", () => {
    // The case the threshold exists for. A deposit is not a sale that
    // has held.
    const s = commissionStatus({ ...base, paidCents: 5_000_00 });
    expect(s.state).toBe("not_due");
  });

  it("becomes due exactly at the threshold", () => {
    const s = commissionStatus({ ...base, paidCents: 20_000_00 });
    expect(s.state).toBe("due");
  });

  it("is not due one centavo short", () => {
    const s = commissionStatus({ ...base, paidCents: 20_000_00 - 1 });
    expect(s.state).toBe("not_due");
    expect(s.shortfallCents).toBe(1);
  });

  it("is due on a contract paid in full", () => {
    const s = commissionStatus({
      ...base,
      contractState: "paid_in_full",
      paidCents: TOTAL,
    });
    expect(s.state).toBe("due");
  });

  it("honours a threshold the park has changed", () => {
    const s = commissionStatus({
      ...base,
      paidCents: 20_000_00,
      earnedAtPercent: 50,
    });
    expect(s.state).toBe("not_due");
  });

  it("pays immediately at a zero threshold", () => {
    // A park that chooses to pay at signing can. It just has to choose
    // it rather than get it by accident.
    const s = commissionStatus({
      ...base,
      paidCents: 0,
      earnedAtPercent: 0,
    });
    expect(s.state).toBe("due");
  });

  it("rounds the requirement UP, never down", () => {
    // Half a centavo short is short. It is the kind of detail that
    // becomes an argument with someone whose income it is.
    const s = commissionStatus({
      contractState: "active",
      contractTotalCents: 1001,
      paidCents: 200,
      commissionCents: 100,
    });
    expect(s.requiredCents).toBe(201);
    expect(s.state).toBe("not_due");
  });
});

describe("a sale that did not hold", () => {
  const base = {
    contractTotalCents: TOTAL,
    commissionCents: 10_000_00,
    paidCents: TOTAL,
  };

  it("owes NOTHING on a voided contract, whatever was collected", () => {
    // The sale did not happen. A commission on it is the park paying
    // for work that produced no lot sold.
    const s = commissionStatus({ ...base, contractState: "voided" });
    expect(s.state).toBe("void");
    expect(s.message).toContain("No commission is owed");
  });

  it("owes nothing on a cancelled contract", () => {
    expect(commissionStatus({ ...base, contractState: "cancelled" }).state).toBe(
      "void",
    );
  });

  it("still owes on a contract in default that passed the mark", () => {
    // Different from a void: the family bought the lot, paid past the
    // threshold, and then stopped. The agent did their work and the
    // park kept the money collected.
    const s = commissionStatus({
      ...base,
      contractState: "in_default",
      paidCents: 30_000_00,
    });
    expect(s.state).toBe("due");
  });
});

describe("what the office is told", () => {
  const base = {
    contractState: "active",
    contractTotalCents: TOTAL,
    commissionCents: 10_000_00,
  };

  it("names the pesos still to collect, not a percentage", () => {
    // "Not yet due" ends a conversation. "₱12,000 more" is something
    // the office can chase.
    const s = commissionStatus({ ...base, paidCents: 8_000_00 });
    expect(s.shortfallCents).toBe(12_000_00);
    expect(s.message).toContain("₱12,000");
  });

  it("says how far the family has actually got", () => {
    const s = commissionStatus({ ...base, paidCents: 8_000_00 });
    expect(s.collectedPercent).toBe(8);
    expect(s.message).toContain("8%");
  });

  it("reports a commission already paid out as settled", () => {
    const s = commissionStatus({
      ...base,
      paidCents: TOTAL,
      paidOutAt: 1_700_000_000_000,
    });
    expect(s.state).toBe("paid");
  });

  it("says plainly when no commission was recorded", () => {
    const s = commissionStatus({
      ...base,
      commissionCents: 0,
      paidCents: TOTAL,
    });
    expect(s.state).toBe("not_due");
    expect(s.message).toContain("No commission was recorded");
  });

  it("never reports a negative shortfall", () => {
    const s = commissionStatus({ ...base, paidCents: TOTAL });
    expect(s.shortfallCents).toBe(0);
  });

  it("survives a zero-value contract without dividing by zero", () => {
    const s = commissionStatus({
      contractState: "active",
      contractTotalCents: 0,
      paidCents: 0,
      commissionCents: 0,
    });
    expect(Number.isFinite(s.collectedPercent)).toBe(true);
    expect(s.collectedPercent).toBe(0);
  });
});

describe("normalising the settings", () => {
  it("clamps a rate above the cap", () => {
    expect(normaliseCommissionPercent(90)).toBe(50);
  });

  it("treats nonsense as no rate", () => {
    expect(normaliseCommissionPercent("ten")).toBe(0);
    expect(normaliseCommissionPercent(-1)).toBe(0);
  });

  it("falls back to twenty for a missing threshold", () => {
    expect(normaliseEarnedAtPercent(undefined)).toBe(20);
    expect(normaliseEarnedAtPercent("soon")).toBe(20);
  });

  it("clamps a threshold outside 0–100", () => {
    expect(normaliseEarnedAtPercent(150)).toBe(100);
    expect(normaliseEarnedAtPercent(-5)).toBe(0);
  });
});
