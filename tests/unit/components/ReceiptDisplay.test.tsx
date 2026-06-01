/**
 * Story 3.11 — `ReceiptDisplay.tsx` unit tests.
 *
 * Asserts the BIR-compliant layout contract:
 *   - Required fields are present (registered name, TIN, ATP, serial,
 *     issued date, customer, amount, amount-in-words, signatory,
 *     footer disclaimer).
 *   - Placeholder banner appears when `templateIsPlaceholder === true`.
 *   - Voided banner + destructive styling appear when `isVoided`.
 *   - VAT block renders only when `template.isVatRegistered === true`.
 *   - Allocation line items render in the order received.
 *   - Empty-allocation path renders a graceful placeholder.
 *   - Payment reference + received-by display when present.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  ReceiptDisplay,
  type ReceiptDetailViewModel,
} from "@/components/ReceiptDisplay";

const T0 = new Date("2026-05-15T12:00:00+08:00").getTime();

function makeReceipt(
  overrides: Partial<ReceiptDetailViewModel> = {},
): ReceiptDetailViewModel {
  return {
    receiptId: "receipts:1",
    receiptSeries: "OR-",
    receiptNumber: "OR-0000123",
    receiptSerial: 123,
    issuedAt: T0,
    amountCents: 250_075,
    isVoided: false,
    voidedAt: null,
    voidReason: null,
    voidedByName: null,
    customer: {
      customerId: "customers:1",
      fullName: "Juan Dela Cruz",
      addressLine1: "123 Sample St.",
      addressBarangay: "Brgy. Sample",
      addressCityMunicipality: "Quezon City",
      addressProvince: "Metro Manila",
      addressPostalCode: "1100",
    },
    payment: {
      paymentId: "payments:1",
      paymentMethod: "cash",
      reference: "REF-2026-001",
      receivedAt: T0,
      receivedByName: "Maria Office",
    },
    contract: {
      contractId: "contracts:1",
      contractNumber: "C-2026-0001",
      lotCode: "D-5-12",
    },
    allocations: [
      {
        targetType: "contract",
        targetId: "contracts:1",
        amountCents: 250_075,
        sequence: 0,
        note: null,
      },
    ],
    template: {
      registeredName: "Test Memorial Park, Inc.",
      tin: "123456789000",
      atpNumber: "OCN-1234567890123456",
      address: "1 Test Avenue\nMakati City, 1200\nPhilippines",
      isVatRegistered: false,
      signatoryName: "Jane Authorized",
      signatoryTitle: "Treasurer",
      formatVersion: "v1-placeholder",
    },
    templateIsPlaceholder: true,
    ...overrides,
  };
}

describe("ReceiptDisplay — BIR-required fields", () => {
  it("renders the registered name, TIN, ATP, and address", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-registered-name")).toHaveTextContent(
      "Test Memorial Park, Inc.",
    );
    expect(screen.getByTestId("receipt-tin")).toHaveTextContent(
      "123-456-789-000",
    );
    expect(screen.getByTestId("receipt-atp")).toHaveTextContent(
      "OCN-1234567890123456",
    );
    // Address lines render.
    expect(screen.getByText("1 Test Avenue")).toBeInTheDocument();
    expect(screen.getByText("Makati City, 1200")).toBeInTheDocument();
  });

  it("renders the receipt serial prominently (AC4 surrogate)", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-number")).toHaveTextContent(
      "OR-0000123",
    );
  });

  it("renders the customer name and address", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-customer-name")).toHaveTextContent(
      "Juan Dela Cruz",
    );
    expect(screen.getByText("123 Sample St.")).toBeInTheDocument();
    expect(
      screen.getByText(/Brgy\. Sample, Quezon City, Metro Manila, 1100/),
    ).toBeInTheDocument();
  });

  it("renders the contract number and lot code", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-contract-number")).toHaveTextContent(
      "C-2026-0001",
    );
    expect(screen.getByTestId("receipt-lot-code")).toHaveTextContent(
      "D-5-12",
    );
  });

  it("renders the total + amount in words", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-total-amount")).toHaveTextContent(
      "₱2,500.75",
    );
    expect(screen.getByTestId("receipt-amount-in-words")).toHaveTextContent(
      /two thousand five hundred pesos and 75\/100/i,
    );
  });

  it("renders the signature block + footer disclaimer", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-signatory-name")).toHaveTextContent(
      "Jane Authorized",
    );
    expect(screen.getByTestId("receipt-footer-disclaimer")).toHaveTextContent(
      /this is an official receipt/i,
    );
    expect(screen.getByTestId("receipt-format-version")).toHaveTextContent(
      "v1-placeholder",
    );
  });

  it("renders the payment method + reference", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.getByTestId("receipt-payment-method")).toHaveTextContent(
      "Cash",
    );
    expect(
      screen.getByTestId("receipt-payment-reference"),
    ).toHaveTextContent("REF-2026-001");
  });
});

describe("ReceiptDisplay — placeholder banner (AC5 surrogate)", () => {
  it("shows the placeholder banner when templateIsPlaceholder=true", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(
      screen.getByTestId("receipt-placeholder-banner"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("receipt-placeholder-banner")).toHaveTextContent(
      /pending BIR confirmation/i,
    );
  });

  it("hides the placeholder banner when templateIsPlaceholder=false", () => {
    render(
      <ReceiptDisplay
        receipt={makeReceipt({ templateIsPlaceholder: false })}
      />,
    );
    expect(
      screen.queryByTestId("receipt-placeholder-banner"),
    ).not.toBeInTheDocument();
  });
});

describe("ReceiptDisplay — voided receipt", () => {
  it("renders the voided banner when isVoided=true", () => {
    render(
      <ReceiptDisplay
        receipt={makeReceipt({
          isVoided: true,
          voidedAt: T0,
          voidReason: "Duplicate entry",
          voidedByName: "Admin User",
        })}
      />,
    );
    const banner = screen.getByTestId("receipt-voided-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/voided receipt/i);
    expect(banner).toHaveTextContent("Duplicate entry");
    expect(banner).toHaveTextContent(/Admin User/);
  });

  it("flags the article with data-voided=true", () => {
    render(
      <ReceiptDisplay
        receipt={makeReceipt({
          isVoided: true,
          voidedAt: T0,
          voidReason: "Test",
        })}
      />,
    );
    expect(screen.getByTestId("receipt-display")).toHaveAttribute(
      "data-voided",
      "true",
    );
  });

  it("hides the voided banner when isVoided=false", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(
      screen.queryByTestId("receipt-voided-banner"),
    ).not.toBeInTheDocument();
  });
});

describe("ReceiptDisplay — VAT block", () => {
  it("hides the VAT block when isVatRegistered=false", () => {
    render(<ReceiptDisplay receipt={makeReceipt()} />);
    expect(screen.queryByTestId("receipt-vat-block")).not.toBeInTheDocument();
  });

  it("renders the VAT block when isVatRegistered=true", () => {
    const receipt = makeReceipt({
      amountCents: 1_120,
      template: {
        ...makeReceipt().template,
        isVatRegistered: true,
      },
    });
    render(<ReceiptDisplay receipt={receipt} />);
    expect(screen.getByTestId("receipt-vat-block")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-vat-net")).toHaveTextContent(
      "₱10.00",
    );
    expect(screen.getByTestId("receipt-vat-amount")).toHaveTextContent(
      "₱1.20",
    );
  });
});

describe("ReceiptDisplay — allocations", () => {
  it("renders each allocation row", () => {
    const receipt = makeReceipt({
      amountCents: 300_000,
      allocations: [
        {
          targetType: "installment",
          targetId: "i1",
          amountCents: 100_000,
          sequence: 0,
          note: null,
        },
        {
          targetType: "installment",
          targetId: "i2",
          amountCents: 100_000,
          sequence: 1,
          note: "Catch-up",
        },
        {
          targetType: "perpetualCare",
          targetId: "p1",
          amountCents: 100_000,
          sequence: 2,
          note: null,
        },
      ],
    });
    render(<ReceiptDisplay receipt={receipt} />);
    expect(screen.getByTestId("receipt-allocation-0")).toBeInTheDocument();
    expect(screen.getByTestId("receipt-allocation-1")).toHaveTextContent(
      /Installment payment — Catch-up/,
    );
    expect(screen.getByTestId("receipt-allocation-2")).toHaveTextContent(
      /Perpetual care fee/,
    );
  });

  it("renders a graceful placeholder when there are no allocations", () => {
    render(
      <ReceiptDisplay receipt={makeReceipt({ allocations: [] })} />,
    );
    expect(screen.getByTestId("receipt-no-allocations")).toBeInTheDocument();
  });
});

describe("ReceiptDisplay — defensive paths", () => {
  it("renders gracefully when the customer record is missing", () => {
    render(
      <ReceiptDisplay
        receipt={makeReceipt({
          customer: {
            customerId: null,
            fullName: null,
            addressLine1: null,
            addressBarangay: null,
            addressCityMunicipality: null,
            addressProvince: null,
            addressPostalCode: null,
          },
        })}
      />,
    );
    expect(screen.getByTestId("receipt-customer-name")).toHaveTextContent(
      /customer record unavailable/i,
    );
  });

  it("omits the payment reference when none is set", () => {
    render(
      <ReceiptDisplay
        receipt={makeReceipt({
          payment: {
            paymentId: "payments:1",
            paymentMethod: "gcash",
            reference: null,
            receivedAt: T0,
            receivedByName: null,
          },
        })}
      />,
    );
    expect(
      screen.queryByTestId("receipt-payment-reference"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("receipt-payment-method")).toHaveTextContent(
      "GCash",
    );
  });
});
