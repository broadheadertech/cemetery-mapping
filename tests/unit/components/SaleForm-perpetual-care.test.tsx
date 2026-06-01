/**
 * Story 3.8 — `SaleForm` perpetual care panel tests.
 *
 * Coverage focus:
 *   - Perpetual care panel renders on the Full Payment tab below the
 *     discount panel.
 *   - Entering a perpetual care amount renders the price summary
 *     (base / + perpetual / total).
 *   - Submitting with a perpetual care fee calls the mutation with
 *     `perpetualCareCents`, `perpetualCareReason` (when provided),
 *     and a correctly-computed `totalPriceCents` (base + fee).
 *   - Submitting without a perpetual care fee sends no
 *     perpetualCare-* args.
 *   - A perpetual care fee composes with a discount: base − discount
 *     + perpetual === total.
 *   - A perpetual care fee may be applied without a reason.
 *
 * Mocking strategy mirrors `SaleForm-discount.test.tsx` (Story 3.5):
 * `convex/react` + `next/navigation` are stubbed; `makeFunctionReference`
 * returns a stringifiable token so our `useQuery` dispatcher picks the
 * right fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn() }),
}));

const mutationSpy = vi.fn();
let lotsQueryResult: unknown = [];
let customersQueryResult: unknown = [];
vi.mock("convex/react", () => ({
  useMutation: () => mutationSpy,
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const refStr = String(ref);
    if (refStr.includes("lots") || refStr.includes("listLots")) {
      return lotsQueryResult;
    }
    if (refStr.includes("customers") || refStr.includes("searchByName")) {
      return customersQueryResult;
    }
    return null;
  },
}));

vi.mock("convex/server", async () => {
  const actual = await vi.importActual<typeof import("convex/server")>(
    "convex/server",
  );
  return {
    ...actual,
    makeFunctionReference: (path: string) => ({ toString: () => path }),
  };
});

import { SaleForm } from "@/components/SaleForm";

beforeEach(() => {
  cleanup();
  pushSpy.mockReset();
  mutationSpy.mockReset();
  lotsQueryResult = [];
  customersQueryResult = [];
});

afterEach(() => {
  cleanup();
});

const SAMPLE_LOTS = [
  {
    _id: "lots:1",
    code: "A-1-1",
    section: "A",
    block: "1",
    row: "1",
    type: "single",
    basePriceCents: 150_000_00,
    status: "available",
    isRetired: false,
  },
];

const SAMPLE_CUSTOMERS = [
  {
    customerId: "customers:1",
    fullName: "Maria Santos",
    govIdLast4: "1234",
  },
];

async function setUpSelectedForm(): Promise<void> {
  lotsQueryResult = SAMPLE_LOTS;
  customersQueryResult = SAMPLE_CUSTOMERS;

  render(<SaleForm userRoles={["office_staff"]} />);
  fireEvent.change(screen.getByTestId("sale-lot-picker"), {
    target: { value: "lots:1" },
  });
  fireEvent.change(screen.getByTestId("sale-customer-picker-search"), {
    target: { value: "Mar" },
  });
  const pickBtn = await screen.findByTestId(
    "sale-customer-picker-result-customers:1",
  );
  fireEvent.click(pickBtn);
}

// CRIT-C foreground-fix pass (2026-05-22): perpetual care is now
// policy-driven (cemeterySettings.perpetualCarePolicy), NOT operator-
// supplied. The editable form panel was removed; this test suite is
// obsolete. Skipped pending follow-on tests for the read-only preview
// + admin settings flow.
describe.skip("SaleForm — perpetual care panel render", () => {
  it("renders the perpetual care panel on the Full Payment tab", () => {
    render(<SaleForm />);
    expect(screen.getByTestId("sale-perpetual-care-panel")).toBeInTheDocument();
    expect(
      screen.getByTestId("sale-perpetual-care-amount"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("sale-perpetual-care-reason"),
    ).toBeInTheDocument();
  });

  it("does NOT render the price summary block until a perpetual care fee or discount is entered", () => {
    render(<SaleForm />);
    expect(screen.queryByTestId("sale-price-summary")).toBeNull();
  });
});

// CRIT-C foreground-fix pass (2026-05-22): perpetual care is now
// policy-driven (cemeterySettings.perpetualCarePolicy), NOT operator-
// supplied. The editable form panel was removed; this test suite is
// obsolete. Skipped pending follow-on tests for the read-only preview
// + admin settings flow.
describe.skip("SaleForm — perpetual care panel behaviour", () => {
  it("shows the price summary (base / + perpetual / total) once a fee is typed", async () => {
    await setUpSelectedForm();

    // Enter a ₱5,000 perpetual care fee.
    const amount = screen.getByTestId(
      "sale-perpetual-care-amount",
    ) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "5000" } });

    const summary = await screen.findByTestId("sale-price-summary");
    expect(summary).toBeInTheDocument();
    expect(screen.getByTestId("sale-summary-base").textContent).toContain(
      "150,000",
    );
    expect(
      screen.getByTestId("sale-summary-perpetual-care").textContent,
    ).toContain("5,000");
    expect(screen.getByTestId("sale-summary-total").textContent).toContain(
      "155,000",
    );
  });

  it("submits with perpetualCareCents + perpetualCareReason and the addon-inclusive total", async () => {
    mutationSpy.mockResolvedValue({
      contractId: "contracts:new",
      contractNumber: "CON-XYZ",
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000101",
    });

    await setUpSelectedForm();

    fireEvent.change(screen.getByTestId("sale-perpetual-care-amount"), {
      target: { value: "5000" },
    });
    fireEvent.change(screen.getByTestId("sale-perpetual-care-reason"), {
      target: { value: "Endowment tier" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));

    await waitFor(() => expect(mutationSpy).toHaveBeenCalledTimes(1));
    const args = mutationSpy.mock.calls[0]![0] as {
      totalPriceCents: number;
      basePriceCents?: number;
      discountCents?: number;
      perpetualCareCents?: number;
      perpetualCareReason?: string;
    };
    expect(args.totalPriceCents).toBe(155_000_00);
    expect(args.perpetualCareCents).toBe(5_000_00);
    expect(args.perpetualCareReason).toBe("Endowment tier");
    // The discount triple is sent (with zero discount) so the server's
    // invariant arithmetic resolves cleanly when only the addon is
    // applied.
    expect(args.basePriceCents).toBe(150_000_00);
    expect(args.discountCents).toBe(0);
  });

  it("submits WITHOUT perpetualCare-* fields when the amount input is empty", async () => {
    mutationSpy.mockResolvedValue({
      contractId: "contracts:new",
      contractNumber: "CON-XYZ",
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000101",
    });

    await setUpSelectedForm();

    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));

    await waitFor(() => expect(mutationSpy).toHaveBeenCalledTimes(1));
    const args = mutationSpy.mock.calls[0]![0] as {
      totalPriceCents: number;
      perpetualCareCents?: number;
      perpetualCareReason?: string;
    };
    expect(args.totalPriceCents).toBe(150_000_00);
    expect(args.perpetualCareCents).toBeUndefined();
    expect(args.perpetualCareReason).toBeUndefined();
  });

  it("composes a perpetual care fee with a discount in the price summary", async () => {
    await setUpSelectedForm();

    fireEvent.change(screen.getByTestId("sale-discount-amount"), {
      target: { value: "15000" },
    });
    fireEvent.change(screen.getByTestId("sale-discount-reason"), {
      target: { value: "Family loyalty" },
    });
    fireEvent.change(screen.getByTestId("sale-perpetual-care-amount"), {
      target: { value: "5000" },
    });

    const summary = await screen.findByTestId("sale-price-summary");
    expect(summary).toBeInTheDocument();
    expect(screen.getByTestId("sale-summary-base").textContent).toContain(
      "150,000",
    );
    expect(screen.getByTestId("sale-summary-discount").textContent).toContain(
      "15,000",
    );
    expect(
      screen.getByTestId("sale-summary-perpetual-care").textContent,
    ).toContain("5,000");
    // 150,000 − 15,000 + 5,000 = 140,000.
    expect(screen.getByTestId("sale-summary-total").textContent).toContain(
      "140,000",
    );
  });

  it("submits with both discount + perpetual care payloads when both are applied", async () => {
    mutationSpy.mockResolvedValue({
      contractId: "contracts:new",
      contractNumber: "CON-XYZ",
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000101",
    });

    await setUpSelectedForm();

    fireEvent.change(screen.getByTestId("sale-discount-amount"), {
      target: { value: "15000" },
    });
    fireEvent.change(screen.getByTestId("sale-discount-reason"), {
      target: { value: "Family loyalty" },
    });
    fireEvent.change(screen.getByTestId("sale-perpetual-care-amount"), {
      target: { value: "5000" },
    });
    fireEvent.change(screen.getByTestId("sale-perpetual-care-reason"), {
      target: { value: "Endowment tier" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));

    await waitFor(() => expect(mutationSpy).toHaveBeenCalledTimes(1));
    const args = mutationSpy.mock.calls[0]![0] as {
      totalPriceCents: number;
      basePriceCents?: number;
      discountCents?: number;
      discountReason?: string;
      perpetualCareCents?: number;
      perpetualCareReason?: string;
    };
    expect(args.totalPriceCents).toBe(140_000_00);
    expect(args.basePriceCents).toBe(150_000_00);
    expect(args.discountCents).toBe(15_000_00);
    expect(args.discountReason).toBe("Family loyalty");
    expect(args.perpetualCareCents).toBe(5_000_00);
    expect(args.perpetualCareReason).toBe("Endowment tier");
  });

  it("submits with a perpetual care fee but no reason when the reason field is left blank", async () => {
    mutationSpy.mockResolvedValue({
      contractId: "contracts:new",
      contractNumber: "CON-XYZ",
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000101",
    });

    await setUpSelectedForm();

    fireEvent.change(screen.getByTestId("sale-perpetual-care-amount"), {
      target: { value: "2500" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));

    await waitFor(() => expect(mutationSpy).toHaveBeenCalledTimes(1));
    const args = mutationSpy.mock.calls[0]![0] as {
      totalPriceCents: number;
      perpetualCareCents?: number;
      perpetualCareReason?: string;
    };
    expect(args.totalPriceCents).toBe(152_500_00);
    expect(args.perpetualCareCents).toBe(2_500_00);
    expect(args.perpetualCareReason).toBeUndefined();
  });
});
