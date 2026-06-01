"use node";

/**
 * Receipt PDF generation — Story 3.13 (FR30, FR31, NFR-S3).
 *
 * Node-runtime Convex action that renders a BIR-compliant receipt PDF
 * via PDFKit and stores the resulting blob in Convex File Storage.
 * Returns the `Id<"_storage">` of the stored PDF; the caller's
 * companion internal mutation (`receipts:storeReceiptPdfBlob`) patches
 * the `pdfStorageId` / `pdfGeneratedAt` fields on the receipt row.
 *
 * Why an action (`"use node"`) and not a mutation:
 *   - PDFKit's CJS bundle pulls in Node's `Buffer`, `stream`, and the
 *     bundled AFM font files. The Convex V8 runtime can't load these;
 *     the Node runtime can.
 *   - Generating a PDF inside the financial mutation would tie its
 *     latency budget to PDFKit's render time (~50–200ms for a single
 *     receipt). Pushing it out-of-band keeps `postFinancialEvent`
 *     within its NFR-P1 budget and lets the UI subscribe reactively
 *     to the `pdfStorageId` field becoming non-null.
 *   - FR31 immutability: the action does NOT mutate any financial
 *     fields. It writes a PDF blob and patches two ancillary fields
 *     (`pdfStorageId`, `pdfGeneratedAt`). The underlying receipt
 *     serial, amount, void state, and audit trail are untouched. A
 *     regenerated PDF is functionally identical to the prior one
 *     (same inputs, same template); only the storage blob's identity
 *     changes.
 *
 * BIR-compliance contract — the PDF mirrors `ReceiptDisplay`'s HTML
 * structure:
 *   1. Header: cemetery registered name, TIN (formatted), BIR ATP,
 *      registered address. Right-aligned: "OFFICIAL RECEIPT" tag plus
 *      the formatted serial (e.g. `OR-0000123`) in a prominent,
 *      tabular-figure font.
 *   2. Voided banner (when `isVoided`): printed at the very top, in
 *      destructive-tone red, with the void reason + voided-by user.
 *      The PDF also overlays a translucent diagonal "VOIDED" watermark
 *      across the page so a printed copy is unambiguous.
 *   3. Issued-on date + received-by user.
 *   4. "Received from" block: customer full name + address.
 *   5. Particulars table: one row per `paymentAllocations` entry with
 *      a friendly label + amount in tabular numerals.
 *   6. Total row: amount in numerals + amount-in-words (BIR
 *      anti-forgery convention from `formatPesoInWords`).
 *   7. VAT block (conditional on `template.isVatRegistered`).
 *   8. Payment method + reference.
 *   9. Signature block.
 *  10. Footer: "This is an official receipt." + ATP + format-version.
 *
 * Auth contract: this action does not call `requireRole` itself —
 * actions cannot read auth from `ctx.db` (no `db` on `ActionCtx`). The
 * gating happens in the `generateReceiptPdfRequest` MUTATION that
 * schedules this action (the mutation calls `requireRole` first). The
 * action is scheduled, not directly invoked by clients; Convex's
 * scheduler refuses cross-deployment invocations.
 *
 * Idempotency / regeneration: the action does not deduplicate runs.
 * A second request schedules a second render and produces a fresh
 * blob; the internal mutation overwrites `pdfStorageId` to the latest
 * run (the prior blob is left in storage and may be cleaned up by a
 * future maintenance task — leaving it is the safer default for
 * audit / accidental-overwrite recovery).
 *
 * Source references:
 *   - Story 3.13 § Acceptance Criteria (AC1, AC4, AC5).
 *   - Story 3.11 `ReceiptDisplay.tsx` (structural mirror; same
 *     sections, same field order).
 *   - `convex/lib/birFormat.ts` — the pure formatters used by both
 *     the HTML render and this PDF render. Keeping the helpers
 *     shared means an OR printed from the browser print path
 *     (Story 3.11's `window.print()`) and an OR downloaded from
 *     this action carry the same string content.
 */

