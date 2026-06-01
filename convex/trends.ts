/**
 * Trend analysis — Story 9.9 (FR48).
 *
 * Admin-only Convex queries that return 12-month time-series buckets
 * powering the `/admin/trends` page. Three metrics are aggregated by
 * Manila-tz calendar month for the trailing 12 months ending at the
 * current month (inclusive):
 *
 *   - sales         — sum of `contracts.totalPriceCents` for contracts
 *                     created within each month, excluding voided and
 *                     cancelled rows. Mirrors the Story 5.2 dashboard's
 *                     `sumContractsCreatedAtPriceInRange` aggregation.
 *   - collections   — sum of non-voided `payments.amountCents` whose
 *                     `receivedAt` falls within the month. Mirrors the
 *                     dashboard's `sumPaymentsInRange` aggregation, and
 *                     uses the `payments.by_receivedAt` index for bounded
 *                     scans per month.
 *   - expenses      — sum of `expenses.amountCents` whose `paidAt` falls
 *                     within the month. Uses the `expenses.by_paidAt`
 *                     index for bounded scans.
 *   - net           — derived series: `collections − expenses` per
 *                     bucket (CASH BASIS), matching the Story 5.2
 *                     dashboard's "Net" tile semantics.
 *
 * Buckets are CALENDAR MONTHS in `Asia/Manila` — PH has no DST so a
 * fixed `+08:00` offset is safe (consistent with
 * `convex/dashboard.ts:periodBounds` and `convex/expenses.ts:monthBoundsMs`).
 * The trailing window is anchored at the FIRST day of the current
 * Manila month and walks back 11 months, yielding 12 buckets total.
 *
 * AR aging deltas (Story 9.9 brief reference):
 *   AR balance is a point-in-time snapshot, not a flow — computing a
 *   monthly AR series from raw history is O(contracts × months) and
 *   requires a per-day snapshot table we have not yet built. The
 *   trends page surfaces the CURRENT AR balance (sum of active +
 *   in_default `contracts.totalPriceCents`) alongside the time series
 *   so admins still see the AR magnitude; a true per-month AR delta
 *   series is deferred to a follow-up that owns the rollup table.
 *
 * Performance:
 *   For each of the 12 buckets we run ONE indexed range scan per
 *   metric (payments, expenses). For contracts we run TWO scans:
 *
 *     1. Sales partition — ONE indexed range scan against
 *        `contracts.by_createdAt` bounded by the trailing-12-month
 *        window. Rows outside the window never enter memory.
 *     2. AR balance snapshot — ONE full-table scan of `contracts`
 *        because AR is a point-in-time aggregate across all active /
 *        in_default rows regardless of `createdAt`. Bounding by the
 *        window would silently exclude older still-open contracts and
 *        understate AR. The full scan is acceptable at Phase 1 scale
 *        (~few hundred contracts/month per Story 5.2 dashboard JSDoc).
 *
 *   Both contract reads happen once per call, not per bucket; we
 *   partition the windowed rows into buckets after the indexed read.
 *
 * Money discipline:
 *   - All amounts in INTEGER centavos (ADR-0007).
 *   - Arithmetic uses the `add` helper from `convex/lib/money.ts` so
 *     non-integer drift fails loudly.
 *
 * Auth: admin only — same role gate as `convex/dashboard.ts`.
 *
 * Tests: `tests/unit/convex/trends.test.ts`.
 */

import {
  type DataModelFromSchemaDefinition,
  queryGeneric,
} from "convex/server";

import schema from "./schema";
import { requireRole, type QueryCtx } from "./lib/auth";
import { add } from "./lib/money";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractDoc = DataModel["contracts"]["document"];
type PaymentDoc = DataModel["payments"]["document"];
type ExpenseDoc = DataModel["expenses"]["document"];

/**
 * Number of trailing months returned by `getTrendData`. Includes the
 * current Manila month as bucket index 11 (last).
 */
export const TREND_BUCKET_COUNT = 12;

/**
 * One bucket in the trend series. `startMs` is the UTC ms timestamp of
 * the first instant of the bucket's Manila calendar month;
 * `monthLabel` is the canonical `YYYY-MM` string the UI uses as the
 * x-axis tick label (the renderer translates it to a friendlier
 * "May 2026" via `Intl.DateTimeFormat`).
 */
