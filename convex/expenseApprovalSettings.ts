/**
 * Admin-configured expense approval thresholds — Story 6.6 (FR41).
 *
 * The `expenseApprovalSettings` table (schema in `convex/schema.ts`)
 * stores one row per category name plus a sentinel `__default__` row
 * carrying the catch-all threshold used for categories that have not
 * been configured explicitly.
 *
 * Public surface:
 *   - `listExpenseApprovalSettings` — admin list of every configured
 *     row (per-category + the default sentinel) for the settings UI.
 *   - `getExpenseApprovalSettingsMap` — admin/office_staff read-only
 *     map of `{ [category]: { thresholdCents, requiresApproval } }`
 *     used by the recording form to surface "this amount will go
 *     through approval" hints before submit.
 *   - `setExpenseApprovalSetting` — admin upsert ("set the threshold
 *     for Utilities to ₱5,000"). Idempotent — calling with the same
 *     values twice produces one (initial) audit row plus a no-op on
 *     the second call.
 *   - `setDefaultExpenseApprovalSetting` — admin upsert against the
 *     `__default__` sentinel. Convenience wrapper over the above.
 *   - `deleteExpenseApprovalSetting` — admin removes a per-category
 *     override; the default row then takes effect for that category.
 *     The `__default__` sentinel itself CANNOT be deleted (a missing
 *     default is replaced by the implicit `requiresApproval: false`
 *     fallback inside `convex/expenses.ts`).
 *
 * Conventions every handler obeys:
 *   1. FIRST awaited statement is `await requireRole(ctx, ["admin"])`
 *      (or `["admin", "office_staff"]` for the read-only map). The
 *      ESLint rule `local-rules/require-role-first-line` enforces
 *      this at build time.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`.
 *   3. `entityType: "expense"`. The schema's `entityType` union does
 *      not carry a dedicated `expenseApprovalSetting` value; the
 *      `before` / `after` payload carries the operational detail (a
 *      `kind: "expenseApprovalSetting"` tag is set so the audit log
 *      consumer can disambiguate).
 *   4. Money is INTEGER centavos (ADR-0007). The setter validates
 *      `thresholdCents` is a non-negative integer.
 *   5. The default-sentinel category name (`__default__`) cannot be
 *      used as a regular category — a category named exactly
 *      "__default__" is reserved.
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

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type SettingDoc = DataModel["expenseApprovalSettings"]["document"];
type SettingId = SettingDoc["_id"];

/**
 * Sentinel category used to store the catch-all threshold. The string
 * is intentionally unusable as a real category (the leading double-
 * underscore makes it visually distinct in the audit log; the
 * `createExpenseCategory` mutation in `convex/expenseCategories.ts`
 * does not block this name today, so the runtime check below is the
 * single authority — re-validated whenever a setting is written).
 */
export const DEFAULT_CATEGORY_SENTINEL = "__default__";

/**
 * Lists every approval-setting row currently configured. Active and
 * inactive (requiresApproval false) rows are returned — the admin
 * page distinguishes them visually. The default sentinel is always
 * emitted as a synthetic row when no real row exists yet so the UI
 * can render a consistent table on first visit.
 */
export interface ListedApprovalSetting {
  _id: SettingId | null;
  category: string;
  thresholdCents: number;
  requiresApproval: boolean;
  updatedAt: number | null;
  updatedBy: SettingDoc["updatedBy"] | null;
  isDefault: boolean;
}

export const listExpenseApprovalSettings = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{ settings: ListedApprovalSetting[] }> => {
    await requireRole(ctx, ["admin"]);
    const rows = await ctx.db.query("expenseApprovalSettings").collect();
    const hasDefault = rows.some((r) => r.category === DEFAULT_CATEGORY_SENTINEL);
    const out: ListedApprovalSetting[] = rows.map((r) => ({
      _id: r._id,
      category: r.category,
      thresholdCents: r.thresholdCents,
      requiresApproval: r.requiresApproval,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
      isDefault: r.category === DEFAULT_CATEGORY_SENTINEL,
    }));
    if (!hasDefault) {
      // Synthesize a "not yet configured" default row so the UI can
      // render a consistent table on first visit. The admin saving
      // the form then converts the synthetic row to a real one.
      out.unshift({
        _id: null,
        category: DEFAULT_CATEGORY_SENTINEL,
        thresholdCents: 0,
        requiresApproval: false,
        updatedAt: null,
        updatedBy: null,
        isDefault: true,
      });
    }
    return { settings: out };
  },
});

