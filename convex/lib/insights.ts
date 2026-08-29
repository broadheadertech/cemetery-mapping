/**
 * Descriptive, diagnostic, predictive, prescriptive — honestly.
 *
 * The four levels are easy to fake and expensive to fake. A memorial
 * park has a handful of agents and a few hundred contracts; at that
 * scale "predictive" is straight-line arithmetic and "prescriptive" is
 * a suggestion, and calling either of them anything grander produces
 * confident nonsense that somebody acts on.
 *
 * So every finding carries three things beside its sentence:
 *
 *   - `level`  — which of the four it is.
 *   - `confidence` — `observed` for a fact, `indicative` for a
 *     comparison that holds but has other explanations, `speculative`
 *     for an extrapolation.
 *   - `basis` — what it was computed from, so a reader can check it
 *     rather than take it.
 *
 * And the rules that keep those honest are enforced here, not left to
 * whoever writes the next finding:
 *
 *   - A DIAGNOSTIC is never `observed`. It is an explanation, and there
 *     is always another one.
 *   - A PREDICTIVE is never better than `indicative`, and is
 *     `speculative` whenever the history behind it is thin.
 *   - Nothing is ranked on a sample too small to rank. Two agents, one
 *     of whom started last month, is not a league table.
 *
 * Pure arithmetic — no database, no clock. Everything is passed in.
 */

export type InsightLevel =
  | "descriptive"
  | "diagnostic"
  | "predictive"
  | "prescriptive";

export type Confidence = "observed" | "indicative" | "speculative";

export type InsightTopic = "agents" | "phases" | "discounts";

export interface Insight {
  level: InsightLevel;
  topic: InsightTopic;
  /** One line, readable across a desk. */
  headline: string;
  detail: string;
  confidence: Confidence;
  /** What it was computed from. */
  basis: string;
  /** Prescriptive only: the thing somebody could actually do. */
  action?: string;
}

/** Below this many sales, an agent is not comparable to another. */
export const MIN_SALES_TO_RANK = 3;

/** Below this many agents with enough sales, there is no ranking. */
export const MIN_AGENTS_TO_RANK = 2;

/** Below this many months of history, a projection is speculative. */
export const MIN_MONTHS_TO_PROJECT = 3;

/**
 * A gap smaller than this is not a finding.
 *
 * Two agents within a fifth of each other are doing the same job. A
 * dashboard that flags that gap teaches people to ignore the dashboard.
 */
export const MATERIAL_GAP_RATIO = 1.25;

// --- agents ------------------------------------------------------------

export interface AgentFacts {
  agentId: string;
  name: string;
  /** True for the park's own row — it is not a person and does not rank. */
  isSystem: boolean;
  salesCount: number;
  /** Total contract value credited to them, in centavos. */
  soldValueCents: number;
  /** Commission recorded across those sales. */
  commissionCents: number;
  /** Of that, what is payable now. */
  commissionDueCents: number;
  /** Of that, what is waiting on the family to pay further in. */
  commissionNotDueCents: number;
  /** Months between their first and most recent sale, at least 1. */
  activeMonths: number;
}

/**
 * Read the agent register.
 *
 * The park's own row is excluded from every comparison. It is not a
 * person, it earns nothing, and leaving it in would make it the biggest
 * seller and the worst earner simultaneously.
 */
