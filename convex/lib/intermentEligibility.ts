/**
 * Whether a lot still being paid off may take an interment.
 *
 * ## Why there has to be a rule
 *
 * A lot becomes `sold` the moment a contract exists — including an
 * installment contract where only the down payment has landed. Until
 * this shipped, `scheduleInterment` checked the lot's STATUS and nothing
 * else, so a family could pay a down payment on Monday and be interred
 * on Tuesday with fifty-nine months outstanding.
 *
 * That is the one case a memorial park cannot recover from. A lot with
 * someone in it cannot practically be reclaimed, so an unpaid balance
 * after interment is not a debt with collateral behind it — it is a
 * loss. Neither the code nor the client-decisions document had a rule;
 * this is it.
 *
 * ## The rule
 *
 * Interment is permitted once a set share of the contract price has been
 * paid — 50% by default, set by an admin rather than hard-coded, because
 * it is a commercial lever the cemetery will want to move without a
 * deployment.
 *
 * A refusal names the shortfall in pesos. "Not eligible" sends a family
 * away with nothing; "₱18,000 more to reach half" is something the
 * office can act on, and often settle at the counter.
 *
 * A fully paid contract is always eligible, whatever the threshold — and
 * a threshold of zero means the cemetery has chosen to allow interment
 * at any point, which is a legitimate position and simply switches the
 * check off.
 */

/** The share of the price that must be paid before interment. */
export const DEFAULT_INTERMENT_THRESHOLD_PERCENT = 50;

export interface ContractPaymentState {
  totalPriceCents: number;
  /** Everything received against this contract so far. */
  paidCents: number;
  state: string;
}

export interface EligibilityResult {
  eligible: boolean;
  /** What must still be paid to qualify. Zero when already eligible. */
  shortfallCents: number;
  requiredCents: number;
  paidCents: number;
  thresholdPercent: number;
  /** Wording for staff, when it is refused. */
  reason?: string;
}

function peso(cents: number): string {
  return "₱" + Math.round(cents / 100).toLocaleString("en-PH");
}

/**
 * Clamp a stored threshold into something meaningful.
 *
 * Above 100 would make every contract ineligible forever, including a
 * fully paid one, which is never what anyone meant to configure.
 */
export function normaliseThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INTERMENT_THRESHOLD_PERCENT;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function checkIntermentEligibility(
  contract: ContractPaymentState,
  thresholdPercent: number = DEFAULT_INTERMENT_THRESHOLD_PERCENT,
): EligibilityResult {
  const threshold = normaliseThreshold(thresholdPercent);
  const paid = Math.max(0, contract.paidCents);

  // Ceiling, not rounding: at a 50% threshold on an odd price, half a
  // centavo short is short. Rounding down would let a contract qualify
  // one centavo below the line, which is the kind of detail that turns
  // into an argument at a counter.
  const requiredCents = Math.ceil(
    (contract.totalPriceCents * threshold) / 100,
  );

  // Settled in full is always eligible, whatever the threshold says.
  const settled =
    contract.state === "paid_in_full" || paid >= contract.totalPriceCents;

  if (settled || paid >= requiredCents) {
    return {
      eligible: true,
      shortfallCents: 0,
      requiredCents,
      paidCents: paid,
      thresholdPercent: threshold,
    };
  }

  const shortfall = requiredCents - paid;
  return {
    eligible: false,
    shortfallCents: shortfall,
    requiredCents,
    paidCents: paid,
    thresholdPercent: threshold,
    reason:
      `This lot is being paid in installments. ${peso(shortfall)} more is ` +
      `needed to reach ${threshold}% of the contract before an interment ` +
      `can be scheduled.`,
  };
}
