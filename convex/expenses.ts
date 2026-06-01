/**
 * Operating expenses (Story 4.6, FR39).
 *
 * Non-financial-cornerstone Phase 1 capability. Expenses do NOT route
 * through `postFinancialEvent` because they're not contract / payment /
 * receipt events. They're a simpler "single insert + audit emit" write
 * path that still respects every cornerstone: RBAC first line, audit
 * emission, idempotency, server-set timestamp, photo two-step upload.
 *
 * Reactive consumers:
 *   - `/expenses` list page subscribes to `listRecentExpenses`.
 *   - Story 5.2 dashboard's "Expenses MTD" + "Net MTD" tiles subscribe
 *     to `getExpensesMtdTotal`. The 600ms amber fade in those tiles is
 *     wired by Story 5.2's `KpiCard` + `ReactiveHighlight`.
 *
 * Schema invariants enforced server-side (Story 4.6 § Dev Notes):
 *   1. `requireRole(ctx, ["admin", "office_staff"])` as the first
 *      awaited statement of every public handler (NFR-S4, lint-
 *      enforced).
 *   2. `vendor` is trimmed and must satisfy `1 ≤ length ≤ 200`.
 *   3. `amountCents` is a positive integer (≥ 1 centavo).
 *   4. `category` is in `getActiveCategories(ctx)` (Phase 1 hardcoded;
 *      Story 4.7 swaps to the `expenseCategories` table).
 *   5. `paidAt` within the role's backdating window: admin 30 days back,
 *      office_staff 7 days back. Future dates are always rejected.
 *   6. `recordedAt = Date.now()` is set server-side. Clients cannot
 *      override (a phone with a wrong clock would corrupt the
 *      timeline).
 *   7. `emitAudit` is called after every successful insert (Story 1.6
 *      cornerstone) with `entityType: "expense"`.
 *   8. Photos use Convex File Storage's two-step upload pattern via
 *      `generateExpensePhotoUploadUrl`; the mutation only stores the
 *      resulting `Id<"_storage">`. URLs are auth-gated through
 *      `getExpensePhotoUrl` (NFR-S3).
 *   9. Idempotency: clients pass a UUID stable across re-renders of
 *      the form mount; a second submit with the same key returns the
 *      original expense id (`by_idempotency_key` index lookup) without
 *      a duplicate insert or a duplicate audit row.
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
import {
  assertValidCategory,
  getActiveCategories,
  IS_PLACEHOLDER,
} from "./lib/expenseCategories";
import { DAY_MS } from "./lib/time";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ExpenseDoc = DataModel["expenses"]["document"];
type ExpenseId = ExpenseDoc["_id"];
type StorageId = NonNullable<ExpenseDoc["photoStorageId"]>;
type Role = "admin" | "office_staff";

/** Maximum vendor length, in characters. Mirrors the form schema. */
export const VENDOR_MAX_LENGTH = 200;

/** Backdating window for office_staff (7 days back) and admin (30 days back). */
export const OFFICE_STAFF_BACKDATE_DAYS = 7;
export const ADMIN_BACKDATE_DAYS = 30;

/** Default page size + ceiling for `listRecentExpenses`. */
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;

/**
 * Generates a short-lived upload URL for an expense photo.
 *
 * Mirrors the Story 1.14 condition-log pattern. Implemented as a
 * MUTATION (not an action) because `ctx.storage.generateUploadUrl()`
 * is available on `MutationCtx` and the call site doesn't need the
 * extra ActionCtx ceremony.
 *
 * The client uses this URL with a `POST` whose body is the file blob;
 * the response is `{ storageId: Id<"_storage"> }` which the client
 * then passes back to `recordExpense`.
 */
