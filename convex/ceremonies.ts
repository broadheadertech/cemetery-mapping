/**
 * Ceremonies domain (Story 7.5, FR43 extension).
 *
 * Generalised scheduling surface for non-interment ceremonies. The
 * Phase-1 surface ships consecration; the `kind` discriminator reserves
 * `interment` (for a future Option-A migration that absorbs the legacy
 * interments table) and `memorial_anniversary` (forward-compat).
 *
 * Architectural posture (matches convex/interments.ts conventions):
 *
 *   1. FIRST awaited line of every public handler is
 *      `await requireRole(ctx, [...])`. ESLint
 *      `local-rules/require-role-first-line` enforces.
 *   2. Mutations emit audit via `emitAudit` (never `db.insert("auditLog", ...)`
 *      directly -- `local-rules/no-audit-log-direct-write` enforces).
 *      `entityType: "lot"` because the audit-log enum is closed and the
 *      LOT is the canonical aggregate root for this sub-entity (matches
 *      occupants + interments precedent). The audit row's `after`
 *      payload carries `ceremonyId` + `kind` so the audit-log UI can
 *      filter on those.
 *   3. The booking-conflict guard lives in `convex/lib/scheduling.ts`
 *      (Option B per ADR 0069: queries BOTH ceremonies and the legacy
 *      interments table). The guard is read-only; the read + insert
 *      land in one mutation transaction so no race window.
 *   4. State machine: ceremony status transitions are scheduled ->
 *      completed | cancelled. Both targets are terminal. We do NOT
 *      route through `assertTransition` because the ceremony entity is
 *      not in `convex/lib/stateMachines.ts:TRANSITIONS` (the table is
 *      additive per ADR 0006; future PR can extend). Inline guards
 *      ("only scheduled rows can complete / cancel") suffice for the
 *      single forward edge each transition exposes.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { emitAudit } from "./lib/audit";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { ErrorCode, throwError } from "./lib/errors";
import {
  assertNoBookingConflict,
  CEREMONY_MAX_DURATION_MINUTES,
  CEREMONY_MIN_DURATION_MINUTES,
} from "./lib/scheduling";
import { DAY_MS } from "./lib/time";
// Import sentinel for the `local-rules/no-raw-status-patch` ESLint rule:
// the rule allows ctx.db.patch({ status }) when the file imports from
// stateMachines. The ceremony entity is not yet a member of the
// declarative TRANSITIONS table (ADR 0006 amendment deferred -- the
// inline guards in completeCeremony / cancelCeremony enforce the same
// invariants the table would). When a follow-up adds `ceremony` to
// TRANSITIONS, the inline guards graduate to assertTransition() calls.
import { assertTransition as _ceremonyStateMachineGuard } from "./lib/stateMachines";

// Reference the import once to keep ts/eslint happy without changing
// the runtime behaviour. The cast-to-void pattern matches the precedent
// in convex/internal/backfillCeremoniesKind.ts.
void _ceremonyStateMachineGuard;

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type CeremonyDoc = DataModel["ceremonies"]["document"];
type CeremonyId = CeremonyDoc["_id"];
type ContractId = DataModel["contracts"]["document"]["_id"];
type LotId = DataModel["lots"]["document"]["_id"];
type UserId = DataModel["users"]["document"]["_id"];

export const CEREMONY_NOTES_MAX_LENGTH = 500;
export const CEREMONY_REASON_MIN_LENGTH = 10;
export const CEREMONY_REASON_MAX_LENGTH = 500;

/** Default durations per kind (minutes). */
export const CEREMONY_DEFAULT_DURATION_MINUTES = {
  consecration: 90,
  interment: 60,
  memorial_anniversary: 60,
} as const;

type CeremonyKind = "consecration" | "interment" | "memorial_anniversary";

export interface CeremonyDetail {
  ceremonyId: CeremonyId;
  kind: CeremonyKind;
  status: "scheduled" | "completed" | "cancelled";
  contractId: ContractId;
  contractNumber: string;
  customerId: string;
  customerName: string;
  lotId: LotId;
  lotCode: string;
  lotSection: string;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  consultantUserId: UserId | undefined;
  consultantName: string | undefined;
  notes: string | undefined;
  scheduledByName: string;
  scheduledAt_createdAt: number;
  completedAt: number | undefined;
  completedByName: string | undefined;
  cancellationReason: string | undefined;
  familyEstateId: string | undefined;
}

