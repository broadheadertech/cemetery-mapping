/**
 * Daily reconciliation invariant — Story 5.5 (FR60, NFR-R4, NFR-M2).
 *
 * Financial-integrity safety net. The Story 3.2 `postFinancialEvent`
 * cornerstone guarantees that every money-touching mutation lands
 * payment + receipt + allocations + audit row atomically inside ONE
 * Convex transaction. The reconciliation invariant assumes the
 * cornerstone is correct AND verifies the ledger nightly anyway:
 *
 *   - A restore-from-backup that lands mid-day could resurrect a
 *     pre-cornerstone row.
 *   - A future direct `ctx.db.patch` against `payments` / `installments`
 *     by a developer with `ctx.db.replace` access could silently corrupt.
 *   - A hardware-induced bit flip on the storage tier would not be
 *     detected by the cornerstone (it only validates inputs).
 *
 * Three invariants the cron checks every day at 2 AM Manila (= 18:00
 * UTC the prior calendar day):
 *
 *   1. `payments_match_allocations` — for every non-voided payment,
 *      `sum(paymentAllocations.amountCents WHERE paymentId === p._id)
 *      === payments.amountCents`. The cornerstone enforces this
 *      structurally; the cron re-verifies post-write.
 *
 *   2. `contract_total_ok` — for every contract, the sum of every
 *      non-voided allocation that targets the contract (whether the
 *      allocation's `targetType` is "contract" pointing at the contract
 *      itself or "installment" pointing at one of the contract's
 *      installments) is `<= contracts.totalPriceCents`. An
 *      over-applied contract would indicate a double-applied payment
 *      or a corrupted allocation row.
 *
 *   3. `installment_paid_bounded` — for every installment row,
 *      `paidCents <= principalCents`. The Story 3.9 allocator should
 *      keep this true; the cron re-verifies.
 *
 * Each invariant runs in its own internal mutation so a single failed
 * check does not block the others. Each run produces one
 * `reconciliationRuns` row capturing the count of checked rows, the
 * count of mismatches, and a small array of discrepancy details
 * (capped to keep the row size bounded — the dashboard tile only
 * shows the count; the detail page would query the underlying tables
 * directly when a richer drill-down is required).
 *
 * Scope deviation from the Story 5.5 spec:
 *   - The original story spec wired against `contracts.outstandingBalanceCents`
 *     + `originalAmountCents` and a `reconciliationFailures` table. The
 *     current schema (Stories 3.3 / 3.4 as shipped) does not carry
 *     either field — contracts have `totalPriceCents` + `state` only,
 *     and Story 3.9's payment allocator runs through the cornerstone's
 *     `paymentAllocations` table rather than maintaining an inline
 *     contract balance. We therefore re-express the invariant in
 *     terms of the schema we actually have. The three checks above
 *     cover the same structural risk surface (silent payment / contract
 *     / installment drift) without requiring a schema migration that
 *     other Epic-3 stories don't ship.
 *
 * Conventions:
 *   - Internal action (`checkReconciliationInvariant`) + internal
 *     mutations (one per check) are NOT in the `api.*` surface — they
 *     are server-to-server only. The `require-role-first-line` lint
 *     rule does not apply to them (internal functions have no user
 *     context).
 *   - Public read query (`getLatestReconciliation`) is admin-only —
 *     `requireRole(ctx, ["admin"])` as the first line.
 *   - Money math via `convex/lib/money.ts` (`sub`) — never raw `-`.
 *   - All writes go to `reconciliationRuns`; the file does NOT mutate
 *     `payments` / `receipts` / `paymentAllocations` / `contracts` /
 *     `installments` (the `no-direct-financial-write` rule + the
 *     architectural commitment to financial-history immutability
 *     enforce this).
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { emitAudit } from "./lib/audit";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";
import { sub } from "./lib/money";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ReconciliationRunDoc = DataModel["reconciliationRuns"]["document"];
type ReconciliationFailureDoc =
  DataModel["reconciliationFailures"]["document"];

/**
 * Per-detection failure descriptor. Maps a single drift instance from a
 * check's discrepancy array into the upsert payload for the
 * `reconciliationFailures` table. Keep this in lockstep with the
 * per-check discrepancy shapes below.
 */
interface FailureUpsert {
  entityType: "payment" | "contract" | "installment";
  entityId: string;
  expectedCents: number;
  actualCents: number;
}

