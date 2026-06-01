import { ErrorCode, throwError } from "./errors";

/**
 * BIR receipt display formatting — Story 3.11 (FR28, NFR-C1).
 *
 * Pure helper module that owns the *display* rules for the
 * BIR-compliant receipt surface. No DB access, no Convex types, no
 * side effects — every function here is a string/number → string
 * transform that can be unit-tested in isolation. The same helpers
 * are reused by the server-side render in Story 3.13's PDF action
 * later, so keeping the surface pure lets the print path produce the
 * same bytes as the HTML preview.
 *
 * Scope deviation from Story 3.11 spec (documented in Dev Agent
 * Record Completion Notes): the parent story sketched a PDFKit-based
 * generator. Per the narrowed scope for this implementation pass
 * (focus: BIR-compliant HTML *display*, PDF deferred to Story 3.13)
 * this file ships the formatting primitives + the placeholder BIR
 * config; the schema-extension / PDF action / scheduler tasks are
 * carried forward as documented dependencies, not files this slice
 * touches.
 *
 * What "BIR-compliant" means for the display layer:
 *   - The serial number (`OR-0000123`) is the legal identity. It
 *     must appear prominently and exactly as `formatSerial` produced
 *     it — never re-derived from the integer.
 *   - The cemetery's BIR-registered name + TIN + Authority-to-Print
 *     (ATP) + business address are required on every issued OR.
 *   - The customer's payable identity ("received from") must appear.
 *   - The amount in numerals AND in words is the BIR convention —
 *     prevents the "missing comma" forgery case.
 *   - VAT breakdown when the issuer is VAT-registered.
 *   - The footer disclaimer "This is an official receipt." is part
 *     of the BIR layout convention.
 *
 * The hardcoded `PLACEHOLDER_BIR_CONFIG` is a Phase-1 *truth-telling*
 * surface: every value is a recognisable placeholder so the dashboard
 * banner ("format pending BIR confirmation") never lies to staff
 * about whether the cemetery's real BIR details have been entered.
 * Once §10 Q3 lands and a future story extends `cemeterySettings`,
 * the config-load path swaps to the table read.
 */

/**
 * Display-shape for the BIR receipt configuration carried on every
 * issued Official Receipt. Mirrors the subset of the canonical
 * `birReceiptConfig` row (see `convex/schema.ts`) that downstream
 * renderers actually consume.
 *
 * The schema row carries additional operational fields
 * (`tradeName`, `atpExpiryDate`, `serialRangeStart`/`serialRangeEnd`,
 * `vatRate`) that the receipt PDF surfaces in the BIR-mandated footer;
 * `loadBirReceiptConfig` returns the full row (typed as
 * `BirReceiptConfigRow`), and this narrower display-shape is the bag
 * the render path threads through PDFKit and the HTML preview.
 */
export interface BirReceiptConfig {
  /** BIR-registered taxpayer name. */
  registeredName: string;
  /** TIN as the BIR issued it. Stored raw (digits + branch suffix); a
   * separate helper formats it for display. */
  tin: string;
  /** Authority-to-Print reference (the OCN string on the OR booklet). */
  atpNumber: string;
  /** Multi-line business address — line-feed separators preserved. */
  address: string;
  /** True when the cemetery is VAT-registered. Phase 1 placeholder is
   * false; the VAT block render is gated on this flag. */
  isVatRegistered: boolean;
  /** Printed signatory line. Placeholder until §10 Q3 confirms. */
  signatoryName: string;
  /** Printed signatory title. */
  signatoryTitle: string;
  /** Format-version tag — surfaces on the receipt footer so an auditor
   * can tell at a glance whether the receipt was issued under the
   * placeholder format or a post-§10-Q3-locked format. */
  formatVersion: string;
}

/**
 * @deprecated Replaced by the database-backed `birReceiptConfig`
 * singleton row (see `convex/schema.ts` and `loadBirReceiptConfig`
 * below). Kept exported strictly for back-compat with the receipt
 * display HTML component (`ReceiptDisplay.tsx`) which is being
 * migrated to read from the DB-loaded row; new render paths MUST NOT
 * thread this constant through PDF / receipt generation. The PDF
 * action explicitly refuses to render against any config flagged
 * `isPlaceholder: true` — using THIS constant would produce a
 * BIR-non-compliant receipt by construction (placeholder TIN,
 * placeholder ATP, missing mandatory footer).
 */
export const PLACEHOLDER_BIR_CONFIG: BirReceiptConfig = {
  registeredName: "Broadheader Memorial Park, Inc. (PLACEHOLDER)",
  tin: "000000000000",
  atpNumber: "OCN-0000000000000000",
  address:
    "123 Placeholder Street\nBarangay Placeholder\nCity, 1000\nPhilippines",
  isVatRegistered: false,
  signatoryName: "(Pending BIR confirmation)",
  signatoryTitle: "Authorized Signatory",
  formatVersion: "v1-placeholder",
};