export const generateExpensePhotoUploadUrl = mutationGeneric({
  args: {},
  handler: async (ctx: MutationCtx): Promise<string> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Inserts a new expense row. RBAC, idempotency, validation, audit
 * emission all live here. Returns the expense id (existing one on
 * idempotent retry, new one otherwise).
 */
export const recordExpense = mutationGeneric({
  args: {
    paidAt: v.number(),
    amountCents: v.number(),
    vendor: v.string(),
    category: v.string(),
    photoStorageId: v.optional(v.id("_storage")),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      paidAt: number;
      amountCents: number;
      vendor: string;
      category: string;
      photoStorageId?: StorageId;
      idempotencyKey?: string;
    },
  ): Promise<{ expenseId: ExpenseId }> => {
    const auth = await requireRole(ctx, ["admin", "office_staff"]);

    // Idempotency check FIRST — a retried submit (network blip, double-
    // tap) must return the original id without a second insert. We
    // narrow by `recordedBy` so two operators colliding on the same UUID
    // (vanishingly unlikely) don't share state.
    if (args.idempotencyKey !== undefined && args.idempotencyKey.length > 0) {
      const existing = await ctx.db
        .query("expenses")
        .withIndex("by_idempotency_key", (q) =>
          q.eq("idempotencyKey", args.idempotencyKey),
        )
        .collect();
      const dup = existing.find((r) => r.recordedBy === auth.userId);
      if (dup !== undefined) {
        return { expenseId: dup._id };
      }
    }

    // Validations — fail loudly with discriminated codes.
    if (
      !Number.isFinite(args.amountCents) ||
      !Number.isInteger(args.amountCents) ||
      args.amountCents <= 0
    ) {
      throwError(
        ErrorCode.VALIDATION,
        "Amount must be a positive whole number of centavos.",
        { amountCents: args.amountCents },
      );
    }

    const vendorTrimmed = args.vendor.trim();
    if (vendorTrimmed.length === 0) {
      throwError(ErrorCode.VALIDATION, "Vendor is required.");
    }
    if (vendorTrimmed.length > VENDOR_MAX_LENGTH) {
      throwError(
        ErrorCode.VALIDATION,
        `Vendor name is too long (max ${VENDOR_MAX_LENGTH} characters).`,
        { vendorLength: vendorTrimmed.length },
      );
    }

    // Epic 4 H2 — persist the CANONICAL category name (the stored row's
    // casing), not the raw client string. The delete-in-use guard and
    // admin linked-count query `expenses.by_category` with the canonical
    // name via case-sensitive equality; storing "utilities" against a
    // "Utilities" row would let a referenced category be hard-deleted.
    const canonicalCategory = await assertValidCategory(ctx, args.category);

    // Backdating window enforcement. Admins get 30 days, office_staff 7;
    // future dates are always rejected. Multi-role users get the MOST
    // PERMISSIVE window (the inverse of session-timeout policy — for
    // operational ergonomics, the user can record on behalf of either
    // role they hold).
    const now = Date.now();
    const isAdmin = auth.roles.includes("admin" as Role);
    const maxBackDays = isAdmin
      ? ADMIN_BACKDATE_DAYS
      : OFFICE_STAFF_BACKDATE_DAYS;
    const minAllowed = now - maxBackDays * DAY_MS;
    if (args.paidAt > now) {
      throwError(
        ErrorCode.VALIDATION,
        "paidAt cannot be in the future.",
        { paidAt: args.paidAt, now },
      );
    }
    if (args.paidAt < minAllowed) {
      throwError(
        ErrorCode.VALIDATION,
        `paidAt is older than the allowed ${maxBackDays}-day backdating window.`,
        { paidAt: args.paidAt, minAllowed, maxBackDays },
      );
    }

    // Story 6.6 — consult the per-category approval thresholds. The
    // settings live in `expenseApprovalSettings`; admins manage them
    // via `convex/expenseApprovalSettings.ts`. The lookup is cheap
    // (one indexed read on the category, plus one on the default
    // sentinel as a fallback). When no settings have been configured
    // the implicit default is `requiresApproval: false` — Phase 1
    // behaviour is preserved.
    const approval = await resolveApprovalForCategory(
      ctx,
      canonicalCategory,
      args.amountCents,
    );

    const insertRow: {
      paidAt: number;
      amountCents: number;
      vendor: string;
      category: string;
      photoStorageId?: StorageId;
      recordedBy: typeof auth.userId;
      recordedAt: number;
      idempotencyKey?: string;
      approvalStatus: "approved" | "pending_approval";
      approvalThresholdCents: number;
      approvedBy?: typeof auth.userId;
      approvedAt?: number;
    } = {
      paidAt: args.paidAt,
      amountCents: args.amountCents,
      vendor: vendorTrimmed,
      category: canonicalCategory,
      recordedBy: auth.userId,
      recordedAt: now,
      approvalStatus: approval.requiresApproval ? "pending_approval" : "approved",
      approvalThresholdCents: approval.thresholdCents,
    };
    if (!approval.requiresApproval) {
      // Auto-approved on insert: stamp the recorder as the "approver"
      // (the operator who saw the cash leave and recorded it). When
      // the workflow IS active we leave `approvedBy` / `approvedAt`
      // empty until an admin actions the row through
      // `approveExpense`.
      insertRow.approvedBy = auth.userId;
      insertRow.approvedAt = now;
    }
    if (args.photoStorageId !== undefined) {
      insertRow.photoStorageId = args.photoStorageId;
    }
    if (args.idempotencyKey !== undefined && args.idempotencyKey.length > 0) {
      insertRow.idempotencyKey = args.idempotencyKey;
    }
    const expenseId = await ctx.db.insert("expenses", insertRow);

    // Audit captures the operational summary, not the photo blob. The
    // photo lives in storage; the audit records the boolean
    // `hasPhoto` so an admin can tell whether one was attached without
    // loading the row.
    await emitAudit(ctx, {
      action: "create",
      entityType: "expense",
      entityId: expenseId,
      after: {
        paidAt: args.paidAt,
        amountCents: args.amountCents,
        vendor: vendorTrimmed,
        category: args.category.trim(),
        hasPhoto: args.photoStorageId !== undefined,
        approvalStatus: insertRow.approvalStatus,
        approvalThresholdCents: approval.thresholdCents,
      },
    });

    return { expenseId };
  },
});

/**
 * Listed expense row — extends the raw doc with `recordedByName`
 * (best-effort: name → email → null) so the list view can render the
 * actor without N extra `db.get` calls in React.
 */
export interface ListedExpense extends ExpenseDoc {
  recordedByName: string | null;
}

/**
 * Lists the N most-recent expenses by `paidAt` descending. Reactive by
 * default — the `/expenses` list page subscribes via `useQuery` and
 * receives new rows live.
 *
 * Each row is augmented with `recordedByName` for display.
 */
export const listRecentExpenses = queryGeneric({
  args: {
    limit: v.optional(v.number()),
    /**
     * HIGH-D (Epic 5 review): optional inclusive `paidAt` range bounds
     * for the dashboard drill-down filter. When supplied we walk
     * `by_paidAt` with the range applied at the index level so the
     * scan is bounded to the period — the prior pattern of loading
     * 100 rows then filtering on the client missed any expense whose
     * `paidAt` predated the visible window (Story 5.3 AC5).
     */
    fromMs: v.optional(v.number()),
    toMs: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number; fromMs?: number; toMs?: number },
  ): Promise<ListedExpense[]> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const requested = args.limit ?? LIST_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, requested));
    // Convex's IndexRangeBuilder is progressively narrowed — a
    // `.gte(...)` call returns an upper-bound-only builder. We branch
    // on the three legal combinations to keep the narrowed types
    // composable without a `let`-reassignment pattern.
    const fromMs = args.fromMs;
    const toMs = args.toMs;
    const hasRange = fromMs !== undefined || toMs !== undefined;
    const rows = hasRange
      ? await ctx.db
          .query("expenses")
          .withIndex("by_paidAt", (q) => {
            if (fromMs !== undefined && toMs !== undefined) {
              return q.gte("paidAt", fromMs).lte("paidAt", toMs);
            }
            if (fromMs !== undefined) {
              return q.gte("paidAt", fromMs);
            }
            if (toMs !== undefined) {
              return q.lte("paidAt", toMs);
            }
            return q;
          })
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("expenses")
          .withIndex("by_paidAt")
          .order("desc")
          .take(limit);
    const out: ListedExpense[] = [];
    for (const row of rows) {
      const user = await ctx.db.get(row.recordedBy);
      const userName =
        user !== null && typeof user === "object" && "name" in user
          ? ((user as { name?: string }).name ?? null)
          : null;
      const userEmail =
        user !== null && typeof user === "object" && "email" in user
          ? ((user as { email?: string }).email ?? null)
          : null;
      out.push({
        ...row,
        recordedByName: userName ?? userEmail ?? null,
      });
    }
    return out;
  },
});

