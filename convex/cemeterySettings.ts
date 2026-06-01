/**
 * Cemetery-wide settings — BIR receipt configuration.
 *
 * Owns the public-facing surface for `/admin/settings/bir-receipt-config`:
 *
 *   - `getBirReceiptConfig` (query) — admin-only read of the singleton
 *     `birReceiptConfig` row used by the settings page. Returns `null`
 *     when the row has not been seeded yet so the UI can prompt for
 *     the one-shot seed before showing the form.
 *   - `setBirReceiptConfig` (mutation) — admin-only upsert covering
 *     every field on the row, plus the `isPlaceholder` toggle. Emits
 *     an `update`-action audit row for every change (the BIR identity
 *     is compliance-relevant — "when did the cemetery promote the
 *     config to production-ready?" is the kind of question an
 *     auditor will ask).
 *
 * The receipt PDF generation path (`convex/actions/generateReceiptPdf.ts`)
 * pulls this same row via `loadBirReceiptConfig` in
 * `convex/lib/birFormat.ts` and REFUSES to render while
 * `isPlaceholder === true` — every receipt produced from a
 * placeholder config would be BIR-non-compliant by construction
 * (placeholder TIN, placeholder ATP, missing mandatory footer text).
 *
 * Auth: every public handler calls `requireRole(ctx, ["admin"])` as
 * its first awaited statement (the `require-role-first-line` ESLint
 * rule enforces this).
 *
 * Audit: every successful mutation emits via `emitAudit`. The
 * `entityType: "user"` choice mirrors `setSalesAgentTracking` in
 * `convex/reports.ts` — the audit-log `entityType` union does not
 * carry a dedicated `cemeterySetting` value, and adding one would
 * touch `auditLog`'s validator + the audit helper (CRIT scopes
 * forbid that here). The `kind: "birReceiptConfig"` tag inside the
 * `before` / `after` payload lets the audit-log consumer
 * disambiguate.
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

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type BirReceiptConfigDoc = DataModel["birReceiptConfig"]["document"];
type BirReceiptConfigId = BirReceiptConfigDoc["_id"];

/**
 * Row shape returned by `getBirReceiptConfig` — mirrors the underlying
 * document so the settings page can hydrate the form directly.
 *
 * `_id` is exposed (the UI doesn't need it but Storybook fixtures and
 * future "view the audit history for this config" pages do). The
 * mutation does NOT take an id — it always upserts the singleton.
 */
export interface BirReceiptConfigResult {
  _id: BirReceiptConfigId;
  registeredName: string;
  tradeName: string | null;
  tin: string;
  registeredAddressLines: string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate: number | null;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
  updatedAt: number;
  updatedBy: BirReceiptConfigDoc["updatedBy"];
}

/**
 * Admin-only read of the `birReceiptConfig` singleton. Returns `null`
 * when the row has not been seeded yet — the settings UI surfaces a
 * "BIR config not initialised" state and instructs the operator to
 * run the seed.
 */
export const getBirReceiptConfig = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<BirReceiptConfigResult | null> => {
    await requireRole(ctx, ["admin"]);
    const row = await ctx.db.query("birReceiptConfig").first();
    if (row === null) return null;
    return {
      _id: row._id,
      registeredName: row.registeredName,
      tradeName: row.tradeName ?? null,
      tin: row.tin,
      registeredAddressLines: [...row.registeredAddressLines],
      atpNumber: row.atpNumber,
      atpExpiryDate: row.atpExpiryDate,
      serialRangeStart: row.serialRangeStart,
      serialRangeEnd: row.serialRangeEnd,
      vatRate: row.vatRate ?? null,
      isVatRegistered: row.isVatRegistered,
      isPlaceholder: row.isPlaceholder,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  },
});

/** Arg shape for `setBirReceiptConfig`. Every field is required so the
 * mutation overwrites the row atomically — the form sends the full
 * value set on every save (matches the cadence-config write pattern in
 * `setRemindersPaused` / `setReminderConfig`). */
interface SetBirReceiptConfigArgs {
  registeredName: string;
  tradeName?: string;
  tin: string;
  registeredAddressLines: string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate?: number;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
}

/**
 * Validation cap on individual address lines. BIR's permit issues
 * physical-mail addresses; even the longest registered legal address
 * fits comfortably under this.
 */
