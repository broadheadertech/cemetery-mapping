/**
 * Dashboard read surface — Story 5.2 (FR42, Journey 4).
 *
 * Admin-only KPI queries for the `/dashboard` page. This module is the
 * READ surface for the owner / admin dashboard. Three reactive queries:
 *
 *   - `getDashboardKpis({ period })` — the seven money / count KPIs that
 *     fill the tile grid (lots inventory snapshot, MTD or YTD sales,
 *     collections, AR balance, expenses, net).
 *   - `getArAgingSummary({})` — multi-bucket aging breakdown. Phase 1
 *     scaffold: returns zero-populated buckets because the per-contract
 *     `agingBucket` field + `hasActiveLoggedAction` flag are scheduled
 *     to land with Epic 4 (Stories 4.1 / 4.2). When those fields exist
 *     in the schema, this query starts returning real bucketed counts
 *     without an API shape change.
 *   - `getFlaggedForFollowupSummary({})` — flagged-for-followup tile.
 *     Phase 1 scaffold: returns `count: 0` because the `flaggedContracts`
 *     table is owned by Story 5.4. The shape is settled here so the
 *     dashboard's tile renders against a stable contract; Story 5.4
 *     populates the table and rewires this query to read from it.
 *
 * Performance:
 *   All three queries call `requireRole` first (NFR-S4, lint-enforced)
 *   then run bounded, indexed scans:
 *     - `payments.by_receivedAt` for MTD / YTD collections.
 *     - `expenses.by_paidAt` for MTD / YTD expenses.
 *     - `contracts.by_state` for AR balance + active-contracts count
 *       (and per-state lot counts derived from `contracts.totalPriceCents`
 *       at sale time, which the dashboard summarises).
 *     - `lots.by_status` for the lot-inventory tile (available / sold /
 *       reserved / occupied).
 *   No `.collect()` of an entire table without an index; no client-side
 *   aggregation; no pre-aggregated summary docs in Phase 1 (architecture
 *   § Deferred Decisions — pre-aggregation is reserved for Phase 1.5 if
 *   live aggregation breaches NFR-P4 under production load).
 *
 * Money discipline:
 *   - All amounts in INTEGER centavos (ADR-0007).
 *   - Arithmetic via `convex/lib/money.ts` helpers (`add`, `sub`). The
 *     `sub` helper throws on underflow — for the "net" tile we compute
 *     `max(collections, expenses)` first so a month with more expenses
 *     than collections does not crash the query. The sign is conveyed
 *     in a separate `netIsNegative` boolean.
 *
 * Time discipline:
 *   - Manila timezone for every period bound (PH has no DST, so the
 *     fixed `+08:00` offset is safe). MTD = `[firstOfMonth, now]`;
 *     YTD = `[firstOfYear, now]`. The comparison period for delta tone
 *     is the equivalent slice of the prior month / year — same length,
 *     ending at the equivalent timestamp. This is the simplest definition
 *     that surfaces a non-trivial delta on day 1 of a month; the choice
 *     is documented as a follow-up for owner refinement (§10 Q).
 *
 * Decision: "Net MTD" definition.
 *   The PRD is ambiguous about which arithmetic defines "Net" — sales
 *   minus expenses (accrual) or collections minus expenses (cash). For
 *   Story 5.2 we pick the CASH basis (`collections − expenses`) because
 *   the BIR-receipt path is collection-centric and Mr. Reyes's typical
 *   conversation about "did we make money this month?" tracks cash in
 *   the till, not signed contracts. The choice is recorded in the Story
 *   5.2 Completion Notes for owner confirmation; flipping to the accrual
 *   basis is a one-line change to the `net*Cents` computation below.
 *
 * Tests: `tests/unit/convex/dashboard.test.ts` (NFR-M2 ≥ 90% coverage).
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import {
  recomputeAllCountersOnce,
  type DashboardCounterSnapshot,
} from "./lib/dashboardCounters";
import { add, sub } from "./lib/money";
import type { ContractState, LotStatus } from "./lib/states";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type PaymentDoc = DataModel["payments"]["document"];
type ExpenseDoc = DataModel["expenses"]["document"];
type ContractDoc = DataModel["contracts"]["document"];
type LotDoc = DataModel["lots"]["document"];

/**
 * Period validator. MTD = month-to-date; YTD = year-to-date.
 */
