/**
 * Audit log read surface — Story 6.5 (FR47, NFR-S7).
 *
 * Admin-only queries for browsing the append-only `auditLog`. This file
 * is the READ surface for the audit log; the WRITE surface lives in
 * `convex/lib/audit.ts` (the `emitAudit` helper). Per architecture, the
 * two are deliberately distinct so the read path never accidentally
 * inserts.
 *
 * PII safety:
 *   The `before` / `after` blobs on every row were already redacted at
 *   WRITE time by `redactPii` inside `emitAudit` (Story 1.6). This file
 *   trusts that contract — it does NOT re-redact, and it does NOT
 *   expose a "reveal full PII" path. Redaction-at-write means the
 *   at-rest data is already safe for any admin read; future stories
 *   that want a click-to-reveal flow will go through `readPii` so the
 *   reveal is itself audited (NFR-C4).
 *
 * Append-only enforcement:
 *   This file never writes to `auditLog`. The
 *   `local-rules/no-audit-log-mutation` ESLint rule (Story 1.6) would
 *   block `patch` / `replace` / `delete` against the table if anyone
 *   tried; `local-rules/no-audit-log-direct-write` would block direct
 *   `insert`. The lint is defense in depth — this module is queries
 *   only.
 *
 * Index-selection heuristic:
 *   - `listByEntity` (entityType + entityId filter) → `by_entity` index
 *     [entityType, entityId, timestamp] — the narrowest index for
 *     "show me the history of this lot / customer / contract".
 *   - `listByActor` (actor filter) → `by_actor` index
 *     [actor, timestamp] — "what did user X do".
 *   - `listRecent` (no entity / actor filter) → `by_timestamp` index
 *     [timestamp] — global activity feed.
 *
 * Every handler's first awaited statement is `requireRole(ctx, ["admin"])`
 * per the `local-rules/require-role-first-line` rule (Story 1.2).
 */

import {
  type DataModelFromSchemaDefinition,
  paginationOptsValidator,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type QueryCtx } from "./lib/auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type AuditLogDoc = DataModel["auditLog"]["document"];

/**
 * Shape returned per row to the UI. We project the actor's display name
 * once on the server so the React table doesn't have to N+1-fetch the
 * user document for every row. The raw user id is preserved alongside
 * the name for click-to-filter UX.
 */