const MAX_ADDRESS_LINE_LENGTH = 200;

/**
 * Admin upsert of the `birReceiptConfig` singleton. Validates the
 * payload, upserts the row, and emits the audit log.
 *
 * Validation summary (every check throws `VALIDATION` with the
 * field name in `details`):
 *   - `registeredName` — non-empty after trim.
 *   - `tin` — exactly 12 digits (BIR canonical shape). The display
 *     formatter (`formatTin` in `convex/lib/birFormat.ts`) tolerates
 *     other lengths defensively, but the canonical at-rest shape is
 *     12 digits.
 *   - `registeredAddressLines` — non-empty array; each line is a
 *     non-empty string of ≤ 200 chars after trim.
 *   - `atpNumber` — non-empty after trim.
 *   - `atpExpiryDate` — integer epoch ms; cannot be in the past more
 *     than one year (a generous tolerance for back-dated entries).
 *     Future-dated expiry is allowed (the common case — BIR ATPs
 *     usually have multi-year validity).
 *   - `serialRangeStart` / `serialRangeEnd` — non-empty after trim.
 *   - `vatRate` — when supplied, finite + non-negative + ≤ 100.
 *   - `isVatRegistered` — boolean; no further validation.
 *   - `isPlaceholder` — boolean; the only field with a destructive
 *     UX (toggling false signals production-ready).
 */
export const setBirReceiptConfig = mutationGeneric({
  args: {
    registeredName: v.string(),
    tradeName: v.optional(v.string()),
    tin: v.string(),
    registeredAddressLines: v.array(v.string()),
    atpNumber: v.string(),
    atpExpiryDate: v.number(),
    serialRangeStart: v.string(),
    serialRangeEnd: v.string(),
    vatRate: v.optional(v.number()),
    isVatRegistered: v.boolean(),
    isPlaceholder: v.boolean(),
  },
  handler: async (
    ctx: MutationCtx,
    args: SetBirReceiptConfigArgs,
  ): Promise<{ configId: BirReceiptConfigId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const normalized = validateAndNormalize(args);

    const existing = await ctx.db.query("birReceiptConfig").first();

    const now = Date.now();

    if (existing === null) {
      const configId = await ctx.db.insert("birReceiptConfig", {
        ...normalized,
        updatedAt: now,
        updatedBy: auth.userId,
      });
      await emitAudit(ctx, {
        action: "create",
        entityType: "user",
        entityId: configId,
        after: {
          kind: "birReceiptConfig",
          ...auditPayload(normalized),
        },
      });
      return { configId };
    }

    await ctx.db.patch(existing._id, {
      ...normalized,
      updatedAt: now,
      updatedBy: auth.userId,
    });
    await emitAudit(ctx, {
      action: "update",
      entityType: "user",
      entityId: existing._id,
      before: {
        kind: "birReceiptConfig",
        ...auditPayload({
          registeredName: existing.registeredName,
          tradeName: existing.tradeName,
          tin: existing.tin,
          registeredAddressLines: [...existing.registeredAddressLines],
          atpNumber: existing.atpNumber,
          atpExpiryDate: existing.atpExpiryDate,
          serialRangeStart: existing.serialRangeStart,
          serialRangeEnd: existing.serialRangeEnd,
          vatRate: existing.vatRate,
          isVatRegistered: existing.isVatRegistered,
          isPlaceholder: existing.isPlaceholder,
        }),
      },
      after: {
        kind: "birReceiptConfig",
        ...auditPayload(normalized),
      },
    });
    return { configId: existing._id };
  },
});

/**
 * Normalized shape stored on the row — trims strings, drops absent
 * optionals. Validation rejects malformed inputs; this helper does the
 * pure shape-massaging so the insert / patch can pass a single
 * payload object.
 */
interface NormalizedBirReceiptConfig {
  registeredName: string;
  tradeName?: string;
  tin: string;
  registeredAddressLines: string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate?: number;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
}

