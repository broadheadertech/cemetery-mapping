"use node";

/**
 * Demand-letter PDF generation action (Story 6.2, FR50).
 *
 * Sibling of `convex/actions/generateContractPdf.ts` (Story 6.1) — same
 * Node-runtime + PDFKit infrastructure, same callback shape into an
 * internal mutation that records `demandLetterStorageId` /
 * `demandLetterGeneratedAt` on the contract row. The only differences
 * are the layout (single-page formal letter rather than a multi-page
 * contract) and the eligibility gate (the scheduling mutation in
 * `convex/contracts.ts:generateDemandLetterRequest` rejects unless the
 * contract has at least one overdue installment — server-side gate per
 * NFR-S4, not just UI).
 *
 * Why an action (not a mutation):
 *   - PDFKit is Node-only and cannot be imported from the V8 runtime.
 *     The `"use node"` directive on line 1 opts this file into the Node
 *     runtime; the V8-runtime mutation builds a `makeFunctionReference`
 *     pointing at the path string below and schedules the action via
 *     `ctx.scheduler.runAfter(0, ...)` so the mutation's transaction
 *     commits before the heavyweight render begins.
 *
 * Story scope deviation from the spec's `contractDocuments` table:
 *   The story spec proposed a versioned child table shared with Story
 *   6.1. Per the system-message file-ownership list, this story persists
 *   the latest demand-letter blob inline on the contract row
 *   (`demandLetterStorageId` + `demandLetterGeneratedAt`) — the same
 *   simplification Story 6.1 made for the contract PDF. Regeneration
 *   overwrites both fields; prior blobs are NOT retained. A future story
 *   may promote both PDF surfaces to a single versioned child table.
 *
 * Reuse of Story 3.11 BIR formatters / Story 6.1 patterns:
 *   The peso / date / address helpers in `convex/lib/birFormat.ts` are
 *   the shared formatting primitives. The cemetery address /
 *   registered-name come from `PLACEHOLDER_BIR_CONFIG` until §10 Q3
 *   resolves; `BIR_CONFIG_IS_PLACEHOLDER` gates a footer notice on the
 *   rendered letter so an auditor can tell at a glance whether the
 *   document used the locked or placeholder template.
 *
 * Phase 2 reservation — template language:
 *   The demand-letter body language in this file is intentionally
 *   conservative boilerplate. Per Story 6.2 disaster prevention, the
 *   cemetery's legal counsel reviews and signs off on the final
 *   template at Phase 2 kickoff before any letter is actually sent.
 *   Do NOT invent more aggressive language here.
 *
 * Failure model:
 *   Mirrors the contract-PDF action — actions are at-most-once per the
 *   Convex scheduler contract; the body wraps the render+store path in
 *   a try/reject inside the Buffer promise and re-throws on failure so
 *   Convex's action-error surface picks it up. The scheduling mutation
 *   does NOT roll back on action failure (action errors are out-of-band
 *   by design). The UI inspects `demandLetterStorageId === undefined`
 *   to detect "PDF never produced" and offers a "Retry generation"
 *   button.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  internalActionGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import PDFKitDocument from "pdfkit";

import schema from "../schema";
import {
  BIR_CONFIG_IS_PLACEHOLDER,
  formatIssuedDate,
  formatPesoAmount,
  PLACEHOLDER_BIR_CONFIG,
} from "../lib/birFormat";
import {
  BRAND,
  drawLetterhead,
  drawSignOff,
} from "../lib/brandAssets";
import { DAY_MS } from "../lib/time";
// The internal query/mutations this action calls live in a V8-runtime
// sibling module (`convex/generateDemandLetterPdfInternal.ts`) — Convex
// forbids defining queries/mutations in a `"use node"` file. `import
// type` is erased at bundle time, so the Node bundle never pulls those
// V8 definitions in.
import type { DemandLetterRenderPayload } from "../generateDemandLetterPdfInternal";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type StorageId = DataModel["customerDocuments"]["document"]["storageId"];
type ActionCtx = GenericActionCtx<DataModel>;

/**
 * Number of days (from issuance) the customer has to remit payment
 * before the cemetery considers escalation. Stamped on the rendered
 * letter; configurable here for a future Phase 2 admin-editable
 * settings surface (out of scope for this story). 30 days is the
 * conservative default per the story spec's example wording.
 */