import type { GenericActionCtx } from "convex/server";
import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import PDFDocument from "pdfkit";

import schema from "../schema";
import {
  formatAllocationLabel,
  formatBirReceiptFooter,
  formatIssuedDate,
  formatIssuedDateTime,
  formatPaymentMethod,
  formatPesoAmount,
  formatPesoInWords,
  formatTin,
  splitForVat,
  type BirReceiptConfig,
  type BirReceiptConfigRow,
} from "../lib/birFormat";
import { BRAND, drawLetterhead } from "../lib/brandAssets";

import type { DataModelFromSchemaDefinition } from "convex/server";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type ReceiptId = DataModel["receipts"]["document"]["_id"];

/**
 * Shape returned by the companion internal query
 * `receipts:getReceiptForPdf`. The action receives a fully-hydrated
 * view-model (receipt + payment + customer + contract + lot +
 * allocations) so it can render without further round-trips. Mirrors
 * (a subset of) the `ReceiptDetail` shape from
 * `convex/receipts.ts:getReceipt`.
 */
interface ReceiptForPdf {
  receiptId: string;
  /**
   * Epic-3/4 adversarial-review HIGH fix — deterministic PDF
   * CreationDate. Mirrors `ReceiptForPdfPayload.receiptCreationTime`
   * in `convex/receipts.ts`; populated from the receipt row's
   * `_creationTime` so the PDF's `info.CreationDate` is byte-stable
   * across regenerations.
   */
  receiptCreationTime: number;
  receiptSeries: string;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  isVoided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  voidedByName: string | null;

  customer: {
    fullName: string | null;
    addressLine1: string | null;
    addressBarangay: string | null;
    addressCityMunicipality: string | null;
    addressProvince: string | null;
    addressPostalCode: string | null;
  };

  payment: {
    paymentMethod:
      | "cash"
      | "check"
      | "bank_transfer"
      | "gcash"
      | "maya"
      | "card";
    reference: string | null;
    receivedAt: number;
    receivedByName: string | null;
  };

  contract: {
    contractNumber: string | null;
    lotCode: string | null;
  };

  allocations: Array<{
    targetType: "contract" | "installment" | "perpetualCare" | "credit";
    amountCents: number;
    sequence: number;
    note: string | null;
  }>;

  /**
   * Legacy display-shape mirrored from the canonical
   * `birReceiptConfig` row. Kept so PDFKit helpers
   * (`drawSignatureBlock`, footer format-version tag) compile without
   * a coordinated refactor; new render code (the registered-address
   * header + the BIR footer) reads from `birConfig` below.
   */
  template: BirReceiptConfig;
  /**
   * The canonical `birReceiptConfig` singleton row. Hydrated by
   * `receipts:getReceiptForPdf` via `loadBirReceiptConfig`, which
   * throws when the row is missing or `isPlaceholder === true`. So
   * by the time the renderer sees this field, the cemetery's BIR
   * identity is confirmed production-ready.
   */
  birConfig: BirReceiptConfigRow;
  /**
   * Always `false` — `loadBirReceiptConfig` refuses to return
   * placeholder rows. Retained for the defensive footer banner in
   * `drawFooter`.
   */
  templateIsPlaceholder: boolean;
}

/**
 * Internal-query reference for the action to hydrate the receipt data
 * it needs. The reference resolves at runtime against
 * `receipts:getReceiptForPdf` (Story 3.13 appends this internal query
 * to `convex/receipts.ts`). Typed as `<"query">` because the function
 * is an internal query.
 *
 * Per the architectural pattern in this repo (the codegen
 * `convex/_generated/` does not exist — see `convex/lib/audit.ts`
 * comments), we resolve function refs via `makeFunctionReference`
 * rather than `internal.receipts.getReceiptForPdf`.
 */
const getReceiptForPdfRef = makeFunctionReference<
  "query",
  { receiptId: string },
  ReceiptForPdf | null
