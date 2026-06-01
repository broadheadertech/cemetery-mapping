/**
 * Story 3.4 — `src/components/InstallmentSchedule/` unit tests.
 *
 * Coverage:
 *   - `generateInstallmentSchedule` math is cents-precise (the NFR-M2
 *     ≥ 90% gate); remainder cents land on the FINAL row.
 *   - `addMonthsClamped` clamps Jan 31 → Feb 28 / 29, advances Mar 15 →
 *     May 15, and crosses year boundaries cleanly.
 *   - `<InstallmentSchedule />` renders the correct row count, updates
 *     live when props change, and shows the empty / error states.
 */

import { describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import {
  InstallmentSchedule,
  addMonthsClamped,
  generateInstallmentSchedule,
} from "../../../src/components/InstallmentSchedule";

afterEach(() => {
  cleanup();
});

// 17 May 2026 at Manila midnight (UTC+8) — a stable test anchor.
const MANILA_MIDNIGHT_2026_05_17 = new Date(
  "2026-05-17T00:00:00+08:00",
).getTime();

// 17 June 2026 — the canonical "one month later" anchor used by the
// schedule-date tests below.
const MANILA_MIDNIGHT_2026_06_17 = new Date(
  "2026-06-17T00:00:00+08:00",
).getTime();

describe("generateInstallmentSchedule", () => {
  it("distributes integer principal evenly with no remainder", () => {
    const result = generateInstallmentSchedule({
      totalPriceCents: 120_000_00, // ₱120,000.00
      downPaymentCents: 0,
      termMonths: 12,
      firstDueDate: MANILA_MIDNIGHT_2026_06_17,
    });
    expect(result.rows).toHaveLength(12);
    expect(result.monthlyAmountCents).toBe(10_000_00);
    for (const row of result.rows) {
      expect(row.principalCents).toBe(10_000_00);
    }
    const sum = result.rows.reduce((acc, r) => acc + r.principalCents, 0);
    expect(sum).toBe(120_000_00);
  });

  it("puts remainder cents on the FINAL installment", () => {
    // 100,001 cents over 12 months → quotient 8333, remainder 5.
    // 11 rows of 8333 + 1 row of 8338 (final).
    const result = generateInstallmentSchedule({
      totalPriceCents: 100_001,
      downPaymentCents: 0,
      termMonths: 12,
      firstDueDate: MANILA_MIDNIGHT_2026_06_17,
    });
    expect(result.rows).toHaveLength(12);
    expect(result.monthlyAmountCents).toBe(8333);
    for (let i = 0; i < 11; i++) {
      expect(result.rows[i]!.principalCents).toBe(8333);
    }
    expect(result.rows[11]!.principalCents).toBe(8338);
    const sum = result.rows.reduce((acc, r) => acc + r.principalCents, 0);
    expect(sum).toBe(100_001);
  });

  it("handles down payment + 24 months + remainder", () => {
    // Total 200,000 — down 50,000 — principal 150,000 / 24 = 6,250 even.
    const result = generateInstallmentSchedule({
      totalPriceCents: 200_000_00,
      downPaymentCents: 50_000_00,
      termMonths: 24,
      firstDueDate: MANILA_MIDNIGHT_2026_06_17,
    });
    expect(result.rows).toHaveLength(24);
    expect(result.monthlyAmountCents).toBe(6_250_00);
    const sum = result.rows.reduce((acc, r) => acc + r.principalCents, 0);
    expect(sum).toBe(150_000_00);
  });

  it("upper-bound term 60 months distributes remainder correctly", () => {
    const result = generateInstallmentSchedule({
      totalPriceCents: 1_000_001,
      downPaymentCents: 0,
      termMonths: 60,
      firstDueDate: MANILA_MIDNIGHT_2026_06_17,
    });
    expect(result.rows).toHaveLength(60);
    // quotient = floor(1_000_001 / 60) = 16_666; remainder = 41
    expect(result.monthlyAmountCents).toBe(16_666);
    for (let i = 0; i < 59; i++) {
      expect(result.rows[i]!.principalCents).toBe(16_666);
    }
    expect(result.rows[59]!.principalCents).toBe(16_666 + 41);
    const sum = result.rows.reduce((acc, r) => acc + r.principalCents, 0);
    expect(sum).toBe(1_000_001);
  });

  it("assigns dueDates advanced one calendar month at a time", () => {
    const result = generateInstallmentSchedule({
      totalPriceCents: 120_000_00,
      downPaymentCents: 0,
      termMonths: 3,
      firstDueDate: MANILA_MIDNIGHT_2026_06_17,
    });
    expect(result.rows[0]!.dueDate).toBe(MANILA_MIDNIGHT_2026_06_17);
    // Row 2 should land on 17 July 2026 at Manila midnight.
    expect(result.rows[1]!.dueDate).toBe(
      new Date("2026-07-17T00:00:00+08:00").getTime(),
    );
    // Row 3 should land on 17 August 2026 at Manila midnight.
    expect(result.rows[2]!.dueDate).toBe(
      new Date("2026-08-17T00:00:00+08:00").getTime(),
    );
  });

  it("throws when totalPriceCents is not a positive integer", () => {
    expect(() =>
      generateInstallmentSchedule({
        totalPriceCents: 0,
        downPaymentCents: 0,
        termMonths: 12,
        firstDueDate: MANILA_MIDNIGHT_2026_06_17,
      }),
    ).toThrow();
    expect(() =>
      generateInstallmentSchedule({
        totalPriceCents: 1.5,
        downPaymentCents: 0,
        termMonths: 12,
        firstDueDate: MANILA_MIDNIGHT_2026_06_17,
      }),
    ).toThrow();
  });

  it("throws when downPayment >= totalPrice", () => {
    expect(() =>
      generateInstallmentSchedule({
        totalPriceCents: 100_00,
        downPaymentCents: 100_00,
        termMonths: 12,
        firstDueDate: MANILA_MIDNIGHT_2026_06_17,
      }),
    ).toThrow();
  });

  it("throws when termMonths is out of range", () => {
    expect(() =>
      generateInstallmentSchedule({
        totalPriceCents: 120_000,
        downPaymentCents: 0,
        termMonths: 0,
        firstDueDate: MANILA_MIDNIGHT_2026_06_17,
      }),
    ).toThrow();
    expect(() =>
      generateInstallmentSchedule({
        totalPriceCents: 120_000,
        downPaymentCents: 0,
        termMonths: 61,
        firstDueDate: MANILA_MIDNIGHT_2026_06_17,
      }),
    ).toThrow();
  });
});

describe("addMonthsClamped", () => {
  it("preserves day-of-month for normal advances", () => {
    const may15 = new Date("2026-05-15T00:00:00+00:00").getTime();
    const result = addMonthsClamped(may15, 2);
    expect(new Date(result).getUTCMonth()).toBe(6); // July
    expect(new Date(result).getUTCDate()).toBe(15);
  });

  it("clamps Jan 31 → Feb 28 in non-leap years", () => {
    const jan31_2026 = new Date("2026-01-31T00:00:00+00:00").getTime();
    const result = addMonthsClamped(jan31_2026, 1);
    expect(new Date(result).getUTCMonth()).toBe(1); // Feb
    expect(new Date(result).getUTCDate()).toBe(28);
  });

  it("clamps Jan 31 → Feb 29 in leap years", () => {
    const jan31_2028 = new Date("2028-01-31T00:00:00+00:00").getTime();
    const result = addMonthsClamped(jan31_2028, 1);
    expect(new Date(result).getUTCMonth()).toBe(1); // Feb
    expect(new Date(result).getUTCDate()).toBe(29);
  });

  it("crosses year boundaries", () => {
    const dec15_2026 = new Date("2026-12-15T00:00:00+00:00").getTime();
    const result = addMonthsClamped(dec15_2026, 1);
    expect(new Date(result).getUTCFullYear()).toBe(2027);
    expect(new Date(result).getUTCMonth()).toBe(0); // Jan
    expect(new Date(result).getUTCDate()).toBe(15);
  });
});

describe("<InstallmentSchedule />", () => {
  it("renders the empty state when total price is zero", () => {
    render(
      <InstallmentSchedule
        totalPriceCents={0}
        downPaymentCents={0}
        termMonths={12}
        firstDueDate={MANILA_MIDNIGHT_2026_06_17}
      />,
    );
    expect(
      screen.getByTestId("installment-schedule-empty"),
    ).toBeInTheDocument();
  });

  it("renders the empty state when firstDueDate is null", () => {
    render(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={0}
        termMonths={12}
        firstDueDate={null}
      />,
    );
    expect(
      screen.getByTestId("installment-schedule-empty"),
    ).toBeInTheDocument();
  });

  it("renders the empty state when down payment ≥ total price", () => {
    render(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={120_000_00}
        termMonths={12}
        firstDueDate={MANILA_MIDNIGHT_2026_06_17}
      />,
    );
    expect(
      screen.getByTestId("installment-schedule-empty"),
    ).toBeInTheDocument();
  });

  it("renders the table with the right number of rows", () => {
    render(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={0}
        termMonths={12}
        firstDueDate={MANILA_MIDNIGHT_2026_06_17}
      />,
    );
    expect(screen.getByTestId("installment-schedule")).toBeInTheDocument();
    for (let i = 1; i <= 12; i++) {
      expect(
        screen.getByTestId(`installment-row-${i}`),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByTestId("installment-schedule-total"),
    ).toBeInTheDocument();
  });

  it("surfaces the month-end clamp warning when due dates are clamped", () => {
    // Epic-3/4 adversarial-review HIGH fix: Jan 31 + 1 month silently
    // becoming Feb 28 was the disaster scenario. The schedule renderer
    // now surfaces a warning row so the operator confirms the dates
    // with the customer before saving.
    const JAN_31_2026 = new Date("2026-01-31T00:00:00+00:00").getTime();
    render(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={0}
        termMonths={12}
        firstDueDate={JAN_31_2026}
      />,
    );
    const warning = screen.getByTestId("installment-schedule-clamp-warning");
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/clamp/i);
    expect(warning.textContent).toMatch(/31st/i);
  });

  it("omits the clamp warning when no due dates were clamped", () => {
    render(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={0}
        termMonths={12}
        firstDueDate={MANILA_MIDNIGHT_2026_06_17}
      />,
    );
    expect(
      screen.queryByTestId("installment-schedule-clamp-warning"),
    ).not.toBeInTheDocument();
  });

  it("re-renders rows when props change", () => {
    const { rerender } = render(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={0}
        termMonths={12}
        firstDueDate={MANILA_MIDNIGHT_2026_06_17}
      />,
    );
    expect(screen.getAllByTestId(/installment-row-/)).toHaveLength(12);
    rerender(
      <InstallmentSchedule
        totalPriceCents={120_000_00}
        downPaymentCents={0}
        termMonths={6}
        firstDueDate={MANILA_MIDNIGHT_2026_06_17}
      />,
    );
    expect(screen.getAllByTestId(/installment-row-/)).toHaveLength(6);
  });
});