/**
 * @deprecated Always `true`. Replaced by the per-row
 * `birReceiptConfig.isPlaceholder` boolean on the canonical singleton
 * row. New code MUST NOT branch on this constant — read the loaded
 * config's `isPlaceholder` field via `loadBirReceiptConfig` (which
 * throws when the row is missing or placeholder) instead.
 */
export const BIR_CONFIG_IS_PLACEHOLDER = true;

/**
 * Canonical row shape returned by `loadBirReceiptConfig`. Mirrors the
 * `birReceiptConfig` table validator in `convex/schema.ts` so a
 * consumer that has the loaded row can reach every BIR-required field
 * without re-querying.
 */
export interface BirReceiptConfigRow {
  registeredName: string;
  tradeName?: string;
  tin: string;
  registeredAddressLines: readonly string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate?: number;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
  updatedAt: number;
}

/**
 * Minimal Convex ctx shape `loadBirReceiptConfig` consumes — just
 * enough to query the singleton table. Typing as a structural
 * interface (rather than importing `MutationCtx` / `QueryCtx` from
 * `./auth`) keeps this module free of circular imports — the auth
 * module already imports `./errors` and any pull on `./auth` from
 * here would chain back through `auth.ts` → `errors.ts` → `birFormat.ts`.
 */
interface BirReceiptConfigCtx {
  db: {
    query: (table: "birReceiptConfig") => {
      first: () => Promise<unknown>;
    };
  };
}

/**
 * Load the canonical BIR receipt config from the `birReceiptConfig`
 * singleton table. Throws `INVARIANT_VIOLATION` with
 * `kind: "bir_not_configured"` when:
 *
 *   - the row is missing (a fresh deployment that has not yet run the
 *     `seedBirReceiptConfig` internal mutation), OR
 *   - `isPlaceholder === true` (the seed inserted a placeholder row
 *     and the admin has not yet promoted it to production-ready via
 *     the `/admin/settings/bir-receipt-config` page).
 *
 * The receipt PDF action and any other receipt-issuing path MUST call
 * this helper rather than reaching for the deprecated
 * `PLACEHOLDER_BIR_CONFIG` constant — every receipt produced from the
 * placeholder is BIR-non-compliant by construction.
 *
 * Returns the typed row including `isPlaceholder: false` (the helper
 * already filtered out placeholders) so callers can pass the row
 * straight to `formatBirReceiptFooter` and other render helpers.
 */
export async function loadBirReceiptConfig(
  ctx: BirReceiptConfigCtx,
): Promise<BirReceiptConfigRow> {
  const row = (await ctx.db
    .query("birReceiptConfig")
    .first()) as BirReceiptConfigRow | null;
  if (row === null) {
    throwBirNotConfigured(
      "BIR receipt config not initialised. Run the seedBirReceiptConfig internal mutation and complete /admin/settings/bir-receipt-config.",
      { reason: "missing_row" },
    );
  }
  if (row.isPlaceholder) {
    throwBirNotConfigured(
      "BIR receipt config is in placeholder mode. Enter real BIR-registered values via /admin/settings/bir-receipt-config and toggle production-ready.",
      { reason: "placeholder_mode" },
    );
  }
  return row;
}

/**
 * Render the BIR-mandated footer block printed at the bottom of every
 * Official Receipt. The exact text "THIS RECEIPT/INVOICE SHALL BE
 * VALID FOR FIVE (5) YEARS FROM THE DATE OF THE PERMIT TO USE." is a
 * BIR compliance requirement — never paraphrase, abbreviate, or
 * translate it.
 *
 * The block also surfaces the ATP / Permit-to-Use number and the
 * expiry date for the operator to cross-check at a glance. Returns
 * multiple lines joined by `\n`; the receipt renderer iterates the
 * lines for layout.
 */
export function formatBirReceiptFooter(config: {
  atpNumber: string;
  atpExpiryDate: number;
}): string {
  const expiryStr = formatIssuedDate(config.atpExpiryDate);
  // The BIR-mandated phrase MUST be reproduced verbatim. The ATP +
  // expiry lines below it satisfy the operator's "is the permit
  // current" cross-check.
  return [
    "THIS RECEIPT/INVOICE SHALL BE VALID FOR FIVE (5) YEARS FROM THE DATE OF THE PERMIT TO USE.",
    `Authority to Print / Permit to Use: ${config.atpNumber}`,
    `Permit expiry: ${expiryStr}`,
  ].join("\n");
}

