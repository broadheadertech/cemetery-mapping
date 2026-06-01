/**
 * Follow-up actions domain — Story 4.2 (FR35).
 *
 * Owns the `followUpActions` table read + write surface. Office Staff
 * (and admin) attach logged follow-up actions to overdue installments so
 * Mr. Reyes can see "₱X with Y% in active follow-up" at the AR-aging
 * tile, and so the < 30s missed-payment recovery loop in Journey 2 has a
 * server-backed home.
 *
 * Conventions every handler obeys (mirrored from `convex/occupants.ts`,
 * `convex/installments.ts`):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are banned
 *      by `local-rules/no-audit-log-direct-write`. The `entityId` we
 *      pass is the LOT id (the canonical aggregate root for cemetery
 *      sub-events, matching the occupants/ownerships convention), not
 *      the installment id. We dereference: followUpAction →
 *      installment → contract → lot.
 *   3. Mutations do not write to `payments` / `receipts` /
 *      `paymentAllocations` / `contracts.balance` — follow-up actions
 *      are NOT financial events. The Story 3.2
 *      `no-direct-financial-write` lint rule continues to pass.
 *   4. The status-flip mutations (`markComplete`, `markCancelled`) do
 *      NOT route through `assertTransition` — the follow-up action's
 *      lifecycle is independent of the installment's own state machine,
 *      and an inline guard against double-completion is cleaner than
 *      registering a new state-machine entry.
 *
 * Story 4.1 integration hook (Epic 4 adversarial-review fix —
 * 2026-05-24): `createFollowUp` and `internal_reflagExpired` SCHEDULE
 * the AR aging recompute via `ctx.scheduler.runAfter(0, ...)` for each
 * affected contract. The internal mutation is idempotent (upsert keyed
 * by `contractId`). Scheduling-rather-than-inlining keeps the host
 * mutation transaction lean; the snapshot upsert runs in its own
 * internal-mutation transaction immediately afterwards and is rolled
 * back if the host transaction aborts (Convex scheduler entries are
 * transactional with the enclosing mutation).
 *
 * Without this hook the `overdueCountWithAction` / `overdueCountSilent`
 * split on the snapshot row stayed stale until the next 01:00 Manila
 * cron — the "with logged action" pill (Story 4.2 AC3) wouldn't flip
 * for hours, breaking the < 30s recovery loop the Journey-4 climax
 * surface promises.
 *
 * `markComplete` / `markCancelled` deliberately do NOT schedule a
 * recompute here — those mutations are outside the scope of the
 * 2026-05-24 review fix. A follow-up story can extend the hook if the
 * "stale snapshot after manual close-out" path turns out to matter.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import { DAY_MS } from "./lib/time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type InstallmentId = DataModel["installments"]["document"]["_id"];
type FollowUpActionDoc = DataModel["followUpActions"]["document"];
type FollowUpActionId = FollowUpActionDoc["_id"];

/**
 * Function reference for `arAging:internal_recomputeAgingForContractMutation`.
 *
 * Built via `makeFunctionReference` (string-path form) rather than a
 * static import from `convex/_generated/api` — same rationale as the
 * `convex/crons.ts` registration: `_generated/` only exists after
 * `npx convex dev` runs interactively, and `tsconfig.json` excludes
 * that directory from typecheck. The string path resolves at deploy
 * time. Mirrors the pattern used by `convex/contracts.ts:2669-2676`
 * (`markContractInDefault` schedules the same internal mutation).
 *
 * Story 4.2 adversarial-review fix: `createFollowUp` previously did
 * not schedule the recompute, so the AR aging snapshot's
 * `overdueCountWithAction` / `overdueCountSilent` split stayed stale
 * until the next 01:00 Manila cron — AC3 + Story 4.1's narrative
 * depend on the count flipping within seconds of the operator
 * logging the action.
 */
const recomputeAgingForContractRef = makeFunctionReference<
  "mutation",
  { contractId: ContractId },
  void
>("arAging:internal_recomputeAgingForContractMutation");

/** Server-side caps mirrored on the client form schema. */
export const FOLLOW_UP_NOTES_MAX_LENGTH = 500;

/**
 * Controlled vocabulary of follow-up channels. Mirrors the
 * `followUpActions.action` schema literal union.
 */
export type FollowUpAction =
  | "phone_call"
  | "sms"
  | "letter"
  | "in_person"
  | "other";