export function analyseAgents(facts: AgentFacts[]): Insight[] {
  const people = facts.filter((a) => !a.isSystem);
  const out: Insight[] = [];

  if (people.length === 0) {
    return [
      {
        level: "descriptive",
        topic: "agents",
        headline: "No sales are credited to an agent yet.",
        detail:
          "Every sale so far is recorded as an online transaction — the park's own. Once agents are on the books and credited on sales, this section compares them.",
        confidence: "observed",
        basis: "The commission records on every contract.",
      },
    ];
  }

  const totalCommission = sum(people.map((a) => a.commissionCents));
  const totalSales = sum(people.map((a) => a.salesCount));

  out.push({
    level: "descriptive",
    topic: "agents",
    headline: `${people.length} agent${people.length === 1 ? "" : "s"} carried ${totalSales} sale${totalSales === 1 ? "" : "s"}, earning ${peso(totalCommission)}.`,
    detail: describeAgentSpread(people),
    confidence: "observed",
    basis: `Commission recorded on ${totalSales} contracts.`,
  });

  // --- ranking, only where ranking means something -------------------
  const rankable = people.filter((a) => a.salesCount >= MIN_SALES_TO_RANK);

  if (rankable.length < MIN_AGENTS_TO_RANK) {
    out.push({
      level: "descriptive",
      topic: "agents",
      headline: "Not enough history to compare agents yet.",
      detail: `Comparing agents needs at least ${MIN_AGENTS_TO_RANK} of them with ${MIN_SALES_TO_RANK} sales each. Ranking on fewer is ranking on luck, and the first ranking a park sees is the one it remembers.`,
      confidence: "observed",
      basis: `${people.length} agents on the books, ${rankable.length} with ${MIN_SALES_TO_RANK} or more sales.`,
    });
    return out;
  }

  const byCommission = [...rankable].sort(
    (a, b) => b.commissionCents - a.commissionCents,
  );
  const top = byCommission[0]!;
  const bottom = byCommission[byCommission.length - 1]!;

  out.push({
    level: "descriptive",
    topic: "agents",
    headline: `${top.name} has earned the most: ${peso(top.commissionCents)}.`,
    detail: `${bottom.name} has earned the least of those comparable: ${peso(bottom.commissionCents)}, across ${bottom.salesCount} sale${bottom.salesCount === 1 ? "" : "s"} against ${top.name}'s ${top.salesCount}.`,
    confidence: "observed",
    basis: `${rankable.length} agents with ${MIN_SALES_TO_RANK} or more sales each.`,
  });

  // --- why ------------------------------------------------------------
  if (top.agentId !== bottom.agentId) {
    out.push(...diagnoseAgentGap(top, bottom));
  }

  // --- a gap that is not about selling --------------------------------
  for (const a of people) {
    if (a.commissionCents <= 0) continue;
    const stuck = a.commissionNotDueCents;
    if (stuck <= 0) continue;
    const stuckShare = stuck / a.commissionCents;
    if (stuckShare < 0.5) continue;

    out.push({
      level: "diagnostic",
      topic: "agents",
      headline: `Most of ${a.name}'s commission is waiting on collections, not on sales.`,
      detail: `${peso(stuck)} of their ${peso(a.commissionCents)} is recorded but not payable — the families on those contracts have not paid in far enough yet. That is a collections question, not a selling one, and it would read as underperformance in any ranking by what has actually been paid out.`,
      confidence: "indicative",
      basis: `${Math.round(stuckShare * 100)}% of this agent's recorded commission is below the collection threshold.`,
    });
  }

  // --- what happens if nothing changes --------------------------------
  out.push(...projectAgents(rankable));

  // --- what to do -----------------------------------------------------
  out.push(...prescribeForAgents(top, bottom, people));

  return out;
}

function describeAgentSpread(people: AgentFacts[]): string {
  const withSales = people.filter((a) => a.salesCount > 0);
  if (withSales.length === 0) {
    return "None of them has been credited with a sale yet.";
  }
  const idle = people.length - withSales.length;
  const parts = [
    `${withSales.length} of ${people.length} ${withSales.length === 1 ? "has" : "have"} sold something.`,
  ];
  if (idle > 0) {
    parts.push(
      `${idle} ${idle === 1 ? "has" : "have"} no sale credited to them at all — worth checking whether that is real or whether their sales are being recorded without an agent.`,
    );
  }
  return parts.join(" ");
}

/**
 * Why one agent is ahead of another.
 *
 * Three candidate explanations, checked in order, and only the ones the
 * numbers actually support are returned. Volume, deal size, and rate
 * are different problems with different answers, and "sells less" is
 * not a diagnosis.
 */
