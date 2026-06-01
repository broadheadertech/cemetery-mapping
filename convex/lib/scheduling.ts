/**
 * Booking-conflict guard for ceremonies (Story 7.5 extension of Story 7.2).
 *
 * `assertNoBookingConflict` is a pure-ish helper (reads from the DB but
 * does no writes) that the `scheduleCeremony` mutation in
 * `convex/ceremonies.ts` calls BEFORE inserting a new row. Three
 * overlapping windows count as a conflict:
 *
 *   1. **Lot conflict** -- any TWO rows whose
 *      [start, start + durationMinutes) windows overlap AND share the
 *      same `lotId`. Kind-agnostic: a consecration at 09:00 on lot A and
 *      an interment at 09:30 on lot A conflict. Story 7.5 § Disaster
 *      prevention calls this out as the disaster-class failure (a
 *      family arrives to find a hole being dug for someone else).
 *
 *   2. **Chapel conflict** -- any TWO rows with `chapelReserved: true`
 *      whose windows overlap, regardless of lot. The chapel is a single
 *      shared resource: only one family may consecrate / mourn / inter
 *      there at a time.
 *
 *   3. **Pathway conflict** -- same as chapel but for the eastern
 *      walking path.
 *
 * The helper scans BOTH `ceremonies` and the legacy `interments` table
 * (Option B per ADR 0069). The interments table only carries
 * `scheduledAt` (no `durationMinutes`); we treat each interment as a
 * 60-minute window via `INTERMENT_LEGACY_DURATION_MINUTES`. Once the
 * Option-A rename lands, the interments branch can be deleted.
 *
 * Conflict throws `SCHEDULING_CONFLICT` with `details.resource`
 * naming the colliding resource and `details.conflictingIds` carrying
 * the offending row ids so the UI can render a deep-link to each.
 */

