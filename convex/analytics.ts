/**
 * Inventory analytics — how fast the ground is going, and how long it lasts.
 *
 * The financial side of this system is well covered: sales, collections,
 * expenses, net, AR aging, twelve-month trends. None of it answers the
 * question an owner of a memorial park actually loses sleep over, which
 * is not "how much did we take last month" but "how many years of
 * ground do we have left, and when do I have to start on the next
 * parcel".
 *
 * `convex/phasePlanning.ts` answers a version of that already — from
 * `monthlyAbsorption`, a number someone typed into a form. This module
 * measures the same rate from contracts that exist, then puts the two
 * side by side. The variance is the finding: a plan assuming three lots
 * a month in a park selling nine has a runway three times too long, and
 * survey and permits do not compress to make up the difference.
 *
 * Every figure here is a count of lots, never money. That is deliberate
 * — the money reports are elsewhere and better, and mixing the two
 * invites reading a peso trend as an inventory trend.
 */

import {
  type DataModelFromSchemaDefinition,
  queryGeneric,
} from "convex/server";

import schema from "./schema";
import { requireRole, type QueryCtx } from "./lib/auth";
import {
  comparePlanToMeasured,
  computeRunway,
  measureAbsorption,
  sellThroughPercent,
  type AbsorptionRate,
  type PlanVariance,
  type Runway,
} from "./lib/absorption";
import { computeTrailingMonthBounds } from "./trends";
import {
  analyseAgents,
  analysePhases,
  type AgentFacts,
  type Insight,
  type PhaseFacts,
} from "./lib/insights";
import { commissionStatus } from "./lib/commission";
import { readAppSettings } from "./reports";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type PhaseId = DataModel["phases"]["document"]["_id"];
type ContractId = DataModel["contracts"]["document"]["_id"];

/** A year of history — long enough to see a season, short enough to be current. */
export const ANALYTICS_WINDOW_MONTHS = 12;

/**
 * Contract states that consume inventory.
 *
 * A voided or cancelled contract released the lot back to the shelf, so
 * counting it would report ground as sold that is standing empty and
 * available. `in_default` DOES count: the lot is still held, the family
 * still has a claim, and it is not on sale.
 */
const CONSUMING_STATES = new Set(["active", "paid_in_full", "in_default"]);

export interface MonthPoint {
  /** "YYYY-MM", Manila. */
  month: string;
  lotsSold: number;
  interments: number;
}

export interface SectionRow {
  section: string;
  total: number;
  available: number;
  reserved: number;
  sold: number;
  occupied: number;
  sellThroughPercent: number;
}

export interface PhaseCheck {
  phaseId: PhaseId;
  number: number;
  name: string;
  stage: string;
  plannedPerMonth: number;
  variance: PlanVariance;
}

export interface InventoryAnalytics {
  windowMonths: number;
  series: MonthPoint[];

  totalLots: number;
  availableLots: number;
  reservedLots: number;
  /** Contracted, nobody interred yet. */
  soldLots: number;
  /**
   * Someone is buried here. Read against `soldLots`: a park at 600 sold
   * and 120 occupied has several hundred interments still ahead of it,
   * which is a staffing and care-cost fact the money reports do not
   * carry.
   */
  occupiedLots: number;
  retiredLots: number;

  absorption: AbsorptionRate;
  runway: Runway;
  sellThroughPercent: number;

  /** Gardens, worst sell-through last. */
  sections: SectionRow[];

  /** Every live phase's assumed rate, checked against the measured one. */
  phaseChecks: PhaseCheck[];

  intermentsInWindow: number;
  generatedAtMs: number;
}

/**
 * The four levels, over the two questions the park asked for: which
 * agents earn most and least, and which phases sell fastest and
 * slowest.
 *
 * A separate query from the inventory one because it is a separate
 * question and a heavier read — it walks contracts and their
 * collections. A screen that only wants the runway should not pay for
 * this.
 */