>("receipts:getReceiptForPdf");

/**
 * Internal-mutation reference that writes the action's output back
 * onto the receipt row. The mutation only patches
 * `pdfStorageId` + `pdfGeneratedAt` — never any financial field.
 */
const storeReceiptPdfBlobRef = makeFunctionReference<
  "mutation",
  { receiptId: string; storageId: string; generatedAt: number },
  null
>("receipts:storeReceiptPdfBlob");

/**
 * Epic-3/4 adversarial-review HIGH fix — failed-state callback. The
 * action catches every render / store / writeback failure and pings
 * this mutation so the receipt row flips to `pdfStatus: "failed"`
 * with the error string; the retry-sweep cron then re-attempts on
 * its next pass.
 */
const recordReceiptPdfFailedRef = makeFunctionReference<
  "mutation",
  { receiptId: string; errorMessage: string },
  null
>("receipts:recordReceiptPdfFailed");

/**
 * Public action: render the receipt to a PDF, store the bytes in
 * Convex File Storage, and patch the receipt row's `pdfStorageId` +
 * `pdfGeneratedAt`. Returns the storage id of the freshly-rendered
 * PDF.
 *
 * The mutation `receipts:generateReceiptPdfRequest` is the
 * client-visible entry point — it role-gates the caller, then
 * schedules this action via `ctx.scheduler.runAfter(0, ...)`. Clients
 * NEVER call this action directly.
 */
export const generateReceiptPdf = actionGeneric({
  args: {
    receiptId: v.id("receipts"),
    // `forceRegenerate` is an opt-in flag the void-receipt flow passes
    // to make the re-render overwrite the existing `pdfStorageId`
    // regardless of any prior PDF on the row. Today the action does
    // not maintain its own idempotency cache (every invocation produces
    // a fresh blob and the writeback mutation overwrites the pointer),
    // so the flag is informational at the action layer — it's threaded
    // through so future idempotency / dedupe logic can opt in / out.
    // The mutation that schedules the void re-render passes
    // `forceRegenerate: true` explicitly so the contract is documented
    // end-to-end.
    forceRegenerate: v.optional(v.boolean()),
  },
  handler: async (
    ctx: ActionCtx,
    args: { receiptId: ReceiptId; forceRegenerate?: boolean },
  ): Promise<{ storageId: string; generatedAt: number } | null> => {
    // Epic-3/4 adversarial-review HIGH fix — wrap the entire body so
    // any failure flips `pdfStatus: "failed"` via the failed-state
    // callback before re-throwing. The retry-sweep cron then re-
    // attempts on its next pass (provided pdfRetryCount < 3).
    // eslint-disable-next-line local-rules/require-role-first-line -- Scheduled-only: `receipts:generateReceiptPdfRequest` role-gates the caller before scheduling this action; actions cannot read user auth from ctx.db.
    try {
      // Hydrate the receipt view-model via the internal query. Returns
      // `null` for a missing / deleted receipt — the action gracefully
      // no-ops rather than throwing, because a scheduled invocation
      // raising surfaces as a hard scheduler error visible to admins.
      const data = (await ctx.runQuery(getReceiptForPdfRef, {
        receiptId: args.receiptId as unknown as string,
      })) as ReceiptForPdf | null;
      if (data === null) {
        return null;
      }
      // `forceRegenerate` is currently informational — see arg docstring
      // above. Touching `args.forceRegenerate` here keeps the parameter
      // referenced so a future tightening (idempotency cache, render-
      // skip-if-recent) has the wiring already in place.
      void args.forceRegenerate;

      // Render the PDF bytes. `renderReceiptPdf` is a pure function
      // (PDFKit doc → Buffer); exported for the unit tests so they can
      // assert PDF structure without round-tripping through the action.
      const pdfBytes = await renderReceiptPdf(data);

      // Store the blob. `ctx.storage.store` accepts a Blob; we wrap the
      // Node Buffer in a Blob with the BIR-friendly application/pdf
      // mime type. The signed URL the UI consumes flows through
      // `ctx.storage.getUrl`, which auth-gates the response (NFR-S3).
      const blob = new Blob([new Uint8Array(pdfBytes)], {
        type: "application/pdf",
      });
      const storageId = await ctx.storage.store(blob);
      const generatedAt = Date.now();

      // Patch the receipt row via the internal mutation. The mutation
      // is the only place that writes `pdfStorageId` /
      // `pdfGeneratedAt`; keeping the write surface narrow lets the
      // schema migration story (any future field renames) live in one
      // file.
      await ctx.runMutation(storeReceiptPdfBlobRef, {
        receiptId: args.receiptId as unknown as string,
        storageId: storageId as unknown as string,
        generatedAt,
      });

      return {
        storageId: storageId as unknown as string,
        generatedAt,
      };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      try {
        await ctx.runMutation(recordReceiptPdfFailedRef, {
          receiptId: args.receiptId as unknown as string,
          errorMessage,
        });
      } catch {
        // Best-effort — surfacing the original error matters more
        // than the bookkeeping miss.
      }
      throw err;
    }
  },
});