const DEMAND_PAYMENT_WINDOW_DAYS = 30;

/**
 * Function reference path for the action itself — used by the public
 * mutation in `convex/contracts.ts` to schedule a run. The mutation
 * builds a `makeFunctionReference` against this path so the V8-runtime
 * file doesn't have to `import` from this Node-runtime module
 * (cross-runtime imports leak Node-only deps like PDFKit into the V8
 * bundle and break the build — see the contract PDF action's matching
 * constant for the long-form rationale).
 */
export const GENERATE_DEMAND_LETTER_PDF_FUNCTION_PATH =
  "actions/generateDemandLetterPdf:run";

/**
 * Function reference path for the internal query the action calls to
 * hydrate its render payload.
 */
export const GET_CONTRACT_FOR_DEMAND_LETTER_RENDER_FUNCTION_PATH =
  "generateDemandLetterPdfInternal:_getContractForDemandLetterRender";

/**
 * Function reference path for the internal mutation the action calls
 * to record the freshly-stored blob id on the contract row.
 */
export const RECORD_DEMAND_LETTER_PDF_READY_FUNCTION_PATH =
  "generateDemandLetterPdfInternal:_recordDemandLetterPdfReady";

/**
 * Function-reference paths for the failed-state callback + retry-count
 * bump. Exposed so the cron + action error handler can resolve them.
 */
export const RECORD_DEMAND_LETTER_PDF_FAILED_FUNCTION_PATH =
  "generateDemandLetterPdfInternal:_recordDemandLetterPdfFailed";
export const BUMP_DEMAND_LETTER_RETRY_COUNT_FUNCTION_PATH =
  "generateDemandLetterPdfInternal:_bumpDemandLetterRetryCount";

/**
 * Renders the demand-letter PDF body into a PDFKit document. Pure
 * layout — no side effects, takes the payload and the PDFKit doc and
 * writes a single page. Extracted from the action handler so the unit
 * tests can drive PDFKit with a stub payload and assert non-empty
 * output without spinning up the action plumbing.
 *
 * Layout (single LETTER page top-to-bottom):
 *   1. Centered cemetery letterhead block.
 *   2. Right-aligned issuance date (Manila tz, long form).
 *   3. Left-aligned addressee block (customer name + address).
 *   4. RE: reference line (contract number + lot code).
 *   5. Polite salutation.
 *   6. Overdue summary paragraph + itemised list.
 *   7. Demand for payment within `DEMAND_PAYMENT_WINDOW_DAYS` days.
 *   8. Payment-instructions paragraph (placeholder — Phase 2 kickoff
 *      legal-counsel review).
 *   9. Closing + signature line for a cemetery officer.
 *  10. Footer notice keyed off `BIR_CONFIG_IS_PLACEHOLDER`.
 */
