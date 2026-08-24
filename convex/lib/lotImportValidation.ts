/**
 * Legacy lot-inventory import — shared read-only validation.
 *
 * Backs BOTH halves of the importer so the dry run and the real run
 * can never disagree:
 *
 *   - `lotImport:previewLotBatch`  (queryGeneric)    — dry run.
 *   - `lotImport:importLotBatch`   (mutationGeneric) — the write.
 *
 * Why the dry run is a QUERY and not `mutation(..., { dryRun: true })`:
 * a Convex query has no `ctx.db.insert`. The "preview must not write"
 * guarantee is then enforced by the runtime rather than by a boolean
 * an operator could mis-set (or a future edit could mishandle) on a
 * 2,000-row migration. Both entry points call `validateLotImportRows`
 * here, so the preview an admin signs off on is exactly the plan the
 * mutation executes.
 *
 * Scope (Q4 of `client-decisions-defaults.md` — legacy records):
 *
 *   The cemetery holds ~2,000 lots as hybrid paper + Excel records.
 *   This module covers the INVENTORY half only: the lot rows
 *   themselves. Customers, contracts, and payment history are NOT
 *   imported — per Q4 those are re-recorded through the normal sale
 *   flow as owners come in to verify, so every peso in the ledger has
 *   a contract and a receipt behind it.
 *
 * Status handling — the one judgement call worth reading:
 *
 *   `status` accepts `available`, `reserved`, and `occupied`. It
 *   REJECTS `sold`.
 *
 *   `sold` in this system means "there is an active contract on this
 *   lot". Importing a bare `sold` lot would manufacture a lot that AR
 *   aging, the reconciliation invariants (Story 5.5), and the
 *   dashboard all expect to find a contract for, and none exists —
 *   a silent data defect that surfaces months later at month-end.
 *   Q4 already settles the intended behaviour: legacy sold lots load
 *   as `available` and the sale is re-recorded when the owner
 *   verifies.
 *
 *   `occupied` is admitted despite the same "no interment row"
 *   asymmetry, because it is a PHYSICAL fact rather than a financial
 *   one. A pre-2020 burial exists in the ground whether or not the
 *   paperwork was ever digitised, and a map that shows those lots as
 *   available invites staff to sell a grave that is already in use.
 *   That failure is materially worse than an interment-less
 *   `occupied` row, which reads correctly everywhere it appears and
 *   still accepts a future interment (`interments.ts:289` allows
 *   scheduling on an already-occupied lot for family plots).
 *
 * Every row is validated independently: one bad row never aborts the
 * batch. The report tells the operator exactly which spreadsheet line
 * to fix, which is the whole point when the source is a hand-kept
 * Excel file of unknown quality.
 */

import { type DataModelFromSchemaDefinition } from "convex/server";

import schema from "../schema";
import type { MutationCtx, QueryCtx } from "./auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type SectionId = DataModel["sections"]["document"]["_id"];

/**
 * Per-call cap. Mirrors `gpsImport.ts:MAX_BATCH_SIZE` — same reasoning
 * (bounded mutation transaction size), same client-side chunking
 * contract. A 2,000-lot cemetery imports as four or five calls; the UI
 * chunks automatically so the operator never sees this number.
 */
export const MAX_IMPORT_BATCH_SIZE = 500;

/** Lot types accepted in the `type` column. Matches the schema union. */
export const IMPORTABLE_LOT_TYPES = [
  "single",
  "family",
  "mausoleum",
  "niche",
] as const;
export type ImportableLotType = (typeof IMPORTABLE_LOT_TYPES)[number];

/**
 * Statuses a legacy row may declare. Deliberately a SUBSET of the
 * schema's seven-member union — see the status note in the file
 * header for why `sold` (and the terminal `cancelled` / `defaulted` /
 * `transferred` states) are not importable.
 */
export const IMPORTABLE_LOT_STATUSES = [
  "available",
  "reserved",
  "occupied",
] as const;
export type ImportableLotStatus = (typeof IMPORTABLE_LOT_STATUSES)[number];

