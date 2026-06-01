"use node";

/**
 * Contract PDF generation action (Story 6.1, FR49).
 *
 * Node-runtime Convex action that renders an installment-contract PDF
 * with PDFKit and stores the resulting blob in Convex File Storage. The
 * public mutation `contracts.generateContractPdfRequest` (this story's
 * paired entry point in `convex/contracts.ts`) schedules this action via
 * `ctx.scheduler.runAfter(0, ...)` so the V8-runtime mutation transaction
 * commits before the heavyweight Node-runtime work begins.
 *
 * Why an action (not a mutation):
 *   - PDFKit is Node-only. The default Convex V8 runtime cannot import
 *     it without bundling failures. The `"use node"` directive on line 1
 *     opts this file into Convex's Node runtime.
 *   - PDFKit produces a Buffer; `ctx.storage.store(...)` accepts a
 *     `Blob` (web standard). Node 18+ has a global `Blob` constructor.
 *   - Actions can't write to the DB directly — they call back into
 *     internal mutations (`_recordContractPdfReady`) to record the
 *     resulting `storageId` + `pdfGeneratedAt` on the contract row.
 *
 * Story scope deviation from the spec's `contractDocuments` table:
 *   The story spec proposed a versioned child table. Per the system
 *   message file-ownership list, this story persists the latest PDF
 *   blob pointer inline on the `contracts` row (`pdfStorageId` +
 *   `pdfGeneratedAt`). Regeneration overwrites both fields; prior
 *   blobs are NOT retained. A future story may promote this to a
 *   versioned child table without changing the action's contract — the
 *   action simply receives a different `documentRowId` to call back
 *   against. Phase-2 reservation noted in the dev-agent record.
 *
 * Reuse of Story 3.11 BIR formatters:
 *   The `formatPesoAmount`, `formatTin`, `formatAddressLines`,
 *   `formatIssuedDate`, and `formatPesoInWords` helpers in
 *   `convex/lib/birFormat.ts` are the shared formatting primitives.
 *   Money is centavos in / peso glyphs out; the cemetery address is
 *   from `PLACEHOLDER_BIR_CONFIG` until §10 Q3 resolves with real BIR
 *   details. The `BIR_CONFIG_IS_PLACEHOLDER` flag drives a footer note
 *   on the PDF so an auditor can tell at a glance whether the rendered
 *   contract used the locked or placeholder template.
 *
 * Failure model:
 *   Action failures are NOT retried automatically by Convex (actions
 *   are at-most-once per the scheduler.d.ts contract). The action wraps
 *   the entire body in a try/catch so a PDFKit / storage / runtime
 *   failure does not leave the contract row in a half-updated state —
 *   the catch logs the error and re-throws so Convex's action-error
 *   surface picks it up. The mutation that scheduled the action does
 *   NOT roll back on action failure (action errors are out-of-band by
 *   design). The UI inspects `pdfStorageId === undefined` to detect
 *   "PDF never produced" and offers a "Retry generation" button.
 *
 * NOT in scope for this story:
 *   - Versioned PDF history (one `pdfStorageId` per contract — see
 *     spec deviation above).
 *   - Email side-channel (Story 3.13 receipt-email pattern; not wired
 *     for contracts in Phase 2 kickoff).
 *   - Scheduled retry cron (would require `convex/scheduled.ts` which
 *     this story is not allowed to touch).
 *   - Pixel-diff golden tests (deferred to Phase 2 kickoff per §10 Q3
 *     resolution + BIR fidelity acceptance criteria).
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
  formatPesoInWords,
  PLACEHOLDER_BIR_CONFIG,
} from "../lib/birFormat";
import {
  BRAND,
  CEMETERY_ADDRESS_LINES,
  drawLetterhead,
  drawSignOff,
} from "../lib/brandAssets";
// The internal query/mutations this action calls live in a V8-runtime
// sibling module (`convex/generateContractPdfInternal.ts`) — Convex
// forbids defining queries/mutations in a `"use node"` file. `import
// type` is erased at bundle time, so the Node bundle never pulls those
// V8 definitions in.
import type { ContractRenderPayload } from "../generateContractPdfInternal";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractId = DataModel["contracts"]["document"]["_id"];
type StorageId = DataModel["customerDocuments"]["document"]["storageId"];
type ActionCtx = GenericActionCtx<DataModel>;

/**
 * Function reference for the action itself — used by the public mutation
 * in `convex/contracts.ts` to schedule a run. We export the bare path
 * here so the mutation file doesn't depend on `convex/_generated/api`
 * (which this repo deliberately doesn't check in — see
 * `convex/gpsImport.ts` line 21-34 for the rationale). The mutation
 * builds a `makeFunctionReference` against the same path string.
 */
