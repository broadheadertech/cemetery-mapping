/**
 * The arithmetic between a lot's price and what a family signs for.
 *
 * This replaces a person doing sums at a counter, so the tests are
 * mostly about the ways that goes wrong: relief stacking into a
 * giveaway, a mistyped promotion selling a lot for nothing, a plan
 * whose down payment the sale flow will refuse, and rounding that
 * leaves a peso unaccounted for between the quote and the contract.
 *
 * Every figure here is integer centavos. A float in this file would be
 * a peso going missing somewhere between the desk and the receipt.
 */

import { describe, it, expect } from "vitest";

import {
  checkPromo,
  clampPercent,
  DEFAULT_MAX_DISCOUNT_PERCENT,
  percentOf,
  planAppliesToLotType,
  quote,
  type PaymentPlanTerms,
} from "../../../../convex/lib/pricing";

const LIST = 100_000_00; // ₱100,000

const cash: PaymentPlanTerms = { name: "Cash", kind: "full_payment" };

const cashWithDiscount: PaymentPlanTerms = {
  name: "Cash — 10% off",
  kind: "full_payment",
  discountPercent: 10,
};

const twelveMonths: PaymentPlanTerms = {
  name: "12 months",
  kind: "installment",
  downPaymentPercent: 20,
  termMonths: 12,
};

describe("a plain quote", () => {
  it("charges the list price when nothing applies", () => {
    const q = quote({ listPriceCents: LIST, plan: cash });
    expect(q.netPriceCents).toBe(LIST);
    expect(q.totalDiscountCents).toBe(0);
    expect(q.adjustments).toHaveLength(0);
  });

  it("applies the plan's own discount", () => {
    const q = quote({ listPriceCents: LIST, plan: cashWithDiscount });
    expect(q.netPriceCents).toBe(90_000_00);
    expect(q.totalDiscountCents).toBe(10_000_00);
    expect(q.adjustments[0]?.source).toBe("plan");
    expect(q.adjustments[0]?.percent).toBe(10);
  });

  it("itemises every adjustment so the desk can explain the figure", () => {
    // A family asks why it is that much. "Because the system said so"
    // is not an answer anyone can give at a counter.
    const q = quote({
      listPriceCents: LIST,
      plan: cashWithDiscount,
      promo: { name: "All Souls", discountPercent: 5 },
      manualDiscountCents: 1_000_00,
    });
    expect(q.adjustments.map((a) => a.source)).toEqual([
      "plan",
      "promo",
      "manual",
    ]);
    expect(q.adjustments.map((a) => a.label)).toEqual([
      "Cash — 10% off",
      "All Souls",
      "Discount agreed at the desk",
    ]);
  });

  it("refuses to quote a lot with no price", () => {
    const q = quote({ listPriceCents: 0, plan: cash });
    expect(q.netPriceCents).toBe(0);
    expect(q.warnings[0]).toContain("no price set");
  });
});

describe("how relief stacks", () => {
  it("applies each adjustment to what is left, not to the list price", () => {
    // 10% then 5% is 14.5% off, not 15%. The commercial convention,
    // and never more generous than the additive reading.
    const q = quote({
      listPriceCents: LIST,
      plan: cashWithDiscount,
      promo: { name: "All Souls", discountPercent: 5 },
    });
    expect(q.totalDiscountCents).toBe(14_500_00);
    expect(q.netPriceCents).toBe(85_500_00);
  });

  it("is never more generous than adding the percentages", () => {
    const sequential = quote({
      listPriceCents: LIST,
      plan: { name: "A", kind: "full_payment", discountPercent: 20 },
      promo: { name: "B", discountPercent: 20 },
    });
    expect(sequential.totalDiscountCents).toBeLessThan(percentOf(LIST, 40));
  });

  it("takes the larger when a promotion carries both a percent and pesos", () => {
    // A data error, not a stacking rule. Taking the larger is the
    // reading that cannot accidentally give away more than either was
    // meant to; the warning gets it fixed.
    const q = quote({
      listPriceCents: LIST,
      plan: cash,
      promo: { name: "Muddle", discountPercent: 5, discountCents: 8_000_00 },
    });
    expect(q.totalDiscountCents).toBe(8_000_00);
    expect(q.warnings[0]).toContain("both a percentage and a peso amount");
  });

  it("never lets a flat promo exceed what is left", () => {
    const q = quote({
      listPriceCents: 10_000_00,
      plan: cash,
      promo: { name: "Too big", discountCents: 99_999_00 },
    });
    expect(q.netPriceCents).toBeGreaterThan(0);
  });
});