function diagnoseAgentGap(top: AgentFacts, bottom: AgentFacts): Insight[] {
  const out: Insight[] = [];

  const topPerMonth = top.salesCount / Math.max(1, top.activeMonths);
  const bottomPerMonth = bottom.salesCount / Math.max(1, bottom.activeMonths);
  if (
    bottomPerMonth > 0 &&
    topPerMonth / bottomPerMonth >= MATERIAL_GAP_RATIO
  ) {
    out.push({
      level: "diagnostic",
      topic: "agents",
      headline: `${top.name} closes more often — ${round1(topPerMonth)} sales a month against ${round1(bottomPerMonth)}.`,
      detail:
        "The gap is in how many families they close, not in what each sale is worth. That points at pipeline or at time on the ground rather than at pricing.",
      confidence: "indicative",
      basis: "Sales per active month for each agent.",
    });
  }

  const topAvg = averageSale(top);
  const bottomAvg = averageSale(bottom);
  if (bottomAvg > 0 && topAvg / bottomAvg >= MATERIAL_GAP_RATIO) {
    out.push({
      level: "diagnostic",
      topic: "agents",
      headline: `${top.name}'s sales are larger — ${peso(topAvg)} against ${peso(bottomAvg)} on average.`,
      detail:
        "Same number of families could produce very different commission at these averages. It usually means a different mix of gardens or lot types is being shown first, which is a coachable thing rather than a talent one.",
      confidence: "indicative",
      basis: "Average contract value per sale for each agent.",
    });
  }

  const topRate = effectiveRate(top);
  const bottomRate = effectiveRate(bottom);
  if (bottomRate > 0 && topRate - bottomRate >= 1) {
    out.push({
      level: "diagnostic",
      topic: "agents",
      headline: `They are not on the same rate — ${round1(topRate)}% against ${round1(bottomRate)}%.`,
      detail:
        "Part of this gap is the agreement, not the performance. Comparing what two agents earned without comparing what they sold reads the rate as effort.",
      confidence: "indicative",
      basis: "Commission as a share of value sold, per agent.",
    });
  }

  if (out.length === 0) {
    out.push({
      level: "diagnostic",
      topic: "agents",
      headline: "The gap has no single obvious cause in this data.",
      detail: `${top.name} and ${bottom.name} are close on volume, deal size and rate. Whatever separates them is not something these numbers hold, and the honest answer is to ask them rather than to infer it.`,
      confidence: "indicative",
      basis: "Volume, average sale value and effective rate all within a quarter of each other.",
    });
  }

  return out;
}

function projectAgents(rankable: AgentFacts[]): Insight[] {
  const mature = rankable.filter((a) => a.activeMonths >= MIN_MONTHS_TO_PROJECT);
  if (mature.length === 0) {
    return [
      {
        level: "predictive",
        topic: "agents",
        headline: "Too early to project what agents will earn.",
        detail: `No agent has ${MIN_MONTHS_TO_PROJECT} months of selling behind them yet. A run-rate off less than that is one good month wearing a trend's clothes.`,
        confidence: "speculative",
        basis: "Months between each agent's first and most recent sale.",
      },
    ];
  }

  const lines = mature
    .map((a) => {
      const perMonth = a.commissionCents / Math.max(1, a.activeMonths);
      return `${a.name} ≈ ${peso(perMonth * 12)}`;
    })
    .join(" · ");

  return [
    {
      level: "predictive",
      topic: "agents",
      headline: "At the current run-rate, over the next twelve months:",
      detail: `${lines}. This is arithmetic, not a forecast — it assumes each agent keeps selling exactly as they have, that prices hold, and that nothing changes about what is on the shelf.`,
      // Never better than indicative, however much history there is.
      // It is an extrapolation of a small park's recent past.
      confidence:
        mature.every((a) => a.activeMonths >= 6) ? "indicative" : "speculative",
      basis: `Commission per active month for ${mature.length} agent${mature.length === 1 ? "" : "s"}, multiplied by twelve.`,
    },
  ];
}

