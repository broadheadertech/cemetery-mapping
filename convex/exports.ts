/**
 * Report-export orchestration — Story 6.4 (FR46).
 *
 * Public surface admins use to request, list, retry, and download
 * report exports. The actual rendering happens out-of-band in
 * `convex/actions/generateReportExport.ts` (Node runtime — PDFKit +
 * the renderer module are Node-only). This file owns:
 *
 *   - `requestExport({ reportType, args, format })` — admin-only
 *     mutation that inserts an `exports` row in `status: "pending"`
 *     and schedules the Node action.
 *   - `listMyExports({ limit })` — admin-only paginated list of the
 *     caller's exports (most-recent first).
 *   - `getExportById({ exportId })` — admin-only reactive read; the
 *     UI subscribes here while the action renders and flips to
 *     `status: "ready"`.
 *   - `getExportDownloadUrl({ exportId })` — admin-only signed URL
 *     fetch + downloadCount increment. Returns `null` when the row
 *     is not in `ready` state or the blob has expired.
 *   - Internal helpers (`_markReady`, `_markFailed`, `_listForRetry`,
 *     `_listForCleanup`) used by the action + scheduled sweeps.
 *
 * Phase 2 scope deviations from the original Story 6.4 spec (documented
 * in the Dev Agent Record):
 *   - `format: "xlsx"` is rendered as CSV bytes (zero new npm deps —
 *     no `exceljs`). CSV opens natively in Excel / Sheets / Numbers.
 *     A future story can layer XLSX without changing the public
 *     surface (the `format` field already accepts the literal).
 *   - Streaming threshold: not implemented (Phase 1 cemetery has
 *     ≤ 1,000 sales/year and ≤ 2,000 lots; in-memory render fits in
 *     the action's 60-second budget by orders of magnitude). The
 *     5-second streaming AC is preserved as a Phase 2 reservation.
 *
 * Auth contract:
 *   - Every public surface calls `requireRole(ctx, ["admin"])` as the
 *     first awaited statement. Exports of audit logs / customer data
 *     are PII-access events (NFR-S7 / NFR-C4) and must NEVER be
 *     reachable by non-admin roles.
 *   - The action re-validates auth via the report query it calls
 *     back into (each underlying report query also `requireRole`s
 *     the admin caller — defense in depth).
 *   - Signed URLs are produced via `ctx.storage.getUrl(blobId)` and
 *     never expose the raw storage id (NFR-S3).
 *
 * Audit trail:
 *   - `requestExport` emits `read_pii` (the closest action verb for
 *     "admin read+exported aggregated data"). Re-uses the entityType
 *     `piiAccess` so the audit log filter for PII access reviews
 *     surfaces the row alongside the Story 2.3 PII read events.
 *   - `_markReady` / `_markFailed` are server-side state transitions
 *     of the export row; the original `read_pii` emission already
 *     covers the audit-trail question ("who requested an export of
 *     X data when?") so the internal mutations do not emit again.
 *   - Cleanup sweep ("expired" transition) does not emit either —
 *     blob expiry is a derived operation; the original `read_pii`
 *     row is the compliance artefact.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ExportDoc = DataModel["exports"]["document"];
type ExportId = ExportDoc["_id"];

/** Closed enum of supported report types. Mirror the schema validator. */
export type ReportType =
  | "sales_by_dimension"
  | "ar_aging"
  | "audit_log";

export type ExportFormat = "xlsx" | "pdf";

export type ExportStatus = "pending" | "ready" | "failed" | "expired";

const reportTypeValidator = v.union(
  v.literal("sales_by_dimension"),
  v.literal("ar_aging"),
  v.literal("audit_log"),
);

const formatValidator = v.union(v.literal("xlsx"), v.literal("pdf"));

/**
 * Maximum retry count for the scheduled sweep (Task 6). Exposed as a
 * named constant so the test suite + the sweep logic share one source
 * of truth.
 */
export const MAX_RETRY_COUNT = 3;

/**
 * Sweep-claim window. The retry sweep treats a `pending` row whose
 * `scheduledAt` is within this window as "another scheduler is already
 * working on it" and skips re-scheduling. Mirrors the cron's 5-minute
 * cadence; we choose a slightly larger value so the window survives a
 * single late-firing sweep without re-arming a duplicate action.
 */
