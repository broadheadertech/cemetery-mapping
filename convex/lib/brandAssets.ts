/**
 * Apostle Paul Memorial Park brand assets + shared letterhead helpers.
 *
 * Bundled into the Node-runtime Convex action bundles (receipt,
 * contract, demand-letter, plaque PDFs). Convex actions cannot read
 * from `public/`; any asset the PDFs need must travel with the action
 * module. Everything here is deliberately self-contained:
 *
 *   - `BRAND` — the hex palette from Chapter III of the brand guide,
 *     captured as PDFKit-ready strings.
 *   - `CEMETERY_ADDRESS` — the canonical address block used in every
 *     letterhead (the brand HTML's "Bulacan" is outdated; the live
 *     address is Aringay, La Union — see the spec).
 *   - `MARK_SVG` — the dove-within-laurel mark, condensed from the
 *     in-document SVG used by the brand HTML. Stored as an inline SVG
 *     string so PDFKit can rasterise it via the `SVGtoPDF` adapter at
 *     render time… EXCEPT: PDFKit's standard distribution does not
 *     include SVG rasterisation, and pulling in the `svg-to-pdfkit`
 *     package would expand the action bundle. The renderers fall back
 *     to a hand-drawn vector approximation (`drawMark`) that uses
 *     PDFKit's primitive shape API — a circle + crossed laurel arcs
 *     + a small gold inlay diamond — keeping the visual signal of the
 *     mark without an external dependency.
 *   - `drawLetterhead` — the shared header block (mark + wordmark +
 *     corporate identity column + gold hairline) used by the receipt,
 *     contract, and demand-letter renderers.
 *   - `drawSignOff` — the ceremonial "With reverence, / The Estate
 *     Office" sign-off block used by the contract and demand-letter
 *     renderers (NOT the receipt, which keeps its BIR signatory line
 *     for compliance).
 *
 * All drawing functions accept a `PDFKit.PDFDocument` and write at
 * the document's current cursor (or at explicit absolute coordinates
 * when the spec demands a specific spot — e.g. the letterhead always
 * occupies the page-top band). No global state; renderers compose
 * these helpers freely.
 */

import type PDFKit from "pdfkit";

// ---------------------------------------------------------------------------
// Palette — Chapter III. Hex strings PDFKit accepts in `fillColor` /
// `strokeColor`. Names mirror the brand-guide spec exactly so the
// rationale stays legible at the call site (`BRAND.gold` over a magic
// `#C9A96B`).
// ---------------------------------------------------------------------------
export const BRAND = {
  /** Primary text + headings on ivory. Voice of the institution. */
  emerald: "#1D5C4D",
  /** Secondary text. */
  forest: "#2F6B57",
  /** Supporting accents. */
  moss: "#4A8270",
  /** Page background tone — used inside plaque inlays. */
  ivory: "#F6F2EA",
  /** Dividers + subtle borders. */
  stone: "#B8B6AF",
  /** RATIONED accent — single hairline rule, single inlay. Never fill. */
  gold: "#C9A96B",
  /** Body copy. Never pure black. */
  ink: "#2A2925",
} as const;

// ---------------------------------------------------------------------------
// Canonical cemetery address — replaces the brand HTML's outdated
// Bulacan reference. Same string everywhere a letterhead reads.
// ---------------------------------------------------------------------------
export const CEMETERY_NAME_LINE_1 = "APOSTLE PAUL";
export const CEMETERY_NAME_LINE_2 = "MEMORIAL PARK";

/**
 * Mono-style corporate identity column shown on the right side of the
 * letterhead. The brand spec writes it in mono small-caps with wide
 * letter-spacing; we approximate the letter-spacing with two trailing
 * spaces between letters in source, but PDFKit's `characterSpacing`
 * lets us do this cleanly at render time — see `drawLetterhead`.
 */
export const CORPORATE_IDENTITY_LINES = [
  "CASES LAND INC.",
  "ZONE 1, SAN EUGENIO",
  "ARINGAY, LA UNION 2503",
  "PHILIPPINES",
] as const;

/**
 * Long-form address block used inside the body of letters / receipts
 * for "the cemetery's address" (BIR-compliant block on receipts,
 * letterhead reference on letters). Exposed as both an array (for
 * line-by-line rendering) and a newline-joined string (for callers
 * that want a single block to feed `birFormat.formatAddressLines`).
 */
export const CEMETERY_ADDRESS_LINES = [
  "Apostle Paul Memorial Park · Cases Land Inc.",
  "Zone 1, San Eugenio",
  "Aringay, La Union 2503",
  "Philippines",
] as const;

export const CEMETERY_ADDRESS_BLOCK = CEMETERY_ADDRESS_LINES.join("\n");

