/**
 * One-shot internal backfill — Story 1.15 (FR3 brand-tier extension).
 *
 * Promotes the legacy free-text `lots.section` string column (Story
 * 1.8) into the new structured `sections` registry table (Story
 * 1.15). Runs once per environment after the schema deploy lands;
 * idempotent on re-run.
 *
 * Invocation (operator runbook):
 *   npx convex run internal/backfillLotSections:run \
 *     '{ "actorUserId": "<users:operator-id>" }'
 *
 * The operator passes their own `users` doc id as `actorUserId`; that
 * value lands in the AC4 audit row's `actor` field via the
 * `emitAudit({ actorOverride })` path. Internal mutations have no auth
 * context (they're reachable only from the Convex CLI by holders of a
 * deployment key), so the operator is the canonical source of
 * attribution. The mutation refuses to run without `actorUserId` — we
 * never write an audit row with no actor.
 *
 * Logic:
 *   1. Walk every `lots` row.
 *   2. For each distinct legacy `section` string, derive a kebab-case
 *      `name` candidate (lowercase, non-alphanumeric → "-", collapse
 *      repeats, trim leading/trailing hyphens). Example:
 *        "Section A · North" → "section-a-north"
 *        "Family Estates · East" → "family-estates-east"
 *      Empty / whitespace-only legacy values are skipped (logged for
 *      operator review).
 *   3. Look up `sections.by_name` with the candidate. If absent,
 *      insert a row with `kind: "standard"`, `displayName` = the
 *      original legacy string, `sortOrder` = arrival-order × 10. If
 *      present, reuse the existing row id.
 *   4. Patch every lot in the group to set `sectionId` (only when
 *      currently absent — re-runs leave already-backfilled lots
 *      untouched).
 *
 * Idempotency: re-running detects rows with an existing `sectionId`
 * and skips them; sections inserted by the previous run are matched
 * by `name` and not duplicated. Re-running on a clean DB after a
 * partial failure is therefore safe — re-runs DO emit a fresh audit
 * row each invocation (the audit log is the run history, not a state
 * machine).
 *
 * Follow-up deploy: once the backfill is verified in production, a
 * separate story drops the `lots.section` string column. The two
 * deploys MUST stay separate — combining them risks an irrecoverable
 * migration if the backfill silently mis-maps any rows.
 *
 * Audit (AC4 — Story 1.15): emits a single audit row per run with
 * `entityType: "section"`, `action: "create"`, `entityId` = the first
 * inserted section id (or the first reused id when no new rows
 * landed; falls back to the literal "all" when neither exists — e.g.
 * an empty lots table). The `after` payload carries
 * `{ kind: "migration_backfill", rowsTouched, sectionsCreated }` so
 * the audit reader distinguishes migration events by the
 * `after.kind === "migration_backfill"` discriminator. The `update`
 * action enum doesn't carry a dedicated migration literal; `create`
 * matches the registry-row creation intent and surfaces the event in
 * standard `by_actor` / `by_entity` queries.
 */

import { internalMutationGeneric } from "convex/server";
import type { DataModelFromSchemaDefinition } from "convex/server";
import { v } from "convex/values";
import type { GenericId } from "convex/values";

import schema from "../schema";
import type { MutationCtx } from "../lib/auth";
import { emitAudit } from "../lib/audit";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotDoc = DataModel["lots"]["document"];
type SectionId = DataModel["sections"]["document"]["_id"];

interface BackfillResult {
  lotsTouched: number;
  lotsSkipped: number;
  sectionsCreated: number;
  sectionsReused: number;
  emptyLegacyValueLots: number;
}

/**
 * Pure helper exposed for unit-test friendliness. Converts a legacy
 * free-text section value into the kebab-case canonical name.
 *
 *   "Section A · North"   → "section-a-north"
 *   "Family Estates · East" → "family-estates-east"
 *   "CHAPEL OF GRACE"     → "chapel-of-grace"
 *   "  D  "               → "d"
 *   "A · B · C"           → "a-b-c"
 */
