"use node";

/**
 * Memorial plaque PDF generation action (Tier 3 brand application).
 *
 * Internal Node-runtime action that renders a small, dignified
 * memorial plaque PDF for a customer or interment. The template is
 * driven by Chapter VII of the Apostle Paul Memorial Park brand
 * guide:
 *
 *   - Emerald page background.
 *   - Gold hairline border inset 1cm from the page edges.
 *   - Brand mark sitting on an ivory inlay panel near the top.
 *   - Name in serif small-caps, ivory, wide letter-spacing.
 *   - Dates in mono, gold-tinted (`1942 — 2026` or Roman-numeral
 *     form `MCMXLII — MMXXVI` when `useRoman: true`).
 *   - Optional italic-serif epitaph at the foot, ivory at 85% opacity.
 *
 * Page size: A6 portrait (105 × 148 mm) per the brand spec's "small,
 * dignified piece" note. A6 in PDF points = 297.64 × 419.53 — we
 * pass a numeric tuple to PDFKit (no preset for A6 in `PDFDocument`
 * options).
 *
 * Public-API contract:
 *
 *   generatePlaquePdf({
 *     customerName: string,
 *     bornAt?: number,
 *     diedAt: number,
 *     epitaph?: string,
 *     useRoman?: boolean,
 *   }) → { storageId: Id<"_storage"> }
 *
 * Returns the storageId of the freshly-rendered PDF blob; admin staff
 * surface a download link via a separate query (mirrors the pattern
 * established by Story 6.1's `getContractPdfUrl`). This action does
 * NOT write back to any domain table — there is no `plaque` row in
 * Phase 1; the blob lives in storage and the storageId is returned
 * to the caller for ad-hoc display / download.
 *
 * Auth contract: the public action `generatePlaquePdf` is gated via
 * the scheduling mutation (callers must hold `["admin",
 * "office_staff"]`). The action body assumes auth was verified at the
 * schedule site — actions cannot read auth directly. This file
 * exposes the public `actionGeneric` entry point so the scheduling
 * mutation can `ctx.scheduler.runAfter(0, ...)` against it.
 *
 * The `renderPlaquePdf` pure function is exported under `__testing`
 * so the unit-test suite can drive PDFKit with a stub payload and
 * assert non-empty output without spinning up the action plumbing.
 */

import {
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  actionGeneric,
  internalActionGeneric,
  makeFunctionReference,
} from "convex/server";
import { v } from "convex/values";
import PDFKitDocument from "pdfkit";

import schema from "../schema";
import { BRAND, drawMark } from "../lib/brandAssets";
import { toRoman } from "../lib/roman";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type PlaqueDraftId = DataModel["plaqueDrafts"]["document"]["_id"];
type PlaqueStorageId = NonNullable<
  DataModel["plaqueDrafts"]["document"]["pdfStorageId"]
>;

// ---------------------------------------------------------------------------
// Page geometry — A6 portrait. mm → points (1 mm = 2.83464567 points).
// Inset 1cm gold border per the brand spec.
// ---------------------------------------------------------------------------

const MM_TO_POINTS = 2.83464567;
const A6_WIDTH = 105 * MM_TO_POINTS; // ≈ 297.64
const A6_HEIGHT = 148 * MM_TO_POINTS; // ≈ 419.53
const BORDER_INSET = 10 * MM_TO_POINTS; // 1cm gold hairline inset

const MAX_EPITAPH_CHARS = 200;

// ---------------------------------------------------------------------------
// Render payload — a small POD type so the unit test can construct
// a fixture without depending on Convex types.
// ---------------------------------------------------------------------------

export interface PlaqueRenderPayload {
  customerName: string;
  /** Epoch ms — optional birth date. When absent the plaque shows the
   * death date alone. */
  bornAt?: number;
  /** Epoch ms — required death date. */
  diedAt: number;
  /** Optional italic-serif epitaph at the foot. Trimmed to
   * MAX_EPITAPH_CHARS by the action; the renderer assumes the caller
   * has already enforced the cap. */
  epitaph?: string;
  /** When true, dates render as Roman numerals (MCMXLII — MMXXVI). */
  useRoman?: boolean;
}

// ---------------------------------------------------------------------------
// Date → year string. The plaque shows years only — month/day would
// crowd the small piece. Roman vs arabic is the only formatting
// switch; the year is extracted in Manila tz so a death just past
// midnight UTC on Dec 31 still reports the right calendar year locally.
// ---------------------------------------------------------------------------

const MANILA_YEAR_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
});