const ALLOWED_ACTIONS: readonly FollowUpAction[] = [
  "phone_call",
  "sms",
  "letter",
  "in_person",
  "other",
];

/**
 * Shape returned by `listForInstallment` / list endpoints. Trimmed (no
 * raw `_id` aliasing, no `_creationTime` leak) so the response surface
 * stays narrow.
 */
export interface FollowUpActionRow {
  followUpActionId: FollowUpActionId;
  installmentId: InstallmentId;
  action: FollowUpAction;
  notes: string | undefined;
  dueAt: number;
  status: "open" | "completed" | "cancelled" | "expired";
  createdAt: number;
  createdBy: DataModel["users"]["document"]["_id"];
  completedAt: number | undefined;
  completedBy: DataModel["users"]["document"]["_id"] | undefined;
  /**
   * Wall-clock time the daily re-flag sweep (Story 4.3) flipped this
   * row from `"open"` to `"expired"`. Surfaced on the read row so the
   * UI can render the "expired N hours ago" visual distinction without
   * a second roundtrip. `undefined` for rows in any other status.
   */
  expiredAt: number | undefined;
}

function toRow(doc: FollowUpActionDoc): FollowUpActionRow {
  const out: FollowUpActionRow = {
    followUpActionId: doc._id,
    installmentId: doc.installmentId,
    action: doc.action as FollowUpAction,
    notes: doc.notes,
    dueAt: doc.dueAt,
    status: doc.status,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy,
    completedAt: doc.completedAt,
    completedBy: doc.completedBy,
    expiredAt: doc.expiredAt,
  };
  return out;
}

/**
 * Resolves the lot id for an installment so the audit row can use it as
 * the aggregate-root entityId. Returns `null` if the chain breaks
 * (installment / contract has been deleted) — caller decides whether to
 * abort.
 */
async function lotIdForInstallment(
  ctx: MutationCtx | QueryCtx,
  installmentId: InstallmentId,
): Promise<DataModel["lots"]["document"]["_id"] | null> {
  const installment = await ctx.db.get(installmentId);
  if (installment === null) return null;
  const contract = await ctx.db.get(installment.contractId);
  if (contract === null) return null;
  return contract.lotId;
}

/**
 * Insert a new follow-up action against an overdue installment.
 *
 * Auth: `office_staff` / `admin`. Field workers cannot log follow-ups —
 * collections is staff/admin only.
 *
 * Validation (defense in depth; the client Zod schema mirrors):
 *   - `action` must be a member of `ALLOWED_ACTIONS`.
 *   - `notes` (when supplied) trimmed; ≤ 500 chars.
 *   - `dueAt` must be a finite positive integer (unix ms) and ≥ now -
 *     one day (Manila tz tolerance) — the operator picks a future
 *     follow-up moment. We allow same-day even if the server clock has
 *     drifted slightly.
 *   - The target installment must exist AND have `status === "overdue"`.
 *     Follow-ups on `paid` / `pending` / `waived` installments are a
 *     category error — surface `INVARIANT_VIOLATION`.
 *
 * Audit: emitted with `entityType: "lot"`, `entityId: <lot id>`.
 */