/**
 * Maximum number of discrepancy detail entries persisted on a single
 * `reconciliationRuns.summary.discrepancies` array. Beyond this cap, the
 * row records the count but truncates the per-row detail to keep the
 * row size bounded. The dashboard tile reads only the count; the
 * forensic drill-down can re-run the invariant interactively if richer
 * detail is needed.
 */
const MAX_DISCREPANCIES_RECORDED = 50;

/**
 * The cron's trigger label. Centralised so the test fixtures and the
 * production cron agree on the literal value without copy-paste drift.
 */
type TriggeredBy = "cron" | "manual";

type CheckType =
  | "payments_match_allocations"
  | "contract_total_ok"
  | "installment_paid_bounded";

type RunStatus = "ok" | "warn" | "fail";

interface CheckResult {
  status: RunStatus;
  summary: {
    checked: number;
    mismatches: number;
    discrepancies: ReadonlyArray<Record<string, unknown>>;
    truncated: boolean;
    durationMs: number;
  };
  /**
   * Failure descriptors emitted ahead of the discrepancy cap. The
   * per-run upsert path uses these to maintain the
   * `reconciliationFailures` register (used by the dashboard banner
   * + admin queue). The cap on `discrepancies` is for the log row's
   * `summary` payload; the failure register itself receives one row
   * per detection (no cap), so the admin queue shows every open drift.
   */
  failures: ReadonlyArray<FailureUpsert>;
}

/**
 * Invariant 1: every non-voided payment's allocations sum to its
 * `amountCents`. Voided payments are skipped — the cornerstone's void
 * path does NOT delete allocations (audit trail), so a voided payment's
 * allocation sum still matches the original amount; only the
 * `isVoided` flag flips. The reconciliation check excludes voided
 * payments from the count entirely so the summary's `checked` reflects
 * the population that the invariant applies to.
 *
 * Algorithm:
 *   1. Stream every `payments` row (no pagination — Phase-1 scale fits in
 *      one mutation budget; Story-5.5's NFR-P3 review allows the simple
 *      path).
 *   2. For each non-voided payment, collect its `paymentAllocations` via
 *      the `by_payment` index, sum `amountCents`, and compare against
 *      `payments.amountCents`.
 *   3. Mismatch → push a discrepancy detail (paymentId, expected, actual,
 *      delta) and bump the mismatch counter.
 */
async function runPaymentsMatchAllocations(
  ctx: MutationCtx,
  startMs: number,
): Promise<CheckResult> {
  let checked = 0;
  let mismatches = 0;
  const discrepancies: Array<Record<string, unknown>> = [];
  const failures: FailureUpsert[] = [];
  let truncated = false;

  const payments = await ctx.db.query("payments").collect();
  for (const payment of payments) {
    if (payment.isVoided === true) continue;
    checked += 1;
    const allocations = await ctx.db
      .query("paymentAllocations")
      .withIndex("by_payment", (q) => q.eq("paymentId", payment._id))
      .collect();
    let allocSum = 0;
    for (const a of allocations) {
      allocSum += a.amountCents;
    }
    if (allocSum !== payment.amountCents) {
      mismatches += 1;
      failures.push({
        entityType: "payment",
        entityId: payment._id,
        expectedCents: payment.amountCents,
        actualCents: allocSum,
      });
      if (discrepancies.length < MAX_DISCREPANCIES_RECORDED) {
        // Use raw difference (signed) for the delta — the invariant
        // accepts BOTH directions of drift as failures, so `sub` (which
        // throws on negative) is the wrong helper here. Money math is
        // still integer-only; we constructed both operands as integers
        // server-side.
        discrepancies.push({
          paymentId: payment._id,
          paymentNumber: payment.paymentNumber,
          expectedCents: payment.amountCents,
          actualCents: allocSum,
          deltaCents: allocSum - payment.amountCents,
        });
      } else {
        truncated = true;
      }
    }
  }

  return {
    status: mismatches === 0 ? "ok" : "fail",
    summary: {
      checked,
      mismatches,
      discrepancies,
      truncated,
      durationMs: Date.now() - startMs,
    },
    failures,
  };
}

