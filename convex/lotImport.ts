/**
 * Legacy lot-inventory import (Q4 — existing legacy records).
 *
 * The cemetery's ~2,000 lots live as hybrid paper + Excel records.
 * `convex/gpsImport.ts` already handles the Phase 1 → Phase 2 geometry
 * bridge, but it only PATCHES lots that already exist — there was no
 * way to get the inventory in here in the first place short of typing
 * 2,000 rows into the lot form. This file is that missing first step.
 *
 * Two entry points, one validation pass:
 *
 *   - `previewLotBatch`  — a QUERY. Returns the full plan (what would
 *     be created, every error, every warning) and writes nothing. The
 *     "dry run cannot write" guarantee is structural: queries have no
 *     `ctx.db.insert`. This is deliberate — a boolean `dryRun` flag on
 *     a mutation is one mis-set argument away from applying 500 rows
 *     the operator only meant to inspect.
 *
 *   - `importLotBatch`   — the MUTATION. Re-runs the same validation
 *     (the preview may be minutes stale, and the browser is not a
 *     trust boundary), then inserts the rows that pass.
 *
 * Partial success is the intended behaviour, not a compromise. A
 * hand-kept spreadsheet of unknown quality will have bad rows; failing
 * the whole batch on row 47 means the operator fixes one typo, re-runs
 * 500 rows, and hits the next typo. Instead: good rows land, bad rows
 * come back with their source line number, the operator fixes those
 * and re-runs. Already-imported codes report as `DUPLICATE_IN_DB`, so
 * a re-run of a corrected file is safe and idempotent.
 *
 * Roles: `admin` ONLY, on both functions. Bulk inventory creation sets
 * the baseline every contract, interment, and ownership record later
 * hangs off; it is not routine office work.
 *
 * Audit: one `create` row per inserted lot, carrying the operator's
 * batch `reason` (e.g. "Section A legacy migration, batch 1/4"). That
 * matches `gpsImport`'s per-lot convention and keeps the audit trail
 * answerable at the individual-lot level, which is what an ownership
 * dispute actually asks about.
 *
 * Status on insert: rows may declare `occupied` (a pre-2020 burial
 * with no digitised paperwork), which is written directly rather than
 * through `transitionLotStatus`. That is the same latitude
 * `convex/seed.ts` takes and the same reason ADR-0006 grants it — a
 * migration establishes an INITIAL state, it does not transition
 * between two states the system has observed. `sold` is refused
 * outright; see the status note in `convex/lib/lotImportValidation.ts`.
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
import { bumpLotStatusCounter } from "./lib/dashboardCounters";
import { ErrorCode, throwError } from "./lib/errors";
import { getDefaultPlaceholderGeometry } from "./lib/geometry";
import { DEFAULT_CAPACITY_UNITS } from "./lib/lotCapacity";
import {
  type LotImportRow,
  type LotImportRowError,
  type LotImportRowWarning,
  MAX_IMPORT_BATCH_SIZE,
  validateLotImportRows,
  type ValidatedLotImportRow,
} from "./lib/lotImportValidation";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];

const importRowValidator = v.object({
  rowNumber: v.number(),
  code: v.string(),
  section: v.string(),
  block: v.string(),
  row: v.string(),
  type: v.string(),
  widthM: v.number(),
  depthM: v.number(),
  basePriceCents: v.number(),
  status: v.optional(v.string()),
});

/**
 * What the preview shows and what the import reports back. Shared
 * shape so the result panel renders identically either way — the only
 * difference an operator sees is the verb ("would create" vs.
 * "created") and the presence of `createdLotIds`.
 */
export interface LotImportReport {
  totalRows: number;
  /** Preview: rows that WOULD be created. Import: rows created. */
  created: number;
  /** Preview rows in file order, so the UI can show a plan table. */
  plan: Array<{
    rowNumber: number;
    code: string;
    section: string;
    sectionLinked: boolean;
    status: string;
  }>;
  errors: LotImportRowError[];
  warnings: LotImportRowWarning[];
}

function toPlan(
  valid: ValidatedLotImportRow[],
): LotImportReport["plan"] {
  return valid.map((r) => ({
    rowNumber: r.rowNumber,
    code: r.code,
    section: r.section,
    sectionLinked: r.sectionId !== undefined,
    status: r.status,
  }));
}

