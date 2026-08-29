/**
 * Where each detail goes on the park's certificate, and what it says.
 *
 * The cemetery uploads its own blank — letterhead, border, seal,
 * signature blocks, and whatever wording its lawyer approved — and then
 * says where the owner's name goes on it. This module owns the two
 * things that can quietly ruin that:
 *
 *   1. **The coordinate flip.** A person placing a field thinks in
 *      distance from the TOP of the page. PDF measures from the bottom.
 *      Every "why is the name upside-down at the bottom" bug is this
 *      conversion happening twice, or not at all. It happens HERE, once,
 *      and it is tested.
 *
 *   2. **Fractions, not points.** Placements are stored as 0–1 fractions
 *      of the page. A template re-uploaded at a different DPI, or an A4
 *      blank replaced with Letter, then moves every field proportionally
 *      instead of scattering them off the page.
 *
 * Pure arithmetic — no database, no clock, no PDF library. Everything is
 * passed in.
 */

/** The details a certificate can carry. */
export const FIELD_KEYS = [
  "ownerName",
  "lotCode",
  "section",
  "lotType",
  "contractNumber",
  "serial",
  "issuedDate",
  "amountPaid",
] as const;

export type FieldKey = (typeof FIELD_KEYS)[number];

/** What each field is called on the placement screen. */
export const FIELD_LABELS: Record<FieldKey, string> = {
  ownerName: "Owner's name",
  lotCode: "Lot",
  section: "Garden",
  lotType: "Lot type",
  contractNumber: "Contract number",
  serial: "Certificate number",
  issuedDate: "Date issued",
  amountPaid: "Amount paid",
};

export type Align = "left" | "center" | "right";

export interface FieldPlacement {
  key: string;
  /** 0–1 across the page, from the left. */
  xFrac: number;
  /** 0–1 down the page, from the TOP. */
  yFrac: number;
  fontSize: number;
  align: Align;
  /** 0–1 of the page width. Text wider than this is shrunk to fit. */
  maxWidthFrac?: number;
}

/** A placement resolved to PDF points, ready to draw. */
export interface ResolvedField {
  key: FieldKey;
  text: string;
  /** Points from the left edge. */
  xPt: number;
  /**
   * Points from the BOTTOM edge — PDF's own origin, and the baseline
   * the text sits on. Converted from `yFrac` exactly once.
   */
  yPt: number;
  fontSize: number;
  align: Align;
  maxWidthPt?: number;
}

export interface CertificateData {
  ownerName: string;
  lotCode: string;
  section: string;
  lotType: string;
  contractNumber: string;
  serial: string;
  /** Epoch ms. Rendered as a Manila calendar date. */
  issuedAt: number;
  amountPaidCents: number;
}

export function isFieldKey(value: string): value is FieldKey {
  return (FIELD_KEYS as readonly string[]).includes(value);
}

/**
 * The text for one field.
 *
 * Never returns an empty string for a field that was placed — an empty
 * slot on a printed certificate reads as an error the family will bring
 * back, whereas an em-dash reads as "not applicable" and is at least
 * deliberate.
 */
export function fieldText(key: FieldKey, data: CertificateData): string {
  switch (key) {
    case "ownerName":
      return nonEmpty(data.ownerName);
    case "lotCode":
      return nonEmpty(data.lotCode);
    case "section":
      return nonEmpty(data.section);
    case "lotType":
      return nonEmpty(titleCase(data.lotType));
    case "contractNumber":
      return nonEmpty(data.contractNumber);
    case "serial":
      return nonEmpty(data.serial);
    case "issuedDate":
      return formatManilaDate(data.issuedAt);
    case "amountPaid":
      return formatPeso(data.amountPaidCents);
  }
}

/**
 * Turn stored placements into points on a specific page.
 *
 * The page size is the one the PDF actually has NOW, not the one that
 * was stored — that is the whole reason fractions are stored. A
 * template swapped from A4 to Letter shifts every field proportionally
 * rather than leaving the signature line hanging off the edge.
 *
 * Placements whose key is not recognised are dropped rather than drawn
 * as raw text: a stale field left over from an earlier version of this
 * list should vanish, not print "{ownerAddress}" on a framed document.
 */