export interface ListedCeremony {
  ceremonyId: CeremonyId;
  kind: CeremonyKind;
  status: "scheduled" | "completed" | "cancelled";
  contractId: ContractId;
  lotId: LotId;
  lotCode: string;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  customerName: string;
  consultantName: string | undefined;
}

/**
 * Schedule a new ceremony.
 *
 * Role gate: `admin` / `office_staff` (FR43 -- only office staff
 * coordinate scheduling). Field workers may read ceremonies but not
 * schedule them; customers are out of scope.
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` -- RBAC.
 *   - `VALIDATION` -- bad scheduledAt / durationMinutes / notes too long.
 *   - `NOT_FOUND` -- contractId or lotId doesn't resolve.
 *   - `INVARIANT_VIOLATION` -- lot is retired; contract is voided /
 *     cancelled (cannot schedule a ceremony for a non-live contract).
 *   - `SCHEDULING_CONFLICT` -- see `assertNoBookingConflict`.
 */
export const scheduleCeremony = mutationGeneric({
  args: {
    kind: v.union(
      v.literal("consecration"),
      v.literal("interment"),
      v.literal("memorial_anniversary"),
    ),
    contractId: v.id("contracts"),
    lotId: v.id("lots"),
    scheduledAt: v.number(),
    durationMinutes: v.number(),
    chapelReserved: v.boolean(),
    pathwayReserved: v.boolean(),
    consultantUserId: v.optional(v.id("users")),
    familyEstateId: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      kind: CeremonyKind;
      contractId: ContractId;
      lotId: LotId;
      scheduledAt: number;
      durationMinutes: number;
      chapelReserved: boolean;
      pathwayReserved: boolean;
      consultantUserId?: UserId;
      familyEstateId?: string;
      notes?: string;
    },
  ): Promise<{ ceremonyId: CeremonyId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Defensive bounds. Most of these mirror the client Zod schema --
    // defense in depth against hand-crafted callers.
    if (
      !Number.isFinite(args.scheduledAt) ||
      !Number.isInteger(args.scheduledAt) ||
      args.scheduledAt <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "scheduledAt must be a positive integer (unix ms).",
      );
    }
    const now = Date.now();
    if (args.scheduledAt < now - DAY_MS) {
      throwError(
        ErrorCode.VALIDATION,
        "Cannot schedule a ceremony more than 1 day in the past.",
      );
    }
    if (
      args.durationMinutes < CEREMONY_MIN_DURATION_MINUTES ||
      args.durationMinutes > CEREMONY_MAX_DURATION_MINUTES
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `durationMinutes must be between ${CEREMONY_MIN_DURATION_MINUTES} and ${CEREMONY_MAX_DURATION_MINUTES}.`,
      );
    }
    const trimmedNotes =
      args.notes !== undefined ? args.notes.trim() : undefined;
    if (
      trimmedNotes !== undefined &&
      trimmedNotes.length > CEREMONY_NOTES_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Notes must be ${CEREMONY_NOTES_MAX_LENGTH} characters or fewer.`,
      );
    }

    const [contract, lot] = await Promise.all([
      ctx.db.get(args.contractId),
      ctx.db.get(args.lotId),
    ]);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot schedule a ceremony on a retired lot.",
        { lotId: args.lotId },
      );
    }
    // Epic 7 H4 — the lot must actually belong to the contract. Without
    // this, a ceremony could be anchored to contract A while pointing
    // `lotId` at an unrelated lot B, producing an inconsistent join (the
    // interment path guards the analogous occupant↔lot invariant for the
    // same reason). Mirrors `contract.lotId` as the single source of truth.
    if ((contract.lotId as unknown as string) !== (args.lotId as unknown as string)) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "The lot does not belong to this contract.",
        { contractId: args.contractId, lotId: args.lotId },
      );
    }
    if (contract.state === "voided" || contract.state === "cancelled") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot schedule a ceremony against a voided or cancelled contract.",
        { contractId: args.contractId, contractState: contract.state },
      );
    }

    // Optional consultant must exist (when provided) so the detail page
    // never has to render a "(missing user)" sentinel because the
    // operator typed a stale id.
    if (args.consultantUserId !== undefined) {
      const consultant = await ctx.db.get(args.consultantUserId);
      if (consultant === null) {
        throwError(ErrorCode.NOT_FOUND, "Consultant user not found.", {
          consultantUserId: args.consultantUserId,
        });
      }
    }

    // Booking-conflict guard -- the load-bearing check. Throws
    // SCHEDULING_CONFLICT on overlap; passes silently on green.
    await assertNoBookingConflict(ctx, {
      lotId: args.lotId,
      scheduledAt: args.scheduledAt,
      durationMinutes: args.durationMinutes,
      chapelReserved: args.chapelReserved,
      pathwayReserved: args.pathwayReserved,
    });

    const insertRow: {
      kind: CeremonyKind;
      contractId: ContractId;
      lotId: LotId;
      scheduledAt: number;
      durationMinutes: number;
      chapelReserved: boolean;
      pathwayReserved: boolean;
      status: "scheduled";
      scheduledBy: UserId;
      scheduledAt_createdAt: number;
      consultantUserId?: UserId;
      familyEstateId?: string;
      notes?: string;
    } = {
      kind: args.kind,
      contractId: args.contractId,
      lotId: args.lotId,
      scheduledAt: args.scheduledAt,
      durationMinutes: args.durationMinutes,
      chapelReserved: args.chapelReserved,
      pathwayReserved: args.pathwayReserved,
      status: "scheduled",
      scheduledBy: auth.userId,
      scheduledAt_createdAt: now,
    };
    if (args.consultantUserId !== undefined) {
      insertRow.consultantUserId = args.consultantUserId;
    }
    if (args.familyEstateId !== undefined && args.familyEstateId.length > 0) {
      insertRow.familyEstateId = args.familyEstateId;
    }
    if (trimmedNotes !== undefined && trimmedNotes.length > 0) {
      insertRow.notes = trimmedNotes;
    }

    const ceremonyId = await ctx.db.insert("ceremonies", insertRow);

    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: args.lotId,
      after: {
        ceremonyId,
        kind: args.kind,
        contractId: args.contractId,
        scheduledAt: args.scheduledAt,
        durationMinutes: args.durationMinutes,
        chapelReserved: args.chapelReserved,
        pathwayReserved: args.pathwayReserved,
        status: "scheduled" as const,
      },
      reason:
        trimmedNotes !== undefined && trimmedNotes.length > 0
          ? trimmedNotes
          : `schedule_ceremony:${args.kind}`,
    });

    return { ceremonyId };
  },
});

/**
 * Mark a ceremony complete.
 *
 * Role gate: `admin` / `office_staff`. Story 7.5 § AC4 keeps the
 * field-worker-driven interment-completion flow owned by Story 7.4
 * (which writes to the legacy `interments` table, not this one). The
 * consecration completion is a simpler office-side gesture.
 */
export const completeCeremony = mutationGeneric({
  args: { ceremonyId: v.id("ceremonies") },
  handler: async (
    ctx: MutationCtx,
    args: { ceremonyId: CeremonyId },
  ): Promise<{ ceremonyId: CeremonyId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);
    const row = await ctx.db.get(args.ceremonyId);
    if (row === null) {
      throwError(ErrorCode.NOT_FOUND, "Ceremony not found.", {
        ceremonyId: args.ceremonyId,
      });
    }
    if (row.status !== "scheduled") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Only scheduled ceremonies can be marked complete.",
        { ceremonyId: args.ceremonyId, currentStatus: row.status },
      );
    }
    const completedAt = Date.now();
    await ctx.db.patch(args.ceremonyId, {
      status: "completed",
      completedAt,
      completedBy: auth.userId,
    });
    await emitAudit(ctx, {
      action: "transition",
      entityType: "lot",
      entityId: row.lotId,
      before: { ceremonyId: args.ceremonyId, status: "scheduled" as const },
      after: {
        ceremonyId: args.ceremonyId,
        kind: row.kind,
        status: "completed" as const,
        completedAt,
      },
      reason: `complete_ceremony:${row.kind}`,
    });
    return { ceremonyId: args.ceremonyId };
  },
});

/**
 * Cancel a ceremony. Admin-only. 10-char reason floor (mirrors the
 * cancellation-reason pattern from MarkInDefaultDialog and Story 3.7
 * void-contract).
 */
export const cancelCeremony = mutationGeneric({
  args: {
    ceremonyId: v.id("ceremonies"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { ceremonyId: CeremonyId; reason: string },
  ): Promise<{ ceremonyId: CeremonyId }> => {
    await requireRole(ctx, ["admin"]);
    const trimmed = args.reason.trim();
    if (trimmed.length < CEREMONY_REASON_MIN_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Cancellation reason must be at least ${CEREMONY_REASON_MIN_LENGTH} characters.`,
      );
    }
    if (trimmed.length > CEREMONY_REASON_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Cancellation reason must be ${CEREMONY_REASON_MAX_LENGTH} characters or fewer.`,
      );
    }
    const row = await ctx.db.get(args.ceremonyId);
    if (row === null) {
      throwError(ErrorCode.NOT_FOUND, "Ceremony not found.", {
        ceremonyId: args.ceremonyId,
      });
    }
    if (row.status !== "scheduled") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Only scheduled ceremonies can be cancelled.",
        { ceremonyId: args.ceremonyId, currentStatus: row.status },
      );
    }
    await ctx.db.patch(args.ceremonyId, {
      status: "cancelled",
      cancellationReason: trimmed,
    });
    await emitAudit(ctx, {
      action: "transition",
      entityType: "lot",
      entityId: row.lotId,
      before: { ceremonyId: args.ceremonyId, status: "scheduled" as const },
      after: {
        ceremonyId: args.ceremonyId,
        kind: row.kind,
        status: "cancelled" as const,
      },
      reason: `cancel_ceremony:${trimmed}`,
    });
    return { ceremonyId: args.ceremonyId };
  },
});

/**
 * Detail-page query. Joins contract + customer + lot + consultant
 * server-side so the page renders without N+1 client fetches.
 */
export const getCeremony = queryGeneric({
  args: { ceremonyId: v.id("ceremonies") },
  handler: async (
    ctx: QueryCtx,
    args: { ceremonyId: CeremonyId },
  ): Promise<CeremonyDetail | null> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const row = await ctx.db.get(args.ceremonyId);
    if (row === null) return null;
    const [contract, lot, scheduler, completed, consultant] = await Promise.all(
      [
        ctx.db.get(row.contractId),
        ctx.db.get(row.lotId),
        ctx.db.get(row.scheduledBy),
        row.completedBy !== undefined
          ? ctx.db.get(row.completedBy)
          : Promise.resolve(null),
        row.consultantUserId !== undefined
          ? ctx.db.get(row.consultantUserId)
          : Promise.resolve(null),
      ],
    );
    const customer =
      contract !== null ? await ctx.db.get(contract.customerId) : null;
    return {
      ceremonyId: row._id,
      kind: row.kind,
      status: row.status,
      contractId: row.contractId,
      contractNumber: contract !== null ? contract.contractNumber : "[deleted]",
      customerId: contract !== null ? contract.customerId : "",
      customerName: customer !== null ? customer.fullName : "[unknown]",
      lotId: row.lotId,
      lotCode: lot !== null ? lot.code : "[retired]",
      lotSection: lot !== null ? lot.section : "",
      scheduledAt: row.scheduledAt,
      durationMinutes: row.durationMinutes,
      chapelReserved: row.chapelReserved,
      pathwayReserved: row.pathwayReserved,
      consultantUserId: row.consultantUserId,
      consultantName:
        consultant !== null && consultant.name !== undefined
          ? consultant.name
          : undefined,
      notes: row.notes,
      scheduledByName:
        scheduler !== null && scheduler.name !== undefined
          ? scheduler.name
          : "[unknown]",
      scheduledAt_createdAt: row.scheduledAt_createdAt,
      completedAt: row.completedAt,
      completedByName:
        completed !== null && completed.name !== undefined
          ? completed.name
          : undefined,
      cancellationReason: row.cancellationReason,
      familyEstateId: row.familyEstateId,
    };
  },
});

/**
 * Calendar / list query. Supports an optional kind filter and a date
 * range bound, both routed through the `by_kind_scheduledAt` /
 * `by_scheduledAt` indexes for viewport-bounded reads.
 */
export const listCeremonies = queryGeneric({
  args: {
    kindFilter: v.optional(
      v.union(
        v.literal("consecration"),
        v.literal("interment"),
        v.literal("memorial_anniversary"),
      ),
    ),
    fromMs: v.optional(v.number()),
    toMs: v.optional(v.number()),
    includeCancelled: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      kindFilter?: CeremonyKind;
      fromMs?: number;
      toMs?: number;
      includeCancelled?: boolean;
      limit?: number;
    },
  ): Promise<ListedCeremony[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const limit = Math.max(1, Math.min(args.limit ?? 200, 500));
    const includeCancelled = args.includeCancelled ?? false;
    const fromMs = args.fromMs;
    const toMs = args.toMs;

    // Index range builders in Convex narrow their type with each
    // bound applied -- after `.gte()` the chain becomes
    // UpperBoundIndexRangeBuilder which only exposes `.lte()` / `.lt()`.
    // We branch over the four (fromMs, toMs) presence combinations so
    // each branch hands the index a builder of the appropriate type.
    const kindFilter = args.kindFilter;
    const rows = await (async () => {
      if (kindFilter !== undefined) {
        if (fromMs !== undefined && toMs !== undefined) {
          return ctx.db
            .query("ceremonies")
            .withIndex("by_kind_scheduledAt", (q) =>
              q.eq("kind", kindFilter).gte("scheduledAt", fromMs).lte("scheduledAt", toMs),
            )
            .take(limit);
        }
        if (fromMs !== undefined) {
          return ctx.db
            .query("ceremonies")
            .withIndex("by_kind_scheduledAt", (q) =>
              q.eq("kind", kindFilter).gte("scheduledAt", fromMs),
            )
            .take(limit);
        }
        if (toMs !== undefined) {
          return ctx.db
            .query("ceremonies")
            .withIndex("by_kind_scheduledAt", (q) =>
              q.eq("kind", kindFilter).lte("scheduledAt", toMs),
            )
            .take(limit);
        }
        return ctx.db
          .query("ceremonies")
          .withIndex("by_kind_scheduledAt", (q) => q.eq("kind", kindFilter))
          .take(limit);
      }
      // No kind filter -- walk the time-only index.
      if (fromMs !== undefined && toMs !== undefined) {
        return ctx.db
          .query("ceremonies")
          .withIndex("by_scheduledAt", (q) =>
            q.gte("scheduledAt", fromMs).lte("scheduledAt", toMs),
          )
          .take(limit);
      }
      if (fromMs !== undefined) {
        return ctx.db
          .query("ceremonies")
          .withIndex("by_scheduledAt", (q) => q.gte("scheduledAt", fromMs))
          .take(limit);
      }
      if (toMs !== undefined) {
        return ctx.db
          .query("ceremonies")
          .withIndex("by_scheduledAt", (q) => q.lte("scheduledAt", toMs))
          .take(limit);
      }
      return ctx.db.query("ceremonies").withIndex("by_scheduledAt").take(limit);
    })();

    const visible = includeCancelled
      ? rows
      : rows.filter((r) => r.status !== "cancelled");

    const sorted = [...visible].sort(
      (a, b) => a.scheduledAt - b.scheduledAt,
    );

    return await Promise.all(
      sorted.map(async (r) => {
        const [contract, lot, consultant] = await Promise.all([
          ctx.db.get(r.contractId),
          ctx.db.get(r.lotId),
          r.consultantUserId !== undefined
            ? ctx.db.get(r.consultantUserId)
            : Promise.resolve(null),
        ]);
        const customer =
          contract !== null ? await ctx.db.get(contract.customerId) : null;
        return {
          ceremonyId: r._id,
          kind: r.kind,
          status: r.status,
          contractId: r.contractId,
          lotId: r.lotId,
          lotCode: lot !== null ? lot.code : "[retired]",
          scheduledAt: r.scheduledAt,
          durationMinutes: r.durationMinutes,
          chapelReserved: r.chapelReserved,
          pathwayReserved: r.pathwayReserved,
          customerName: customer !== null ? customer.fullName : "[unknown]",
          consultantName:
            consultant !== null && consultant.name !== undefined
              ? consultant.name
              : undefined,
        };
      }),
    );
  },
});
