/**
 * GPS-surveyed lot geometry import — Story 8.1 (FR9, prep for FR10 P2).
 *
 * This is the Phase 1 ↔ Phase 2 bridge. A field worker / GIS surveyor
 * delivers a JSON batch of `{ lotCode, polygon }` pairs (and an
 * optional override centroid per item) and an admin runs
 * `importGpsBatch` to patch the existing `lots.geometry` slot from
 * `geometryStatus: "placeholder"` to `"surveyed"`.
 *
 * Why this lives in a separate file rather than a method on
 * `convex/lots.ts`:
 *
 *   1. Story 1.9 deliberately exposed geometry rewrites ONLY through the
 *      `internalMutationGeneric updateLotGeometry` (no public surface).
 *      The Phase 2 ADR-0008 §4 commits to admin-only geometry rewrites
 *      with audit emission, NOT a user-facing edit form. Putting the
 *      admin-callable import here keeps `convex/lots.ts` focused on the
 *      generic CRUD surface and concentrates the bulk-write semantics
 *      (batch, per-item errors, summary report) in one place.
 *
 *   2. Story 8.1's spec calls for an `internalAction` + Convex File
 *      Storage upload flow driven from `npx convex run`. That pattern
 *      requires `convex/_generated/api.internal` (the codegen output
 *      of `npx convex dev`), which this repo deliberately does NOT
 *      check in — see `convex/lib/audit.ts:emitAuditFromAction`'s
 *      explicit gap-throw at line 341. Until the codegen exists, the
 *      same operational deliverable is satisfied by an admin-only
 *      public mutation that accepts the parsed JSON batch inline. The
 *      admin uploads the file in the browser (the `/admin/gps-import`
 *      page parses it client-side and calls this mutation). When the
 *      codegen lands, a future story can add the action + storage
 *      transport without changing this mutation's contract — the UI
 *      simply switches from parsing in the browser to uploading to
 *      storage and invoking the action.
 *
 *   3. Audit emission MUST happen inside a `MutationCtx` (the same
 *      gap explained in `convex/lib/audit.ts` — `emitAuditFromAction`
 *      explicitly throws). Doing the per-lot writes inside a mutation
 *      makes the audit chain work today; moving to an action later
 *      will require the audit-from-action transport that ships in a
 *      separate Story 1.6 follow-up.
 *
 * Batched in-mutation strategy (audit trail per lot):
 *
 *   Story 8.1 spec §Architecture warns about Convex's per-mutation
 *   transaction-size budget. For 2,000 lots at ~1KB each the raw write
 *   payload is ~2MB; with audit `before`/`after` doubled it's still
 *   well under the ~16MB soft limit. The current scope caps a single
 *   import call at `MAX_BATCH_SIZE` items (default 500) — the cemetery
 *   typically imports in surveyor-delivered chunks anyway. Larger
 *   imports run multiple `importGpsBatch` calls back-to-back; the UI
 *   chunks them automatically.
 *
 * Skip-if-already-surveyed default:
 *
 *   The Story 8.1 spec §"Common LLM-developer mistakes" calls out that
 *   `force: false` (the default) is the safe behaviour — a second
 *   accidental run with the same file does NOT clobber corrected
 *   geometry. A re-survey correction sets `force: true` explicitly.
 *   Per-lot, an already-surveyed lot is reported in
 *   `skippedAlreadySurveyed`, not in `errors`.
 *
 * What this file does NOT do:
 *
 *   - Parse CSV. JSON-first per the dev-agent system message: "Keep
 *     CSV as a stretch goal (and only add `papaparse` if necessary)."
 *     The browser-side parser in `src/components/GpsImport/*` accepts
 *     both `FeatureCollection` GeoJSON and plain `{ items: [...] }`
 *     JSON — no surveyor-formatted CSV path in Phase 1.
 *
 *   - Use `ctx.storage`. There is no upload step. The UI sends the
 *     parsed batch over the wire to this mutation directly.
 *
 *   - Decrement / reset `geometryStatus`. The mutation only flips
 *     `placeholder → surveyed`; it never goes the other direction.
 *     (Reverting a survey is a separate admin task tracked in §10 Q-
 *     pool, not in this story.)
 *
 * Roles: `admin` ONLY. Lot geometry is legal evidence in ownership
 * disputes — see Story 1.9's `updateLotGeometry` JSDoc (lines 657-685).
 * `office_staff` cannot trigger an import.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import {
  bboxFromPolygon,
  isCoordInManilaSanityRange,
  type LatLng,
  type LotGeometry,
  type Polygon,
  polygonCentroid,
  validatePolygon,
} from "./lib/geometry";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotDoc = DataModel["lots"]["document"];
type LotId = LotDoc["_id"];

/**
 * Per-call cap. A surveyor's typical chunk is one section (~200 lots);
 * the cap is generous enough for whole-cemetery imports while still
 * bounding the worst-case mutation size. Larger imports must run as
 * multiple back-to-back calls. The UI handles chunking transparently.
 */
