/**
 * What the operator sees when they price a lot.
 *
 * The arithmetic is tested in `convex/lib/pricing.test.ts` and the
 * selection in `convex/paymentPlans.test.ts`. This is about the desk:
 * whether an option that cannot close a sale can be clicked, whether an
 * instalment plan can be applied to the full-payment tab, and whether
 * the figure comes with the working that lets an operator explain it.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
}));

import { PlanPicker, type QuoteOption } from "@/components/SaleForm/PlanPicker";

function option(over: Partial<QuoteOption> = {}): QuoteOption {
  return {
    planId: "paymentPlans:cash",
    planName: "Cash",
    kind: "full_payment",
    isDefault: true,
    listPriceCents: 100_000_00,
    netPriceCents: 90_000_00,
    totalDiscountCents: 10_000_00,
    totalSurchargeCents: 0,
    downPaymentCents: 0,
    termMonths: 0,
    indicativeMonthlyCents: 0,
    adjustments: [
      { label: "Cash", amountCents: -10_000_00, source: "plan", percent: 10 },
    ],
    warnings: [],
    ...over,
  };
}

function quote(over: Record<string, unknown> = {}) {
  return {
    lotId: "lots:a1",
    lotCode: "A-1",
    lotType: "family",
    section: "Garden of Faith",
    listPriceCents: 100_000_00,
    options: [option()],
    promosNotApplied: [],
    noPlansConfigured: false,
    ...over,
  };
}

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("before a lot is chosen", () => {
  it("asks for a lot rather than showing an empty list", () => {
    useQueryMock.mockReturnValue(undefined);
    render(<PlanPicker lotId={null} onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId("plan-picker-no-lot")).toBeInTheDocument();
  });

  it("skips the query entirely", () => {
    // A rejected query throws during render, and quoting nothing is not
    // a question the server can answer.
    useQueryMock.mockReturnValue(undefined);
    render(<PlanPicker lotId={null} onApply={vi.fn()} onClear={vi.fn()} />);
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), "skip");
  });
});

describe("when the cemetery has configured nothing", () => {
  it("says so and points at hand-pricing", () => {
    useQueryMock.mockReturnValue(quote({ options: [], noPlansConfigured: true }));
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId("plan-picker-none")).toHaveTextContent(
      /priced by hand/i,
    );
  });
});

describe("the options", () => {
  it("shows the price and the working behind it", () => {
    // A number that appeared in a box is not something an operator can
    // explain across a desk.
    useQueryMock.mockReturnValue(quote());
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    const card = screen.getByTestId("plan-option");
    expect(card).toHaveTextContent("₱90,000");
    expect(card).toHaveTextContent("From ₱100,000");
    expect(card).toHaveTextContent("Cash");
    expect(card).toHaveTextContent("10%");
  });

  it("names the promotion that was applied", () => {
    useQueryMock.mockReturnValue(
      quote({ options: [option({ promoName: "All Souls" })] }),
    );
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId("plan-option-promo")).toHaveTextContent(
      "All Souls",
    );
  });

  it("hands the whole option back on click", () => {
    const onApply = vi.fn();
    useQueryMock.mockReturnValue(quote());
    render(<PlanPicker lotId="lots:a1" onApply={onApply} onClear={vi.fn()} />);
    fireEvent.click(screen.getByTestId("plan-option"));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ netPriceCents: 90_000_00 }),
    );
  });

  it("shows an instalment plan's deposit and monthly figure", () => {
    useQueryMock.mockReturnValue(
      quote({
        options: [
          option({
            planId: "paymentPlans:12",
            planName: "12 months",
            kind: "installment",
            netPriceCents: 100_000_00,
            downPaymentCents: 20_000_00,
            termMonths: 12,
            indicativeMonthlyCents: 6_666_66,
          }),
        ],
      }),
    );
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    // `formatPeso` renders centavos, so the deposit reads
    // "₱20,000.00 down". Asserted with the decimals rather than
    // loosened, because the figure a family is quoted is exact.
    expect(screen.getByTestId("plan-option")).toHaveTextContent(
      "₱20,000.00 down, then ₱6,666.66 a month for 12",
    );
  });
});

describe("an option that cannot close a sale", () => {
  it("CANNOT be clicked", () => {
    // Otherwise the operator meets a raw server rejection with a family
    // in front of them.
    const onApply = vi.fn();
    useQueryMock.mockReturnValue(
      quote({
        options: [
          option({
            warnings: ['"12 months" asks for no deposit, which the sale flow refuses.'],
          }),
        ],
      }),
    );
    render(<PlanPicker lotId="lots:a1" onApply={onApply} onClear={vi.fn()} />);
    const card = screen.getByTestId("plan-option");
    expect(card).toBeDisabled();
    fireEvent.click(card);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("says what is wrong with it", () => {
    useQueryMock.mockReturnValue(
      quote({ options: [option({ warnings: ["asks for no deposit"] })] }),
    );
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId("plan-option-unusable")).toHaveTextContent(
      "no deposit",
    );
  });
});

describe("a capped quote", () => {
  it("shows the cap rather than just the reduced figure", () => {
    // A silent cap means quoting a figure nobody approved.
    useQueryMock.mockReturnValue(
      quote({
        options: [
          option({ cappedNote: "Relief was capped at 50% of the list price." }),
        ],
      }),
    );
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId("plan-option-capped")).toHaveTextContent(
      /capped at 50%/,
    );
  });
});

describe("offers that did not apply", () => {
  it("gives the reason, not just an absence", () => {
    // "The All Souls offer ended on 5 November" is something the office
    // can say to a family who heard about it.
    useQueryMock.mockReturnValue(
      quote({
        promosNotApplied: [
          { name: "All Souls", reason: '"All Souls" ended on 5 November 2026.' },
        ],
      }),
    );
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByTestId("plan-picker-not-applied")).toHaveTextContent(
      /ended on 5 November/,
    );
  });
});

describe("a promotion code", () => {
  it("is not sent until the operator applies it", () => {
    // Re-querying per keystroke would put a moving price list in front
    // of a family.
    useQueryMock.mockReturnValue(quote());
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    fireEvent.change(screen.getByTestId("plan-picker-code"), {
      target: { value: "UNDAS26" },
    });
    expect(useQueryMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ promoCode: expect.anything() }),
    );

    fireEvent.click(screen.getByTestId("plan-picker-apply-code"));
    expect(useQueryMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ promoCode: "UNDAS26" }),
    );
  });
});

describe("going back to hand-pricing", () => {
  it("offers the escape hatch once a plan is applied", () => {
    const onClear = vi.fn();
    useQueryMock.mockReturnValue(quote());
    render(
      <PlanPicker
        lotId="lots:a1"
        selectedPlanId="paymentPlans:cash"
        onApply={vi.fn()}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByTestId("plan-picker-clear"));
    expect(onClear).toHaveBeenCalled();
  });

  it("does not offer it before one is", () => {
    useQueryMock.mockReturnValue(quote());
    render(<PlanPicker lotId="lots:a1" onApply={vi.fn()} onClear={vi.fn()} />);
    expect(screen.queryByTestId("plan-picker-clear")).toBeNull();
  });
});