// -----------------------------------------------------------------------
// Renderer — exported so unit tests can render fixtures without an action
// ctx. Pure: `(view-model) → Promise<Buffer>`. No DB / storage access.
// -----------------------------------------------------------------------

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;

/**
 * Render a `ReceiptForPdf` view-model to a PDF and resolve a `Buffer`
 * containing the bytes. Pure: no DB / storage / network. Exported so
 * unit tests can exercise the renderer in isolation.
 *
 * Implementation notes:
 *   - Built on PDFKit's standard 14 fonts (Helvetica / Helvetica-Bold)
 *     to avoid pulling embedded font files into the Convex action
 *     bundle. The BIR doesn't require a specific typeface.
 *   - Layout uses absolute coordinates within the page margins; the
 *     content is short enough to fit on one US-Letter page even for
 *     a maximally-allocated installment with 12 line items. If a
 *     future story needs longer receipts, the renderer can switch
 *     to PDFKit's flowing layout API.
 *   - The voided watermark uses a translucent red diagonal text
 *     overlay (`fillOpacity(0.2)`) — visible enough to mark the
 *     document, light enough to keep the underlying content
 *     readable for audit purposes.
 */
export async function renderReceiptPdf(
  data: ReceiptForPdf,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margin: PAGE_MARGIN,
        info: {
          Title: `Receipt ${data.receiptNumber}`,
          Author: data.template.registeredName,
          Subject: "Official Receipt",
          Creator: "Broadheader Cemetery Management System",
          // Epic-3/4 adversarial-review HIGH fix — deterministic
          // CreationDate. Derived from the receipt row's immutable
          // `_creationTime` so regenerated PDFs are byte-stable.
          CreationDate: new Date(data.receiptCreationTime),
        },
      });

      const chunks: Uint8Array[] = [];
      doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );

      drawHeader(doc, data);
      drawIssuanceLine(doc, data);
      drawCustomerBlock(doc, data);
      drawAllocationsTable(doc, data);
      drawTotals(doc, data);
      if (data.template.isVatRegistered) {
        drawVatBlock(doc, data);
      }
      drawPaymentMethod(doc, data);
      drawSignatureBlock(doc, data);
      drawFooter(doc, data);

      // The voided watermark is drawn LAST so it overlays every
      // section. PDFKit composites without explicit z-order; last
      // drawn = on top.
      if (data.isVoided) {
        drawVoidedWatermark(doc);
        // The void notice banner is drawn at the top of the document
        // body, replacing what would otherwise be an empty top margin.
        drawVoidedBanner(doc, data);
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

type PdfDoc = InstanceType<typeof PDFDocument>;

function drawHeader(doc: PdfDoc, data: ReceiptForPdf): void {
  // Brand letterhead — dove-laurel mark + wordmark + corporate ID
  // column + gold hairline rule. Replaces the prior plain-text BIR
  // identity header. BIR-mandated fields (registered name, TIN, ATP)
  // remain on the page, but they live below the letterhead so the
  // brand mark is the first surface a reader sees while the legal
  // text remains intact for compliance.
  drawLetterhead(doc, {
    marginLeft: PAGE_MARGIN,
    marginRight: PAGE_MARGIN,
    top: PAGE_MARGIN,
    pageWidth: PAGE_WIDTH,
  });

  // BIR-required identity block — registered name, TIN, ATP, and the
  // BIR-REGISTERED address (NOT the brand / marketing address). Per
  // BIR rules the address printed on the OR must match what was
  // registered with the bureau; the brand-layer customer-facing
  // address is irrelevant to compliance and printing it here would
  // mismatch the BIR records on audit. Source: the
  // `birReceiptConfig.registeredAddressLines` array hydrated from
  // the singleton row.
  const blockTop = doc.y;
  doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.ink);
  doc.text(data.birConfig.registeredName, PAGE_MARGIN, blockTop, {
    width: 320,
  });
  if (
    data.birConfig.tradeName !== undefined &&
    data.birConfig.tradeName.length > 0
  ) {
    doc.font("Times-Italic").fontSize(9).fillColor(BRAND.forest);
    doc.text(`Trading as: ${data.birConfig.tradeName}`, { width: 320 });
    doc.fillColor(BRAND.ink);
  }
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.ink);
  doc.text(`TIN: ${formatTin(data.birConfig.tin)}`, { width: 320 });
  // BIR-registered address (NOT the brand wordmark's customer-facing
  // address). Renders the array verbatim — operators entered the
  // exact lines through the admin settings page.
  for (const line of data.birConfig.registeredAddressLines) {
    doc.text(line, { width: 320 });
  }
  doc.fontSize(8).fillColor(BRAND.moss);
  doc.text(`BIR ATP: ${data.birConfig.atpNumber}`, { width: 320 });
  doc.fillColor(BRAND.ink);

  // Right column — OR title + serial. Absolute coordinates so a long
  // registered name doesn't push the serial off the right edge. The
  // serial appears in serif (the brand display face) at a generous
  // size; the "OFFICIAL RECEIPT" label stays in the body face.
  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.moss);
  doc.text("OFFICIAL RECEIPT", PAGE_WIDTH - PAGE_MARGIN - 200, blockTop, {
    width: 200,
    align: "right",
    characterSpacing: 1.5,
  });
  doc.font("Times-Roman").fontSize(22).fillColor(BRAND.emerald);
  doc.text(data.receiptNumber, PAGE_WIDTH - PAGE_MARGIN - 200, blockTop + 14, {
    width: 200,
    align: "right",
  });
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.forest);
  doc.text(
    `Issued ${formatIssuedDate(data.issuedAt)}`,
    PAGE_WIDTH - PAGE_MARGIN - 200,
    blockTop + 44,
    { width: 200, align: "right" },
  );
  doc.fillColor(BRAND.ink);

  // Slim stone divider under the identity block — the gold hairline
  // already lives above (drawn by `drawLetterhead`); this softer
  // stone rule visually separates identity from the body.
  const dividerY = Math.max(doc.y + 4, blockTop + 80);
  doc.save();
  doc.strokeColor(BRAND.stone);
  doc.lineWidth(0.5);
  doc
    .moveTo(PAGE_MARGIN, dividerY)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, dividerY)
    .stroke();
  doc.restore();
  doc.y = dividerY + 10;
}

