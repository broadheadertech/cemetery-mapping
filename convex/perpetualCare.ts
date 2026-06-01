/**
 * Perpetual care policy — admin / read surface (Story 3.8 rebuild, FR25).
 *
 * This file owns the public Convex functions for the
 * `perpetualCarePolicy` singleton table:
 *
 *   - `getPerpetualCarePolicy` — admin-only query. Returns the
 *     singleton row (or `null` when the seed has not yet run).
 *     Surfaces the policy + `isPlaceholder` flag so the admin
 *     settings page renders the red banner + the editable form.
 *
 *   - `previewPerpetualCareForLot` — office_staff / admin query.
 *     Hydrates the policy-derived fee for a given lot id so the
 *     SaleForm renders a read-only "Perpetual care: ₱5,000 (per
 *     Apostle Paul policy)" line without the operator entering a
 *     value. Returns `feeCents: 0` + a placeholder flag when the
 *     policy is unconfigured (the sale-path mutation will throw on
 *     submit; the preview surfaces the warning copy earlier).
 *
 *   - `updatePerpetualCarePolicy` — admin-only mutation. Upserts the
 *     singleton row. Audit-logged. Flipping `isPlaceholder: false`
 *     is the destructive admin confirmation that unblocks the
 *     sale-path helper.
 *
 *   - `seedPerpetualCarePolicy` — internal mutation. Idempotent
 *     seeder; inserts the Q7-default row with `isPlaceholder: true`
 *     if absent. Used by the seed script + deploy bootstrap.
 *
 * Conventions every handler obeys:
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])` for
 *      public functions (the lint rule enforces this).
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned.
 *   3. The internal seed mutation skips `requireRole` (no caller
 *      identity in internal contexts; mirrors `seedReceiptCounter`'s
 *      pattern).
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import {
  computePerpetualCareForSale,
  Q7_DEFAULT_ONE_TIME_FEES,
  type PerpetualCareBillingType,
  type PerpetualCarePolicyType,
} from "./lib/perpetualCare";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotId = DataModel["lots"]["document"]["_id"];

const policyTypeValidator = v.union(
  v.literal("one_time"),
  v.literal("annual"),
  v.literal("none"),
);

const oneTimeFeesValidator = v.array(
  v.object({
    lotType: v.string(),
    feeCents: v.number(),
  }),
);

/**
 * Public arg shape for `updatePerpetualCarePolicy`. The destructive
 * `isPlaceholder: false` flip + the per-type fee schedule live in the
 * same mutation so the admin save is atomic — a save that flips the
 * placeholder AND changes the fee schedule lands as one audit row,
 * one transaction.
 */
export interface UpdatePerpetualCarePolicyArgs {
  type: PerpetualCarePolicyType;
  oneTimeFeesByLotType?: Array<{ lotType: string; feeCents: number }>;
  annualFeeCents?: number;
  annualBillingStartMonthsAfterSale?: number;
  isPlaceholder: boolean;
}

export interface PerpetualCarePolicyResult {
  type: PerpetualCarePolicyType;
  oneTimeFeesByLotType?: Array<{ lotType: string; feeCents: number }>;
  annualFeeCents?: number;
  annualBillingStartMonthsAfterSale?: number;
  isPlaceholder: boolean;
  updatedAt: number;
}

/**
 * Admin-only read of the perpetual-care policy singleton. Returns
 * `null` when the seed has not yet inserted a row (fresh
 * deployment). Office-staff sale-path consumers should use the
 * lib-level `loadPerpetualCarePolicy` helper instead — the admin
 * surface needs the placeholder flag for the form's banner; the
 * sale-path helper throws.
 */
export const getPerpetualCarePolicy = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<PerpetualCarePolicyResult | null> => {
    await requireRole(ctx, ["admin"]);
    const row = await ctx.db.query("perpetualCarePolicy").first();
    if (row === null) return null;
    const result: PerpetualCarePolicyResult = {
      type: row.type,
      isPlaceholder: row.isPlaceholder,
      updatedAt: row.updatedAt,
    };
    if (row.oneTimeFeesByLotType !== undefined) {
      result.oneTimeFeesByLotType = row.oneTimeFeesByLotType;
    }
    if (row.annualFeeCents !== undefined) {
      result.annualFeeCents = row.annualFeeCents;
    }
    if (row.annualBillingStartMonthsAfterSale !== undefined) {
      result.annualBillingStartMonthsAfterSale =
        row.annualBillingStartMonthsAfterSale;
    }
    return result;
  },
});