export interface TrendBucket {
  monthLabel: string;
  startMs: number;
  endMs: number;
  salesCents: number;
  collectionsCents: number;
  expensesCents: number;
  /** Cash-basis: collectionsCents − expensesCents. May be negative. */
  netCents: number;
}

export interface TrendDataResult {
  /** Trailing 12 calendar months ending with the current Manila month. */
  buckets: TrendBucket[];
  /**
   * Current AR balance snapshot in centavos — sum of
   * `contracts.totalPriceCents` for rows in state `active` or
   * `in_default`. Surfaced alongside the time series because AR is a
   * point-in-time snapshot, not a flow (see file JSDoc).
   */
  arBalanceCents: number;
  /**
   * UTC ms timestamp the buckets were generated at — the UI uses this
   * as the "last refreshed" marker.
   */
  generatedAtMs: number;
}

/**
 * Returns the trailing-12-month trend series for sales, collections,
 * expenses, and the derived net (collections − expenses) — plus the
 * current AR balance snapshot.
 *
 * Admin-only. Office staff use the per-domain list pages; the
 * aggregate trend surface is the owner-grade reporting tool.
 *
 * Side-effect-free reactive query: any payment / contract / expense
 * mutation reactively re-evaluates this query and the chart updates
 * without a manual refresh (NFR-P4 / FR48).
 */
export const getTrendData = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<TrendDataResult> => {
    await requireRole(ctx, ["admin"]);

    const now = Date.now();
    const bucketBounds = computeTrailingMonthBounds(now, TREND_BUCKET_COUNT);

    // Collections — one indexed range scan per bucket against
    // `payments.by_receivedAt`. We scan bucket-by-bucket (rather than
    // one global scan) so the index does the work; the per-bucket sums
    // accumulate as we go.
    const collectionsCentsByBucket: number[] = new Array(
      TREND_BUCKET_COUNT,
    ).fill(0);
    for (let i = 0; i < bucketBounds.length; i++) {
      const { startMs, endMs } = bucketBounds[i]!;
      const rows = (await ctx.db
        .query("payments")
        .withIndex("by_receivedAt", (q) =>
          q.gte("receivedAt", startMs).lt("receivedAt", endMs),
        )
        .collect()) as PaymentDoc[];
      let total = 0;
      for (const row of rows) {
        if (row.isVoided) continue;
        total = add(total, row.amountCents);
      }
      collectionsCentsByBucket[i] = total;
    }

    // Expenses — one indexed range scan per bucket against
    // `expenses.by_paidAt`. Mirrors the collections aggregator.
    const expensesCentsByBucket: number[] = new Array(
      TREND_BUCKET_COUNT,
    ).fill(0);
    for (let i = 0; i < bucketBounds.length; i++) {
      const { startMs, endMs } = bucketBounds[i]!;
      const rows = (await ctx.db
        .query("expenses")
        .withIndex("by_paidAt", (q) =>
          q.gte("paidAt", startMs).lt("paidAt", endMs),
        )
        .collect()) as ExpenseDoc[];
      let total = 0;
      for (const row of rows) {
        total = add(total, row.amountCents);
      }
      expensesCentsByBucket[i] = total;
    }

    // Sales — ONE indexed range scan against `contracts.by_createdAt`
    // bounded by the trailing-12-month window. Rows outside the window
    // never enter memory, so this is O(window-contracts) rather than
    // O(all-contracts).
    const salesCentsByBucket: number[] = new Array(TREND_BUCKET_COUNT).fill(0);
    const windowStartMs = bucketBounds[0]!.startMs;
    const windowEndMs = bucketBounds[bucketBounds.length - 1]!.endMs;
    const windowedContracts = (await ctx.db
      .query("contracts")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", windowStartMs).lt("createdAt", windowEndMs),
      )
      .collect()) as ContractDoc[];
    for (const row of windowedContracts) {
      // Sales partitioning — skip voided / cancelled rows.
      if (row.state === "voided" || row.state === "cancelled") continue;
      const bucketIndex = findBucketIndex(bucketBounds, row.createdAt);
      if (bucketIndex === -1) continue;
      salesCentsByBucket[bucketIndex] = add(
        salesCentsByBucket[bucketIndex]!,
        row.totalPriceCents,
      );
    }

    // AR balance — point-in-time snapshot across ALL active /
    // in_default contracts regardless of `createdAt`. This deliberately
    // ignores the trailing-12-month window: older still-open contracts
    // belong in AR too. Identical semantics to the dashboard's
    // `arBalanceCents` tile so the trends page and the dashboard agree
    // on the number. Full-table scan is acceptable at Phase 1 scale.
    let arBalanceCents = 0;
    const allContracts = (await ctx.db
      .query("contracts")
      .collect()) as ContractDoc[];
    for (const row of allContracts) {
      if (row.state === "active" || row.state === "in_default") {
        arBalanceCents = add(arBalanceCents, row.totalPriceCents);
      }
    }

    // Materialise the final bucket rows. `netCents` is signed (cash
    // basis) — the renderer formats negatives with a minus sign.
    const buckets: TrendBucket[] = bucketBounds.map((b, i) => ({
      monthLabel: b.monthLabel,
      startMs: b.startMs,
      endMs: b.endMs,
      salesCents: salesCentsByBucket[i]!,
      collectionsCents: collectionsCentsByBucket[i]!,
      expensesCents: expensesCentsByBucket[i]!,
      netCents:
        collectionsCentsByBucket[i]! - expensesCentsByBucket[i]!,
    }));

    return {
      buckets,
      arBalanceCents,
      generatedAtMs: now,
    };
  },
});