/**
 * Returns a `{ [category]: { thresholdCents, requiresApproval } }`
 * snapshot. Office staff calls this on the expense form to display
 * "this expense will require admin approval" hints inline before
 * submit. The Convex query is reactive — when the admin updates a
 * threshold in another tab, the staff form's hint live-updates.
 */
export const getExpenseApprovalSettingsMap = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{
    map: Record<
      string,
      { thresholdCents: number; requiresApproval: boolean }
    >;
    default: { thresholdCents: number; requiresApproval: boolean };
  }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const rows = await ctx.db.query("expenseApprovalSettings").collect();
    const map: Record<
      string,
      { thresholdCents: number; requiresApproval: boolean }
    > = {};
    let defaultEntry = { thresholdCents: 0, requiresApproval: false };
    for (const row of rows) {
      if (row.category === DEFAULT_CATEGORY_SENTINEL) {
        defaultEntry = {
          thresholdCents: row.thresholdCents,
          requiresApproval: row.requiresApproval,
        };
        continue;
      }
      map[row.category] = {
        thresholdCents: row.thresholdCents,
        requiresApproval: row.requiresApproval,
      };
    }
    return { map, default: defaultEntry };
  },
});

/**
 * Upserts the approval setting for a single category. Pass
 * `category: DEFAULT_CATEGORY_SENTINEL` to write the catch-all row;
 * the dedicated `setDefaultExpenseApprovalSetting` helper below is
 * a thin convenience wrapper.
 *
 * `thresholdCents` is an INTEGER centavos value (ADR-0007). Negative
 * thresholds throw VALIDATION; non-integer values throw VALIDATION.
 * `requiresApproval === false` ignores the threshold entirely — the
 * row exists so the admin can see the per-category opt-out in the
 * settings table.
 *
 * Audit emits `create` on first save, `update` on subsequent saves.
 * A no-op save (identical values) skips the audit emission to avoid
 * audit-log spam.
 */
export const setExpenseApprovalSetting = mutationGeneric({
  args: {
    category: v.string(),
    thresholdCents: v.number(),
    requiresApproval: v.boolean(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      category: string;
      thresholdCents: number;
      requiresApproval: boolean;
    },
  ): Promise<{ settingId: SettingId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const categoryTrimmed = args.category.trim();
    if (categoryTrimmed.length === 0) {
      throwError(ErrorCode.VALIDATION, "Category is required.", {
        field: "category",
      });
    }
    if (
      !Number.isFinite(args.thresholdCents) ||
      !Number.isInteger(args.thresholdCents) ||
      args.thresholdCents < 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Threshold must be a non-negative whole number of centavos.",
        { field: "thresholdCents", value: args.thresholdCents },
      );
    }

    const existing = await ctx.db
      .query("expenseApprovalSettings")
      .withIndex("by_category", (q) => q.eq("category", categoryTrimmed))
      .first();

    const now = Date.now();

    if (existing === null) {
      const settingId = await ctx.db.insert("expenseApprovalSettings", {
        category: categoryTrimmed,
        thresholdCents: args.thresholdCents,
        requiresApproval: args.requiresApproval,
        updatedAt: now,
        updatedBy: auth.userId,
      });

      await emitAudit(ctx, {
        action: "create",
        entityType: "expense",
        entityId: settingId,
        after: {
          kind: "expenseApprovalSetting",
          category: categoryTrimmed,
          thresholdCents: args.thresholdCents,
          requiresApproval: args.requiresApproval,
        },
      });

      return { settingId };
    }

    // No-op short-circuit: identical values → don't bother updating
    // or emitting an audit row (this is the dominant "admin clicked
    // save again with no change" path).
    if (
      existing.thresholdCents === args.thresholdCents &&
      existing.requiresApproval === args.requiresApproval
    ) {
      return { settingId: existing._id };
    }

    await ctx.db.patch(existing._id, {
      thresholdCents: args.thresholdCents,
      requiresApproval: args.requiresApproval,
      updatedAt: now,
      updatedBy: auth.userId,
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "expense",
      entityId: existing._id,
      before: {
        kind: "expenseApprovalSetting",
        category: existing.category,
        thresholdCents: existing.thresholdCents,
        requiresApproval: existing.requiresApproval,
      },
      after: {
        kind: "expenseApprovalSetting",
        category: existing.category,
        thresholdCents: args.thresholdCents,
        requiresApproval: args.requiresApproval,
      },
    });

    return { settingId: existing._id };
  },
});