function yearOf(ms: number): number {
  // `Intl.DateTimeFormat.format` returns a string; parsing back into
  // a number is the cleanest way to extract just the year in the
  // target timezone without an OS-dependent `Date.getFullYear()`.
  const yearStr = MANILA_YEAR_FORMATTER.format(new Date(ms));
  return Number.parseInt(yearStr, 10);
}

/**
 * Format the plaque date band. Returns the dates joined by an
 * em-dash. When `bornAt` is absent the band shows the death year
 * alone — the brand spec treats this as the natural fallback.
 */
function formatPlaqueDates(payload: PlaqueRenderPayload): string {
  const diedYear = yearOf(payload.diedAt);
  const diedStr = payload.useRoman === true ? toRoman(diedYear) : String(diedYear);
  if (payload.bornAt === undefined) {
    return diedStr;
  }
  const bornYear = yearOf(payload.bornAt);
  const bornStr = payload.useRoman === true ? toRoman(bornYear) : String(bornYear);
  return `${bornStr} — ${diedStr}`;
}

// ---------------------------------------------------------------------------
// Renderer — pure PDFKit doc → Buffer. Exposed for unit tests.
// ---------------------------------------------------------------------------

/**
 * Render a memorial plaque PDF and resolve a Buffer with the bytes.
 * Pure: no DB / storage / network. Exported so unit tests can exercise
 * the renderer in isolation.
 */
export async function renderPlaquePdf(
  payload: PlaqueRenderPayload,
): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFKitDocument({
        size: [A6_WIDTH, A6_HEIGHT],
        margin: 0,
        info: {
          Title: `Memorial plaque · ${payload.customerName}`,
          Author: "APOSTLE PAUL MEMORIAL PARK",
          Subject: "Memorial plaque",
          Creator: "Cemetery Mapping",
        },
      });

      const chunks: Uint8Array[] = [];
      doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );

      drawPlaqueBody(doc, payload);

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

type PdfDoc = InstanceType<typeof PDFKitDocument>;

function drawPlaqueBody(doc: PdfDoc, payload: PlaqueRenderPayload): void {
  // --- 1. Emerald background filling the entire page ---
  doc.save();
  doc.rect(0, 0, A6_WIDTH, A6_HEIGHT).fill(BRAND.emerald);
  doc.restore();

  // --- 2. Gold hairline border inset 1cm from each edge ---
  doc.save();
  doc.strokeColor(BRAND.gold);
  doc.lineWidth(0.5);
  doc.rect(
    BORDER_INSET,
    BORDER_INSET,
    A6_WIDTH - 2 * BORDER_INSET,
    A6_HEIGHT - 2 * BORDER_INSET,
  );
  doc.stroke();
  doc.restore();

  // --- 3. Ivory inlay panel + brand mark, near the top ---
  // The brand spec shows the mark "on a small ivory inlay panel
  // against an emerald background" — render as a rounded-rect ivory
  // panel centred horizontally, with the mark drawn at its centre.
  const inlaySize = 56;
  const inlayX = (A6_WIDTH - inlaySize) / 2;
  const inlayY = BORDER_INSET + 18;
  doc.save();
  doc.fillColor(BRAND.ivory);
  doc
    .roundedRect(inlayX, inlayY, inlaySize, inlaySize, 4)
    .fill();
  doc.restore();
  // Mark sits centred in the inlay panel; the laurel + dove + diamond
  // use the emerald + gold palette for contrast against ivory.
  const markSize = 40;
  const markX = inlayX + (inlaySize - markSize) / 2;
  const markY = inlayY + (inlaySize - markSize) / 2;
  drawMark(doc, markX, markY, {
    size: markSize,
    color: BRAND.emerald,
    accent: BRAND.gold,
  });

  // --- 4. Name (serif, all-caps, ivory, wide letter-spacing) ---
  // The spec calls for a generous letter-spacing on the name; 4pt
  // suits the small page without overflowing the ~270pt content box.
  const nameY = inlayY + inlaySize + 28;
  doc.save();
  doc.fillColor(BRAND.ivory);
  doc.font("Times-Roman").fontSize(18);
  doc.text(payload.customerName.toUpperCase(), BORDER_INSET, nameY, {
    width: A6_WIDTH - 2 * BORDER_INSET,
    align: "center",
    characterSpacing: 4,
    lineBreak: false,
  });
  doc.restore();

  // --- 5. Dates (mono, gold, em-dash separator) ---
  const datesY = nameY + 28;
  doc.save();
  doc.fillColor(BRAND.gold);
  doc.font("Courier").fontSize(11);
  doc.text(formatPlaqueDates(payload), BORDER_INSET, datesY, {
    width: A6_WIDTH - 2 * BORDER_INSET,
    align: "center",
    characterSpacing: 3,
    lineBreak: false,
  });
  doc.restore();

  // --- 6. Optional italic-serif epitaph ---
  if (payload.epitaph !== undefined && payload.epitaph.trim().length > 0) {
    const epitaphY = datesY + 32;
    doc.save();
    // 85% ivory ≈ blend with emerald; PDFKit supports `fillOpacity`
    // for this kind of soft tint.
    doc.fillColor(BRAND.ivory);
    doc.fillOpacity(0.85);
    doc.font("Times-Italic").fontSize(10);
    doc.text(payload.epitaph.trim(), BORDER_INSET + 18, epitaphY, {
      width: A6_WIDTH - 2 * BORDER_INSET - 36,
      align: "center",
      lineGap: 2,
    });
    doc.fillOpacity(1);
    doc.restore();
  }
}