/**
 * Invariant 2: every contract's applied allocation sum is bounded by
 * `contracts.totalPriceCents`. Sums every allocation row whose target
 * resolves to this contract — either directly (`targetType: "contract"`
 * with `targetId === contract._id`) OR transitively via an installment
 * (`targetType: "installment"` with `targetId` resolving to an
 * installment whose `contractId === contract._id`).
 *
 * Voided payments' allocations are excluded — the cornerstone's void
 * path flips the payment's `isVoided` flag but preserves the
 * allocation rows; we look up each allocation's payment to filter.
 *
 * Algorithm:
 *   1. Stream every `contracts` row (Phase-1 scale fits in one mutation).
 *   2. For each contract, scan `paymentAllocations.by_target`:
 *      a. `{ targetType: "contract", targetId: contract._id }` — direct.
 *      b. For each of the contract's installments, scan
 *         `{ targetType: "installment", targetId: installment._id }`.
 *   3. Filter out allocations whose payment is voided.
 *   4. Sum + compare against `totalPriceCents`.
 *   5. Sum > total → push discrepancy.
 *
 * Performance: 2k contracts × ~60 installments per contract × small
 * allocation count per installment ≈ ~250k index lookups. Convex's
 * per-mutation budget handles this comfortably for Phase 1; a future
 * sharded run could split per-contract into a fan-out of mutations if
 * needed.
 */
async function runContractTotalOk(
  ctx: MutationCtx,
  startMs: number,
): Promise<CheckResult> {
  let checked = 0;
  let mismatches = 0;
  const discrepancies: Array<Record<string, unknown>> = [];
  const failures: FailureUpsert[] = [];
  let truncated = false;

  const contracts = await ctx.db.query("contracts").collect();
  for (const contract of contracts) {
    checked += 1;
    let appliedCents = 0;
    // Money applied specifically to this contract's INSTALLMENTS via
    // non-voided allocations. Compared below against the paidCents the
    // installment rows claim (invariant 2b — under-recording detection).
    let installmentAllocCents = 0;

    // Direct contract-targeted allocations.
    const directAllocations = await ctx.db
      .query("paymentAllocations")
      .withIndex("by_target", (q) =>
        q.eq("targetType", "contract").eq("targetId", contract._id),
      )
      .collect();
    for (const a of directAllocations) {
      const payment = await ctx.db.get(a.paymentId);
      if (payment !== null && payment.isVoided !== true) {
        appliedCents += a.amountCents;
      }
    }

    // Installment-targeted allocations (transitive) AND the paidCents the
    // installment rows CLAIM. In every correct flow these are equal: the
    // payment allocator (`payments.ts`) bumps `installment.paidCents` by
    // exactly the allocation amount in the same mutation, and the void
    // reversal (`postFinancialEvent.ts`) decrements both together. So a
    // divergence is genuine drift — a dropped payment row, a bad restore,
    // or a manual `ctx.db.patch` — which is the dominant real-world
    // failure mode Story 5.5 exists to catch.
    const installments = await ctx.db
      .query("installments")
      .withIndex("by_contract", (q) => q.eq("contractId", contract._id))
      .collect();
    let installmentPaidCents = 0;
    for (const inst of installments) {
      installmentPaidCents += inst.paidCents;
      const instAllocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_target", (q) =>
          q.eq("targetType", "installment").eq("targetId", inst._id),
        )
        .collect();
      for (const a of instAllocations) {
        const payment = await ctx.db.get(a.paymentId);
        if (payment !== null && payment.isVoided !== true) {
          appliedCents += a.amountCents;
          installmentAllocCents += a.amountCents;
        }
      }
    }

    // Accumulate every issue found for THIS contract, then flag the
    // contract once (so `mismatches` counts drifting contracts, not
    // individual sub-issues, preserving the single-issue == 1 contract
    // semantics). The over-application detail is pushed first so it
    // remains `discrepancies[0]` for that contract.
    const contractDiscrepancies: Array<Record<string, unknown>> = [];

    // Invariant 2a — over-application: money applied must never EXCEED
    // the contract total.
    if (appliedCents > contract.totalPriceCents) {
      contractDiscrepancies.push({
        kind: "over_application",
        contractId: contract._id,
        contractNumber: contract.contractNumber,
        totalPriceCents: contract.totalPriceCents,
        appliedCents,
        overByCents: sub(appliedCents, contract.totalPriceCents),
      });
    }

    // Invariant 2b — UNDER-recording (the canonical Story 5.5 AC4 case
    // and the previous blind spot). The installment rows' claimed
    // paidCents total MUST equal the non-voided installment-allocation
    // total. A negative delta means money is missing from the ledger
    // (allocations < claimed paid — a dropped payment); a positive delta
    // means phantom allocations. Either direction is drift.
    if (installmentAllocCents !== installmentPaidCents) {
      contractDiscrepancies.push({
        kind: "installment_paid_vs_allocations",
        contractId: contract._id,
        contractNumber: contract.contractNumber,
        installmentPaidCents,
        installmentAllocCents,
        // Signed delta: actual (allocations) − expected (claimed paid).
        deltaCents: installmentAllocCents - installmentPaidCents,
      });
    }

    // Invariant 2c — paid_in_full completeness. Full-payment sales carry
    // no installments, so 2b cannot see a dropped full-payment receipt;
    // this catches it. A contract in the terminal `paid_in_full` state
    // must have non-voided allocations summing to EXACTLY its total.
    // (After the Epic 3 void-revert fix, voiding the closing receipt
    // moves the contract OUT of paid_in_full, so a paid_in_full contract
    // whose allocations don't sum to the total is genuine drift.)
    if (
      contract.state === "paid_in_full" &&
      appliedCents !== contract.totalPriceCents
    ) {
      contractDiscrepancies.push({
        kind: "paid_in_full_incomplete",
        contractId: contract._id,
        contractNumber: contract.contractNumber,
        totalPriceCents: contract.totalPriceCents,
        appliedCents,
        deltaCents: appliedCents - contract.totalPriceCents,
      });
    }

    if (contractDiscrepancies.length > 0) {
      mismatches += 1;
      // One register row per drifting contract. Prefer the under-recording
      // figures as the headline expected/actual when present (money
      // missing is the most urgent signal); else fall back to the
      // contract-total comparison.
      const under = contractDiscrepancies.find(
        (d) => d.kind === "installment_paid_vs_allocations",
      );
      failures.push({
        entityType: "contract",
        entityId: contract._id,
        expectedCents:
          under !== undefined
            ? (under.installmentPaidCents as number)
            : contract.totalPriceCents,
        actualCents:
          under !== undefined
            ? (under.installmentAllocCents as number)
            : appliedCents,
      });
      for (const d of contractDiscrepancies) {
        if (discrepancies.length < MAX_DISCREPANCIES_RECORDED) {
          discrepancies.push(d);
        } else {
          truncated = true;
        }
      }
    }
  }

  return {
    status: mismatches === 0 ? "ok" : "fail",
    summary: {
      checked,
      mismatches,
      discrepancies,
      truncated,
      durationMs: Date.now() - startMs,
    },
    failures,
  };
}

