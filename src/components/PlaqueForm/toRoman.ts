/**
 * Client-side Roman numeral converter (Story 6.8).
 *
 * Mirrors `convex/lib/roman.ts` exactly. Duplicated rather than
 * imported because the `src/` (Next.js) and `convex/` (server)
 * module graphs do not share a tsconfig path alias — importing
 * across the boundary would force Convex's V8 bundle to ship Next.js
 * runtime deps. Both copies are tested against the same canonical
 * cases so drift is caught at unit-test time.
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

/** Convert an integer in [1, 3999] to its canonical Roman-numeral form. */
export function toRoman(n: number): string {
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return "";
  }
  if (n < 1 || n > 3999) return "";
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

/**
 * Format a plaque date band the same way `convex/actions/generatePlaquePdf.ts`
 * does — "1942 — 2026" or "MCMXLII — MMXXVI" depending on the chosen
 * format. Returns an empty string when both years are missing /
 * invalid.
 */
export function formatPlaqueDateBand(
  bornYear: number | undefined,
  diedYear: number | undefined,
  format: "arabic" | "roman",
): string {
  const bornStr = formatYear(bornYear, format);
  const diedStr = formatYear(diedYear, format);
  if (bornStr === "" && diedStr === "") return "";
  if (bornStr === "") return diedStr;
  if (diedStr === "") return bornStr;
  return `${bornStr} — ${diedStr}`;
}

function formatYear(
  year: number | undefined,
  format: "arabic" | "roman",
): string {
  if (year === undefined || !Number.isFinite(year)) return "";
  if (format === "roman") {
    const r = toRoman(year);
    return r;
  }
  return String(year);
}
