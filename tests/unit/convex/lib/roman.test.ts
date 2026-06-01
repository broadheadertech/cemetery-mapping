/**
 * Tests for the Roman-numeral helper used by the plaque PDF
 * generator. Covers the canonical small / boundary cases plus the
 * out-of-range error path.
 */

import { describe, expect, it } from "vitest";

import { toRoman } from "../../../../convex/lib/roman";

describe("toRoman", () => {
  it("converts 1 to I", () => {
    expect(toRoman(1)).toBe("I");
  });

  it("converts 4 to IV (subtractive form)", () => {
    expect(toRoman(4)).toBe("IV");
  });

  it("converts 9 to IX (subtractive form)", () => {
    expect(toRoman(9)).toBe("IX");
  });

  it("converts 40, 90, 400, 900 to subtractive forms", () => {
    expect(toRoman(40)).toBe("XL");
    expect(toRoman(90)).toBe("XC");
    expect(toRoman(400)).toBe("CD");
    expect(toRoman(900)).toBe("CM");
  });

  it("converts 1942 to MCMXLII (brand example)", () => {
    expect(toRoman(1942)).toBe("MCMXLII");
  });

  it("converts 1999 to MCMXCIX", () => {
    expect(toRoman(1999)).toBe("MCMXCIX");
  });

  it("converts 2026 to MMXXVI (brand example)", () => {
    expect(toRoman(2026)).toBe("MMXXVI");
  });

  it("converts the upper bound 3999 to MMMCMXCIX", () => {
    expect(toRoman(3999)).toBe("MMMCMXCIX");
  });

  it("throws RangeError for 0", () => {
    expect(() => toRoman(0)).toThrow(RangeError);
  });

  it("throws RangeError for negative values", () => {
    expect(() => toRoman(-1)).toThrow(RangeError);
    expect(() => toRoman(-2026)).toThrow(RangeError);
  });

  it("throws RangeError for values greater than 3999", () => {
    expect(() => toRoman(4000)).toThrow(RangeError);
    expect(() => toRoman(99999)).toThrow(RangeError);
  });

  it("throws RangeError for non-integer values", () => {
    expect(() => toRoman(1.5)).toThrow(RangeError);
    expect(() => toRoman(Number.NaN)).toThrow(RangeError);
    expect(() => toRoman(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("produces canonical (greedy / subtractive) form, never additive", () => {
    // 1990 canonical = MCMXC, additive would be MDCCCCLXXXX
    expect(toRoman(1990)).toBe("MCMXC");
    // 1444 canonical = MCDXLIV
    expect(toRoman(1444)).toBe("MCDXLIV");
  });
});