export const createFollowUp = mutationGeneric({
  args: {
    installmentId: v.id("installments"),
    action: v.union(
      v.literal("phone_call"),
      v.literal("sms"),
      v.literal("letter"),
      v.literal("in_person"),
      v.literal("other"),
    ),
    dueAt: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      installmentId: InstallmentId;
      action: FollowUpAction;
      dueAt: number;
      notes?: string;
    },
  ): Promise<{ followUpActionId: FollowUpActionId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    if (!ALLOWED_ACTIONS.includes(args.action)) {
      throwError(ErrorCode.VALIDATION, "Unknown follow-up action channel.");
    }

    if (
      !Number.isFinite(args.dueAt) ||
      !Number.isInteger(args.dueAt) ||
      args.dueAt <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Due date must be a positive integer (unix ms).",
      );
    }
    // Allow up to one day of clock skew so an operator picking "today"
    // does not get rejected by a slightly-fast server clock.
    if (args.dueAt < Date.now() - DAY_MS) {
      throwError(
        ErrorCode.VALIDATION,
        "Due date must be today or later.",
      );
    }

    let trimmedNotes: string | undefined;
    if (args.notes !== undefined) {
      const trimmed = args.notes.trim();
      if (trimmed.length > FOLLOW_UP_NOTES_MAX_LENGTH) {
        throwError(
          ErrorCode.VALIDATION,
          `Notes must be ${FOLLOW_UP_NOTES_MAX_LENGTH} characters or fewer.`,
        );
      }
      if (trimmed.length > 0) {
        trimmedNotes = trimmed;
      }
    }

    const installment = await ctx.db.get(args.installmentId);
    if (installment === null) {
      throwError(ErrorCode.NOT_FOUND, "Installment not found.", {
        installmentId: args.installmentId,
      });
    }
    // Overdue gate (Epic 4 C1 fix). Installments are never patched to a
    // literal `status: "overdue"` — that status exists in the schema but
    // nothing writes it. The AR-aging recompute derives "overdue" purely
    // from the due date (`arAging.ts:computeContractAging`), so this gate
    // MUST use the SAME derived predicate or the two halves of Epic 4
    // disagree and follow-ups become impossible to create. An installment
    // is overdue when it is unpaid/unwaived, its due date is more than a
    // full day in the past (matching aging's `daysOverdue > 0`), and it
    // still has outstanding principal.
    const remainingCents = installment.principalCents - installment.paidCents;
    const daysOverdue = Math.floor(
      (Date.now() - installment.dueDate) / DAY_MS,
    );
    const isOverdue =
      installment.status !== "paid" &&
      installment.status !== "waived" &&
      daysOverdue > 0 &&
      remainingCents > 0;
    if (!isOverdue) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Follow-up actions are only allowed on overdue installments.",
        { installmentId: args.installmentId, status: installment.status },
      );
    }

    const contract = await ctx.db.get(installment.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: installment.contractId,
      });
    }

    const createdAt = Date.now();
    const insertRow: {
      installmentId: InstallmentId;
      action: FollowUpAction;
      notes?: string;
      dueAt: number;
      status: "open";
      createdAt: number;
      createdBy: typeof auth.userId;
    } = {
      installmentId: args.installmentId,
      action: args.action,
      dueAt: args.dueAt,
      status: "open",
      createdAt,
      createdBy: auth.userId,
    };
    if (trimmedNotes !== undefined) {
      insertRow.notes = trimmedNotes;
    }
    const followUpActionId = await ctx.db.insert(
      "followUpActions",
      insertRow,
    );

    // Audit row keyed on the LOT (aggregate root for cemetery
    // sub-events). `reason` field carries the trimmed notes when
    // present — keeps the audit trail self-describing without
    // duplicating the field shape.
    const auditPayload: {
      action: "create";
      entityType: "lot";
      entityId: string;
      after: Record<string, unknown>;
      reason?: string;
    } = {
      action: "create",
      entityType: "lot",
      entityId: contract.lotId as unknown as string,
      after: {
        followUpActionId,
        installmentId: args.installmentId,
        action: args.action,
        dueAt: args.dueAt,
        status: "open",
      },
    };
    if (trimmedNotes !== undefined) {
      auditPayload.reason = trimmedNotes;
    }
    await emitAudit(ctx, auditPayload);

    // Story 4.2 adversarial-review fix — schedule the AR aging
    // snapshot recompute for the affected contract so the
    // `overdueCountWithAction` / `overdueCountSilent` split flips
    // within seconds instead of waiting for the next 01:00 Manila
    // cron. The internal mutation is idempotent (upsert keyed by
    // `contractId`). Mirrors the pattern in
    // `convex/contracts.ts:markContractInDefault`.
    await ctx.scheduler.runAfter(0, recomputeAgingForContractRef, {
      contractId: contract._id,
    });

    return { followUpActionId };
  },
});

/**
 * List every follow-up action attached to an installment, sorted by
 * `createdAt` descending (newest first). Auth: `office_staff` / `admin`.
 */
export const listForInstallment = queryGeneric({
  args: { installmentId: v.id("installments") },
  handler: async (
    ctx: QueryCtx,
    args: { installmentId: InstallmentId },
  ): Promise<FollowUpActionRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db
      .query("followUpActions")
      .withIndex("by_installment", (q) =>
        q.eq("installmentId", args.installmentId),
      )
      .collect();
    const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
    return sorted.map(toRow);
  },
});

/**
 * List every `open` follow-up action across the cemetery, sorted by
 * `dueAt` ascending so the earliest-due rows render first. Powers the
 * `/follow-ups` page. Auth: `office_staff` / `admin`.
 *
 * Phase 1 simplification: no pagination cap. At the cemetery's Phase 1
 * scale (~2,000 lots, the open follow-up set is bounded by the overdue
 * installment set), the full collection fits inside a single Convex
 * query budget. A `limit` arg can land later without an API break.
 */
