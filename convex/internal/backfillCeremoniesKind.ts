/**
 * Backfill `ceremonies.kind` (Story 7.5 backfill).
 *
 * Per ADR 0069 the team chose **Option B** (parallel `ceremonies` table)
 * over Option A (rename `interments` -> `ceremonies`). In Option B the
 * new `ceremonies` table is created EMPTY; existing scheduled
 * interments stay in the legacy `interments` table and continue to be
 * managed by `convex/interments.ts`. The booking-conflict guard in
 * `convex/lib/scheduling.ts` reads from BOTH tables so the cross-kind
 * lot-overlap protection holds without a data migration.
 *
 * Consequence: there is NO data to backfill. Every row already in the
 * `ceremonies` table was inserted through `scheduleCeremony`, which
 * REQUIRES the `kind` field at the validator level -- a row without
 * `kind` is impossible by construction.
 *
 * This file ships an idempotent internal mutation anyway because:
 *
 *   1. The Story 7.5 spec explicitly enumerates the file as a Task
 *      deliverable (Task 2). Shipping the harness now means a future
 *      Option-A migration drops in the real scan logic without a new
 *      file landing.
 *   2. The CI / smoke-deploy path expects a callable internal mutation
 *      at `internal/backfillCeremoniesKind:run` so a runbook entry can
 *      reference it.
 *
 * Invocation:
 *   npx convex run internal/backfillCeremoniesKind:run
 *
 * Return shape: `{ scanned, patched, skipped }`. Under Option B, scanned
 * counts every row in `ceremonies` (informational) and `patched` is
 * always 0.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
} from "convex/server";

import schema from "../schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;

export interface BackfillCeremoniesKindResult {
  scanned: number;
  patched: number;
  skipped: number;
}

export const run = internalMutationGeneric({
  args: {},
  handler: async (ctx): Promise<BackfillCeremoniesKindResult> => {
    const rows = await ctx.db
      .query("ceremonies")
      .withIndex("by_scheduledAt")
      .collect();
    let patched = 0;
    let skipped = 0;
    for (const row of rows) {
      // Defensive scan: if a future migration injects rows without a
      // `kind` field (e.g. an Option-A rename pulls in legacy interment
      // rows), patch them to the safe default `"interment"`. Today the
      // validator makes this branch unreachable.
      const k = (row as unknown as { kind?: string }).kind;
      if (k === undefined || k === null) {
        await ctx.db.patch(row._id, {
          kind: "interment",
          chapelReserved: false,
          pathwayReserved: false,
        });
        patched += 1;
      } else {
        skipped += 1;
      }
    }
    // Suppress no-unused warnings while keeping the dependency live for
    // future Option-A consumers.
    void (null as DataModel | null);
    const result: BackfillCeremoniesKindResult = {
      scanned: rows.length,
      patched,
      skipped,
    };
    console.log(
      `[backfillCeremoniesKind] scanned=${result.scanned} patched=${result.patched} skipped=${result.skipped}`,
    );
    return result;
  },
});