/**
 * One row as it arrives from the client-side CSV parser. Already
 * shape-checked in the browser (`src/lib/lotImportParse.ts`); this
 * module re-validates every field regardless, because the browser is
 * not a trust boundary.
 */
export interface LotImportRow {
  /**
   * 1-based line number in the SOURCE FILE (header row included), not
   * the index in this array. Carried end-to-end so an error reads
   * "line 47" and the operator can open the spreadsheet at line 47.
   */
  rowNumber: number;
  code: string;
  section: string;
  block: string;
  row: string;
  type: string;
  widthM: number;
  depthM: number;
  basePriceCents: number;
  status?: string;
}

export type LotImportErrorReason =
  | "INVALID_INPUT"
  | "INVALID_TYPE"
  | "INVALID_STATUS"
  | "DUPLICATE_IN_FILE"
  | "DUPLICATE_IN_DB";

export interface LotImportRowError {
  rowNumber: number;
  code: string;
  reason: LotImportErrorReason;
  details: string;
}

export type LotImportWarningReason = "SECTION_NOT_REGISTERED";

export interface LotImportRowWarning {
  rowNumber: number;
  code: string;
  reason: LotImportWarningReason;
  details: string;
}

/**
 * A row that passed every check, resolved into exactly the shape the
 * mutation inserts. The mutation does no further interpretation —
 * whatever the preview showed is what gets written.
 */
export interface ValidatedLotImportRow {
  rowNumber: number;
  code: string;
  section: string;
  sectionId?: SectionId;
  block: string;
  row: string;
  type: ImportableLotType;
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: ImportableLotStatus;
}

export interface LotImportValidationReport {
  totalRows: number;
  /** Rows that would be (or were) created. */
  valid: ValidatedLotImportRow[];
  errors: LotImportRowError[];
  /** Non-blocking: the row imports, but the operator should know. */
  warnings: LotImportRowWarning[];
}

