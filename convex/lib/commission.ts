/**
 * What an agent is owed, and when the park actually owes it.
 *
 * Two separate questions, and conflating them is the expensive mistake.
 *
 *   - HOW MUCH is a rate against the contract — agreed at the sale and
 *     frozen there, so a park that changes its rate next year does not
 *     silently rewrite what an agent was promised last year.
 *
 *   - WHEN is a share of the price actually collected. The park pays
 *     once the family has paid in far enough — 20% by default. Paying
 *     at signing means paying commission on money that may never
 *     arrive: an instalment contract that defaults in month three has
 *     cost the park a commission and left it holding a lot it has to
 *     sell again.
 *
 * Both are settings rather than constants. The rate is commercial and
 * the threshold is a risk appetite; a cemetery moves both without
 * wanting a deployment.
 *
 * Pure arithmetic — no database, no clock. Everything is passed in.
 */

/** Share of the price that must be collected before commission is due. */
export const DEFAULT_EARNED_AT_PERCENT = 20;

/** Nothing above this can be a rate; a typo, not a policy. */
export const MAX_COMMISSION_PERCENT = 50;

/**
 * The commission on a contract, in centavos.
 *
 * Charged against what the family actually pays — the contract total,
 * net of any discount — not the lot's list price. An agent's share of a
 * discount they helped agree is the discounted figure; commissioning on
 * a price nobody paid would have the park paying out more than it took
 * on a heavily-discounted sale.
 *
 * `Math.round`, so the error is at most half a centavo and does not
 * lean either way. Consistent with `convex/lib/pricing.ts`.
 */
export function computeCommissionCents(
  contractTotalCents: number,
  percent: number,
): number {
  const total = toWholeCents(contractTotalCents);
  const rate = normaliseCommissionPercent(percent);
  if (total <= 0 || rate <= 0) return 0;
  return Math.round((total * rate) / 100);
}

/** Clamp a rate into 0–50; nonsense becomes zero. */
export function normaliseCommissionPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.min(MAX_COMMISSION_PERCENT, value);
}

/** Clamp the earned-at threshold into 0–100. */
export function normaliseEarnedAtPercent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_EARNED_AT_PERCENT;
  }
  return Math.min(100, Math.max(0, value));
}

export type CommissionState = "not_due" | "due" | "paid" | "void";

export interface CommissionStatus {
  state: CommissionState;
  /** What the agent is owed in total, once due. */
  commissionCents: number;
  /** Collected against the contract so far. */
  paidCents: number;
  /** Collections needed before the park owes anything. */
  requiredCents: number;
  /** Still to collect before it becomes due. Zero once it is. */
  shortfallCents: number;
  /** How far the family has got, as a whole percent of the contract. */
  collectedPercent: number;
  /** A sentence the office can read out. */
  message: string;
}

/**
 * Whether the park owes this commission yet.
 *
 * The whole amount becomes payable at once when the threshold is
 * crossed — it does not accrue pro-rata. That is what "earned at 20%
 * paid" means commercially, and a part-paid commission would need its
 * own ledger to track.
 *
 * A voided or cancelled contract owes nothing, whatever was collected.
 * The sale did not happen; a commission on it would be the park paying
 * for work that produced no lot sold.
 */
export function commissionStatus(input: {
  contractState: string;
  contractTotalCents: number;
  paidCents: number;
  commissionCents: number;
  earnedAtPercent?: number;
  paidOutAt?: number;
}): CommissionStatus {
  const total = toWholeCents(input.contractTotalCents);
  const paid = toWholeCents(input.paidCents);
  const commission = toWholeCents(input.commissionCents);
  const threshold = normaliseEarnedAtPercent(
    input.earnedAtPercent ?? DEFAULT_EARNED_AT_PERCENT,
  );

  // Rounded UP: at a 20% threshold on an odd total, half a centavo
  // short is short. It is the kind of detail that becomes an argument.
  const requiredCents = total > 0 ? Math.ceil((total * threshold) / 100) : 0;
  const collectedPercent =
    total > 0 ? Math.floor((paid / total) * 100) : 0;

  const base = {
    commissionCents: commission,
    paidCents: paid,
    requiredCents,
    collectedPercent,
  };

  if (input.contractState === "voided" || input.contractState === "cancelled") {
    return {
      ...base,
      state: "void",
      shortfallCents: 0,
      message: `This contract was ${input.contractState}. No commission is owed on it.`,
    };
  }

  if (commission <= 0) {
    return {
      ...base,
      state: "not_due",
      shortfallCents: 0,
      message: "No commission was recorded on this sale.",
    };
  }

  if (input.paidOutAt !== undefined) {
    return {
      ...base,
      state: "paid",
      shortfallCents: 0,
      message: "Already paid out.",
    };
  }

  if (paid >= requiredCents) {
    return {
      ...base,
      state: "due",
      shortfallCents: 0,
      message: `The family has paid ${collectedPercent}% of the contract, past the ${threshold}% mark. This commission is payable.`,
    };
  }

  const shortfall = requiredCents - paid;
  return {
    ...base,
    state: "not_due",
    shortfallCents: shortfall,
    message: `${formatPesoRough(shortfall)} more must be collected before this commission is due — the family is at ${collectedPercent}% of the ${threshold}% mark.`,
  };
}

/**
 * The rate that applies to a sale.
 *
 * An agent's own rate wins over the park's default, and an explicit
 * rate agreed at the desk wins over both. Resolved here rather than at
 * three call sites, because the answer has to be the same one that gets
 * frozen onto the contract.
 */
export function resolveCommissionPercent(input: {
  explicitPercent?: number;
  agentPercent?: number;
  defaultPercent?: number;
}): number {
  for (const candidate of [
    input.explicitPercent,
    input.agentPercent,
    input.defaultPercent,
  ]) {
    if (candidate === undefined) continue;
    const rate = normaliseCommissionPercent(candidate);
    if (rate > 0) return rate;
  }
  return 0;
}

// --- helpers ----------------------------------------------------------

function toWholeCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Pesos for a message, not for a payout.
 *
 * `src/lib/money.ts` owns display formatting, but it lives under `src/`
 * and the Convex bundler will not pull that across.
 */
function formatPesoRough(cents: number): string {
  const pesos = Math.round(cents / 100);
  return `₱${pesos.toLocaleString("en-PH")}`;
}
