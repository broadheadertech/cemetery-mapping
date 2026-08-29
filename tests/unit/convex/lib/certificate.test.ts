/**
 * Placing text on a document a family will frame.
 *
 * Two things here are worth more than the rest of the file. The
 * coordinate flip — a person places a field from the top of the page,
 * PDF measures from the bottom, and every "the name is upside-down at
 * the bottom" bug is that conversion happening twice or not at all. And
 * fractions rather than points, so a template re-uploaded at a
 * different size moves the fields proportionally instead of scattering
 * them off the page.
 *
 * The rest is about what a printed certificate must never show: a blank
 * where a detail should be, a raw `{placeholder}`, a name running
 * through the border, or an ownership claim on a lot that is still
 * being paid for.
 */

import { describe, it, expect } from "vitest";

import {
  certificateSerial,
  checkCertificateEligibility,
  drawXFor,
  fieldText,
  FIELD_KEYS,
  FIELD_LABELS,
  isFieldKey,
  MIN_FONT_SIZE,
  resolveFields,
  shrinkToFit,
  type CertificateData,
  type FieldPlacement,
} from "../../../../convex/lib/certificate";

/** A4 in PDF points. */
const PAGE = { widthPt: 595, heightPt: 842 };

const DATA: CertificateData = {
  ownerName: "Ana Reyes",
  lotCode: "A-2-01",
  section: "Garden of Faith",
  lotType: "family",
  contractNumber: "CTR-2026-0042",
  serial: "COO-2026-00007",
  issuedAt: new Date("2026-11-01T10:00:00+08:00").getTime(),
  amountPaidCents: 120_000_00,
};

function place(over: Partial<FieldPlacement> = {}): FieldPlacement {
  return {
    key: "ownerName",
    xFrac: 0.5,
    yFrac: 0.4,
    fontSize: 18,
    align: "center",
    ...over,
  };
}

describe("the coordinate flip", () => {
  it("converts distance-from-top into PDF's distance-from-bottom", () => {
    // A field placed 40% down an A4 page sits 60% up it.
    const [f] = resolveFields([place({ yFrac: 0.4 })], PAGE, DATA);
    expect(f?.yPt).toBeCloseTo(842 * 0.6, 5);
  });

  it("puts a field at the top of the page near the TOP", () => {
    // The bug this catches: a missing flip puts "near the top" at
    // yPt ≈ 0, which is the bottom of the page.
    const [f] = resolveFields([place({ yFrac: 0.05 })], PAGE, DATA);
    expect(f?.yPt).toBeGreaterThan(PAGE.heightPt * 0.9);
  });

  it("puts a field at the bottom of the page near the BOTTOM", () => {
    const [f] = resolveFields([place({ yFrac: 0.95 })], PAGE, DATA);
    expect(f?.yPt).toBeLessThan(PAGE.heightPt * 0.1);
  });

  it("does not flip x", () => {
    const [f] = resolveFields([place({ xFrac: 0.25 })], PAGE, DATA);
    expect(f?.xPt).toBeCloseTo(595 * 0.25, 5);
  });
});

describe("fractions rather than points", () => {
  it("moves a field proportionally when the page changes size", () => {
    // The reason fractions are stored. A blank re-exported at a
    // different DPI, or A4 swapped for Letter, must not leave the
    // signature line hanging off the edge.
    const p = [place({ xFrac: 0.5, yFrac: 0.5 })];
    const a4 = resolveFields(p, PAGE, DATA)[0];
    const letter = resolveFields(p, { widthPt: 612, heightPt: 792 }, DATA)[0];

    expect(a4?.xPt).toBeCloseTo(297.5, 5);
    expect(letter?.xPt).toBeCloseTo(306, 5);
    expect(a4?.yPt).toBeCloseTo(421, 5);
    expect(letter?.yPt).toBeCloseTo(396, 5);
  });

  it("clamps a fraction outside the page", () => {
    const [f] = resolveFields(
      [place({ xFrac: 1.8, yFrac: -0.3 })],
      PAGE,
      DATA,
    );
    expect(f?.xPt).toBe(PAGE.widthPt);
    expect(f?.yPt).toBe(PAGE.heightPt);
  });

  it("treats a nonsense fraction as zero rather than NaN", () => {
    const [f] = resolveFields(
      [place({ xFrac: Number.NaN, yFrac: Number.POSITIVE_INFINITY })],
      PAGE,
      DATA,
    );
    expect(Number.isFinite(f?.xPt)).toBe(true);
    expect(Number.isFinite(f?.yPt)).toBe(true);
  });
});