describe("the cap", () => {
  it("stops relief past half the list price by default", () => {
    expect(DEFAULT_MAX_DISCOUNT_PERCENT).toBe(50);
    const q = quote({
      listPriceCents: LIST,
      plan: { name: "Huge", kind: "full_payment", discountPercent: 60 },
    });
    expect(q.totalDiscountCents).toBe(50_000_00);
    expect(q.netPriceCents).toBe(50_000_00);
  });

  it("says out loud that it capped, and by how much", () => {
    // A silent cap is the dangerous version: the office quotes a
    // figure nobody approved and finds out at reconciliation.
    const q = quote({
      listPriceCents: LIST,
      plan: { name: "Huge", kind: "full_payment", discountPercent: 60 },
    });
    expect(q.cappedNote).toContain("capped at 50%");
    expect(q.cappedNote).toContain("₱10,000");
  });

  it("caps the TOTAL, not each adjustment separately", () => {
    // Three modest discounts that individually pass the ceiling and
    // together sail through it. This is the case a per-adjustment cap
    // misses entirely.
    const q = quote({
      listPriceCents: LIST,
      plan: { name: "A", kind: "full_payment", discountPercent: 25 },
      promo: { name: "B", discountPercent: 25 },
      manualDiscountCents: 25_000_00,
    });
    expect(q.totalDiscountCents).toBe(50_000_00);
    expect(q.cappedNote).toBeDefined();
  });

  it("honours a cap the cemetery has changed", () => {
    const q = quote({
      listPriceCents: LIST,
      plan: cashWithDiscount,
      maxDiscountPercent: 5,
    });
    expect(q.totalDiscountCents).toBe(5_000_00);
  });

  it("NEVER sells a lot for nothing", () => {
    // The mistyped-promotion case. A hundred per cent off must not
    // produce a free grave and a receipt for zero.
    const q = quote({
      listPriceCents: LIST,
      plan: cash,
      promo: { name: "Oops", discountPercent: 100 },
      maxDiscountPercent: 100,
    });
    expect(q.netPriceCents).toBeGreaterThan(0);
    expect(q.cappedNote).toContain("reduced this lot to nothing");
  });

  it("never produces a negative price", () => {
    const q = quote({
      listPriceCents: 5_000_00,
      plan: cash,
      manualDiscountCents: 900_000_00,
      maxDiscountPercent: 100,
    });
    expect(q.netPriceCents).toBeGreaterThan(0);
    expect(q.totalDiscountCents).toBeLessThan(5_000_00);
  });
});

describe("instalment terms", () => {
  it("splits the net into a deposit and a term", () => {
    const q = quote({ listPriceCents: LIST, plan: twelveMonths });
    expect(q.netPriceCents).toBe(LIST);
    expect(q.downPaymentCents).toBe(20_000_00);
    expect(q.termMonths).toBe(12);
    expect(q.indicativeMonthlyCents).toBe(Math.floor(80_000_00 / 12));
  });

  it("takes the deposit from the DISCOUNTED price, not the list price", () => {
    // Otherwise a family with a promotion pays a deposit calculated on
    // money they were told they would not be charged.
    const q = quote({
      listPriceCents: LIST,
      plan: { ...twelveMonths, discountPercent: 10 },
    });
    expect(q.netPriceCents).toBe(90_000_00);
    expect(q.downPaymentCents).toBe(18_000_00);
  });

  it("adds a surcharge for carrying the balance when the plan has one", () => {
    const q = quote({
      listPriceCents: LIST,
      plan: { ...twelveMonths, surchargePercent: 6 },
    });
    expect(q.netPriceCents).toBe(106_000_00);
    expect(q.totalSurchargeCents).toBe(6_000_00);
  });

  it("adds the surcharge AFTER relief, never before", () => {
    // Charging interest on money the family is not paying would be
    // both wrong and hard to explain.
    const q = quote({
      listPriceCents: LIST,
      plan: { ...twelveMonths, discountPercent: 10, surchargePercent: 10 },
    });
    // 100,000 → 90,000 → +9,000
    expect(q.netPriceCents).toBe(99_000_00);
  });

  it("charges no surcharge on a cash plan even if one is set", () => {
    const q = quote({
      listPriceCents: LIST,
      plan: { name: "Cash", kind: "full_payment", surchargePercent: 10 },
    });
    expect(q.netPriceCents).toBe(LIST);
    expect(q.totalSurchargeCents).toBe(0);
  });

  it("leaves a full payment with no deposit or term", () => {
    const q = quote({ listPriceCents: LIST, plan: cashWithDiscount });
    expect(q.downPaymentCents).toBe(0);
    expect(q.termMonths).toBe(0);
    expect(q.indicativeMonthlyCents).toBe(0);
  });
});

