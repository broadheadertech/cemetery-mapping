/**
 * When a lot still being paid off may take an interment.
 *
 * Before this rule existed, `scheduleInterment` checked only the lot's
 * status — and a lot turns `sold` the moment a contract exists. A family
 * could pay a down payment on Monday and be interred on Tuesday with
 * fifty-nine months outstanding.
 *
 * That is the case a memorial park cannot recover from: an occupied lot
 * cannot practically be reclaimed, so the balance stops being a debt
 * with collateral behind it and becomes a loss. The cemetery chose a
 * threshold — half the contract by default — rather than requiring full
 * payment, so a family with an immediate need is still served.
 */

import { describe, it, expect } from "vitest";

import {
  checkIntermentEligibility,
  DEFAULT_INTERMENT_THRESHOLD_PERCENT,
  normaliseThreshold,
} from "../../../../convex/lib/intermentEligibility";

const PRICE = 100_000_00;

const contract = (paidCents: number, state = "active") => ({
  totalPriceCents: PRICE,
  paidCents,
  state,
});

describe("the threshold", () => {
  it("defaults to half the contract", () => {
    expect(DEFAULT_INTERMENT_THRESHOLD_PERCENT).toBe(50);
  });

  it("refuses a contract below it", () => {
    const r = checkIntermentEligibility(contract(20_000_00));
    expect(r.eligible).toBe(false);
  });

  it("allows a contract exactly at it", () => {
    expect(checkIntermentEligibility(contract(50_000_00)).eligible).toBe(true);
  });

  it("allows a contract above it", () => {
    expect(checkIntermentEligibility(contract(70_000_00)).eligible).toBe(true);
  });

  it("honours a threshold the cemetery has changed", () => {
    expect(checkIntermentEligibility(contract(30_000_00), 25).eligible).toBe(
      true,
    );
    expect(checkIntermentEligibility(contract(30_000_00), 75).eligible).toBe(
      false,
    );
  });

  it("switches the check off at zero", () => {
    // A legitimate position: serve the family first and put the
    // protection in the contract terms instead.
    expect(checkIntermentEligibility(contract(0), 0).eligible).toBe(true);
  });
});

describe("a settled contract is always eligible", () => {
  it("when paid in full", () => {
    expect(checkIntermentEligibility(contract(PRICE)).eligible).toBe(true);
  });

  it("when the contract says so, whatever the numbers", () => {
    const r = checkIntermentEligibility(contract(PRICE, "paid_in_full"), 100);
    expect(r.eligible).toBe(true);
  });

  it("even under a threshold that would otherwise be unreachable", () => {
    expect(checkIntermentEligibility(contract(PRICE), 100).eligible).toBe(true);
  });
});

describe("what staff are told", () => {
  it("names the shortfall in pesos, not a percentage", () => {
    // "Not eligible" sends a family away with nothing. "₱30,000 more"
    // is something the office can act on, and often settle at the desk.
    const r = checkIntermentEligibility(contract(20_000_00));
    expect(r.shortfallCents).toBe(30_000_00);
    expect(r.reason).toContain("₱30,000");
  });

  it("reports no shortfall once eligible", () => {
    const r = checkIntermentEligibility(contract(60_000_00));
    expect(r.shortfallCents).toBe(0);
    expect(r.reason).toBeUndefined();
  });
});

describe("the arithmetic", () => {
  it("rounds the requirement up, never down", () => {
    // Half of an odd price is not a whole centavo. Rounding down would
    // qualify a contract one centavo short, which is exactly the detail
    // that becomes an argument at a counter.
    const r = checkIntermentEligibility({
      totalPriceCents: 1001,
      paidCents: 500,
      state: "active",
    });
    expect(r.requiredCents).toBe(501);
    expect(r.eligible).toBe(false);
  });

  it("treats a negative paid figure as zero", () => {
    const r = checkIntermentEligibility(contract(-500));
    expect(r.paidCents).toBe(0);
    expect(r.eligible).toBe(false);
  });
});

describe("normaliseThreshold", () => {
  it("falls back on a missing or nonsense value", () => {
    expect(normaliseThreshold(undefined)).toBe(50);
    expect(normaliseThreshold("half")).toBe(50);
    expect(normaliseThreshold(Number.NaN)).toBe(50);
  });

  it("clamps above 100", () => {
    // Over 100 would make every contract ineligible forever, including
    // one paid in full. Nobody configures that on purpose.
    expect(normaliseThreshold(150)).toBe(100);
  });

  it("clamps below zero", () => {
    expect(normaliseThreshold(-20)).toBe(0);
  });
});