/**
 * Returns an auth-gated, short-lived URL for fetching an expense
 * photo. NFR-S3: file URLs are NEVER public. The caller's role is
 * checked on every read.
 */
export const getExpensePhotoUrl = queryGeneric({
  args: { expenseId: v.id("expenses") },
  handler: async (
    ctx: QueryCtx,
    args: { expenseId: ExpenseId },
  ): Promise<string | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const expense = await ctx.db.get(args.expenseId);
    if (expense === null) {
      return null;
    }
    if (expense.photoStorageId === undefined) {
      return null;
    }
    return await ctx.storage.getUrl(expense.photoStorageId);
  },
});

/**
 * Lookup a single expense by id. Returns null when missing so the UI
 * can render a "not found" without surfacing an error code.
 */
export const getExpense = queryGeneric({
  args: { expenseId: v.id("expenses") },
  handler: async (
    ctx: QueryCtx,
    args: { expenseId: ExpenseId },
  ): Promise<ExpenseDoc | null> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const row = await ctx.db.get(args.expenseId);
    return row;
  },
});

/**
 * Returns the placeholder-vs-managed sentinel + the active category
 * list for the form. Phase 1: hardcoded list, banner shown. Story
 * 4.7 will swap the implementation; the public shape stays the same.
 *
 * Implemented as a query (rather than importing the constant directly
 * into the client) so the form has a single source of truth that
 * survives the Story 4.7 swap with no UI changes.
 */
