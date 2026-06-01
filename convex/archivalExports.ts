/**
 * Admin-facing surface for the monthly archival exports (Story 5.7,
 * FR62 / NFR-R3 / NFR-C2). The actual export action lives in
 * `convex/actions/archivalExport.ts` (Node-runtime, `"use node";`);
 * this file is the admin's read + manual-trigger boundary.
 *
 * Three functions:
 *   - `listExports` — admin-only query, returns every row from
 *     `archivalExports` ordered by `period` descending.
 *   - `getDownloadUrl` — admin-only query, returns the Convex
 *     File Storage signed URL for a row's blob (short-lived; the
 *     client uses it immediately to open / download the file).
 *   - `triggerArchivalExport` — admin-only mutation, schedules the
 *     internal action via `ctx.scheduler.runAfter(0, ...)`. The
 *     scheduler hop is the only safe way to call a Node-runtime
 *     action from a mutation — actions cannot be invoked
 *     synchronously via `ctx.runAction`.
 *
 * Auth posture: every public function calls `requireRole(ctx,
 * ["admin"])` as its first action — Story 1.2's enforced pattern.
 * `/admin/archival-exports` is gated at the edge by middleware
 * (`src/middleware.ts`) and again here at the server boundary
 * (NFR-S4 defense in depth).
 *
 * NFR-S3: signed URLs are short-lived; the client uses them
 * immediately. We never return the raw `storageId` to the client.
 *
 * Why a separate file from `convex/actions/archivalExport.ts`:
 *   - The action file is Node-runtime (`"use node";`) which limits
 *     the public-function surface (the `use node` directive
 *     forecloses some Convex bundler optimisations on the file).
 *   - Public queries / mutations belong in the default V8 runtime
 *     so the admin page's reactive subscription pays no extra
 *     start-up cost.
 *   - Splitting also keeps the public surface narrow — the action
 *     file's `monthlyArchivalExport` is `internalAction` only;
 *     callers reach it via the scheduler hop in this file.
 */

import {
  type DataModelFromSchemaDefinition,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { parsePeriod } from "./lib/archivalPeriods";
import { ErrorCode, throwError } from "./lib/errors";
// Imported from the neutral V8-safe module, NOT from the `"use node"`
// action file — importing anything from that file would pull its
// `node:zlib` / `node:crypto` imports into this mutation's V8 bundle.
import { MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH } from "./lib/archivalExportPath";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ArchivalExportDoc = DataModel["archivalExports"]["document"];
type ArchivalExportId = ArchivalExportDoc["_id"];

/**
 * Row shape returned by `listExports`. Narrow on purpose — the admin
 * list view only needs the metadata, not the storage id (which is
 * served via `getDownloadUrl` instead).
 */
export interface ArchivalExportListRow {
  _id: ArchivalExportId;
  _creationTime: number;
  period: string;
  sha256: string;
  sizeBytesUncompressed: number;
  sizeBytesCompressed: number;
  recordCounts: {
    receipts: number;
    payments: number;
    customers: number;
    contracts: number;
  };
  exportedAt: number;
  s3Status: "uploaded" | "failed" | "skipped" | null;
  s3Etag: string | null;
  s3UploadedAt: number | null;
  s3ErrorMessage: string | null;
}

/**
 * Admin list query — drives `/admin/archival-exports`. Returns
 * every `archivalExports` row ordered by `period` descending so the
 * latest export is at the top of the list.
 *
 * Auth: `requireRole(["admin"])`. Story 5.7 surfaces no office_staff
 * affordance for archival exports — the BIR retention surface is
 * cemetery-owner / admin only.
 */
export const listExports = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<ArchivalExportListRow[]> => {
    await requireRole(ctx, ["admin"]);
    const rows = await ctx.db
      .query("archivalExports")
      .withIndex("by_exportedAt")
      .order("desc")
      .collect();
    // Re-sort by period descending (a manual re-run can update
    // `exportedAt` for an OLDER period; the user expects the table
    // sorted by period). The `by_period` index covers the same
    // ordering at the storage layer; we apply the order in-handler
    // for clarity.
    rows.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
    return rows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      period: r.period,
      sha256: r.sha256,
      sizeBytesUncompressed: r.sizeBytesUncompressed,
      sizeBytesCompressed: r.sizeBytesCompressed,
      recordCounts: r.recordCounts,
      exportedAt: r.exportedAt,
      s3Status: r.s3Status ?? null,
      s3Etag: r.s3Etag ?? null,
      s3UploadedAt: r.s3UploadedAt ?? null,
      s3ErrorMessage: r.s3ErrorMessage ?? null,
    }));
  },
});

