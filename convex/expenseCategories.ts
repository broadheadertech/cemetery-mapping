/**
 * Admin-managed expense categories — Story 4.7 (FR40).
 *
 * Public CRUD surface for the `expenseCategories` table introduced in
 * this story. Every function below is gated to `admin` only — the
 * office_staff role consumes the resulting list through Story 4.6's
 * `getActiveCategoriesForForm` query, but only admins manage the
 * taxonomy itself.
 *
 * Story 4.6's `convex/lib/expenseCategories.ts` is the single source
 * of truth for the active category set; the helpers there now query
 * this table directly (with a bootstrap fallback to the hardcoded
 * defaults when the table is empty). The ExpenseForm is therefore
 * unchanged across the swap.
 *
 * Conventions every handler obeys:
 *
 *   1. FIRST awaited statement is `await requireRole(ctx, ["admin"])`.
 *      The ESLint rule `local-rules/require-role-first-line` enforces
 *      this at build time.
 *   2. Mutations call `emitAudit` — direct `auditLog` inserts are
 *      banned by `local-rules/no-audit-log-direct-write`.
 *   3. Audit `entityType` is `"expense"`. The `auditLog.entityType`
 *      schema validator does NOT include a dedicated `"expenseCategory"`
 *      value, and adding one is a follow-up coordinated with the
 *      audit cornerstone owners (both the schema validator and
 *      `convex/lib/audit.ts`'s `AuditEntityType` would change). The
 *      action codes (`"create" / "update" / "deactivate" /
 *      "reactivate" / "delete"`) match the existing controlled
 *      vocabulary; the `before` / `after` payload carries the
 *      operational detail (category name, isActive, description).
 *   4. Deactivate-not-delete: `setExpenseCategoryActive` is the
 *      hide-from-new-entries path; `deleteExpenseCategory` is allowed
 *      ONLY when no expenses reference the category by name.
 *      Cascade-delete is explicitly forbidden — historical expenses
 *      keep the original category string on their own row.
 *   5. Case-insensitive uniqueness via the `nameLowercased`
 *      denormalised column + the `by_nameLowercased` index. The
 *      check considers both active AND inactive rows — you cannot
 *      have two "Utilities" categories even if one is deactivated.
 *   6. Historical-rename immutability: updating a category's name
 *      does NOT rewrite the `expenses.category` string on any prior
 *      expense row. The expense captured its category at write time
 *      (FR31 financial-history immutability principle).
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
type ExpenseCategoryDoc = DataModel["expenseCategories"]["document"];
type ExpenseCategoryId = ExpenseCategoryDoc["_id"];

/**
 * Maximum lengths for the form fields. Mirrored by the client-side
 * Zod schema; the server is authoritative.
 */
export const CATEGORY_NAME_MAX_LENGTH = 50;
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Shape the admin list page consumes. Each row carries the raw
 * document plus a denormalised `linkedExpenseCount` so the "Delete"
 * action can render conditionally without an extra round-trip per
 * row.
 */
export interface ListedExpenseCategory {
  _id: ExpenseCategoryId;
  _creationTime: number;
  name: string;
  nameLowercased: string;
  description?: string;
  isActive: boolean;
  displayOrder?: number;
  createdAt: number;
  createdBy: ExpenseCategoryDoc["createdBy"];
  lastModifiedAt?: number;
  lastModifiedBy?: ExpenseCategoryDoc["lastModifiedBy"];
  linkedExpenseCount: number;
}

/**
 * Lists categories with their linked-expense counts. Sort order:
 * active first (by name asc), then inactive (by name asc).
 *
 * `includeInactive` defaults to `false` for the form's read-through
 * path; the admin list page passes `true` to surface deactivated
 * rows.
 */
export const listExpenseCategories = queryGeneric({
  args: {
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { includeInactive?: boolean },
  ): Promise<ListedExpenseCategory[]> => {
    await requireRole(ctx, ["admin"]);
    const rows = await ctx.db.query("expenseCategories").collect();
    const includeInactive = args.includeInactive === true;
    const filtered = includeInactive
      ? rows
      : rows.filter((r) => r.isActive);

    // Compute linked-expense counts. Phase 1 scale (hundreds of
    // expenses at most) makes per-category index scans cheap; if
    // expense volume reaches 10k+ we switch to a maintained counter
    // (documented in the Story 4.7 spec).
    const out: ListedExpenseCategory[] = [];
    for (const row of filtered) {
      const linkedExpenses = await ctx.db
        .query("expenses")
        .withIndex("by_category", (q) => q.eq("category", row.name))
        .collect();
      const item: ListedExpenseCategory = {
        _id: row._id,
        _creationTime: row._creationTime,
        name: row.name,
        nameLowercased: row.nameLowercased,
        isActive: row.isActive,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
        linkedExpenseCount: linkedExpenses.length,
      };
      if (row.description !== undefined) item.description = row.description;
      if (row.displayOrder !== undefined) item.displayOrder = row.displayOrder;
      if (row.lastModifiedAt !== undefined) {
        item.lastModifiedAt = row.lastModifiedAt;
      }
      if (row.lastModifiedBy !== undefined) {
        item.lastModifiedBy = row.lastModifiedBy;
      }
      out.push(item);
    }
    // Sort: active rows first (active === true), then by name asc.
    // `Array.sort` is stable in modern engines (Node 20+), so the
    // secondary key holds even when the primary ties.
    return out.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  },
});