function drawIssuanceLine(doc: PdfDoc, data: ReceiptForPdf): void {
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.forest);
  const receivedBy =
    data.payment.receivedByName !== null
      ? `Received by ${data.payment.receivedByName} on ${formatIssuedDateTime(
          data.payment.receivedAt,
        )}`
      : `Received on ${formatIssuedDateTime(data.payment.receivedAt)}`;
  doc.text(receivedBy, PAGE_MARGIN, doc.y);
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.5);
}

function drawCustomerBlock(doc: PdfDoc, data: ReceiptForPdf): void {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.moss);
  doc.text("RECEIVED FROM", PAGE_MARGIN, doc.y, {
    characterSpacing: 1.5,
  });
  doc.fillColor(BRAND.ink);
  doc.font("Times-Roman").fontSize(13).fillColor(BRAND.emerald);
  doc.text(
    data.customer.fullName ?? "[Customer record unavailable]",
    PAGE_MARGIN,
    doc.y,
  );
  doc.font("Helvetica").fontSize(9).fillColor(BRAND.forest);
  const localityBits = [
    data.customer.addressBarangay,
    data.customer.addressCityMunicipality,
    data.customer.addressProvince,
    data.customer.addressPostalCode,
  ].filter((s): s is string => s !== null && s.length > 0);
  if (data.customer.addressLine1 !== null) {
    doc.text(data.customer.addressLine1, { width: 500 });
  }
  if (localityBits.length > 0) {
    doc.text(localityBits.join(", "), { width: 500 });
  }
  if (data.contract.contractNumber !== null) {
    const lotSuffix =
      data.contract.lotCode !== null ? ` · Lot: ${data.contract.lotCode}` : "";
    doc.text(`Contract: ${data.contract.contractNumber}${lotSuffix}`, {
      width: 500,
    });
  }
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.5);
}

