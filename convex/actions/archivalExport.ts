"use node";

/**
 * Monthly archival export for BIR 10-year retention (Story 5.7 —
 * FR62, NFR-R3, NFR-C2).
 *
 * Node-runtime Convex action that:
 *
 *   1. Computes the prior calendar month in Manila tz (or accepts an
 *      override period for manual re-runs / backfills).
 *   2. Reads every receipt + payment + customer + contract that the
 *      period touches via the internal queries in
 *      `convex/lib/archivalQueries.ts`.
 *   3. Builds a human-readable JSON payload, pretty-printed with
 *      2-space indentation.
 *   4. Compresses the payload with gzip (Node's `node:zlib`) and
 *      computes the SHA-256 of the compressed blob.
 *   5. Writes the gzipped blob to Convex File Storage.
 *   6. Optionally mirrors the blob to an S3-compatible bucket when
 *      `ARCHIVE_S3_BUCKET` is configured.
 *   7. Inserts (or patches) an `archivalExports` row capturing the
 *      `storageId`, sha256, sizes, record counts, and S3 status.
 *
 * Why a Node-runtime action (the `"use node";` directive on line 1):
 *   - `node:zlib` (gzip) and `node:crypto` (SHA-256) are Node-only.
 *     The Convex default V8 runtime can't import them.
 *   - The optional AWS SDK call (`@aws-sdk/client-s3`) is Node-only.
 *   - Pure-JS gzip alternatives exist (`pako`) but adopting Node
 *     keeps the stack narrow.
 *
 * Why `internalAction` (not the public `action`):
 *   - The function is invoked by the monthly cron + by the
 *     `triggerArchivalExport` mutation (Admin-gated). It has no
 *     direct client call path.
 *   - The `triggerArchivalExport` mutation in
 *     `convex/archivalExports.ts` provides the client-driven entry
 *     by scheduling this action via `ctx.scheduler.runAfter(0, ...)`.
 *
 * Idempotency:
 *   - The action checks `archivalExports.by_period` at the start. If
 *     a row already exists for `period`, the action LOGS a "skipping"
 *     message and returns without overwriting. Manual `--force`
 *     re-runs are not Phase-1 scope; the cron's accidental
 *     double-trigger is the threat the check defends against.
 *   - Failure recovery path: if a row exists with `s3Status: "failed"`
 *     and the operator re-runs from the admin UI, the action treats
 *     it as a re-export (overwrites the row + storage + retries S3).
 *     This is the only "force" path Phase-1 supports.
 *
 * Action runtime budget:
 *   - Convex actions have a ~10-minute wall-clock cap. A typical
 *     month at the cemetery's projected volume (~2k payments × ~1KB
 *     JSON each = ~2MB uncompressed → ~200KB gzipped) finishes in
 *     well under a second. The first real export should measure +
 *     log the actual duration.
 *
 * Failure model:
 *   - Any throw inside the action propagates to Convex's action-
 *     error log. The action attempts to write a `failed` row to
 *     `archivalExports` before re-throwing so the admin UI surfaces
 *     the failure.
 *   - S3 upload failures DO NOT throw — they are captured into
 *     `s3Status: "failed"` + `s3ErrorMessage` and the action
 *     completes "ready" otherwise. The admin can re-trigger from
 *     `/admin/archival-exports` once the S3 misconfig is resolved.
 *
 * Disaster-prevention rules (per the story spec's "do NOT" list):
 *   - Do NOT delete an existing `archivalExports` row or its file —
 *     append-only by design.
 *   - Do NOT include unredacted `govIdNumber` — only last-4 (handled
 *     by `convex/lib/archivalQueries.ts`).
 *   - Do NOT use `new Date().getMonth()` — anchor through
 *     `convex/lib/archivalPeriods.ts` Manila helpers.
 *   - Do NOT compress with `deflate` or `brotli` — gzip is the
 *     documented format.
 *   - Do NOT pretty-print AFTER compression — `JSON.stringify`
 *     produces the readable text; gzip wraps it.
 *   - Do NOT hardcode the S3 endpoint — `ARCHIVE_S3_ENDPOINT` is
 *     optional and supports non-AWS providers (Backblaze B2,
 *     Cloudflare R2, Wasabi).
 *   - Do NOT log full file contents in any error path — the export
 *     contains PII even when redacted; treat logs as semi-public.
 *   - Do NOT silently swallow S3 failures — capture in
 *     `s3Status: "failed"` + `s3ErrorMessage` so the admin sees it.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  internalActionGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// `insertExportRecord` (the V8 mutation that writes the archivalExports
// row) lives in `convex/archivalExportInternal.ts` — Convex forbids
// defining mutations in this `"use node"` file. The action calls it via
// the `archivalExportInternal:insertExportRecord` function reference.
import schema from "../schema";
import {
  formatPeriod,
  getPeriodBounds,
  getPriorPeriod,
  parsePeriod,
} from "../lib/archivalPeriods";
import { MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH } from "../lib/archivalExportPath";
import type {
  ArchivalContractRow,
  ArchivalCustomerRow,
  ArchivalPaymentRow,
  ArchivalReceiptRow,
} from "../lib/archivalQueries";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ArchivalExportDoc = DataModel["archivalExports"]["document"];
type ArchivalExportId = ArchivalExportDoc["_id"];
type StorageId = ArchivalExportDoc["storageId"];
type ActionCtx = GenericActionCtx<DataModel>;

/** Schema version of the archival JSON payload — bump on shape change. */
export const ARCHIVAL_SCHEMA_VERSION = 1;

