/**
 * AR aging domain — Story 4.1 (FR34, NFR-P3).
 *
 * This file owns the AR aging surface end-to-end (helpers + internal
 * recompute mutation + public read queries). The companion file
 * `convex/crons.ts` registers the daily cron that drives the recompute.
 *
 * Why a single file (and not a `convex/lib/arAging.ts` helper split):
 * Story 4.1's strict file-ownership boundary blocks new files under
 * `convex/lib/**` (READ-ONLY in the dev contract). The helpers therefore
 * live alongside the public surface in `convex/arAging.ts`; the
 * `bucketFromDaysOverdue` / `pickMostOverdueBucket` pure functions are
 * exported so the test file can exercise them without going through the
 * mutation surface.
 *
 * Three call sites for the recompute helper:
 *   1. The daily cron (`convex/crons.ts` → `internal_recomputeAllAging`)
 *      iterates every active / in-default contract and dispatches one
 *      `internal_recomputeAgingForContractMutation` per contract.
 *   2. Story 4.2 (follow-up actions): after a follow-up action is
 *      created or expires, the calling mutation will dispatch this
 *      internal mutation for the touched contract so the snapshot row
 *      reflects the new `overdueCountWithAction` / `overdueCountSilent`
 *      split. Story 4.1 ships the hook; Story 4.2 wires the call sites.
 *   3. Manual replay via `npx convex run arAging:internal_recomputeAllAging`
 *      (for the runbook's "the cron missed last night" path).
 *
 * Pre-aggregation rationale (architecture § Tech Stack / § Design
 * Patterns): live aggregation over `installments` × `contracts` ×
 * `followUpActions` would not meet NFR-P3's dashboard-freshness budget
 * (≤ 1 day). The `arAgingSnapshots` table is the documented escape hatch.
 *
 * Disaster prevention (story § Hard stops):
 *   - The recompute helper NEVER writes to `payments` / `receipts` /
 *     `paymentAllocations` / `contracts.balance`. It is read-only over
 *     financial data and write-only over `arAgingSnapshots`. The Story
 *     3.2 `no-direct-financial-write` lint rule enforces this at build
 *     time.
 *   - Each contract appears in exactly ONE bucket (its most-overdue).
 *     Buckets sum to total AR; no double-counting.
 *   - Time math is integer millisecond arithmetic — never `new Date(...)`
 *     or `Date.parse(...)` in the helper body. Manila has no DST so a
 *     fixed `+08:00` cron is safe.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { DAY_MS } from "./lib/time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type SnapshotDoc = DataModel["arAgingSnapshots"]["document"];

/**
 * Bucket key. Matches the dashboard's `ArAgingBucketKey` union so the
 * snapshot rows and the dashboard summary share a single vocabulary.
 *
 * `"current"` is the not-yet-alarming bucket — every unpaid installment
 * for the contract is either not due yet OR less than 1 day past due.
 * The original Story 4.1 brief collapsed "1-30 days late" into
 * `"current"` because the UX only distinguished 30 / 60 / 90+; this
 * implementation follows the user's task contract instead (5 distinct
 * buckets: current / 1-30 / 31-60 / 61-90 / 90+) so the dashboard's
 * existing four-bucket display has a one-to-one mapping (the snapshot's
 * `"current"` rows are excluded from the dashboard tile and shown in the
 * "current" implicit category).
 */
export type ArAgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

const BUCKET_ORDER: readonly ArAgingBucket[] = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "90+",
];

/**
 * Pure classifier: turn a `daysOverdue` integer into a bucket label.
 *
 * Boundary conventions (story AC2):
 *   - `daysOverdue ≤ 0`     → `"current"` (paid on time / not yet due)
 *   - `1 ≤ d ≤ 30`          → `"1-30"`
 *   - `31 ≤ d ≤ 60`         → `"31-60"`
 *   - `61 ≤ d ≤ 90`         → `"61-90"`
 *   - `d > 90`              → `"90+"`
 *
 * The function is pure (no ctx, no time math beyond the input integer)
 * so the unit tests can exercise the boundary conditions exhaustively.
 */