/**
 * Invariant 3: every installment row's `paidCents` does not exceed
 * `principalCents`. The Story 3.9 payment allocator is supposed to keep
 * this invariant; the reconciliation cron re-verifies. The cheapest of
 * the three checks — a single table scan with no joins.
 *
 * Why not also flag `paidCents < 0`: Convex's schema validator already
 * enforces `v.number()` and the allocator never writes negative; a bit
 * flip would corrupt the type, not the sign within range. The
 * single-bound check covers the practical drift surface.
 */
async function runInstallmentPaidBounded(
  ctx: MutationCtx,
  startMs: number,
): Promise<CheckResult> {
  let checked = 0;
  let mismatches = 0;
  const discrepancies: Array<Record<string, unknown>> = [];
  const failures: FailureUpsert[] = [];
  let truncated = false;

  const installments = await ctx.db.query("installments").collect();
  for (const inst of installments) {
    checked += 1;
    if (inst.paidCents > inst.principalCents) {
      mismatches += 1;
      failures.push({
        entityType: "installment",
        entityId: inst._id,
        expectedCents: inst.principalCents,
        actualCents: inst.paidCents,
      });
      if (discrepancies.length < MAX_DISCREPANCIES_RECORDED) {
        discrepancies.push({
          installmentId: inst._id,
          contractId: inst.contractId,
          installmentNumber: inst.installmentNumber,
          principalCents: inst.principalCents,
          paidCents: inst.paidCents,
          // Over-payment — `paidCents > principalCents` by construction.
          overByCents: sub(inst.paidCents, inst.principalCents),
        });
      } else {
        truncated = true;
      }
    }
  }

  return {
    status: mismatches === 0 ? "ok" : "fail",
    summary: {
      checked,
      mismatches,
      discrepancies,
      truncated,
      durationMs: Date.now() - startMs,
    },
    failures,
  };
}

/**
 * Upserts the per-detection rows into `reconciliationFailures`.
 *
 * Dedup key: `(entityType, entityId)`. When a row already exists for
 * the same entity, we patch `discoveredAt` / `actualCents` /
 * `expectedCents` / `runId` so the admin sees the freshest values;
 * `firstDiscoveredAt` is preserved so the "how long has this been
 * drifting?" question retains its answer.
 *
 * Returns the number of rows that were inserted vs patched — useful
 * for log review.
 */