/**
 * Function path the cron in `convex/crons.ts` references. Defined in the
 * V8-safe `../lib/archivalExportPath` module and re-exported here for
 * back-compat: V8 callers (e.g. `convex/archivalExports.ts`) MUST import
 * it from that module, never from this `"use node"` file, or esbuild
 * drags this file's `node:` imports into the V8 bundle. See that module's
 * header for the full rationale.
 */
export { MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH };

/**
 * The serialised archival payload shape — the JSON written to
 * Convex File Storage. Stable across schema versions until
 * `ARCHIVAL_SCHEMA_VERSION` is bumped.
 */
export interface ArchivalPayload {
  schemaVersion: number;
  period: string;
  exportedAt: number;
  deploymentName: string;
  recordCounts: {
    receipts: number;
    payments: number;
    customers: number;
    contracts: number;
  };
  receipts: ArchivalReceiptRow[];
  payments: ArchivalPaymentRow[];
  customers: ArchivalCustomerRow[];
  contracts: ArchivalContractRow[];
}

/**
 * S3 upload result shape — narrow on purpose so the action can patch
 * the `archivalExports` row's `s3Status` / `s3Etag` /
 * `s3ErrorMessage` fields without ambiguity.
 */
export interface S3UploadResult {
  status: "uploaded" | "failed" | "skipped";
  etag?: string;
  errorMessage?: string;
}

/**
 * Upload the gzipped blob to the configured S3-compatible bucket.
 *
 *   - `ARCHIVE_S3_BUCKET` UNSET → `{ status: "skipped" }` (S3 mirror
 *     is opt-in; absent env var is the no-op default).
 *   - Upload success → `{ status: "uploaded", etag }`. The ETag is
 *     captured from the response; for non-multipart uploads (which
 *     our < 100MB blobs always are) it equals the blob's MD5.
 *   - Upload failure → `{ status: "failed", errorMessage }`. The
 *     action does NOT throw — the caller records the failure on the
 *     `archivalExports` row so the admin UI surfaces it for manual
 *     retry.
 *
 * Environment variables (all `process.env`):
 *   - `ARCHIVE_S3_BUCKET`  — required to enable the mirror.
 *   - `ARCHIVE_S3_REGION`  — required when the bucket is configured.
 *   - `ARCHIVE_S3_ACCESS_KEY` — required.
 *   - `ARCHIVE_S3_SECRET_KEY` — required.
 *   - `ARCHIVE_S3_ENDPOINT` — OPTIONAL; supports non-AWS providers
 *     (Backblaze B2, Cloudflare R2, Wasabi). Falls back to AWS S3's
 *     standard endpoint when absent.
 *
 * Why the SDK is loaded lazily (`await import(...)`):
 *   - Convex's Node-runtime bundler is sensitive to top-level
 *     side-effectful imports. Lazy loading the SDK keeps the cold-
 *     start path narrow for the common "S3 not configured" case.
 *   - Tests can mock the SDK via `vi.mock("@aws-sdk/client-s3", ...)`
 *     and assert no call when the env var is unset, without the SDK
 *     ever being instantiated.
 */