function prescribeForAgents(
  top: AgentFacts,
  bottom: AgentFacts,
  all: AgentFacts[],
): Insight[] {
  const out: Insight[] = [];

  const topAvg = averageSale(top);
  const bottomAvg = averageSale(bottom);
  if (bottomAvg > 0 && topAvg / bottomAvg >= MATERIAL_GAP_RATIO) {
    out.push({
      level: "prescriptive",
      topic: "agents",
      headline: `Find out which gardens ${top.name} shows first.`,
      detail: `Their average sale is ${peso(topAvg - bottomAvg)} higher than ${bottom.name}'s. If that is about which lots get shown rather than who is asking, it is the cheapest thing on this page to fix.`,
      confidence: "indicative",
      basis: "The difference in average contract value between the two.",
      action: `Compare the lot types and gardens on ${top.name}'s and ${bottom.name}'s recent contracts.`,
    });
  }

  const idle = all.filter((a) => a.salesCount === 0);
  if (idle.length > 0) {
    out.push({
      level: "prescriptive",
      topic: "agents",
      headline: `${idle.length} agent${idle.length === 1 ? " has" : "s have"} no sales recorded.`,
      detail:
        "Before reading that as performance, check the desk: a sale recorded without picking an agent is credited to the platform, and an agent's work can disappear that way without anybody noticing.",
      confidence: "indicative",
      basis: "Agents on the register with no contract credited to them.",
      action:
        "Check a few recent contracts against what the agents say they sold.",
    });
  }

  const waiting = all.filter(
    (a) => a.commissionNotDueCents > 0 && a.commissionDueCents === 0,
  );
  if (waiting.length > 0) {
    out.push({
      level: "prescriptive",
      topic: "agents",
      headline: `Nothing is payable to ${waiting.length === 1 ? waiting[0]!.name : `${waiting.length} agents`} yet.`,
      detail:
        "Their commission is recorded but the families have not paid in far enough. Chasing those collections pays the agent and the park at the same time.",
      confidence: "observed",
      basis: "Commissions below the collection threshold.",
      action: "Work the receivables on those contracts.",
    });
  }

  return out;
}

// --- phases ------------------------------------------------------------

export interface PhaseFacts {
  phaseId: string;
  number: number;
  name: string;
  stage: string;
  totalLots: number;
  availableLots: number;
  /** Sold across the whole life of the phase. */
  soldLots: number;
  /** Sold within the analytics window. */
  soldInWindow: number;
  /** Months the window covers. */
  windowMonths: number;
  /** Average list price of a lot in this phase, in centavos. */
  averagePriceCents: number;
}

/**
 * Read the phase plan against what is actually selling.
 *
 * "Buy rate" here is sell-through — the share of a phase that has gone
 * — read alongside how fast it is currently going. A phase can be 80%
 * sold and stalled, or 10% sold and moving quickly, and those are
 * opposite situations that one number hides.
 */
export function analysePhases(facts: PhaseFacts[]): Insight[] {
  const live = facts.filter((p) => p.totalLots > 0);
  const out: Insight[] = [];

  if (live.length === 0) {
    return [
      {
        level: "descriptive",
        topic: "phases",
        headline: "No phase has any lots against it yet.",
        detail:
          "Phases need their section names filled in before their buy rate can be measured from real inventory.",
        confidence: "observed",
        basis: "Lots matched to each phase by section name.",
      },
    ];
  }

  const ranked = [...live].sort(
    (a, b) => buyRate(b) - buyRate(a) || b.soldLots - a.soldLots,
  );
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;

  out.push({
    level: "descriptive",
    topic: "phases",
    headline: `${best.name} is selling best at ${buyRate(best)}% taken.`,
    detail:
      live.length === 1
        ? "It is the only phase with lots against it, so there is nothing to compare it to."
        : `${worst.name} is lowest at ${buyRate(worst)}%. Across all phases, ${sum(live.map((p) => p.soldLots))} of ${sum(live.map((p) => p.totalLots))} lots have gone.`,
    confidence: "observed",
    basis: "Lots no longer available, as a share of lots in each phase.",
  });

  if (live.length < 2 || best.phaseId === worst.phaseId) return out;

  // --- why ------------------------------------------------------------
  out.push(...diagnosePhaseGap(best, worst));

  // --- how long the slow one takes ------------------------------------
  out.push(...projectPhase(worst));

  // --- what to do -----------------------------------------------------
  out.push(...prescribeForPhases(best, worst));

  return out;
}