const SCHEDULED_CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * Args shape and runtime validator helper. Per-report validation lives
 * here so `requestExport` rejects malformed args at the public-surface
 * mutation boundary, before the action ever runs. The audit-log adapter
 * also reads `from` / `to`; the sales-by-dimension adapter requires
 * `from` and `to`; AR-aging accepts an empty args bag.
 *
 * Convex's `v.any()` is too permissive for a PII-adjacent mutation — a
 * caller can shove arbitrary payload into the export row and have it
 * persist there. We narrow per-type below.
 */
function validateRequestArgs(
  reportType: ReportType,
  args: unknown,
): { from?: number; to?: number; [k: string]: unknown } {
  const isObject =
    args !== null && typeof args === "object" && !Array.isArray(args);
  if (!isObject) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      "requestExport: args must be an object",
    );
  }
  const a = args as Record<string, unknown>;
  const isNum = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  const isStr = (v: unknown): v is string => typeof v === "string";
  switch (reportType) {
    case "sales_by_dimension": {
      if (!isNum(a.from) || !isNum(a.to)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: sales_by_dimension requires numeric from/to",
        );
      }
      if (a.from > a.to) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: sales_by_dimension from must be <= to",
        );
      }
      for (const k of ["lotTypeId", "sectionId", "agentId"]) {
        if (a[k] !== undefined && !isStr(a[k])) {
          throwError(
            ErrorCode.INVARIANT_VIOLATION,
            `requestExport: sales_by_dimension ${k} must be a string`,
          );
        }
      }
      return a as { from: number; to: number };
    }
    case "ar_aging": {
      if (a.asOf !== undefined && !isNum(a.asOf)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: ar_aging asOf must be a number",
        );
      }
      return a;
    }
    case "audit_log": {
      if (a.from !== undefined && !isNum(a.from)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: audit_log from must be a number",
        );
      }
      if (a.to !== undefined && !isNum(a.to)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: audit_log to must be a number",
        );
      }
      if (
        isNum(a.from) &&
        isNum(a.to) &&
        (a.from as number) > (a.to as number)
      ) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: audit_log from must be <= to",
        );
      }
      if (a.entityType !== undefined && !isStr(a.entityType)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: audit_log entityType must be a string",
        );
      }
      if (a.action !== undefined && !isStr(a.action)) {
        throwError(
          ErrorCode.INVARIANT_VIOLATION,
          "requestExport: audit_log action must be a string",
        );
      }
      return a;
    }
    default: {
      const never: never = reportType;
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        `requestExport: unknown reportType ${String(never)}`,
      );
    }
  }
}

/**
 * Sanitized args summary persisted to the audit-log `after` payload.
 * Avoids dumping the entire opaque `v.any()` blob into the append-only
 * log (NFR-S7). The summary keeps the load-bearing fields (date range
 * for time-bounded reports) for compliance reviewers without echoing
 * arbitrary attacker-supplied keys.
 */
function summarizeArgs(
  reportType: ReportType,
  args: { from?: number; to?: number; [k: string]: unknown },
): Record<string, unknown> {
  switch (reportType) {
    case "sales_by_dimension": {
      const out: Record<string, unknown> = { from: args.from, to: args.to };
      for (const k of ["lotTypeId", "sectionId", "agentId"]) {
        if (args[k] !== undefined) out[k] = args[k];
      }
      return out;
    }
    case "ar_aging": {
      const out: Record<string, unknown> = {};
      if (args.asOf !== undefined) out.asOf = args.asOf;
      return out;
    }
    case "audit_log": {
      const out: Record<string, unknown> = {};
      if (args.from !== undefined) out.from = args.from;
      if (args.to !== undefined) out.to = args.to;
      if (args.entityType !== undefined) out.entityType = args.entityType;
      if (args.action !== undefined) out.action = args.action;
      return out;
    }
    default:
      return {};
  }
}

/**
 * Convex function reference to the export action. Resolved at runtime;
 * the action lives in `convex/actions/generateReportExport.ts`. We use
 * `makeFunctionReference` for the same reason `crons.ts` /
 * `lib/audit.ts` do — `convex/_generated/api.ts` doesn't exist yet in
 * this repo so static `internal.actions.*` imports are not available
 * pre-codegen.
 */
const generateReportExportRef = makeFunctionReference<
  "action",
  { exportId: string },
  null
>("actions/generateReportExport:generateReportExport");

/**
 * Public mutation: admin requests an export. Inserts the `exports` row
 * in `status: "pending"`, schedules the Node action to render the file,
 * and returns the row id so the UI can subscribe via
 * `getExportById({ exportId })`.
 *
 * The action receives the row id (not the args themselves) so a tamper
 * of the row between mutation + action execution is impossible — the
 * action re-reads the row through an internal query.
 */