function renderDemandLetterPdf(
  doc: InstanceType<typeof PDFKitDocument>,
  payload: DemandLetterRenderPayload,
): void {
  // --- 1. Brand letterhead (mark + wordmark + corporate ID + gold rule) ---
  drawLetterhead(doc, {
    marginLeft: 72,
    marginRight: 72,
    top: 50,
    pageWidth: 612,
  });

  // --- 2. Right-aligned issuance date (mono, moss tone) ---
  doc.font("Courier").fontSize(9).fillColor(BRAND.moss);
  doc.text(formatIssuedDate(payload.generatedAt).toUpperCase(), 72, doc.y, {
    width: 612 - 144,
    align: "right",
    characterSpacing: 1,
  });
  doc.fillColor(BRAND.ink);
  doc.moveDown(2);

  // --- 3. Addressee block (serif body) ---
  doc.font("Times-Roman").fontSize(11).fillColor(BRAND.ink);
  doc.text(payload.customerFullName, 72);
  for (const line of payload.customerAddressLines) {
    doc.text(line);
  }
  doc.moveDown(1);

  // --- 4. RE: reference line (mono small-caps, moss) ---
  doc.font("Courier").fontSize(9).fillColor(BRAND.moss);
  doc.text(
    `RE · CONTRACT ${payload.contractNumber} · LOT ${payload.lotCode}`,
    72,
    doc.y,
    { characterSpacing: 0.8 },
  );
  doc.text(
    `   SECTION ${payload.lotSection} · BLOCK ${payload.lotBlock} · ROW ${payload.lotRow}`,
    72,
    doc.y,
    { characterSpacing: 0.8 },
  );
  doc.fillColor(BRAND.ink);
  doc.moveDown(1.2);

  // --- 5. Salutation (serif, ceremonial) ---
  doc.font("Times-Roman").fontSize(11).fillColor(BRAND.ink);
  doc.text(`Dear ${payload.customerFullName},`, 72);
  doc.moveDown(0.75);

  // --- 6. Compassionate brand-voice body ---
  // First paragraph: the regret + the specific overdue summary.
  // Phrasing follows the spec's template — gentle reminder framing,
  // "the estate continues to hold your place" reassurance.
  const oldestDueStr = formatIssuedDate(payload.oldestMissedDate);
  const totalStr = formatPesoAmount(payload.totalOverdueCents);
  doc.font("Times-Roman").fontSize(11);
  doc.text(
    `The Estate Office writes with regret to note that the installment of ` +
      `${totalStr} for lot ${payload.lotCode}, due ${oldestDueStr}, has not ` +
      `yet been settled. The estate continues to hold your place; we trust ` +
      `this notice serves only as a gentle reminder.`,
    72,
    doc.y,
    { width: 612 - 144, align: "justify" },
  );
  doc.moveDown(0.75);

  // --- 7. Itemised overdue list (mono, moss) — kept brief; the spec's
  // body copy mentions the single oldest installment, but the list
  // remains useful for families with multiple missed payments.
  doc.font("Courier").fontSize(9).fillColor(BRAND.forest);
  for (const row of payload.overdueInstallments) {
    const remaining = row.principalCents - row.paidCents;
    doc.text(
      `   · INSTALLMENT ${row.installmentNumber} · DUE ${formatIssuedDate(row.dueDate).toUpperCase()} · ${formatPesoAmount(remaining)}`,
      72,
      doc.y,
      { width: 612 - 144, characterSpacing: 0.6 },
    );
  }
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.75);

  // --- 8. Consultant offer paragraph (brand voice) ---
  const consultant =
    payload.consultantName !== undefined &&
      payload.consultantName.trim().length > 0
      ? payload.consultantName
      : "the Estate Office";
  doc.font("Times-Roman").fontSize(11);
  doc.text(
    `Should circumstance be the cause, please write or call at any hour. ` +
      `Memorial estate consultant ${consultant} stands ready to discuss ` +
      `arrangements that honour both the family's situation and the lot's ` +
      `holding.`,
    72,
    doc.y,
    { width: 612 - 144, align: "justify" },
  );
  doc.moveDown(0.75);

  // --- 9. Closing notice with grace-period date ---
  // The grace-end date is computed at render time from `generatedAt +
  // DEMAND_PAYMENT_WINDOW_DAYS`. Keeping the arithmetic inside the
  // renderer (rather than the action) means the unit-test fixture can
  // assert against deterministic output.
  const graceEndDate = formatIssuedDate(
    payload.generatedAt + DEMAND_PAYMENT_WINDOW_DAYS * DAY_MS,
  );
  doc.font("Times-Roman").fontSize(11);
  doc.text(
    `If settlement remains absent by ${graceEndDate}, the estate must ` +
      `regrettably consider its further course.`,
    72,
    doc.y,
    { width: 612 - 144, align: "justify" },
  );
  doc.moveDown(2);

  // --- 10. Ceremonial sign-off block ---
  drawSignOff(doc, {
    rightX: 540,
    top: doc.y,
    width: 240,
  });
  doc.moveDown(2);

  // --- 11. Footer notice (placeholder template flag) ---
  doc.font("Times-Italic").fontSize(7).fillColor(BRAND.moss);
  doc.text(
    `Format version: ${PLACEHOLDER_BIR_CONFIG.formatVersion}${
      BIR_CONFIG_IS_PLACEHOLDER
        ? " — template pending legal-counsel review (Phase 2 kickoff)."
        : ""
    }`,
    72,
    762,
    { width: 612 - 144, align: "left" },
  );
  doc.fillColor(BRAND.ink);
}