/**
 * Per-lot perpetual-care fee preview. Used by the SaleForm to
 * render the read-only "Perpetual care: ₱X,XXX (per Apostle Paul
 * policy)" line. Returns `{ feeCents: 0, billingType: "none",
 * isPlaceholder: true }` when the policy is unconfigured so the
 * preview UI can render a "Policy pending — confirm in admin
 * settings before submitting" warning. The sale-path mutation
 * will throw on submit; the preview catches the misconfiguration
 * earlier.
 */
export interface PreviewPerpetualCareForLotResult {
  feeCents: number;
  billingType: PerpetualCareBillingType;
  isPlaceholder: boolean;
  policyType: PerpetualCarePolicyType;
}

export const previewPerpetualCareForLot = queryGeneric({
  args: { lotId: v.id("lots") },
  handler: async (
    ctx: QueryCtx,
    args: { lotId: LotId },
  ): Promise<PreviewPerpetualCareForLotResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const lot = await ctx.db.get(args.lotId);
    if (lot === null) {
      throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: args.lotId });
    }
    const policy = await ctx.db.query("perpetualCarePolicy").first();
    if (policy === null) {
      return {
        feeCents: 0,
        billingType: "none",
        isPlaceholder: true,
        policyType: "none",
      };
    }
    const derived = computePerpetualCareForSale(policy, lot.type);
    return {
      feeCents: derived.feeCents,
      billingType: derived.billingType,
      isPlaceholder: policy.isPlaceholder,
      policyType: policy.type,
    };
  },
});

/**
 * Validates the per-lot-type fee schedule shape. Each row's
 * `lotType` must be a non-empty trimmed string; each `feeCents`
 * must be a non-negative integer. Duplicates within the array
 * throw.
 */