export function resolveFields(
  placements: FieldPlacement[],
  page: { widthPt: number; heightPt: number },
  data: CertificateData,
): ResolvedField[] {
  const out: ResolvedField[] = [];
  for (const p of placements) {
    if (!isFieldKey(p.key)) continue;

    const xFrac = clamp01(p.xFrac);
    const yFrac = clamp01(p.yFrac);
    const fontSize = normaliseFontSize(p.fontSize);

    const field: ResolvedField = {
      key: p.key,
      text: fieldText(p.key, data),
      xPt: xFrac * page.widthPt,
      // The flip. `yFrac` is measured DOWN from the top; PDF measures UP
      // from the bottom. This subtraction is the only place the two
      // conventions meet.
      yPt: page.heightPt - yFrac * page.heightPt,
      fontSize,
      align: p.align === "center" || p.align === "right" ? p.align : "left",
    };
    if (p.maxWidthFrac !== undefined) {
      const w = clamp01(p.maxWidthFrac);
      if (w > 0) field.maxWidthPt = w * page.widthPt;
    }
    out.push(field);
  }
  return out;
}

/**
 * Where to start drawing, given the alignment.
 *
 * `xPt` is the ANCHOR, not always the left edge: for a centred field it
 * is the centre of the text, for a right-aligned one the right edge.
 * That is what makes a placed field stay put when the owner's name is
 * "Li" one week and "Maria Concepcion de los Santos" the next.
 */
export function drawXFor(
  field: { xPt: number; align: Align },
  textWidthPt: number,
): number {
  if (field.align === "center") return field.xPt - textWidthPt / 2;
  if (field.align === "right") return field.xPt - textWidthPt;
  return field.xPt;
}

/**
 * Shrink the font until the text fits the field's width.
 *
 * Overflow on a certificate is not a cosmetic problem: a long name
 * running through the border of a framed document is the version the
 * family notices. Shrinking is the lesser evil, floored so it never
 * becomes unreadable — past that the office needs to know the template
 * has no room, which `fitsAt` reports.
 */
export const MIN_FONT_SIZE = 6;

export function shrinkToFit(
  fontSize: number,
  textWidthAtSize: number,
  maxWidthPt: number | undefined,
): { fontSize: number; fits: boolean } {
  const start = normaliseFontSize(fontSize);
  if (
    maxWidthPt === undefined ||
    maxWidthPt <= 0 ||
    textWidthAtSize <= maxWidthPt ||
    textWidthAtSize <= 0
  ) {
    return { fontSize: start, fits: true };
  }
  // Text width scales linearly with font size, so the ratio gives the
  // size that just fits without measuring again.
  const scaled = Math.floor((start * maxWidthPt) / textWidthAtSize);
  if (scaled >= MIN_FONT_SIZE) return { fontSize: scaled, fits: true };
  return { fontSize: MIN_FONT_SIZE, fits: false };
}

/**
 * Whether a contract may have a certificate of ownership.
 *
 * Paid in full and nothing else. A certificate says the family owns the
 * lot outright, so issuing one against an active instalment contract
 * would put a document in their hands that contradicts the balance they
 * still owe — and it is the document, not the ledger, that gets framed
 * and produced years later.
 */
export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

export function checkCertificateEligibility(contract: {
  state: string;
}): EligibilityResult {
  if (contract.state === "paid_in_full") return { eligible: true };

  const reasons: Record<string, string> = {
    active:
      "This contract is still being paid. A certificate of ownership can be issued once the balance is settled.",
    in_default:
      "This contract is in default. Settle or resolve it before issuing a certificate.",
    cancelled: "This contract was cancelled — there is no ownership to certify.",
    voided: "This contract was voided — there is no ownership to certify.",
  };
  return {
    eligible: false,
    reason:
      reasons[contract.state] ??
      "Only a fully-paid contract can carry a certificate of ownership.",
  };
}

/**
 * A certificate's human reference.
 *
 * Deliberately NOT the BIR receipt counter. That sequence is regulated,
 * audited, and monotonic for reasons that have nothing to do with
 * certificates; borrowing from it would consume official serials for a
 * document the BIR never asked about.
 */
export function certificateSerial(
  issuedAt: number,
  sequence: number,
): string {
  const year = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
  }).format(new Date(issuedAt));
  return `COO-${year}-${String(Math.max(1, Math.floor(sequence))).padStart(5, "0")}`;
}

// --- helpers ----------------------------------------------------------

function clamp01(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normaliseFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 12;
  return Math.min(96, Math.max(MIN_FONT_SIZE, Math.round(value)));
}

/** An em-dash reads as "not applicable"; a blank reads as a fault. */
function nonEmpty(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : "—";
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function formatManilaDate(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

/**
 * Pesos for a printed certificate.
 *
 * `src/lib/money.ts` owns display formatting everywhere else, but it
 * lives under `src/` and the Convex bundler will not pull that across.
 */
function formatPeso(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  const whole = Math.floor(Math.abs(cents) / 100);
  const part = Math.abs(cents) % 100;
  return `₱${whole.toLocaleString("en-PH")}.${String(part).padStart(2, "0")}`;
}
