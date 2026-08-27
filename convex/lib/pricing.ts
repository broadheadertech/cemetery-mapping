/**
 * What a family actually pays.
 *
 * Until now this arithmetic happened at the counter. An operator typed
 * the price, typed a discount, typed a reason, typed a down payment, a
 * term, and a monthly amount. Every one of those was a chance to be
 * generous or wrong by a few thousand pesos, and nothing in the system
 * could tell the difference afterwards.
 *
 * This module turns that into a quote: a lot's list price, a named
 * payment plan, an optional promotion, and one number out the other
 * end — with every adjustment itemised, because a family is going to
 * ask why the figure is what it is and the office needs to be able to
 * say.
 *
 * Rules that hold no matter what is passed in:
 *
 *   1. Integer centavos only. Floats are how a peso goes missing
 *      between the quote, the contract and the receipt.
 *   2. Adjustments apply in sequence against the running balance, never
 *      additively against the list price. Ten per cent then five per
 *      cent is 14.5% off, not 15% — the commercial convention, and
 *      never MORE generous than the alternative.
 *   3. The net can never reach zero, and total relief is capped. A
 *      mistyped promotion caps loudly rather than selling a lot for
 *      nothing; the cap is reported so the office sees it happened.
 *   4. `downPaymentCents + monthly × term` is reconciled by the
 *      canonical schedule generator, not here. This module decides the
 *      TOTAL and the DOWN PAYMENT; `convex/lib/installmentSchedule.ts`
 *      owns the split, including where the remainder cents land.
 *
 * Pure arithmetic — no database, no clock. Everything is passed in.
 */

/** Beyond this share of the list price, relief is capped. */
export const DEFAULT_MAX_DISCOUNT_PERCENT = 50;

/** A lot is never sold for nothing, whatever the arithmetic says. */
export const MINIMUM_NET_CENTS = 1;

export type PlanKind = "full_payment" | "installment";

export interface PaymentPlanTerms {
  name: string;
  kind: PlanKind;
  /** Relief for choosing this plan — the classic cash discount. */
  discountPercent?: number;
  /** Installment only: share of the net taken up front. */
  downPaymentPercent?: number;
  /** Installment only: number of monthly payments. */
  termMonths?: number;
  /**
   * Installment only: what the park adds for carrying the balance.
   * Optional and normally absent — a park that prices cash and terms
   * the same simply leaves it off.
   */
  surchargePercent?: number;
}

export interface PromoTerms {
  name: string;
  discountPercent?: number;
  discountCents?: number;
}

/** One line of the "why is it this much" explanation. */
export interface Adjustment {
  label: string;
  /** Negative reduces what the family pays; positive increases it. */
  amountCents: number;
  source: "plan" | "promo" | "manual";
  /** The percentage behind it, when there was one. */
  percent?: number;
}

export interface Quote {
  /** The lot's price before anything is applied. */
  listPriceCents: number;
  adjustments: Adjustment[];
  /** What the family pays in total. */
  netPriceCents: number;
  /** Everything taken off, as a positive number. */
  totalDiscountCents: number;
  /** Everything added on, as a positive number. */
  totalSurchargeCents: number;

  kind: PlanKind;
  /** Installment only. Zero for a full payment. */
  downPaymentCents: number;
  /** Installment only. Zero for a full payment. */
  termMonths: number;
  /**
   * Indicative monthly figure, for showing a family at the desk. The
   * contract's real schedule comes from `generateInstallmentSchedule`,
   * which places the remainder cents on the final month — so the last
   * payment can be a few centavos more than this.
   */
  indicativeMonthlyCents: number;

  /**
   * Set when relief was reduced to stay inside the cap. Present means
   * the family was quoted LESS of a discount than the plan and promo
   * asked for, which somebody needs to see rather than discover later.
   */
  cappedNote?: string;
  /** Anything the office should read aloud or check before signing. */
  warnings: string[];
}

export interface QuoteInput {
  listPriceCents: number;
  plan: PaymentPlanTerms;
  promo?: PromoTerms;
  /** A one-off discount the operator entered, in centavos. */
  manualDiscountCents?: number;
  /** Ceiling on total relief. Defaults to 50%. */
  maxDiscountPercent?: number;
}

/**
 * Price a lot under a plan, with an optional promotion.
 *
 * Order matters and is fixed: the plan's own terms first, then the
 * promotion, then any one-off discount the operator entered. Each
 * applies to what is left after the one before it. A different order
 * produces a different peso figure, so it is not left to chance.
 */