export function bucketFromDaysOverdue(daysOverdue: number): ArAgingBucket {
  if (!Number.isFinite(daysOverdue) || daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
}

/**
 * Pure helper: pick the most-overdue bucket across a list of installments.
 *
 * Returns `"current"` when the list is empty or every installment is
 * still within its grace window. Bucket precedence order is documented
 * by `BUCKET_ORDER` above.
 *
 * Inputs intentionally narrow — accepts any object with `dueDate` and
 * (optionally) a `status` field. The helper considers an installment
 * "unpaid" when `status !== "paid"` (Story 3.4's installment lifecycle
 * names the paid state `"paid"`). A consumer passing already-filtered
 * unpaid rows can omit `status` entirely.
 */
export function pickMostOverdueBucket(
  installments: ReadonlyArray<{ dueDate: number; status?: string }>,
  nowMs: number,
): ArAgingBucket {
  let highest: ArAgingBucket = "current";
  let highestIdx = 0;
  for (const row of installments) {
    if (row.status === "paid" || row.status === "waived") continue;
    const days = Math.floor((nowMs - row.dueDate) / DAY_MS);
    const bucket = bucketFromDaysOverdue(days);
    const idx = BUCKET_ORDER.indexOf(bucket);
    if (idx > highestIdx) {
      highest = bucket;
      highestIdx = idx;
    }
  }
  return highest;
}

/**
 * Compute the snapshot fields for one contract.
 *
 * Returns the fields that get written to `arAgingSnapshots` (minus
 * `recomputedAt` which the caller stamps). Pure-ish: reads only the
 * `installments` table; never writes. The internal mutation below
 * wraps it with the upsert.
 */
async function computeContractAging(
  ctx: MutationCtx,
  contractId: ContractId,
  nowMs: number,
): Promise<{
  bucket: ArAgingBucket;
  totalOverdueCents: number;
  overdueCountSilent: number;
  overdueCountWithAction: number;
  oldestDueDate: number | undefined;
} | null> {
  const contract = await ctx.db.get(contractId);
  if (contract === null) return null;
  // Only `active` or `in_default` contracts produce snapshots. Cancelled,
  // voided, transferred, paid_in_full all skip.
  if (contract.state !== "active" && contract.state !== "in_default") {
    return null;
  }
  const rows = await ctx.db
    .query("installments")
    .withIndex("by_contract", (q) => q.eq("contractId", contractId))
    .collect();

  const unpaid = rows.filter(
    (r) => r.status !== "paid" && r.status !== "waived",
  );

  let totalOverdueCents = 0;
  let overdueCountSilent = 0;
  let overdueCountWithAction = 0;
  let oldestDueDate: number | undefined;
  for (const row of unpaid) {
    const daysOverdue = Math.floor((nowMs - row.dueDate) / DAY_MS);
    if (daysOverdue > 0) {
      // Outstanding past-due principal = principalCents - paidCents.
      // Integer subtraction; clamp at zero in case of any accounting
      // drift (defense in depth — Story 3.9's allocator should keep
      // paidCents ≤ principalCents).
      const remaining = row.principalCents - row.paidCents;
      if (remaining > 0) totalOverdueCents += remaining;
      // Epic 4 H1 fix: split silent vs. with-logged-action by checking
      // for an OPEN follow-up on this installment. Only `open` counts —
      // expired/completed/cancelled follow-ups leave the installment
      // "silent" so the alarm re-surfaces (the whole point of Story 4.3's
      // expiry sweep). This is the FR34 "X overdue, Y% with logged
      // follow-up" signal; hardcoding it to 0 made the dashboard always
      // report zero coverage while the drill-down table showed the truth.
      const followUps = await ctx.db
        .query("followUpActions")
        .withIndex("by_installment", (q) => q.eq("installmentId", row._id))
        .collect();
      if (followUps.some((f) => f.status === "open")) {
        overdueCountWithAction += 1;
      } else {
        overdueCountSilent += 1;
      }
      if (oldestDueDate === undefined || row.dueDate < oldestDueDate) {
        oldestDueDate = row.dueDate;
      }
    }
  }

  const bucket = pickMostOverdueBucket(unpaid, nowMs);

  return {
    bucket,
    totalOverdueCents,
    overdueCountSilent,
    overdueCountWithAction,
    oldestDueDate,
  };
}

/**
 * Internal-only mutation: upsert the snapshot row for one contract.
 *
 * Exempt from `require-role-first-line` (internal mutations have no
 * user context). Wraps `computeContractAging` with the
 * upsert-via-by_contract-index pattern; idempotent — calling twice in
 * succession produces identical row contents (modulo `recomputedAt`).
 *
 * Why an internal mutation per contract (rather than batching the loop
 * in a single action): Convex actions cannot write to the DB directly.
 * Wrapping the per-contract recompute in its own mutation also gives us
 * per-contract atomicity — a failed contract write rolls back only that
 * contract's snapshot, not the whole cron run.
 *
 * Internal action: invoked by the cron and Story 4.2's follow-up
 * mutations; no user context to authenticate.
 */
export const internal_recomputeAgingForContractMutation =
  internalMutationGeneric({
    args: { contractId: v.id("contracts") },
    handler: async (
      ctx: MutationCtx,
      args: { contractId: ContractId },
    ): Promise<void> => {
      const nowMs = Date.now();
      const computed = await computeContractAging(ctx, args.contractId, nowMs);
      if (computed === null) {
        // Contract is not active / in-default. Drop the snapshot row if
        // one exists so the dashboard stops counting a contract that
        // transitioned to paid_in_full or cancelled.
        const stale = await ctx.db
          .query("arAgingSnapshots")
          .withIndex("by_contract", (q) =>
            q.eq("contractId", args.contractId),
          )
          .first();
        if (stale !== null) {
          await ctx.db.delete(stale._id);
        }
        return;
      }
      const existing = await ctx.db
        .query("arAgingSnapshots")
        .withIndex("by_contract", (q) =>
          q.eq("contractId", args.contractId),
        )
        .first();
      const row = {
        contractId: args.contractId,
        bucket: computed.bucket,
        totalOverdueCents: computed.totalOverdueCents,
        overdueCountWithAction: computed.overdueCountWithAction,
        overdueCountSilent: computed.overdueCountSilent,
        ...(computed.oldestDueDate !== undefined
          ? { oldestDueDate: computed.oldestDueDate }
          : {}),
        recomputedAt: nowMs,
      };
      if (existing === null) {
        await ctx.db.insert("arAgingSnapshots", row);
      } else {
        await ctx.db.patch(existing._id, row);
      }
    },
  });

/**
 * Internal mutation: recompute every active / in_default contract.
 *
 * Designed to be invoked from the cron (`convex/crons.ts`) AND from a
 * manual replay (`npx convex run arAging:internal_recomputeAllAging`).
 *
 * Convex actions can't do DB writes directly — but a cron-scheduled
 * internal mutation CAN do DB work, and at Phase 1 scale (~2,000
 * contracts × small handful of installments each) the whole loop fits
 * inside one mutation's budget. Should the dataset grow past that
 * budget we can split this into an action that fan-outs per-contract
 * mutations; the public read surface is unchanged either way.
 *
 * Logging via `console.log` — visible through `npx convex logs` per the
 * runbook.
 *
 * Internal mutation: invoked by cron only; no user context to
 * authenticate.
 */
export const internal_recomputeAllAging = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ processed: number; skipped: number }> => {
    const startMs = Date.now();
    let processed = 0;
    let skipped = 0;
    console.log("[arAging] recompute start", new Date(startMs).toISOString());
    // Use the `by_state` index twice rather than scanning the whole
    // contracts table — NFR-P4 requires the indexed path.
    const active = await ctx.db
      .query("contracts")
      .withIndex("by_state", (q) => q.eq("state", "active"))
      .collect();
    const inDefault = await ctx.db
      .query("contracts")
      .withIndex("by_state", (q) => q.eq("state", "in_default"))
      .collect();
    const candidates = [...active, ...inDefault];
    const nowMs = Date.now();
    for (const contract of candidates) {
      try {
        const computed = await computeContractAging(
          ctx,
          contract._id,
          nowMs,
        );
        if (computed === null) {
          skipped += 1;
          continue;
        }
        const existing = await ctx.db
          .query("arAgingSnapshots")
          .withIndex("by_contract", (q) =>
            q.eq("contractId", contract._id),
          )
          .first();
        const row = {
          contractId: contract._id,
          bucket: computed.bucket,
          totalOverdueCents: computed.totalOverdueCents,
          overdueCountWithAction: computed.overdueCountWithAction,
          overdueCountSilent: computed.overdueCountSilent,
          ...(computed.oldestDueDate !== undefined
            ? { oldestDueDate: computed.oldestDueDate }
            : {}),
          recomputedAt: nowMs,
        };
        if (existing === null) {
          await ctx.db.insert("arAgingSnapshots", row);
        } else {
          await ctx.db.patch(existing._id, row);
        }
        processed += 1;
      } catch (e) {
        // One bad contract should not stop the other contracts from
        // updating. Log + continue; the next day's cron will retry.
        console.error(
          "[arAging] contract failed",
          contract._id,
          (e as Error).message,
        );
        skipped += 1;
      }
    }
    const elapsedMs = Date.now() - startMs;
    console.log("[arAging] recompute end", { processed, skipped, elapsedMs });
    return { processed, skipped };
  },
});

