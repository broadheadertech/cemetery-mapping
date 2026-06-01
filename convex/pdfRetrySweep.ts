/**
 * PDF retry sweep — Epic-3/4 adversarial-review HIGH fix.
 *
 * Centralised internal-mutation entry point the daily cron in
 * `convex/crons.ts` invokes to re-attempt PDF generations that landed
 * in `pending` (action dropped without writeback) or `failed` (action
 * threw and the failed-state callback patched the row) status.
 *
 * Surfaces (one sweep per PDF kind so a single misbehaving surface
 * doesn't starve the others):
 *
 *   - `internal_sweepContractPdfs`     — Story 6.1 contract PDFs.
 *   - `internal_sweepDemandLetterPdfs` — Story 6.2 demand-letter PDFs.
 *   - `internal_sweepReceiptPdfs`      — Story 3.13 receipt PDFs.
 *
 * Each sweep walks the relevant status index (`by_pdfStatus` /
 * `by_demandLetterStatus`) for rows in `pending` or `failed` status,
 * filters out rows that have already exhausted the per-row retry
 * cap (3), bumps the retry counter via the row's domain mutation,
 * then schedules the renderer action via `ctx.scheduler.runAfter(0,
 * ...)`. Rows past the cap STAY in `failed` status with the prior
 * `pdfLastError`; the UI surfaces a "Manual intervention required"
 * affordance for operators.
 *
 * Why a separate file vs. the domain files:
 *   - The sweep is a cron-driven concern; the domain files own the
 *     direct user-facing surface. Keeping the sweep separate lets the
 *     cron registration import a thin, focused entry point and makes
 *     the retry-cap policy easy to audit.
 *   - The schema indices the sweep uses (`by_pdfStatus`,
 *     `by_demandLetterStatus`) are added in `convex/schema.ts`
 *     alongside the lifecycle fields the sweep reads.
 *
 * Cron cadence (registered in `convex/crons.ts`):
 *   - Every 10 minutes. PDF generation is operator-driven and
 *     latency-sensitive (the operator wants the download link
 *     promptly); 10 minutes is the sweet spot between "fast enough
 *     to recover from a transient failure within the same admin
 *     session" and "infrequent enough to not stampede the action
 *     queue on a sustained outage."
 *
 * Per-row retry cap: 3. After 3 failed attempts the row stays in
 * `failed` and the cron skips it. Operators can manually retry via
 * the public `generateContractPdfRequest` / etc. mutations, which
 * reset the counter back to 0 when called with a fresh idempotency
 * key.
 */

import {
  internalMutationGeneric,
  makeFunctionReference,
  type DataModelFromSchemaDefinition,
} from "convex/server";

import schema from "./schema";
import { type MutationCtx } from "./lib/auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type ReceiptId = DataModel["receipts"]["document"]["_id"];
type PlaqueDraftId = DataModel["plaqueDrafts"]["document"]["_id"];

/** Per-row retry cap. After this many failures the cron skips the row. */
const MAX_PDF_RETRIES = 3;

/**
 * Action paths the sweeps re-schedule. Resolved via
 * `makeFunctionReference` rather than the codegen `_generated/api`
 * import — matches the convention the rest of `convex/` uses.
 */
const GENERATE_CONTRACT_PDF_PATH = "actions/generateContractPdf:run";
const GENERATE_DEMAND_LETTER_PDF_PATH = "actions/generateDemandLetterPdf:run";
const GENERATE_RECEIPT_PDF_PATH =
  "actions/generateReceiptPdf:generateReceiptPdf";
// Story 6.8 — memorial plaque PDF retry sweep.
const GENERATE_PLAQUE_DRAFT_PDF_PATH =
  "actions/generatePlaquePdf:runForDraft";

/**
 * Retry-bump mutation paths. Each kind's domain file exposes a small
 * internal mutation that bumps the retry counter + flips status back
 * to `pending` so the sweep can schedule the action against a
 * consistent row state.
 */
const BUMP_CONTRACT_PDF_RETRY_PATH =
  "generateContractPdfInternal:_bumpContractPdfRetryCount";
const BUMP_DEMAND_LETTER_RETRY_PATH =
  "generateDemandLetterPdfInternal:_bumpDemandLetterRetryCount";