/**
 * Local helper — throws the `INVARIANT_VIOLATION` ConvexError with
 * the `kind: "bir_not_configured"` discriminator so calling code can
 * distinguish "BIR-config missing" from other invariant violations.
 *
 * Inlined (rather than importing `throwError` from `./errors`) to
 * keep this module's import graph tight; `./errors` is fine as-is but
 * a future move of `errors.ts` shouldn't ripple through here.
 */
function throwBirNotConfigured(
  message: string,
  details: { reason: "missing_row" | "placeholder_mode" },
): never {
  throwError(ErrorCode.INVARIANT_VIOLATION, message, {
    kind: "bir_not_configured",
    ...details,
  });
}

/** Stable peso formatter — duplicated from `src/lib/money.ts` so this
 * file stays import-clean on the Convex side (the Convex runtime
 * cannot import from `src/`). */
const PESO_FORMATTER = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Manila-tz date formatter used for issued-at display. */
const MANILA_DATE_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/** Manila-tz date+time formatter used for issued-at audit display. */
const MANILA_DATETIME_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

/**
 * Format a peso centavo amount with the BIR-printable peso glyph and
 * tabular figures. Matches `src/lib/money.ts:formatPeso` so the same
 * receipt renders identically whether the consumer is a client
 * component or a server query.
 *
 *   formatPesoAmount(125_000)   →  "₱1,250.00"
 *   formatPesoAmount(0)         →  "₱0.00"
 */
export function formatPesoAmount(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return PESO_FORMATTER.format(cents / 100);
}

/**
 * Format a TIN string into the BIR-standard `XXX-XXX-XXX-XXX` shape.
 *
 * The BIR Tax Identification Number is a 12-digit string (legacy
 * 9-digit TINs are padded with `000` at the branch suffix). The
 * canonical display form groups them in 3-3-3-3.
 *
 *   formatTin("123456789000")  →  "123-456-789-000"
 *   formatTin("123-456-789-000") → "123-456-789-000"
 *   formatTin("123456789")     →  "123-456-789-000"  (legacy, padded)
 *
 * Returns the raw input when it doesn't parse — never throws, because
 * the receipt must still render even with a misconfigured TIN. A
 * config-time validator would catch the malformed value upstream; the
 * display layer is defensive.
 */
export function formatTin(tin: string): string {
  const digits = tin.replace(/\D/g, "");
  if (digits.length === 0) return tin;
  // Legacy 9-digit TINs: pad to 12 with branch suffix `000`.
  const padded = digits.length === 9 ? `${digits}000` : digits;
  if (padded.length !== 12) {
    // Unrecognised length — return the input as-is so the receipt is
    // still legible. The config validator should have caught this.
    return tin;
  }
  return `${padded.slice(0, 3)}-${padded.slice(3, 6)}-${padded.slice(6, 9)}-${padded.slice(9, 12)}`;
}

/**
 * Split an address string into an array of trimmed lines. Empty
 * trailing lines are dropped. The receipt render walks the array to
 * emit one HTML line per address line; the helper keeps the splitting
 * rule in one place.
 *
 *   formatAddressLines("Line1\nLine 2\n\nLine 3\n")
 *   → ["Line1", "Line 2", "Line 3"]
 */
export function formatAddressLines(address: string): string[] {
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Format an issued-at millisecond timestamp as a Manila-tz date string
 * matching the OR layout — e.g. `"May 15, 2026"`.
 */
export function formatIssuedDate(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return MANILA_DATE_FORMATTER.format(new Date(ms));
}

/**
 * Format an issued-at millisecond timestamp with time included — used
 * for the audit subtext under the prominent date.
 */
export function formatIssuedDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return MANILA_DATETIME_FORMATTER.format(new Date(ms));
}

/**
 * Convert a centavo amount to its English-Philippines word form, BIR
 * format: `"<integer pesos word form> pesos and <NN>/100"`. Used in
 * the "Amount in words" row that's a BIR OR convention to deter the
 * "missing comma" forgery vector.
 *
 *   formatPesoInWords(0)        → "Zero pesos and 00/100"
 *   formatPesoInWords(100)      → "One peso and 00/100"
 *   formatPesoInWords(425_075)  → "Four thousand two hundred fifty pesos and 75/100"
 *
 * The implementation is a hand-written converter (no `number-to-words`
 * dependency — the architecture's "no new runtime deps unless
 * justified" rule applies and the English-Philippines rule set is
 * small enough to inline).
 *
 * Throws on negative input — receipts represent collected money;
 * negative amounts are a category error the caller must resolve.
 */