/**
 * Public, on-demand recompute mutation — admin escape hatch.
 *
 * Wraps `internal_recomputeAllAging` behind an admin-only auth gate so
 * Mr. Reyes can force a recompute from the dashboard if the daily cron
 * is missing. Returns the run statistics.
 */
export const recomputeNow = mutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ processed: number; skipped: number }> => {
    await requireRole(ctx, ["admin"]);
    const startMs = Date.now();
    let processed = 0;
    let skipped = 0;
    const active = await ctx.db
      .query("contracts")
      .withIndex("by_state", (q) => q.eq("state", "active"))
      .collect();
    const inDefault = await ctx.db
      .query("contracts")
      .withIndex("by_state", (q) => q.eq("state", "in_default"))
      .collect();
    const candidates = [...active, ...inDefault];
    const nowMs = Date.now();
    for (const contract of candidates) {
      const computed = await computeContractAging(ctx, contract._id, nowMs);
      if (computed === null) {
        skipped += 1;
        continue;
      }
      const existing = await ctx.db
        .query("arAgingSnapshots")
        .withIndex("by_contract", (q) => q.eq("contractId", contract._id))
        .first();
      const row = {
        contractId: contract._id,
        bucket: computed.bucket,
        totalOverdueCents: computed.totalOverdueCents,
        overdueCountWithAction: computed.overdueCountWithAction,
        overdueCountSilent: computed.overdueCountSilent,
        ...(computed.oldestDueDate !== undefined
          ? { oldestDueDate: computed.oldestDueDate }
          : {}),
        recomputedAt: nowMs,
      };
      if (existing === null) {
        await ctx.db.insert("arAgingSnapshots", row);
      } else {
        await ctx.db.patch(existing._id, row);
      }
      processed += 1;
    }
    void startMs; // referenced for symmetry with the cron logger above
    return { processed, skipped };
  },
});