export const getActiveCategoriesForForm = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{ categories: readonly string[]; isPlaceholder: boolean }> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const categories = await getActiveCategories(ctx);
    return { categories, isPlaceholder: IS_PLACEHOLDER };
  },
});

/**
 * Computes the MTD (month-to-date) total cents + count of expenses for
 * the given Manila-month string (e.g. `"2026-05"`). When `month` is
 * omitted, defaults to the current Manila month.
 *
 * Admin-only — Story 5.2's dashboard tiles subscribe to this. The
 * office_staff role doesn't need the aggregate (they see the row-level
 * list at `/expenses`).
 *
 * Phase 1.5 optimization note: at small expense volume (~5/day), live
 * aggregation by index scan is fine. If volume grows to 100s/day, a
 * pre-aggregated `expenseSummaries` doc updated on write becomes the
 * better pattern (documented in Story 5.2's spec).
 */
export const getExpensesMtdTotal = queryGeneric({
  args: {
    month: v.optional(v.string()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { month?: string },
  ): Promise<{ totalCents: number; count: number; month: string }> => {
    await requireRole(ctx, ["admin"]);
    const month = args.month ?? currentManilaMonthString();
    const { startMs, endMs } = monthBoundsMs(month);
    const rows = await ctx.db
      .query("expenses")
      .withIndex("by_paidAt", (q) =>
        q.gte("paidAt", startMs).lte("paidAt", endMs - 1),
      )
      .collect();
    let totalCents = 0;
    for (const row of rows) {
      totalCents += row.amountCents;
    }
    return { totalCents, count: rows.length, month };
  },
});

// ---------------------------------------------------------------------------
// Story 6.6 — admin approval workflow.
// ---------------------------------------------------------------------------

/**
 * Sentinel category that stores the catch-all approval setting. Kept
 * in lockstep with `convex/expenseApprovalSettings.ts`; duplicated as
 * a local const so this file does not import from there (the call
 * direction is one-way: settings → expenses via DB only, no shared
 * module dependency).
 */
const DEFAULT_APPROVAL_CATEGORY_SENTINEL = "__default__";

interface ApprovalDecision {
  requiresApproval: boolean;
  thresholdCents: number;
}

/**
 * Reads the approval setting for the given category + amount. Falls
 * back to the `__default__` sentinel row when no per-category row
 * exists, and finally to the implicit `requiresApproval: false`
 * default when neither row exists (Phase 1 preserved).
 *
 * Pure read; safe from both queries and mutations.
 */
async function resolveApprovalForCategory(
  ctx: QueryCtx | MutationCtx,
  category: string,
  amountCents: number,
): Promise<ApprovalDecision> {
  const categoryRow = await ctx.db
    .query("expenseApprovalSettings")
    .withIndex("by_category", (q) => q.eq("category", category))
    .first();
  const effective =
    categoryRow !== null
      ? {
          thresholdCents: categoryRow.thresholdCents,
          requiresApproval: categoryRow.requiresApproval,
        }
      : await (async () => {
          const def = await ctx.db
            .query("expenseApprovalSettings")
            .withIndex("by_category", (q) =>
              q.eq("category", DEFAULT_APPROVAL_CATEGORY_SENTINEL),
            )
            .first();
          if (def !== null) {
            return {
              thresholdCents: def.thresholdCents,
              requiresApproval: def.requiresApproval,
            };
          }
          return { thresholdCents: 0, requiresApproval: false };
        })();

  if (!effective.requiresApproval) {
    return { requiresApproval: false, thresholdCents: effective.thresholdCents };
  }
  // `requiresApproval === true` AND `amountCents >= thresholdCents` →
  // route to the approval queue. `thresholdCents === 0` means EVERY
  // expense in the category needs approval.
  const needs = amountCents >= effective.thresholdCents;
  return {
    requiresApproval: needs,
    thresholdCents: effective.thresholdCents,
  };
}

/**
 * Office-staff explicit submit for approval. The recording form
 * normally auto-routes via `recordExpense` (category + amount drive
 * the decision), but a future UX may add an explicit "submit for
 * approval" affordance — this mutation supports that flow against an
 * already-recorded expense. Today it flips an approved row back to
 * pending; admin-only because this is an unusual operation.
 */
export const submitExpenseForApproval = mutationGeneric({
  args: {
    expenseId: v.id("expenses"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { expenseId: ExpenseId },
  ): Promise<{ expenseId: ExpenseId }> => {
    await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.expenseId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Expense not found.", {
        expenseId: args.expenseId,
      });
    }

    const currentStatus = existing.approvalStatus ?? "approved";
    if (currentStatus === "pending_approval") {
      // No-op idempotency: already pending.
      return { expenseId: args.expenseId };
    }
    if (currentStatus === "rejected") {
      throwError(
        ErrorCode.VALIDATION,
        "Cannot submit a rejected expense for approval.",
        { kind: "ALREADY_REJECTED" },
      );
    }

    await ctx.db.patch(args.expenseId, {
      approvalStatus: "pending_approval",
      approvedBy: undefined,
      approvedAt: undefined,
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "expense",
      entityId: args.expenseId,
      before: { approvalStatus: currentStatus },
      after: { approvalStatus: "pending_approval" },
    });

    return { expenseId: args.expenseId };
  },
});

