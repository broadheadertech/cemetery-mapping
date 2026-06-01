/**
 * Dashboard counter summary maintenance — Story 5.2 adversarial-review
 * follow-up (AC5, NFR-P4 / NFR-P5).
 *
 * Helpers that keep the `dashboardCountersByLotStatus` /
 * `dashboardCountersByContractState` summary docs in sync with the
 * underlying `lots` / `contracts` tables. The dashboard's
 * `getDashboardKpis` query reads the summary docs in O(1) so the lot
 * inventory + contract snapshot tiles never need a full-table scan,
 * even at Phase 2 scale (~2,000 lots × N reactive subscribers).
 *
 * Three call sites:
 *
 *   - `convex/lots.ts → createLot` increments the new status counter.
 *   - `convex/lots.ts → updateLot` is a no-op here (the mutation rejects
 *     `status`/`isRetired` writes; status writes route through
 *     `transitionLotStatus`).
 *   - `convex/lots.ts → retireLot` decrements the (no-longer-counted)
 *     prior status counter.
 *   - `convex/lib/stateMachines.ts → transitionLotStatus` shifts the
 *     count from the old status to the new.
 *   - Contract create paths (`recordFullPaymentSale`,
 *     `recordInstallmentSale`) increment the new state counter +
 *     accumulate `totalPriceCents`.
 *   - `convex/lib/stateMachines.ts → transitionContractState` shifts
 *     the count + totals between two state buckets.
 *
 * Bootstrap path:
 *   On a fresh deployment the summary tables are empty. `getDashboardKpis`
 *   detects the empty state, calls `recomputeAllCountersOnce` to do a
 *   one-time recomputation (single scan of each table), and populates
 *   the summary docs so subsequent loads stay fast. The recomputation
 *   is idempotent and re-runnable from `npx convex run` if the summary
 *   docs ever drift.
 *
 * Money discipline: `totalPriceCentsSum` is integer centavos. Updates
 * use plain arithmetic (defended at the call sites against negative /
 * non-integer values by Convex's schema validator); the running sums
 * are bounded by Number.MAX_SAFE_INTEGER (~₱90 trillion) — well above
 * any plausible single-cemetery AR balance.
 */

import { type DataModelFromSchemaDefinition } from "convex/server";

import schema from "../schema";
import type { MutationCtx } from "./auth";
import type { ContractState, LotStatus } from "./states";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractDoc = DataModel["contracts"]["document"];
type LotDoc = DataModel["lots"]["document"];

/**
 * Bump (or initialise) the lot-status counter for `status` by `delta`
 * (typically +1 / −1). When the row does not yet exist, this function
 * creates it at `count: max(delta, 0)` — a defensive floor that avoids
 * persisting a negative count if the bootstrap path missed a row.
 */