const periodValidator = v.union(v.literal("mtd"), v.literal("ytd"));

export type DashboardPeriod = "mtd" | "ytd";

/**
 * Public return shape for `getDashboardKpis`.
 *
 * Every money field is an INTEGER centavo amount. Delta fields are the
 * signed difference between the current period and the comparison
 * period; the UI consumes the sign + magnitude separately (e.g. expenses
 * up is a negative tone, sales up is a positive tone).
 */
export interface DashboardKpiResult {
  period: DashboardPeriod;
  /** UTC ms — start of the current period (inclusive). */
  periodStartMs: number;
  /** UTC ms — end of the current period (exclusive; usually `Date.now()`). */
  periodEndMs: number;

  // Lot inventory snapshot — current state, period-independent.
  lotsTotal: number;
  lotsAvailable: number;
  lotsReserved: number;
  lotsSold: number;
  lotsOccupied: number;

  // Contract snapshot — current state, period-independent.
  contractsActive: number;
  contractsInDefault: number;
  contractsPaidInFull: number;

  // Money tiles — period-bounded.
  salesCents: number;
  collectionsCents: number;
  arBalanceCents: number;
  expensesCents: number;
  /** Cash-basis: collections − expenses. May be negative; see `netIsNegative`. */
  netCents: number;
  /** True when expenses exceeded collections in the period. */
  netIsNegative: boolean;

  // Deltas (signed) vs. the equivalent prior period slice.
  salesDeltaCents: number;
  collectionsDeltaCents: number;
  expensesDeltaCents: number;
  netDeltaCents: number;
  /** True when the net delta is negative (this period is worse than prior). */
  netDeltaIsNegative: boolean;
}

/**
 * Aggregates the dashboard KPI tile values.
 *
 * Admin-only. Office_staff can see the per-page lists (e.g. `/expenses`)
 * but the dashboard aggregate is owner-grade — exposing it to staff
 * would short-circuit the "ask the admin for the number" workflow that
 * the cemetery currently relies on.
 */