const BUMP_RECEIPT_PDF_RETRY_PATH = "receipts:bumpReceiptPdfRetryCount";
// Story 6.8 — plaque-draft retry-bump entry. Lives in
// `convex/plaqueDrafts.ts` (V8 runtime) for the same `ctx.db` reasons
// the other domain files own their own bump helpers.
const BUMP_PLAQUE_DRAFT_RETRY_PATH =
  "plaqueDrafts:_bumpPlaqueDraftRetryCount";

/**
 * Sweep the `contracts` table for PDF generations that need re-attempt.
 * Reads `by_pdfStatus` for `pending` AND `failed`; filters out rows
 * past the retry cap; bumps the counter; schedules the action.
 */
export const internal_sweepContractPdfs = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ retried: number; skipped: number }> => {
    const failed = await ctx.db
      .query("contracts")
      .withIndex("by_pdfStatus", (q) => q.eq("pdfStatus", "failed"))
      .collect();
    const pending = await ctx.db
      .query("contracts")
      .withIndex("by_pdfStatus", (q) => q.eq("pdfStatus", "pending"))
      .collect();
    const candidates = [...failed, ...pending];
    let retried = 0;
    let skipped = 0;
    const actionRef = makeFunctionReference<
      "action",
      { contractId: ContractId },
      { storageId: string }
    >(GENERATE_CONTRACT_PDF_PATH);
    const bumpRef = makeFunctionReference<
      "mutation",
      { contractId: ContractId },
      { retryCount: number }
    >(BUMP_CONTRACT_PDF_RETRY_PATH);
    for (const row of candidates) {
      if ((row.pdfRetryCount ?? 0) >= MAX_PDF_RETRIES) {
        skipped += 1;
        continue;
      }
      try {
        // Schedule the bump as an internal mutation that runs BEFORE
        // the action via the scheduler queue (both are inserted with
        // `runAfter(0, ...)` and the bump is queued first). Doing
        // them in this order keeps the bump + action paired so a
        // dropped action doesn't leave the counter under-incremented.
        await ctx.scheduler.runAfter(0, bumpRef, { contractId: row._id });
        await ctx.scheduler.runAfter(0, actionRef, { contractId: row._id });
        retried += 1;
      } catch (err) {
        console.error(
          "[pdfRetrySweep] contract skip",
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
 * Sweep the `contracts` table for demand-letter generations that need
 * re-attempt. Mirrors the contract-PDF sweep against the
 * `by_demandLetterStatus` index.
 */
export const internal_sweepDemandLetterPdfs = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ retried: number; skipped: number }> => {
    const failed = await ctx.db
      .query("contracts")
      .withIndex("by_demandLetterStatus", (q) =>
        q.eq("demandLetterStatus", "failed"),
      )
      .collect();
    const pending = await ctx.db
      .query("contracts")
      .withIndex("by_demandLetterStatus", (q) =>
        q.eq("demandLetterStatus", "pending"),
      )
      .collect();
    const candidates = [...failed, ...pending];
    let retried = 0;
    let skipped = 0;
    const actionRef = makeFunctionReference<
      "action",
      { contractId: ContractId },
      { storageId: string }
    >(GENERATE_DEMAND_LETTER_PDF_PATH);
    const bumpRef = makeFunctionReference<
      "mutation",
      { contractId: ContractId },
      { retryCount: number }
    >(BUMP_DEMAND_LETTER_RETRY_PATH);
    for (const row of candidates) {
      if ((row.demandLetterRetryCount ?? 0) >= MAX_PDF_RETRIES) {
        skipped += 1;
        continue;
      }
      try {
        await ctx.scheduler.runAfter(0, bumpRef, { contractId: row._id });
        await ctx.scheduler.runAfter(0, actionRef, { contractId: row._id });
        retried += 1;
      } catch (err) {
        console.error(
          "[pdfRetrySweep] demand-letter skip",
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
 * Sweep the `plaqueDrafts` table for memorial plaque PDF generations
 * that need re-attempt (Story 6.8). Mirrors the contract / demand-
 * letter sweeps against the `plaqueDrafts.by_status` index.
 *
 * Per-row retry cap (`MAX_PDF_RETRIES = 3`) matches the other PDF
 * surfaces; rows past the cap stay `failed` and require an admin
 * "Retry" click via the plaque-page draft-history rail
 * (`plaqueDrafts:retryPlaqueDraft`).
 */
export const internal_sweepPlaqueDraftPdfs = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ retried: number; skipped: number }> => {
    const failed = await ctx.db
      .query("plaqueDrafts")
      .withIndex("by_status", (q) => q.eq("pdfStatus", "failed"))
      .collect();
    const pending = await ctx.db
      .query("plaqueDrafts")
      .withIndex("by_status", (q) => q.eq("pdfStatus", "pending"))
      .collect();
    const candidates = [...failed, ...pending];
    let retried = 0;
    let skipped = 0;
    // The plaque action's full arg shape requires the draft's render
    // payload (name + years + format + epitaph); the sweep reads each
    // row to forward those into the scheduler. The bump helper flips
    // status back to `pending` first so the action sees consistent
    // row state.
    const actionRef = makeFunctionReference<
      "action",
      {
        plaqueDraftId: PlaqueDraftId;
        deceasedName: string;
        bornYear: number;
        diedYear: number;
        dateFormat: "arabic" | "roman";
        epitaph?: string;
      },
      { storageId: string }
    >(GENERATE_PLAQUE_DRAFT_PDF_PATH);
    const bumpRef = makeFunctionReference<
      "mutation",
      { plaqueDraftId: PlaqueDraftId },
      { retryCount: number }
    >(BUMP_PLAQUE_DRAFT_RETRY_PATH);
    for (const row of candidates) {
      if (row.retryCount >= MAX_PDF_RETRIES) {
        skipped += 1;
        continue;
      }
      try {
        await ctx.scheduler.runAfter(0, bumpRef, {
          plaqueDraftId: row._id,
        });
        const scheduleArgs: {
          plaqueDraftId: PlaqueDraftId;
          deceasedName: string;
          bornYear: number;
          diedYear: number;
          dateFormat: "arabic" | "roman";
          epitaph?: string;
        } = {
          plaqueDraftId: row._id,
          deceasedName: row.deceasedName,
          bornYear: row.bornYear,
          diedYear: row.diedYear,
          dateFormat: row.dateFormat,
        };
        if (row.epitaph !== undefined) {
          scheduleArgs.epitaph = row.epitaph;
        }
        await ctx.scheduler.runAfter(0, actionRef, scheduleArgs);
        retried += 1;
      } catch (err) {
        console.error(
          "[pdfRetrySweep] plaque skip",
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
 * Sweep the `receipts` table for PDF generations that need re-attempt.
 * Same shape as the contract sweeps; uses the
 * `receipts.by_pdfStatus` index.
 */
export const internal_sweepReceiptPdfs = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ retried: number; skipped: number }> => {
    const failed = await ctx.db
      .query("receipts")
      .withIndex("by_pdfStatus", (q) => q.eq("pdfStatus", "failed"))
      .collect();
    const pending = await ctx.db
      .query("receipts")
      .withIndex("by_pdfStatus", (q) => q.eq("pdfStatus", "pending"))
      .collect();
    const candidates = [...failed, ...pending];
    let retried = 0;
    let skipped = 0;
    const actionRef = makeFunctionReference<
      "action",
      { receiptId: ReceiptId; forceRegenerate?: boolean },
      { storageId: string; generatedAt: number } | null
    >(GENERATE_RECEIPT_PDF_PATH);
    const bumpRef = makeFunctionReference<
      "mutation",
      { receiptId: ReceiptId },
      { retryCount: number }
    >(BUMP_RECEIPT_PDF_RETRY_PATH);
    for (const row of candidates) {
      if ((row.pdfRetryCount ?? 0) >= MAX_PDF_RETRIES) {
        skipped += 1;
        continue;
      }
      try {
        await ctx.scheduler.runAfter(0, bumpRef, { receiptId: row._id });
        await ctx.scheduler.runAfter(0, actionRef, { receiptId: row._id });
        retried += 1;
      } catch (err) {
        console.error(
          "[pdfRetrySweep] receipt skip",
          row._id,
          (err as Error).message,
        );
        skipped += 1;
      }
    }
    return { retried, skipped };
  },
});