/**
 * Guard shared by both entry points. Batch-level problems (empty,
 * oversized) DO throw — unlike per-row problems, they mean the caller
 * is malformed rather than the data being dirty, and there is no
 * partial result worth returning.
 */
function assertBatchSize(rowCount: number): void {
  if (rowCount === 0) {
    throwError(ErrorCode.VALIDATION, "Batch must contain at least one row.");
  }
  if (rowCount > MAX_IMPORT_BATCH_SIZE) {
    throwError(
      ErrorCode.VALIDATION,
      `Batch exceeds the per-call cap of ${MAX_IMPORT_BATCH_SIZE} rows. Split into multiple calls.`,
      { received: rowCount, max: MAX_IMPORT_BATCH_SIZE },
    );
  }
}

/**
 * Dry run. Validates the batch against the live database and returns
 * the plan without writing. Safe to run repeatedly while the operator
 * cleans up the spreadsheet.
 */
export const previewLotBatch = queryGeneric({
  args: { rows: v.array(importRowValidator) },
  handler: async (
    ctx: QueryCtx,
    args: { rows: LotImportRow[] },
  ): Promise<LotImportReport> => {
    await requireRole(ctx, ["admin"]);
    assertBatchSize(args.rows.length);

    const report = await validateLotImportRows(ctx, args.rows);
    return {
      totalRows: report.totalRows,
      created: report.valid.length,
      plan: toPlan(report.valid),
      errors: report.errors,
      warnings: report.warnings,
    };
  },
});

/**
 * Apply the batch. Inserts every row that validates; reports the rest.
 *
 * `reason` is the operator's batch label and propagates verbatim into
 * every emitted audit row, so a later reviewer can tell a migration
 * batch apart from a hand-created lot without cross-referencing
 * timestamps.
 */
export const importLotBatch = mutationGeneric({
  args: {
    rows: v.array(importRowValidator),
    reason: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: { rows: LotImportRow[]; reason?: string },
  ): Promise<LotImportReport> => {
    const auth = await requireRole(ctx, ["admin"]);
    assertBatchSize(args.rows.length);

    const report = await validateLotImportRows(ctx, args.rows);
    const auditReason =
      typeof args.reason === "string" && args.reason.trim().length > 0
        ? args.reason.trim()
        : "Legacy lot inventory import";

    const now = Date.now();
    let created = 0;

    for (const row of report.valid) {
      // Placeholder geometry, section-aware — `gpsImport:importGpsBatch`
      // replaces it with the surveyed polygon later. Importing
      // inventory does NOT pretend to know where the lot is.
      const geometry = getDefaultPlaceholderGeometry({
        section: row.section,
      });

      const insert: {
        code: string;
        section: string;
        sectionId?: ValidatedLotImportRow["sectionId"];
        block: string;
        row: string;
        type: ValidatedLotImportRow["type"];
        dimensions: { widthM: number; depthM: number };
        capacityUnits: number;
        basePriceCents: number;
        status: ValidatedLotImportRow["status"];
        geometry: typeof geometry;
        geometryStatus: "placeholder";
        isRetired: false;
        createdAt: number;
        createdBy: typeof auth.userId;
      } = {
        code: row.code,
        section: row.section,
        block: row.block,
        row: row.row,
        type: row.type,
        dimensions: row.dimensions,
        capacityUnits: DEFAULT_CAPACITY_UNITS[row.type],
        basePriceCents: row.basePriceCents,
        status: row.status,
        geometry,
        geometryStatus: "placeholder",
        isRetired: false,
        createdAt: now,
        createdBy: auth.userId,
      };
      if (row.sectionId !== undefined) {
        insert.sectionId = row.sectionId;
      }

      const lotId: LotId = await ctx.db.insert("lots", insert);
      await bumpLotStatusCounter(ctx, row.status, +1);
      await emitAudit(ctx, {
        action: "create",
        entityType: "lot",
        entityId: lotId,
        reason: auditReason,
        after: {
          code: row.code,
          section: row.section,
          sectionId: row.sectionId ?? null,
          block: row.block,
          row: row.row,
          type: row.type,
          dimensions: row.dimensions,
          basePriceCents: row.basePriceCents,
          status: row.status,
          importedFromLine: row.rowNumber,
        },
      });
      created += 1;
    }

    return {
      totalRows: report.totalRows,
      created,
      plan: toPlan(report.valid),
      errors: report.errors,
      warnings: report.warnings,
    };
  },
});