function diagnosePhaseGap(best: PhaseFacts, worst: PhaseFacts): Insight[] {
  const out: Insight[] = [];

  // A phase that is not open yet is not underperforming.
  if (worst.stage !== "live") {
    out.push({
      level: "diagnostic",
      topic: "phases",
      headline: `${worst.name} is ${worst.stage}, not selling badly.`,
      detail:
        "It is behind because it is not open, which is a schedule fact rather than a demand one. Comparing its buy rate to a live phase says nothing.",
      confidence: "indicative",
      basis: `Phase stage is "${worst.stage}".`,
    });
    return out;
  }

  if (
    worst.averagePriceCents > 0 &&
    best.averagePriceCents > 0 &&
    worst.averagePriceCents / best.averagePriceCents >= MATERIAL_GAP_RATIO
  ) {
    const gap = Math.round(
      (worst.averagePriceCents / best.averagePriceCents - 1) * 100,
    );
    out.push({
      level: "diagnostic",
      topic: "phases",
      headline: `${worst.name} is priced about ${gap}% above ${best.name}.`,
      detail:
        "Price is the readiest explanation for a slower phase, and the easiest to test — but families choose a garden for where it is and what it looks like as much as for what it costs. This is a lead, not a cause.",
      confidence: "indicative",
      basis: "Average list price per lot in each phase.",
    });
  }

  const bestRecent = best.soldInWindow;
  const worstRecent = worst.soldInWindow;
  if (worstRecent === 0 && bestRecent > 0) {
    out.push({
      level: "diagnostic",
      topic: "phases",
      headline: `Nothing has sold in ${worst.name} for ${worst.windowMonths} months.`,
      detail:
        "This is not a slow phase, it is a stopped one. A phase that sold before and has stopped is a different problem from one that never started, and it is worth knowing which this is before deciding anything.",
      confidence: "indicative",
      basis: `Contracts in the trailing ${worst.windowMonths} months, by phase.`,
    });
  }

  if (out.length === 0) {
    out.push({
      level: "diagnostic",
      topic: "phases",
      headline: "Nothing in this data explains the difference.",
      detail: `${worst.name} and ${best.name} are similarly priced and both still moving. Location, outlook and what the desk shows first are the usual causes, and none of them are numbers this system holds.`,
      confidence: "indicative",
      basis: "Price and recent sales are comparable between the two.",
    });
  }

  return out;
}

function projectPhase(worst: PhaseFacts): Insight[] {
  const perMonth = worst.soldInWindow / Math.max(1, worst.windowMonths);

  if (perMonth <= 0) {
    return [
      {
        level: "predictive",
        topic: "phases",
        headline: `${worst.name} has no rate to project from.`,
        detail:
          "Nothing sold in the window, so there is no sensible answer to how long it will take — not a long time, an unknown time. Something has to change before that question has an answer.",
        confidence: "speculative",
        basis: `Zero sales in the trailing ${worst.windowMonths} months.`,
      },
    ];
  }

  const months = Math.round(worst.availableLots / perMonth);
  const years = round1(months / 12);
  return [
    {
      level: "predictive",
      topic: "phases",
      headline: `At its current rate ${worst.name} takes about ${years} year${years === 1 ? "" : "s"} to sell out.`,
      detail: `${worst.availableLots} lots left, going at ${round1(perMonth)} a month. This assumes the rate holds, which over that span it will not — it is a way of seeing how far off the pace is, not a date.`,
      confidence:
        worst.windowMonths >= 6 && worst.soldInWindow >= MIN_MONTHS_TO_PROJECT
          ? "indicative"
          : "speculative",
      basis: `Sales in the trailing ${worst.windowMonths} months divided into remaining inventory.`,
    },
  ];
}