export const GENERATE_CONTRACT_PDF_FUNCTION_PATH =
  "actions/generateContractPdf:run";

/**
 * Function reference for the internal query the action calls. Exposed
 * for the same `_generated`-free reason as above.
 */
export const GET_CONTRACT_FOR_PDF_RENDER_FUNCTION_PATH =
  "generateContractPdfInternal:_getContractForPdfRender";

/**
 * Function reference for the internal mutation the action calls to
 * record the stored blob id on the contract row.
 */
export const RECORD_CONTRACT_PDF_READY_FUNCTION_PATH =
  "generateContractPdfInternal:_recordContractPdfReady";

/**
 * Function-reference path for the failed-state callback. Exposed so
 * the retry-sweep cron + action error handler can resolve it via
 * `makeFunctionReference`.
 */
export const RECORD_CONTRACT_PDF_FAILED_FUNCTION_PATH =
  "generateContractPdfInternal:_recordContractPdfFailed";

/**
 * Function-reference path for the retry-count bump. Used by the
 * retry-sweep cron in `convex/crons.ts`.
 */
export const BUMP_CONTRACT_PDF_RETRY_COUNT_FUNCTION_PATH =
  "generateContractPdfInternal:_bumpContractPdfRetryCount";

/**
 * Renders the contract PDF body into a PDFKit document. Pure layout —
 * no side effects, takes the payload and the PDFKit doc and writes
 * pages. Extracted from the action handler so it can be unit-tested
 * independently of the action plumbing.
 */