export const requestExport = mutationGeneric({
  args: {
    reportType: reportTypeValidator,
    args: v.any(),
    format: formatValidator,
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      reportType: ReportType;
      args: unknown;
      format: ExportFormat;
    },
  ): Promise<{ exportId: ExportId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    // P1-6: narrow `args.args` per `reportType`. `v.any()` at the
    // validator surface is necessary because Convex doesn't yet support
    // discriminated-union args at the codegen level in this repo; we
    // re-validate inside the handler so a malformed payload is rejected
    // before the row is inserted and before the action ever fires.
    const validated = validateRequestArgs(args.reportType, args.args);

    // P1-4: enforce `MAX_RETRY_COUNT` against the (caller, reportType)
    // tuple. The action's retry counter lives on the failed row; once a
    // row hits the cap the sweep stops. The UI Retry button issues a
    // FRESH `requestExport`, which would otherwise insert a row with
    // `retryCount: 0` and defeat the cap. We block here by reading the
    // caller's recent failed rows for the same reportType and refusing
    // when any of them are at the cap.
    const recentFailed = await ctx.db
      .query("exports")
      .withIndex("by_requestedBy_requestedAt", (q) =>
        q.eq("requestedBy", auth.userId),
      )
      .order("desc")
      .take(50);
    const cappedFailureExists = recentFailed.some(
      (row) =>
        row.reportType === args.reportType &&
        row.status === "failed" &&
        row.retryCount >= MAX_RETRY_COUNT,
    );
    if (cappedFailureExists) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "Retry cap exceeded for this report. Wait for the issue to be resolved or contact support.",
      );
    }

    const now = Date.now();
    const exportId = await ctx.db.insert("exports", {
      reportType: args.reportType,
      args: args.args,
      format: args.format,
      status: "pending",
      requestedBy: auth.userId,
      requestedAt: now,
      downloadCount: 0,
      retryCount: 0,
      scheduledAt: now,
    });

    // Schedule the action immediately. The action's own auth-chain
    // (it calls back into the report query, which requireRole-s the
    // admin caller) is the defense-in-depth.
    await ctx.scheduler.runAfter(0, generateReportExportRef, {
      exportId: exportId as unknown as string,
    });

    await emitAudit(ctx, {
      action: "read_pii",
      entityType: "piiAccess",
      entityId: exportId,
      after: {
        kind: "reportExport",
        reportType: args.reportType,
        format: args.format,
        // P1-6: sanitized `argsSummary` (no opaque attacker keys).
        argsSummary: summarizeArgs(args.reportType, validated),
      },
    });

    return { exportId };
  },
});

/** Row shape returned by `listMyExports` + `getExportById`. */
export interface ExportRow {
  _id: ExportId;
  _creationTime: number;
  reportType: ReportType;
  format: ExportFormat;
  status: ExportStatus;
  requestedAt: number;
  readyAt: number | null;
  downloadCount: number;
  retryCount: number;
  lastError: string | null;
  /**
   * Args echoed back to the UI so the "re-run" affordance can copy
   * them into a fresh request without round-tripping through another
   * query. Treat as opaque JSON in render code.
   */
  args: unknown;
}

function projectRow(row: ExportDoc): ExportRow {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    reportType: row.reportType,
    format: row.format,
    status: row.status,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt ?? null,
    downloadCount: row.downloadCount,
    retryCount: row.retryCount,
    lastError: row.lastError ?? null,
    args: row.args,
  };
}

/**
 * Lists the caller's exports, most-recent-first. `limit` caps the
 * result count — Phase 2 default is 50, matching the "My exports" page
 * UX surface.
 */
export const listMyExports = queryGeneric({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number },
  ): Promise<{ exports: ExportRow[] }> => {
    const auth = await requireRole(ctx, ["admin"]);
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const rows = await ctx.db
      .query("exports")
      .withIndex("by_requestedBy_requestedAt", (q) =>
        q.eq("requestedBy", auth.userId),
      )
      .order("desc")
      .take(limit);
    return { exports: rows.map(projectRow) };
  },
});

/**
 * Reactive single-row read. The UI subscribes here while the action
 * renders and flips the row through `pending` → `ready` (success) or
 * `pending` → `failed` (after action error).
 */