// ---------------------------------------------------------------------------
// Mark drawing — a stand-in for the dove-within-laurel SVG. PDFKit
// ships no SVG renderer; pulling in `svg-to-pdfkit` would inflate
// every action's bundle. The fallback uses PDFKit primitives to draw
// the same visual signal (laurel wreath outer ring + dove glyph in
// the middle + crossed-stem gold inlay at the base).
//
// The rendering is deliberately simple — the brand spec's mark is a
// finely-detailed engraving; recreating it with `arc` / `lineTo` calls
// would balloon this file. The approximation here uses:
//   1. An outer ring (laurel wreath silhouette).
//   2. Two short tangent strokes at the crown (opening of the wreath).
//   3. A small dove glyph at the centre (two curves).
//   4. A small gold diamond inlay at the base (the wreath inlay).
//
// All measured against a target `size` in PDF points; the renderers
// pass `size: 32` for letterheads, `size: 64` for plaques. Higher-
// fidelity rendering can replace this body without changing the call
// signature.
// ---------------------------------------------------------------------------

type PDFKitDoc = InstanceType<typeof PDFKit>;

interface DrawMarkOptions {
  /** Size in points (width = height). */
  size: number;
  /**
   * Stroke colour. Defaults to `BRAND.emerald`. Reversed contexts
   * (e.g. the plaque's emerald background) pass `BRAND.ivory`.
   */
  color?: string;
  /**
   * Gold inlay colour. Defaults to `BRAND.gold`. The plaque renderer
   * passes the same gold; reversed marks on emerald also use gold.
   */
  accent?: string;
}

/**
 * Draw the brand mark at the document's current cursor. The cursor
 * is preserved (we use `save`/`restore` around the transform). The
 * mark fits into an `(x, doc.y) → (x + size, doc.y + size)` box.
 *
 * Implementation: a circle outline for the wreath silhouette plus
 * inner detail strokes plus a small gold diamond at the foot.
 */
export function drawMark(
  doc: PDFKitDoc,
  x: number,
  y: number,
  options: DrawMarkOptions,
): void {
  const { size, color = BRAND.emerald, accent = BRAND.gold } = options;
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2 - size * 0.06;

  doc.save();
  doc.lineWidth(Math.max(0.6, size * 0.025));
  doc.strokeColor(color);

  // 1. Laurel wreath outer ring — drawn as two arcs meeting at the
  // crown with a small opening at the top (matches the brand-guide
  // "open at the crown" gesture).
  const openingAngle = Math.PI / 18; // ~10° opening at the crown
  doc.path(
    arcPath(
      cx,
      cy,
      r,
      -Math.PI / 2 + openingAngle,
      Math.PI * 1.5 - openingAngle,
    ),
  );
  doc.stroke();

  // 2. Small dove glyph at centre — two curved strokes forming the
  // body + a wing. Sized at ~40% of the mark width.
  const doveR = size * 0.18;
  doc.lineWidth(Math.max(0.4, size * 0.018));
  doc.path(
    `M ${cx - doveR} ${cy + doveR * 0.2} ` +
      `Q ${cx} ${cy - doveR * 0.6} ${cx + doveR} ${cy + doveR * 0.2}`,
  );
  doc.stroke();
  doc.path(
    `M ${cx - doveR * 0.4} ${cy + doveR * 0.05} ` +
      `Q ${cx} ${cy - doveR * 0.1} ${cx + doveR * 0.4} ${cy + doveR * 0.05}`,
  );
  doc.stroke();

  // 3. Small gold diamond inlay at the base — the wreath stem inlay
  // from the brand spec. Drawn as a filled diamond.
  doc.save();
  const inlayR = size * 0.06;
  const inlayY = y + size - inlayR * 1.4;
  doc.fillColor(accent);
  doc
    .moveTo(cx, inlayY - inlayR)
    .lineTo(cx + inlayR, inlayY)
    .lineTo(cx, inlayY + inlayR)
    .lineTo(cx - inlayR, inlayY)
    .closePath()
    .fill();
  doc.restore();

  doc.restore();
}

/**
 * Build a PDF path string approximating a circular arc from
 * `startAngle` to `endAngle` (radians, math convention: 0 = east,
 * positive = counter-clockwise). PDFKit's `arc` API doesn't exist on
 * the document — we hand-emit cubic Bezier approximations via the
 * raw `path` API.
 *
 * For a smooth wreath silhouette we subdivide the sweep into ≤ 90°
 * Bezier segments — each segment approximates an arc with the
 * standard four-control-point cubic recipe.
 */