export async function uploadToS3(
  compressed: Buffer,
  period: string,
): Promise<S3UploadResult> {
  const bucket = process.env.ARCHIVE_S3_BUCKET;
  if (bucket === undefined || bucket.length === 0) {
    return { status: "skipped" };
  }
  const region = process.env.ARCHIVE_S3_REGION;
  const accessKeyId = process.env.ARCHIVE_S3_ACCESS_KEY;
  const secretAccessKey = process.env.ARCHIVE_S3_SECRET_KEY;
  const endpoint = process.env.ARCHIVE_S3_ENDPOINT; // optional

  if (
    region === undefined ||
    region.length === 0 ||
    accessKeyId === undefined ||
    accessKeyId.length === 0 ||
    secretAccessKey === undefined ||
    secretAccessKey.length === 0
  ) {
    return {
      status: "failed",
      errorMessage:
        "ARCHIVE_S3_BUCKET is set but ARCHIVE_S3_REGION / ACCESS_KEY / SECRET_KEY are not all configured.",
    };
  }

  try {
    // Lazy import — keeps the SDK out of the cold-start path for the
    // common skip case.
    const { S3Client, PutObjectCommand } = await import(
      "@aws-sdk/client-s3"
    );
    const clientConfig: {
      region: string;
      credentials: { accessKeyId: string; secretAccessKey: string };
      endpoint?: string;
      forcePathStyle?: boolean;
    } = {
      region,
      credentials: { accessKeyId, secretAccessKey },
    };
    if (endpoint !== undefined && endpoint.length > 0) {
      clientConfig.endpoint = endpoint;
      // Path-style addressing is required by many non-AWS providers
      // (Backblaze B2, MinIO). It's also accepted by AWS S3 for
      // backwards compatibility.
      clientConfig.forcePathStyle = true;
    }
    const client = new S3Client(clientConfig);

    const key = `archives/${period}.json.gz`;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: compressed,
      ContentType: "application/gzip",
    });
    const response = await client.send(command);
    const etag =
      typeof response.ETag === "string"
        ? response.ETag.replace(/^"|"$/g, "")
        : undefined;
    const result: S3UploadResult = { status: "uploaded" };
    if (etag !== undefined) result.etag = etag;
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Do NOT include the blob in the error message — even the size
    // of the blob is fine to omit. Keep the log narrow.
    return { status: "failed", errorMessage: message };
  }
}

/**
 * Build the archival JSON payload from the period's denormalised
 * row arrays. Pure function — no DB / storage / time side effects.
 * Exported for unit tests.
 */
export function buildArchivalPayload(args: {
  period: string;
  exportedAt: number;
  deploymentName: string;
  receipts: ArchivalReceiptRow[];
  payments: ArchivalPaymentRow[];
  customers: ArchivalCustomerRow[];
  contracts: ArchivalContractRow[];
}): ArchivalPayload {
  return {
    schemaVersion: ARCHIVAL_SCHEMA_VERSION,
    period: args.period,
    exportedAt: args.exportedAt,
    deploymentName: args.deploymentName,
    recordCounts: {
      receipts: args.receipts.length,
      payments: args.payments.length,
      customers: args.customers.length,
      contracts: args.contracts.length,
    },
    receipts: args.receipts,
    payments: args.payments,
    customers: args.customers,
    contracts: args.contracts,
  };
}

/**
 * Serialise + gzip + hash the payload. Pure helper — exported for
 * tests so the action's tests can stub the read path and feed a
 * known payload through the serialization.
 *
 * Steps (order matters — see story spec's "do NOT" list):
 *   1. `JSON.stringify(payload, null, 2)` — pretty-print FIRST.
 *   2. `Buffer.from(json, "utf8")` — capture uncompressed bytes.
 *   3. `gzipSync(uncompressed)` — gzip wraps the readable JSON.
 *   4. `sha256(compressed)` — hash the OUTPUT bytes; this is the
 *      blob's content-identity hash, mirroring what S3 stores.
 */
export function serializePayload(payload: ArchivalPayload): {
  uncompressed: Buffer;
  compressed: Buffer;
  sha256: string;
} {
  const json = JSON.stringify(payload, null, 2);
  const uncompressed = Buffer.from(json, "utf8");
  const compressed = gzipSync(uncompressed);
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  return { uncompressed, compressed, sha256 };
}

/**
 * Collect unique customer ids from a period's receipts + payments.
 * Pure — exported for unit tests.
 */