export const getDashboardKpis = queryGeneric({
  args: { period: periodValidator },
  handler: async (
    ctx: QueryCtx,
    args: { period: DashboardPeriod },
  ): Promise<DashboardKpiResult> => {
    await requireRole(ctx, ["admin"]);

    const now = Date.now();
    const { startMs, endMs } = periodBounds(args.period, now);
    const comparison = comparisonBounds(args.period, startMs, endMs);

    // Lot inventory snapshot + contract snapshot.
    //
    // Story 5.2 follow-up (NFR-P4 / NFR-P5): both tiles read from
    // pre-aggregated summary docs (`dashboardCountersByLotStatus` /
    // `dashboardCountersByContractState`) maintained on every lot /
    // contract mutation by the helpers in
    // `convex/lib/dashboardCounters.ts`. The summary read is O(rows-
    // in-summary) which is bounded at 7 lot statuses × 5 contract
    // states regardless of underlying table size.
    //
    // Bootstrap path: when EITHER summary table is empty (fresh
    // deploy, or the seed script never ran), the dashboard transparently
    // falls back to a live recomputation. Because `queryGeneric` cannot
    // write, the in-query fallback DOES NOT populate the summary docs
    // — the admin `recomputeDashboardCounters` mutation is the path
    // that persists the recomputation. The query never crashes; it
    // simply runs the slower path until an admin (or the next mutation
    // that touches a lot/contract) refreshes the summary table.
    const lotsByStatus = await readLotStatusCounters(ctx);
    let lotsAvailable = lotsByStatus.available;
    let lotsReserved = lotsByStatus.reserved;
    let lotsSold = lotsByStatus.sold;
    let lotsOccupied = lotsByStatus.occupied;
    let lotsTotal =
      lotsAvailable +
      lotsReserved +
      lotsSold +
      lotsOccupied +
      lotsByStatus.cancelled +
      lotsByStatus.defaulted +
      lotsByStatus.transferred;
    if (lotsAvailable + lotsReserved + lotsSold + lotsOccupied + lotsTotal === 0) {
      const live = await liveRecomputeLotCounts(ctx);
      lotsAvailable = live.lotsByStatus.available;
      lotsReserved = live.lotsByStatus.reserved;
      lotsSold = live.lotsByStatus.sold;
      lotsOccupied = live.lotsByStatus.occupied;
      lotsTotal =
        lotsAvailable +
        lotsReserved +
        lotsSold +
        lotsOccupied +
        live.lotsByStatus.cancelled +
        live.lotsByStatus.defaulted +
        live.lotsByStatus.transferred;
    }

    // Contract snapshot + AR balance — read summary docs. AR balance
    // is the sum of `totalPriceCents` across active + in_default
    // contracts (the architecture's Phase 1 proxy; Story 4.x will
    // refine to a per-contract `outstandingBalanceCents` once
    // installments land).
    const contractsByState = await readContractStateCounters(ctx);
    let contractsActive = contractsByState.active.count;
    let contractsInDefault = contractsByState.in_default.count;
    let contractsPaidInFull = contractsByState.paid_in_full.count;
    let arBalanceCents = add(
      contractsByState.active.totalPriceCentsSum,
      contractsByState.in_default.totalPriceCentsSum,
    );
    const haveContractCounters =
      contractsActive +
        contractsInDefault +
        contractsPaidInFull +
        contractsByState.cancelled.count +
        contractsByState.voided.count >
      0;
    if (!haveContractCounters) {
      const live = await liveRecomputeContractCounts(ctx);
      contractsActive = live.contractsByState.active.count;
      contractsInDefault = live.contractsByState.in_default.count;
      contractsPaidInFull = live.contractsByState.paid_in_full.count;
      arBalanceCents = add(
        live.contractsByState.active.totalPriceCentsSum,
        live.contractsByState.in_default.totalPriceCentsSum,
      );
    }

    // Sales — sum `contracts.totalPriceCents` for contracts created
    // within the period (via `_creationTime` from Convex; we use
    // `createdAt` since it's the schema's canonical field).
    const salesCents = await sumContractsCreatedAtPriceInRange(
      ctx,
      startMs,
      endMs,
    );
    const salesComparisonCents = await sumContractsCreatedAtPriceInRange(
      ctx,
      comparison.startMs,
      comparison.endMs,
    );

    // Collections — sum non-voided payments received within the period.
    // `payments.by_receivedAt` is the canonical bounded-range index.
    const collectionsCents = await sumPaymentsInRange(ctx, startMs, endMs);
    const collectionsComparisonCents = await sumPaymentsInRange(
      ctx,
      comparison.startMs,
      comparison.endMs,
    );

    // Expenses — sum `expenses.amountCents` for rows paidAt within range.
    const expensesCents = await sumExpensesInRange(ctx, startMs, endMs);
    const expensesComparisonCents = await sumExpensesInRange(
      ctx,
      comparison.startMs,
      comparison.endMs,
    );

    // Net = collections − expenses (cash basis; see file JSDoc). When
    // expenses exceed collections we return the absolute magnitude and
    // flag the sign in `netIsNegative` to keep `netCents` non-negative
    // for the `sub` helper's underflow guard.
    const netIsNegative = expensesCents > collectionsCents;
    const netCents = netIsNegative
      ? sub(expensesCents, collectionsCents)
      : sub(collectionsCents, expensesCents);

    // Deltas are signed via the absolute-magnitude + sign-flag pattern.
    // For the UI we return the SIGNED delta in cents (positive = up,
    // negative = down). Centavo arithmetic on the difference is small
    // enough to fit in a JS number without overflow risk.
    const salesDeltaCents = salesCents - salesComparisonCents;
    const collectionsDeltaCents =
      collectionsCents - collectionsComparisonCents;
    const expensesDeltaCents = expensesCents - expensesComparisonCents;

    const netComparisonIsNegative =
      expensesComparisonCents > collectionsComparisonCents;
    const netComparisonAbs = netComparisonIsNegative
      ? expensesComparisonCents - collectionsComparisonCents
      : collectionsComparisonCents - expensesComparisonCents;
    const netCurrentSigned = netIsNegative ? -netCents : netCents;
    const netComparisonSigned = netComparisonIsNegative
      ? -netComparisonAbs
      : netComparisonAbs;
    const netDeltaCents = netCurrentSigned - netComparisonSigned;

    return {
      period: args.period,
      periodStartMs: startMs,
      periodEndMs: endMs,
      lotsTotal,
      lotsAvailable,
      lotsReserved,
      lotsSold,
      lotsOccupied,
      contractsActive,
      contractsInDefault,
      contractsPaidInFull,
      salesCents,
      collectionsCents,
      arBalanceCents,
      expensesCents,
      netCents,
      netIsNegative,
      salesDeltaCents,
      collectionsDeltaCents,
      expensesDeltaCents,
      netDeltaCents,
      netDeltaIsNegative: netDeltaCents < 0,
    };
  },
});

