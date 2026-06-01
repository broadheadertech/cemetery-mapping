/**
 * Client-side money helpers — Story 1.8 unit tests.
 *
 * Coverage target: ≥ 90% (NFR-M2 — `basePriceCents` is financial).
 * Float-drift edge cases are the highlight; they are why the helpers
 * exist in the first place.
 */

import { describe, expect, it } from "vitest";

import {
  centsToPesos,
  formatPeso,
  pesosToCents,
} from "../../../src/lib/money";

describe("formatPeso", () => {
  it("formats whole pesos with the peso prefix", () => {
    // The Node Intl impl uses the non-breaking-space variant of the
    // peso prefix on en-PH. Test for the digits + decimal pattern
    // rather than asserting the exact prefix glyph.
    const out = formatPeso(125_000);
    expect(out).toContain("1,250.00");
  });

  it("formats sub-peso amounts as 0.xx", () => {
    expect(formatPeso(99)).toContain("0.99");
  });

  it("formats zero", () => {
    expect(formatPeso(0)).toContain("0.00");
  });

  it("returns an em-dash placeholder for non-finite input", () => {
    expect(formatPeso(Number.NaN)).toBe("—");
    expect(formatPeso(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("pesosToCents", () => {
  it("parses an integer peso string", () => {
    expect(pesosToCents("1250")).toBe(125_000);
  });

  it("parses a decimal peso string", () => {
    expect(pesosToCents("1250.50")).toBe(125_050);
  });

  it("strips peso prefix and comma separators", () => {
    expect(pesosToCents("₱1,250.50")).toBe(125_050);
  });

  it("strips whitespace", () => {
    expect(pesosToCents("  1250.50  ")).toBe(125_050);
  });

  it("returns NaN for empty or non-numeric input", () => {
    expect(pesosToCents("")).toBeNaN();
    expect(pesosToCents("abc")).toBeNaN();
    expect(pesosToCents(".")).toBeNaN();
    expect(pesosToCents("-")).toBeNaN();
  });

  it("accepts numeric input directly", () => {
    expect(pesosToCents(1250.5)).toBe(125_050);
    expect(pesosToCents(0)).toBe(0);
  });

  it("rounds 0.1 + 0.2 to 30 cents (no float drift)", () => {
    // 0.1 + 0.2 === 0.30000000000000004; Math.round(x * 100) yields 30.
    expect(pesosToCents(0.1 + 0.2)).toBe(30);
  });

  it("rounds 1.99 cleanly to 199 cents", () => {
    expect(pesosToCents(1.99)).toBe(199);
    expect(pesosToCents("1.99")).toBe(199);
  });

  it("rounds 1.999 to 200 cents (banker-friendly half-up rounding)", () => {
    expect(pesosToCents(1.999)).toBe(200);
  });

  it("rejects embedded minus signs", () => {
    // "-1250.50" → cleaned to "-1250.50" → -125050. But "12-50" →
    // we strip embedded minuses → "1250" → 125000.
    expect(pesosToCents("12-50")).toBe(125_000);
  });

  it("preserves a single leading minus (display-only credit balances)", () => {
    expect(pesosToCents("-1250")).toBe(-125_000);
  });

  it("returns NaN for non-finite numeric input", () => {
    expect(pesosToCents(Number.NaN)).toBeNaN();
    expect(pesosToCents(Number.POSITIVE_INFINITY)).toBeNaN();
  });
});

describe("centsToPesos", () => {
  it("divides by 100", () => {
    expect(centsToPesos(125_050)).toBe(1250.5);
  });

  it("handles zero", () => {
    expect(centsToPesos(0)).toBe(0);
  });

  it("returns 0 for non-finite input", () => {
    expect(centsToPesos(Number.NaN)).toBe(0);
  });
});

describe("round-trip property", () => {
  it("pesosToCents(centsToPesos(N)) === N for integer N", () => {
    for (const cents of [0, 1, 99, 100, 12_345, 1_234_567, 99_999_999]) {
      expect(pesosToCents(centsToPesos(cents))).toBe(cents);
    }
  });
});