function prescribeForPhases(best: PhaseFacts, worst: PhaseFacts): Insight[] {
  const out: Insight[] = [];

  if (worst.stage !== "live") {
    out.push({
      level: "prescriptive",
      topic: "phases",
      headline: `Leave ${worst.name} out of the comparison until it opens.`,
      detail:
        "Judging an unopened parcel against a selling one produces a number that means nothing and a decision that follows it.",
      confidence: "observed",
      basis: `Phase stage is "${worst.stage}".`,
      action: "Check its readiness checklist on phase planning instead.",
    });
    return out;
  }

  if (
    worst.averagePriceCents > best.averagePriceCents &&
    worst.availableLots > 0
  ) {
    out.push({
      level: "prescriptive",
      topic: "phases",
      headline: `Try a promotion on ${worst.name} before cutting its price.`,
      detail:
        "A time-boxed offer tests whether price is the problem without permanently repricing the garden. If it moves lots, price was the cause; if it does not, the money was not lost and the answer is elsewhere.",
      confidence: "indicative",
      basis: "Higher average price and lower sell-through than the best phase.",
      action: `Set a promotion limited to ${worst.name} under Payment plans, with an end date.`,
    });
  }

  if (worst.soldInWindow === 0 && worst.availableLots > 0) {
    out.push({
      level: "prescriptive",
      topic: "phases",
      headline: `Ask the desk what they show a family first.`,
      detail: `${worst.name} has ${worst.availableLots} lots and sold none in ${worst.windowMonths} months. A garden that is never shown never sells, and that is a five-minute conversation rather than a pricing exercise.`,
      confidence: "indicative",
      basis: "No contracts against this phase in the window.",
      action: "Walk through the lot suggestion flow and see where it lands.",
    });
  }

  return out;
}

// --- helpers -----------------------------------------------------------

/** Share of a phase that is no longer available, as a whole percent. */
export function buyRate(p: PhaseFacts): number {
  if (p.totalLots <= 0) return 0;
  return Math.round((p.soldLots / p.totalLots) * 100);
}

function averageSale(a: AgentFacts): number {
  if (a.salesCount <= 0) return 0;
  return Math.round(a.soldValueCents / a.salesCount);
}

/** Commission as a share of what they sold — the rate they actually got. */
function effectiveRate(a: AgentFacts): number {
  if (a.soldValueCents <= 0) return 0;
  return (a.commissionCents / a.soldValueCents) * 100;
}

function sum(values: number[]): number {
  return values.reduce((t, n) => t + (Number.isFinite(n) ? n : 0), 0);
}

function round1(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}

/**
 * Pesos for a sentence, not for a payout.
 *
 * `src/lib/money.ts` owns display formatting, but it lives under `src/`
 * and the Convex bundler will not pull that across.
 */
function peso(cents: number): string {
  if (!Number.isFinite(cents)) return "₱0";
  return `₱${Math.round(cents / 100).toLocaleString("en-PH")}`;
}

// --- discounts ---------------------------------------------------------

/**
 * What a discount actually costs the park.
 *
 * ONLY the discretionary kind is counted here — the figure an operator
 * typed at the desk with a reason beside it. A cash plan that takes ten
 * per cent off, or a promotion the park is running deliberately, is
 * policy: it was decided once, by somebody with the authority, and
 * reporting it as leakage would put a staffer's name against a decision
 * the park itself made.
 *
 * That distinction is not cosmetic. The whole value of this section is
 * that it points somewhere, and pointing at the wrong person is worse
 * than pointing nowhere.
 */
export interface DiscountLine {
  key: string;
  label: string;
  /** Contracts written, discounted or not. */
  contracts: number;
  discountedContracts: number;
  /** Sum of the pre-discount price on the discounted ones. */
  listCents: number;
  discountCents: number;
}

export interface DiscountFacts {
  windowMonths: number;
  totalContracts: number;
  discountedContracts: number;
  totalDiscountCents: number;
  /** Pre-discount value of the contracts that carried one. */
  discountedListCents: number;
  byAgent: DiscountLine[];
  bySection: DiscountLine[];
  /** Reasons given, grouped by the exact words typed. */
  reasons: Array<{ reason: string; count: number; discountCents: number }>;
  /** Contracts sold under a plan or promotion — policy, not leakage. */
  policyContracts: number;
}

/** Below this many contracts, a discount rate is not a pattern. */
export const MIN_CONTRACTS_TO_JUDGE_DISCOUNTS = 5;

/**
 * A reason typed this often is a policy in disguise.
 *
 * Three of the same sentence is a habit; once is a decision about one
 * family. The point of flagging it is to move it into the price book,
 * where it is controlled and reported — not to stop it.
 */
export const REPEATED_REASON_THRESHOLD = 3;