/**
 * Returns `{ available: boolean }` for a candidate name. Used by the
 * Edit dialog's inline duplicate check (debounced on blur).
 *
 * `excludeCategoryId` lets the edit flow check uniqueness while
 * keeping its own current name from registering as a duplicate
 * conflict.
 */
export const checkNameAvailability = queryGeneric({
  args: {
    name: v.string(),
    excludeCategoryId: v.optional(v.id("expenseCategories")),
  },
  handler: async (
    ctx: QueryCtx,
    args: { name: string; excludeCategoryId?: ExpenseCategoryId },
  ): Promise<{ available: boolean }> => {
    await requireRole(ctx, ["admin"]);
    const lowered = args.name.trim().toLowerCase();
    if (lowered.length === 0) {
      return { available: false };
    }
    const existing = await ctx.db
      .query("expenseCategories")
      .withIndex("by_nameLowercased", (q) => q.eq("nameLowercased", lowered))
      .first();
    if (existing === null) {
      return { available: true };
    }
    if (
      args.excludeCategoryId !== undefined &&
      existing._id === args.excludeCategoryId
    ) {
      return { available: true };
    }
    return { available: false };
  },
});

/**
 * Inserts a new active expense category. Case-insensitive uniqueness
 * is enforced; the duplicate path throws `VALIDATION` with the
 * canonical "DUPLICATE_CATEGORY_NAME" intent.
 *
 * Note on error code reuse: the `ErrorCode` enum does NOT carry a
 * dedicated `DUPLICATE_CATEGORY_NAME` value today. We reuse
 * `VALIDATION` and pass the discriminator in `details.kind`. Story 4.7
 * spec calls out a future enum amendment; until then the inline
 * check on the client + the `details.kind` tag give the form enough
 * to surface the right inline message.
 */