export function quote(input: QuoteInput): Quote {
  const listPriceCents = toWholeCents(input.listPriceCents);
  const kind = input.plan.kind;
  const adjustments: Adjustment[] = [];
  const warnings: string[] = [];

  if (listPriceCents <= 0) {
    return emptyQuote(kind, [
      "This lot has no price set. Set one before quoting.",
    ]);
  }

  const maxDiscountPercent = clampPercent(
    input.maxDiscountPercent ?? DEFAULT_MAX_DISCOUNT_PERCENT,
  );

  // --- relief, in order ------------------------------------------
  let running = listPriceCents;

  const planPct = clampPercent(input.plan.discountPercent ?? 0);
  if (planPct > 0) {
    const amount = percentOf(running, planPct);
    if (amount > 0) {
      adjustments.push({
        label: input.plan.name,
        amountCents: -amount,
        source: "plan",
        percent: planPct,
      });
      running -= amount;
    }
  }

  if (input.promo !== undefined) {
    const promoPct = clampPercent(input.promo.discountPercent ?? 0);
    const promoFlat = toWholeCents(input.promo.discountCents ?? 0);
    // A promotion carrying both is a data error, not a stacking rule.
    // Taking the larger of the two is the reading that cannot
    // accidentally give away more than either was meant to.
    const byPercent = promoPct > 0 ? percentOf(running, promoPct) : 0;
    const amount = Math.max(byPercent, promoFlat);
    if (promoPct > 0 && promoFlat > 0) {
      warnings.push(
        `"${input.promo.name}" carries both a percentage and a peso amount. The larger of the two was applied; fix the promotion so it carries one.`,
      );
    }
    if (amount > 0) {
      const entry: Adjustment = {
        label: input.promo.name,
        amountCents: -Math.min(amount, running),
        source: "promo",
      };
      if (amount === byPercent && promoPct > 0) entry.percent = promoPct;
      adjustments.push(entry);
      running -= Math.min(amount, running);
    }
  }

  const manual = toWholeCents(input.manualDiscountCents ?? 0);
  if (manual > 0) {
    const amount = Math.min(manual, running);
    adjustments.push({
      label: "Discount agreed at the desk",
      amountCents: -amount,
      source: "manual",
    });
    running -= amount;
  }

  // --- the cap ----------------------------------------------------
  //
  // Applied to the TOTAL, after everything, because that is the only
  // point where the real figure is known. Capping each adjustment
  // separately would let three modest ones combine past the ceiling.
  let totalDiscountCents = listPriceCents - running;
  let cappedNote: string | undefined;
  const ceiling = percentOf(listPriceCents, maxDiscountPercent);

  if (totalDiscountCents > ceiling) {
    const removed = totalDiscountCents - ceiling;
    cappedNote = `Relief was capped at ${maxDiscountPercent}% of the list price. ${formatPesoRough(
      removed,
    )} of the requested discount was not applied — check the plan and the promotion before signing anything.`;
    totalDiscountCents = ceiling;
    running = listPriceCents - ceiling;
  }

  if (running < MINIMUM_NET_CENTS) {
    cappedNote =
      "The discounts would have reduced this lot to nothing. They were capped; check the figures before signing anything.";
    running = MINIMUM_NET_CENTS;
    totalDiscountCents = listPriceCents - MINIMUM_NET_CENTS;
  }

  // --- what the park adds for carrying the balance -----------------
  let totalSurchargeCents = 0;
  if (kind === "installment") {
    const surPct = clampPercent(input.plan.surchargePercent ?? 0);
    if (surPct > 0) {
      const amount = percentOf(running, surPct);
      if (amount > 0) {
        adjustments.push({
          label: `Instalment terms (${input.plan.name})`,
          amountCents: amount,
          source: "plan",
          percent: surPct,
        });
        running += amount;
        totalSurchargeCents = amount;
      }
    }
  }

  const netPriceCents = running;

  // --- the split ---------------------------------------------------
  let downPaymentCents = 0;
  let termMonths = 0;
  let indicativeMonthlyCents = 0;

  if (kind === "installment") {
    termMonths = wholeTerm(input.plan.termMonths);
    if (termMonths === 0) {
      warnings.push(
        `"${input.plan.name}" has no term set, so no schedule can be quoted. Fix the plan.`,
      );
    } else {
      const downPct = clampPercent(input.plan.downPaymentPercent ?? 0);
      downPaymentCents = percentOf(netPriceCents, downPct);

      // The sale mutation rejects a down payment at or above the total
      // (that is a full payment wearing the wrong hat) and rejects zero
      // down outright. Catching both here means the office is told
      // which plan is misconfigured rather than reading a raw
      // ZERO_DOWN_NOT_SUPPORTED at submit.
      if (downPaymentCents >= netPriceCents) {
        downPaymentCents = netPriceCents - MINIMUM_NET_CENTS;
        warnings.push(
          `"${input.plan.name}" asks for a down payment at or above the whole price. It was reduced; this plan needs fixing.`,
        );
      }
      if (downPaymentCents <= 0) {
        warnings.push(
          `"${input.plan.name}" asks for no deposit, which the sale flow refuses. Set a down payment on the plan.`,
        );
      }

      indicativeMonthlyCents = Math.floor(
        (netPriceCents - downPaymentCents) / termMonths,
      );
    }
  }

  const result: Quote = {
    listPriceCents,
    adjustments,
    netPriceCents,
    totalDiscountCents,
    totalSurchargeCents,
    kind,
    downPaymentCents,
    termMonths,
    indicativeMonthlyCents,
    warnings,
  };
  if (cappedNote !== undefined) result.cappedNote = cappedNote;
  return result;
}

