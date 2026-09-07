/**
 * What has been paid against a contract.
 *
 * The page said "Full timeline view (payments, transitions, void /
 * cancel) ships in Story 3.6" — printed beneath the mark-in-default and
 * reclaim-lot controls it claimed were missing, on a page whose query
 * for these payments had existed all along.
 *
 * The arithmetic here decides what somebody is told at a counter, so
 * the failures worth guarding are the ones that produce a plausible
 * wrong number rather than an error: counting a voided payment as
 * money received, or showing a negative balance on an overpayment.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

import { ContractPayments } from "@/components/ContractPayments";

function payment(over: Record<string, unknown> = {}) {
  return {
    paymentId: "payments:p1",
    paymentNumber: "PAY-0001",
    amountCents: 25_000_00,
    paymentMethod: "cash",
    receivedAt: Date.parse("2026-03-04T00:00:00+08:00"),
    isVoided: false,
    ...over,
  };
}

function view(total = 100_000_00) {
  return <ContractPayments contractId="contracts:c1" totalPriceCents={total} />;
}

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("what the panel adds up", () => {
  it("totals what has actually arrived", () => {
    useQueryMock.mockReturnValue([
      payment(),
      payment({ paymentId: "payments:p2", amountCents: 15_000_00 }),
    ]);
    render(view());
    expect(screen.getByTestId("contract-payments-summary")).toHaveTextContent(
      "₱40,000.00 of ₱100,000.00",
    );
  });

  it("EXCLUDES a voided payment from the total", () => {
    // A voided payment is not money the customer paid. Counting it
    // overstates what is settled, and the number is read aloud at a
    // counter to somebody holding a receipt.
    useQueryMock.mockReturnValue([
      payment(),
      payment({ paymentId: "payments:p2", amountCents: 15_000_00, isVoided: true }),
    ]);
    render(view());
    expect(screen.getByTestId("contract-payments-summary")).toHaveTextContent(
      "₱25,000.00 of ₱100,000.00",
    );
  });

  it("still SHOWS the voided payment, struck through", () => {
    // A receipt exists in the world with that number on it. A history
    // that quietly omits one cannot be reconciled against the drawer.
    useQueryMock.mockReturnValue([payment({ isVoided: true })]);
    render(view());
    expect(screen.getByTestId("contract-payment-voided")).toBeInTheDocument();
    expect(screen.getAllByTestId("contract-payment-row")).toHaveLength(1);
  });

  it("says what is outstanding", () => {
    useQueryMock.mockReturnValue([payment()]);
    render(view());
    expect(screen.getByTestId("contract-payments-summary")).toHaveTextContent(
      "₱75,000.00 outstanding",
    );
  });

  it("says Settled rather than showing a zero", () => {
    // A bare ₱0.00 reads like a missing value.
    useQueryMock.mockReturnValue([payment({ amountCents: 100_000_00 })]);
    render(view());
    expect(screen.getByTestId("contract-payments-summary")).toHaveTextContent(
      "Settled",
    );
  });

  it("never shows a NEGATIVE balance on an overpayment", () => {
    // An overpayment is a real thing at a counter. "-₱5,000.00
    // outstanding" is not a sentence anybody can act on.
    useQueryMock.mockReturnValue([payment({ amountCents: 105_000_00 })]);
    render(view());
    const summary = screen.getByTestId("contract-payments-summary");
    expect(summary).toHaveTextContent("Settled");
    expect(summary.textContent ?? "").not.toContain("-₱");
  });
});

describe("finding the paperwork again", () => {
  it("links the receipt number, which is what a family arrives holding", () => {
    useQueryMock.mockReturnValue([
      payment({ receiptId: "receipts:r1", receiptNumber: "OR-000123" }),
    ]);
    render(view());
    expect(
      screen.getByRole("link", { name: "OR-000123" }),
    ).toHaveAttribute("href", "/receipts/receipts:r1");
  });

  it("falls back to the payment number when no receipt was issued", () => {
    useQueryMock.mockReturnValue([payment()]);
    render(view());
    expect(screen.getByText("PAY-0001")).toBeInTheDocument();
  });
});

describe("when there is nothing to show", () => {
  it("says so plainly", () => {
    useQueryMock.mockReturnValue([]);
    render(view());
    expect(screen.getByTestId("contract-payments-empty")).toHaveTextContent(
      /no payment has been recorded/i,
    );
  });

  it("distinguishes loading from empty", () => {
    useQueryMock.mockReturnValue(undefined);
    render(view());
    expect(screen.queryByTestId("contract-payments-empty")).toBeNull();
    expect(screen.queryByTestId("contract-payments-summary")).toBeNull();
  });
});