export const getExportById = queryGeneric({
  args: { exportId: v.id("exports") },
  handler: async (
    ctx: QueryCtx,
    args: { exportId: ExportId },
  ): Promise<ExportRow | null> => {
    const auth = await requireRole(ctx, ["admin"]);
    const row = await ctx.db.get(args.exportId);
    if (row === null) return null;
    // Admins can only see their OWN export rows (defense in depth —
    // even if the UI mis-passes another admin's id, the projection
    // is gated by `requestedBy === caller`). Audit reviewers reach
    // the row via the audit log surface, not this query.
    if (row.requestedBy !== auth.userId) return null;
    return projectRow(row);
  },
});

/**
 * Produces a signed download URL for a `ready` export. Returns `null`
 * when:
 *   - The export does not exist
 *   - The caller is not the owner (defense in depth)
 *   - The export is not `ready`
 *   - The blob has been deleted (expired or never landed)
 *
 * Side effect: increments `downloadCount` on success. The count helps
 * Phase 2 retros understand which reports the cemetery actually uses.
 */
export const getExportDownloadUrl = mutationGeneric({
  args: { exportId: v.id("exports") },
  handler: async (
    ctx: MutationCtx,
    args: { exportId: ExportId },
  ): Promise<{ url: string | null }> => {
    const auth = await requireRole(ctx, ["admin"]);
    const row = await ctx.db.get(args.exportId);
    if (row === null) return { url: null };
    if (row.requestedBy !== auth.userId) return { url: null };
    if (row.status !== "ready" || row.blobId === undefined) {
      return { url: null };
    }
    const url = await ctx.storage.getUrl(row.blobId);
    if (url === null) return { url: null };

    await ctx.db.patch(args.exportId, {
      downloadCount: row.downloadCount + 1,
    });

    return { url };
  },
});

// ---------------------------------------------------------------------------
// Internal helpers — used by the Node action + the scheduled sweep.
// Internal mutations skip `requireRole` (Convex actions cannot read
// auth from `ctx.db`). The trust chain is: action is only schedulable
// by the public `requestExport` mutation (which is admin-gated), and
// the sweep is only invoked by the cron registration.
// ---------------------------------------------------------------------------

/**
 * Internal query the action uses to read the row it's working on. The
 * action re-reads via this query rather than receiving the args inline
 * — this prevents a tampered scheduled-arg payload from bypassing the
 * row's `args` validation.
 */
export const internal_getExportRow = internalQueryGeneric({
  args: { exportId: v.id("exports") },
  handler: async (
    ctx: QueryCtx,
    args: { exportId: ExportId },
  ): Promise<ExportDoc | null> => {
    // Internal-only read (not in the public function namespace): callable
    // solely from `generateReportExport.ts`'s scheduled action, which is
    // itself launched from the admin-gated `requestExport`. Declaring it
    // `internalQueryGeneric` keeps the full export row (blobId, filter
    // args, requestedBy) off the public API — a `queryGeneric` here was an
    // IDOR that returned any owner's export row to any authenticated caller.
    return await ctx.db.get(args.exportId);
  },
});

/** Internal: action calls this on success. */
export const internal_markReady = internalMutationGeneric({
  args: {
    exportId: v.id("exports"),
    blobId: v.id("_storage"),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      exportId: ExportId;
      blobId: DataModel["receipts"]["document"]["pdfStorageId"];
    },
  ): Promise<null> => {
    const row = await ctx.db.get(args.exportId);
    if (row === null) return null;
    await ctx.db.patch(args.exportId, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "ready",
      blobId: args.blobId,
      readyAt: Date.now(),
    });
    return null;
  },
});

/** Internal: action calls this on failure. */
export const internal_markFailed = internalMutationGeneric({
  args: {
    exportId: v.id("exports"),
    error: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: { exportId: ExportId; error: string },
  ): Promise<null> => {
    const row = await ctx.db.get(args.exportId);
    if (row === null) return null;
    await ctx.db.patch(args.exportId, {
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "failed",
      lastError: args.error,
      retryCount: row.retryCount + 1,
    });
    return null;
  },
});

/**
 * Internal: 5-minute retry sweep. Finds exports stuck in
 * `pending` or `failed` with retryCount below the cap and reschedules
 * the action. Hour-bounded (`requestedAt > now - 1h`) so we don't keep
 * retrying ancient rows forever.
 *
 * P1-3 optimistic-claim protocol:
 *   - Each pass writes `scheduledAt = now()` onto the row BEFORE
 *     `ctx.scheduler.runAfter`. A second sweep firing within
 *     `SCHEDULED_CLAIM_WINDOW_MS` will observe a fresh `scheduledAt`
 *     and skip the row, so a double-firing cron never produces two
 *     simultaneous schedule entries for the same row.
 *   - `pending` rows with a recent `scheduledAt` are explicitly left
 *     alone — the in-flight action is still working on them.
 *   - `failed` rows have no recent `scheduledAt` claim (the action
 *     already finished); the sweep flips them back to pending and
 *     re-claims via a fresh `scheduledAt`.
 */