/**
 * Whether a promotion is live and applies to this lot right now.
 *
 * Deliberately returns a REASON when it does not. An operator told
 * "promo not applied" starts arguing with the system; one told "the
 * All Souls offer ended on 3 November" tells the family something true.
 */
export interface PromoEligibility {
  eligible: boolean;
  reason?: string;
}

export interface PromoWindow {
  name: string;
  startsAt: number;
  endsAt: number;
  appliesToLotTypes?: string[];
  appliesToSections?: string[];
  appliesToPlanKinds?: PlanKind[];
  maxRedemptions?: number;
  redemptionCount?: number;
  isRetired?: boolean;
}

export function checkPromo(
  promo: PromoWindow,
  context: {
    now: number;
    lotType: string;
    section: string;
    planKind: PlanKind;
  },
): PromoEligibility {
  if (promo.isRetired === true) {
    return { eligible: false, reason: `"${promo.name}" is no longer offered.` };
  }
  if (context.now < promo.startsAt) {
    return {
      eligible: false,
      reason: `"${promo.name}" does not start until ${formatDayRough(promo.startsAt)}.`,
    };
  }
  if (context.now >= promo.endsAt) {
    return {
      eligible: false,
      reason: `"${promo.name}" ended on ${formatDayRough(promo.endsAt)}.`,
    };
  }
  // An empty list means "everything" — the common case, and the one a
  // form produces when nobody ticks anything.
  if (
    promo.appliesToLotTypes !== undefined &&
    promo.appliesToLotTypes.length > 0 &&
    !promo.appliesToLotTypes.includes(context.lotType)
  ) {
    return {
      eligible: false,
      reason: `"${promo.name}" does not cover ${context.lotType} lots.`,
    };
  }
  if (
    promo.appliesToSections !== undefined &&
    promo.appliesToSections.length > 0 &&
    !promo.appliesToSections.includes(context.section)
  ) {
    return {
      eligible: false,
      reason: `"${promo.name}" does not cover ${context.section}.`,
    };
  }
  if (
    promo.appliesToPlanKinds !== undefined &&
    promo.appliesToPlanKinds.length > 0 &&
    !promo.appliesToPlanKinds.includes(context.planKind)
  ) {
    return {
      eligible: false,
      reason:
        context.planKind === "installment"
          ? `"${promo.name}" applies to cash purchases only.`
          : `"${promo.name}" applies to instalment plans only.`,
    };
  }
  const cap = promo.maxRedemptions;
  if (cap !== undefined && cap > 0) {
    const used = promo.redemptionCount ?? 0;
    if (used >= cap) {
      return {
        eligible: false,
        reason: `"${promo.name}" has been taken up ${used} times and is fully subscribed.`,
      };
    }
  }
  return { eligible: true };
}

/** Whether a plan may be offered for a lot of this type. */
export function planAppliesToLotType(
  appliesToLotTypes: string[] | undefined,
  lotType: string,
): boolean {
  if (appliesToLotTypes === undefined || appliesToLotTypes.length === 0) {
    return true;
  }
  return appliesToLotTypes.includes(lotType);
}

// --- arithmetic -------------------------------------------------------

/**
 * A percentage of a centavo amount, as whole centavos.
 *
 * `Math.round`, not floor or ceil. The error is at most half a centavo
 * and it does not lean one way, which is the only version of this that
 * survives being explained to either party.
 */
export function percentOf(cents: number, percent: number): number {
  if (!Number.isFinite(cents) || !Number.isFinite(percent)) return 0;
  return Math.round((cents * percent) / 100);
}

/** Clamp a percentage into 0–100; nonsense becomes zero. */
export function clampPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.min(100, value);
}

function toWholeCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function wholeTerm(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const n = Math.floor(value);
  return n > 0 && n <= 60 ? n : 0;
}

function emptyQuote(kind: PlanKind, warnings: string[]): Quote {
  return {
    listPriceCents: 0,
    adjustments: [],
    netPriceCents: 0,
    totalDiscountCents: 0,
    totalSurchargeCents: 0,
    kind,
    downPaymentCents: 0,
    termMonths: 0,
    indicativeMonthlyCents: 0,
    warnings,
  };
}

/**
 * Pesos for a message, not for a receipt.
 *
 * `src/lib/money.ts` owns display formatting, but it lives under `src/`
 * and the Convex bundler will not pull that across. These strings only
 * ever appear inside a warning sentence.
 */
function formatPesoRough(cents: number): string {
  const pesos = Math.round(cents / 100);
  return `₱${pesos.toLocaleString("en-PH")}`;
}

function formatDayRough(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}