export async function bumpLotStatusCounter(
  ctx: MutationCtx,
  status: LotStatus,
  delta: number,
): Promise<void> {
  const existing = await ctx.db
    .query("dashboardCountersByLotStatus")
    .withIndex("by_key", (q) => q.eq("key", status))
    .first();
  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("dashboardCountersByLotStatus", {
      key: status,
      count: Math.max(0, delta),
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(existing._id, {
    count: Math.max(0, existing.count + delta),
    updatedAt: now,
  });
}

/**
 * Bump (or initialise) the contract-state counter for `state` by
 * `countDelta` (typically +1 / −1) AND `totalDelta` (the contract's
 * `totalPriceCents`, signed). Both counters move together because the
 * AR balance tile reads `totalPriceCentsSum` for `(active,
 * in_default)`; keeping count + sum in lockstep avoids a "phantom AR"
 * window where the count and total diverge mid-mutation.
 */
export async function bumpContractStateCounter(
  ctx: MutationCtx,
  state: ContractState,
  countDelta: number,
  totalDelta: number,
): Promise<void> {
  const existing = await ctx.db
    .query("dashboardCountersByContractState")
    .withIndex("by_key", (q) => q.eq("key", state))
    .first();
  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("dashboardCountersByContractState", {
      key: state,
      count: Math.max(0, countDelta),
      totalPriceCentsSum: Math.max(0, totalDelta),
      updatedAt: now,
    });
    return;
  }
  await ctx.db.patch(existing._id, {
    count: Math.max(0, existing.count + countDelta),
    totalPriceCentsSum: Math.max(0, existing.totalPriceCentsSum + totalDelta),
    updatedAt: now,
  });
}

/**
 * Shift the lot-status counter from `from` to `to`. Convenience wrapper
 * around two `bumpLotStatusCounter` calls; used by
 * `transitionLotStatus` so the state machine doesn't need to repeat the
 * +1/-1 dance inline.
 */
export async function shiftLotStatusCounter(
  ctx: MutationCtx,
  from: LotStatus,
  to: LotStatus,
): Promise<void> {
  if (from === to) return;
  await bumpLotStatusCounter(ctx, from, -1);
  await bumpLotStatusCounter(ctx, to, +1);
}

/**
 * Shift the contract-state counter (and the matching
 * `totalPriceCentsSum`) from `from` to `to`. Used by
 * `transitionContractState` so the state machine doesn't repeat the
 * paired bump dance inline.
 */
export async function shiftContractStateCounter(
  ctx: MutationCtx,
  from: ContractState,
  to: ContractState,
  totalPriceCents: number,
): Promise<void> {
  if (from === to) return;
  await bumpContractStateCounter(ctx, from, -1, -totalPriceCents);
  await bumpContractStateCounter(ctx, to, +1, +totalPriceCents);
}

/**
 * Counter snapshot shape consumed by the dashboard's bootstrap path.
 * Mirrors the eight numbers the dashboard tile needs to render after
 * a recompute; deliberately small so the bootstrap return value stays
 * a fixed-shape object.
 */
export interface DashboardCounterSnapshot {
  lotsByStatus: Record<LotStatus, number>;
  contractsByState: Record<
    ContractState,
    { count: number; totalPriceCentsSum: number }
  >;
}

/**
 * One-time bootstrap recomputation. Walks both source tables, computes
 * the canonical counts, and upserts the summary rows.
 *
 * Called by `getDashboardKpis` ONLY when the summary tables are empty
 * (e.g. fresh deploy). After this runs once, the per-mutation helpers
 * keep the summary docs current without ever scanning the source
 * tables again. The function is idempotent — running it twice on the
 * same data yields the same summary rows.
 *
 * Retired lots are excluded from `lotsByStatus` to match the live
 * counter contract (`createLot` / `retireLot` / `transitionLotStatus`
 * all treat the retired flag as "remove from the inventory grid").
 */
export async function recomputeAllCountersOnce(
  ctx: MutationCtx,
): Promise<DashboardCounterSnapshot> {
  const lots = (await ctx.db.query("lots").collect()) as LotDoc[];
  const lotsByStatus: Record<LotStatus, number> = {
    available: 0,
    reserved: 0,
    sold: 0,
    occupied: 0,
    cancelled: 0,
    defaulted: 0,
    transferred: 0,
  };
  for (const lot of lots) {
    if (lot.isRetired) continue;
    lotsByStatus[lot.status] += 1;
  }

  const contracts = (await ctx.db.query("contracts").collect()) as ContractDoc[];
  const contractsByState: Record<
    ContractState,
    { count: number; totalPriceCentsSum: number }
  > = {
    active: { count: 0, totalPriceCentsSum: 0 },
    paid_in_full: { count: 0, totalPriceCentsSum: 0 },
    in_default: { count: 0, totalPriceCentsSum: 0 },
    cancelled: { count: 0, totalPriceCentsSum: 0 },
    voided: { count: 0, totalPriceCentsSum: 0 },
  };
  for (const contract of contracts) {
    const acc = contractsByState[contract.state];
    acc.count += 1;
    acc.totalPriceCentsSum += contract.totalPriceCents;
  }

  const now = Date.now();

  // Upsert lot-status rows.
  for (const key of Object.keys(lotsByStatus) as LotStatus[]) {
    const existing = await ctx.db
      .query("dashboardCountersByLotStatus")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing === null) {
      await ctx.db.insert("dashboardCountersByLotStatus", {
        key,
        count: lotsByStatus[key],
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        count: lotsByStatus[key],
        updatedAt: now,
      });
    }
  }

  // Upsert contract-state rows.
  for (const key of Object.keys(contractsByState) as ContractState[]) {
    const acc = contractsByState[key];
    const existing = await ctx.db
      .query("dashboardCountersByContractState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    if (existing === null) {
      await ctx.db.insert("dashboardCountersByContractState", {
        key,
        count: acc.count,
        totalPriceCentsSum: acc.totalPriceCentsSum,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        count: acc.count,
        totalPriceCentsSum: acc.totalPriceCentsSum,
        updatedAt: now,
      });
    }
  }

  return { lotsByStatus, contractsByState };
}