export const listOpenFollowUps = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<FollowUpActionRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db
      .query("followUpActions")
      .withIndex("by_status_dueAt", (q) => q.eq("status", "open"))
      .collect();
    // The `by_status_dueAt` index already sorts by `dueAt` ascending
    // within a fixed status equality; re-sort defensively so test
    // fixtures that bypass index ordering still produce stable output.
    const sorted = [...rows].sort((a, b) => a.dueAt - b.dueAt);
    return sorted.map(toRow);
  },
});

/**
 * Mark an `open` follow-up action as `completed`. Idempotent: a
 * follow-up that is ALREADY `completed` returns successfully without
 * modification (defensive against double-clicks). A follow-up that is
 * `cancelled` rejects with `INVARIANT_VIOLATION` — completing a
 * previously-abandoned follow-up is a category error.
 *
 * Auth: `office_staff` / `admin`.
 */
export const markComplete = mutationGeneric({
  args: { followUpActionId: v.id("followUpActions") },
  handler: async (
    ctx: MutationCtx,
    args: { followUpActionId: FollowUpActionId },
  ): Promise<{ followUpActionId: FollowUpActionId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const row = await ctx.db.get(args.followUpActionId);
    if (row === null) {
      throwError(ErrorCode.NOT_FOUND, "Follow-up action not found.", {
        followUpActionId: args.followUpActionId,
      });
    }
    if (row.status === "completed") {
      return { followUpActionId: args.followUpActionId };
    }
    if (row.status === "cancelled") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot complete a cancelled follow-up action.",
        { followUpActionId: args.followUpActionId },
      );
    }

    const completedAt = Date.now();
    await ctx.db.patch(args.followUpActionId, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "completed",
      completedAt,
      completedBy: auth.userId,
    });

    const lotId = await lotIdForInstallment(ctx, row.installmentId);
    if (lotId !== null) {
      await emitAudit(ctx, {
        action: "update",
        entityType: "lot",
        entityId: lotId as unknown as string,
        before: { status: row.status },
        after: {
          followUpActionId: args.followUpActionId,
          status: "completed",
          completedAt,
        },
      });
    }

    return { followUpActionId: args.followUpActionId };
  },
});

/**
 * Mark an `open` follow-up action as `cancelled`. Idempotent on
 * `cancelled`; rejects with `INVARIANT_VIOLATION` for already-`completed`
 * rows (cancelling a completed follow-up is a category error). Auth:
 * `office_staff` / `admin`.
 *
 * `completedAt` is reused as the cancellation timestamp so we don't
 * grow a parallel `cancelledAt` field — the schema's `status`
 * discriminator already disambiguates the two close-out modes.
 */
export const markCancelled = mutationGeneric({
  args: { followUpActionId: v.id("followUpActions") },
  handler: async (
    ctx: MutationCtx,
    args: { followUpActionId: FollowUpActionId },
  ): Promise<{ followUpActionId: FollowUpActionId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    const row = await ctx.db.get(args.followUpActionId);
    if (row === null) {
      throwError(ErrorCode.NOT_FOUND, "Follow-up action not found.", {
        followUpActionId: args.followUpActionId,
      });
    }
    if (row.status === "cancelled") {
      return { followUpActionId: args.followUpActionId };
    }
    if (row.status === "completed") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot cancel a completed follow-up action.",
        { followUpActionId: args.followUpActionId },
      );
    }

    const cancelledAt = Date.now();
    await ctx.db.patch(args.followUpActionId, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "cancelled",
      completedAt: cancelledAt,
      completedBy: auth.userId,
    });

    const lotId = await lotIdForInstallment(ctx, row.installmentId);
    if (lotId !== null) {
      await emitAudit(ctx, {
        action: "update",
        entityType: "lot",
        entityId: lotId as unknown as string,
        before: { status: row.status },
        after: {
          followUpActionId: args.followUpActionId,
          status: "cancelled",
          completedAt: cancelledAt,
        },
      });
    }

    return { followUpActionId: args.followUpActionId };
  },
});

