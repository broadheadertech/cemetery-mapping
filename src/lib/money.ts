/**
 * Client-side money helpers — Story 1.8.
 *
 * Pesos / centavos conversion + display. All money is stored on the
 * server as INTEGER centavos (architecture § Format Patterns + ADR-0007).
 * The form layer takes peso input strings, normalises them, and
 * converts to centavos before sending to Convex.
 *
 * Why a helper module:
 *   1. Tail of the codebase: the deferred `no-cents-math` ESLint rule
 *      (Story 1.2 § TODO) will eventually fail any raw `* 100` /
 *      `/ 100` on identifiers ending in `Cents`. Centralising the
 *      conversion gets ahead of that.
 *   2. Float drift: `0.1 + 0.2 === 0.30000000000000004`. Doing the
 *      math via `Math.round(pesos * 100)` makes the rounding explicit
 *      and testable.
 *   3. Display: `Intl.NumberFormat("en-PH", { currency: "PHP" })`
 *      handles the peso sign, grouping comma, and locale-correct
 *      decimal separator in one call.
 */

const PESO_FORMATTER = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a centavo amount as a peso-prefixed string.
 *
 *   formatPeso(125_000)   →  "₱1,250.00"
 *   formatPeso(0)         →  "₱0.00"
 *   formatPeso(99)        →  "₱0.99"
 *
 * Negative amounts pass through (the formatter shows them as `-₱…`);
 * the server-side `sub` helper rejects negatives, so this case only
 * arises in display-only edge cases (e.g. credit balances later).
 */
export function formatPeso(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return PESO_FORMATTER.format(cents / 100);
}

/**
 * Parse a user-typed peso string into centavos. Tolerant of:
 *   - Peso prefix: "₱1,250.50"
 *   - Comma separators: "1,250.50"
 *   - Whitespace: "  1250.50 "
 *   - Integer pesos: "1250"
 *   - Numeric input: pesosToCents(1250.5) → 125050
 *
 * Returns NaN for unparseable inputs so the caller can surface a
 * validation error. Always uses `Math.round` to dodge float drift
 * (e.g. `0.1 + 0.2 = 0.30000000000000004` → 30, not 30.0000004).
 */
export function pesosToCents(input: number | string): number {
  let pesos: number;
  if (typeof input === "number") {
    pesos = input;
  } else {
    // Strip everything that isn't a digit, decimal point, or minus.
    const cleaned = input
      .replace(/[^\d.\-]/g, "")
      .replace(/(?!^)-/g, ""); // disallow embedded minus signs
    if (cleaned === "" || cleaned === "-" || cleaned === ".") {
      return Number.NaN;
    }
    pesos = Number.parseFloat(cleaned);
  }
  if (!Number.isFinite(pesos)) return Number.NaN;
  return Math.round(pesos * 100);
}

/**
 * Convert centavos to pesos for form-input display. The form binds
 * its input to a string; this helper produces the un-formatted peso
 * value (e.g. `1250.50`) suitable for an `<input type="text">`
 * default value. Use `formatPeso` for read-only display contexts.
 */
export function centsToPesos(cents: number): number {
  if (!Number.isFinite(cents)) return 0;
  return cents / 100;
}