function validateAndNormalize(
  args: SetBirReceiptConfigArgs,
): NormalizedBirReceiptConfig {
  const registeredName = args.registeredName.trim();
  if (registeredName.length === 0) {
    throwError(ErrorCode.VALIDATION, "Registered name is required.", {
      field: "registeredName",
    });
  }

  // BIR TIN is 12 digits with no separators in the canonical at-rest
  // shape. We strip incidental whitespace / hyphens the operator may
  // have pasted in, then enforce the digit count.
  const tinDigits = args.tin.replace(/\D/g, "");
  if (tinDigits.length !== 12) {
    throwError(
      ErrorCode.VALIDATION,
      "TIN must be 12 digits (e.g. 123456789000).",
      { field: "tin", length: tinDigits.length },
    );
  }

  const trimmedLines = args.registeredAddressLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (trimmedLines.length === 0) {
    throwError(
      ErrorCode.VALIDATION,
      "At least one BIR-registered address line is required.",
      { field: "registeredAddressLines" },
    );
  }
  for (const line of trimmedLines) {
    if (line.length > MAX_ADDRESS_LINE_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Address line exceeds ${MAX_ADDRESS_LINE_LENGTH} chars.`,
        { field: "registeredAddressLines", line: line.slice(0, 40) },
      );
    }
  }

  const atpNumber = args.atpNumber.trim();
  if (atpNumber.length === 0) {
    throwError(ErrorCode.VALIDATION, "ATP number is required.", {
      field: "atpNumber",
    });
  }

  if (!Number.isInteger(args.atpExpiryDate)) {
    throwError(
      ErrorCode.VALIDATION,
      "ATP expiry must be a valid epoch-ms integer.",
      { field: "atpExpiryDate" },
    );
  }
  // Allow up to one year back-dated entry; sane operators only enter
  // current / future expiries, but a back-dated entry might be needed
  // for an audit reconstruction.
  const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  if (args.atpExpiryDate < Date.now() - ONE_YEAR_MS) {
    throwError(
      ErrorCode.VALIDATION,
      "ATP expiry is more than a year in the past — double-check the date.",
      { field: "atpExpiryDate" },
    );
  }

  const serialRangeStart = args.serialRangeStart.trim();
  const serialRangeEnd = args.serialRangeEnd.trim();
  if (serialRangeStart.length === 0 || serialRangeEnd.length === 0) {
    throwError(
      ErrorCode.VALIDATION,
      "Serial range start and end are both required.",
      {
        field:
          serialRangeStart.length === 0 ? "serialRangeStart" : "serialRangeEnd",
      },
    );
  }

  if (args.vatRate !== undefined) {
    if (!Number.isFinite(args.vatRate) || args.vatRate < 0 || args.vatRate > 100) {
      throwError(
        ErrorCode.VALIDATION,
        "VAT rate must be between 0 and 100.",
        { field: "vatRate", value: args.vatRate },
      );
    }
  }

  const normalized: NormalizedBirReceiptConfig = {
    registeredName,
    tin: tinDigits,
    registeredAddressLines: trimmedLines,
    atpNumber,
    atpExpiryDate: args.atpExpiryDate,
    serialRangeStart,
    serialRangeEnd,
    isVatRegistered: args.isVatRegistered,
    isPlaceholder: args.isPlaceholder,
  };
  if (args.tradeName !== undefined && args.tradeName.trim().length > 0) {
    normalized.tradeName = args.tradeName.trim();
  }
  if (args.vatRate !== undefined) {
    normalized.vatRate = args.vatRate;
  }
  return normalized;
}

/**
 * Audit-row payload helper. Pulls out the fields that matter for the
 * "what changed?" diff; intentionally omits `updatedAt` / `updatedBy`
 * which the audit row carries via the actor / timestamp columns.
 */
function auditPayload(
  source: Pick<
    BirReceiptConfigDoc,
    | "registeredName"
    | "tradeName"
    | "tin"
    | "registeredAddressLines"
    | "atpNumber"
    | "atpExpiryDate"
    | "serialRangeStart"
    | "serialRangeEnd"
    | "vatRate"
    | "isVatRegistered"
    | "isPlaceholder"
  >,
): Record<string, unknown> {
  return {
    registeredName: source.registeredName,
    tradeName: source.tradeName ?? null,
    tin: source.tin,
    registeredAddressLines: [...source.registeredAddressLines],
    atpNumber: source.atpNumber,
    atpExpiryDate: source.atpExpiryDate,
    serialRangeStart: source.serialRangeStart,
    serialRangeEnd: source.serialRangeEnd,
    vatRate: source.vatRate ?? null,
    isVatRegistered: source.isVatRegistered,
    isPlaceholder: source.isPlaceholder,
  };
}