export function analyseDiscounts(facts: DiscountFacts): Insight[] {
  const out: Insight[] = [];

  if (facts.totalContracts === 0) {
    return [
      {
        level: "descriptive",
        topic: "discounts",
        headline: "No contracts in the window to read.",
        detail:
          "Discounts are measured against contracts written in the last twelve months.",
        confidence: "observed",
        basis: "Contracts created inside the analytics window.",
      },
    ];
  }

  const share = Math.round(
    (facts.discountedContracts / facts.totalContracts) * 100,
  );
  const rate = rateOf(facts.discountedListCents, facts.totalDiscountCents);

  out.push({
    level: "descriptive",
    topic: "discounts",
    headline:
      facts.discountedContracts === 0
        ? "No discretionary discounts were given."
        : `${peso(facts.totalDiscountCents)} was given away at the desk.`,
    detail:
      facts.discountedContracts === 0
        ? `None of the ${facts.totalContracts} contracts in the window carried a discount typed at the counter. Any relief given came from a payment plan or a promotion, which is policy rather than discretion.`
        : `${facts.discountedContracts} of ${facts.totalContracts} contracts (${share}%) carried one, averaging ${round1(rate)}% off the price. This counts only discounts entered by hand — a plan's cash terms and a promotion are policy, and are not in this figure.`,
    confidence: "observed",
    basis: `The discount recorded on each contract, over ${facts.windowMonths} months.`,
  });

  if (facts.discountedContracts === 0) return out;

  out.push(...diagnoseDiscountSpread(facts));

  const repeated = facts.reasons.filter(
    (r) => r.count >= REPEATED_REASON_THRESHOLD,
  );
  if (repeated.length > 0) {
    const top = repeated[0]!;
    out.push({
      level: "diagnostic",
      topic: "discounts",
      headline: `The same reason keeps being typed: "${top.reason}".`,
      detail: `${top.count} contracts carry it, worth ${peso(top.discountCents)}. A discount given that consistently is not discretion, it is a policy nobody has written down — which means it is not capped, not reported as policy, and not necessarily the same amount every time.`,
      confidence: "indicative",
      basis: `Identical discount reasons across ${facts.discountedContracts} discounted contracts.`,
    });
  }

  out.push(...projectDiscounts(facts));
  out.push(...prescribeForDiscounts(facts, repeated));

  return out;
}

function diagnoseDiscountSpread(facts: DiscountFacts): Insight[] {
  const out: Insight[] = [];

  const judgeable = facts.byAgent.filter(
    (a) => a.contracts >= MIN_CONTRACTS_TO_JUDGE_DISCOUNTS,
  );

  if (judgeable.length < 2) {
    out.push({
      level: "diagnostic",
      topic: "discounts",
      headline: "Not enough contracts per seller to say who discounts most.",
      detail: `Comparing discount habits needs at least ${MIN_CONTRACTS_TO_JUDGE_DISCOUNTS} contracts each. Below that a single generous sale looks like a pattern — and this is a report that puts a name against money given away.`,
      confidence: "observed",
      basis: `${facts.byAgent.length} sellers in the window, ${judgeable.length} with ${MIN_CONTRACTS_TO_JUDGE_DISCOUNTS} or more contracts.`,
    });
  } else {
    const ranked = [...judgeable].sort(
      (a, b) =>
        rateOf(b.listCents, b.discountCents) -
        rateOf(a.listCents, a.discountCents),
    );
    const most = ranked[0]!;
    const least = ranked[ranked.length - 1]!;
    const mostRate = rateOf(most.listCents, most.discountCents);
    const leastRate = rateOf(least.listCents, least.discountCents);

    if (mostRate - leastRate >= 2) {
      out.push({
        level: "diagnostic",
        topic: "discounts",
        headline: `${most.label} discounts hardest — ${round1(mostRate)}% against ${least.label}'s ${round1(leastRate)}%.`,
        detail: `Over ${most.contracts} contracts that is ${peso(most.discountCents)}. It may have been the right call every time; it may also be a habit nobody has questioned, because each one looked small on its own.`,
        confidence: "indicative",
        basis: "Discount as a share of pre-discount value, per seller.",
      });
    } else {
      out.push({
        level: "diagnostic",
        topic: "discounts",
        headline: "Everybody discounts about the same amount.",
        detail:
          "No seller stands out. That usually means the discounting is driven by what families ask for rather than by who is at the desk — a pricing question rather than a personnel one.",
        confidence: "indicative",
        basis: "Discount rates within two points of each other across sellers.",
      });
    }
  }

  const sections = facts.bySection.filter(
    (row) => row.contracts >= MIN_CONTRACTS_TO_JUDGE_DISCOUNTS,
  );
  if (sections.length >= 2) {
    const ranked = [...sections].sort(
      (a, b) =>
        rateOf(b.listCents, b.discountCents) -
        rateOf(a.listCents, a.discountCents),
    );
    const worst = ranked[0]!;
    const cheapest = ranked[ranked.length - 1]!;
    const worstRate = rateOf(worst.listCents, worst.discountCents);
    const bestRate = rateOf(cheapest.listCents, cheapest.discountCents);
    if (worstRate - bestRate >= 3) {
      out.push({
        level: "diagnostic",
        topic: "discounts",
        headline: `${worst.label} needs the most money off to sell — ${round1(worstRate)}% on average.`,
        detail:
          "A garden that only moves with a discount is usually priced above what families think it is worth. That is a list-price question, and answering it once is cheaper than answering it at every counter.",
        confidence: "indicative",
        basis: "Discount rate by garden, across sellers.",
      });
    }
  }

  return out;
}