describe("plans the sale flow would reject", () => {
  it("warns when a plan asks for no deposit", () => {
    // `recordInstallmentSale` refuses zero-down outright. Better to
    // name the misconfigured plan here than to let the operator meet
    // ZERO_DOWN_NOT_SUPPORTED at submit.
    const q = quote({
      listPriceCents: LIST,
      plan: { ...twelveMonths, downPaymentPercent: 0 },
    });
    expect(q.warnings.join(" ")).toContain("no deposit");
  });

  it("reduces and warns when a deposit is the whole price", () => {
    const q = quote({
      listPriceCents: LIST,
      plan: { ...twelveMonths, downPaymentPercent: 100 },
    });
    expect(q.downPaymentCents).toBeLessThan(q.netPriceCents);
    expect(q.warnings.join(" ")).toContain("needs fixing");
  });

  it("warns when a plan has no term", () => {
    const q = quote({
      listPriceCents: LIST,
      plan: { name: "Broken", kind: "installment", downPaymentPercent: 20 },
    });
    expect(q.termMonths).toBe(0);
    expect(q.warnings.join(" ")).toContain("no term set");
  });

  it("treats a term over sixty months as unset", () => {
    // The sale form and the server both bound the term at 60.
    const q = quote({
      listPriceCents: LIST,
      plan: { ...twelveMonths, termMonths: 120 },
    });
    expect(q.termMonths).toBe(0);
  });
});

describe("rounding", () => {
  it("returns whole centavos for an awkward percentage", () => {
    const q = quote({
      listPriceCents: 33_333_33,
      plan: { name: "Odd", kind: "full_payment", discountPercent: 7.5 },
    });
    expect(Number.isInteger(q.netPriceCents)).toBe(true);
    expect(Number.isInteger(q.totalDiscountCents)).toBe(true);
  });

  it("keeps list = net + discount − surcharge exactly", () => {
    // The reconciliation that has to hold, or a peso goes missing
    // between the quote, the contract and the receipt.
    const q = quote({
      listPriceCents: 87_654_32,
      plan: {
        name: "Messy",
        kind: "installment",
        discountPercent: 12.5,
        downPaymentPercent: 17,
        termMonths: 7,
        surchargePercent: 3.5,
      },
      promo: { name: "Odd promo", discountPercent: 2.5 },
    });
    expect(q.listPriceCents - q.totalDiscountCents + q.totalSurchargeCents).toBe(
      q.netPriceCents,
    );
  });

  it("rounds to nearest rather than always favouring one side", () => {
    // 1 centavo at 50% is half a centavo. Rounding is unbiased on
    // purpose — it is the only version that survives being explained
    // to either party.
    expect(percentOf(1, 50)).toBe(1);
    expect(percentOf(3, 50)).toBe(2);
    expect(percentOf(100, 33)).toBe(33);
  });

  it("never lets a fractional peso reach a contract", () => {
    const q = quote({
      listPriceCents: 99_999_99,
      plan: { ...twelveMonths, discountPercent: 3.33 },
    });
    for (const key of [
      q.netPriceCents,
      q.downPaymentCents,
      q.indicativeMonthlyCents,
      q.totalDiscountCents,
    ]) {
      expect(Number.isInteger(key)).toBe(true);
    }
  });
});