export const internal_retrySweep = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ retried: number; skipped: number }> => {
    const now = Date.now();
    const cutoff = now - 60 * 60 * 1000;
    const claimCutoff = now - SCHEDULED_CLAIM_WINDOW_MS;
    const failed = await ctx.db
      .query("exports")
      .withIndex("by_status_requestedAt", (q) => q.eq("status", "failed"))
      .collect();
    const pending = await ctx.db
      .query("exports")
      .withIndex("by_status_requestedAt", (q) => q.eq("status", "pending"))
      .collect();
    const candidates = [...failed, ...pending].filter(
      (row) =>
        row.retryCount < MAX_RETRY_COUNT && row.requestedAt > cutoff,
    );
    let retried = 0;
    let skipped = 0;
    for (const row of candidates) {
      // Optimistic claim: skip rows whose `scheduledAt` is fresh enough
      // that another sweep / the original schedule call must already
      // be working on it. For pending rows this is the dominant
      // skip path (avoids double-schedule); for failed rows the
      // sweep typically resets the claim itself.
      if (
        typeof row.scheduledAt === "number" &&
        row.scheduledAt >= claimCutoff
      ) {
        skipped += 1;
        continue;
      }
      try {
        // Patch the claim marker BEFORE `runAfter` so a concurrent
        // sweep that's already past the claim-check above never reads
        // a stale `scheduledAt`.
        await ctx.db.patch(row._id, { scheduledAt: now });
        await ctx.scheduler.runAfter(0, generateReportExportRef, {
          exportId: row._id as unknown as string,
        });
        // Re-flip status to pending so the UI knows the row is being
        // worked on again. Don't bump retryCount — the action does
        // that on the next failure.
        if (row.status === "failed") {
          // eslint-disable-next-line local-rules/no-raw-status-patch
          await ctx.db.patch(row._id, { status: "pending" });
        }
        retried += 1;
      } catch (err) {
        console.error(
          "[exports] retry sweep skip",
          row._id,
          (err as Error).message,
        );
        skipped += 1;
      }
    }
    return { retried, skipped };
  },
});

/**
 * Internal: daily cleanup sweep. Marks `ready` rows older than 30 days
 * as `expired` and deletes the underlying blob. The row PERSISTS — the
 * audit trail of "admin X exported Y on date Z" stays intact.
 *
 * P1-5: blob reclamation is best-effort. The audit-log preservation
 * (the row's `read_pii` history) is the load-bearing concern; if
 * `ctx.storage.delete` throws (transient storage error, blob already
 * gone, etc.) we STILL patch the row to `expired` so the signed-URL
 * mint path stops minting against it. Persistent failures get a
 * console.error with the storageId so ops can manually reclaim.
 */
export const internal_cleanupSweep = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ expired: number; skipped: number }> => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const ready = await ctx.db
      .query("exports")
      .withIndex("by_status_requestedAt", (q) =>
        q.eq("status", "ready"),
      )
      .collect();
    const candidates = ready.filter((row) => {
      const ts = row.readyAt ?? row.requestedAt;
      return ts < cutoff;
    });
    let expired = 0;
    let skipped = 0;
    for (const row of candidates) {
      // Best-effort blob delete. The row patch must succeed regardless
      // so a downstream `getExportDownloadUrl` no longer hands out a
      // signed URL for a row we consider expired.
      if (row.blobId !== undefined) {
        try {
          await ctx.storage.delete(row.blobId);
        } catch (err) {
          console.error(
            "[exports] cleanup sweep: storage.delete failed",
            row._id,
            row.blobId,
            (err as Error).message,
          );
        }
      }
      try {
        await ctx.db.patch(row._id, {
          // eslint-disable-next-line local-rules/no-raw-status-patch
          status: "expired",
          blobId: undefined,
        });
        expired += 1;
      } catch (err) {
        console.error(
          "[exports] cleanup sweep: patch failed",
          row._id,
          (err as Error).message,
        );
        skipped += 1;
      }
    }
    return { expired, skipped };
  },
});

// Re-export the validator for the action so it doesn't import schema
// itself.
export { reportTypeValidator, formatValidator };

// Surface a friendly throw-error helper for the action.
export function throwExportInvariant(message: string): never {
  return throwError(ErrorCode.INVARIANT_VIOLATION, message);
}