function arcPath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const totalSweep = endAngle - startAngle;
  const segments = Math.max(1, Math.ceil(Math.abs(totalSweep) / (Math.PI / 2)));
  const sweepPerSeg = totalSweep / segments;
  const k = (4 / 3) * Math.tan(sweepPerSeg / 4);

  let path = `M ${cx + r * Math.cos(startAngle)} ${cy - r * Math.sin(startAngle)}`;
  for (let i = 0; i < segments; i++) {
    const a0 = startAngle + i * sweepPerSeg;
    const a1 = a0 + sweepPerSeg;
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    const cp1x = x0 - k * r * Math.sin(a0);
    const cp1y = y0 - k * r * Math.cos(a0);
    const cp2x = x1 + k * r * Math.sin(a1);
    const cp2y = y1 + k * r * Math.cos(a1);
    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${x1} ${y1}`;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Letterhead block — used at the top of receipts, contracts, and
// demand letters. Layout:
//
//   ┌──────────────────────────────────────────────────────────────┐
//   │ [mark 32pt]  APOSTLE PAUL              CASES LAND INC.        │
//   │             MEMORIAL PARK              ZONE 1, SAN EUGENIO    │
//   │                                        ARINGAY, LA UNION 2503 │
//   │                                        PHILIPPINES            │
//   ├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  (gold hairline)
//   └──────────────────────────────────────────────────────────────┘
//
// After drawing, `doc.y` is moved below the header. The renderers
// continue placing content at that cursor.
// ---------------------------------------------------------------------------

interface DrawLetterheadOptions {
  /** Left margin in points. */
  marginLeft: number;
  /** Right margin in points. */
  marginRight: number;
  /** Top y in points. */
  top: number;
  /** Page width in points. */
  pageWidth: number;
  /**
   * Mark size override. Defaults to 32pt per the brand spec for
   * stationery letterheads.
   */
  markSize?: number;
}

/**
 * Render the shared brand letterhead at the page top. Returns the
 * y-coordinate below the hairline rule — the caller positions body
 * copy at or past that point.
 */
export function drawLetterhead(
  doc: PDFKitDoc,
  options: DrawLetterheadOptions,
): number {
  const { marginLeft, marginRight, top, pageWidth, markSize = 32 } = options;
  const contentWidth = pageWidth - marginLeft - marginRight;

  // Mark on the left.
  drawMark(doc, marginLeft, top, { size: markSize });

  // Wordmark to the right of the mark — serif, wide letter-spacing.
  const wordmarkX = marginLeft + markSize + 12;
  doc.save();
  doc.fillColor(BRAND.emerald);
  doc.font("Times-Roman").fontSize(14);
  doc.text(CEMETERY_NAME_LINE_1, wordmarkX, top + 2, {
    characterSpacing: 2.5,
    lineBreak: false,
  });
  doc.fillColor(BRAND.forest);
  doc.fontSize(8);
  doc.text(CEMETERY_NAME_LINE_2, wordmarkX, top + 20, {
    characterSpacing: 4,
    lineBreak: false,
  });
  doc.restore();

  // Corporate identity column on the right — mono, small, moss
  // colour, wide letter-spacing.
  const corpX = marginLeft + contentWidth - 180;
  doc.save();
  doc.fillColor(BRAND.moss);
  doc.font("Courier").fontSize(7.5);
  let corpY = top;
  for (const line of CORPORATE_IDENTITY_LINES) {
    doc.text(line, corpX, corpY, {
      width: 180,
      align: "right",
      characterSpacing: 0.6,
      lineBreak: false,
    });
    corpY += 11;
  }
  doc.restore();

  // Gold hairline rule below the header.
  const ruleY = top + markSize + 16;
  doc.save();
  doc.strokeColor(BRAND.gold);
  doc.lineWidth(0.5);
  doc
    .moveTo(marginLeft, ruleY)
    .lineTo(marginLeft + contentWidth, ruleY)
    .stroke();
  doc.restore();

  // Reset stroke + fill colours so subsequent content uses the
  // document defaults; renderers explicitly set ink for body copy.
  doc.strokeColor(BRAND.ink);
  doc.fillColor(BRAND.ink);

  // Move the document cursor below the rule with a breath of space.
  doc.x = marginLeft;
  doc.y = ruleY + 12;
  return doc.y;
}

// ---------------------------------------------------------------------------
// Ceremonial sign-off block — used at the foot of contracts and
// demand letters. Italic serif on two lines:
//
//   With reverence,
//
//   The Estate Office
//   APOSTLE PAUL MEMORIAL PARK
//
// Right-aligned inside the content column. Receipts do NOT use this
// block — they retain their BIR-mandated signatory line untouched.
// ---------------------------------------------------------------------------

interface DrawSignOffOptions {
  /** Right edge in points. */
  rightX: number;
  /** Top y to start the block. */
  top: number;
  /** Block width in points. */
  width?: number;
}

/**
 * Render the ceremonial sign-off block. Returns the y-coordinate
 * below the block.
 */
export function drawSignOff(
  doc: PDFKitDoc,
  options: DrawSignOffOptions,
): number {
  const { rightX, top, width = 220 } = options;
  const startX = rightX - width;

  doc.save();
  doc.fillColor(BRAND.forest);
  doc.font("Times-Italic").fontSize(11);
  doc.text("With reverence,", startX, top, {
    width,
    align: "right",
    lineBreak: false,
  });

  doc.fillColor(BRAND.emerald);
  doc.font("Times-Italic").fontSize(11);
  doc.text("The Estate Office", startX, top + 36, {
    width,
    align: "right",
    lineBreak: false,
  });
  doc.font("Times-Roman").fontSize(8.5);
  doc.text("APOSTLE PAUL MEMORIAL PARK", startX, top + 52, {
    width,
    align: "right",
    characterSpacing: 1.5,
    lineBreak: false,
  });
  doc.restore();

  // Restore defaults so callers don't inherit our colour state.
  doc.fillColor(BRAND.ink);
  return top + 70;
}
