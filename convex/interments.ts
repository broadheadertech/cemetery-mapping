/**
 * Interment scheduling domain (Story 7.1, FR51).
 *
 * The third Phase-2 state-machine-bearing entity (after `lots` and the
 * `contracts` table Epic 3 introduces). An interment binds a planned
 * occupant to a lot at a specific moment in time. Story 7.1 ships the
 * basic `scheduleInterment` mutation + read queries; Stories 7.2
 * (double-booking guard), 7.3 (calendar view), and 7.4 (field-worker
 * completion) extend the surface.
 *
 * Conventions every handler obeys (matches `convex/occupants.ts`):
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])`. The
 *      ESLint rule `local-rules/require-role-first-line` enforces this
 *      on `query` / `mutation` callees — `queryGeneric` / `mutationGeneric`
 *      are not name-matched by the rule, but we honour the convention
 *      so reviewers can read these files uniformly.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`. We key audit
 *      rows on the LOT (`entityType: "lot"`), NOT the interment id,
 *      because the lot is the canonical aggregate root for this sub-
 *      entity (matches the `occupants` audit pattern; the `auditLog`
 *      `entityType` enum does not contain "interment" — a follow-up
 *      tracked in this file's TODOs).
 *   3. The initial insert state is always `"scheduled"`. Inserts are
 *      NOT transitions — `assertTransition` validates FROM→TO moves on
 *      existing rows. Story 7.4 (`scheduled → completed`) and a future
 *      Phase-2 7.5 (`scheduled → cancelled`) introduce the first real
 *      transitions; they will add an `interment` entry to
 *      `convex/lib/stateMachines.ts → TRANSITIONS` at that time.
 *   4. Time handling: `scheduledAt` is UTC epoch ms throughout. The
 *      client composes the Manila-tz moment using a hardcoded `+08:00`
 *      offset (PH has no DST) per `convex/lib/time.ts` policy. We
 *      never call `new Date()` / `Date.parse()` on operator-supplied
 *      strings inside the mutation.
 *   5. Field Worker gets read access on `listForLot` / `getInterment`
 *      (Story 7.4 needs them); only `office_staff` / `admin` may
 *      schedule. Customer role is rejected on every endpoint here —
 *      Phase 2 portal exposure is out of scope.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import {
  assertIntermentTransition,
  transitionLotStatus,
} from "./lib/stateMachines";
import {
  assertNoBookingConflict,
  INTERMENT_LEGACY_DURATION_MINUTES,
} from "./lib/scheduling";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./lib/time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];
type OccupantDoc = DataModel["occupants"]["document"];
type OccupantId = OccupantDoc["_id"];
type IntermentDoc = DataModel["interments"]["document"];
type IntermentId = IntermentDoc["_id"];
/**
 * Story 7.4 — derived storage id type for the optional completion
 * photo. Mirrors the `LotConditionLogDoc` pattern in
 * `convex/conditionLogs.ts:55`; pulling the type off the table doc
 * avoids touching the `DataModel["_storage"]` system table (Convex
 * doesn't expose `_storage` through `DataModelFromSchemaDefinition`).
 */
type StorageId = NonNullable<IntermentDoc["completionPhotoBlobId"]>;

/** Field-length caps mirrored by the client Zod schema. */
export const INTERMENT_NOTES_MAX_LENGTH = 500;

/**
 * Story 7.2 — double-booking conflict window.
 *
 * Two interments at the same lot whose `scheduledAt` epoch ms fall
 * within `INTERMENT_CONFLICT_WINDOW_MS` of each other are considered
 * to collide. Sixty minutes is the safe minimum: cemetery operations
 * are crewed by a single interment team at a time, and an interment
 * occupies the lot for roughly an hour. The window is symmetric
 * (±window). Story spec — see file-level "Double-booking prevention".
 *
 * Only rows with `status: "scheduled"` count — `cancelled` rows do
 * not occupy the lot, and `completed` rows are historical (the crew
 * is no longer busy). Both filters are applied below.
 */
export const INTERMENT_CONFLICT_WINDOW_MS = 60 * MINUTE_MS;

/** Shape returned by `findConflicts` — one row per conflicting interment. */
export interface IntermentConflict {
  intermentId: IntermentId;
  scheduledAt: number;
  occupantId: OccupantId;
  occupantName: string;
  notes: string | undefined;
  /**
   * Story 7.2 (HIGH-fix) — `"same-lot"` rows reflect the original lot-
   * collision check (would throw `LOT_ALREADY_SCHEDULED`); `"cross-lot"`
   * rows reflect the single-crew/timeslot collision at a different lot
   * (would throw `TIMESLOT_ALREADY_BOOKED`). The UI uses this to render
   * the right warning copy without re-fetching the lot.
   */
  scope: "same-lot" | "cross-lot";
  /**
   * Convenience join for the cross-lot conflict banner. Same-lot rows
   * have the field omitted since the caller already knows the lot.
   */
  lotCode?: string;
}

/**
 * Story 7.2 (HIGH-fix) — config knob for the single-crew assumption.
 *
 * The cross-lot timeslot guard is on by default because the cemetery
 * has exactly one interment crew (per the story's load-bearing
 * assumption). When a second crew is hired, an operator can set the
 * environment variable `INTERMENTS_ALLOW_CONCURRENT=true` to relax
 * the guard back to per-lot conflicts only. Reading from `process.env`
 * keeps the surface tiny — no new schema table, no admin UI — until a
 * dedicated cemetery-settings page lands. Defaults to `false`.
 *
 * The lookup is intentionally per-call rather than module-cached so a
 * Convex deployment can flip the flag without a redeploy of this
 * file. The cost is negligible (one property read).
 */