async function upsertReconciliationFailures(
  ctx: MutationCtx,
  runId: string,
  failures: ReadonlyArray<FailureUpsert>,
): Promise<{ inserted: number; patched: number }> {
  let inserted = 0;
  let patched = 0;
  const now = Date.now();
  for (const f of failures) {
    const existing = await ctx.db
      .query("reconciliationFailures")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", f.entityType).eq("entityId", f.entityId),
      )
      .first();
    if (existing === null) {
      await ctx.db.insert("reconciliationFailures", {
        runId,
        entityType: f.entityType,
        entityId: f.entityId,
        expectedCents: f.expectedCents,
        actualCents: f.actualCents,
        discoveredAt: now,
        firstDiscoveredAt: now,
      });
      inserted += 1;
      continue;
    }
    // If the prior row was acknowledged but the drift is BACK, clear
    // the acknowledgement so the dashboard banner re-asserts. New drift
    // after a clean run deserves fresh attention.
    const patch: Partial<ReconciliationFailureDoc> = {
      runId,
      expectedCents: f.expectedCents,
      actualCents: f.actualCents,
      discoveredAt: now,
    };
    if (existing.acknowledgedAt !== undefined) {
      patch.acknowledgedAt = undefined;
      patch.acknowledgedBy = undefined;
      patch.acknowledgmentNote = undefined;
    }
    // Drift that previously self-resolved (Story 5.5 AC2) is back: clear
    // the resolution stamp so the row counts as open again.
    if (existing.resolvedAt !== undefined) {
      patch.resolvedAt = undefined;
    }
    await ctx.db.patch(existing._id, patch);
    patched += 1;
  }
  return { inserted, patched };
}

/**
 * The single `reconciliationFailures.entityType` each check produces.
 * Used to scope self-resolution (AC2) to the rows a given check owns —
 * a clean `contract_total_ok` run must not resolve a still-open
 * `installment_paid_bounded` failure.
 */
const ENTITY_TYPE_FOR_CHECK: Record<
  CheckType,
  "payment" | "contract" | "installment"
> = {
  payments_match_allocations: "payment",
  contract_total_ok: "contract",
  installment_paid_bounded: "installment",
};

/**
 * Story 5.5 AC2 self-resolution. After a check runs, any failure row in
 * the check's entity domain that is still OPEN (not acknowledged, not
 * already resolved) but whose entity is NOT in this run's failing set
 * has reconciled cleanly since the last detection. Stamp `resolvedAt`
 * (never delete — the "drifted between T1 and T2" forensic trail must
 * survive, NFR-S7) so the dashboard banner + admin queue stop counting
 * it. Returns the number of rows resolved.
 */
async function resolveStaleFailures(
  ctx: MutationCtx,
  entityType: "payment" | "contract" | "installment",
  currentFailingIds: ReadonlySet<string>,
  now: number,
): Promise<number> {
  const domainRows = await ctx.db
    .query("reconciliationFailures")
    .withIndex("by_entity", (q) => q.eq("entityType", entityType))
    .collect();
  let resolved = 0;
  for (const row of domainRows) {
    if (row.resolvedAt !== undefined) continue; // already resolved
    if (currentFailingIds.has(row.entityId)) continue; // still drifting
    await ctx.db.patch(row._id, { resolvedAt: now });
    resolved += 1;
  }
  return resolved;
}

/**
 * Internal mutation: run a single check and persist its result.
 *
 * One mutation per check keeps each invariant atomic — a failure in
 * one check (e.g. an exception thrown mid-loop) does not roll back
 * the other checks' rows. The orchestrator dispatches all three.
 *
 * Internal mutation: invoked from `runReconciliationCheckpoint` only;
 * no user context to authenticate.
 */
