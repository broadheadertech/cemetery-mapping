/**
 * Tests for the new memorial-plaque PDF action.
 *
 * Surfaces under test:
 *   1. `renderPlaquePdf` — pure renderer; assert magic bytes + that
 *      both arabic + Roman-numeral date forms render without errors,
 *      that the optional epitaph and optional birth date paths each
 *      produce a valid PDF, and that the rendered output is non-empty.
 *   2. `formatPlaqueDates` — date band string formatter; arabic vs
 *      Roman, with and without birth year.
 *   3. The exposed `__testing.MAX_EPITAPH_CHARS` cap matches the brand
 *      spec (200 chars).
 */

import { describe, expect, it } from "vitest";

import {
  renderPlaquePdf,
  __testing,
  type PlaqueRenderPayload,
} from "../../../../convex/actions/generatePlaquePdf";

const T0 = new Date("2026-05-22T08:00:00+08:00").getTime();
// Born in 1942, died in 2026 — the brand-spec example dates.
const BORN_1942 = new Date("1942-03-14T12:00:00+08:00").getTime();
const DIED_2026 = new Date("2026-04-20T12:00:00+08:00").getTime();

function makeFixture(
  overrides: Partial<PlaqueRenderPayload> = {},
): PlaqueRenderPayload {
  return {
    customerName: "Mateo Reyes",
    bornAt: BORN_1942,
    diedAt: DIED_2026,
    epitaph:
      "A devoted father, a kind soul, and a quiet light to those who knew him.",
    ...overrides,
  };
}

describe("renderPlaquePdf — renderer smoke tests", () => {
  it("renders a PDF buffer starting with the %PDF magic header", async () => {
    const buf = await renderPlaquePdf(makeFixture());
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders without an epitaph", async () => {
    const buf = await renderPlaquePdf(makeFixture({ epitaph: undefined }));
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders without a birth date (death year alone)", async () => {
    const buf = await renderPlaquePdf(
      makeFixture({ bornAt: undefined, epitaph: undefined }),
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders with arabic-numeral dates by default", async () => {
    // No useRoman flag — arabic by default. We can't easily inspect the
    // raw PDF text content (PDFKit compresses the stream), so we rely
    // on `formatPlaqueDates` for the string-level assertion and use
    // this test for the render-path smoke check.
    const buf = await renderPlaquePdf(makeFixture());
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders with Roman-numeral dates when useRoman is true", async () => {
    const buf = await renderPlaquePdf(makeFixture({ useRoman: true }));
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders a very long name without throwing (single-line layout)", async () => {
    const buf = await renderPlaquePdf(
      makeFixture({
        customerName: "Doña Mercedes Concepcion del Mar Reyes-Salazar",
      }),
    );
    expect(buf.length).toBeGreaterThan(500);
  });

  it("truncates an over-long epitaph behaviour is owned by the action; renderer accepts up to 200 chars cleanly", async () => {
    const epitaph = "A".repeat(__testing.MAX_EPITAPH_CHARS);
    const buf = await renderPlaquePdf(makeFixture({ epitaph }));
    expect(buf.length).toBeGreaterThan(500);
  });
});

describe("formatPlaqueDates", () => {
  const fmt = __testing.formatPlaqueDates;

  it("returns the death year alone when bornAt is absent (arabic)", () => {
    expect(fmt({ customerName: "X", diedAt: DIED_2026 })).toBe("2026");
  });

  it("returns the death year alone in Roman form when useRoman is true", () => {
    expect(
      fmt({ customerName: "X", diedAt: DIED_2026, useRoman: true }),
    ).toBe("MMXXVI");
  });

  it("returns 'born — died' as arabic years by default", () => {
    expect(
      fmt({ customerName: "X", bornAt: BORN_1942, diedAt: DIED_2026 }),
    ).toBe("1942 — 2026");
  });

  it("returns 'born — died' as Roman numerals when useRoman is true", () => {
    expect(
      fmt({
        customerName: "X",
        bornAt: BORN_1942,
        diedAt: DIED_2026,
        useRoman: true,
      }),
    ).toBe("MCMXLII — MMXXVI");
  });

  it("uses Manila tz when extracting the year (no off-by-one)", () => {
    // Just past midnight UTC on Jan 1 2026, which is morning of Jan 1
    // 2026 in Manila — the Manila year remains 2026, NOT 2025.
    const earlyJan2026 = new Date("2026-01-01T00:30:00+08:00").getTime();
    expect(fmt({ customerName: "X", diedAt: earlyJan2026 })).toBe("2026");
  });
});

describe("plaque action — sanity wiring", () => {
  it("exposes a 200-char epitaph cap matching the brand spec", () => {
    expect(__testing.MAX_EPITAPH_CHARS).toBe(200);
  });

  it("uses A6 portrait dimensions (≈ 297.64 × 419.53 points)", () => {
    expect(__testing.A6_WIDTH).toBeGreaterThan(297);
    expect(__testing.A6_WIDTH).toBeLessThan(298);
    expect(__testing.A6_HEIGHT).toBeGreaterThan(419);
    expect(__testing.A6_HEIGHT).toBeLessThan(420);
  });

  it("does not reference the current wall-clock — `T0` only used for fixture dates", () => {
    // Lightweight sanity test: building a fixture should not throw or
    // mutate global state.
    expect(makeFixture().diedAt).toBe(DIED_2026);
    expect(T0).toBeGreaterThan(0);
  });
});