export interface AnalysisResult {
  agents: Insight[];
  phases: Insight[];
  /** The facts the agent findings were computed from, for the table. */
  agentFacts: AgentFacts[];
  /** The facts the phase findings were computed from, for the table. */
  phaseFacts: PhaseFacts[];
  windowMonths: number;
  generatedAtMs: number;
}

/**
 * The whole picture, in one query.
 *
 * Deliberately one call rather than five: the figures are read together
 * and must agree with each other. Five queries settling at five
 * different moments would let someone read a runway computed from an
 * inventory count that no longer matches the section table below it.
 */
export const getInventoryAnalytics = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<InventoryAnalytics> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const now = Date.now();
    const buckets = computeTrailingMonthBounds(now, ANALYTICS_WINDOW_MONTHS);
    const windowStart = buckets[0]?.startMs ?? now;
    const windowEnd = buckets[buckets.length - 1]?.endMs ?? now;

    // --- inventory ---------------------------------------------------
    //
    // One scan, same as `phasePlanning` does at this scale (~2k lots).
    const lots = await ctx.db.query("lots").collect();

    let totalLots = 0;
    let availableLots = 0;
    let reservedLots = 0;
    let soldLots = 0;
    let occupiedLots = 0;
    let retiredLots = 0;
    const bySection = new Map<string, SectionRow>();

    for (const lot of lots) {
      if (lot.isRetired) {
        retiredLots += 1;
        continue;
      }
      totalLots += 1;

      let row = bySection.get(lot.section);
      if (row === undefined) {
        row = {
          section: lot.section,
          total: 0,
          available: 0,
          reserved: 0,
          sold: 0,
          occupied: 0,
          sellThroughPercent: 0,
        };
        bySection.set(lot.section, row);
      }
      row.total += 1;

      switch (lot.status) {
        case "available":
          availableLots += 1;
          row.available += 1;
          break;
        case "reserved":
          reservedLots += 1;
          row.reserved += 1;
          break;
        case "sold":
          soldLots += 1;
          row.sold += 1;
          break;
        case "occupied":
          occupiedLots += 1;
          row.occupied += 1;
          break;
        default:
          // cancelled / defaulted / transferred sit in `total` but in
          // none of the four buckets. They are neither on sale nor
          // occupied, and quietly folding them into "available" would
          // overstate what there is to sell.
          break;
      }
    }

    // --- what sold, month by month -----------------------------------
    const contracts = await ctx.db
      .query("contracts")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", windowStart).lt("createdAt", windowEnd),
      )
      .collect();

    // Distinct lots per month. A lot with two contracts in one month
    // (a correction, a re-paper) consumed one lot of inventory, not two.
    const lotsSoldPerMonth = buckets.map(() => new Set<string>());
    for (const c of contracts) {
      if (!CONSUMING_STATES.has(c.state)) continue;
      const i = bucketIndexOf(buckets, c.createdAt);
      if (i === -1) continue;
      lotsSoldPerMonth[i]?.add(c.lotId);
    }
    const monthlySales = lotsSoldPerMonth.map((s) => s.size);

    // --- interments, month by month ----------------------------------
    const interments = await ctx.db
      .query("interments")
      .withIndex("by_scheduledAt", (q) =>
        q.gte("scheduledAt", windowStart).lt("scheduledAt", windowEnd),
      )
      .collect();

    const monthlyInterments = buckets.map(() => 0);
    let intermentsInWindow = 0;
    for (const it of interments) {
      // Cancelled interments never happened; counting them would
      // overstate the work the crew actually did.
      if (it.status === "cancelled") continue;
      const i = bucketIndexOf(buckets, it.scheduledAt);
      if (i === -1) continue;
      monthlyInterments[i] = (monthlyInterments[i] ?? 0) + 1;
      intermentsInWindow += 1;
    }

    const series: MonthPoint[] = buckets.map((b, i) => ({
      month: b.monthLabel,
      lotsSold: monthlySales[i] ?? 0,
      interments: monthlyInterments[i] ?? 0,
    }));

    // --- the numbers that matter -------------------------------------
    const absorption = measureAbsorption(monthlySales);
    const runway = computeRunway(availableLots, absorption.perMonth);

    for (const row of bySection.values()) {
      row.sellThroughPercent = sellThroughPercent(row.total, row.available);
    }
    // Slowest movers last, so the gardens needing attention are the ones
    // you scroll to rather than the ones you scroll past.
    const sections = [...bySection.values()].sort(
      (a, b) => b.sellThroughPercent - a.sellThroughPercent,
    );

    // --- the plan, checked -------------------------------------------
    const phases = await ctx.db
      .query("phases")
      .withIndex("by_number")
      .collect();
    const phaseChecks: PhaseCheck[] = phases
      .filter((p) => !p.isRetired)
      .sort((a, b) => a.number - b.number)
      .map((p) => ({
        phaseId: p._id,
        number: p.number,
        name: p.name,
        stage: p.stage,
        plannedPerMonth: p.monthlyAbsorption,
        variance: comparePlanToMeasured(p.monthlyAbsorption, absorption),
      }));

    return {
      windowMonths: ANALYTICS_WINDOW_MONTHS,
      series,
      totalLots,
      availableLots,
      reservedLots,
      soldLots,
      occupiedLots,
      retiredLots,
      absorption,
      runway,
      sellThroughPercent: sellThroughPercent(totalLots, availableLots),
      sections,
      phaseChecks,
      intermentsInWindow,
      generatedAtMs: now,
    };
  },
});