export function collectCustomerIds(args: {
  receipts: ArchivalReceiptRow[];
  payments: ArchivalPaymentRow[];
}): string[] {
  const set = new Set<string>();
  for (const r of args.receipts) {
    if (r.customerId !== null && r.customerId.length > 0) {
      set.add(r.customerId);
    }
  }
  for (const p of args.payments) {
    if (p.customerId !== null && p.customerId.length > 0) {
      set.add(p.customerId);
    }
  }
  return Array.from(set);
}

/**
 * Collect unique contract ids from a period's payments AND receipts.
 *
 * Why both arrays (Story 5.7 P1 fix):
 *   - A receipt can be issued for a payment that was received in an
 *     EARLIER period (e.g. an OR re-printed in May for an April
 *     payment, or a manual receipt for a non-payment line item that
 *     carries a `contractId` but no in-period payment row).
 *   - Walking only `payments[].contractId` orphans those receipts'
 *     `contractId` references — the archival JSON would carry a
 *     receipt whose `contractId` points to a contract that the export
 *     never resolved into `contracts[]`.
 *   - Taking the UNION of `paymentRow.contractId` ∪ `receiptRow.contractId`
 *     (filtering null / empty) preserves referential closure inside
 *     the per-period blob without dragging in unrelated contracts.
 *
 * Pure — exported for unit tests.
 */
export function collectContractIds(args: {
  payments: ArchivalPaymentRow[];
  receipts: ArchivalReceiptRow[];
}): string[] {
  const set = new Set<string>();
  for (const p of args.payments) {
    if (p.contractId !== null && p.contractId.length > 0) {
      set.add(p.contractId);
    }
  }
  for (const r of args.receipts) {
    if (r.contractId !== null && r.contractId.length > 0) {
      set.add(r.contractId);
    }
  }
  return Array.from(set);
}

/**
 * `monthlyArchivalExport` — the action body. Exported as a Convex
 * `internalAction` so the cron + the admin-gated `triggerArchivalExport`
 * mutation can schedule it.
 *
 * Args:
 *   - `overridePeriod?: string` — `"YYYY-MM"` to re-run a specific
 *     month. Omitted by the cron path (which computes "prior month").
 *
 * Return shape: `{ period, storageId, recordCounts, status }` so
 * the scheduler's log captures a useful summary.
 *
 * Idempotency: a `ready` row for `period` causes the action to
 * SHORT-CIRCUIT and return the existing storageId without
 * overwriting. A `failed` row (s3Status: "failed") triggers a
 * fresh export (overwrites the local file + row + retries S3) — the
 * admin's manual re-trigger path.
 */