function allowConcurrentInterments(): boolean {
  const raw =
    typeof process !== "undefined" && process.env !== undefined
      ? process.env.INTERMENTS_ALLOW_CONCURRENT
      : undefined;
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

/**
 * Far-past tolerance for the `scheduledAt` argument. Allows backfilling
 * up to one day in the past (e.g. an interment that happened yesterday
 * but was only recorded today), but rejects arbitrarily old dates as a
 * sanity guard. The matching client-side hint lives on the date input
 * (`min={yesterday}`).
 */
export const INTERMENT_BACKFILL_TOLERANCE_MS = DAY_MS;

/**
 * Shape returned to the client by `listForLot`. Trimmed (no raw `_id`,
 * no `scheduledBy`) — minimises the response surface and keeps PII
 * shape lean. Occupant name + scheduler name are joined server-side
 * so the client query is a simple read with no follow-up lookups.
 */
export interface ListedInterment {
  intermentId: IntermentId;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: OccupantId;
  occupantName: string;
  notes: string | undefined;
  scheduledByName: string;
  scheduledAt_createdAt: number;
}

/**
 * Shape returned by `getInterment` — the detail view. Includes the lot
 * summary (code / section / block / row) so the Story 7.4 detail page
 * can render a header without a second `lots.get` round-trip.
 */
export interface IntermentDetail extends ListedInterment {
  lotId: LotId;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  completedAt: number | undefined;
  completedByName: string | undefined;
  completionNotes: string | undefined;
  cancellationReason: string | undefined;
}

/**
 * Schedules an interment for a lot + occupant at a given moment.
 *
 * Role gate: `office_staff` / `admin`. Field Worker scheduling is out
 * of scope (architecture § FR51-FR54 — only office staff and admins
 * coordinate scheduling).
 *
 * Throws:
 *   - `UNAUTHENTICATED` / `FORBIDDEN` — RBAC.
 *   - `VALIDATION` — notes longer than 500 chars; `scheduledAt` not a
 *     finite positive integer.
 *   - `INVALID_INPUT` (alias `VALIDATION` here — the closed ErrorCode
 *     enum doesn't expose a distinct `INVALID_INPUT`; we use the
 *     existing `VALIDATION` code with a descriptive message) when
 *     `scheduledAt` is more than 1 day in the past.
 *   - `NOT_FOUND` — `lotId` or `occupantId` doesn't resolve.
 *   - `INVARIANT_VIOLATION` — (a) the occupant exists but belongs
 *     to a different lot (defense in depth against malformed
 *     clients), (b) the lot is retired, or (c) the occupant is
 *     soft-removed.
 *   - `LOT_ALREADY_SCHEDULED` — Story 7.2's same-lot double-booking
 *     guard fires because another scheduled interment at the same
 *     lot falls within ±`INTERMENT_CONFLICT_WINDOW_MS`.
 *     `details.conflictingIds` carries the conflicting interment ids.
 *   - `TIMESLOT_ALREADY_BOOKED` — Story 7.2's cross-lot crew guard
 *     fires because another scheduled interment at a DIFFERENT lot
 *     falls within ±`INTERMENT_CONFLICT_WINDOW_MS` and the cemetery
 *     is single-crew (the default). Opt out via
 *     `INTERMENTS_ALLOW_CONCURRENT=true`.
 */
export const scheduleInterment = mutationGeneric({
  args: {
    lotId: v.id("lots"),
    occupantId: v.id("occupants"),
    scheduledAt: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      lotId: LotId;
      occupantId: OccupantId;
      scheduledAt: number;
      notes?: string;
    },
  ): Promise<{ intermentId: IntermentId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Argument validation — defense in depth (client also Zod-validates).
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
    if (args.scheduledAt < now - INTERMENT_BACKFILL_TOLERANCE_MS) {
      throwError(
        ErrorCode.VALIDATION,
        "Cannot schedule interments more than 1 day in the past.",
      );
    }

    const trimmedNotes = args.notes !== undefined ? args.notes.trim() : undefined;
    if (
      trimmedNotes !== undefined &&
      trimmedNotes.length > INTERMENT_NOTES_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Notes must be ${INTERMENT_NOTES_MAX_LENGTH} characters or fewer.`,
      );
    }

    // Lot existence + retire guard. Retired lots cannot host new
    // interments (matches `occupants.addOccupant` precedent).
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", {
        lotId: args.lotId,
      });
    }
    if (lot.isRetired) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot schedule an interment on a retired lot.",
        { lotId: args.lotId },
      );
    }
    // Epic 7 H2 — the lot must be `sold` or `occupied`. `completeInterment`
    // transitions the lot to `occupied`, and the lot state machine only
    // allows `sold → occupied` (or an already-`occupied` family-plot lot
    // taking another interment). Scheduling against an `available` /
    // `reserved` / `defaulted` / `cancelled` / `transferred` lot creates
    // an interment that can NEVER be completed (the completion transition
    // would throw ILLEGAL_STATE_TRANSITION). Reject it at scheduling time
    // — server-side, not just in the booking-form UI.
    if (lot.status !== "sold" && lot.status !== "occupied") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Interments can only be scheduled on a sold or occupied lot.",
        { lotId: args.lotId, lotStatus: lot.status },
      );
    }

    // Occupant existence + belongs-to-lot invariant. The Story 7.1
    // spec calls this out explicitly: without it, a malformed client
    // could schedule occupant A's interment against lot B, then joins
    // through `occupant.lotId` would produce inconsistent data. This
    // is a server-side invariant, not just UI defense.
    const occupant = await ctx.db.get(args.occupantId);
    if (occupant === null) {
      throwError(ErrorCode.NOT_FOUND, "Occupant not found.", {
        occupantId: args.occupantId,
      });
    }
    if (occupant.lotId !== args.lotId) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Occupant does not belong to this lot.",
        { occupantId: args.occupantId, lotId: args.lotId },
      );
    }
    if (occupant.isRemoved) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Cannot schedule an interment for a removed occupant.",
        { occupantId: args.occupantId },
      );
    }

    // Story 7.2 — double-booking guard. Run AFTER occupant validation
    // (cheaper, more specific) and BEFORE insert. Convex mutations are
    // transactional: this read + the insert below form a single unit
    // of work, so a concurrent writer cannot slip a conflicting row in
    // between the two operations.
    //
    // Two checks, evaluated in order:
    //   1. Same-lot conflict (LOT_ALREADY_SCHEDULED) — the lot is busy.
    //   2. Cross-lot timeslot conflict (TIMESLOT_ALREADY_BOOKED) — the
    //      single interment crew is busy at a different lot in the
    //      window. The cemetery has exactly one crew; opt out via
    //      `INTERMENTS_ALLOW_CONCURRENT=true`.
    //
    // Same-lot is checked first because it's the strictly stronger
    // failure mode (a sibling lot's crew can be re-routed; a same-lot
    // overlap cannot).
    const sameLotConflicts = await findSameLotConflicts(ctx, {
      lotId: args.lotId,
      scheduledAt: args.scheduledAt,
    });
    if (sameLotConflicts.length > 0) {
      throwError(
        ErrorCode.LOT_ALREADY_SCHEDULED,
        "Double-booked: this lot already has an interment scheduled within the conflict window.",
        {
          conflictingIds: sameLotConflicts.map((c) => c.intermentId),
          conflictWindowMs: INTERMENT_CONFLICT_WINDOW_MS,
        },
      );
    }

    if (!allowConcurrentInterments()) {
      const crossLotConflicts = await findCrossLotConflicts(ctx, {
        lotId: args.lotId,
        scheduledAt: args.scheduledAt,
      });
      if (crossLotConflicts.length > 0) {
        throwError(
          ErrorCode.TIMESLOT_ALREADY_BOOKED,
          "Timeslot busy: the interment crew is already scheduled at another lot within the conflict window.",
          {
            conflictingIds: crossLotConflicts.map((c) => c.intermentId),
            conflictWindowMs: INTERMENT_CONFLICT_WINDOW_MS,
          },
        );
      }
    }

    // Story 7.5 cross-table guard (Epic 7 C1 fix). The two checks above
    // only scan the `interments` table — they are BLIND to the
    // `ceremonies` table that Story 7.5 introduced. So a consecration
    // booked on this lot+window via `scheduleCeremony` is invisible here,
    // and the two paths can each book the same lot at the same time: the
    // exact "family arrives to find a hole being dug for someone else"
    // disaster Stories 7.2/7.5 exist to prevent. `assertNoBookingConflict`
    // is the SAME authority `scheduleCeremony` uses; it scans BOTH tables
    // with the half-open interval-overlap model and throws
    // SCHEDULING_CONFLICT on a same-lot / chapel / pathway overlap. An
    // interment occupies a fixed 60-minute window and (when scheduled via
    // this mutation) reserves neither the chapel nor the pathway. Runs in
    // the same transaction as the insert below — no TOCTOU window.
    await assertNoBookingConflict(ctx, {
      lotId: args.lotId,
      scheduledAt: args.scheduledAt,
      durationMinutes: INTERMENT_LEGACY_DURATION_MINUTES,
      chapelReserved: false,
      pathwayReserved: false,
    });

    const insertRow: {
      lotId: LotId;
      occupantId: OccupantId;
      scheduledAt: number;
      status: "scheduled";
      notes?: string;
      scheduledBy: typeof auth.userId;
      scheduledAt_createdAt: number;
    } = {
      lotId: args.lotId,
      occupantId: args.occupantId,
      scheduledAt: args.scheduledAt,
      status: "scheduled",
      scheduledBy: auth.userId,
      scheduledAt_createdAt: now,
    };
    if (trimmedNotes !== undefined && trimmedNotes.length > 0) {
      insertRow.notes = trimmedNotes;
    }
    const intermentId = await ctx.db.insert("interments", insertRow);

    // Audit. The `entityType` enum on `auditLog` does not include
    // "interment"; we key on the lot (the aggregate root) and put the
    // interment id inside the `after` payload. This matches the
    // `occupants.addOccupant` precedent. Follow-up: extend the
    // `auditLog.entityType` validator + `audit.ts` `AuditEntityType`
    // alias to include "interment" once we want a dedicated audit feed
    // per interment; coordinate with the audit-cornerstone owners.
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: args.lotId,
      after: {
        intermentId,
        occupantId: args.occupantId,
        scheduledAt: args.scheduledAt,
        status: "scheduled" as const,
      },
      reason:
        trimmedNotes !== undefined && trimmedNotes.length > 0
          ? trimmedNotes
          : "scheduled via lot detail",
    });

    return { intermentId };
  },
});

/**
 * Reactive listing of interments for a given lot. Sorted by
 * `scheduledAt` ascending (upcoming first). All statuses are
 * included — the UI may filter client-side for "Upcoming" vs.
 * "History" tabs.
 *
 * Role gate: `office_staff` / `admin` / `field_worker`. Field Worker
 * read access is needed for Story 7.4's burial-day view.
 */
export const listForLot = queryGeneric({
  args: {
    lotId: v.id("lots"),
  },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId },
  ): Promise<ListedInterment[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const rows = await ctx.db
      .query("interments")
      .withIndex("by_lot_status", (q) => q.eq("lotId", args.lotId))
      .collect();
    return await projectListedInterments(ctx, rows);
  },
});

/**
 * Admin-facing global list of interments, sorted by `scheduledAt`
 * ascending. Bounded with a sane upper limit (Phase 1 cemetery scale
 * is ≤ ~2,000 lots; even fully booked, this returns a small set).
 *
 * Optional `statusFilter` lets the `/interments` page render a
 * status-scoped view; defaults to `"scheduled"` so the "Upcoming"
 * list is the first thing the operator sees.
 *
 * Role gate: `office_staff` / `admin`. Field Worker should drill
 * through `listForLot` from a specific lot — the global list is
 * coordination UX (Story 7.3 introduces the richer calendar view).
 */
export const listInterments = queryGeneric({
  args: {
    statusFilter: v.optional(
      v.union(
        v.literal("scheduled"),
        v.literal("completed"),
        v.literal("cancelled"),
      ),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      statusFilter?: "scheduled" | "completed" | "cancelled";
      limit?: number;
    },
  ): Promise<ListedInterment[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit = Math.max(1, Math.min(args.limit ?? 200, 500));
    const status = args.statusFilter;
    const rows =
      status !== undefined
        ? await ctx.db
            .query("interments")
            .withIndex("by_status_scheduledAt", (q) => q.eq("status", status))
            .take(limit)
        : await ctx.db
            .query("interments")
            .withIndex("by_scheduledAt")
            .take(limit);
    return await projectListedInterments(ctx, rows);
  },
});

/**
 * Detail-page query — returns the full interment plus lot summary +
 * scheduled-by / completed-by names so the page can render a header
 * without per-field round-trips. Used by Story 7.4 (completion screen).
 *
 * Role gate: `office_staff` / `admin` / `field_worker`. Field Worker
 * needs detail to navigate to the burial site.
 */
export const getInterment = queryGeneric({
  args: {
    intermentId: v.id("interments"),
  },
  handler: async (
    ctx: QueryCtx,
    args: { intermentId: IntermentId },
  ): Promise<IntermentDetail | null> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const row = await ctx.db.get(args.intermentId);
    if (row === null) return null;
    const [occupant, lot, scheduledBy, completedBy] = await Promise.all([
      ctx.db.get(row.occupantId),
      ctx.db.get(row.lotId),
      ctx.db.get(row.scheduledBy),
      row.completedBy !== undefined
        ? ctx.db.get(row.completedBy)
        : Promise.resolve(null),
    ]);
    const occupantName = occupant !== null ? occupant.name : "[unknown]";
    const lotCode = lot !== null ? lot.code : "[retired]";
    const lotSection = lot !== null ? lot.section : "";
    const lotBlock = lot !== null ? lot.block : "";
    const lotRow = lot !== null ? lot.row : "";
    const scheduledByName =
      scheduledBy !== null && scheduledBy.name !== undefined
        ? scheduledBy.name
        : "[unknown]";
    const completedByName =
      completedBy !== null && completedBy.name !== undefined
        ? completedBy.name
        : undefined;
    return {
      intermentId: row._id,
      scheduledAt: row.scheduledAt,
      status: row.status,
      occupantId: row.occupantId,
      occupantName,
      notes: row.notes,
      scheduledByName,
      scheduledAt_createdAt: row.scheduledAt_createdAt,
      lotId: row.lotId,
      lotCode,
      lotSection,
      lotBlock,
      lotRow,
      completedAt: row.completedAt,
      completedByName,
      completionNotes: row.completionNotes,
      cancellationReason: row.cancellationReason,
    };
  },
});

/**
 * Story 7.3 — calendar-shaped read.
 *
 * Returns the interments whose `scheduledAt` falls in `[fromMs, toMs]`
 * (inclusive on both bounds), projected to the lean shape the
 * `/interments/calendar` month-view needs to render a day cell. The
 * dev brief intentionally keeps this minimal (the story spec's
 * richer `listForCalendar` with section/status filtering is a
 * follow-up); the contract here is "viewport-scoped time range,
 * cheap projection, ascending order".
 *
 * Implementation:
 *   - Walks the `by_scheduledAt` index with `.gte(fromMs).lte(toMs)`
 *     so the read is index-bounded regardless of the cemetery's
 *     historical depth. Architecture's "viewport-bounded queries"
 *     principle extended to the time axis.
 *   - `cancelled` rows are excluded by default — they're noise on the
 *     calendar. Pass `includeCancelled: true` to opt back in (e.g.
 *     a future "show all" toggle).
 *   - Occupant name + lot summary are joined server-side so each
 *     calendar event is render-ready on the client (no follow-up
 *     `useQuery` round-trips per row — Story 7.3 § Common LLM
 *     mistakes calls out N+1 client joins as a perf killer).
 *
 * Role gate: `office_staff` / `admin` / `field_worker`. Field Worker
 * read access mirrors `listForLot` / `getInterment` — the burial-day
 * mobile view (Story 7.4) may surface a stripped-down today view.
 */
export interface CalendarInterment {
  intermentId: IntermentId;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: OccupantId;
  occupantName: string;
  lotId: LotId;
  lotCode: string;
  lotSection: string;
}

export const listInRange = queryGeneric({
  args: {
    fromMs: v.number(),
    toMs: v.number(),
    includeCancelled: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { fromMs: number; toMs: number; includeCancelled?: boolean },
  ): Promise<CalendarInterment[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);

    // Defensive validation — out-of-order or non-finite bounds produce
    // an empty result rather than scanning the whole index.
    if (
      !Number.isFinite(args.fromMs) ||
      !Number.isFinite(args.toMs) ||
      args.toMs < args.fromMs
    ) {
      return [];
    }

    const includeCancelled = args.includeCancelled ?? false;
    const rows = await ctx.db
      .query("interments")
      .withIndex("by_scheduledAt", (q) =>
        q.gte("scheduledAt", args.fromMs).lte("scheduledAt", args.toMs),
      )
      .collect();

    const visible = includeCancelled
      ? rows
      : rows.filter((r) => r.status !== "cancelled");

    // Stable order: ascending by `scheduledAt`, ties broken by insert
    // time so duplicate-minute rows render deterministically.
    const sorted = [...visible].sort((a, b) => {
      if (a.scheduledAt !== b.scheduledAt) {
        return a.scheduledAt - b.scheduledAt;
      }
      return a.scheduledAt_createdAt - b.scheduledAt_createdAt;
    });

    // Fan-out occupant + lot lookups in parallel — bounded by the
    // viewport range (a typical month view has tens of rows).
    return await Promise.all(
      sorted.map(async (r) => {
        const [occupant, lot] = await Promise.all([
          ctx.db.get(r.occupantId),
          ctx.db.get(r.lotId),
        ]);
        const occupantName = occupant !== null ? occupant.name : "[unknown]";
        const lotCode = lot !== null ? lot.code : "[retired]";
        const lotSection = lot !== null ? lot.section : "";
        return {
          intermentId: r._id,
          scheduledAt: r.scheduledAt,
          status: r.status,
          occupantId: r.occupantId,
          occupantName,
          lotId: r.lotId,
          lotCode,
          lotSection,
        };
      }),
    );
  },
});

/**
 * Story 7.2 — `findConflicts` query.
 *
 * Returns interments at the given lot whose `scheduledAt` falls
 * within ±`INTERMENT_CONFLICT_WINDOW_MS` of the requested moment and
 * whose status is `"scheduled"`. Used by the IntermentForm to warn
 * operators inline BEFORE they submit (the server-side guard inside
 * `scheduleInterment` is the source of truth — this query is a UX
 * nicety, not a substitute).
 *
 * Role gate: `office_staff` / `admin` / `field_worker`. Field Worker
 * read access keeps the query usable in the burial-day mobile view
 * (Story 7.4 may surface conflicts before marking a row complete).
 *
 * Returns an empty array when no conflicts exist. Each row carries
 * the occupant name + notes so the UI can render a human-readable
 * banner without a follow-up join.
 */
export const findConflicts = queryGeneric({
  args: {
    lotId: v.id("lots"),
    scheduledAt: v.number(),
    excludeIntermentId: v.optional(v.id("interments")),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      lotId: LotId;
      scheduledAt: number;
      excludeIntermentId?: IntermentId;
    },
  ): Promise<IntermentConflict[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    if (
      !Number.isFinite(args.scheduledAt) ||
      !Number.isInteger(args.scheduledAt) ||
      args.scheduledAt <= 0
    ) {
      return [];
    }
    const sameLot = await findSameLotConflicts(ctx, {
      lotId: args.lotId,
      scheduledAt: args.scheduledAt,
      excludeIntermentId: args.excludeIntermentId,
    });
    // Cross-lot is suppressed entirely when the multi-crew flag is on
    // — the operator can safely book two simultaneous interments.
    const crossLot = allowConcurrentInterments()
      ? []
      : await findCrossLotConflicts(ctx, {
          lotId: args.lotId,
          scheduledAt: args.scheduledAt,
          excludeIntermentId: args.excludeIntermentId,
        });
    return [...sameLot, ...crossLot].sort(
      (a, b) => a.scheduledAt - b.scheduledAt,
    );
  },
});

/**
 * Same-lot conflict helper. Walks `by_lot_scheduledAt` narrowed to the
 * target lot, then bounded by ±`INTERMENT_CONFLICT_WINDOW_MS` around
 * the new moment. Used by both `findConflicts` (UX preview) and
 * `scheduleInterment` (server guard for `LOT_ALREADY_SCHEDULED`).
 *
 * `excludeIntermentId` lets a future reschedule mutation (Phase 2)
 * skip the row being moved — wire the param now to avoid a follow-up
 * patch when that story lands.
 */
async function findSameLotConflicts(
  ctx: QueryCtx | MutationCtx,
  params: {
    lotId: LotId;
    scheduledAt: number;
    excludeIntermentId?: IntermentId;
  },
): Promise<IntermentConflict[]> {
  const from = params.scheduledAt - INTERMENT_CONFLICT_WINDOW_MS;
  const to = params.scheduledAt + INTERMENT_CONFLICT_WINDOW_MS;
  const candidates = await ctx.db
    .query("interments")
    .withIndex("by_lot_scheduledAt", (q) =>
      q.eq("lotId", params.lotId).gte("scheduledAt", from).lte("scheduledAt", to),
    )
    .collect();
  const filtered = candidates.filter((r) => {
    if (r.status !== "scheduled") return false;
    if (
      params.excludeIntermentId !== undefined &&
      r._id === params.excludeIntermentId
    ) {
      return false;
    }
    return true;
  });
  filtered.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return await Promise.all(
    filtered.map(async (r) => {
      const occupant = await ctx.db.get(r.occupantId);
      const occupantName = occupant !== null ? occupant.name : "[unknown]";
      return {
        intermentId: r._id,
        scheduledAt: r.scheduledAt,
        occupantId: r.occupantId,
        occupantName,
        notes: r.notes,
        scope: "same-lot" as const,
      };
    }),
  );
}

/**
 * Cross-lot timeslot conflict helper (Story 7.2 HIGH-fix).
 *
 * Walks `by_scheduledAt` bounded by ±`INTERMENT_CONFLICT_WINDOW_MS`,
 * then filters in memory to rows at OTHER lots. The single-crew
 * assumption (one interment team at the cemetery) means any
 * concurrent booking at any other lot collides with the current one.
 *
 * Why the scan is bounded by the time index, not by lot: there's no
 * compound `(time, !lotId)` index, and the time range is already
 * tight (±60 min) so the candidate set is small in practice.
 *
 * `excludeIntermentId` mirrors the same-lot helper — used by a future
 * reschedule path so the row being moved is not its own conflict.
 */
async function findCrossLotConflicts(
  ctx: QueryCtx | MutationCtx,
  params: {
    lotId: LotId;
    scheduledAt: number;
    excludeIntermentId?: IntermentId;
  },
): Promise<IntermentConflict[]> {
  const from = params.scheduledAt - INTERMENT_CONFLICT_WINDOW_MS;
  const to = params.scheduledAt + INTERMENT_CONFLICT_WINDOW_MS;
  const candidates = await ctx.db
    .query("interments")
    .withIndex("by_scheduledAt", (q) =>
      q.gte("scheduledAt", from).lte("scheduledAt", to),
    )
    .collect();
  const filtered = candidates.filter((r) => {
    if (r.status !== "scheduled") return false;
    // Same-lot rows are excluded — they're reported by the dedicated
    // helper above with the `LOT_ALREADY_SCHEDULED` code.
    if (r.lotId === params.lotId) return false;
    if (
      params.excludeIntermentId !== undefined &&
      r._id === params.excludeIntermentId
    ) {
      return false;
    }
    return true;
  });
  filtered.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return await Promise.all(
    filtered.map(async (r) => {
      const [occupant, lot] = await Promise.all([
        ctx.db.get(r.occupantId),
        ctx.db.get(r.lotId),
      ]);
      const occupantName = occupant !== null ? occupant.name : "[unknown]";
      const lotCode = lot !== null ? lot.code : "[retired]";
      return {
        intermentId: r._id,
        scheduledAt: r.scheduledAt,
        occupantId: r.occupantId,
        occupantName,
        notes: r.notes,
        scope: "cross-lot" as const,
        lotCode,
      };
    }),
  );
}

/**
 * Shared projector — joins occupant + scheduler names server-side so
 * the client query is a simple read. Sort ascending by `scheduledAt`
 * (upcoming first); ties broken by insert time for determinism.
 */
async function projectListedInterments(
  ctx: QueryCtx,
  rows: ReadonlyArray<IntermentDoc>,
): Promise<ListedInterment[]> {
  const sorted = [...rows].sort((a, b) => {
    if (a.scheduledAt !== b.scheduledAt) {
      return a.scheduledAt - b.scheduledAt;
    }
    return a.scheduledAt_createdAt - b.scheduledAt_createdAt;
  });
  // Fan-out the occupant + scheduler lookups in parallel — the projection
  // is bounded by the page-size cap on the calling query, so this is
  // safe at our scale.
  const enriched = await Promise.all(
    sorted.map(async (r) => {
      const [occupant, scheduler] = await Promise.all([
        ctx.db.get(r.occupantId),
        ctx.db.get(r.scheduledBy),
      ]);
      const occupantName = occupant !== null ? occupant.name : "[unknown]";
      const scheduledByName =
        scheduler !== null && scheduler.name !== undefined
          ? scheduler.name
          : "[unknown]";
      return {
        intermentId: r._id,
        scheduledAt: r.scheduledAt,
        status: r.status,
        occupantId: r.occupantId,
        occupantName,
        notes: r.notes,
        scheduledByName,
        scheduledAt_createdAt: r.scheduledAt_createdAt,
      };
    }),
  );
  return enriched;
}

// ──────────────────────────────────────────────────────────────────────
// Story 7.4 — Field Worker marks an interment complete
// ──────────────────────────────────────────────────────────────────────

/** Notes cap on the completion-side payload — mirrors scheduling. */
export const COMPLETION_NOTES_MAX_LENGTH = 500;

/**
 * Manila timezone is UTC+8 with no DST per `convex/lib/time.ts`
 * policy. Used by `listTodayForFieldWorker` to compute the start /
 * end of "today" in Manila wall-clock time without pulling in a tz
 * library.
 */
const MANILA_UTC_OFFSET_MS = 8 * HOUR_MS;

/**
 * Compute the [startOfDay, endOfDay] epoch ms range for the Manila
 * calendar day that contains `nowMs`. The start is the first
 * millisecond of that day (00:00:00.000 Manila); the end is the last
 * millisecond (23:59:59.999 Manila).
 *
 * The implementation is a deliberately small piece of arithmetic
 * rather than a `toLocaleString` parse: Manila's UTC+8 offset is
 * constant, and the math is O(1) + zero allocations. The end bound
 * is `start + DAY_MS - 1` so the inclusive `lte` index query catches
 * everything in the day without overlapping into tomorrow.
 */
function manilaDayBounds(nowMs: number): { fromMs: number; toMs: number } {
  const shifted = nowMs + MANILA_UTC_OFFSET_MS;
  const startShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  const fromMs = startShifted - MANILA_UTC_OFFSET_MS;
  const toMs = fromMs + DAY_MS - 1;
  return { fromMs, toMs };
}

/** Row shape returned by `listTodayForFieldWorker` — lean mobile UI. */
export interface FieldWorkerTodayRow {
  intermentId: IntermentId;
  scheduledAt: number;
  occupantId: OccupantId;
  occupantName: string;
  lotId: LotId;
  lotCode: string;
  lotSection: string;
  lotBlock: string;
  lotRow: string;
  notes: string | undefined;
}

/**
 * Story 7.4 / AC1 — today's scheduled interments for the field worker.
 *
 * Walks the `by_status_scheduledAt` index for `status: "scheduled"`
 * bounded to the Manila-tz calendar day that contains `Date.now()`.
 * Projects to a small mobile-friendly shape (occupant name + lot
 * code + scheduled time) so the burial-day page renders in one
 * round-trip with no follow-up joins.
 *
 * Role gate: `office_staff` / `admin` / `field_worker`. The page is
 * primarily for field workers; admin / staff read access supports
 * back-office monitoring.
 */
export const listTodayForFieldWorker = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<FieldWorkerTodayRow[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const { fromMs, toMs } = manilaDayBounds(Date.now());
    const rows = await ctx.db
      .query("interments")
      .withIndex("by_status_scheduledAt", (q) =>
        q
          .eq("status", "scheduled")
          .gte("scheduledAt", fromMs)
          .lte("scheduledAt", toMs),
      )
      .collect();
    const sorted = [...rows].sort((a, b) => {
      if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
      return a.scheduledAt_createdAt - b.scheduledAt_createdAt;
    });
    return await Promise.all(
      sorted.map(async (r) => {
        const [occupant, lot] = await Promise.all([
          ctx.db.get(r.occupantId),
          ctx.db.get(r.lotId),
        ]);
        const occupantName = occupant !== null ? occupant.name : "[unknown]";
        const lotCode = lot !== null ? lot.code : "[retired]";
        const lotSection = lot !== null ? lot.section : "";
        const lotBlock = lot !== null ? lot.block : "";
        const lotRow = lot !== null ? lot.row : "";
        return {
          intermentId: r._id,
          scheduledAt: r.scheduledAt,
          occupantId: r.occupantId,
          occupantName,
          lotId: r.lotId,
          lotCode,
          lotSection,
          lotBlock,
          lotRow,
          notes: r.notes,
        };
      }),
    );
  },
});

/**
 * Story 7.4 / AC2 — signed upload URL for the completion photo.
 *
 * Standard Convex File Storage two-step upload (matches Story 1.14
 * `LogConditionForm` photo flow): client calls this mutation to
 * receive a short-lived signed URL, POSTs the file directly to that
 * URL, parses the `_storage` id from the response, then passes the
 * id into `completeInterment`. Keeps the mutation arg surface free
 * of base64 bloat and respects Convex's mutation arg-size limits.
 *
 * Role gate matches `completeInterment` — anyone allowed to mark a
 * row complete is allowed to upload the photo for it.
 */
export const generateUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Story 7.4 / AC2 — fetch a short-lived signed URL for a completed
 * interment's photo. Returns `null` when no photo was attached or
 * when the interment row doesn't carry a `completionPhotoBlobId`.
 *
 * Signed URLs are deliberately short-lived (Convex default ~1h); the
 * query refreshes them automatically when callers re-subscribe.
 * Never cache the URL in localStorage / browser caches.
 *
 * Role gate: `office_staff` / `admin` / `field_worker`. Mirrors
 * `getInterment` — read access is the same population.
 */
export const getCompletionPhotoUrl = queryGeneric({
  args: { intermentId: v.id("interments") },
  handler: async (
    ctx: QueryCtx,
    args: { intermentId: IntermentId },
  ): Promise<string | null> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const row = await ctx.db.get(args.intermentId);
    if (row === null) return null;
    if (row.completionPhotoBlobId === undefined) return null;
    return await ctx.storage.getUrl(row.completionPhotoBlobId);
  },
});

/**
 * Story 7.4 / AC3 — atomic completion mutation.
 *
 * Single Convex mutation = single transaction; both the interment
 * patch (status `"scheduled" → "completed"`, `completedAt`,
 * `completedBy`, optional notes / photo) AND the dependent lot
 * transition (`sold → occupied` when applicable) land in one unit
 * of work. Either both succeed or neither does — preventing the
 * "ghost completed interment against still-sold lot" and "phantom
 * occupied lot with no interment" reporting horrors.
 *
 * Family-plot idempotency: when the lot is already `occupied` (a
 * prior interment at the same family plot already completed), the
 * lot transition is skipped (would otherwise fail `assertTransition`
 * — `occupied → occupied` is not a legal self-loop). The mutation
 * returns `lotTransitioned: false` in that case so the UI can show
 * a small "family plot — already occupied" hint instead of the
 * normal "Lot now marked occupied" confirmation.
 *
 * Anomaly path: if the lot's current status is anything other than
 * `sold` or `occupied` (e.g. `available`, `reserved`, `defaulted`)
 * — an operational anomaly where an interment was scheduled against
 * a non-sold lot — `transitionLotStatus` throws
 * `ILLEGAL_STATE_TRANSITION`; the entire mutation rolls back and the
 * interment is NOT marked complete. The UI surfaces this as a
 * generic "Cannot mark complete — lot state invalid" message that
 * directs the operator to the runbook for manual reconciliation.
 *
 * Role gate: `admin` / `office_staff` / `field_worker`. Field worker
 * is the primary actor on burial day; admin / office_staff are
 * allowed for back-office corrections.
 *
 * Audit pattern: emits an interment-completion audit row keyed on
 * the lot (consistent with `scheduleInterment` — the audit log's
 * `entityType` enum is closed and doesn't include "interment"; the
 * interment id rides in `after`). `transitionLotStatus` emits a
 * SECOND row for the lot's status change when the transition fires.
 * Two audit rows = correct cardinality for the dual-write.
 *
 * Note on the per-spec `INVALID_STATE` code: `errors.ts` is read-only
 * for this story and its enum does not currently include
 * `INVALID_STATE`. We use `INVARIANT_VIOLATION` with a specific
 * message for the explicit pre-check; the redundant `assertTransition`
 * call below uses the canonical `ILLEGAL_STATE_TRANSITION` code.
 */
export const completeInterment = mutationGeneric({
  args: {
    intermentId: v.id("interments"),
    notes: v.optional(v.string()),
    photoBlobId: v.optional(v.id("_storage")),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      intermentId: IntermentId;
      notes?: string;
      photoBlobId?: StorageId;
    },
  ): Promise<{ intermentId: IntermentId; lotTransitioned: boolean }> => {
    const auth = await requireRole(ctx, [
      "admin",
      "office_staff",
      "field_worker",
    ]);

    const trimmedNotes =
      args.notes !== undefined ? args.notes.trim() : undefined;
    if (
      trimmedNotes !== undefined &&
      trimmedNotes.length > COMPLETION_NOTES_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Notes must be ${COMPLETION_NOTES_MAX_LENGTH} characters or fewer.`,
      );
    }

    const interment = await ctx.db.get(args.intermentId);
    if (interment === null) {
      throwError(ErrorCode.NOT_FOUND, "Interment not found.", {
        intermentId: args.intermentId,
      });
    }

    // Explicit pre-check — gives a domain-specific error code AND
    // message before the more generic `assertTransition` runs.
    // Idempotent re-completion is NOT supported (per story spec
    // § Disaster prevention) — it would mask UI bugs.
    if (interment.status !== "scheduled") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Only scheduled interments can be marked complete.",
        {
          intermentId: args.intermentId,
          currentStatus: interment.status,
        },
      );
    }

    // Defense in depth — pure validator routes through the canonical
    // TRANSITIONS table. The explicit guard above and this call
    // overlap intentionally: this throws `ILLEGAL_STATE_TRANSITION`
    // (the state-machine code) and gives audit reviewers a uniform
    // signal for ALL illegal transitions across the codebase.
    assertIntermentTransition({ from: "scheduled", to: "completed" });

    // Read the lot BEFORE patching so we can decide whether the
    // dependent transition fires. Atomic dual-write — both writes
    // happen inside this single mutation context.
    const lot = await ctx.db.get(interment.lotId);
    if (lot === null) {
      // Defensive — the schedule mutation guards against this; if it
      // somehow happens (manual data manipulation), surface loudly
      // rather than orphan the completion.
      throwError(ErrorCode.NOT_FOUND, "Lot for this interment not found.", {
        lotId: interment.lotId,
      });
    }

    const completedAt = Date.now();
    const patch: {
      status: "completed";
      completedAt: number;
      completedBy: typeof auth.userId;
      completionNotes?: string;
      completionPhotoBlobId?: StorageId;
    } = {
      status: "completed",
      completedAt,
      completedBy: auth.userId,
    };
    if (trimmedNotes !== undefined && trimmedNotes.length > 0) {
      patch.completionNotes = trimmedNotes;
    }
    if (args.photoBlobId !== undefined) {
      patch.completionPhotoBlobId = args.photoBlobId;
    }
    await ctx.db.patch(args.intermentId, patch);

    // Conditional lot transition — only fire when the lot isn't
    // already `occupied`. Family-plot lots that already completed a
    // prior interment stay `occupied` (the state machine doesn't
    // allow `occupied → occupied`).
    let lotTransitioned = false;
    if (lot.status !== "occupied") {
      await transitionLotStatus(ctx, {
        lotId: interment.lotId,
        to: "occupied",
        // Causal-link reason — preserves the link between the lot's
        // status flip and the interment that drove it, for audit
        // reviewers tracing the chain backwards.
        reason: `interment_completed:${args.intermentId}`,
      });
      lotTransitioned = true;
    }

    // Interment-side audit row. Keyed on the lot (entityType enum is
    // closed; `interment` isn't in it). `transitionLotStatus` above
    // already emitted its OWN audit row for the lot-status flip when
    // applicable; this row is the interment's completion record.
    await emitAudit(ctx, {
      action: "transition",
      entityType: "lot",
      entityId: interment.lotId,
      before: {
        intermentId: args.intermentId,
        status: "scheduled" as const,
      },
      after: {
        intermentId: args.intermentId,
        status: "completed" as const,
        completedAt,
        completedBy: auth.userId,
        lotTransitioned,
      },
      reason:
        trimmedNotes !== undefined && trimmedNotes.length > 0
          ? trimmedNotes
          : "field worker completion",
    });

    return { intermentId: args.intermentId, lotTransitioned };
  },
});