/** Which trailing-month bucket a timestamp falls in, or -1. */
function bucketIndexOf(
  buckets: ReadonlyArray<{ startMs: number; endMs: number }>,
  ms: number,
): number {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    if (ms >= b.startMs && ms < b.endMs) return i;
  }
  return -1;
}

/**
 * The four levels, read off real contracts.
 *
 * Admin-only. It names individual agents beside what they earn, which
 * is a payroll-shaped view even though every figure in it is already
 * elsewhere in the system.
 */
export const getAnalysis = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<AnalysisResult> => {
    await requireRole(ctx, ["admin"]);

    const now = Date.now();
    const buckets = computeTrailingMonthBounds(now, ANALYTICS_WINDOW_MONTHS);
    const windowStart = buckets[0]?.startMs ?? now;
    const windowEnd = buckets[buckets.length - 1]?.endMs ?? now;

    const { commissionEarnedAtPercent } = await readAppSettings(ctx);
    const contracts = await ctx.db.query("contracts").collect();

    // --- agents ------------------------------------------------------
    const agents = await ctx.db.query("salesAgents").collect();
    const byAgent = new Map<string, AgentFacts>();
    for (const a of agents) {
      byAgent.set(a._id, {
        agentId: a._id,
        name: a.fullName,
        isSystem: a.isSystem === true,
        salesCount: 0,
        soldValueCents: 0,
        commissionCents: 0,
        commissionDueCents: 0,
        commissionNotDueCents: 0,
        activeMonths: 1,
      });
    }

    // First and last sale per agent, to measure how long they have
    // actually been selling. An agent who joined in September has three
    // months of history, not twelve, and averaging over twelve would
    // divide their rate by four.
    const span = new Map<string, { first: number; last: number }>();

    for (const c of contracts) {
      if (c.salesAgentId === undefined) continue;
      const facts = byAgent.get(c.salesAgentId);
      if (facts === undefined) continue;

      facts.salesCount += 1;
      facts.soldValueCents += c.totalPriceCents;
      facts.commissionCents += c.commissionCents ?? 0;

      const seen = span.get(c.salesAgentId);
      span.set(c.salesAgentId, {
        first: Math.min(seen?.first ?? c.createdAt, c.createdAt),
        last: Math.max(seen?.last ?? c.createdAt, c.createdAt),
      });

      if ((c.commissionCents ?? 0) > 0) {
        const paidCents = await sumInstallmentsPaid(ctx, c);
        const status = commissionStatus({
          contractState: c.state,
          contractTotalCents: c.totalPriceCents,
          paidCents,
          commissionCents: c.commissionCents ?? 0,
          earnedAtPercent: commissionEarnedAtPercent,
          ...(c.commissionPaidOutAt !== undefined
            ? { paidOutAt: c.commissionPaidOutAt }
            : {}),
        });
        if (status.state === "due" || status.state === "paid") {
          facts.commissionDueCents += status.commissionCents;
        } else if (status.state === "not_due") {
          facts.commissionNotDueCents += status.commissionCents;
        }
      }
    }

    for (const [agentId, s] of span) {
      const facts = byAgent.get(agentId);
      if (facts === undefined) continue;
      const months = Math.round((s.last - s.first) / (30 * 24 * 3600 * 1000));
      facts.activeMonths = Math.max(1, months + 1);
    }

    const agentFacts = [...byAgent.values()].sort(
      (a, b) => b.commissionCents - a.commissionCents,
    );

    // --- phases ------------------------------------------------------
    const lots = await ctx.db.query("lots").collect();
    const phases = (await ctx.db.query("phases").collect()).filter(
      (p) => !p.isRetired,
    );

    // Which phase a lot belongs to, by section name. A lot in no phase
    // is left out rather than assigned to one — guessing would make a
    // phase look busier than it is.
    const phaseOfSection = new Map<string, string>();
    for (const p of phases) {
      for (const name of p.sectionNames ?? []) {
        phaseOfSection.set(name, p._id);
      }
    }

    const soldInWindowByPhase = new Map<string, number>();
    const lotPhase = new Map<string, string>();
    for (const lot of lots) {
      const phaseId = phaseOfSection.get(lot.section);
      if (phaseId !== undefined) lotPhase.set(lot._id, phaseId);
    }
    for (const c of contracts) {
      if (c.createdAt < windowStart || c.createdAt >= windowEnd) continue;
      if (!CONSUMING_STATES.has(c.state)) continue;
      const phaseId = lotPhase.get(c.lotId);
      if (phaseId === undefined) continue;
      soldInWindowByPhase.set(
        phaseId,
        (soldInWindowByPhase.get(phaseId) ?? 0) + 1,
      );
    }

    const phaseFacts: PhaseFacts[] = phases
      .sort((a, b) => a.number - b.number)
      .map((p) => {
        const names = new Set(p.sectionNames ?? []);
        const mine = lots.filter(
          (l) => !l.isRetired && names.has(l.section),
        );
        const available = mine.filter((l) => l.status === "available").length;
        const priceTotal = mine.reduce((t, l) => t + l.basePriceCents, 0);
        return {
          phaseId: p._id,
          number: p.number,
          name: p.name,
          stage: p.stage,
          totalLots: mine.length,
          availableLots: available,
          soldLots: Math.max(0, mine.length - available),
          soldInWindow: soldInWindowByPhase.get(p._id) ?? 0,
          windowMonths: ANALYTICS_WINDOW_MONTHS,
          averagePriceCents:
            mine.length > 0 ? Math.round(priceTotal / mine.length) : 0,
        };
      });

    return {
      agents: analyseAgents(agentFacts),
      phases: analysePhases(phaseFacts),
      agentFacts,
      phaseFacts,
      windowMonths: ANALYTICS_WINDOW_MONTHS,
      generatedAtMs: now,
    };
  },
});

/**
 * What has been collected against a contract.
 *
 * Mirrors `convex/salesAgents.ts` — instalment rows where they exist,
 * and the whole price for a full-payment contract, which has none by
 * construction.
 */
async function sumInstallmentsPaid(
  ctx: QueryCtx,
  contract: { _id: ContractId; state: string; totalPriceCents: number },
): Promise<number> {
  const installments = await ctx.db
    .query("installments")
    .withIndex("by_contract", (q) => q.eq("contractId", contract._id))
    .collect();
  if (installments.length > 0) {
    return installments.reduce((t, i) => t + i.paidCents, 0);
  }
  return contract.state === "paid_in_full" ? contract.totalPriceCents : 0;
}