export const internal_runReconciliationCheck = internalMutationGeneric({
  args: {
    checkType: v.union(
      v.literal("payments_match_allocations"),
      v.literal("contract_total_ok"),
      v.literal("installment_paid_bounded"),
    ),
    triggeredBy: v.union(v.literal("cron"), v.literal("manual")),
  },
  handler: async (
    ctx: MutationCtx,
    args: { checkType: CheckType; triggeredBy: TriggeredBy },
  ): Promise<{ status: RunStatus; mismatches: number; checked: number }> => {
    const startMs = Date.now();
    let result: CheckResult;
    if (args.checkType === "payments_match_allocations") {
      result = await runPaymentsMatchAllocations(ctx, startMs);
    } else if (args.checkType === "contract_total_ok") {
      result = await runContractTotalOk(ctx, startMs);
    } else {
      result = await runInstallmentPaidBounded(ctx, startMs);
    }
    const runId = await ctx.db.insert("reconciliationRuns", {
      runAt: startMs,
      checkType: args.checkType,
      status: result.status,
      summary: result.summary,
      triggeredBy: args.triggeredBy,
    });
    // Story 5.5 follow-up — upsert one row per drift detection into
    // the `reconciliationFailures` register so the dashboard banner +
    // admin queue have a top-level, indexed surface (NFR-R4 ≤ 2-hour
    // visibility).
    if (result.failures.length > 0) {
      await upsertReconciliationFailures(ctx, runId, result.failures);
    }
    // Story 5.5 AC2 — self-resolve any previously-open failure in this
    // check's entity domain that no longer drifts (runs even when the
    // current run is clean, so a fully-healed ledger empties the queue).
    await resolveStaleFailures(
      ctx,
      ENTITY_TYPE_FOR_CHECK[args.checkType],
      new Set(result.failures.map((f) => f.entityId)),
      startMs,
    );
    return {
      status: result.status,
      mismatches: result.summary.mismatches,
      checked: result.summary.checked,
    };
  },
});

/**
 * Internal mutation: the cron's body. Runs all three checks in
 * sequence and returns a top-level summary suitable for the cron's
 * `npx convex logs` output.
 *
 * Why a single mutation rather than fan-out into three: the three
 * checks together fit inside one mutation budget at Phase-1 scale and
 * scheduling three separate mutations would add complexity (and three
 * mutation-quotas of cost) without operational benefit. A future
 * scale-out can split them via the cron registration instead.
 *
 * Internal mutation: invoked by the daily cron AND the admin
 * `runReconciliationNow` mutation; no user context here.
 */