/**
 * Admin download-URL query — returns the short-lived signed URL for
 * a single archival export's stored blob. The URL is the only safe
 * way to surface the file to the browser (NFR-S3 — never raw
 * storage ids).
 *
 * Returns `null` URL when the row is missing the storageId
 * (shouldn't happen in Phase 1 — the row is only inserted after the
 * blob lands — but the read path tolerates the shape).
 */
export const getDownloadUrl = queryGeneric({
  args: { exportId: v.id("archivalExports") },
  handler: async (
    ctx: QueryCtx,
    args: { exportId: ArchivalExportId },
  ): Promise<{ url: string | null; period: string | null }> => {
    await requireRole(ctx, ["admin"]);
    const row = await ctx.db.get(args.exportId);
    if (row === null) {
      return { url: null, period: null };
    }
    const url = await ctx.storage.getUrl(row.storageId);
    return { url: url ?? null, period: row.period };
  },
});

/**
 * Admin manual-trigger mutation — schedules the archival export
 * action for `period` via `ctx.scheduler.runAfter(0, ...)`. The
 * scheduler hop is the canonical pattern for invoking a Node-runtime
 * action from a mutation (Story 6.1's `generateContractPdfRequest`
 * uses the same shape).
 *
 * Use cases:
 *   - Backfill an older period that the cron missed (e.g. the cron
 *     was disabled during a maintenance window).
 *   - Re-run an export that failed (s3 misconfig, transient outage).
 *     The action's idempotency check tolerates re-runs over a
 *     `failed` row — the existing storage blob + row are
 *     overwritten.
 *
 * Args: `period` — `"YYYY-MM"` string. Validated server-side via
 * `parsePeriod` from `convex/lib/archivalPeriods.ts`.
 *
 * Auth: `requireRole(["admin"])`.
 */
export const triggerArchivalExport = mutationGeneric({
  args: { period: v.string() },
  handler: async (
    ctx: MutationCtx,
    args: { period: string },
  ): Promise<{ scheduled: true; period: string }> => {
    await requireRole(ctx, ["admin"]);
    // Validate the period shape before scheduling — throwing here
    // gives the admin an immediate inline error instead of an
    // opaque "action failed" log after the scheduler hop.
    try {
      parsePeriod(args.period);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throwError(ErrorCode.VALIDATION, message, { period: args.period });
    }
    // Schedule the action. The scheduler.runAfter delay of 0 means
    // "as soon as the mutation transaction commits" — Convex's
    // scheduler explicitly serialises this so the action sees the
    // committed DB state.
    //
    // The action reference is built via `makeFunctionReference`
    // against the action's function path constant, mirroring the
    // pattern in `convex/contracts.ts → generateContractPdfRequest`.
    const actionRef = makeFunctionReference<
      "action",
      { overridePeriod?: string },
      {
        period: string;
        storageId: string;
        recordCounts: {
          receipts: number;
          payments: number;
          customers: number;
          contracts: number;
        };
        status: "ready" | "skipped";
        s3Status: "uploaded" | "failed" | "skipped";
      }
    >(MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH);
    await ctx.scheduler.runAfter(0, actionRef, {
      overridePeriod: args.period,
    });
    return { scheduled: true, period: args.period };
  },
});