/**
 * Public read surface for the dashboard / drill-down (Stories 5.2, 4.8).
 *
 * Aggregates `arAgingSnapshots` into the bucket-keyed counts + totals
 * shape that Story 5.2's `getArAgingSummary` already exposes (this query
 * is the back-fill that turns the placeholder buckets into real numbers).
 *
 * Auth: admin or office_staff — the staff drill-down (Story 4.8) and the
 * dashboard tile (Story 5.2) both read here.
 */
export const getAgingSummary = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{
    buckets: Array<{
      key: "1-30" | "31-60" | "61-90" | "90+";
      count: number;
      totalCents: number;
      withLoggedActionCount: number;
    }>;
    currentCents: number;
    currentCount: number;
    totalOverdueCents: number;
    totalOverdueCount: number;
    oldestSnapshotAt: number | null;
  }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = (await ctx.db
      .query("arAgingSnapshots")
      .collect()) as SnapshotDoc[];

    const bucketAcc: Record<
      ArAgingBucket,
      { count: number; totalCents: number; withAction: number }
    > = {
      current: { count: 0, totalCents: 0, withAction: 0 },
      "1-30": { count: 0, totalCents: 0, withAction: 0 },
      "31-60": { count: 0, totalCents: 0, withAction: 0 },
      "61-90": { count: 0, totalCents: 0, withAction: 0 },
      "90+": { count: 0, totalCents: 0, withAction: 0 },
    };
    let oldestSnapshotAt: number | null = null;
    for (const row of rows) {
      const acc = bucketAcc[row.bucket];
      acc.count += 1;
      acc.totalCents += row.totalOverdueCents;
      acc.withAction += row.overdueCountWithAction;
      if (oldestSnapshotAt === null || row.recomputedAt < oldestSnapshotAt) {
        oldestSnapshotAt = row.recomputedAt;
      }
    }

    const dashboardKeys = ["1-30", "31-60", "61-90", "90+"] as const;
    const buckets = dashboardKeys.map((key) => ({
      key,
      count: bucketAcc[key].count,
      totalCents: bucketAcc[key].totalCents,
      withLoggedActionCount: bucketAcc[key].withAction,
    }));

    const totalOverdueCents = buckets.reduce(
      (sum, b) => sum + b.totalCents,
      0,
    );
    const totalOverdueCount = buckets.reduce((sum, b) => sum + b.count, 0);

    return {
      buckets,
      currentCents: bucketAcc.current.totalCents,
      currentCount: bucketAcc.current.count,
      totalOverdueCents,
      totalOverdueCount,
      oldestSnapshotAt,
    };
  },
});

