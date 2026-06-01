/**
 * Expense category vocabulary — source-of-truth helpers.
 *
 * Story 4.6 (`recordExpense`) calls `getActiveCategories(ctx)` /
 * `assertValidCategory(ctx, name)` to gate every new expense against
 * the active category set. The helpers are async on purpose — Story
 * 4.6 shipped them returning a hardcoded constant; Story 4.7 SWAPS the
 * body to read from the admin-managed `expenseCategories` table
 * without changing any caller (`convex/expenses.ts` is unchanged).
 *
 * Bootstrap path: if the table is empty (fresh deploy that hasn't run
 * the seed yet), the helpers fall back to the hardcoded default list
 * (`_DEFAULT_EXPENSE_CATEGORIES`) so a freshly-deployed environment
 * doesn't lock the office staff out of recording any expense. Once
 * the admin (or the seed mutation) inserts the first category, the
 * table becomes the runtime source and the fallback is dormant.
 *
 * Banner sentinel: `IS_PLACEHOLDER` was the 4.6-era flag that drove
 * the "Expense categories pending client confirmation — §10 Q8"
 * banner. Story 4.7 flips it to `false` permanently — the admin now
 * owns the taxonomy through `/admin/expense-categories`, so there is
 * no "pending §10 Q8" state any more. The flag remains exported so
 * `convex/expenses.ts:getActiveCategoriesForForm` (Story 4.6) keeps
 * compiling with no signature changes.
 *
 * Why the helpers live in `convex/lib/`:
 *   - Files in `convex/lib/**` are exempt from the
 *     `local-rules/require-role-first-line` rule (helpers, not public
 *     functions).
 *   - Pre-4.7, the helpers needed `ctx` only as a future hook; post-
 *     4.7 they actively read `ctx.db.query("expenseCategories")`.
 *
 * Disaster prevention (from the Story 4.7 spec):
 *   - DO NOT remove `_DEFAULT_EXPENSE_CATEGORIES`. The seed path
 *     (or any future re-seed) re-uses it.
 *   - DO NOT change `IS_PLACEHOLDER` back to `true`. The 4.6 banner
 *     is gone for good once the admin owns the table.
 *   - DO NOT make uniqueness case-sensitive. The `expenseCategories`
 *     table stores `nameLowercased` precisely so we can look up
 *     by `name.trim().toLowerCase()` and reject duplicates.
 */

import type { ReadableCtx } from "./auth";
import { ErrorCode, throwError } from "./errors";

/**
 * Hardcoded Phase 1 vocabulary. Pre-4.7 this was the RUNTIME source
 * of categories; post-4.7 it is the BOOTSTRAP seed used (a) by the
 * `seedDefaultExpenseCategories` internal mutation and (b) as the
 * fallback returned by `getActiveCategories` when the table is empty.
 *
 * Underscore prefix per Story 4.7 § Disaster prevention — marks the
 * constant as internal-only (callers should rely on the table; this
 * is the bootstrap seed).
 */
export const _DEFAULT_EXPENSE_CATEGORIES = [
  "Utilities",
  "Maintenance",
  "Supplies",
  "Salaries",
  "Other",
] as const;

/**
 * Backwards-compatible alias preserved so any pre-4.7 consumer that
 * imported the un-prefixed name keeps compiling. Prefer
 * `_DEFAULT_EXPENSE_CATEGORIES` in new code.
 */
export const DEFAULT_EXPENSE_CATEGORIES = _DEFAULT_EXPENSE_CATEGORIES;

export type ExpenseCategoryName = (typeof _DEFAULT_EXPENSE_CATEGORIES)[number];

/**
 * Post-4.7 the banner is permanently retired — the admin manages the
 * taxonomy through `/admin/expense-categories`. The flag remains
 * exported so Story 4.6's `getActiveCategoriesForForm` keeps a stable
 * signature (`isPlaceholder: boolean`) across the swap.
 */
export const IS_PLACEHOLDER = false;

/**
 * Returns the list of currently-active expense category names.
 *
 * Post-Story-4.7 contract:
 *   1. Query `expenseCategories` via the `by_active_name` index for
 *      `isActive: true`. Returns category names sorted by `name` asc.
 *   2. If the table is empty (fresh deploy / seed not yet run), fall
 *      back to `_DEFAULT_EXPENSE_CATEGORIES` so the office staff can
 *      still record expenses before the admin populates the list.
 */
export async function getActiveCategories(
  ctx: ReadableCtx,
): Promise<readonly string[]> {
  const rows = await ctx.db
    .query("expenseCategories")
    .withIndex("by_active_name", (q) => q.eq("isActive", true))
    .collect();
  if (rows.length === 0) {
    // Bootstrap path — table is empty (seed not yet run); fall back
    // to the hardcoded defaults so `recordExpense` still has a valid
    // set to validate against.
    return _DEFAULT_EXPENSE_CATEGORIES;
  }
  const names = rows.map((r) => r.name);
  // `localeCompare` keeps "Utilities" / "utilities" ordering intuitive
  // for human readers; matches the customer / lot sorting conventions
  // elsewhere in the codebase.
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * Throws `VALIDATION` when `category` is not in the active set;
 * otherwise RETURNS the CANONICAL category name (the stored row's
 * `name`, or the matched default's canonical casing).
 *
 * Looks up by `nameLowercased` (case-insensitive, trimmed) so a
 * client sending "utilities" matches a stored "Utilities" row. When
 * the table is empty, falls back to the hardcoded defaults (same
 * bootstrap path as `getActiveCategories`).
 *
 * Epic 4 H2 — callers (notably `recordExpense`) MUST persist the
 * returned canonical name, NOT the raw client string. The
 * `deleteExpenseCategory` in-use guard and the admin linked-count both
 * query `expenses.by_category` with the canonical `expenseCategories.name`
 * (case-sensitive equality). Storing the raw "utilities" against a
 * canonical "Utilities" row let the guard miss the linkage and
 * hard-delete a referenced category. Returning + persisting the canonical
 * name closes that gap.
 */
export async function assertValidCategory(
  ctx: ReadableCtx,
  category: string,
): Promise<string> {
  const trimmed = category.trim();
  const lowered = trimmed.toLowerCase();
  // Try the table first via the case-insensitive index.
  const row = await ctx.db
    .query("expenseCategories")
    .withIndex("by_nameLowercased", (q) => q.eq("nameLowercased", lowered))
    .first();
  if (row !== null) {
    if (row.isActive) {
      return row.name;
    }
    // Inactive row found — reject explicitly so the error message can
    // distinguish "unknown category" from "deactivated category".
    throwError(
      ErrorCode.VALIDATION,
      "Category is deactivated and cannot be used for new expenses.",
      { category: trimmed },
    );
  }
  // Bootstrap path — table empty (or this name simply isn't there).
  // Check whether ANY row exists; if not, allow the hardcoded
  // defaults as a fallback.
  const anyRow = await ctx.db.query("expenseCategories").first();
  if (anyRow === null) {
    const matchedDefault = (
      _DEFAULT_EXPENSE_CATEGORIES as readonly string[]
    ).find((d) => d.toLowerCase() === lowered);
    if (matchedDefault !== undefined) {
      return matchedDefault;
    }
  }
  const active = await getActiveCategories(ctx);
  throwError(
    ErrorCode.VALIDATION,
    "Category is not in the active list.",
    { category: trimmed, active: [...active] },
  );
}
