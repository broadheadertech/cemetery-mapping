/**
 * How fast the park is selling, and how long the ground will last.
 *
 * `convex/phasePlanning.ts` already computes a runway, but from
 * `monthlyAbsorption` — a figure someone typed in. This module measures
 * the same thing from contracts that actually exist, so the plan can be
 * checked against reality instead of against itself.
 *
 * The decision on the other end of this number is whether to spend
 * millions developing the next parcel, and when. That sets the tone for
 * everything here: it reports what it can support and says so plainly
 * when it cannot. A confident-looking rate measured from two months of
 * data is worse than no rate at all, so `confidence` is part of the
 * result, not a footnote.
 *
 * Pure arithmetic — no database, no clock. Everything is passed in.
 */

/** Months of history below which a rate is not worth acting on. */
export const MIN_MONTHS_FOR_CONFIDENCE = 6;

/** The recent window, used when it disagrees with the long one. */
export const RECENT_WINDOW_MONTHS = 6;

export type Confidence = "good" | "thin" | "insufficient";

export interface AbsorptionRate {
  /** Lots sold per month across the whole window. */
  perMonth: number;
  /** Lots sold per month across the trailing six. */
  recentPerMonth: number;
  /** Total lots sold in the window. */
  totalSold: number;
  /** Months in the window that carry any data at all. */
  monthsObserved: number;
  confidence: Confidence;
  /**
   * Whether the recent window is running ahead of, behind, or level
   * with the full window. Level is anything within 15% — below that the
   * difference is month-to-month noise, not a trend.
   */
  trend: "accelerating" | "slowing" | "steady";
  /** Plain-language note on what the number can bear. */
  caveat?: string;
}

/**
 * Measure the sales rate from a monthly series, oldest first.
 *
 * `monthsObserved` deliberately counts months from the first month with
 * a sale onward, not the whole array. A park that opened four months ago
 * has four months of history; averaging over twelve would quietly divide
 * its rate by three and make the ground look like it will last forever.
 */
export function measureAbsorption(monthlySales: number[]): AbsorptionRate {
  const series = monthlySales.map((n) =>
    Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
  );
  const firstSale = series.findIndex((n) => n > 0);

  if (firstSale === -1) {
    return {
      perMonth: 0,
      recentPerMonth: 0,
      totalSold: 0,
      monthsObserved: 0,
      confidence: "insufficient",
      trend: "steady",
      caveat:
        "No sales recorded in this window, so the rate cannot be measured. Runway below is unknown, not infinite.",
    };
  }

  const observed = series.slice(firstSale);
  const monthsObserved = observed.length;
  const totalSold = observed.reduce((t, n) => t + n, 0);
  const perMonth = round1(totalSold / monthsObserved);

  const recentSlice = series.slice(-RECENT_WINDOW_MONTHS);
  const recentMonths = Math.min(monthsObserved, recentSlice.length);
  const recentPerMonth =
    recentMonths > 0
      ? round1(recentSlice.reduce((t, n) => t + n, 0) / recentMonths)
      : perMonth;

  const confidence: Confidence =
    monthsObserved >= MIN_MONTHS_FOR_CONFIDENCE
      ? "good"
      : monthsObserved >= 3
        ? "thin"
        : "insufficient";

  // 15% either way is noise at these volumes — a park selling eight lots
  // a month sells six in a slow one without anything having changed.
  const drift = perMonth > 0 ? (recentPerMonth - perMonth) / perMonth : 0;
  const trend =
    drift > 0.15 ? "accelerating" : drift < -0.15 ? "slowing" : "steady";

  const rate: AbsorptionRate = {
    perMonth,
    recentPerMonth,
    totalSold,
    monthsObserved,
    confidence,
    trend,
  };

  if (confidence === "insufficient") {
    rate.caveat = `Only ${monthsObserved} month${
      monthsObserved === 1 ? "" : "s"
    } of sales to measure from. Treat this as an early indication, not a planning figure.`;
  } else if (confidence === "thin") {
    rate.caveat = `Measured from ${monthsObserved} months. Enough to see a shape, not enough to commit a development budget to.`;
  } else if (trend !== "steady") {
    rate.caveat = `The last ${RECENT_WINDOW_MONTHS} months are ${
      trend === "accelerating" ? "ahead of" : "behind"
    } the full-year rate (${recentPerMonth} vs ${perMonth} a month). The runway below uses the full-year figure; recalculate on the recent rate if you believe the change will hold.`;
  }

  return rate;
}

export interface Runway {
  /** Months of inventory left, or null when the rate is zero. */
  months: number | null;
  /** The same figure in years, for anything beyond about two years. */
  years: number | null;
  /** How it should be said out loud. */
  label: string;
  /**
   * True when the ground runs out inside two years — the point at which
   * developing the next parcel stops being a plan and becomes a
   * deadline, given survey and permit lead times.
   */
  isUrgent: boolean;
}