/**
 * Public read: current aging snapshot for a single contract.
 *
 * Used by the contract detail page (Story 3.6 already shipped the page;
 * this is the additional reactive tile). Returns `null` when the
 * snapshot row hasn't been computed yet (e.g. a contract created since
 * the last cron run).
 */
export const getSnapshotForContract = queryGeneric({
  args: { contractId: v.id("contracts") },
  handler: async (
    ctx: QueryCtx,
    args: { contractId: ContractId },
  ): Promise<SnapshotDoc | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const row = await ctx.db
      .query("arAgingSnapshots")
      .withIndex("by_contract", (q) => q.eq("contractId", args.contractId))
      .first();
    return row;
  },
});

/**
 * Public, documented row cap on `listAgingDetail`.
 *
 * Epic 4 adversarial-review fix (2026-05-24): the per-row joins inside
 * `listAgingDetail` (contract + customer + lot + installments +
 * payments) are O(N) on the snapshot row count, and the follow-up
 * read used to be N+M (one query per installment). At Phase 1 the
 * snapshot table is small (~2,000 contracts; only the overdue ones
 * have snapshot rows), but the page's UX never shows more than a
 * single bucket's worth of rows at a time and the operator can drill
 * deeper via the bucket chips. Capping the result set at 100 rows is
 * the explicit performance contract — the UI shows the top 100 by
 * `totalOverdueCents` descending (biggest financial risk first), and
 * a "showing first 100 of N" indicator surfaces when the cap clipped
 * the list. Operators who need the long tail use the report-export
 * surface (Epic 6).
 */
export const AR_AGING_DETAIL_ROW_CAP = 100;

/**
 * Story 4.8 — public read: AR aging drill-down detail rows.
 *
 * Per-contract aging row joined with the customer's display name + the
 * lot code + a derived `hasActiveFollowUp` flag. The flag is true when
 * AT LEAST ONE of the contract's overdue installments has a follow-up
 * action whose `status === "open"` (the Story 4.2 lifecycle name for an
 * unresolved entry). Note: Story 4.8's narrative talks about "active
 * (non-expired)" follow-ups; Story 4.3 (the expiry sweep) flips
 * expired-and-still-open rows to `"cancelled"`, so once 4.3 ships the
 * `"open"` filter is equivalent to "active and not expired" without
 * further date math here.
 *
 * Args:
 *   - `bucket` (optional) — filter to a single aging bucket. Omitted
 *     means "all four overdue buckets PLUS current".
 *
 * Returns rows sorted by `totalOverdueCents` descending (biggest
 * financial risk first; the column header click in the UI flips the
 * direction client-side without a second round-trip — at 100-row scale
 * a re-sort is cheap and the URL still carries the user's preference
 * via search params). The result is capped at
 * `AR_AGING_DETAIL_ROW_CAP` (100) — see the constant's docstring for
 * the rationale.
 *
 * Performance (Epic 4 adversarial-review fix — 2026-05-24):
 *   - Follow-up reads are hoisted: ONE index scan of the open
 *     `followUpActions` rows up front, then in-memory grouping by
 *     `installmentId`. Avoids the prior N+M per-installment query
 *     pattern that ran one round-trip per overdue installment.
 *   - Snapshot rows are sorted by `totalOverdueCents` BEFORE the
 *     per-row joins, then the top `AR_AGING_DETAIL_ROW_CAP` are
 *     joined. The join cost is now bounded at the cap regardless of
 *     how many snapshot rows exist.
 *
 * Auth: `admin` + `office_staff`. Field workers are excluded — the
 * page surfaces overdue-financial detail that's outside the field
 * worker's role per Story 1.2's RBAC matrix.
 */