/**
 * Daily re-flag sweep — Story 4.3 (FR36).
 *
 * Scans every `open` follow-up action whose `dueAt` has passed and
 * re-categorizes it as `"expired"`. The reactive `listForInstallment`
 * subscription (Story 4.2) flips the installment's display status back
 * from "overdue · follow-up logged" (amber) to "silently overdue"
 * (red) without any client-side refresh — the "with logged action" pill
 * is a promise that becomes a lie if the action expires unnoticed, and
 * this sweep closes the loop.
 *
 * Invocation paths:
 *   1. The daily cron (`convex/crons.ts` → `internal_reflagExpired`)
 *      runs once per day at 03:00 Manila (19:00 UTC). The 03:00 slot
 *      sits AFTER the 02:00 reconciliation invariant + the 01:00 AR
 *      aging recompute — so each day's snapshot already reflects the
 *      previous day's expirations and the sweep doesn't race the
 *      aging recompute over the same rows.
 *   2. Manual replay via `npx convex run followUpActions:internal_reflagExpired`
 *      for the runbook's "the cron missed last night" path.
 *
 * Idempotency:
 *   - The index scan filters for `status === "open"` server-side, so
 *     running the mutation twice in succession finds zero rows on the
 *     second pass (every previously-open expired row is now
 *     `"expired"`).
 *   - `expiredAt` is set to the captured `nowMs` once and never
 *     re-patched (we don't double-flip an already-expired row).
 *
 * No `requireRole` first line — this is an `internalMutation` and the
 * `require-role-first-line` ESLint rule is documented to exempt
 * internal functions (see `eslint-rules/require-role-first-line.js`).
 *
 * Audit emission (Epic 4 adversarial-review fix — 2026-05-24): AC4 of
 * Story 4.3 explicitly requires a system-actor audit row per expired
 * follow-up. `emitAudit` requires an authenticated session (it throws
 * `UNAUTHENTICATED` from a cron context), so this sweep writes
 * directly to `auditLog` with an `eslint-disable-next-line
 * local-rules/no-audit-log-direct-write` comment — the rule
 * intentionally has no per-file exemption; the comment is the
 * documented bypass for the rare "system actor with no session" case.
 * The schema's `actor: v.id("users")` invariant forces us to attribute
 * the audit row to the user who CREATED the follow-up (the "system
 * acting on behalf of" pattern); a `reason: "system: expired ..."`
 * prefix marks every row as cron-driven so audit consumers can filter
 * cron-emitted rows out of operator-action review. The `entityType:
 * "lot"` choice mirrors the rest of `convex/followUpActions.ts`
 * (`createFollowUp` / `markComplete` / `markCancelled` all key the
 * audit row on the lot id) — `"lot"` is the canonical aggregate
 * root for cemetery sub-events; the schema's `entityType` validator
 * union does NOT include `"followUpAction"`.
 *
 * Aging-snapshot recompute (Epic 4 adversarial-review fix —
 * 2026-05-24): for every expired row, schedule the AR aging recompute
 * for the affected contract via `ctx.scheduler.runAfter(0, ...)`. The
 * `overdueCountWithAction` / `overdueCountSilent` split must flip
 * within seconds — a sweep that flips 100 follow-ups to expired but
 * leaves the snapshot showing them as "with logged action" until the
 * next 01:00 cron breaks the same Journey-4 < 30s recovery loop the
 * `createFollowUp` hook protects. We deduplicate the recompute via a
 * `Set<ContractId>` so each contract sees at most one scheduler entry
 * even if its installments owned multiple expired follow-ups.
 *
 * Disaster prevention (story § Hard stops + § Disaster prevention):
 *   - Does NOT write to `payments` / `receipts` / `paymentAllocations`
 *     / `contracts.balance` — expirations are not financial events.
 *     The Story 3.2 `no-direct-financial-write` lint rule continues
 *     to pass.
 *   - Uses the `by_status_dueAt` index (NOT a full-table scan); the
 *     range predicate is `status === "open" && dueAt < nowMs`, which
 *     Convex's range index supports natively. NFR-P4 indexed-path
 *     requirement holds.
 *   - Captures `nowMs` once at the top so every row written in this
 *     run shares the same `expiredAt` timestamp — deterministic for
 *     observability and audit-style log scraping.
 *   - One failing row does NOT stop the others — `try`/`catch` around
 *     each patch lets the rest of the batch proceed, same pattern as
 *     `arAging.internal_recomputeAllAging`.
 *   - Audit and recompute scheduling happen INSIDE the per-row
 *     try/catch so a failing audit insert (e.g. a follow-up whose
 *     `createdBy` user has been deleted) does not block the
 *     status-flip from committing.
 *
 * Internal mutation: invoked by cron only; no user context to
 * authenticate.
 */