const MAX_BATCH_SIZE = 500;

/**
 * Reasons a single item can fail validation BEFORE the per-lot write is
 * attempted. The literal-union keeps callers (the result viewer in the
 * import UI) from drifting out of sync with the server's vocabulary.
 *
 * Mapped from the dev-spec §AC3 reporting buckets:
 *
 *   - `NOT_FOUND`           — surveyor's `lotCode` doesn't match any lot.
 *   - `INVALID_POLYGON`     — `validatePolygon` rejected the shape.
 *   - `INVALID_INPUT`       — wrapper input issue (empty lotCode, etc.).
 *   - `ALREADY_SURVEYED`    — the lot is `surveyed` and `force !== true`.
 *                              Surfaced as a separate counter, NOT in
 *                              the error list — it's a skip, not a fail.
 */
export type ImportItemErrorReason =
  | "NOT_FOUND"
  | "INVALID_POLYGON"
  | "INVALID_INPUT";

interface ImportItemError {
  lotCode: string;
  reason: ImportItemErrorReason;
  details: string;
}

interface ImportItemSkipped {
  lotCode: string;
  reason: "ALREADY_SURVEYED";
  details: string;
}

export interface ImportGpsBatchResult {
  totalItems: number;
  updated: number;
  skippedAlreadySurveyed: ImportItemSkipped[];
  errors: ImportItemError[];
}

const polygonVertexValidator = v.object({
  lat: v.number(),
  lng: v.number(),
});

const importItemValidator = v.object({
  lotCode: v.string(),
  polygon: v.array(polygonVertexValidator),
  centroid: v.optional(polygonVertexValidator),
});

interface ImportItem {
  lotCode: string;
  polygon: Polygon;
  centroid?: LatLng;
}

/**
 * Admin-only public mutation: apply a batch of GPS-surveyed polygons
 * to existing lots.
 *
 * The mutation is the canonical write path for Phase 2 geometry; it
 * embeds the same invariants as `updateLotGeometry` (Story 1.9) but
 * adds bulk semantics: per-item errors don't abort the whole call;
 * the result document tells the operator which items succeeded,
 * which were skipped, and which failed with what reason.
 *
 * Contract (called via `useMutation` from the admin UI):
 *
 *   args:
 *     - `items`: `[{ lotCode, polygon, centroid? }]`, length 1..500.
 *       Per-item polygon validation uses `validatePolygon`; the
 *       wrapper layer here additionally enforces that `lotCode` is a
 *       non-empty trimmed string (`INVALID_INPUT`) so we don't waste
 *       a lookup on garbage rows.
 *     - `force?`: when `true`, surveyed lots are overwritten and
 *       counted in `updated`. Default `false` skips them and counts in
 *       `skippedAlreadySurveyed`.
 *     - `reason?`: free-text operator note. Stored in each emitted
 *       audit row's `reason` field so an admin reviewing the audit
 *       trail later can see e.g. "Initial GPS import 2026-05-19" or
 *       "Re-survey correction for section D, ticket #487".
 *
 *   returns:
 *     `{ totalItems, updated, skippedAlreadySurveyed[], errors[] }`.
 *
 *   throws:
 *     - `FORBIDDEN`         — caller is not admin.
 *     - `VALIDATION`        — `items` exceeds `MAX_BATCH_SIZE` or is
 *                             empty. Per-item validation does NOT
 *                             throw; it accumulates into `errors`.
 *
 * Audit emission: ONE `auditLog` row per successful update. Audit
 * action is `"update"` (same convention as `updateLotGeometry`'s
 * JSDoc justifies, line 691-697) with a `before`/`after` payload
 * carrying the full geometry + status diff. The operator-supplied
 * `reason` propagates to every emitted row. Skipped and failed items
 * emit NO audit — there was no state change.
 */