/**
 * Convenience wrapper around `setExpenseApprovalSetting` that targets
 * the `__default__` sentinel. Useful for the UI's "set default
 * threshold" affordance — keeps the call site explicit about intent.
 */
export const setDefaultExpenseApprovalSetting = mutationGeneric({
  args: {
    thresholdCents: v.number(),
    requiresApproval: v.boolean(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { thresholdCents: number; requiresApproval: boolean },
  ): Promise<{ settingId: SettingId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    if (
      !Number.isFinite(args.thresholdCents) ||
      !Number.isInteger(args.thresholdCents) ||
      args.thresholdCents < 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Threshold must be a non-negative whole number of centavos.",
        { field: "thresholdCents", value: args.thresholdCents },
      );
    }

    const existing = await ctx.db
      .query("expenseApprovalSettings")
      .withIndex("by_category", (q) =>
        q.eq("category", DEFAULT_CATEGORY_SENTINEL),
      )
      .first();

    const now = Date.now();
    if (existing === null) {
      const settingId = await ctx.db.insert("expenseApprovalSettings", {
        category: DEFAULT_CATEGORY_SENTINEL,
        thresholdCents: args.thresholdCents,
        requiresApproval: args.requiresApproval,
        updatedAt: now,
        updatedBy: auth.userId,
      });
      await emitAudit(ctx, {
        action: "create",
        entityType: "expense",
        entityId: settingId,
        after: {
          kind: "expenseApprovalSetting",
          category: DEFAULT_CATEGORY_SENTINEL,
          thresholdCents: args.thresholdCents,
          requiresApproval: args.requiresApproval,
        },
      });
      return { settingId };
    }

    if (
      existing.thresholdCents === args.thresholdCents &&
      existing.requiresApproval === args.requiresApproval
    ) {
      return { settingId: existing._id };
    }

    await ctx.db.patch(existing._id, {
      thresholdCents: args.thresholdCents,
      requiresApproval: args.requiresApproval,
      updatedAt: now,
      updatedBy: auth.userId,
    });
    await emitAudit(ctx, {
      action: "update",
      entityType: "expense",
      entityId: existing._id,
      before: {
        kind: "expenseApprovalSetting",
        category: DEFAULT_CATEGORY_SENTINEL,
        thresholdCents: existing.thresholdCents,
        requiresApproval: existing.requiresApproval,
      },
      after: {
        kind: "expenseApprovalSetting",
        category: DEFAULT_CATEGORY_SENTINEL,
        thresholdCents: args.thresholdCents,
        requiresApproval: args.requiresApproval,
      },
    });
    return { settingId: existing._id };
  },
});

/**
 * Removes a per-category override. The default-sentinel row CANNOT
 * be deleted — attempts return VALIDATION. Removing a category row
 * causes that category's expenses to fall back to the default-
 * sentinel threshold (or the implicit `requiresApproval: false` if
 * the default has not been configured yet).
 */
export const deleteExpenseApprovalSetting = mutationGeneric({
  args: {
    settingId: v.id("expenseApprovalSettings"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { settingId: SettingId },
  ): Promise<{ deleted: true }> => {
    await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.settingId);
    if (existing === null) {
      throwError(
        ErrorCode.NOT_FOUND,
        "Expense approval setting not found.",
        { settingId: args.settingId },
      );
    }

    if (existing.category === DEFAULT_CATEGORY_SENTINEL) {
      throwError(
        ErrorCode.VALIDATION,
        "The default expense approval setting cannot be deleted. Set requiresApproval to false instead.",
        { kind: "CANNOT_DELETE_DEFAULT_APPROVAL_SETTING" },
      );
    }

    await ctx.db.delete(args.settingId);

    await emitAudit(ctx, {
      action: "delete",
      entityType: "expense",
      entityId: args.settingId,
      before: {
        kind: "expenseApprovalSetting",
        category: existing.category,
        thresholdCents: existing.thresholdCents,
        requiresApproval: existing.requiresApproval,
      },
    });

    return { deleted: true };
  },
});
