/**
 * V8-runtime internal mutation for the archival-export action (Story 5.7).
 *
 * Same runtime-split rationale as `generateContractPdfInternal.ts`: the
 * archival action (`actions/archivalExport.ts`) runs in Node (`"use node"`
 * — it gzips + hashes + optionally uploads to S3), and Convex forbids
 * defining mutations in a `"use node"` module. So the DB upsert that
 * records the `archivalExports` row lives HERE in the default V8 runtime;
 * the action calls it via `makeFunctionReference` against
 * `archivalExportInternal:insertExportRecord`.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { type MutationCtx } from "./lib/auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ArchivalExportDoc = DataModel["archivalExports"]["document"];
type ArchivalExportId = ArchivalExportDoc["_id"];
type StorageId = ArchivalExportDoc["storageId"];

/**
 * Internal mutation — insert / patch the `archivalExports` row. Splits
 * the "insert on first run" + "patch on rerun" paths into a single upsert
 * keyed by `period`. Internal because the cron-driven action has no user
 * context; `requireRole` does not apply.
 */
export const insertExportRecord = internalMutationGeneric({
  args: {
    period: v.string(),
    storageId: v.id("_storage"),
    sha256: v.string(),
    sizeBytesUncompressed: v.number(),
    sizeBytesCompressed: v.number(),
    recordCounts: v.object({
      receipts: v.number(),
      payments: v.number(),
      customers: v.number(),
      contracts: v.number(),
    }),
    exportedAt: v.number(),
    s3Status: v.optional(
      v.union(
        v.literal("uploaded"),
        v.literal("failed"),
        v.literal("skipped"),
      ),
    ),
    s3Etag: v.optional(v.string()),
    s3UploadedAt: v.optional(v.number()),
    s3ErrorMessage: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      period: string;
      storageId: StorageId;
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
      s3Status?: "uploaded" | "failed" | "skipped";
      s3Etag?: string;
      s3UploadedAt?: number;
      s3ErrorMessage?: string;
    },
  ): Promise<ArchivalExportId> => {
    const existing = await ctx.db
      .query("archivalExports")
      .withIndex("by_period", (q) => q.eq("period", args.period))
      .unique();
    const patch: Partial<ArchivalExportDoc> = {
      storageId: args.storageId,
      sha256: args.sha256,
      sizeBytesUncompressed: args.sizeBytesUncompressed,
      sizeBytesCompressed: args.sizeBytesCompressed,
      recordCounts: args.recordCounts,
      exportedAt: args.exportedAt,
    };
    if (args.s3Status !== undefined) patch.s3Status = args.s3Status;
    if (args.s3Etag !== undefined) patch.s3Etag = args.s3Etag;
    if (args.s3UploadedAt !== undefined)
      patch.s3UploadedAt = args.s3UploadedAt;
    if (args.s3ErrorMessage !== undefined)
      patch.s3ErrorMessage = args.s3ErrorMessage;

    if (existing !== null) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    const id = await ctx.db.insert("archivalExports", {
      period: args.period,
      storageId: args.storageId,
      sha256: args.sha256,
      sizeBytesUncompressed: args.sizeBytesUncompressed,
      sizeBytesCompressed: args.sizeBytesCompressed,
      recordCounts: args.recordCounts,
      exportedAt: args.exportedAt,
      ...(args.s3Status !== undefined ? { s3Status: args.s3Status } : {}),
      ...(args.s3Etag !== undefined ? { s3Etag: args.s3Etag } : {}),
      ...(args.s3UploadedAt !== undefined
        ? { s3UploadedAt: args.s3UploadedAt }
        : {}),
      ...(args.s3ErrorMessage !== undefined
        ? { s3ErrorMessage: args.s3ErrorMessage }
        : {}),
    });
    return id;
  },
});