export const importGpsBatch = mutationGeneric({
  args: {
    items: v.array(importItemValidator),
    force: v.optional(v.boolean()),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      items: ImportItem[];
      force?: boolean;
      reason?: string;
    },
  ): Promise<ImportGpsBatchResult> => {
    await requireRole(ctx, ["admin"]);

    if (args.items.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Batch must contain at least one item.",
      );
    }
    if (args.items.length > MAX_BATCH_SIZE) {
      throwError(
        ErrorCode.VALIDATION,
        `Batch exceeds the per-call cap of ${MAX_BATCH_SIZE} items. Split into multiple calls.`,
        { received: args.items.length, max: MAX_BATCH_SIZE },
      );
    }

    const force = args.force === true;
    const auditReason =
      typeof args.reason === "string" && args.reason.trim().length > 0
        ? args.reason.trim()
        : "GPS survey import";

    const result: ImportGpsBatchResult = {
      totalItems: args.items.length,
      updated: 0,
      skippedAlreadySurveyed: [],
      errors: [],
    };

    for (const rawItem of args.items) {
      const trimmedCode =
        typeof rawItem.lotCode === "string" ? rawItem.lotCode.trim() : "";
      if (trimmedCode.length === 0) {
        result.errors.push({
          lotCode: rawItem.lotCode ?? "",
          reason: "INVALID_INPUT",
          details: "Lot code is required and must be a non-empty string.",
        });
        continue;
      }

      // Polygon must be valid before we touch the DB — `validatePolygon`
      // accepts empty (placeholder) shapes, but an "import" by definition
      // is non-empty surveyed geometry. The wrapper rejects empty polygons
      // here so the surveyor's accidental empty row is caught loudly
      // rather than silently flipping a lot's status back to placeholder.
      if (rawItem.polygon.length === 0) {
        result.errors.push({
          lotCode: trimmedCode,
          reason: "INVALID_POLYGON",
          details: "Polygon is empty. Imports require at least 3 vertices.",
        });
        continue;
      }

      const polygonCheck = validatePolygon(rawItem.polygon);
      if (!polygonCheck.ok) {
        result.errors.push({
          lotCode: trimmedCode,
          reason: "INVALID_POLYGON",
          details: polygonCheck.details,
        });
        continue;
      }

      // Epic 8 H1 — validate an operator-supplied centroid OVERRIDE.
      // `validatePolygon` only checks the polygon vertices; a bad or
      // lat/lng-swapped centroid override is otherwise stored verbatim
      // and later drives field-worker GPS navigation to the wrong place.
      // Apply the same Manila coordinate sanity range as the vertex check.
      if (
        rawItem.centroid !== undefined &&
        !isCoordInManilaSanityRange(rawItem.centroid)
      ) {
        result.errors.push({
          lotCode: trimmedCode,
          reason: "INVALID_POLYGON",
          details:
            "Supplied centroid is outside the Manila coordinate sanity range — check the lat/lng order.",
        });
        continue;
      }

      const lot = await findLotByCode(ctx, trimmedCode);
      if (lot === null) {
        result.errors.push({
          lotCode: trimmedCode,
          reason: "NOT_FOUND",
          details: `No lot exists with code "${trimmedCode}".`,
        });
        continue;
      }

      if (lot.geometryStatus === "surveyed" && !force) {
        result.skippedAlreadySurveyed.push({
          lotCode: trimmedCode,
          reason: "ALREADY_SURVEYED",
          details:
            "Lot already has surveyed geometry. Re-run with force=true to overwrite.",
        });
        continue;
      }

      const centroid: LatLng =
        rawItem.centroid ??
        polygonCentroid(rawItem.polygon, lot.geometry.centroid);
      const bbox = bboxFromPolygon(rawItem.polygon, centroid);
      const nextGeometry: LotGeometry = {
        centroid,
        polygon: rawItem.polygon,
        ...bbox,
      };

      // Patch + audit. Mirrors `convex/lots.ts:updateLotGeometry`'s
      // body exactly — same audit shape, same before/after fields —
      // so audit-log readers don't need to distinguish "the GPS batch
      // touched this lot" from "an internal mutation touched this
      // lot". The `reason` field is the only operator-visible
      // difference; it carries the batch-level note across each row.
      await ctx.db.patch(lot._id as LotId, {
        geometry: nextGeometry,
        geometryStatus: "surveyed",
      });
      await emitAudit(ctx, {
        action: "update",
        entityType: "lot",
        entityId: lot._id,
        before: {
          geometry: lot.geometry,
          geometryStatus: lot.geometryStatus,
        },
        after: {
          geometry: nextGeometry,
          geometryStatus: "surveyed",
        },
        reason: auditReason,
      });

      result.updated += 1;
    }

    return result;
  },
});

/**
 * Module-private lookup used by the in-mutation per-item loop. The
 * `internalQueryGeneric` companion `getLotByCode` lives in
 * `convex/lots.ts` (Story 8.1 task: append an internal-query helper
 * there if it doesn't exist already) so other Convex domains can
 * resolve a surveyor's `lotCode` to a `lots._id` without crossing
 * file boundaries through this import-domain file. The mutation
 * above uses this helper directly (single round-trip) rather than
 * invoking the internal query via `ctx.runQuery`.
 */
async function findLotByCode(
  ctx: QueryCtx | MutationCtx,
  code: string,
): Promise<LotDoc | null> {
  return await ctx.db
    .query("lots")
    .withIndex("by_code", (q) => q.eq("code", code))
    .first();
}
