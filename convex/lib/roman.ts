/**
 * Roman-numeral conversion helper — supports plaque date rendering for
 * the Apostle Paul Memorial Park brand. The plaque template (see
 * `convex/actions/generatePlaquePdf.ts`) renders memorial dates in
 * Roman numerals when `useRoman: true` (e.g. `MCMXLII — MMXXVI`); when
 * `useRoman: false` the same dates render as arabic years (`1942 —
 * 2026`).
 *
 * Pure helper — no side effects, no external imports, deliberately
 * untouched by `"use node"`. Lives in `convex/lib` so the action
 * bundle and any future surface (e.g. an admin preview component on
 * the V8 side) can both reach it.
 *
 * Range: 1 .. 3999 inclusive. This is the canonical range of Roman
 * numerals as classically expressed (3999 = `MMMCMXCIX`). Inputs of
 * 0, negative numbers, non-integers, or numbers > 3999 throw a
 * `RangeError` rather than silently producing garbage — the plaque
 * generator's call site treats such inputs as a programmer error
 * (the caller decides whether to fall back to arabic numerals or
 * reject the request before invoking `toRoman`).
 */

/**
 * Glyph table — ordered from largest to smallest. The standard
 * subtractive-form table includes IV / IX / XL / XC / CD / CM so the
 * greedy walk produces canonical numerals (1999 → `MCMXCIX`, never
 * `MDCCCCLXXXXVIIII`).
 */
const ROMAN_GLYPHS: ReadonlyArray<readonly [number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/**
 * Convert a positive integer in `[1, 3999]` to its canonical Roman-
 * numeral form. Throws `RangeError` for values outside that range or
 * for non-integer / non-finite inputs.
 *
 *   toRoman(1)    → "I"
 *   toRoman(4)    → "IV"
 *   toRoman(9)    → "IX"
 *   toRoman(1942) → "MCMXLII"
 *   toRoman(1999) → "MCMXCIX"
 *   toRoman(2026) → "MMXXVI"
 *   toRoman(3999) → "MMMCMXCIX"
 *   toRoman(0)    → throws RangeError
 *   toRoman(4000) → throws RangeError
 */
export function toRoman(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new RangeError(
      `toRoman: expected a finite integer, received ${String(n)}`,
    );
  }
  if (n < 1 || n > 3999) {
    throw new RangeError(
      `toRoman: value out of range (1..3999), received ${n}`,
    );
  }

  let remainder = n;
  let out = "";
  for (const [value, glyph] of ROMAN_GLYPHS) {
    while (remainder >= value) {
      out += glyph;
      remainder -= value;
    }
  }
  return out;
}