function projectDiscounts(facts: DiscountFacts): Insight[] {
  if (facts.windowMonths <= 0) return [];
  const perMonth = facts.totalDiscountCents / facts.windowMonths;
  const enough = facts.discountedContracts >= MIN_CONTRACTS_TO_JUDGE_DISCOUNTS;

  return [
    {
      level: "predictive",
      topic: "discounts",
      headline: `At this rate, roughly ${peso(perMonth * 12)} a year.`,
      detail: enough
        ? "Straight arithmetic on the last twelve months. It assumes the same mix of families, the same prices and the same habits at the desk — the size of the number is the point here, not its precision."
        : `Based on only ${facts.discountedContracts} discounted contracts, so read it as an order of magnitude rather than a total.`,
      confidence: enough ? "indicative" : "speculative",
      basis: `${peso(facts.totalDiscountCents)} over ${facts.windowMonths} months.`,
    },
  ];
}

function prescribeForDiscounts(
  facts: DiscountFacts,
  repeated: Array<{ reason: string; count: number; discountCents: number }>,
): Insight[] {
  const out: Insight[] = [];

  if (repeated.length > 0) {
    const top = repeated[0]!;
    out.push({
      level: "prescriptive",
      topic: "discounts",
      headline: `Turn "${top.reason}" into a payment plan or a promotion.`,
      detail:
        "A discount the park gives routinely belongs in the price book, where it is the same amount every time, shows on every quote, and reports as policy rather than as somebody's discretion. Nothing is taken away from families by doing it — it just stops being invisible.",
      confidence: "indicative",
      basis: `${top.count} contracts carrying the same typed reason.`,
      action: "Add it under Payment plans, then watch this figure fall.",
    });
  }

  const rate = rateOf(facts.discountedListCents, facts.totalDiscountCents);
  if (rate >= 10) {
    out.push({
      level: "prescriptive",
      topic: "discounts",
      headline: `Discounts average ${round1(rate)}% — worth setting a ceiling.`,
      detail:
        "There is a cap on total relief in the settings, and it is a backstop rather than a policy. Lowering it makes the desk ask before going past it, which is a conversation rather than a refusal.",
      confidence: "indicative",
      basis: "Average discount as a share of pre-discount value.",
      action: "Review the maximum discount in the cemetery's settings.",
    });
  }

  if (facts.policyContracts === 0 && facts.discountedContracts > 0) {
    out.push({
      level: "prescriptive",
      topic: "discounts",
      headline: "Every discount so far was typed by hand.",
      detail:
        "No sale used a payment plan or a promotion. If the park does have standard terms — a cash discount, an instalment option — putting them in the price book means the desk stops re-deciding them one family at a time.",
      confidence: "observed",
      basis: "Contracts with no payment plan or promotion recorded.",
      action: "Set up the park's standard terms under Payment plans.",
    });
  }

  return out;
}

/** A discount as a share of the pre-discount price, as a percentage. */
function rateOf(listCents: number, discountCents: number): number {
  if (listCents <= 0) return 0;
  return (discountCents / listCents) * 100;
}
