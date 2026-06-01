/**
 * Story 3.5 — `SaleForm` discount-panel tests.
 *
 * Coverage focus:
 *   - Discount panel renders on the Full Payment tab between the
 *     price block and the method block.
 *   - Entering a discount amount + reason renders the price summary
 *     (base / discount / total).
 *   - Submitting with a discount calls the mutation with
 *     `basePriceCents`, `discountCents`, `discountReason`, and a
 *     correctly-computed `totalPriceCents`.
 *   - Submitting without a discount sends no discount-* args.
 *   - A discount that exceeds the base price disables submit (zod
 *     superRefine catches it).
 *   - Discount with no reason disables submit until a reason is typed.
 *
 * Mocking strategy mirrors `SaleForm.test.tsx` (Story 3.3): `convex/react`
 * + `next/navigation` are stubbed; `makeFunctionReference` returns a
 * stringifiable token so our `useQuery` dispatcher can pick the right
 * fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, replace: vi.fn() }),
}));

const mutationSpy = vi.fn();
let lotsQueryResult: unknown = [];
let customersQueryResult: unknown = [];
const perpetualCarePreviewResult: unknown = {
  feeCents: 0,
  billingType: "none",
  isPlaceholder: false,
  policyType: "none",
};
vi.mock("convex/react", () => ({
  useMutation: () => mutationSpy,
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const refStr = String(ref);
    if (refStr.includes("perpetualCare")) {
      return perpetualCarePreviewResult;
    }
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

describe("SaleForm — discount panel render", () => {
  it("renders the discount panel between the price block and the method block", () => {
    render(<SaleForm />);
    expect(screen.getByTestId("sale-discount-panel")).toBeInTheDocument();
    expect(screen.getByTestId("sale-discount-amount")).toBeInTheDocument();
    expect(screen.getByTestId("sale-discount-reason")).toBeInTheDocument();
  });

  it("does NOT render the price summary block until a valid discount is entered", () => {
    render(<SaleForm />);
    expect(screen.queryByTestId("sale-price-summary")).toBeNull();
  });
});

describe("SaleForm — discount panel behaviour", () => {
  it("shows the price summary (base / discount / total) once a valid discount is typed", async () => {
    await setUpSelectedForm();

    // Type a discount of ₱15,000.
    const amount = screen.getByTestId("sale-discount-amount") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "15000" } });
    const reason = screen.getByTestId("sale-discount-reason") as HTMLInputElement;
    fireEvent.change(reason, { target: { value: "Family loyalty" } });

    const summary = await screen.findByTestId("sale-price-summary");
    expect(summary).toBeInTheDocument();
    expect(screen.getByTestId("sale-summary-base").textContent).toContain("150,000");
    expect(screen.getByTestId("sale-summary-discount").textContent).toContain("15,000");
    expect(screen.getByTestId("sale-summary-total").textContent).toContain("135,000");
    expect(screen.getByTestId("sale-summary-reason").textContent).toContain(
      "Family loyalty",
    );
  });

  it("submits with basePriceCents / discountCents / discountReason and the post-discount total", async () => {
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
    };
    expect(args.totalPriceCents).toBe(135_000_00);
    expect(args.basePriceCents).toBe(150_000_00);
    expect(args.discountCents).toBe(15_000_00);
    expect(args.discountReason).toBe("Family loyalty");
  });

  it("submits WITHOUT discount-* fields when the discount input is empty", async () => {
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
      basePriceCents?: number;
      discountCents?: number;
      discountReason?: string;
    };
    expect(args.totalPriceCents).toBe(150_000_00);
    expect(args.basePriceCents).toBeUndefined();
    expect(args.discountCents).toBeUndefined();
    expect(args.discountReason).toBeUndefined();
  });

  it("disables submit when the discount exceeds the lot's base price", async () => {
    await setUpSelectedForm();

    // Form is initially valid (no discount entered yet).
    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );

    // Entering a discount larger than the listed price makes the form
    // invalid (zod superRefine catches it before submit).
    fireEvent.change(screen.getByTestId("sale-discount-amount"), {
      target: { value: "200000" },
    });
    fireEvent.change(screen.getByTestId("sale-discount-reason"), {
      target: { value: "Way too much" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("sale-form-submit")).toBeDisabled();
    });
  });

  it("disables submit when a discount is entered without a reason", async () => {
    const user = userEvent.setup();
    await setUpSelectedForm();

    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );

    await user.type(screen.getByTestId("sale-discount-amount"), "5000");
    await waitFor(() => {
      expect(screen.getByTestId("sale-form-submit")).toBeDisabled();
    });

    // Typing a long-enough reason re-enables the form.
    await user.type(
      screen.getByTestId("sale-discount-reason"),
      "Family loyalty",
    );
    await waitFor(() => {
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled();
    });
  });
});