export const internal_runDailyReconciliation = internalMutationGeneric({
  args: {
    triggeredBy: v.optional(
      v.union(v.literal("cron"), v.literal("manual")),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: { triggeredBy?: TriggeredBy },
  ): Promise<{
    paymentsMatchAllocations: {
      status: RunStatus;
      mismatches: number;
      checked: number;
    };
    contractTotalOk: {
      status: RunStatus;
      mismatches: number;
      checked: number;
    };
    installmentPaidBounded: {
      status: RunStatus;
      mismatches: number;
      checked: number;
    };
  }> => {
    const triggeredBy: TriggeredBy = args.triggeredBy ?? "cron";
    const startMs = Date.now();
    console.log(
      "[reconciliation] start",
      new Date(startMs).toISOString(),
      triggeredBy,
    );

    // Inline the per-check work rather than calling the per-check
    // internal mutation reentrantly — Convex mutations cannot invoke
    // other mutations directly. Each check is still its own row in
    // `reconciliationRuns` (one per checkType per run).
    const checks: Array<{
      checkType: CheckType;
      run: () => Promise<CheckResult>;
    }> = [
      {
        checkType: "payments_match_allocations",
        run: () => runPaymentsMatchAllocations(ctx, Date.now()),
      },
      {
        checkType: "contract_total_ok",
        run: () => runContractTotalOk(ctx, Date.now()),
      },
      {
        checkType: "installment_paid_bounded",
        run: () => runInstallmentPaidBounded(ctx, Date.now()),
      },
    ];

    const results: Record<
      CheckType,
      { status: RunStatus; mismatches: number; checked: number }
    > = {
      payments_match_allocations: { status: "ok", mismatches: 0, checked: 0 },
      contract_total_ok: { status: "ok", mismatches: 0, checked: 0 },
      installment_paid_bounded: { status: "ok", mismatches: 0, checked: 0 },
    };

    for (const c of checks) {
      const runAt = Date.now();
      const r = await c.run();
      const runId = await ctx.db.insert("reconciliationRuns", {
        runAt,
        checkType: c.checkType,
        status: r.status,
        summary: r.summary,
        triggeredBy,
      });
      if (r.failures.length > 0) {
        await upsertReconciliationFailures(ctx, runId, r.failures);
      }
      results[c.checkType] = {
        status: r.status,
        mismatches: r.summary.mismatches,
        checked: r.summary.checked,
      };
    }

    const elapsedMs = Date.now() - startMs;
    console.log("[reconciliation] end", {
      elapsedMs,
      paymentsMatchAllocations: results.payments_match_allocations,
      contractTotalOk: results.contract_total_ok,
      installmentPaidBounded: results.installment_paid_bounded,
    });

    return {
      paymentsMatchAllocations: results.payments_match_allocations,
      contractTotalOk: results.contract_total_ok,
      installmentPaidBounded: results.installment_paid_bounded,
    };
  },
});

/**
 * Public, on-demand reconciliation mutation — admin escape hatch.
 *
 * Wraps `internal_runDailyReconciliation` behind an admin-only auth
 * gate so Mr. Reyes can force a reconciliation from the dashboard
 * (e.g. after a manual data correction) without waiting for the
 * next nightly cron. Records the run as `triggeredBy: "manual"`.
 */
export const runReconciliationNow = mutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{
    paymentsMatchAllocations: {
      status: RunStatus;
      mismatches: number;
      checked: number;
    };
    contractTotalOk: {
      status: RunStatus;
      mismatches: number;
      checked: number;
    };
    installmentPaidBounded: {
      status: RunStatus;
      mismatches: number;
      checked: number;
    };
  }> => {
    await requireRole(ctx, ["admin"]);
    const triggeredBy: TriggeredBy = "manual";
    const startMs = Date.now();

    const checks: Array<{
      checkType: CheckType;
      run: () => Promise<CheckResult>;
    }> = [
      {
        checkType: "payments_match_allocations",
        run: () => runPaymentsMatchAllocations(ctx, Date.now()),
      },
      {
        checkType: "contract_total_ok",
        run: () => runContractTotalOk(ctx, Date.now()),
      },
      {
        checkType: "installment_paid_bounded",
        run: () => runInstallmentPaidBounded(ctx, Date.now()),
      },
    ];

    const results: Record<
      CheckType,
      { status: RunStatus; mismatches: number; checked: number }
    > = {
      payments_match_allocations: { status: "ok", mismatches: 0, checked: 0 },
      contract_total_ok: { status: "ok", mismatches: 0, checked: 0 },
      installment_paid_bounded: { status: "ok", mismatches: 0, checked: 0 },
    };

    for (const c of checks) {
      const runAt = Date.now();
      const r = await c.run();
      const runId = await ctx.db.insert("reconciliationRuns", {
        runAt,
        checkType: c.checkType,
        status: r.status,
        summary: r.summary,
        triggeredBy,
      });
      if (r.failures.length > 0) {
        await upsertReconciliationFailures(ctx, runId, r.failures);
      }
      results[c.checkType] = {
        status: r.status,
        mismatches: r.summary.mismatches,
        checked: r.summary.checked,
      };
    }
    void startMs; // symmetric with `internal_runDailyReconciliation`.

    return {
      paymentsMatchAllocations: results.payments_match_allocations,
      contractTotalOk: results.contract_total_ok,
      installmentPaidBounded: results.installment_paid_bounded,
    };
  },
});

/**
 * Public read: latest reconciliation summary across all three checks.
 *
 * Returns the most-recent row per `checkType` (or `null` for a check
 * that has never run). Admin-only — reconciliation diagnostics are
 * not a routine office-staff surface. The dashboard banner (a future
 * story) consumes a derived count from this query.
 */
export const getLatestReconciliation = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{
    paymentsMatchAllocations: ReconciliationRunDoc | null;
    contractTotalOk: ReconciliationRunDoc | null;
    installmentPaidBounded: ReconciliationRunDoc | null;
  }> => {
    await requireRole(ctx, ["admin"]);

    async function latestForCheck(
      checkType: CheckType,
    ): Promise<ReconciliationRunDoc | null> {
      const row = await ctx.db
        .query("reconciliationRuns")
        .withIndex("by_checkType_runAt", (q) =>
          q.eq("checkType", checkType),
        )
        .order("desc")
        .first();
      return row;
    }

    return {
      paymentsMatchAllocations: await latestForCheck(
        "payments_match_allocations",
      ),
      contractTotalOk: await latestForCheck("contract_total_ok"),
      installmentPaidBounded: await latestForCheck(
        "installment_paid_bounded",
      ),
    };
  },
});

/**
 * Public admin query: count + recent rows of OPEN reconciliation
 * failures. "Open" = `acknowledgedAt` is absent.
 *
 * Powers two surfaces:
 *   - The dashboard banner — subscribes to `count` and renders a red
 *     warning when > 0 (Story 5.5 AC3 / NFR-R4: ≤ 2-hour visibility).
 *   - The `/admin/reconciliation` queue — shows up to `limit` rows
 *     (default 50) sorted by most-recently discovered.
 *
 * Returns the count separately from the rows so the banner can render
 * even when the recent-rows page is empty (e.g. drift detected but
 * limit is 0). Admin-only — reconciliation diagnostics are not a
 * routine office-staff surface.
 */