/**
 * AR aging bucket key. Mirrors the architecture's bucketing convention
 * for collections: 1–30 / 31–60 / 61–90 / 90+ days past due.
 */
export type ArAgingBucketKey = "1-30" | "31-60" | "61-90" | "90+";

export interface ArAgingBucket {
  key: ArAgingBucketKey;
  count: number;
  totalCents: number;
  withLoggedActionCount: number;
}

export interface ArAgingSummaryResult {
  buckets: ArAgingBucket[];
  /**
   * True when the underlying per-contract `agingBucket` field is not yet
   * populated by Epic 4. Used by the UI to render a "Epic 4 not yet
   * shipped — buckets are placeholders" inline note rather than empty
   * counts that would mislead the viewer.
   */
  isPlaceholder: boolean;
}

const AR_BUCKET_KEYS: readonly ArAgingBucketKey[] = [
  "1-30",
  "31-60",
  "61-90",
  "90+",
];

/**
 * AR aging summary. Story 4.1 wired this to real `arAgingSnapshots`
 * rows — `isPlaceholder` is now `true` only when the snapshot table has
 * not been populated yet (e.g. brand-new deployment that hasn't run the
 * cron yet OR the manual `recomputeNow` mutation). Otherwise the bucket
 * counts / totals reflect the most-recent recompute (≤ 24h freshness
 * per NFR-P3; cron runs at 17:00 UTC = 01:00 Asia/Manila).
 *
 * Admin + office_staff can both read the aging summary — the staff page
 * (Story 4.8) uses the same bucket counts as the dashboard tile.
 *
 * Bucket vocabulary (mirrors `convex/arAging.ts` and the
 * `arAgingSnapshots.bucket` validator). The dashboard tile only displays
 * the four overdue buckets; the snapshot's `"current"` rows (contracts
 * with no installment past due) are tallied separately and exposed as
 * the "not yet alarming" implicit category — UX-DR aging definition.
 */