function drawAllocationsTable(doc: PdfDoc, data: ReceiptForPdf): void {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.moss);
  doc.text("PARTICULARS", PAGE_MARGIN, doc.y, { characterSpacing: 1.5 });
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.25);

  const tableTop = doc.y;
  const descX = PAGE_MARGIN;
  const amountX = PAGE_WIDTH - PAGE_MARGIN - 100;

  doc.font("Helvetica-Bold").fontSize(9).fillColor(BRAND.emerald);
  doc.text("Description", descX, tableTop);
  doc.text("Amount", amountX, tableTop, { width: 100, align: "right" });
  doc.save();
  doc.strokeColor(BRAND.stone);
  doc.lineWidth(0.5);
  doc
    .moveTo(PAGE_MARGIN, tableTop + 14)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, tableTop + 14)
    .stroke();
  doc.restore();
  doc.fillColor(BRAND.ink);
  doc.y = tableTop + 18;

  doc.font("Helvetica").fontSize(10);
  if (data.allocations.length === 0) {
    doc.fillColor(BRAND.moss);
    doc.text("No allocation breakdown recorded.", descX, doc.y);
    doc.fillColor(BRAND.ink);
  } else {
    for (const alloc of data.allocations) {
      const rowY = doc.y;
      doc.text(
        formatAllocationLabel(alloc.targetType, alloc.note ?? undefined),
        descX,
        rowY,
        { width: amountX - descX - 10 },
      );
      doc.text(formatPesoAmount(alloc.amountCents), amountX, rowY, {
        width: 100,
        align: "right",
      });
      doc.moveDown(0.3);
    }
  }

  doc.save();
  doc.strokeColor(BRAND.stone);
  doc.lineWidth(0.5);
  doc
    .moveTo(PAGE_MARGIN, doc.y + 2)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, doc.y + 2)
    .stroke();
  doc.restore();
  doc.y += 6;
}