function renderContractPdf(
  doc: InstanceType<typeof PDFKitDocument>,
  payload: ContractRenderPayload,
): void {
  // === Page 1: brand letterhead + title + parties + lot + (optional) schedule ===

  // --- Brand letterhead (mark + wordmark + corporate ID + gold rule) ---
  drawLetterhead(doc, {
    marginLeft: 50,
    marginRight: 50,
    top: 50,
    pageWidth: 612,
  });

  // --- Title block (ceremonial serif, emerald, wide letter-spacing) ---
  doc.fillColor(BRAND.emerald).font("Times-Roman").fontSize(18);
  doc.text("INSTALLMENT CONTRACT", 50, doc.y, {
    width: 512,
    align: "center",
    characterSpacing: 3,
  });
  doc.fontSize(11).fillColor(BRAND.forest);
  doc.text("FOR INTERMENT LOT", 50, doc.y, {
    width: 512,
    align: "center",
    characterSpacing: 4,
  });
  doc.moveDown(0.6);
  doc.fillColor(BRAND.moss).font("Courier").fontSize(8);
  doc.text(`Contract № ${payload.contractNumber}`, 50, doc.y, {
    width: 512,
    align: "center",
    characterSpacing: 0.6,
  });
  doc.text(`Date issued · ${formatIssuedDate(payload.createdAt)}`, 50, doc.y, {
    width: 512,
    align: "center",
    characterSpacing: 0.6,
  });
  doc.fillColor(BRAND.ink);
  doc.moveDown(1.5);

  // --- Parties block ---
  doc.font("Times-Roman").fontSize(13).fillColor(BRAND.emerald);
  doc.text("The Parties", 50, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);
  // The cemetery's BIR-registered name remains in the contract for
  // legal completeness; address uses the brand-canonical block.
  doc.text(`Cemetery: ${PLACEHOLDER_BIR_CONFIG.registeredName}`);
  for (const line of CEMETERY_ADDRESS_LINES) {
    doc.text(line);
  }
  doc.moveDown(0.3);
  doc.text(`Customer: ${payload.customerFullName}`);
  doc.text(
    `Government ID: ${payload.customerGovIdType.toUpperCase()} ending in ${payload.customerGovIdLast4 || "(redacted)"}`,
  );
  for (const line of payload.customerAddressLines) {
    doc.text(line);
  }
  if (payload.customerPhone !== undefined) {
    doc.text(`Phone: ${payload.customerPhone}`);
  }
  if (payload.customerEmail !== undefined) {
    doc.text(`Email: ${payload.customerEmail}`);
  }
  doc.moveDown(1);

  // --- Lot description ---
  doc.font("Times-Roman").fontSize(13).fillColor(BRAND.emerald);
  doc.text("Lot Details", 50, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);
  doc.text(`Lot code: ${payload.lotCode}`);
  doc.text(`Type: ${payload.lotType}`);
  doc.text(
    `Location: Section ${payload.lotSection}, Block ${payload.lotBlock}, Row ${payload.lotRow}`,
  );
  doc.text(
    `Dimensions: ${payload.lotWidthM.toFixed(2)} m x ${payload.lotDepthM.toFixed(2)} m`,
  );
  doc.font("Helvetica-Bold").fillColor(BRAND.forest);
  doc.text(
    `Total contract price: ${formatPesoAmount(payload.totalPriceCents)} (${formatPesoInWords(payload.totalPriceCents)})`,
  );
  doc.font("Helvetica").fillColor(BRAND.ink);
  doc.moveDown(1);

  // --- Installment schedule table (installment contracts only) ---
  if (
    payload.contractKind === "installment" &&
    payload.installments.length > 0
  ) {
    doc.font("Times-Roman").fontSize(13).fillColor(BRAND.emerald);
    doc.text("Installment Schedule", 50, doc.y, { characterSpacing: 1 });
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);
    if (payload.downPaymentCents !== undefined) {
      doc.text(
        `Down payment: ${formatPesoAmount(payload.downPaymentCents)}`,
      );
    }
    if (payload.termMonths !== undefined) {
      doc.text(`Term: ${payload.termMonths} month(s)`);
    }
    if (payload.monthlyAmountCents !== undefined) {
      doc.text(
        `Monthly amount: ${formatPesoAmount(payload.monthlyAmountCents)}`,
      );
    }
    if (payload.firstDueDate !== undefined) {
      doc.text(`First due date: ${formatIssuedDate(payload.firstDueDate)}`);
    }
    doc.moveDown(0.5);

    // Hand-drawn table grid in brand colours — stone divider rule,
    // emerald header text, mono body for tabular figures.
    const tableTop = doc.y;
    const colX = { num: 50, due: 110, amount: 260, status: 410 };
    doc.font("Helvetica-Bold").fillColor(BRAND.emerald);
    doc.text("#", colX.num, tableTop);
    doc.text("Due date", colX.due, tableTop);
    doc.text("Amount", colX.amount, tableTop);
    doc.text("Status", colX.status, tableTop);
    doc.save();
    doc.strokeColor(BRAND.stone);
    doc.lineWidth(0.5);
    doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).stroke();
    doc.restore();
    doc.font("Helvetica").fillColor(BRAND.ink);
    let rowY = tableTop + 18;
    for (const row of payload.installments) {
      // New page if we'd overflow.
      if (rowY > 720) {
        doc.addPage();
        rowY = 50;
      }
      doc.text(String(row.installmentNumber), colX.num, rowY);
      doc.text(formatIssuedDate(row.dueDate), colX.due, rowY);
      doc.font("Courier").fontSize(9);
      doc.text(formatPesoAmount(row.principalCents), colX.amount, rowY);
      doc.font("Helvetica").fontSize(10);
      doc.text(row.status, colX.status, rowY);
      rowY += 16;
    }
    doc.y = rowY + 10;
    doc.x = 50;
  }

  // --- Terms paragraph ---
  doc.moveDown(1);
  doc.font("Times-Roman").fontSize(13).fillColor(BRAND.emerald);
  doc.text("Terms", 50, doc.y, { characterSpacing: 1 });
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);
  doc.text(
    "The Customer agrees to remit the installment amounts on the dates set " +
      "forth in the schedule above. Late settlement may incur a grace period " +
      "and / or penalty as set by the Cemetery's then-current installment " +
      "policy. The lot shall remain the property of the Cemetery until this " +
      "contract is paid in full, whereupon legal title transfers to the " +
      "Customer subject to the Cemetery's rules and the regulations of the " +
      "Estate Office.",
    { align: "justify" },
  );
  doc.moveDown(0.5);
  doc.font("Times-Italic").fontSize(8).fillColor(BRAND.gold);
  doc.text(
    "Final terms language pending §10 Q1 (grace / penalty policy). " +
      "Until the cemetery's legal counsel confirms, the paragraph above is " +
      "placeholder boilerplate not binding on either party.",
  );
  doc.fillColor(BRAND.ink);

  // --- Signature blocks (final page) ---
  doc.addPage();
  // Letterhead repeats on the signature page so the document holds
  // brand consistency end-to-end.
  drawLetterhead(doc, {
    marginLeft: 50,
    marginRight: 50,
    top: 50,
    pageWidth: 612,
  });
  doc.font("Times-Roman").fontSize(16).fillColor(BRAND.emerald);
  doc.text("Signatures", 50, doc.y, {
    width: 512,
    align: "center",
    characterSpacing: 2,
  });
  doc.moveDown(2);
  doc.font("Helvetica").fontSize(10).fillColor(BRAND.ink);

  // Two columns side-by-side.
  const sigY = doc.y;
  doc.save();
  doc.strokeColor(BRAND.stone);
  doc.lineWidth(0.5);
  // Left column — Cemetery officer.
  doc.text("Cemetery officer:", 50, sigY);
  doc.moveTo(50, sigY + 60).lineTo(280, sigY + 60).stroke();
  doc.text("Printed name", 50, sigY + 64);
  doc.text(`(${PLACEHOLDER_BIR_CONFIG.signatoryName})`, 50, sigY + 80);
  doc.text(PLACEHOLDER_BIR_CONFIG.signatoryTitle, 50, sigY + 94);
  doc.moveTo(50, sigY + 140).lineTo(280, sigY + 140).stroke();
  doc.text("Date", 50, sigY + 144);

  // Right column — Customer.
  doc.text("Customer:", 320, sigY);
  doc.moveTo(320, sigY + 60).lineTo(550, sigY + 60).stroke();
  doc.text("Printed name", 320, sigY + 64);
  doc.text(`(${payload.customerFullName})`, 320, sigY + 80);
  doc.moveTo(320, sigY + 140).lineTo(550, sigY + 140).stroke();
  doc.text("Date", 320, sigY + 144);
  doc.restore();

  // --- Ceremonial sign-off ("With reverence, / The Estate Office") ---
  drawSignOff(doc, {
    rightX: 562,
    top: sigY + 200,
    width: 240,
  });

  // --- Footer note ---
  doc.font("Times-Italic").fontSize(8).fillColor(BRAND.moss);
  doc.text(
    `Format version: ${PLACEHOLDER_BIR_CONFIG.formatVersion}${
      BIR_CONFIG_IS_PLACEHOLDER ? " (template pending BIR confirmation)" : ""
    }`,
    50,
    sigY + 290,
  );
  doc.fillColor(BRAND.ink);
}