export const listOpenReconciliationFailures = queryGeneric({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number },
  ): Promise<{
    count: number;
    rows: ReconciliationFailureDoc[];
  }> => {
    await requireRole(ctx, ["admin"]);
    const limit = Math.min(args.limit ?? 50, 200);
    // The `by_acknowledged` index keys on `acknowledgedAt`. A row with
    // `acknowledgedAt === undefined` (open) sorts at the sentinel head
    // of the index range; we filter for the "open" subset by walking
    // the index without a range constraint and selecting rows whose
    // `acknowledgedAt` is absent. At Phase-1 scale (open failure count
    // bounded by 100s in the worst-case) this is cheap.
    const all = await ctx.db
      .query("reconciliationFailures")
      .withIndex("by_acknowledged")
      .collect();
    // "Open" = neither acknowledged by an admin NOR self-resolved by a
    // later clean run (Story 5.5 AC2). A resolved row is retained for the
    // forensic trail but must not inflate the banner/queue count.
    const open = all.filter(
      (r) => r.acknowledgedAt === undefined && r.resolvedAt === undefined,
    );
    open.sort((a, b) => b.discoveredAt - a.discoveredAt);
    return {
      count: open.length,
      rows: open.slice(0, limit),
    };
  },
});

/**
 * Admin-only: acknowledge a reconciliation failure. Sets
 * `acknowledgedAt` / `acknowledgedBy` (+ optional note) on the row so
 * it drops out of the open-failures count + dashboard banner.
 *
 * The row is NEVER deleted — the audit history of "drift was detected,
 * admin X acknowledged on date Y with reason Z" is itself a compliance
 * artefact (NFR-S7). An acknowledged row that re-drifts on a later
 * cron run has its acknowledgement CLEARED by
 * `upsertReconciliationFailures` so the banner re-asserts.
 *
 * Emits an audit row so the acknowledgement is forensically traceable
 * even after the failure register row is overwritten by future
 * detections.
 */
export const acknowledgeReconciliationFailure = mutationGeneric({
  args: {
    failureId: v.id("reconciliationFailures"),
    note: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      failureId: ReconciliationFailureDoc["_id"];
      note?: string;
    },
  ): Promise<void> => {
    const auth = await requireRole(ctx, ["admin"]);
    const row = await ctx.db.get(args.failureId);
    if (row === null) {
      throwError(ErrorCode.NOT_FOUND, "Reconciliation failure not found.", {
        failureId: args.failureId,
      });
    }
    if (row.acknowledgedAt !== undefined) {
      // Idempotent — already acknowledged, no-op. We do not bump the
      // acknowledgement metadata so the audit trail retains the
      // original acknowledger.
      return;
    }
    const trimmedNote = args.note?.trim();
    if (trimmedNote !== undefined && trimmedNote.length > 500) {
      throwError(
        ErrorCode.VALIDATION,
        "Acknowledgment note must be 500 characters or fewer.",
      );
    }
    const now = Date.now();
    const patch: Partial<ReconciliationFailureDoc> = {
      acknowledgedAt: now,
      acknowledgedBy: auth.userId,
    };
    if (trimmedNote !== undefined && trimmedNote.length > 0) {
      patch.acknowledgmentNote = trimmedNote;
    }
    await ctx.db.patch(args.failureId, patch);
    await emitAudit(ctx, {
      // Use `update` as the closest action in the canonical
      // `AuditAction` enum — the audit log does not have a dedicated
      // `acknowledge` member, and adding one is an ADR amendment out
      // of scope for this follow-up.
      action: "update",
      // The reconciliation register is not in the `auditLog.entityType`
      // union; we attribute the audit row to the entity the drift
      // refers to (`payment` / `contract`; `installment` drift attributes
      // to its parent `contract` because the union does not carry an
      // installment literal). The entityId stays as the original
      // reconciliation entity id, with the discriminator preserved in
      // the audit `after` payload for forensic resolution.
      entityType: row.entityType === "payment" ? "payment" : "contract",
      entityId: row.entityId,
      before: { acknowledgedAt: null, driftEntityType: row.entityType },
      after: {
        acknowledgedAt: now,
        acknowledgedBy: auth.userId,
        note: trimmedNote,
        driftEntityType: row.entityType,
      },
      reason: trimmedNote,
    });
  },
});