function validateOneTimeFees(
  rows: Array<{ lotType: string; feeCents: number }>,
): Array<{ lotType: string; feeCents: number }> {
  const seen = new Set<string>();
  const out: Array<{ lotType: string; feeCents: number }> = [];
  for (const row of rows) {
    const trimmed = row.lotType.trim();
    if (trimmed.length === 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Lot type must be a non-empty string.",
        { lotType: row.lotType },
      );
    }
    if (seen.has(trimmed)) {
      throwError(
        ErrorCode.VALIDATION,
        `Duplicate lot type "${trimmed}" in perpetual-care fee schedule.`,
        { lotType: trimmed },
      );
    }
    seen.add(trimmed);
    if (
      !Number.isFinite(row.feeCents) ||
      !Number.isInteger(row.feeCents) ||
      row.feeCents < 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Perpetual-care fee for lot type "${trimmed}" must be a non-negative integer in centavos.`,
        { lotType: trimmed, feeCents: row.feeCents },
      );
    }
    out.push({ lotType: trimmed, feeCents: row.feeCents });
  }
  return out;
}

/**
 * Admin upsert of the perpetual-care policy singleton. Atomically
 * writes the new policy + audit row. Flipping `isPlaceholder: false`
 * is the destructive confirmation that unblocks the sale-path
 * helper; flipping it back to `true` re-blocks sales.
 */
export const updatePerpetualCarePolicy = mutationGeneric({
  args: {
    type: policyTypeValidator,
    oneTimeFeesByLotType: v.optional(oneTimeFeesValidator),
    annualFeeCents: v.optional(v.number()),
    annualBillingStartMonthsAfterSale: v.optional(v.number()),
    isPlaceholder: v.boolean(),
  },
  handler: async (
    ctx: MutationCtx,
    args: UpdatePerpetualCarePolicyArgs,
  ): Promise<PerpetualCarePolicyResult> => {
    const auth = await requireRole(ctx, ["admin"]);

    // Per-type invariants. The form is the primary gate (the admin
    // UI hides irrelevant fields); these are the defense-in-depth
    // server checks against a tampered or out-of-date client.
    if (args.type === "one_time") {
      if (
        args.oneTimeFeesByLotType === undefined ||
        args.oneTimeFeesByLotType.length === 0
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "One-time policy requires at least one lot-type fee row.",
        );
      }
    }
    if (args.type === "annual") {
      if (
        args.annualFeeCents === undefined ||
        !Number.isFinite(args.annualFeeCents) ||
        !Number.isInteger(args.annualFeeCents) ||
        args.annualFeeCents < 0
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "Annual policy requires a non-negative annualFeeCents.",
          { annualFeeCents: args.annualFeeCents ?? null },
        );
      }
      if (
        args.annualBillingStartMonthsAfterSale !== undefined &&
        (!Number.isInteger(args.annualBillingStartMonthsAfterSale) ||
          args.annualBillingStartMonthsAfterSale < 0)
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "annualBillingStartMonthsAfterSale must be a non-negative integer.",
          {
            annualBillingStartMonthsAfterSale:
              args.annualBillingStartMonthsAfterSale,
          },
        );
      }
    }

    const cleanedFees =
      args.oneTimeFeesByLotType !== undefined
        ? validateOneTimeFees(args.oneTimeFeesByLotType)
        : undefined;

    const now = Date.now();
    const existing = await ctx.db.query("perpetualCarePolicy").first();

    type PolicyInsert =
      DataModel["perpetualCarePolicy"]["document"] extends infer Doc
        ? Omit<Doc, "_id" | "_creationTime">
        : never;
    const row: PolicyInsert = {
      type: args.type,
      isPlaceholder: args.isPlaceholder,
      updatedAt: now,
      updatedBy: auth.userId,
    };
    if (cleanedFees !== undefined) row.oneTimeFeesByLotType = cleanedFees;
    if (args.annualFeeCents !== undefined) row.annualFeeCents = args.annualFeeCents;
    if (args.annualBillingStartMonthsAfterSale !== undefined) {
      row.annualBillingStartMonthsAfterSale =
        args.annualBillingStartMonthsAfterSale;
    }

    const auditBefore: Record<string, unknown> | undefined =
      existing !== null
        ? {
            type: existing.type,
            isPlaceholder: existing.isPlaceholder,
            oneTimeFeesByLotType: existing.oneTimeFeesByLotType ?? null,
            annualFeeCents: existing.annualFeeCents ?? null,
            annualBillingStartMonthsAfterSale:
              existing.annualBillingStartMonthsAfterSale ?? null,
          }
        : undefined;
    const auditAfter: Record<string, unknown> = {
      type: row.type,
      isPlaceholder: row.isPlaceholder,
      oneTimeFeesByLotType: row.oneTimeFeesByLotType ?? null,
      annualFeeCents: row.annualFeeCents ?? null,
      annualBillingStartMonthsAfterSale:
        row.annualBillingStartMonthsAfterSale ?? null,
    };

    if (existing !== null) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("perpetualCarePolicy", row);
    }

    // The audit entity type doesn't include a dedicated
    // perpetualCarePolicy literal; reuse `contract` because the
    // policy is a contract-pricing concern. Future schema work can
    // promote this to its own entity type.
    await emitAudit(ctx, {
      action: existing !== null ? "update" : "create",
      entityType: "contract",
      entityId: "perpetualCarePolicy:singleton",
      before: auditBefore,
      after: auditAfter,
      reason: "Perpetual care policy updated by admin.",
    });

    const result: PerpetualCarePolicyResult = {
      type: row.type,
      isPlaceholder: row.isPlaceholder,
      updatedAt: now,
    };
    if (row.oneTimeFeesByLotType !== undefined) {
      result.oneTimeFeesByLotType = row.oneTimeFeesByLotType;
    }
    if (row.annualFeeCents !== undefined) result.annualFeeCents = row.annualFeeCents;
    if (row.annualBillingStartMonthsAfterSale !== undefined) {
      result.annualBillingStartMonthsAfterSale =
        row.annualBillingStartMonthsAfterSale;
    }
    return result;
  },
});

/**
 * Idempotent seeder for the perpetual-care policy singleton. Inserts
 * the Q7-default row with `isPlaceholder: true` when absent; no-op
 * otherwise. Mirrors the pattern from `seedReceiptCounter`.
 *
 * The seed deliberately writes `isPlaceholder: true` so sales fail-
 * closed until an admin confirms the policy in the settings page.
 * The Q7 defaults (single ₱5k, family ₱5k, mausoleum ₱10k, niche
 * ₱0) are pre-filled as the form's initial values.
 *
 * The seeded `updatedBy` accepts an optional caller id; when absent
 * (script invocation), it requires a placeholder admin user id from
 * the caller via the `seededByUserId` arg — we cannot mint a user
 * id inside the internal mutation.
 */
export const seedPerpetualCarePolicy = internalMutationGeneric({
  args: {
    seededByUserId: v.id("users"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { seededByUserId: DataModel["users"]["document"]["_id"] },
  ): Promise<{ alreadySeeded: boolean }> => {
    const existing = await ctx.db.query("perpetualCarePolicy").first();
    if (existing !== null) {
      return { alreadySeeded: true };
    }
    await ctx.db.insert("perpetualCarePolicy", {
      type: "one_time",
      oneTimeFeesByLotType: Q7_DEFAULT_ONE_TIME_FEES.map((row) => ({
        lotType: row.lotType,
        feeCents: row.feeCents,
      })),
      isPlaceholder: true,
      updatedAt: Date.now(),
      updatedBy: args.seededByUserId,
    });
    return { alreadySeeded: false };
  },
});