export const createExpenseCategory = mutationGeneric({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: { name: string; description?: string },
  ): Promise<{ categoryId: ExpenseCategoryId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const name = args.name.trim();
    if (name.length === 0) {
      throwError(ErrorCode.VALIDATION, "Name is required.", {
        field: "name",
      });
    }
    if (name.length > CATEGORY_NAME_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Name too long (max ${CATEGORY_NAME_MAX_LENGTH} characters).`,
        { field: "name", length: name.length },
      );
    }
    const description = args.description?.trim();
    if (
      description !== undefined &&
      description.length > CATEGORY_DESCRIPTION_MAX_LENGTH
    ) {
      throwError(
        ErrorCode.VALIDATION,
        `Description too long (max ${CATEGORY_DESCRIPTION_MAX_LENGTH} characters).`,
        { field: "description", length: description.length },
      );
    }

    const nameLowercased = name.toLowerCase();
    const duplicate = await ctx.db
      .query("expenseCategories")
      .withIndex("by_nameLowercased", (q) =>
        q.eq("nameLowercased", nameLowercased),
      )
      .first();
    if (duplicate !== null) {
      throwError(
        ErrorCode.VALIDATION,
        "A category with this name already exists.",
        { kind: "DUPLICATE_CATEGORY_NAME", name },
      );
    }

    const now = Date.now();
    const insertRow: {
      name: string;
      nameLowercased: string;
      description?: string;
      isActive: boolean;
      displayOrder: number;
      createdAt: number;
      createdBy: typeof auth.userId;
    } = {
      name,
      nameLowercased,
      isActive: true,
      displayOrder: 0,
      createdAt: now,
      createdBy: auth.userId,
    };
    if (description !== undefined && description.length > 0) {
      insertRow.description = description;
    }
    const categoryId = await ctx.db.insert("expenseCategories", insertRow);

    await emitAudit(ctx, {
      action: "create",
      entityType: "expense",
      entityId: categoryId,
      after: {
        kind: "expenseCategory",
        name,
        description: description ?? null,
        isActive: true,
      },
    });

    return { categoryId };
  },
});

/**
 * Updates a category's name and/or description. Partial-patch shape —
 * supply only the fields you want to change. Renaming is allowed but
 * does NOT retroactively rewrite the `expenses.category` string on
 * past expenses (financial-history immutability).
 */
export const updateExpenseCategory = mutationGeneric({
  args: {
    categoryId: v.id("expenseCategories"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      categoryId: ExpenseCategoryId;
      name?: string;
      description?: string;
    },
  ): Promise<{ categoryId: ExpenseCategoryId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.categoryId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Expense category not found.", {
        categoryId: args.categoryId,
      });
    }

    const patch: {
      name?: string;
      nameLowercased?: string;
      description?: string;
      lastModifiedAt: number;
      lastModifiedBy: typeof auth.userId;
    } = {
      lastModifiedAt: Date.now(),
      lastModifiedBy: auth.userId,
    };

    if (args.name !== undefined) {
      const name = args.name.trim();
      if (name.length === 0) {
        throwError(ErrorCode.VALIDATION, "Name is required.", {
          field: "name",
        });
      }
      if (name.length > CATEGORY_NAME_MAX_LENGTH) {
        throwError(
          ErrorCode.VALIDATION,
          `Name too long (max ${CATEGORY_NAME_MAX_LENGTH} characters).`,
          { field: "name", length: name.length },
        );
      }
      const lowered = name.toLowerCase();
      if (lowered !== existing.nameLowercased) {
        const duplicate = await ctx.db
          .query("expenseCategories")
          .withIndex("by_nameLowercased", (q) =>
            q.eq("nameLowercased", lowered),
          )
          .first();
        if (duplicate !== null && duplicate._id !== args.categoryId) {
          throwError(
            ErrorCode.VALIDATION,
            "A category with this name already exists.",
            { kind: "DUPLICATE_CATEGORY_NAME", name },
          );
        }
      }
      patch.name = name;
      patch.nameLowercased = lowered;
    }

    if (args.description !== undefined) {
      const description = args.description.trim();
      if (description.length > CATEGORY_DESCRIPTION_MAX_LENGTH) {
        throwError(
          ErrorCode.VALIDATION,
          `Description too long (max ${CATEGORY_DESCRIPTION_MAX_LENGTH} characters).`,
          { field: "description", length: description.length },
        );
      }
      patch.description = description;
    }

    await ctx.db.patch(args.categoryId, patch);

    await emitAudit(ctx, {
      action: "update",
      entityType: "expense",
      entityId: args.categoryId,
      before: {
        kind: "expenseCategory",
        name: existing.name,
        description: existing.description ?? null,
      },
      after: {
        kind: "expenseCategory",
        name: patch.name ?? existing.name,
        description:
          patch.description !== undefined
            ? patch.description
            : (existing.description ?? null),
      },
    });

    return { categoryId: args.categoryId };
  },
});

/**
 * Flips `isActive` on a category. Deactivation hides the category
 * from `getActiveCategories` (new expense entries can no longer pick
 * it) but preserves the category name on every historical expense
 * (those store the name as a denormalised string at write time).
 *
 * Reactivation flips the flag back to true.
 */
export const setExpenseCategoryActive = mutationGeneric({
  args: {
    categoryId: v.id("expenseCategories"),
    isActive: v.boolean(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { categoryId: ExpenseCategoryId; isActive: boolean },
  ): Promise<{ categoryId: ExpenseCategoryId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.categoryId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Expense category not found.", {
        categoryId: args.categoryId,
      });
    }

    if (existing.isActive === args.isActive) {
      // No-op — same value. Skip the audit emission rather than
      // record a non-change.
      return { categoryId: args.categoryId };
    }

    const now = Date.now();
    await ctx.db.patch(args.categoryId, {
      isActive: args.isActive,
      lastModifiedAt: now,
      lastModifiedBy: auth.userId,
    });

    await emitAudit(ctx, {
      action: args.isActive ? "reactivate" : "deactivate",
      entityType: "expense",
      entityId: args.categoryId,
      before: {
        kind: "expenseCategory",
        name: existing.name,
        isActive: existing.isActive,
      },
      after: {
        kind: "expenseCategory",
        name: existing.name,
        isActive: args.isActive,
      },
    });

    return { categoryId: args.categoryId };
  },
});

/**
 * Hard-deletes a category. Refuses if any expense references it by
 * name — historical references must remain intact, and deactivation
 * is the correct path for "stop using this".
 */
export const deleteExpenseCategory = mutationGeneric({
  args: {
    categoryId: v.id("expenseCategories"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { categoryId: ExpenseCategoryId },
  ): Promise<{ deleted: true }> => {
    await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.categoryId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Expense category not found.", {
        categoryId: args.categoryId,
      });
    }

    const linkedExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_category", (q) => q.eq("category", existing.name))
      .collect();
    if (linkedExpenses.length > 0) {
      throwError(
        ErrorCode.VALIDATION,
        "Cannot delete — this category is referenced by existing expenses. Deactivate it instead.",
        {
          kind: "CANNOT_DELETE_CATEGORY_WITH_EXPENSES",
          linkedExpenseCount: linkedExpenses.length,
        },
      );
    }

    await ctx.db.delete(args.categoryId);

    await emitAudit(ctx, {
      action: "delete",
      entityType: "expense",
      entityId: args.categoryId,
      before: {
        kind: "expenseCategory",
        name: existing.name,
        description: existing.description ?? null,
        isActive: existing.isActive,
      },
    });

    return { deleted: true };
  },
});