// ---------------------------------------------------------------------------
// Public action entry point. Renders the PDF, stores the blob in
// Convex File Storage, and returns the storageId. Internal callers
// schedule this via the existing scheduler pattern.
// ---------------------------------------------------------------------------

/**
 * Public arg shape for the `generatePlaquePdf` action.
 */
export interface GeneratePlaquePdfArgs {
  customerName: string;
  bornAt?: number;
  diedAt: number;
  epitaph?: string;
  useRoman?: boolean;
}

export const generatePlaquePdf = actionGeneric({
  args: {
    customerName: v.string(),
    bornAt: v.optional(v.number()),
    diedAt: v.number(),
    epitaph: v.optional(v.string()),
    useRoman: v.optional(v.boolean()),
  },
  handler: async (
    ctx: ActionCtx,
    args: GeneratePlaquePdfArgs,
  ): Promise<{ storageId: string }> => {
    // Light input normalisation — the spec puts a 200-char cap on the
    // epitaph; truncating at the action boundary keeps the renderer
    // free of magic numbers and protects the rendered layout from
    // overflowing the small A6 page.
    // eslint-disable-next-line local-rules/require-role-first-line -- Scheduled-only: the scheduling mutation role-gates the caller (admin/office_staff); actions cannot read user auth from ctx.db.
    const epitaph =
      args.epitaph !== undefined
        ? args.epitaph.slice(0, MAX_EPITAPH_CHARS)
        : undefined;

    const payload: PlaqueRenderPayload = {
      customerName: args.customerName,
      diedAt: args.diedAt,
    };
    if (args.bornAt !== undefined) payload.bornAt = args.bornAt;
    if (epitaph !== undefined) payload.epitaph = epitaph;
    if (args.useRoman !== undefined) payload.useRoman = args.useRoman;

    const pdfBytes = await renderPlaquePdf(payload);
    const blob = new Blob([new Uint8Array(pdfBytes)], {
      type: "application/pdf",
    });
    const storageId = await ctx.storage.store(blob);
    return { storageId: storageId as unknown as string };
  },
});

// ---------------------------------------------------------------------------
// Story 6.8 — plaque-draft callback entry point.
//
// `runForDraft` is the internal-action entry the V8 `requestPlaqueDraft`
// mutation schedules via `ctx.scheduler.runAfter(0, ...)`. It accepts
// the `plaqueDraftId` + the render args derived from the form, calls
// the pure renderer, stores the blob, and patches the draft row via
// the internal mutations exposed in `convex/plaqueDrafts.ts`.
//
// Same try/catch failed-state pattern as Story 6.1's contract action
// (`actions/generateContractPdf:run`):
//   - Wrap the entire body so a PDFKit / storage failure lands a
//     `pdfStatus: "failed"` patch via `_recordPlaqueFailed` BEFORE
//     re-throwing. Without this, a runtime crash leaves the row
//     stuck on `"pending"` and the retry-sweep cron has nothing to
//     re-attempt against the failed-row index branch.
//   - The retry-sweep cron in `convex/pdfRetrySweep.ts` re-schedules
//     `pending` + `failed` rows whose `retryCount < 3`.
//
// Auth note: scheduled by the V8 mutation which already gated on
// `["admin", "office_staff"]`. The internal action itself has no user
// context (actions cannot read auth from `ctx.db`); the scheduling-
// site role check is the gate.
// ---------------------------------------------------------------------------

const RECORD_PLAQUE_READY_FUNCTION_PATH =
  "plaqueDrafts:_recordPlaqueReady";