export const listAgingDetail = queryGeneric({
  args: {
    bucket: v.optional(
      v.union(
        v.literal("current"),
        v.literal("1-30"),
        v.literal("31-60"),
        v.literal("61-90"),
        v.literal("90+"),
      ),
    ),
  },
  handler: async (
    ctx: QueryCtx,
    args: { bucket?: ArAgingBucket },
  ): Promise<{
    rows: Array<{
      contractId: string;
      contractNumber: string;
      customerId: string;
      customerFullName: string;
      lotId: string;
      lotCode: string;
      bucket: ArAgingBucket;
      totalOverdueCents: number;
      currentBalanceCents: number;
      daysOverdue: number;
      hasActiveFollowUp: boolean;
      followUpActionNote: string | undefined;
      lastPaymentAt: number | undefined;
      contractState:
        | "active"
        | "paid_in_full"
        | "cancelled"
        | "voided"
        | "in_default";
    }>;
    totalCount: number;
    needsActionCount: number;
    truncatedAt: number | null;
  }> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const nowMs = Date.now();

    // Pull snapshot rows for the requested bucket (or all of them).
    // Using the dedicated `by_bucket` index when a single bucket is
    // requested keeps the scan bounded to that band; the unfiltered
    // path falls back to a full collect (cemetery Phase 1 has ~2,000
    // contracts, so the snapshot table is small).
    const snapshots: SnapshotDoc[] = args.bucket
      ? ((await ctx.db
          .query("arAgingSnapshots")
          .withIndex("by_bucket", (q) => q.eq("bucket", args.bucket!))
          .collect()) as SnapshotDoc[])
      : ((await ctx.db
          .query("arAgingSnapshots")
          .collect()) as SnapshotDoc[]);

    type Row = {
      contractId: string;
      contractNumber: string;
      customerId: string;
      customerFullName: string;
      lotId: string;
      lotCode: string;
      bucket: ArAgingBucket;
      totalOverdueCents: number;
      currentBalanceCents: number;
      daysOverdue: number;
      hasActiveFollowUp: boolean;
      followUpActionNote: string | undefined;
      lastPaymentAt: number | undefined;
      contractState:
        | "active"
        | "paid_in_full"
        | "cancelled"
        | "voided"
        | "in_default";
    };

    // Epic 4 adversarial-review fix (2026-05-24): cap the working set
    // at `AR_AGING_DETAIL_ROW_CAP` rows BEFORE we run the per-row
    // joins. Snapshot rows already carry `totalOverdueCents` (it's
    // the canonical sort key), so we can sort + slice here without
    // touching contracts / customers / lots / installments. The
    // join cost is now bounded at the cap regardless of how many
    // snapshot rows exist.
    const snapshotsSorted = [...snapshots].sort(
      (a, b) => b.totalOverdueCents - a.totalOverdueCents,
    );
    const totalSnapshotCount = snapshotsSorted.length;
    const truncatedAt =
      totalSnapshotCount > AR_AGING_DETAIL_ROW_CAP
        ? AR_AGING_DETAIL_ROW_CAP
        : null;
    const snapshotsToJoin = snapshotsSorted.slice(0, AR_AGING_DETAIL_ROW_CAP);

    // Epic 4 adversarial-review fix (2026-05-24): hoist the
    // follow-up read into ONE indexed scan over all `open` rows,
    // then group by `installmentId`. Without this, the per-snapshot
    // loop ran one `followUpActions.by_installment` query per
    // overdue installment — at Phase 1's scale that's hundreds of
    // round-trips per drill-down. The single `by_status_dueAt`
    // scan returns only the rows we care about (`status === "open"`)
    // and the in-memory grouping is O(N) where N = total open
    // follow-ups (bounded by the overdue installment count).
    const allOpenFollowUps = await ctx.db
      .query("followUpActions")
      .withIndex("by_status_dueAt", (q) => q.eq("status", "open"))
      .collect();
    const followUpsByInstallment = new Map<
      string,
      Array<(typeof allOpenFollowUps)[number]>
    >();
    for (const fu of allOpenFollowUps) {
      const key = fu.installmentId as unknown as string;
      const bucket = followUpsByInstallment.get(key);
      if (bucket === undefined) {
        followUpsByInstallment.set(key, [fu]);
      } else {
        bucket.push(fu);
      }
    }

    const rows: Row[] = [];
    let needsActionCount = 0;
    for (const snap of snapshotsToJoin) {
      const contract = await ctx.db.get(snap.contractId);
      if (contract === null) continue;
      // Defense in depth — drop snapshots whose contract no longer
      // belongs to active / in_default. The cron should have culled
      // these but a snapshot can lag a state transition by up to one
      // day before the next recompute.
      if (
        contract.state !== "active" &&
        contract.state !== "in_default"
      ) {
        continue;
      }

      // pii-read-ok: AR aging detail projects fullName only — address/email/phone/govId not returned; staff-facing surface gated by requireRole earlier
      const customer = await ctx.db.get(contract.customerId);
      const lot = await ctx.db.get(contract.lotId);

      // hasActiveFollowUp: walk this contract's installments and look
      // each up in the pre-built `followUpsByInstallment` map. Short-
      // circuits on the first hit. We also grab the note of the first
      // matched action so the UI can render "Action: …" inline
      // without a second round-trip.
      const installments = await ctx.db
        .query("installments")
        .withIndex("by_contract", (q) =>
          q.eq("contractId", contract._id),
        )
        .collect();

      let hasActiveFollowUp = false;
      let followUpActionNote: string | undefined;
      // Also compute current outstanding balance across all unpaid
      // installments (not just the overdue ones) so the UI can show
      // contract-level balance distinct from `totalOverdueCents`.
      let currentBalanceCents = 0;
      for (const inst of installments) {
        if (inst.status === "paid" || inst.status === "waived") continue;
        currentBalanceCents += Math.max(
          0,
          inst.principalCents - inst.paidCents,
        );
        if (hasActiveFollowUp) continue;
        const followUpsForInst = followUpsByInstallment.get(
          inst._id as unknown as string,
        );
        if (followUpsForInst !== undefined && followUpsForInst.length > 0) {
          // Every row in `followUpsForInst` already has
          // `status === "open"` (the index filter guaranteed it),
          // so any entry counts as an active follow-up.
          hasActiveFollowUp = true;
          followUpActionNote = followUpsForInst[0]!.notes;
        }
      }

      // daysOverdue: derived from the oldest overdue installment's due
      // date if present on the snapshot; otherwise zero (e.g. the
      // `current` bucket).
      const daysOverdue =
        snap.oldestDueDate !== undefined
          ? Math.max(
              0,
              Math.floor((nowMs - snap.oldestDueDate) / DAY_MS),
            )
          : 0;

      // lastPaymentAt: the most recent NON-voided payment on the
      // contract. Convex stores `payments.contractId` as a string
      // (polymorphic; ADR-0007 cornerstone field), so we filter on
      // string equality. Indexed via `by_contract`.
      const payments = await ctx.db
        .query("payments")
        .withIndex("by_contract", (q) =>
          q.eq("contractId", contract._id as unknown as string),
        )
        .collect();
      let lastPaymentAt: number | undefined;
      for (const p of payments) {
        if (p.isVoided === true) continue;
        if (lastPaymentAt === undefined || p.receivedAt > lastPaymentAt) {
          lastPaymentAt = p.receivedAt;
        }
      }

      const row: Row = {
        contractId: contract._id as unknown as string,
        contractNumber: contract.contractNumber,
        customerId: contract.customerId as unknown as string,
        customerFullName: customer?.fullName ?? "[deleted customer]",
        lotId: contract.lotId as unknown as string,
        lotCode: lot?.code ?? "[retired]",
        bucket: snap.bucket,
        totalOverdueCents: snap.totalOverdueCents,
        currentBalanceCents,
        daysOverdue,
        hasActiveFollowUp,
        followUpActionNote,
        lastPaymentAt,
        contractState: contract.state,
      };
      rows.push(row);
      if (!hasActiveFollowUp && snap.bucket !== "current") {
        needsActionCount += 1;
      }
    }

    // Story 2.9 (FR15) — consolidate estate-bound rows into one row
    // per estate so the AR-aging surface treats the estate as a single
    // outstanding obligation. Single-lot rows (`familyEstateId` absent)
    // pass through unchanged. The consolidated row inherits the
    // worst-bucket of its constituents (max by BUCKET_ORDER) and sums
    // the financial fields; `lotCode` becomes the comma-joined member
    // codes ("A-1, A-2, A-3") so the operator can see the estate's
    // footprint at a glance.
    const consolidated: Row[] = [];
    const estateAccum = new Map<string, { row: Row; bucketIdx: number }>();
    for (const r of rows) {
      const contract = await ctx.db.get(
        r.contractId as unknown as DataModel["contracts"]["document"]["_id"],
      );
      const estateId = (contract as { familyEstateId?: string } | null)
        ?.familyEstateId;
      if (estateId === undefined) {
        consolidated.push(r);
        continue;
      }
      const existing = estateAccum.get(estateId as unknown as string);
      const bucketIdx = BUCKET_ORDER.indexOf(r.bucket);
      if (existing === undefined) {
        // Resolve the estate name once on first hit per group.
        const estate = await ctx.db.get(
          estateId as unknown as DataModel["familyEstates"]["document"]["_id"],
        );
        const estateName =
          estate !== null && typeof estate === "object" && "name" in estate
            ? (estate as { name: string }).name
            : "Family estate";
        estateAccum.set(estateId as unknown as string, {
          row: {
            ...r,
            // Replace per-lot identity with estate identity so the UI
            // renders one consolidated row.
            lotCode: estateName,
            // Keep `contractId` pointing at the anchor contract — the
            // detail page navigation lands on the contract that holds
            // the estate FK.
          },
          bucketIdx,
        });
      } else {
        existing.row.totalOverdueCents += r.totalOverdueCents;
        existing.row.currentBalanceCents += r.currentBalanceCents;
        if (r.daysOverdue > existing.row.daysOverdue) {
          existing.row.daysOverdue = r.daysOverdue;
        }
        if (bucketIdx > existing.bucketIdx) {
          existing.row.bucket = r.bucket;
          existing.bucketIdx = bucketIdx;
        }
        if (r.hasActiveFollowUp) {
          existing.row.hasActiveFollowUp = true;
          if (existing.row.followUpActionNote === undefined) {
            existing.row.followUpActionNote = r.followUpActionNote;
          }
        }
        if (
          r.lastPaymentAt !== undefined &&
          (existing.row.lastPaymentAt === undefined ||
            r.lastPaymentAt > existing.row.lastPaymentAt)
        ) {
          existing.row.lastPaymentAt = r.lastPaymentAt;
        }
      }
    }
    for (const { row: estateRow } of estateAccum.values()) {
      consolidated.push(estateRow);
    }

    consolidated.sort(
      (a, b) => b.totalOverdueCents - a.totalOverdueCents,
    );

    // Re-derive needsActionCount on the consolidated list so the
    // estate consolidation does not over-count.
    const consolidatedNeedsAction = consolidated.filter(
      (r) => !r.hasActiveFollowUp && r.bucket !== "current",
    ).length;
    void needsActionCount; // pre-consolidation tally retained inline for traceability

    return {
      rows: consolidated,
      totalCount: consolidated.length,
      needsActionCount: consolidatedNeedsAction,
      truncatedAt,
    };
  },
});

/**
 * Convenience read: "is the dashboard's aging data still fresh?" Returns
 * the most-recent `recomputedAt` across the snapshot table, or `null`
 * when no snapshots exist yet. The dashboard tile shows a "Data stale —
 * last refresh > 24h ago" hint when this lags `now - 24h`.
 */
export const getCurrentAging = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{
    lastRecomputedAt: number | null;
    snapshotCount: number;
  }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = (await ctx.db
      .query("arAgingSnapshots")
      .collect()) as SnapshotDoc[];
    if (rows.length === 0) {
      return { lastRecomputedAt: null, snapshotCount: 0 };
    }
    let latest = rows[0]!.recomputedAt;
    for (const r of rows) {
      if (r.recomputedAt > latest) latest = r.recomputedAt;
    }
    return { lastRecomputedAt: latest, snapshotCount: rows.length };
  },
});
