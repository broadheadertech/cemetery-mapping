/**
 * Story 3.11 — `convex/lib/birFormat.ts` unit tests.
 *
 * Pure-function helpers; no Convex ctx mocking required. Each helper
 * is small enough to enumerate the meaningful cases.
 */

import { ConvexError, type Value } from "convex/values";
import { describe, expect, it } from "vitest";

import {
  BIR_CONFIG_IS_PLACEHOLDER,
  PLACEHOLDER_BIR_CONFIG,
  formatAddressLines,
  formatAllocationLabel,
  formatBirReceiptFooter,
  formatIssuedDate,
  formatIssuedDateTime,
  formatPaymentMethod,
  formatPesoAmount,
  formatPesoInWords,
  formatTin,
  loadBirReceiptConfig,
  splitForVat,
  type BirReceiptConfigRow,
} from "../../../../convex/lib/birFormat";
import {
  ErrorCode,
  type ErrorPayload,
} from "../../../../convex/lib/errors";

describe("PLACEHOLDER_BIR_CONFIG", () => {
  it("is flagged as a placeholder", () => {
    expect(BIR_CONFIG_IS_PLACEHOLDER).toBe(true);
  });
  it("carries the v1-placeholder formatVersion", () => {
    expect(PLACEHOLDER_BIR_CONFIG.formatVersion).toBe("v1-placeholder");
  });
  it("declares the cemetery as non-VAT-registered in Phase 1", () => {
    expect(PLACEHOLDER_BIR_CONFIG.isVatRegistered).toBe(false);
  });
  it("uses recognisable placeholder values (audit truth-telling)", () => {
    expect(PLACEHOLDER_BIR_CONFIG.tin).toMatch(/^0+$/);
    expect(PLACEHOLDER_BIR_CONFIG.atpNumber).toContain("0000");
    expect(PLACEHOLDER_BIR_CONFIG.registeredName).toContain("PLACEHOLDER");
  });
});