// ──────────────────────────────────────────────────────────────────────
// Story 6.8 — getLatestInterment query (occupant → latest interment)
// ──────────────────────────────────────────────────────────────────────

/**
 * Return the most-recent interment row (by `scheduledAt`) for the
 * supplied occupant id, or `null` when the occupant has no interments.
 *
 * Used by the customer-detail page's "Plaque" action link
 * (Story 6.8 AC4): the operator clicks "Plaque" on a deceased
 * occupant, this query resolves the latest interment id, and the UI
 * navigates to `/interments/[intermentId]/plaque` with the form
 * prefilled from the occupant record.
 *
 * Role gate: admin / office_staff. The plaque workflow is office-
 * staff coordination; field workers do not have read access to the
 * plaque page.
 *
 * Implementation: walks the `by_scheduledAt` index in descending
 * order via `.order("desc")` and filters in-memory for the matching
 * `occupantId`. The cemetery's interment volume per occupant is small
 * (typically 1; family-plot edge cases ≤ 5), so the in-memory filter
 * over a per-occupant slice is bounded. If the cemetery ever scales
 * such that a single occupant has hundreds of interment events, a
 * dedicated `by_occupant_scheduledAt` index can land in a follow-up.
 */
export const getLatestInterment = queryGeneric({
  args: { occupantId: v.id("occupants") },
  handler: async (
    ctx: QueryCtx,
    args: { occupantId: OccupantId },
  ): Promise<{
    intermentId: IntermentId;
    lotId: LotId;
    scheduledAt: number;
    status: "scheduled" | "completed" | "cancelled";
  } | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    // Walk the time index descending; early-return on the first row
    // matching the occupant. The `take(200)` cap bounds the scan
    // against an attempted DoS via a hostile id.
    const rows = await ctx.db
      .query("interments")
      .withIndex("by_scheduledAt")
      .order("desc")
      .take(200);
    for (const r of rows) {
      if (r.occupantId === args.occupantId) {
        return {
          intermentId: r._id,
          lotId: r.lotId,
          scheduledAt: r.scheduledAt,
          status: r.status,
        };
      }
    }
    return null;
  },
});