export const internal_reflagExpired = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ expired: number; skipped: number; scanned: number }> => {
    const startMs = Date.now();
    const nowMs = startMs;
    console.log(
      "[followUpActions] reflag-expired sweep start",
      new Date(startMs).toISOString(),
    );

    // `by_status_dueAt` is the [status, dueAt] index Story 4.2
    // already declared. The range filter `q.eq("status", "open")
    // .lt("dueAt", nowMs)` is the documented Convex range query
    // shape — server-side scan over only the open rows whose dueAt
    // has passed.
    const candidates = await ctx.db
      .query("followUpActions")
      .withIndex("by_status_dueAt", (q) =>
        q.eq("status", "open").lt("dueAt", nowMs),
      )
      .collect();

    let expired = 0;
    let skipped = 0;
    // Track affected contract ids so we schedule the AR aging
    // recompute exactly once per contract per sweep — multiple
    // expired follow-ups under the same contract share one
    // scheduler entry. `Set<ContractId>` carries opaque branded
    // strings; the deduplication still works because Convex ids
    // compare by string equality.
    const affectedContracts = new Set<ContractId>();
    for (const row of candidates) {
      // Defensive re-check: another invocation (manual replay racing
      // the cron) may have already flipped this row.
      if (row.status !== "open") {
        skipped += 1;
        continue;
      }
      try {
        await ctx.db.patch(row._id, {
          // eslint-disable-next-line local-rules/no-raw-status-patch
          status: "expired",
          expiredAt: nowMs,
        });
        expired += 1;

        // Resolve installment → contract → lot for the audit row's
        // `entityId`, AND for the affected-contract set used by the
        // recompute scheduler. A missing installment / contract is
        // logged + skipped (the status flip already committed).
        const installment = await ctx.db.get(row.installmentId);
        if (installment === null) {
          console.warn(
            "[followUpActions] reflag-expired: installment vanished",
            { followUpActionId: row._id, installmentId: row.installmentId },
          );
          continue;
        }
        const contract = await ctx.db.get(installment.contractId);
        if (contract === null) {
          console.warn(
            "[followUpActions] reflag-expired: contract vanished",
            {
              followUpActionId: row._id,
              installmentId: row.installmentId,
              contractId: installment.contractId,
            },
          );
          continue;
        }
        affectedContracts.add(contract._id);

        // Story 4.3 AC4 — system-actor audit row. Direct insert
        // because `emitAudit` requires an authenticated session
        // (cron has none); the `actor` is the follow-up's original
        // `createdBy` so the schema's `v.id("users")` invariant
        // holds. The `reason: "system: ..."` prefix marks every
        // row as cron-driven so audit consumers can filter it out
        // of operator-action review.
        // eslint-disable-next-line local-rules/no-audit-log-direct-write
        await ctx.db.insert("auditLog", {
          actor: row.createdBy,
          timestamp: nowMs,
          action: "update",
          entityType: "lot",
          entityId: contract.lotId as unknown as string,
          before: { status: "open" },
          after: {
            followUpActionId: row._id,
            status: "expired",
            expiredAt: nowMs,
          },
          reason: `system: follow-up action auto-expired (dueAt ${new Date(row.dueAt).toISOString()})`,
        });
      } catch (e) {
        console.error(
          "[followUpActions] reflag-expired row failed",
          row._id,
          (e as Error).message,
        );
        skipped += 1;
      }
    }

    // Schedule one recompute per affected contract — the upsert is
    // idempotent so a duplicate scheduler entry (from a concurrent
    // manual replay) is a no-op modulo `recomputedAt`. Failures
    // here log + continue: scheduler entries are best-effort and
    // the daily 01:00 cron is the safety net.
    for (const contractId of affectedContracts) {
      try {
        await ctx.scheduler.runAfter(0, recomputeAgingForContractRef, {
          contractId,
        });
      } catch (e) {
        console.error(
          "[followUpActions] reflag-expired schedule recompute failed",
          contractId,
          (e as Error).message,
        );
      }
    }

    const elapsedMs = Date.now() - startMs;
    console.log("[followUpActions] reflag-expired sweep end", {
      scanned: candidates.length,
      expired,
      skipped,
      contractsScheduled: affectedContracts.size,
      elapsedMs,
    });
    return { expired, skipped, scanned: candidates.length };
  },
});