/** Trim a possibly-nonstring cell into a string. */
function cell(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Normalises a section label for registry matching. The Excel column
 * is hand-typed across years by different people — "Section A",
 * "section-a", and "SECTION  A" are the same place. Collapse case,
 * punctuation, and runs of whitespace so all three resolve to the one
 * registry row.
 */
export function normalizeSectionKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Validate a batch against the live database.
 *
 * Read-only by construction — takes a `QueryCtx` so a `ctx.db.insert`
 * would not type-check here even if someone added one later. The
 * mutation passes its `MutationCtx`, which is assignable.
 *
 * Two classes of duplicate are distinguished because the operator's
 * fix differs: `DUPLICATE_IN_FILE` means the spreadsheet lists the
 * same lot code twice (fix the file); `DUPLICATE_IN_DB` means the lot
 * already exists here (usually a re-run of a partially-applied batch —
 * the row is simply already done).
 */
export async function validateLotImportRows(
  ctx: QueryCtx | MutationCtx,
  rows: LotImportRow[],
): Promise<LotImportValidationReport> {
  const report: LotImportValidationReport = {
    totalRows: rows.length,
    valid: [],
    errors: [],
    warnings: [],
  };

  // Section registry, keyed by every label an operator might type.
  // Loaded once — the registry is a handful of rows, and doing this
  // per-lot would be 500 scans per call.
  const sectionsByKey = new Map<string, SectionId>();
  for (const section of await ctx.db.query("sections").collect()) {
    if (section.isRetired) continue;
    sectionsByKey.set(normalizeSectionKey(section.name), section._id);
    sectionsByKey.set(normalizeSectionKey(section.displayName), section._id);
  }

  // Codes claimed earlier in THIS batch, so the second occurrence of a
  // duplicated code fails rather than both silently racing to insert.
  const seenCodes = new Map<string, number>();

  for (const raw of rows) {
    const rowNumber =
      Number.isFinite(raw.rowNumber) && raw.rowNumber > 0
        ? Math.floor(raw.rowNumber)
        : 0;
    const code = cell(raw.code);
    const fail = (
      reason: LotImportErrorReason,
      details: string,
    ): void => {
      report.errors.push({ rowNumber, code, reason, details });
    };

    if (code.length === 0) {
      fail("INVALID_INPUT", "Lot code is required.");
      continue;
    }

    const section = cell(raw.section);
    if (section.length === 0) {
      fail("INVALID_INPUT", "Section is required.");
      continue;
    }
    const block = cell(raw.block);
    if (block.length === 0) {
      fail("INVALID_INPUT", "Block is required.");
      continue;
    }
    const rowLabel = cell(raw.row);
    if (rowLabel.length === 0) {
      fail("INVALID_INPUT", "Row is required.");
      continue;
    }

    const type = cell(raw.type).toLowerCase();
    if (!IMPORTABLE_LOT_TYPES.includes(type as ImportableLotType)) {
      fail(
        "INVALID_TYPE",
        `Type must be one of ${IMPORTABLE_LOT_TYPES.join(", ")} — got "${cell(raw.type)}".`,
      );
      continue;
    }

    const rawStatus = cell(raw.status).toLowerCase();
    let status: ImportableLotStatus = "available";
    if (rawStatus.length > 0) {
      if (rawStatus === "sold") {
        fail(
          "INVALID_STATUS",
          'Legacy "sold" lots import as available — a sold lot needs a contract behind it. Import the lot, then re-record the sale through the sale form so the contract and receipt exist. (Client decision Q4.)',
        );
        continue;
      }
      if (!IMPORTABLE_LOT_STATUSES.includes(rawStatus as ImportableLotStatus)) {
        fail(
          "INVALID_STATUS",
          `Status must be one of ${IMPORTABLE_LOT_STATUSES.join(", ")} — got "${cell(raw.status)}".`,
        );
        continue;
      }
      status = rawStatus as ImportableLotStatus;
    }

    if (!Number.isFinite(raw.widthM) || raw.widthM <= 0) {
      fail("INVALID_INPUT", "Width (m) must be a positive number.");
      continue;
    }
    if (!Number.isFinite(raw.depthM) || raw.depthM <= 0) {
      fail("INVALID_INPUT", "Depth (m) must be a positive number.");
      continue;
    }
    if (
      !Number.isFinite(raw.basePriceCents) ||
      !Number.isInteger(raw.basePriceCents) ||
      raw.basePriceCents <= 0
    ) {
      fail(
        "INVALID_INPUT",
        "Base price must resolve to a positive whole number of centavos.",
      );
      continue;
    }

    const priorLine = seenCodes.get(code);
    if (priorLine !== undefined) {
      fail(
        "DUPLICATE_IN_FILE",
        `Lot code "${code}" already appears on line ${priorLine} of this file.`,
      );
      continue;
    }

    const existing = await ctx.db
      .query("lots")
      .withIndex("by_code", (q) => q.eq("code", code))
      .first();
    if (existing !== null) {
      fail(
        "DUPLICATE_IN_DB",
        `A lot with code "${code}" already exists — nothing to import for this row.`,
      );
      continue;
    }

    seenCodes.set(code, rowNumber);

    const sectionId = sectionsByKey.get(normalizeSectionKey(section));
    if (sectionId === undefined) {
      // Non-blocking. The free-text `section` column still carries the
      // value, and `convex/internal/backfillLotSections.ts` can attach
      // the FK later once the registry has a matching row — which is
      // exactly the two-step migration the schema documents.
      report.warnings.push({
        rowNumber,
        code,
        reason: "SECTION_NOT_REGISTERED",
        details: `No section registered as "${section}". The lot imports with the free-text section; register the section and run the backfill to attach the reference.`,
      });
    }

    const validated: ValidatedLotImportRow = {
      rowNumber,
      code,
      section,
      block,
      row: rowLabel,
      type: type as ImportableLotType,
      dimensions: { widthM: raw.widthM, depthM: raw.depthM },
      basePriceCents: raw.basePriceCents,
      status,
    };
    if (sectionId !== undefined) {
      validated.sectionId = sectionId;
    }
    report.valid.push(validated);
  }

  return report;
}