/**
 * Admin-only — approves a pending expense. Sets `approvalStatus`
 * to `"approved"`, stamps `approvedBy` / `approvedAt`, and emits
 * audit. Idempotent on an already-approved row (no audit re-emit).
 */
export const approveExpense = mutationGeneric({
  args: {
    expenseId: v.id("expenses"),
  },
  handler: async (
    ctx: MutationCtx,
    args: { expenseId: ExpenseId },
  ): Promise<{ expenseId: ExpenseId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.expenseId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Expense not found.", {
        expenseId: args.expenseId,
      });
    }

    const currentStatus = existing.approvalStatus ?? "approved";
    if (currentStatus === "approved") {
      return { expenseId: args.expenseId };
    }
    if (currentStatus === "rejected") {
      throwError(
        ErrorCode.VALIDATION,
        "Cannot approve a rejected expense.",
        { kind: "ALREADY_REJECTED" },
      );
    }

    const now = Date.now();
    await ctx.db.patch(args.expenseId, {
      approvalStatus: "approved",
      approvedBy: auth.userId,
      approvedAt: now,
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "expense",
      entityId: args.expenseId,
      before: {
        approvalStatus: currentStatus,
        approvedBy: existing.approvedBy ?? null,
        approvedAt: existing.approvedAt ?? null,
      },
      after: {
        approvalStatus: "approved",
        approvedBy: auth.userId,
        approvedAt: now,
      },
    });

    return { expenseId: args.expenseId };
  },
});

/**
 * Admin-only — rejects a pending expense with a required free-text
 * reason (1–500 chars). Sets `approvalStatus` to `"rejected"` and
 * stores the reason. Idempotent on an already-rejected row (the
 * reason is NOT overwritten; the first rejection's reason stands as
 * the audit-of-record).
 */