describe("formatPesoAmount", () => {
  it("formats common amounts with peso glyph", () => {
    expect(formatPesoAmount(0)).toBe("₱0.00");
    expect(formatPesoAmount(100)).toBe("₱1.00");
    expect(formatPesoAmount(125_000)).toBe("₱1,250.00");
    expect(formatPesoAmount(99)).toBe("₱0.99");
  });
  it("returns dash for non-finite input", () => {
    expect(formatPesoAmount(Number.NaN)).toBe("—");
    expect(formatPesoAmount(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatTin", () => {
  it("groups 12-digit raw TINs in 3-3-3-3", () => {
    expect(formatTin("123456789000")).toBe("123-456-789-000");
  });
  it("re-groups pre-formatted TINs", () => {
    expect(formatTin("123-456-789-000")).toBe("123-456-789-000");
  });
  it("pads legacy 9-digit TINs with branch suffix 000", () => {
    expect(formatTin("123456789")).toBe("123-456-789-000");
  });
  it("returns the placeholder all-zero TIN grouped", () => {
    expect(formatTin("000000000000")).toBe("000-000-000-000");
  });
  it("returns the input unchanged when length doesn't match", () => {
    expect(formatTin("12345")).toBe("12345");
    expect(formatTin("abc")).toBe("abc");
  });
  it("returns the input when empty/no-digits", () => {
    expect(formatTin("")).toBe("");
    expect(formatTin("---")).toBe("---");
  });
});

describe("formatAddressLines", () => {
  it("splits on newlines and trims", () => {
    expect(formatAddressLines("Line1\nLine 2")).toEqual([
      "Line1",
      "Line 2",
    ]);
  });
  it("drops empty trailing lines", () => {
    expect(formatAddressLines("Line1\n\nLine 2\n")).toEqual([
      "Line1",
      "Line 2",
    ]);
  });
  it("handles Windows line endings", () => {
    expect(formatAddressLines("Line1\r\nLine 2\r\n")).toEqual([
      "Line1",
      "Line 2",
    ]);
  });
  it("returns an empty array on empty input", () => {
    expect(formatAddressLines("")).toEqual([]);
  });
});

describe("formatIssuedDate / formatIssuedDateTime", () => {
  // 2026-05-15 noon Manila — middle of May 2026.
  const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();
  it("formats the date in Manila tz", () => {
    expect(formatIssuedDate(T0)).toMatch(/May 15, 2026/);
  });
  it("formats the date+time in Manila tz", () => {
    expect(formatIssuedDateTime(T0)).toMatch(/May 15, 2026/);
    expect(formatIssuedDateTime(T0)).toMatch(/12:00/);
  });
  it("returns dash for non-finite input", () => {
    expect(formatIssuedDate(Number.NaN)).toBe("—");
    expect(formatIssuedDateTime(Number.NaN)).toBe("—");
  });
});

describe("formatPesoInWords", () => {
  it("handles zero", () => {
    expect(formatPesoInWords(0)).toBe("Zero pesos and 00/100");
  });
  it("singularises one peso", () => {
    expect(formatPesoInWords(100)).toBe("One peso and 00/100");
  });
  it("handles centavos only", () => {
    expect(formatPesoInWords(75)).toBe("Zero pesos and 75/100");
    expect(formatPesoInWords(1)).toBe("Zero pesos and 01/100");
  });
  it("formats mid-sized amounts", () => {
    expect(formatPesoInWords(425_075)).toBe(
      "Four thousand two hundred fifty pesos and 75/100",
    );
  });
  it("formats one thousand pesos plus one centavo", () => {
    expect(formatPesoInWords(100_001)).toBe(
      "One thousand pesos and 01/100",
    );
  });
  it("formats hyphenated tens", () => {
    expect(formatPesoInWords(4_200)).toBe(
      "Forty-two pesos and 00/100",
    );
  });
  it("handles teen numbers", () => {
    expect(formatPesoInWords(1_300)).toBe("Thirteen pesos and 00/100");
    expect(formatPesoInWords(1_900)).toBe("Nineteen pesos and 00/100");
  });
  it("formats millions", () => {
    expect(formatPesoInWords(1_000_000_00)).toBe(
      "One million pesos and 00/100",
    );
  });
  it("formats compound thousands + hundreds", () => {
    expect(formatPesoInWords(2_500_00)).toBe(
      "Two thousand five hundred pesos and 00/100",
    );
  });
  it("throws on negative input", () => {
    expect(() => formatPesoInWords(-1)).toThrow(/negative/);
  });
  it("throws on non-integer input", () => {
    expect(() => formatPesoInWords(1.5)).toThrow(/integer/);
  });
  it("returns dash for non-finite input", () => {
    expect(formatPesoInWords(Number.NaN)).toBe("—");
  });
});

describe("splitForVat", () => {
  it("returns zero for zero total", () => {
    expect(splitForVat(0)).toEqual({ netCents: 0, vatCents: 0 });
  });
  it("splits a clean 1120 cents into 1000 + 120 at 12%", () => {
    expect(splitForVat(1_120)).toEqual({ netCents: 1000, vatCents: 120 });
  });
  it("places the remainder cents into the VAT amount", () => {
    const result = splitForVat(1_001);
    expect(result.netCents + result.vatCents).toBe(1_001);
    expect(result.vatCents).toBeGreaterThan(0);
  });
  it("accepts a custom VAT rate in basis points", () => {
    // 0% VAT → all to net.
    expect(splitForVat(1_000, 0)).toEqual({ netCents: 1000, vatCents: 0 });
  });
  it("throws on negative input", () => {
    expect(() => splitForVat(-1)).toThrow();
  });
  it("throws on non-integer input", () => {
    expect(() => splitForVat(1.5)).toThrow();
  });
  it("throws on negative VAT rate", () => {
    expect(() => splitForVat(100, -1)).toThrow();
  });
});

describe("formatAllocationLabel", () => {
  it("labels every target kind", () => {
    expect(formatAllocationLabel("contract")).toBe("Contract payment");
    expect(formatAllocationLabel("installment")).toBe(
      "Installment payment",
    );
    expect(formatAllocationLabel("perpetualCare")).toBe(
      "Perpetual care fee",
    );
    expect(formatAllocationLabel("credit")).toBe("Credit balance");
  });
  it("appends the note when present", () => {
    expect(
      formatAllocationLabel("installment", "Installment #3"),
    ).toBe("Installment payment — Installment #3");
  });
  it("trims and ignores empty notes", () => {
    expect(formatAllocationLabel("contract", "   ")).toBe(
      "Contract payment",
    );
  });
});

describe("formatPaymentMethod", () => {
  it("labels every Phase 1 method", () => {
    expect(formatPaymentMethod("cash")).toBe("Cash");
    expect(formatPaymentMethod("check")).toBe("Check");
    expect(formatPaymentMethod("bank_transfer")).toBe("Bank transfer");
    expect(formatPaymentMethod("gcash")).toBe("GCash");
    expect(formatPaymentMethod("maya")).toBe("Maya");
    expect(formatPaymentMethod("card")).toBe("Card");
  });
  it("passes through unknown methods (defensive)", () => {
    expect(formatPaymentMethod("crypto")).toBe("crypto");
  });
});

// =====================================================================
// loadBirReceiptConfig — DB-backed loader with placeholder gating.
// =====================================================================

describe("loadBirReceiptConfig", () => {
  function makeCtx(row: BirReceiptConfigRow | null) {
    return {
      db: {
        query: (table: "birReceiptConfig") => {
          expect(table).toBe("birReceiptConfig");
          return {
            first: async () => row,
          };
        },
      },
    };
  }

  const realRow: BirReceiptConfigRow = {
    registeredName: "Cases Land Inc.",
    tin: "123456789000",
    registeredAddressLines: ["Zone 1, San Eugenio", "Aringay, La Union"],
    atpNumber: "OCN-12345678901234",
    atpExpiryDate: new Date("2030-01-01T00:00:00+08:00").getTime(),
    serialRangeStart: "0000001",
    serialRangeEnd: "9999999",
    isVatRegistered: false,
    isPlaceholder: false,
    updatedAt: 0,
  };

  it("returns the row when present and not placeholder", async () => {
    const row = await loadBirReceiptConfig(makeCtx(realRow));
    expect(row.registeredName).toBe("Cases Land Inc.");
    expect(row.isPlaceholder).toBe(false);
  });

  it("throws INVARIANT_VIOLATION with kind:bir_not_configured when row is missing", async () => {
    let caught: unknown = null;
    try {
      await loadBirReceiptConfig(makeCtx(null));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    const payload = (caught as ConvexError<Value>)
      .data as unknown as ErrorPayload;
    expect(payload.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect((payload.details as { kind: string }).kind).toBe(
      "bir_not_configured",
    );
    expect((payload.details as { reason: string }).reason).toBe(
      "missing_row",
    );
  });

  it("throws INVARIANT_VIOLATION when row is placeholder", async () => {
    let caught: unknown = null;
    try {
      await loadBirReceiptConfig(
        makeCtx({ ...realRow, isPlaceholder: true }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    const payload = (caught as ConvexError<Value>)
      .data as unknown as ErrorPayload;
    expect(payload.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect((payload.details as { reason: string }).reason).toBe(
      "placeholder_mode",
    );
  });
});

// =====================================================================
// formatBirReceiptFooter — BIR-mandated 5-year-validity disclosure.
// =====================================================================

describe("formatBirReceiptFooter", () => {
  it("includes the verbatim 5-year-validity sentence", () => {
    const out = formatBirReceiptFooter({
      atpNumber: "OCN-12345678901234",
      atpExpiryDate: new Date("2030-01-01T00:00:00+08:00").getTime(),
    });
    expect(out).toContain(
      "THIS RECEIPT/INVOICE SHALL BE VALID FOR FIVE (5) YEARS FROM THE DATE OF THE PERMIT TO USE.",
    );
  });

  it("surfaces the ATP number and expiry date", () => {
    const out = formatBirReceiptFooter({
      atpNumber: "OCN-12345678901234",
      atpExpiryDate: new Date("2030-01-01T00:00:00+08:00").getTime(),
    });
    expect(out).toContain("OCN-12345678901234");
    expect(out).toMatch(/Jan 01, 2030|Dec 31, 2029/);
  });
});