describe("what the fields say", () => {
  it("fills every supported key with something printable", () => {
    for (const key of FIELD_KEYS) {
      const text = fieldText(key, DATA);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("{");
      expect(text).not.toContain("undefined");
    }
  });

  it("names every key on the placement screen", () => {
    for (const key of FIELD_KEYS) {
      expect(FIELD_LABELS[key]).toBeTruthy();
    }
  });

  it("writes the date as a Manila calendar day", () => {
    // `en-PH` renders "November 1, 2026". Kept as the locale default so
    // every document the park issues — receipt, contract, certificate —
    // dates itself the same way. A formal "1 November 2026" register
    // would read better on a framed certificate, but not at the price
    // of one document disagreeing with the rest.
    expect(fieldText("issuedDate", DATA)).toBe("November 1, 2026");
  });

  it("writes pesos with centavos", () => {
    expect(fieldText("amountPaid", DATA)).toBe("₱120,000.00");
  });

  it("never leaves a placed field blank", () => {
    // A blank slot on a printed certificate reads as a fault the family
    // brings back. An em-dash reads as deliberate.
    const text = fieldText("section", { ...DATA, section: "   " });
    expect(text).toBe("—");
  });

  it("drops a field key it does not recognise", () => {
    // Rather than printing "{ownerAddress}" on a framed document.
    const resolved = resolveFields(
      [place({ key: "ownerAddress" }), place({ key: "ownerName" })],
      PAGE,
      DATA,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.key).toBe("ownerName");
  });

  it("recognises exactly the supported keys", () => {
    expect(isFieldKey("ownerName")).toBe(true);
    expect(isFieldKey("ownerAddress")).toBe(false);
  });
});

describe("alignment", () => {
  it("treats x as the left edge when left-aligned", () => {
    expect(drawXFor({ xPt: 100, align: "left" }, 80)).toBe(100);
  });

  it("treats x as the centre when centred", () => {
    // So a placed field stays put whether the name is "Li" or "Maria
    // Concepcion de los Santos".
    expect(drawXFor({ xPt: 100, align: "center" }, 80)).toBe(60);
  });

  it("treats x as the right edge when right-aligned", () => {
    expect(drawXFor({ xPt: 100, align: "right" }, 80)).toBe(20);
  });

  it("falls back to left for a nonsense alignment", () => {
    const [f] = resolveFields(
      [place({ align: "sideways" as never })],
      PAGE,
      DATA,
    );
    expect(f?.align).toBe("left");
  });
});

describe("text that is too wide", () => {
  it("leaves text alone when it fits", () => {
    const r = shrinkToFit(18, 100, 200);
    expect(r.fontSize).toBe(18);
    expect(r.fits).toBe(true);
  });

  it("leaves text alone when no width was set", () => {
    expect(shrinkToFit(18, 9999, undefined).fontSize).toBe(18);
  });

  it("shrinks a long name to fit its box", () => {
    // A name running through the border of a framed document is the
    // version the family notices.
    const r = shrinkToFit(20, 400, 200);
    expect(r.fontSize).toBe(10);
    expect(r.fits).toBe(true);
  });

  it("stops shrinking before the text becomes unreadable", () => {
    const r = shrinkToFit(20, 4000, 100);
    expect(r.fontSize).toBe(MIN_FONT_SIZE);
    expect(r.fits).toBe(false);
  });

  it("reports the overflow so the office can be told", () => {
    // At that point the template has no room and somebody needs to move
    // the field, not squint at it.
    expect(shrinkToFit(20, 4000, 100).fits).toBe(false);
  });
});

describe("who may have a certificate", () => {
  it("issues against a fully-paid contract", () => {
    expect(checkCertificateEligibility({ state: "paid_in_full" }).eligible).toBe(
      true,
    );
  });

  it("REFUSES a contract still being paid", () => {
    // A certificate says the family owns the lot outright. Issuing one
    // against an open balance puts a document in their hands that
    // contradicts the ledger — and it is the document that gets framed
    // and produced years later.
    const r = checkCertificateEligibility({ state: "active" });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("still being paid");
  });

  it("refuses a contract in default", () => {
    const r = checkCertificateEligibility({ state: "in_default" });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("default");
  });

  it("refuses a cancelled or voided contract", () => {
    expect(checkCertificateEligibility({ state: "cancelled" }).reason).toContain(
      "no ownership to certify",
    );
    expect(checkCertificateEligibility({ state: "voided" }).reason).toContain(
      "no ownership to certify",
    );
  });

  it("refuses an unknown state rather than allowing it", () => {
    const r = checkCertificateEligibility({ state: "something_new" });
    expect(r.eligible).toBe(false);
  });
});

describe("the certificate's own number", () => {
  it("carries the Manila year and a padded sequence", () => {
    expect(certificateSerial(DATA.issuedAt, 7)).toBe("COO-2026-00007");
  });

  it("is not a BIR receipt serial", () => {
    // That sequence is regulated and monotonic for reasons unrelated to
    // certificates. Borrowing from it would consume official serials
    // for a document the BIR never asked about.
    expect(certificateSerial(DATA.issuedAt, 7)).toMatch(/^COO-/);
  });

  it("starts at one for a nonsense sequence", () => {
    expect(certificateSerial(DATA.issuedAt, 0)).toBe("COO-2026-00001");
    expect(certificateSerial(DATA.issuedAt, -5)).toBe("COO-2026-00001");
  });

  it("uses the Manila year, not UTC", () => {
    // 31 December 2026, 9pm Manila is still 2026 there and already
    // 1 January in nowhere useful — but it is 13:00 UTC, so a naive
    // getFullYear() would agree by luck. This is the hour that does not:
    // 1 January 2027, 7am Manila is 31 December 2026 in UTC.
    const manilaNewYear = new Date("2027-01-01T07:00:00+08:00").getTime();
    expect(certificateSerial(manilaNewYear, 1)).toBe("COO-2027-00001");
  });
});