export const rejectExpense = mutationGeneric({
  args: {
    expenseId: v.id("expenses"),
    reason: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { expenseId: ExpenseId; reason: string },
  ): Promise<{ expenseId: ExpenseId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.expenseId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Expense not found.", {
        expenseId: args.expenseId,
      });
    }

    const reasonTrimmed = args.reason.trim();
    if (reasonTrimmed.length === 0) {
      throwError(ErrorCode.VALIDATION, "Rejection reason is required.", {
        field: "reason",
      });
    }
    if (reasonTrimmed.length > 500) {
      throwError(
        ErrorCode.VALIDATION,
        "Rejection reason is too long (max 500 characters).",
        { field: "reason", length: reasonTrimmed.length },
      );
    }

    const currentStatus = existing.approvalStatus ?? "approved";
    if (currentStatus === "rejected") {
      return { expenseId: args.expenseId };
    }
    if (currentStatus === "approved") {
      throwError(
        ErrorCode.VALIDATION,
        "Cannot reject an already-approved expense.",
        { kind: "ALREADY_APPROVED" },
      );
    }

    const now = Date.now();
    await ctx.db.patch(args.expenseId, {
      approvalStatus: "rejected",
      approvedBy: auth.userId,
      approvedAt: now,
      rejectionReason: reasonTrimmed,
    });

    await emitAudit(ctx, {
      action: "update",
      entityType: "expense",
      entityId: args.expenseId,
      before: { approvalStatus: currentStatus },
      after: {
        approvalStatus: "rejected",
        rejectionReason: reasonTrimmed,
        approvedBy: auth.userId,
        approvedAt: now,
      },
    });

    return { expenseId: args.expenseId };
  },
});

/**
 * Admin-only listing of pending approvals. Returned in
 * `paidAt`-descending order so the queue surfaces the freshest
 * recordings first; the UI may re-sort client-side.
 */
export const listPendingApprovals = queryGeneric({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number },
  ): Promise<ListedExpense[]> => {
    await requireRole(ctx, ["admin"]);
    const requested = args.limit ?? LIST_DEFAULT_LIMIT;
    const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, requested));
    const rows = await ctx.db
      .query("expenses")
      .withIndex("by_approvalStatus_paidAt", (q) =>
        q.eq("approvalStatus", "pending_approval"),
      )
      .order("desc")
      .take(limit);
    const out: ListedExpense[] = [];
    for (const row of rows) {
      const user = await ctx.db.get(row.recordedBy);
      const userName =
        user !== null && typeof user === "object" && "name" in user
          ? ((user as { name?: string }).name ?? null)
          : null;
      const userEmail =
        user !== null && typeof user === "object" && "email" in user
          ? ((user as { email?: string }).email ?? null)
          : null;
      out.push({
        ...row,
        recordedByName: userName ?? userEmail ?? null,
      });
    }
    return out;
  },
});

/**
 * Returns the Manila-month string for "now" — e.g. "2026-05". Stable
 * helper so the MTD aggregator and the UI's month picker can share the
 * same source.
 */
function currentManilaMonthString(): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const monthPart = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${monthPart}`;
}

/**
 * Returns the half-open `[startMs, endMs)` interval for the given
 * `YYYY-MM` Manila-month string. The end-of-month boundary uses the
 * first instant of the NEXT month so the half-open interval is exact
 * regardless of the month length.
 *
 * Throws `VALIDATION` for an unparseable month string.
 */
function monthBoundsMs(month: string): { startMs: number; endMs: number } {
  const match = month.match(/^(\d{4})-(\d{2})$/);
  if (match === null) {
    throwError(ErrorCode.VALIDATION, "month must be YYYY-MM.", { month });
  }
  const year = Number.parseInt(match[1]!, 10);
  const m = Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(year) || m < 1 || m > 12) {
    throwError(ErrorCode.VALIDATION, "month is out of range.", { month });
  }
  // `+08:00` keeps the boundary anchored to Manila tz; PH has no DST so
  // a fixed offset is safe per `convex/lib/time.ts` policy.
  const startIso = `${match[1]}-${match[2]}-01T00:00:00+08:00`;
  const startMs = new Date(startIso).getTime();
  // Next month: month+1 if <12, else year+1 / month=01.
  let nextYear = year;
  let nextMonth = m + 1;
  if (nextMonth === 13) {
    nextYear = year + 1;
    nextMonth = 1;
  }
  const nextIso = `${nextYear.toString().padStart(4, "0")}-${nextMonth
    .toString()
    .padStart(2, "0")}-01T00:00:00+08:00`;
  const endMs = new Date(nextIso).getTime();
  return { startMs, endMs };
}