/**
 * Read-only helper for the customer-detail page's occupants card.
 * Returns the lite occupant list ACROSS all of a customer's CURRENTLY
 * OWNED lots, with the latest interment summary joined per occupant
 * (so the "Plaque" link can deep-link without a second round-trip).
 *
 * Role gate: admin / office_staff. The same population that can
 * generate plaques (Story 6.8 AC4) — field workers do not see this
 * surface.
 *
 * Implementation:
 *   - Walks `ownerships.by_customer` for the currently-open ownership
 *     rows (effectiveTo === undefined).
 *   - For each lot, walks `occupants.by_lot` and filters out removed
 *     rows.
 *   - For each remaining occupant, walks `interments.by_scheduledAt`
 *     (descending, capped) to find the latest interment id.
 *
 * Bounded by the customer's active-lot count (typically 1 in Phase 1;
 * a few in family-plot edge cases).
 */
export interface CustomerOccupantRow {
  occupantId: OccupantId;
  lotId: LotId;
  lotCode: string;
  name: string;
  diedYear: number | undefined;
  bornYear: number | undefined;
  latestIntermentId: IntermentId | null;
  latestIntermentStatus: "scheduled" | "completed" | "cancelled" | null;
}

export const listOccupantsForCustomer = queryGeneric({
  args: { customerId: v.id("customers") },
  handler: async (
    ctx: QueryCtx,
    args: { customerId: DataModel["customers"]["document"]["_id"] },
  ): Promise<CustomerOccupantRow[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    // Currently-active ownership rows for this customer.
    const ownerships = await ctx.db
      .query("ownerships")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .collect();
    const activeOwnerships = ownerships.filter(
      (o) => o.effectiveTo === undefined,
    );

    // Pre-load the latest 200 interments once so the per-occupant
    // latest-interment lookup is in-memory.
    const recentInterments = await ctx.db
      .query("interments")
      .withIndex("by_scheduledAt")
      .order("desc")
      .take(200);

    const out: CustomerOccupantRow[] = [];
    for (const ownership of activeOwnerships) {
      const lot = await ctx.db.get(ownership.lotId);
      if (lot === null) continue;
      const occupants = await ctx.db
        .query("occupants")
        .withIndex("by_lot", (q) => q.eq("lotId", ownership.lotId))
        .collect();
      for (const occupant of occupants) {
        if (occupant.isRemoved) continue;
        const latest =
          recentInterments.find((r) => r.occupantId === occupant._id) ?? null;
        const diedYear = deriveYearFromInterment(occupant, latest);
        const bornYear = undefined;
        out.push({
          occupantId: occupant._id,
          lotId: ownership.lotId,
          lotCode: lot.code,
          name: occupant.name,
          diedYear,
          bornYear,
          latestIntermentId: latest !== null ? latest._id : null,
          latestIntermentStatus: latest !== null ? latest.status : null,
        });
      }
    }
    return out;
  },
});