/**
 * How long the remaining lots last at a given rate.
 *
 * A zero rate yields `null`, never `Infinity`. "Unknown" is the honest
 * answer and it renders; `Infinity` becomes "∞ years of inventory" on a
 * screen someone plans against.
 */
export function computeRunway(
  availableLots: number,
  perMonth: number,
): Runway {
  const available = Math.max(0, Math.floor(availableLots));

  if (perMonth <= 0) {
    return {
      months: null,
      years: null,
      label:
        available === 0
          ? "Nothing left to sell."
          : "Not measurable — no sales in the window.",
      isUrgent: available === 0,
    };
  }

  if (available === 0) {
    return {
      months: 0,
      years: 0,
      label: "Sold out. Every remaining lot is spoken for.",
      isUrgent: true,
    };
  }

  const months = round1(available / perMonth);
  const years = round1(months / 12);

  const label =
    months < 12
      ? `About ${Math.round(months)} month${
          Math.round(months) === 1 ? "" : "s"
        } of inventory left.`
      : `About ${years} year${years === 1 ? "" : "s"} of inventory left.`;

  return { months, years, label, isUrgent: months <= 24 };
}

export interface PlanVariance {
  /** The figure the phase plan was built on. */
  plannedPerMonth: number;
  /** What the contracts actually show. */
  measuredPerMonth: number;
  /** Measured ÷ planned, as a percentage. 100 means they agree. */
  percentOfPlan: number;
  /**
   * `agrees` within 25%; otherwise which way reality has gone. The band
   * is wide on purpose — a plan is an estimate, and flagging every 10%
   * wobble would train people to ignore the flag.
   *
   * Named for the MEASUREMENT, not for a judgement about the plan.
   * "optimistic plan" reads either way depending on whether you think
   * the optimism is about sales or about runway, and this is not a
   * sentence to be ambiguous in.
   */
  verdict: "agrees" | "sales_below_plan" | "sales_above_plan" | "unknown";
  message: string;
  /**
   * True for the direction that costs the park ground: selling faster
   * than the plan assumed, so inventory runs out before the next parcel
   * is ready. The opposite direction only wastes capital early.
   */
  isRisk: boolean;
}

/**
 * Check a phase plan's assumed absorption against the measured one.
 *
 * This is the point of the module. A plan that assumes twelve lots a
 * month when the park sells four has a runway three times longer than
 * the real one, and the parcel gets developed three years late.
 */
export function comparePlanToMeasured(
  plannedPerMonth: number,
  measured: AbsorptionRate,
): PlanVariance {
  const planned = Number.isFinite(plannedPerMonth)
    ? Math.max(0, plannedPerMonth)
    : 0;

  if (measured.confidence === "insufficient" || planned <= 0) {
    return {
      plannedPerMonth: planned,
      measuredPerMonth: measured.perMonth,
      percentOfPlan: 0,
      verdict: "unknown",
      isRisk: false,
      message:
        planned <= 0
          ? "This phase has no assumed sales rate to check against."
          : "Not enough sales history to check the plan's assumption yet.",
    };
  }

  const percentOfPlan = Math.round((measured.perMonth / planned) * 100);

  if (percentOfPlan >= 75 && percentOfPlan <= 125) {
    return {
      plannedPerMonth: planned,
      measuredPerMonth: measured.perMonth,
      percentOfPlan,
      verdict: "agrees",
      isRisk: false,
      message: `The plan assumes ${planned} a month and the park is selling ${measured.perMonth}. Close enough to plan on.`,
    };
  }

  // Selling BELOW plan means the ground lasts longer than the plan
  // thinks — wasteful, not dangerous. Selling ABOVE plan means it runs
  // out sooner, and survey and permits cannot be hurried.
  const belowPlan = percentOfPlan < 75;
  return {
    plannedPerMonth: planned,
    measuredPerMonth: measured.perMonth,
    percentOfPlan,
    verdict: belowPlan ? "sales_below_plan" : "sales_above_plan",
    isRisk: !belowPlan,
    message: belowPlan
      ? `The plan assumes ${planned} lots a month; the park is selling ${measured.perMonth} — about ${percentOfPlan}% of that. The ground will last longer than the plan expects, so the next parcel is scheduled earlier than it needs to be.`
      : `The plan assumes ${planned} lots a month; the park is selling ${measured.perMonth} — about ${percentOfPlan}% of that. Inventory will run out sooner than the plan expects, and survey and permits take months.`,
  };
}

/** Sell-through as a whole percent. Zero inventory reads as zero. */
export function sellThroughPercent(total: number, available: number): number {
  if (total <= 0) return 0;
  const sold = Math.max(0, total - Math.max(0, available));
  return Math.round((sold / total) * 100);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