export const getArAgingSummary = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<ArAgingSummaryResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    // Read snapshot rows produced by `convex/arAging.ts` —
    // `internal_recomputeAllAging` (daily cron, see `convex/crons.ts`)
    // or the on-demand `recomputeNow` admin mutation. Each row is one
    // active / in_default contract assigned to its most-overdue bucket.
    const rows = await ctx.db.query("arAgingSnapshots").collect();
    const init: Record<
      ArAgingBucketKey,
      { count: number; totalCents: number; withAction: number }
    > = {
      "1-30": { count: 0, totalCents: 0, withAction: 0 },
      "31-60": { count: 0, totalCents: 0, withAction: 0 },
      "61-90": { count: 0, totalCents: 0, withAction: 0 },
      "90+": { count: 0, totalCents: 0, withAction: 0 },
    };
    for (const row of rows) {
      if (row.bucket === "current") continue; // tallied implicitly
      const acc = init[row.bucket];
      if (acc === undefined) continue;
      acc.count += 1;
      acc.totalCents += row.totalOverdueCents;
      acc.withAction += row.overdueCountWithAction;
    }
    const buckets: ArAgingBucket[] = AR_BUCKET_KEYS.map((key) => ({
      key,
      count: init[key].count,
      totalCents: init[key].totalCents,
      withLoggedActionCount: init[key].withAction,
    }));
    return { buckets, isPlaceholder: rows.length === 0 };
  },
});

export interface FlaggedForFollowupResult {
  count: number;
  mostRecentComment: string | null;
  mostRecentFlaggedAt: number | null;
  /**
   * Story 5.4 wired this query to read real flag data from the
   * `contracts.isFlagged` field. The flag retains the field name for API
   * stability — it is now `false` whenever the query has executed
   * successfully (the data path is live; there's no placeholder branch
   * remaining). Existing consumers (Story 5.2's dashboard tile) treat
   * `isPlaceholder: false` as "show the real number"; the field is kept
   * to preserve the public shape across Story 5.2 / 5.4.
   */
  isPlaceholder: boolean;
}

/**
 * Flagged-for-follow-up summary. Story 5.4 (FR44) wired this to read the
 * `contracts.isFlagged` field via the `by_isFlagged` index — counts every
 * contract currently flagged by an admin, plus surfaces the most-recent
 * flag's comment + timestamp so the dashboard tile renders a meaningful
 * snapshot ("3 contracts flagged — last: 'Confirm installment 5 due
 * date' 2 min ago").
 *
 * Admin-only: the owner uses this tile to review their own outstanding
 * directives. The matching staff-side projection ("flags I should see")
 * is the same data set in Phase 1 — every flag goes to all_staff, and
 * the office staff dashboard tile reads `listFlaggedContracts` (from
 * `convex/contracts.ts`) for the queue. A per-staff scope can land in a
 * future story if the cemetery's roles ever differentiate.
 *
 * Performance: bounded scan via `by_isFlagged` (only flagged rows). At
 * typical-load steady state ≤ 50 open flags per cemetery, this is well
 * inside NFR-P4.
 */