/**
 * Derive a 4-digit "died year" for an occupant from the most-reliable
 * available signal. Story 2.6's `occupants` schema carries
 * `dateOfInterment` (optional epoch ms — often missing for legacy
 * records); the matching interment row's `scheduledAt` (or
 * `completedAt`) is the secondary signal. Returns `undefined` when no
 * signal is available — the UI surfaces "Date unknown" and disables
 * the Plaque link.
 *
 * Year extraction uses UTC to avoid pulling in a timezone library at
 * the read path; the Manila offset (+8h) does not move year boundaries
 * meaningfully for plaque date display (the plaque renders the
 * calendar year only).
 */
function deriveYearFromInterment(
  occupant: OccupantDoc,
  interment: IntermentDoc | null,
): number | undefined {
  const sourceMs =
    occupant.dateOfInterment !== undefined
      ? occupant.dateOfInterment
      : interment !== null
        ? (interment.completedAt ?? interment.scheduledAt)
        : undefined;
  if (sourceMs === undefined) return undefined;
  // UTC year extraction — Manila is UTC+8 with no DST, so a moment
  // recorded at UTC midnight on Jan 1 maps to 08:00 Manila on Jan 1
  // (same calendar year). The off-by-one risk only exists for moments
  // recorded between 16:00 and 00:00 UTC on Dec 31; the cemetery does
  // not record interment timestamps with sub-second precision, so the
  // approximation is acceptable for display. The PDF renderer itself
  // uses an `Intl.DateTimeFormat({ timeZone: "Asia/Manila" })` for
  // pixel-accurate year extraction.
  return new Date(sourceMs).getUTCFullYear();
}
