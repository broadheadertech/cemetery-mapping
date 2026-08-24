/**
 * Error log — the read surface plus the action-side capture entry point.
 *
 * Backs `/admin/errors`. The write logic lives in
 * `convex/lib/errorCapture.ts`; this file is the Convex boundary.
 *
 * Who can see it: `admin` only. Error context can carry contract ids,
 * lot codes, and gateway responses — operationally useful, but not
 * something office staff need, and the narrower the read surface on a
 * table full of failure detail the better.
 *
 * The `internal_captureError` mutation exists because actions have no
 * `ctx.db`. A Node-runtime action that needs to record a failure calls
 * it through `ctx.runMutation`, which is the same transport the rest
 * of `convex/actions/*` uses for its writes.
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
import { ErrorCode, throwError } from "./lib/errors";
import {
  captureError,
  type ErrorSeverity,
  resolveErrorGroup,
} from "./lib/errorCapture";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ErrorLogId = DataModel["errorLog"]["document"]["_id"];

/** Page size for the admin list. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ErrorGroupView {
  id: ErrorLogId;
  source: string;
  severity: ErrorSeverity;
  message: string;
  stack: string | null;
  context: unknown;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
  isResolved: boolean;
  resolvedAt: number | null;
}

export interface ErrorLogSummary {
  unresolvedGroups: number;
  unresolvedOccurrences: number;
  /** Most recent unresolved occurrence, or null when all clear. */
  lastSeenAt: number | null;
}

/**
 * Admin list, newest occurrence first.
 *
 * Defaults to unresolved only — the point of the page is "what is
 * broken now", and a resolved row is one an operator has already
 * decided about. `includeResolved` widens it for review.
 */
export const listErrorGroups = queryGeneric({
  args: {
    includeResolved: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { includeResolved?: boolean; limit?: number },
  ): Promise<ErrorGroupView[]> => {
    await requireRole(ctx, ["admin"]);

    const limit = Math.min(
      Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)),
      MAX_LIMIT,
    );

    const rows =
      args.includeResolved === true
        ? await ctx.db
            .query("errorLog")
            .withIndex("by_lastSeenAt")
            .order("desc")
            .take(limit)
        : await ctx.db
            .query("errorLog")
            .withIndex("by_resolved_lastSeen", (q) =>
              q.eq("isResolved", false),
            )
            .order("desc")
            .take(limit);

    return rows.map((r) => ({
      id: r._id,
      source: r.source,
      severity: r.severity,
      message: r.message,
      stack: r.stack ?? null,
      context: r.context ?? null,
      count: r.count,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
      isResolved: r.isResolved,
      resolvedAt: r.resolvedAt ?? null,
    }));
  },
});

/**
 * Headline counters for the admin index.
 *
 * Bounded scan: reads at most `MAX_LIMIT` unresolved rows. A precise
 * count past that point does not change what an operator does — "200+
 * unresolved" and "203 unresolved" prompt the same response — and an
 * unbounded scan on the one table that fills up when things are going
 * wrong is the wrong thing to build.
 */
export const getErrorLogSummary = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<ErrorLogSummary> => {
    await requireRole(ctx, ["admin"]);
    const rows = await ctx.db
      .query("errorLog")
      .withIndex("by_resolved_lastSeen", (q) => q.eq("isResolved", false))
      .order("desc")
      .take(MAX_LIMIT);
    return {
      unresolvedGroups: rows.length,
      unresolvedOccurrences: rows.reduce((sum, r) => sum + r.count, 0),
      lastSeenAt: rows[0]?.lastSeenAt ?? null,
    };
  },
});

/**
 * Mark a group handled. A later occurrence reopens it — see
 * `captureError`. That is intentional: "I fixed it" and "it came back"
 * are different facts and the operator needs to see the second one.
 */
export const resolveError = mutationGeneric({
  args: { errorLogId: v.id("errorLog") },
  handler: async (
    ctx: MutationCtx,
    args: { errorLogId: ErrorLogId },
  ): Promise<{ resolved: boolean }> => {
    const auth = await requireRole(ctx, ["admin"]);
    const ok = await resolveErrorGroup(ctx, args.errorLogId, auth.userId);
    if (!ok) {
      throwError(ErrorCode.NOT_FOUND, "That error entry no longer exists.");
    }
    return { resolved: true };
  },
});

/**
 * Action-side capture. Internal — no user context, no role check
 * (internal functions are server-to-server; see the
 * `require-role-first-line` rule's scope note).
 */
export const internal_captureError = internalMutationGeneric({
  args: {
    source: v.string(),
    message: v.string(),
    severity: v.optional(
      v.union(v.literal("error"), v.literal("warning")),
    ),
    context: v.optional(v.any()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      source: string;
      message: string;
      severity?: ErrorSeverity;
      context?: Record<string, unknown>;
    },
  ): Promise<null> => {
    const params: Parameters<typeof captureError>[1] = {
      source: args.source,
      error: args.message,
    };
    if (args.severity !== undefined) params.severity = args.severity;
    if (args.context !== undefined) params.context = args.context;
    await captureError(ctx, params);
    return null;
  },
});