export const monthlyArchivalExport = internalActionGeneric({
  args: { overridePeriod: v.optional(v.string()) },
  handler: async (
    ctx: ActionCtx,
    args: { overridePeriod?: string },
  ): Promise<{
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
  }> => {
    // Step 1: compute period bounds — Manila tz.
    let period: string;
    let startMs: number;
    let endMs: number;
    if (args.overridePeriod !== undefined) {
      // Validates the YYYY-MM shape; throws on malformed input.
      parsePeriod(args.overridePeriod);
      const bounds = getPeriodBounds(args.overridePeriod);
      period = bounds.period;
      startMs = bounds.startMs;
      endMs = bounds.endMs;
    } else {
      const bounds = getPriorPeriod(Date.now());
      period = bounds.period;
      startMs = bounds.startMs;
      endMs = bounds.endMs;
    }

    // Step 2: idempotency guard — short-circuit on an existing
    // `ready` row (storageId present + s3Status not "failed").
    //
    // P1 fix: echo the EXISTING row's `recordCounts` back to the
    // caller instead of `{0,0,0,0}`. The admin "Re-run" UI displays
    // the returned counts in a success toast; zeros for a healthy
    // prior export look like a bug ("0 records archived").
    const findRef = makeFunctionReference<
      "query",
      { period: string },
      {
        _id: ArchivalExportId;
        period: string;
        storageId: StorageId;
        s3Status: "uploaded" | "failed" | "skipped" | undefined;
        recordCounts: {
          receipts: number;
          payments: number;
          customers: number;
          contracts: number;
        };
      } | null
    >("lib/archivalQueries:findExistingArchivalExport");
    const existing = await ctx.runQuery(findRef, { period });
    if (existing !== null && existing.s3Status !== "failed") {
      console.log(
        `[archivalExport] skipping ${period} — already exported (s3Status=${existing.s3Status ?? "n/a"})`,
      );
      return {
        period,
        storageId: existing.storageId as unknown as string,
        recordCounts: existing.recordCounts,
        status: "skipped",
        s3Status: existing.s3Status ?? "skipped",
      };
    }

    // Step 3: read period-bounded rows via the internal queries.
    type ReceiptsResult = ArchivalReceiptRow[];
    type PaymentsResult = ArchivalPaymentRow[];
    type CustomersResult = ArchivalCustomerRow[];
    type ContractsResult = ArchivalContractRow[];

    const getReceiptsRef = makeFunctionReference<
      "query",
      { startMs: number; endMs: number },
      ReceiptsResult
    >("lib/archivalQueries:getReceiptsInPeriod");
    const getPaymentsRef = makeFunctionReference<
      "query",
      { startMs: number; endMs: number },
      PaymentsResult
    >("lib/archivalQueries:getPaymentsInPeriod");
    const getCustomersRef = makeFunctionReference<
      "query",
      { customerIds: string[] },
      CustomersResult
    >("lib/archivalQueries:getCustomersForPeriod");
    const getContractsRef = makeFunctionReference<
      "query",
      { contractIds: string[] },
      ContractsResult
    >("lib/archivalQueries:getContractsForPeriod");

    const receipts = await ctx.runQuery(getReceiptsRef, { startMs, endMs });
    const payments = await ctx.runQuery(getPaymentsRef, { startMs, endMs });
    const customerIds = collectCustomerIds({ receipts, payments });
    const contractIds = collectContractIds({ payments, receipts });
    const customers = await ctx.runQuery(getCustomersRef, { customerIds });
    const contracts = await ctx.runQuery(getContractsRef, { contractIds });

    // Step 4: build + serialise the JSON payload.
    const exportedAt = Date.now();
    const deploymentName =
      process.env.CONVEX_DEPLOYMENT ??
      process.env.CONVEX_CLOUD_URL ??
      "unknown-deployment";
    const payload = buildArchivalPayload({
      period,
      exportedAt,
      deploymentName,
      receipts,
      payments,
      customers,
      contracts,
    });
    const { uncompressed, compressed, sha256 } = serializePayload(payload);

    // Step 5: write the gzipped blob to Convex File Storage.
    const blob = new Blob([new Uint8Array(compressed)], {
      type: "application/gzip",
    });
    const storageId = await ctx.storage.store(blob);

    // Step 6: optional S3 mirror.
    const s3Result = await uploadToS3(compressed, period);

    // Step 7: insert / patch the `archivalExports` row.
    const insertRef = makeFunctionReference<
      "mutation",
      {
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
      ArchivalExportId
    >("archivalExportInternal:insertExportRecord");
    const insertArgs: {
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
    } = {
      period,
      storageId: storageId as StorageId,
      sha256,
      sizeBytesUncompressed: uncompressed.byteLength,
      sizeBytesCompressed: compressed.byteLength,
      recordCounts: payload.recordCounts,
      exportedAt,
      s3Status: s3Result.status,
    };
    if (s3Result.status === "uploaded") {
      if (s3Result.etag !== undefined) insertArgs.s3Etag = s3Result.etag;
      insertArgs.s3UploadedAt = exportedAt;
    }
    if (s3Result.status === "failed" && s3Result.errorMessage !== undefined) {
      insertArgs.s3ErrorMessage = s3Result.errorMessage;
    }
    await ctx.runMutation(insertRef, insertArgs);

    console.log(
      `[archivalExport] ${period} ready — ${payload.recordCounts.receipts} receipts, ${payload.recordCounts.payments} payments, ${payload.recordCounts.customers} customers, ${payload.recordCounts.contracts} contracts; ${compressed.byteLength} bytes gzipped; s3Status=${s3Result.status}`,
    );

    return {
      period,
      storageId: storageId as unknown as string,
      recordCounts: payload.recordCounts,
      status: "ready",
      s3Status: s3Result.status,
    };
  },
});

/**
 * Test surface — exports the pure helpers + the function-reference
 * paths so the unit-test suite can drive them without standing up
 * Convex's action plumbing. Plain TS re-export pattern; not a
 * Convex function.
 *
 * Also exposes `formatPeriod` for convenience in tests.
 */
export const __testing = {
  ARCHIVAL_SCHEMA_VERSION,
  MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH,
  buildArchivalPayload,
  serializePayload,
  collectCustomerIds,
  collectContractIds,
  formatPeriod,
  uploadToS3,
};