function drawTotals(doc: PdfDoc, data: ReceiptForPdf): void {
  const totalsY = doc.y;
  const amountX = PAGE_WIDTH - PAGE_MARGIN - 100;

  doc.font("Helvetica-Bold").fontSize(11).fillColor(BRAND.emerald);
  doc.text("TOTAL", PAGE_MARGIN, totalsY);
  doc.text(formatPesoAmount(data.amountCents), amountX, totalsY, {
    width: 100,
    align: "right",
  });
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.4);

  // BIR-required "amount in words" — VERBATIM string from
  // `formatPesoInWords`, presented in italic serif for the ceremonial
  // brand voice but the legal phrasing itself is untouched.
  doc.font("Times-Italic").fontSize(10).fillColor(BRAND.forest);
  doc.text(`(Amount in words: ${formatPesoInWords(data.amountCents)})`, {
    width: PAGE_WIDTH - 2 * PAGE_MARGIN,
  });
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.5);
}

function drawVatBlock(doc: PdfDoc, data: ReceiptForPdf): void {
  const { netCents, vatCents } = splitForVat(data.amountCents);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(BRAND.moss);
  doc.text("VAT BREAKDOWN", PAGE_MARGIN, doc.y, { characterSpacing: 1.5 });
  doc.fillColor(BRAND.ink);
  doc.moveDown(0.25);

  const labelX = PAGE_MARGIN;
  const amountX = PAGE_WIDTH - PAGE_MARGIN - 100;
  const lineHeight = 14;

  const rows: Array<[string, string, boolean]> = [
    ["VATable Sales", formatPesoAmount(netCents), false],
    ["VAT (12%)", formatPesoAmount(vatCents), false],
    ["VAT-Exempt Sales", formatPesoAmount(0), false],
    ["Total Amount Due", formatPesoAmount(data.amountCents), true],
  ];
  for (const [label, value, bold] of rows) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
    const y = doc.y;
    doc.text(label, labelX, y);
    doc.text(value, amountX, y, { width: 100, align: "right" });
    doc.y = y + lineHeight;
  }
  doc.moveDown(0.5);
}

function drawPaymentMethod(doc: PdfDoc, data: ReceiptForPdf): void {
  doc.font("Helvetica").fontSize(10);
  const method = formatPaymentMethod(data.payment.paymentMethod);
  const refSuffix =
    data.payment.reference !== null && data.payment.reference.length > 0
      ? ` · Ref: ${data.payment.reference}`
      : "";
  doc.text(`Payment method: ${method}${refSuffix}`, PAGE_MARGIN, doc.y, {
    width: PAGE_WIDTH - 2 * PAGE_MARGIN,
  });
  doc.moveDown(1);
}

function drawSignatureBlock(doc: PdfDoc, data: ReceiptForPdf): void {
  // BIR-mandated signatory line — preserved as bottom-LEFT block per
  // the spec ("the legally-mandated BIR block stays bottom-left
  // untouched"). The signatoryName / signatoryTitle strings come from
  // the BIR template and are not paraphrased.
  const sigX = PAGE_MARGIN;
  const sigY = doc.y + 20;
  doc.save();
  doc.strokeColor(BRAND.stone);
  doc.lineWidth(0.5);
  doc
    .moveTo(sigX, sigY)
    .lineTo(sigX + 220, sigY)
    .stroke();
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(10).fillColor(BRAND.ink);
  doc.text(data.template.signatoryName, sigX, sigY + 4, {
    width: 220,
    align: "left",
  });
  doc.font("Helvetica").fontSize(8).fillColor(BRAND.moss);
  doc.text(data.template.signatoryTitle, sigX, doc.y, {
    width: 220,
    align: "left",
  });
  doc.fillColor(BRAND.ink);
  doc.y = sigY + 40;
}