/**
 * Action body — orchestrates the read, render, store, callback flow.
 * Exported as `run` so the function path is
 * `actions/generateDemandLetterPdf:run`.
 *
 * Auth note: the originating mutation
 * (`generateDemandLetterRequest` in `convex/contracts.ts`) already
 * gated on `["admin", "office_staff"]` AND verified the contract has
 * overdue installments. This action has no user context (scheduled via
 * `runAfter`); the internal-only nature plus the scheduler's "only
 * schedulable from a mutation that has already authenticated" path is
 * the gate.
 */
export const run = internalActionGeneric({
  args: {
    contractId: v.id("contracts"),
  },
  handler: async (
    ctx: ActionCtx,
    args: { contractId: ContractId },
  ): Promise<{ storageId: string }> => {
    // Epic-3/4 adversarial-review HIGH fix — wrap the entire body so
    // any failure path lands a `demandLetterStatus: "failed"` patch
    // before re-throwing. The retry-sweep cron then picks the row up
    // on its next pass (provided demandLetterRetryCount < 3).
    try {
      // Step 1: load the render payload via the internal query. We
      // stamp `generatedAt` HERE (not inside the query) so it matches
      // what the callback mutation writes to the row and the renderer
      // prints on the letter.
      const generatedAt = Date.now();
      const getRef = makeFunctionReference<
        "query",
        { contractId: ContractId; generatedAt: number },
        DemandLetterRenderPayload
      >(GET_CONTRACT_FOR_DEMAND_LETTER_RENDER_FUNCTION_PATH);
      const payload = await ctx.runQuery(getRef, {
        contractId: args.contractId,
        generatedAt,
      });

      // Step 2: render the PDF into a Buffer. CreationDate is derived
      // from the contract row's `_creationTime` (deterministic across
      // regenerations) per the HIGH fix.
      const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFKitDocument({
          size: "LETTER",
          margin: 72,
          info: {
            Title: `Demand letter — Contract ${payload.contractNumber}`,
            Author: PLACEHOLDER_BIR_CONFIG.registeredName,
            Subject: "Demand for payment — overdue interment-lot contract",
            Creator: "Cemetery Mapping",
            CreationDate: new Date(payload.contractCreationTime),
          },
        });
        const chunks: Buffer[] = [];
        doc.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        doc.on("end", () => {
          resolve(Buffer.concat(chunks));
        });
        doc.on("error", (err: unknown) => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        try {
          renderDemandLetterPdf(doc, payload);
          doc.end();
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // Step 3: store the blob in Convex File Storage.
      const blob = new Blob([new Uint8Array(pdfBuffer)], {
        type: "application/pdf",
      });
      const storageId = await ctx.storage.store(blob);

      // Step 4: callback into the internal mutation to record the blob
      // pointer + flip demandLetterStatus to "ready".
      const recordRef = makeFunctionReference<
        "mutation",
        {
          contractId: ContractId;
          storageId: StorageId;
          generatedAt: number;
        },
        void
      >(RECORD_DEMAND_LETTER_PDF_READY_FUNCTION_PATH);
      await ctx.runMutation(recordRef, {
        contractId: args.contractId,
        storageId: storageId as StorageId,
        generatedAt,
      });

      return { storageId: storageId as string };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      try {
        const failedRef = makeFunctionReference<
          "mutation",
          { contractId: ContractId; errorMessage: string },
          void
        >(RECORD_DEMAND_LETTER_PDF_FAILED_FUNCTION_PATH);
        await ctx.runMutation(failedRef, {
          contractId: args.contractId,
          errorMessage,
        });
      } catch {
        // Best-effort — surfacing the original error is more important
        // than the bookkeeping miss.
      }
      throw err;
    }
  },
});

/**
 * Test helper — exposes the pure render function so the unit-test suite
 * can drive PDFKit with a stub payload and assert non-empty output
 * without spinning up the action plumbing. NOT a public Convex
 * function (no `args` / `handler` wrapper) — plain TypeScript export.
 */
export const __testing = {
  renderDemandLetterPdf,
  DEMAND_PAYMENT_WINDOW_DAYS,
  GENERATE_DEMAND_LETTER_PDF_FUNCTION_PATH,
  GET_CONTRACT_FOR_DEMAND_LETTER_RENDER_FUNCTION_PATH,
  RECORD_DEMAND_LETTER_PDF_READY_FUNCTION_PATH,
};