export interface AuditLogRow {
  _id: AuditLogDoc["_id"];
  _creationTime: number;
  actor: AuditLogDoc["actor"];
  actorName: string | null;
  timestamp: number;
  action: string;
  entityType: AuditLogDoc["entityType"];
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/**
 * Convex pagination envelope. We restate the shape here because the
 * generated `PaginationResult` type lives in `convex/_generated/` which
 * isn't built in this repo (every module routes around that gap via
 * schema-driven types).
 */
export interface AuditLogPage {
  page: AuditLogRow[];
  isDone: boolean;
  continueCursor: string;
}

/** Entity-type literal union used by both the schema and the filter UI. */
const entityTypeValidator = v.union(
  v.literal("lot"),
  v.literal("customer"),
  v.literal("contract"),
  v.literal("payment"),
  v.literal("receipt"),
  v.literal("user"),
  v.literal("expense"),
  v.literal("ownership"),
  v.literal("piiAccess"),
);

/**
 * Cap on the per-page row count. Convex's pagination is cursor-based;
 * the limit is supplied via `paginationOpts.numItems` and we accept any
 * caller-supplied value but clamp to `MAX_PAGE_SIZE` server-side so a
 * malicious / buggy caller can't request the entire table in one page.
 *
 * 100 is comfortably above the UX target (50 rows / page) and well below
 * Convex's per-query response budget.
 */
const MAX_PAGE_SIZE = 100;

function clampPaginationOpts(opts: {
  numItems: number;
  cursor: string | null;
}): { numItems: number; cursor: string | null } {
  const numItems = Math.min(
    Math.max(1, Math.floor(opts.numItems)),
    MAX_PAGE_SIZE,
  );
  return { numItems, cursor: opts.cursor };
}

async function resolveActorName(
  ctx: QueryCtx,
  actorId: AuditLogDoc["actor"],
): Promise<string | null> {
  const user = await ctx.db.get(actorId);
  if (user === null) return null;
  if (typeof user !== "object") return null;
  const u = user as { name?: string; email?: string };
  return u.name ?? u.email ?? null;
}

async function projectRow(
  ctx: QueryCtx,
  row: AuditLogDoc,
): Promise<AuditLogRow> {
  const actorName = await resolveActorName(ctx, row.actor);
  const out: AuditLogRow = {
    _id: row._id,
    _creationTime: row._creationTime,
    actor: row.actor,
    actorName,
    timestamp: row.timestamp,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
  };
  if (row.before !== undefined) out.before = row.before;
  if (row.after !== undefined) out.after = row.after;
  if (row.reason !== undefined) out.reason = row.reason;
  return out;
}

/**
 * Paginated global activity feed — newest entries first. Uses the
 * `by_timestamp` index in descending order.
 *
 * Caller supplies Convex's standard `paginationOpts` ({ numItems,
 * cursor }). `numItems` is clamped to `[1, MAX_PAGE_SIZE]` server-side.
 * The continuation cursor in the response is opaque — the client
 * passes it back verbatim for the next page.
 *
 * Admin-only — `requireRole(ctx, ["admin"])` is the first awaited
 * statement (lint-enforced).
 */
export const listRecent = queryGeneric({
  args: {
    paginationOpts: paginationOptsValidator,
    /**
     * Optional inclusive lower bound (epoch ms). When supplied, the
     * scan restricts to rows whose `timestamp >= from`. Story 6.4's
     * audit_log export adapter forwards admin-supplied `args.from`
     * here so a "Jan–Mar audit log" export honors the date range
     * rather than silently delivering the most-recent rows.
     */
    from: v.optional(v.number()),
    /**
     * Optional inclusive upper bound (epoch ms). Pairs with `from`.
     */
    to: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      paginationOpts: { numItems: number; cursor: string | null };
      from?: number;
      to?: number;
    },
  ): Promise<AuditLogPage> => {
    await requireRole(ctx, ["admin"]);
    const opts = clampPaginationOpts(args.paginationOpts);
    const hasFrom = typeof args.from === "number" && Number.isFinite(args.from);
    const hasTo = typeof args.to === "number" && Number.isFinite(args.to);
    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_timestamp", (q) => {
        // The Convex `IndexRangeBuilder` narrows the builder type
        // after each call — `.gte()` returns an
        // `UpperBoundIndexRangeBuilder` that only has `.lt` / `.lte`.
        // So we branch on all four shapes explicitly rather than
        // re-assigning the (now-narrower) builder back to a wider
        // variable.
        if (hasFrom && hasTo) {
          return q
            .gte("timestamp", args.from as number)
            .lte("timestamp", args.to as number);
        }
        if (hasFrom) {
          return q.gte("timestamp", args.from as number);
        }
        if (hasTo) {
          return q.lte("timestamp", args.to as number);
        }
        return q;
      })
      .order("desc")
      .paginate(opts);
    const page = await Promise.all(
      result.page.map((row) => projectRow(ctx, row)),
    );
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Paginated history for a single entity — "show me every audit row
 * that touched this lot / customer / contract / etc." Newest first.
 *
 * Uses the `by_entity` index [entityType, entityId, timestamp] which
 * is the narrowest match for the filter shape.
 *
 * Admin-only.
 */
export const listByEntity = queryGeneric({
  args: {
    entityType: entityTypeValidator,
    entityId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      entityType: AuditLogDoc["entityType"];
      entityId: string;
      paginationOpts: { numItems: number; cursor: string | null };
    },
  ): Promise<AuditLogPage> => {
    await requireRole(ctx, ["admin"]);
    const opts = clampPaginationOpts(args.paginationOpts);
    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) =>
        q.eq("entityType", args.entityType).eq("entityId", args.entityId),
      )
      .order("desc")
      .paginate(opts);
    const page = await Promise.all(
      result.page.map((row) => projectRow(ctx, row)),
    );
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * Paginated history for a single actor — "what did this user do".
 * Newest first.
 *
 * Uses the `by_actor` index [actor, timestamp]. The argument is typed
 * as `v.id("users")` so a malformed actor id is rejected by the
 * validator before the handler runs.
 *
 * Admin-only.
 */
export const listByActor = queryGeneric({
  args: {
    actorUserId: v.id("users"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      actorUserId: AuditLogDoc["actor"];
      paginationOpts: { numItems: number; cursor: string | null };
    },
  ): Promise<AuditLogPage> => {
    await requireRole(ctx, ["admin"]);
    const opts = clampPaginationOpts(args.paginationOpts);
    const result = await ctx.db
      .query("auditLog")
      .withIndex("by_actor", (q) => q.eq("actor", args.actorUserId))
      .order("desc")
      .paginate(opts);
    const page = await Promise.all(
      result.page.map((row) => projectRow(ctx, row)),
    );
    return {
      page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

// Re-export the max-page-size constant for tests so they don't reach
// into the internals.
export { MAX_PAGE_SIZE };