describe("nonsense in", () => {
  it("ignores a negative percentage", () => {
    const q = quote({
      listPriceCents: LIST,
      plan: { name: "Neg", kind: "full_payment", discountPercent: -20 },
    });
    expect(q.netPriceCents).toBe(LIST);
  });

  it("clamps a percentage above 100", () => {
    expect(clampPercent(400)).toBe(100);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent("half")).toBe(0);
  });

  it("ignores a fractional centavo in the list price", () => {
    const q = quote({ listPriceCents: 1000.7, plan: cash });
    expect(q.listPriceCents).toBe(1000);
  });
});

describe("whether a promotion applies", () => {
  const NOW = new Date("2026-11-01T10:00:00+08:00").getTime();
  const base = {
    name: "All Souls",
    startsAt: new Date("2026-10-25T00:00:00+08:00").getTime(),
    endsAt: new Date("2026-11-05T00:00:00+08:00").getTime(),
  };
  const ctx = {
    now: NOW,
    lotType: "family",
    section: "Garden of Faith",
    planKind: "full_payment" as const,
  };

  it("applies inside its window", () => {
    expect(checkPromo(base, ctx).eligible).toBe(true);
  });

  it("says WHEN it ended, not just that it did not apply", () => {
    // "Promo not applied" starts an argument. "The All Souls offer
    // ended on 5 November" is something the office can say to a family.
    const r = checkPromo(base, { ...ctx, now: base.endsAt + 1 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("ended on");
    expect(r.reason).toContain("November");
  });

  it("says when it has not started yet", () => {
    const r = checkPromo(base, { ...ctx, now: base.startsAt - 1 });
    expect(r.reason).toContain("does not start until");
  });

  it("ends exclusively — the end instant is already over", () => {
    expect(checkPromo(base, { ...ctx, now: base.endsAt }).eligible).toBe(false);
    expect(checkPromo(base, { ...ctx, now: base.endsAt - 1 }).eligible).toBe(
      true,
    );
  });

  it("limits by lot type when the promotion says so", () => {
    const p = { ...base, appliesToLotTypes: ["niche"] };
    expect(checkPromo(p, ctx).reason).toContain("does not cover family lots");
    expect(checkPromo(p, { ...ctx, lotType: "niche" }).eligible).toBe(true);
  });

  it("treats an empty list as everything", () => {
    // Which is what a form produces when nobody ticks anything, and
    // must not silently mean "nothing".
    const p = {
      ...base,
      appliesToLotTypes: [],
      appliesToSections: [],
      appliesToPlanKinds: [],
    };
    expect(checkPromo(p, ctx).eligible).toBe(true);
  });

  it("limits by garden", () => {
    const p = { ...base, appliesToSections: ["Garden of Peace"] };
    expect(checkPromo(p, ctx).reason).toContain("Garden of Faith");
  });

  it("limits to cash or to instalments", () => {
    const cashOnly = { ...base, appliesToPlanKinds: ["full_payment" as const] };
    expect(
      checkPromo(cashOnly, { ...ctx, planKind: "installment" }).reason,
    ).toContain("cash purchases only");
    expect(checkPromo(cashOnly, ctx).eligible).toBe(true);
  });

  it("stops at the redemption limit", () => {
    const p = { ...base, maxRedemptions: 50, redemptionCount: 50 };
    const r = checkPromo(p, ctx);
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("fully subscribed");
  });

  it("allows the last redemption", () => {
    const p = { ...base, maxRedemptions: 50, redemptionCount: 49 };
    expect(checkPromo(p, ctx).eligible).toBe(true);
  });

  it("treats no limit as unlimited", () => {
    const p = { ...base, redemptionCount: 9999 };
    expect(checkPromo(p, ctx).eligible).toBe(true);
  });

  it("refuses a retired promotion", () => {
    expect(checkPromo({ ...base, isRetired: true }, ctx).reason).toContain(
      "no longer offered",
    );
  });
});

describe("whether a plan applies", () => {
  it("treats an empty list as every lot type", () => {
    expect(planAppliesToLotType([], "family")).toBe(true);
    expect(planAppliesToLotType(undefined, "family")).toBe(true);
  });

  it("limits when the plan names types", () => {
    expect(planAppliesToLotType(["niche"], "family")).toBe(false);
    expect(planAppliesToLotType(["niche", "family"], "family")).toBe(true);
  });
});