function drawFooter(doc: PdfDoc, data: ReceiptForPdf): void {
  // BIR-mandated "This is an official receipt." statement — VERBATIM.
  // Brand styling around it (italic serif, forest tone) is permitted
  // because the wording itself is preserved.
  //
  // The footer block also contains the BIR-mandated 5-year validity
  // statement ("THIS RECEIPT/INVOICE SHALL BE VALID FOR FIVE (5) YEARS
  // FROM THE DATE OF THE PERMIT TO USE.") — sourced via
  // `formatBirReceiptFooter` so the exact wording is centralised and
  // can never drift between the PDF render and any future HTML
  // preview.
  const FOOTER_TOP = PAGE_HEIGHT - 120;
  doc.font("Times-Italic").fontSize(9).fillColor(BRAND.forest);
  doc.text("This is an official receipt.", PAGE_MARGIN, FOOTER_TOP, {
    width: PAGE_WIDTH - 2 * PAGE_MARGIN,
    align: "center",
  });

  // BIR-required 5-year validity disclosure + ATP + expiry. Rendered
  // in body face (not Courier) so the legal text reads cleanly; small
  // size keeps the footer compact.
  doc.font("Helvetica-Bold").fontSize(7).fillColor(BRAND.ink);
  const footerLines = formatBirReceiptFooter({
    atpNumber: data.birConfig.atpNumber,
    atpExpiryDate: data.birConfig.atpExpiryDate,
  }).split("\n");
  for (const line of footerLines) {
    doc.text(line, {
      width: PAGE_WIDTH - 2 * PAGE_MARGIN,
      align: "center",
    });
  }

  doc.font("Courier").fontSize(7).fillColor(BRAND.moss);
  doc.text(
    `Serial range: ${data.birConfig.serialRangeStart}–${data.birConfig.serialRangeEnd} · Template format: ${data.template.formatVersion}`,
    { width: PAGE_WIDTH - 2 * PAGE_MARGIN, align: "center" },
  );
  if (data.templateIsPlaceholder) {
    // Defensive — `loadBirReceiptConfig` already throws on placeholder
    // rows so this branch should be unreachable in production. Kept as
    // a belt-and-suspenders banner so a future bypass surfaces visibly
    // on the rendered document instead of silently issuing a
    // non-compliant receipt.
    doc.fillColor(BRAND.gold);
    doc.text(
      "Receipt format pending BIR confirmation — placeholder template.",
      { width: PAGE_WIDTH - 2 * PAGE_MARGIN, align: "center" },
    );
  }
  doc.fillColor(BRAND.ink);
}

function drawVoidedBanner(doc: PdfDoc, data: ReceiptForPdf): void {
  // Draw a banner inside the top margin band so it doesn't overlap the
  // signature block. The text is positioned at y=15 (above the header
  // content); the watermark handles the full-page mark.
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#dc2626");
  doc.text("VOIDED RECEIPT", PAGE_MARGIN, 15, {
    width: PAGE_WIDTH - 2 * PAGE_MARGIN,
    align: "center",
  });
  doc.font("Helvetica").fontSize(8);
  const voidedAtStr =
    data.voidedAt !== null ? formatIssuedDateTime(data.voidedAt) : "—";
  const voidedByStr =
    data.voidedByName !== null ? ` by ${data.voidedByName}` : "";
  const reasonStr = data.voidReason ?? "—";
  doc.text(
    `Voided on ${voidedAtStr}${voidedByStr}. Reason: ${reasonStr}.`,
    PAGE_MARGIN,
    32,
    { width: PAGE_WIDTH - 2 * PAGE_MARGIN, align: "center" },
  );
  doc.fillColor("#000000");
}

function drawVoidedWatermark(doc: PdfDoc): void {
  doc.save();
  doc.fillColor("#dc2626");
  doc.fillOpacity(0.18);
  doc.font("Helvetica-Bold").fontSize(120);
  // Rotate about the page centre. PDFKit's rotate axis is the upper-
  // left corner of the page; translating to centre, rotating, and
  // translating back is the standard recipe.
  const cx = PAGE_WIDTH / 2;
  const cy = PAGE_HEIGHT / 2;
  doc.translate(cx, cy);
  doc.rotate(-30);
  doc.text("VOIDED", -200, -60, { width: 400, align: "center" });
  doc.restore();
  doc.fillOpacity(1);
  doc.fillColor("#000000");
}

// Re-export the type so tests can import a single, stable name.
export type { ReceiptForPdf };
