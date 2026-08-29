"use node";

/**
 * Fill the park's certificate blank with one family's details.
 *
 * The blank is whatever the cemetery uploaded — a PDF from their
 * designer, or a scan. Nothing here draws a border, a seal, or a word
 * of legal text: that document is theirs, approved by their lawyer, and
 * this only writes names onto it.
 *
 * `pdf-lib`, not PDFKit. PDFKit builds a PDF from nothing and cannot
 * open an existing one, so a PDF blank would have to be rasterised to
 * an image first — which prints softer than the vector original on a
 * document people frame. `pdf-lib` draws onto the real page and leaves
 * the park's artwork untouched.
 *
 * The coordinate flip lives in `convex/lib/certificate.ts` and is
 * tested there. This file trusts `resolveFields` and does not repeat
 * the arithmetic; two copies of a flip is exactly how a name ends up
 * upside-down at the bottom of a page.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  internalActionGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFPage,
} from "pdf-lib";

import schema from "../schema";
import {
  drawXFor,
  resolveFields,
  shrinkToFit,
  type CertificateData,
  type FieldPlacement,
} from "../lib/certificate";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type StorageId = DataModel["certificates"]["document"]["storageId"];

/** Ink colour for the filled-in details. Near-black, not pure black. */
const INK = rgb(0.12, 0.12, 0.1);

export interface RenderResult {
  storageId: StorageId;
  /** Fields whose text would not fit even at the minimum size. */
  overflowed: string[];
}

const recordCertificateRef = makeFunctionReference<
  "mutation",
  {
    contractId: string;
    storageId: string;
    mimeType: string;
    source: "generated" | "uploaded";
    templateId?: string;
    serial?: string;
    supersedeReason?: string;
  },
  { certificateId: string; serial: string }
>("certificates:recordCertificate");

/**
 * Draw the details onto the blank and store the result.
 *
 * INTERNAL, deliberately. As a public action this took the owner's
 * name, the template, and the contract as plain arguments — so any
 * signed-in office account could have rendered a certificate bearing
 * any name at all against any fully-paid contract it could reach. The
 * only caller is `issueCertificate`, which reads the real details from
 * the database through a role-gated query.
 *
 * `recordCertificate` still re-checks the role and the fully-paid rule
 * when the row is written; that gate does not move.
 */
export const generateCertificatePdf = internalActionGeneric({
  args: {
    contractId: v.string(),
    templateId: v.string(),
    templateStorageId: v.string(),
    templateMimeType: v.string(),
    data: v.object({
      ownerName: v.string(),
      lotCode: v.string(),
      section: v.string(),
      lotType: v.string(),
      contractNumber: v.string(),
      serial: v.string(),
      issuedAt: v.number(),
      amountPaidCents: v.number(),
    }),
    fields: v.array(
      v.object({
        key: v.string(),
        xFrac: v.number(),
        yFrac: v.number(),
        fontSize: v.number(),
        align: v.union(
          v.literal("left"),
          v.literal("center"),
          v.literal("right"),
        ),
        maxWidthFrac: v.optional(v.number()),
      }),
    ),
    supersedeReason: v.optional(v.string()),
  },
  handler: async (
    ctx: ActionCtx,
    args: {
      contractId: string;
      templateId: string;
      templateStorageId: string;
      templateMimeType: string;
      data: CertificateData;
      fields: FieldPlacement[];
      supersedeReason?: string;
    },
  ): Promise<{ certificateId: string; serial: string; overflowed: string[] }> => {
    const blob = await ctx.storage.get(args.templateStorageId as StorageId);
    if (blob === null) {
      throw new Error(
        "The certificate blank has gone missing from storage. Upload it again under Certificate template.",
      );
    }
    const templateBytes = new Uint8Array(await blob.arrayBuffer());

    const rendered = await renderCertificate({
      templateBytes,
      templateMimeType: args.templateMimeType,
      fields: args.fields,
      data: args.data,
    });

    const storageId = await ctx.storage.store(
      new Blob([rendered.bytes as BlobPart], { type: "application/pdf" }),
    );

    const result = await ctx.runMutation(recordCertificateRef, {
      contractId: args.contractId,
      storageId: storageId as unknown as string,
      mimeType: "application/pdf",
      source: "generated",
      templateId: args.templateId,
      // The number that was actually PRINTED, a page ago. Letting the
      // mutation take a fresh one here would put one serial on the
      // document and a different one in the record — which is the exact
      // failure the reserve-then-render ordering exists to prevent.
      serial: args.data.serial,
      ...(args.supersedeReason !== undefined
        ? { supersedeReason: args.supersedeReason }
        : {}),
    });

    return { ...result, overflowed: rendered.overflowed };
  },
});

/**
 * The drawing itself, with no Convex around it.
 *
 * Exported under `__testing` so the suite can hand it a real one-page
 * PDF and assert the output opens, keeps the original page size, and
 * reports overflow — without standing up the action plumbing.
 */
async function renderCertificate(input: {
  templateBytes: Uint8Array;
  templateMimeType: string;
  fields: FieldPlacement[];
  data: CertificateData;
}): Promise<{ bytes: Uint8Array; overflowed: string[] }> {
  const { doc, page } = await openTemplate(
    input.templateBytes,
    input.templateMimeType,
  );

  // A serif face, because a certificate is a formal document and the
  // park's own artwork will be set in one. Standard-14, so nothing has
  // to be embedded and the output stays small.
  const font = await doc.embedFont(StandardFonts.TimesRoman);

  const { width, height } = page.getSize();
  const resolved = resolveFields(input.fields, {
    widthPt: width,
    heightPt: height,
  }, input.data);

  const overflowed: string[] = [];

  for (const field of resolved) {
    const measuredAtSize = font.widthOfTextAtSize(field.text, field.fontSize);
    const { fontSize, fits } = shrinkToFit(
      field.fontSize,
      measuredAtSize,
      field.maxWidthPt,
    );
    if (!fits) overflowed.push(field.key);

    // Re-measure at whatever size we settled on, so the alignment
    // anchor is right. Measuring once and scaling would drift.
    const finalWidth = font.widthOfTextAtSize(field.text, fontSize);

    page.drawText(field.text, {
      x: drawXFor(field, finalWidth),
      y: field.yPt,
      size: fontSize,
      font,
      color: INK,
    });
  }

  return { bytes: await doc.save(), overflowed };
}

/**
 * Open the blank, whatever form it arrived in.
 *
 * A PDF is opened as itself and its first page drawn on — the park's
 * vector artwork survives. An image becomes a new page at the image's
 * own pixel dimensions read as points, which is the reading that makes
 * a 300dpi A4 export land at roughly A4 and keeps the placement
 * fractions meaningful.
 */
async function openTemplate(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ doc: PDFDocument; page: PDFPage }> {
  if (mimeType === "application/pdf") {
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    if (page === undefined) {
      throw new Error("The certificate blank has no pages.");
    }
    return { doc, page };
  }

  const doc = await PDFDocument.create();
  const image =
    mimeType === "image/png"
      ? await doc.embedPng(bytes)
      : await doc.embedJpg(bytes);
  const page = doc.addPage([image.width, image.height]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: image.width,
    height: image.height,
  });
  return { doc, page };
}

export const __testing = { renderCertificate, openTemplate };