import type {
  DataModelFromSchemaDefinition,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";

import schema from "../schema";
import { ErrorCode, throwError } from "./errors";
import { MINUTE_MS } from "./time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];
type CeremonyId = DataModel["ceremonies"]["document"]["_id"];
type IntermentId = DataModel["interments"]["document"]["_id"];

type AnyCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

/**
 * Legacy interments don't carry a `durationMinutes` column (Story 7.1
 * shipped them as point-in-time `scheduledAt` records). For the
 * overlap math we treat each scheduled interment as occupying 60
 * minutes -- matches the `INTERMENT_CONFLICT_WINDOW_MS` precedent in
 * `convex/interments.ts`.
 */
export const INTERMENT_LEGACY_DURATION_MINUTES = 60;

/** Minimum / maximum legal `durationMinutes` for a ceremony. */
export const CEREMONY_MIN_DURATION_MINUTES = 30;
export const CEREMONY_MAX_DURATION_MINUTES = 240;

export interface AssertNoBookingConflictParams {
  lotId: LotId;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  /**
   * When rescheduling an existing ceremony, the row's own id is passed
   * here so it doesn't conflict with itself. Optional; omit on insert.
   */
  excludeCeremonyId?: CeremonyId;
}

interface WindowedRow {
  id: string;
  start: number;
  end: number;
  lotId: string;
  chapelReserved: boolean;
  pathwayReserved: boolean;
}

/**
 * Half-open interval overlap. `[aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅`
 * iff `aStart < bEnd && bStart < aEnd`. The half-open shape means two
 * windows that touch at a single point (one ends exactly when the
 * other begins) do NOT conflict -- a 09:00 ceremony of 60 min and a
 * 10:00 ceremony of 30 min are back-to-back, not overlapping.
 */
function windowsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Conflict check entry point. Reads candidate rows from both
 * `ceremonies` and `interments`, applies the three overlap rules in
 * order (lot first because it's the strongest failure mode), and
 * throws on the first conflict found.
 */
export async function assertNoBookingConflict(
  ctx: AnyCtx,
  params: AssertNoBookingConflictParams,
): Promise<void> {
  if (
    !Number.isFinite(params.scheduledAt) ||
    !Number.isInteger(params.scheduledAt) ||
    params.scheduledAt <= 0
  ) {
    throwError(
      ErrorCode.VALIDATION,
      "scheduledAt must be a positive integer (unix ms).",
    );
  }
  if (
    !Number.isFinite(params.durationMinutes) ||
    params.durationMinutes < CEREMONY_MIN_DURATION_MINUTES ||
    params.durationMinutes > CEREMONY_MAX_DURATION_MINUTES
  ) {
    throwError(
      ErrorCode.VALIDATION,
      `durationMinutes must be between ${CEREMONY_MIN_DURATION_MINUTES} and ${CEREMONY_MAX_DURATION_MINUTES}.`,
    );
  }

  const newStart = params.scheduledAt;
  const newEnd = params.scheduledAt + params.durationMinutes * MINUTE_MS;

  // We need to fetch all candidate rows whose window might overlap.
  // Cheapest indexed scan: bound by [newStart - MAX_DURATION, newEnd)
  // so any row whose START is in that window MAY overlap (its END
  // could fall after newStart). Anything with start >= newEnd cannot
  // overlap (we use half-open intervals). Anything whose start is more
  // than MAX_DURATION before newStart is too far in the past to reach.
  const lookbackMs = CEREMONY_MAX_DURATION_MINUTES * MINUTE_MS;
  const scanFrom = newStart - lookbackMs;
  const scanTo = newEnd; // exclusive upper bound conceptually

  // ---- ceremonies table ----
  const ceremonyRows = await ctx.db
    .query("ceremonies")
    .withIndex("by_scheduledAt", (q) =>
      q.gte("scheduledAt", scanFrom).lt("scheduledAt", scanTo),
    )
    .collect();
  const candidateCeremonies: WindowedRow[] = ceremonyRows
    .filter((r) => r.status === "scheduled")
    .filter(
      (r) =>
        params.excludeCeremonyId === undefined ||
        r._id !== params.excludeCeremonyId,
    )
    .map((r) => ({
      id: r._id,
      start: r.scheduledAt,
      end: r.scheduledAt + r.durationMinutes * MINUTE_MS,
      lotId: r.lotId,
      chapelReserved: r.chapelReserved,
      pathwayReserved: r.pathwayReserved,
    }));

  // ---- legacy interments table (Option B coexistence) ----
  const intermentRows = await ctx.db
    .query("interments")
    .withIndex("by_scheduledAt", (q) =>
      q.gte("scheduledAt", scanFrom).lt("scheduledAt", scanTo),
    )
    .collect();
  const candidateInterments: WindowedRow[] = intermentRows
    .filter((r) => r.status === "scheduled")
    .map((r) => ({
      id: r._id,
      start: r.scheduledAt,
      end: r.scheduledAt + INTERMENT_LEGACY_DURATION_MINUTES * MINUTE_MS,
      lotId: r.lotId,
      // Story 7.5 H4 fix (adversarial review): read the actual toggles
      // off the interment row. Pre-fix this branch hard-coded `false`,
      // which let a chapel-bound interment slip past a chapel-bound
      // ceremony's overlap scan -- the disaster-class failure the
      // Story 7.5 dev notes call out. The `=== true` shape is a
      // defensive coercion: legacy interment rows from before the
      // schema additions lack these columns entirely, and we want
      // `undefined` to map to `false` (i.e. legacy = "did not reserve").
      // Future Option-A migration would promote the columns to
      // required + backfill from the row's `kind` field.
      chapelReserved: r.chapelReserved === true,
      pathwayReserved: r.pathwayReserved === true,
    }));

  const all = [...candidateCeremonies, ...candidateInterments];

  // 1. Lot conflict (strongest signal, surfaced first).
  const lotHits = all
    .filter((r) => r.lotId === params.lotId)
    .filter((r) => windowsOverlap(newStart, newEnd, r.start, r.end));
  if (lotHits.length > 0) {
    throwError(
      ErrorCode.SCHEDULING_CONFLICT,
      "This lot already has a ceremony scheduled in the requested window.",
      {
        resource: "lot",
        conflictingIds: lotHits.map((r) => r.id),
      },
    );
  }

  // 2. Chapel conflict -- only fires when the NEW row reserves the chapel.
  if (params.chapelReserved) {
    const chapelHits = all
      .filter((r) => r.chapelReserved)
      .filter((r) => windowsOverlap(newStart, newEnd, r.start, r.end));
    if (chapelHits.length > 0) {
      throwError(
        ErrorCode.SCHEDULING_CONFLICT,
        "The chapel is already reserved by another ceremony in the requested window.",
        {
          resource: "chapel",
          conflictingIds: chapelHits.map((r) => r.id),
        },
      );
    }
  }

  // 3. Pathway conflict -- only fires when the NEW row reserves the pathway.
  if (params.pathwayReserved) {
    const pathwayHits = all
      .filter((r) => r.pathwayReserved)
      .filter((r) => windowsOverlap(newStart, newEnd, r.start, r.end));
    if (pathwayHits.length > 0) {
      throwError(
        ErrorCode.SCHEDULING_CONFLICT,
        "The walking pathway is already reserved by another ceremony in the requested window.",
        {
          resource: "pathway",
          conflictingIds: pathwayHits.map((r) => r.id),
        },
      );
    }
  }
}

/**
 * Type-export helpers re-exported for tests + dev tooling.
 */
export type { LotId, CeremonyId, IntermentId };