/**
 * Action body — orchestrates the read, render, store, callback flow.
 * Exported as `run` so the function path is `actions/generateContractPdf:run`.
 *
 * Auth note: the originating mutation (`generateContractPdfRequest` in
 * `convex/contracts.ts`) already gated on `["admin", "office_staff"]`.
 * This action has no user context (scheduled via `runAfter`); the
 * internal-only nature plus the scheduler's "only schedulable from a
 * mutation that has already authenticated" path is the gate.
 */
export const run = internalActionGeneric({
  args: {
    contractId: v.id("contracts"),
  },
  handler: async (
    ctx: ActionCtx,
    args: { contractId: ContractId },
  ): Promise<{ storageId: string }> => {
    // Epic-3/4 adversarial-review HIGH fix — wrap the entire action
    // body so any failure path lands a `pdfStatus: "failed"` patch
    // (via `_recordContractPdfFailed`) before re-throwing. Without
    // this, a runtime crash (PDFKit OOM, storage outage) would leave
    // the contract row stuck on "pending" until the retry-sweep cron
    // picked it up — the failed-state record gives operators
    // immediate visibility on the contract detail page and lets the
    // retry-sweep cron filter on `"failed"` directly.
    try {
      // Step 1: load the render payload via the internal query.
      const getRef = makeFunctionReference<
        "query",
        { contractId: ContractId },
        ContractRenderPayload
      >(GET_CONTRACT_FOR_PDF_RENDER_FUNCTION_PATH);
      const payload = await ctx.runQuery(getRef, {
        contractId: args.contractId,
      });

      // Step 2: render the PDF into a Buffer. PDFKit emits chunks on
      // the document's data event; we collect them into a single
      // Buffer. The PDFKit `info.CreationDate` is derived from the
      // contract row's `_creationTime` so repeated regenerations
      // against the same row produce a byte-stable header — the prior
      // `new Date()` non-determinism was a HIGH adversarial-review
      // finding.
      const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFKitDocument({
          size: "LETTER",
          margin: 50,
          info: {
            Title: `Contract ${payload.contractNumber}`,
            Author: PLACEHOLDER_BIR_CONFIG.registeredName,
            Subject: "Installment contract for interment lot",
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
          renderContractPdf(doc, payload);
          doc.end();
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      // Step 3: store the blob in Convex File Storage. `Blob` is the
      // web-standard wrapper; Node 18+ exposes it as a global.
      const blob = new Blob([new Uint8Array(pdfBuffer)], {
        type: "application/pdf",
      });
      const storageId = await ctx.storage.store(blob);

      // Step 4: call back into the internal mutation to record the blob
      // pointer on the contract row + flip pdfStatus to "ready".
      // `generatedAt` is wall-clock at the moment of writeback; this
      // is for UI display ("PDF generated 5 minutes ago") and is NOT
      // the same value as the deterministic PDFKit CreationDate above.
      const recordRef = makeFunctionReference<
        "mutation",
        {
          contractId: ContractId;
          storageId: StorageId;
          generatedAt: number;
        },
        void
      >(RECORD_CONTRACT_PDF_READY_FUNCTION_PATH);
      await ctx.runMutation(recordRef, {
        contractId: args.contractId,
        storageId: storageId as StorageId,
        generatedAt: Date.now(),
      });

      return { storageId: storageId as string };
    } catch (err: unknown) {
      // Epic-3/4 HIGH fix — failed-state callback. The retry-sweep cron
      // will pick this up on its next pass (provided
      // pdfRetryCount < 3). Re-throw so Convex's action-error log
      // captures the underlying error for operator diagnostics.
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      try {
        const failedRef = makeFunctionReference<
          "mutation",
          { contractId: ContractId; errorMessage: string },
          void
        >(RECORD_CONTRACT_PDF_FAILED_FUNCTION_PATH);
        await ctx.runMutation(failedRef, {
          contractId: args.contractId,
          errorMessage,
        });
      } catch {
        // Best-effort — if the failed-state patch itself errors
        // (database down), surfacing the original error is more
        // important than the bookkeeping miss.
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
  renderContractPdf,
  GENERATE_CONTRACT_PDF_FUNCTION_PATH,
  GET_CONTRACT_FOR_PDF_RENDER_FUNCTION_PATH,
  RECORD_CONTRACT_PDF_READY_FUNCTION_PATH,
};