export function formatPesoInWords(amountCents: number): string {
  if (!Number.isFinite(amountCents)) return "—";
  if (amountCents < 0) {
    throw new Error("formatPesoInWords: amount cannot be negative");
  }
  if (!Number.isInteger(amountCents)) {
    throw new Error("formatPesoInWords: amount must be integer cents");
  }
  const pesos = Math.floor(amountCents / 100);
  const cents = amountCents % 100;
  const pesoWords = integerToWords(pesos);
  const pesoLabel = pesos === 1 ? "peso" : "pesos";
  const centString = cents.toString().padStart(2, "0");
  // Capitalize the first letter of the peso word form.
  const capitalized =
    pesoWords.charAt(0).toUpperCase() + pesoWords.slice(1);
  return `${capitalized} ${pesoLabel} and ${centString}/100`;
}

/**
 * English number-to-words for non-negative integers up to 999,999,999
 * (nine digits — enough for any single transaction the cemetery will
 * ever record). Not exported because the only valid receipt-facing
 * entry point is `formatPesoInWords`.
 */
function integerToWords(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;
  if (millions > 0) {
    parts.push(`${hundredsToWords(millions)} million`);
  }
  if (thousands > 0) {
    parts.push(`${hundredsToWords(thousands)} thousand`);
  }
  if (rest > 0) {
    parts.push(hundredsToWords(rest));
  }
  return parts.join(" ");
}

/** 1..999 → words. */
function hundredsToWords(n: number): string {
  if (n === 0) return "";
  const ones = [
    "",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
  ];
  const tens = [
    "",
    "",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
  ];
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) {
    parts.push(`${ones[hundreds]} hundred`);
  }
  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(ones[remainder]!);
    } else {
      const t = Math.floor(remainder / 10);
      const o = remainder % 10;
      if (o === 0) {
        parts.push(tens[t]!);
      } else {
        parts.push(`${tens[t]}-${ones[o]}`);
      }
    }
  }
  return parts.join(" ");
}

/**
 * VAT-inclusive split. For a VAT-registered issuer, the receipt must
 * break the total into the net (VATable) sales and the VAT amount.
 * The default rate is 12% — the Philippine VAT rate.
 *
 * Returns `{ netCents, vatCents }` such that `net + vat = total` in
 * integer cents. Any remainder from the integer division goes to the
 * VAT amount (the cemetery's accountant preference is documented in
 * the ADR-0007 placeholder; the choice is reversible).
 *
 *   splitForVat(1_120)  →  { netCents: 1000, vatCents: 120 }
 *   splitForVat(0)      →  { netCents: 0, vatCents: 0 }
 *
 * Throws on negative or non-integer input — money math is integer-only.
 */
export function splitForVat(
  totalCents: number,
  vatRateBp = 1200,
): { netCents: number; vatCents: number } {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error("splitForVat: totalCents must be a non-negative integer");
  }
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0) {
    throw new Error("splitForVat: vatRateBp must be a non-negative integer");
  }
  if (totalCents === 0) return { netCents: 0, vatCents: 0 };
  // For VAT-inclusive total T at rate r (in basis points / 10000), the
  // net portion is T * 10000 / (10000 + r) and the VAT portion is the
  // remainder. Using integer arithmetic to dodge float drift.
  const denominator = 10_000 + vatRateBp;
  const netCents = Math.floor((totalCents * 10_000) / denominator);
  const vatCents = totalCents - netCents;
  return { netCents, vatCents };
}

/**
 * Friendly label for a paymentAllocations row. The receipt body
 * iterates the allocations as line items; this helper turns the
 * polymorphic `targetType` into a human-readable description without
 * the consumer having to know the discriminator vocabulary.
 *
 *   formatAllocationLabel("contract", "abc")     → "Contract payment"
 *   formatAllocationLabel("installment", "abc")  → "Installment payment"
 *   formatAllocationLabel("perpetualCare", "x")  → "Perpetual care fee"
 *   formatAllocationLabel("credit", "x")         → "Credit balance"
 */
export function formatAllocationLabel(
  targetType: "contract" | "installment" | "perpetualCare" | "credit",
  note?: string,
): string {
  const base = (() => {
    switch (targetType) {
      case "contract":
        return "Contract payment";
      case "installment":
        return "Installment payment";
      case "perpetualCare":
        return "Perpetual care fee";
      case "credit":
        return "Credit balance";
    }
  })();
  if (note !== undefined && note.trim().length > 0) {
    return `${base} — ${note.trim()}`;
  }
  return base;
}

/**
 * Human-readable label for the `payments.paymentMethod` enum.
 *
 *   formatPaymentMethod("cash")          → "Cash"
 *   formatPaymentMethod("bank_transfer") → "Bank transfer"
 */
export function formatPaymentMethod(method: string): string {
  switch (method) {
    case "cash":
      return "Cash";
    case "check":
      return "Check";
    case "bank_transfer":
      return "Bank transfer";
    case "gcash":
      return "GCash";
    case "maya":
      return "Maya";
    case "card":
      return "Card";
    default:
      return method;
  }
}