// ---------------------------------------------------------------------------
// Helpers — Manila-anchored month-boundary math + bucket lookup.
// ---------------------------------------------------------------------------

interface MonthBucketBounds {
  monthLabel: string; // "YYYY-MM"
  startMs: number; // inclusive
  endMs: number; // exclusive
}

/**
 * Computes the trailing `count` Manila calendar-month bucket bounds
 * ending at the month containing `now`. The result is ordered oldest →
 * newest so chart x-axes can render it left-to-right.
 *
 * Example for `now = 2026-05-15T12:00:00+08:00` and `count = 12`:
 *
 *   [0] = { monthLabel: "2025-06", startMs: 2025-06-01T00:00 Manila,
 *           endMs: 2025-07-01T00:00 Manila }
 *   ...
 *   [11] = { monthLabel: "2026-05", startMs: 2026-05-01T00:00 Manila,
 *            endMs: 2026-06-01T00:00 Manila }
 *
 * Exported for unit-test reuse.
 */
export function computeTrailingMonthBounds(
  now: number,
  count: number,
): MonthBucketBounds[] {
  if (!Number.isInteger(count) || count <= 0) {
    return [];
  }
  const parts = manilaDateParts(now);
  const currentYear = Number.parseInt(parts.year, 10);
  const currentMonth = Number.parseInt(parts.month, 10); // 1-12
  const result: MonthBucketBounds[] = [];
  // Walk back `count - 1` months from the current month so the current
  // month sits at the last position (index `count - 1`).
  for (let offset = count - 1; offset >= 0; offset--) {
    let m = currentMonth - offset;
    let y = currentYear;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    const monthLabel = `${y.toString().padStart(4, "0")}-${m
      .toString()
      .padStart(2, "0")}`;
    const startIso = `${monthLabel}-01T00:00:00+08:00`;
    const startMs = new Date(startIso).getTime();
    // End boundary = first instant of the FOLLOWING Manila month.
    let nextY = y;
    let nextM = m + 1;
    if (nextM === 13) {
      nextY += 1;
      nextM = 1;
    }
    const endIso = `${nextY.toString().padStart(4, "0")}-${nextM
      .toString()
      .padStart(2, "0")}-01T00:00:00+08:00`;
    const endMs = new Date(endIso).getTime();
    result.push({ monthLabel, startMs, endMs });
  }
  return result;
}

/**
 * Binary search the bucket array for the bucket containing `ms`.
 * Returns the index, or `-1` when no bucket contains the timestamp.
 * Bucket bounds are `[startMs, endMs)` (half-open) so the boundary
 * never double-counts.
 */
function findBucketIndex(buckets: MonthBucketBounds[], ms: number): number {
  // Linear scan is fine for `count = 12`; binary search would be
  // theoretical micro-optimisation. Kept simple for review clarity.
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    if (ms >= b.startMs && ms < b.endMs) return i;
  }
  return -1;
}

interface ManilaDateParts {
  year: string;
  month: string;
}

function manilaDateParts(ms: number): ManilaDateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return { year, month };
}