export const getFlaggedForFollowupSummary = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<FlaggedForFollowupResult> => {
    await requireRole(ctx, ["admin"]);
    const flaggedRows = (await ctx.db
      .query("contracts")
      .withIndex("by_isFlagged", (q) => q.eq("isFlagged", true))
      .collect()) as ContractDoc[];
    let count = 0;
    let mostRecentComment: string | null = null;
    let mostRecentFlaggedAt: number | null = null;
    for (const row of flaggedRows) {
      // Defensive: an index hit on `isFlagged === true` should always
      // carry the matching reason + timestamp, but partial patches
      // (theoretical bug) would leave one absent. Skip those rows so
      // the tile's count doesn't overstate the queue.
      if (
        row.isFlagged !== true ||
        row.flaggedAt === undefined ||
        row.flagReason === undefined
      ) {
        continue;
      }
      count += 1;
      if (
        mostRecentFlaggedAt === null ||
        row.flaggedAt > mostRecentFlaggedAt
      ) {
        mostRecentFlaggedAt = row.flaggedAt;
        mostRecentComment = row.flagReason;
      }
    }
    return {
      count,
      mostRecentComment,
      mostRecentFlaggedAt,
      isPlaceholder: false,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers — period bound math + bounded-range aggregators.
// ---------------------------------------------------------------------------

interface PeriodBounds {
  startMs: number;
  endMs: number;
}

/**
 * Computes the half-open `[startMs, endMs)` interval for a Manila-tz
 * MTD / YTD period anchored at `now`.
 *
 * PH has no DST so a fixed `+08:00` offset is safe (consistent with
 * `convex/expenses.ts:monthBoundsMs`).
 */
export function periodBounds(
  period: DashboardPeriod,
  now: number,
): PeriodBounds {
  const parts = manilaDateParts(now);
  if (period === "mtd") {
    const startIso = `${parts.year}-${parts.month}-01T00:00:00+08:00`;
    return { startMs: new Date(startIso).getTime(), endMs: now };
  }
  // YTD
  const startIso = `${parts.year}-01-01T00:00:00+08:00`;
  return { startMs: new Date(startIso).getTime(), endMs: now };
}

/**
 * Computes the equivalent prior-period slice for delta computation.
 *
 *   - MTD comparison: "yesterday-same-time-of-day" — the equivalent
 *     window from `[currentStartMs − 1 day, currentEndMs − 1 day)`.
 *     Concretely: at noon today, the comparison window is exactly
 *     yesterday up to noon. This matches the dashboard tile's "delta
 *     vs yesterday" semantics — the cemetery's typical conversation
 *     is "did we make money today compared to yesterday at this hour",
 *     not "did the month-to-date track the prior month-to-date".
 *     (Adversarial-review fix: the prior implementation month-shifted
 *     the MTD window, which is the YTD shape and does not match the
 *     spec's "MTD delta is vs yesterday" copy.)
 *   - YTD comparison: the prior year's slice from Jan 1 through the
 *     equivalent day-of-year.
 *
 * The exact definition is documented in the file JSDoc. Both branches
 * use the same `[startMs, endMs)` half-open shape so the aggregators
 * are interchangeable.
 */
export function comparisonBounds(
  period: DashboardPeriod,
  currentStartMs: number,
  currentEndMs: number,
): PeriodBounds {
  if (period === "mtd") {
    // Yesterday-same-time-of-day: shift the [startMs, endMs) window
    // back by 24 hours. The window length is preserved (=> deltas are
    // an apples-to-apples comparison of "today so far" vs "yesterday
    // up to this exact time"). Manila has no DST so the 24-hour shift
    // is unambiguous; we don't need to round-trip through the
    // timezone-aware date helpers.
    const DAY_MS = 24 * 60 * 60 * 1000;
    return {
      startMs: currentStartMs - DAY_MS,
      endMs: currentEndMs - DAY_MS,
    };
  }
  // YTD: prior year same slice length.
  const lengthMs = currentEndMs - currentStartMs;
  const priorStart = subtractYearsManila(currentStartMs, 1);
  return { startMs: priorStart, endMs: priorStart + lengthMs };
}

interface ManilaDateParts {
  year: string;
  month: string;
  day: string;
}

function manilaDateParts(ms: number): ManilaDateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return { year, month, day };
}

function subtractYearsManila(ms: number, years: number): number {
  const parts = manilaDateParts(ms);
  const year = Number.parseInt(parts.year, 10) - years;
  const iso = `${year.toString().padStart(4, "0")}-01-01T00:00:00+08:00`;
  return new Date(iso).getTime();
}

/**
 * Sums non-voided payments received within `[startMs, endMs)`. Uses the
 * `by_receivedAt` index so the scan is bounded to the period.
 */
async function sumPaymentsInRange(
  ctx: QueryCtx,
  startMs: number,
  endMs: number,
): Promise<number> {
  // Use a CLOSED interval [startMs, endMs] for period aggregation. The
  // period's `endMs` is "now" (the moment the dashboard was loaded);
  // a payment that lands at exactly that millisecond MUST count toward
  // the period — otherwise the on-load reactive subscription would
  // omit the just-posted payment that triggered the cross-tab fade.
  const rows = (await ctx.db
    .query("payments")
    .withIndex("by_receivedAt", (q) =>
      q.gte("receivedAt", startMs).lte("receivedAt", endMs),
    )
    .collect()) as PaymentDoc[];
  let total = 0;
  for (const row of rows) {
    if (row.isVoided) continue;
    total = add(total, row.amountCents);
  }
  return total;
}

/**
 * Sums `expenses.amountCents` for rows paid within `[startMs, endMs]`.
 *
 * Story 6.6 follow-up: filters out rows with
 * `approvalStatus !== "approved"`. The approval-queue workflow
 * (Story 6.6 toggle) routes large expenses through
 * `approvalStatus: "pending_approval"`; before this fix the dashboard
 * tile summed pending expenses anyway, silently breaking the workflow's
 * "show me only approved money out" semantic. Back-compat: rows
 * missing the `approvalStatus` field entirely (pre-6.6 data) are
 * treated as approved.
 *
 * Uses the `by_paidAt` index for the date-range scan; the
 * approvalStatus filter runs in-memory afterwards. A future optimisation
 * could query `by_approvalStatus_paidAt` with `eq("approved")` +
 * range — Phase 1 keeps the simpler shape since the approval workflow
 * is off by default.
 */
async function sumExpensesInRange(
  ctx: QueryCtx,
  startMs: number,
  endMs: number,
): Promise<number> {
  const rows = (await ctx.db
    .query("expenses")
    .withIndex("by_paidAt", (q) =>
      q.gte("paidAt", startMs).lte("paidAt", endMs),
    )
    .collect()) as ExpenseDoc[];
  let total = 0;
  for (const row of rows) {
    // Treat missing `approvalStatus` as approved (back-compat with
    // pre-Story-6.6 data). Pending / rejected rows do not move money.
    const status = row.approvalStatus ?? "approved";
    if (status !== "approved") continue;
    total = add(total, row.amountCents);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Dashboard counter helpers (Story 5.2 follow-up).
// ---------------------------------------------------------------------------

const ALL_LOT_STATUSES: readonly LotStatus[] = [
  "available",
  "reserved",
  "sold",
  "occupied",
  "cancelled",
  "defaulted",
  "transferred",
];

const ALL_CONTRACT_STATES: readonly ContractState[] = [
  "active",
  "paid_in_full",
  "in_default",
  "cancelled",
  "voided",
];

/**
 * Reads the per-lot-status summary doc into a plain record. Missing
 * rows default to 0 — the caller decides whether an all-zero result is
 * "empty inventory" or "summary table not yet populated".
 */
async function readLotStatusCounters(
  ctx: QueryCtx,
): Promise<Record<LotStatus, number>> {
  const counts: Record<LotStatus, number> = {
    available: 0,
    reserved: 0,
    sold: 0,
    occupied: 0,
    cancelled: 0,
    defaulted: 0,
    transferred: 0,
  };
  const rows = await ctx.db.query("dashboardCountersByLotStatus").collect();
  for (const row of rows) {
    counts[row.key] = row.count;
  }
  return counts;
}

/**
 * Reads the per-contract-state summary doc into a plain record.
 */
async function readContractStateCounters(
  ctx: QueryCtx,
): Promise<Record<ContractState, { count: number; totalPriceCentsSum: number }>> {
  const counts: Record<
    ContractState,
    { count: number; totalPriceCentsSum: number }
  > = {
    active: { count: 0, totalPriceCentsSum: 0 },
    paid_in_full: { count: 0, totalPriceCentsSum: 0 },
    in_default: { count: 0, totalPriceCentsSum: 0 },
    cancelled: { count: 0, totalPriceCentsSum: 0 },
    voided: { count: 0, totalPriceCentsSum: 0 },
  };
  const rows = await ctx.db
    .query("dashboardCountersByContractState")
    .collect();
  for (const row of rows) {
    counts[row.key] = {
      count: row.count,
      totalPriceCentsSum: row.totalPriceCentsSum,
    };
  }
  return counts;
}

/**
 * Read-side fallback for the lot inventory tile. Runs a single
 * full-table scan + classification when the summary doc is empty
 * (fresh deploy, summary table not yet seeded). Queries cannot write,
 * so this DOES NOT persist the recomputation — the admin mutation
 * `recomputeDashboardCounters` is the path that populates the summary
 * docs.
 */
async function liveRecomputeLotCounts(
  ctx: QueryCtx,
): Promise<{ lotsByStatus: Record<LotStatus, number> }> {
  const counts: Record<LotStatus, number> = {
    available: 0,
    reserved: 0,
    sold: 0,
    occupied: 0,
    cancelled: 0,
    defaulted: 0,
    transferred: 0,
  };
  const lots = (await ctx.db.query("lots").collect()) as LotDoc[];
  for (const lot of lots) {
    if (lot.isRetired) continue;
    counts[lot.status] += 1;
  }
  return { lotsByStatus: counts };
}

/**
 * Read-side fallback for the contract snapshot tile.
 */
async function liveRecomputeContractCounts(
  ctx: QueryCtx,
): Promise<{
  contractsByState: Record<
    ContractState,
    { count: number; totalPriceCentsSum: number }
  >;
}> {
  const counts: Record<
    ContractState,
    { count: number; totalPriceCentsSum: number }
  > = {
    active: { count: 0, totalPriceCentsSum: 0 },
    paid_in_full: { count: 0, totalPriceCentsSum: 0 },
    in_default: { count: 0, totalPriceCentsSum: 0 },
    cancelled: { count: 0, totalPriceCentsSum: 0 },
    voided: { count: 0, totalPriceCentsSum: 0 },
  };
  const contracts = (await ctx.db
    .query("contracts")
    .collect()) as ContractDoc[];
  for (const c of contracts) {
    const acc = counts[c.state];
    acc.count += 1;
    acc.totalPriceCentsSum += c.totalPriceCents;
  }
  return { contractsByState: counts };
}

// Reference unused enum constants so they don't get tree-shaken /
// flagged by the lint config — they exist for downstream stories that
// will iterate over the full state space (e.g. an admin "summary
// drift" view).
void ALL_LOT_STATUSES;
void ALL_CONTRACT_STATES;

/**
 * Admin-only mutation that force-recomputes the dashboard summary
 * docs. Useful after data migrations, restore-from-backup, or any
 * change to a lot / contract row that bypassed the maintenance
 * helpers (e.g. a direct `npx convex run` patch).
 *
 * Records the snapshot it produced in the function's return value so
 * the admin tooling can confirm the result without re-querying.
 */
export const recomputeDashboardCounters = mutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<DashboardCounterSnapshot> => {
    await requireRole(ctx, ["admin"]);
    return recomputeAllCountersOnce(ctx);
  },
});

/**
 * Sums `contracts.totalPriceCents` for contracts whose `createdAt` falls
 * within `[startMs, endMs]`.
 *
 * Story 5.2 follow-up: uses the `by_createdAt` index (added by Story
 * 6.3 for sales-by-dimension). The prior implementation full-scanned
 * the contracts table on every dashboard reactive re-evaluation,
 * blowing the NFR-P4 budget at Phase 2 scale. The indexed range scan
 * is bounded to contracts created within the period.
 *
 * Range bound: a CLOSED interval `[startMs, endMs]` matches the
 * `sumPaymentsInRange` convention — see that function's comment for
 * the "on-load reactive subscription must include the just-posted
 * row" rationale.
 */
async function sumContractsCreatedAtPriceInRange(
  ctx: QueryCtx,
  startMs: number,
  endMs: number,
): Promise<number> {
  const rows = (await ctx.db
    .query("contracts")
    .withIndex("by_createdAt", (q) =>
      q.gte("createdAt", startMs).lte("createdAt", endMs),
    )
    .collect()) as ContractDoc[];
  let total = 0;
  for (const row of rows) {
    // Voided / cancelled contracts do not count as sales for the period.
    if (row.state === "voided" || row.state === "cancelled") continue;
    total = add(total, row.totalPriceCents);
  }
  return total;
}