export function deriveKebabName(legacy: string): string {
  return legacy
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The one-shot backfill mutation. Idempotent — running twice on the
 * same dataset produces identical state (modulo a second audit row).
 *
 * `actorUserId` is the operator's own `users` doc id, passed at the
 * CLI invocation. Internal mutations have no auth context to read
 * from; we pass it through to `emitAudit({ actorOverride })` so the
 * audit row carries proper attribution. The operator MUST supply
 * their own id — there is no default and no fallback.
 */
export const run = internalMutationGeneric({
  args: {
    actorUserId: v.id("users"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { actorUserId: GenericId<"users"> },
  ): Promise<BackfillResult> => {
    // Step 1: walk every lot row. At Phase 1 scale (~2,000 lots) a
    // single `.collect()` is acceptable; a larger dataset would
    // paginate.
    const lots = await ctx.db.query("lots").collect();

    // Step 2: group by the legacy `section` string. Use a Map keyed
    // by the derived kebab-case name so multiple legacy strings that
    // collapse to the same canonical name (e.g. "Section A " vs
    // "Section A") share a single row.
    const groups = new Map<
      string,
      {
        canonicalName: string;
        displayName: string;
        lots: LotDoc[];
      }
    >();
    let emptyLegacyValueLots = 0;
    for (const lot of lots) {
      const legacy = (lot.section ?? "").trim();
      if (legacy.length === 0) {
        emptyLegacyValueLots += 1;
        continue;
      }
      const canonicalName = deriveKebabName(legacy);
      if (canonicalName.length === 0) {
        emptyLegacyValueLots += 1;
        continue;
      }
      const existing = groups.get(canonicalName);
      if (existing === undefined) {
        groups.set(canonicalName, {
          canonicalName,
          // Use the FIRST encountered legacy string as the
          // human-readable display name. Deterministic enough for a
          // one-shot migration — the admin can edit the row later
          // via `/admin/sections` if the canonical display string
          // doesn't match the brand-guide preference.
          displayName: legacy,
          lots: [lot],
        });
      } else {
        existing.lots.push(lot);
      }
    }

    // Step 3: ensure each canonical name has a section row. Reuse
    // existing rows by `by_name` index lookup (so re-runs don't
    // duplicate the registry).
    let sectionsCreated = 0;
    let sectionsReused = 0;
    const sectionIdByName = new Map<string, SectionId>();
    let sortOrder = 10;
    for (const group of groups.values()) {
      const existing = await ctx.db
        .query("sections")
        .withIndex("by_name", (q) => q.eq("name", group.canonicalName))
        .first();
      if (existing !== null) {
        sectionsReused += 1;
        sectionIdByName.set(group.canonicalName, existing._id);
        continue;
      }
      // Insert a new section. `createdBy` falls back to the first
      // lot's `createdBy` so the FK to `users` stays valid even
      // without an authenticated caller. The audit row at the end
      // captures the migration context.
      const firstLot = group.lots[0]!;
      const sectionId = await ctx.db.insert("sections", {
        name: group.canonicalName,
        displayName: group.displayName,
        sortOrder,
        kind: "standard",
        isRetired: false,
        createdAt: Date.now(),
        createdBy: firstLot.createdBy,
      });
      sectionsCreated += 1;
      sectionIdByName.set(group.canonicalName, sectionId);
      sortOrder += 10;
    }

    // Step 4: patch every lot in the group with the matching
    // `sectionId`. Skip lots that already carry one — re-runs are a
    // no-op for those rows.
    let lotsTouched = 0;
    let lotsSkipped = 0;
    for (const group of groups.values()) {
      const sectionId = sectionIdByName.get(group.canonicalName);
      if (sectionId === undefined) continue;
      for (const lot of group.lots) {
        if (lot.sectionId !== undefined) {
          lotsSkipped += 1;
          continue;
        }
        await ctx.db.patch(lot._id, { sectionId });
        lotsTouched += 1;
      }
    }

    const result: BackfillResult = {
      lotsTouched,
      lotsSkipped,
      sectionsCreated,
      sectionsReused,
      emptyLegacyValueLots,
    };

    // AC4 — emit a migration_backfill_sections audit row attributed
    // to the operator who launched the CLI. `emitAudit` with
    // `actorOverride` is the only sanctioned path for internal
    // mutations that have no auth context (see
    // `EmitAuditParams.actorOverride` JSDoc + Story 1.15 H5 review).
    // `entityId` prefers the first inserted section id, then the
    // first reused id, then the literal "all" for the
    // empty-lots-table case — every audit row needs a non-empty
    // entityId for `by_entity` lookups.
    const firstSectionId = sectionIdByName.values().next();
    const entityId: string =
      !firstSectionId.done && firstSectionId.value !== undefined
        ? (firstSectionId.value as unknown as string)
        : "all";
    await emitAudit(ctx, {
      action: "create",
      entityType: "section",
      entityId,
      actorOverride: args.actorUserId,
      after: {
        kind: "migration_backfill",
        rowsTouched: lotsTouched,
        sectionsCreated,
        sectionsReused,
        lotsSkipped,
        emptyLegacyValueLots,
      },
      reason:
        "Story 1.15 backfill: legacy lots.section string promoted to sections registry.",
    });

    return result;
  },
});