const RECORD_PLAQUE_FAILED_FUNCTION_PATH =
  "plaqueDrafts:_recordPlaqueFailed";

/**
 * Convert a 4-digit year + a Manila-tz wall-clock midpoint to an epoch
 * ms value the existing renderer accepts. The renderer extracts only
 * the year (Manila tz) from the value, so any moment within the target
 * year produces the correct render — we pick July 1 noon Manila as a
 * mid-year sentinel that is safely inside the year boundary regardless
 * of UTC offset.
 */
function yearToManilaMidYearMs(year: number): number {
  // Manila is UTC+8 with no DST. July 1 noon Manila = July 1 04:00 UTC.
  // We compose the UTC timestamp directly to avoid any local-machine
  // timezone surprise in `Date.UTC`.
  return Date.UTC(year, 6, 1, 4, 0, 0);
}

export const runForDraft = internalActionGeneric({
  args: {
    plaqueDraftId: v.id("plaqueDrafts"),
    deceasedName: v.string(),
    bornYear: v.number(),
    diedYear: v.number(),
    dateFormat: v.union(v.literal("arabic"), v.literal("roman")),
    epitaph: v.optional(v.string()),
  },
  handler: async (
    ctx: ActionCtx,
    args: {
      plaqueDraftId: PlaqueDraftId;
      deceasedName: string;
      bornYear: number;
      diedYear: number;
      dateFormat: "arabic" | "roman";
      epitaph?: string;
    },
  ): Promise<{ storageId: string }> => {
    try {
      const payload: PlaqueRenderPayload = {
        customerName: args.deceasedName,
        bornAt: yearToManilaMidYearMs(args.bornYear),
        diedAt: yearToManilaMidYearMs(args.diedYear),
        useRoman: args.dateFormat === "roman",
      };
      if (args.epitaph !== undefined && args.epitaph.length > 0) {
        // Mirror the public action's defensive cap — the V8 mutation
        // enforces a stricter 240-char cap, this is belt + suspenders.
        payload.epitaph = args.epitaph.slice(0, MAX_EPITAPH_CHARS);
      }

      const pdfBytes = await renderPlaquePdf(payload);
      const blob = new Blob([new Uint8Array(pdfBytes)], {
        type: "application/pdf",
      });
      const storageId = await ctx.storage.store(blob);

      const readyRef = makeFunctionReference<
        "mutation",
        { plaqueDraftId: PlaqueDraftId; pdfStorageId: PlaqueStorageId },
        void
      >(RECORD_PLAQUE_READY_FUNCTION_PATH);
      await ctx.runMutation(readyRef, {
        plaqueDraftId: args.plaqueDraftId,
        pdfStorageId: storageId as PlaqueStorageId,
      });
      return { storageId: storageId as unknown as string };
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      try {
        const failedRef = makeFunctionReference<
          "mutation",
          { plaqueDraftId: PlaqueDraftId; error: string },
          void
        >(RECORD_PLAQUE_FAILED_FUNCTION_PATH);
        await ctx.runMutation(failedRef, {
          plaqueDraftId: args.plaqueDraftId,
          error: errorMessage,
        });
      } catch {
        // Best-effort — if the failed-state patch itself errors, surface
        // the underlying error rather than the bookkeeping miss.
      }
      throw err;
    }
  },
});

/**
 * Function-reference path for the draft callback entry. Used by the
 * V8 mutation in `convex/plaqueDrafts.ts` to schedule this action.
 * The retry-counter bump + the retry-sweep itself live in
 * `convex/plaqueDrafts.ts` and `convex/pdfRetrySweep.ts` respectively
 * — those files own the V8 surface; this file is Node-runtime only.
 */
export const GENERATE_PLAQUE_DRAFT_PDF_FUNCTION_PATH =
  "actions/generatePlaquePdf:runForDraft";

/**
 * Test helper — exposes the pure render function + internal constants
 * so the unit-test suite can drive PDFKit with a stub payload and
 * assert non-empty output without spinning up the action plumbing.
 */
export const __testing = {
  renderPlaquePdf,
  formatPlaqueDates,
  MAX_EPITAPH_CHARS,
  A6_WIDTH,
  A6_HEIGHT,
  yearToManilaMidYearMs,
  RECORD_PLAQUE_READY_FUNCTION_PATH,
  RECORD_PLAQUE_FAILED_FUNCTION_PATH,
  GENERATE_PLAQUE_DRAFT_PDF_FUNCTION_PATH,
};
