/**
 * Story 3.3 — `SaleForm` component tests.
 *
 * Coverage focus:
 *   - Tabs render and the Installment tab shows the stub copy.
 *   - LotPicker + CustomerPicker fields render with the expected
 *     test ids.
 *   - Reference field is disabled when method is `cash`, enabled and
 *     required when method is `check`.
 *   - "Review receipt" submit opens the preview modal; "Cancel"
 *     closes it without writing.
 *   - Successful commit calls the mutation with the expected args
 *     shape and navigates.
 *   - ILLEGAL_STATE_TRANSITION error renders the conflict banner
 *     with a Refresh button.
 *
 * Mocking strategy:
 *   - `convex/react` is mocked so `useMutation` / `useQuery` are
 *     stub-controllable.
 *   - `next/navigation`'s `useRouter` is mocked so we can spy on
 *     `router.push`.
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
// CRIT-C foreground-fix pass: perpetual-care preview is read-only,
// driven by a Convex query. Tests get a default policy-configured
// zero-fee preview so the SaleForm renders without throwing.
let perpetualCarePreviewResult: unknown = {
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

// `makeFunctionReference` returns a special object; we mock it to a
// string token so our useQuery dispatcher can distinguish refs.
vi.mock("convex/server", async () => {
  const actual = await vi.importActual<typeof import("convex/server")>(
    "convex/server",
  );
  return {
    ...actual,
    makeFunctionReference: (path: string) => ({
      toString: () => path,
    }),
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

describe("SaleForm — render", () => {
  it("renders Full Payment and Installment tabs", () => {
    render(<SaleForm />);
    expect(screen.getByTestId("sale-tab-full")).toBeInTheDocument();
    expect(screen.getByTestId("sale-tab-installment")).toBeInTheDocument();
  });

  it("Installment tab mounts the installment terms panel (Story 3.4)", async () => {
    const user = userEvent.setup();
    render(<SaleForm />);
    await user.click(screen.getByTestId("sale-tab-installment"));
    // Story 3.4 replaced the Story 3.3 stub with the full
    // `InstallmentTermsPanel`. Assert the panel's distinctive surface
    // (the down-payment + term + first-due-date fields) appears.
    expect(
      screen.getByTestId("installment-sale-form"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("installment-down-payment"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("installment-term-months"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("installment-first-due-date"),
    ).toBeInTheDocument();
  });

  it("renders the LotPicker, CustomerPicker, method, and date / time inputs", () => {
    render(<SaleForm />);
    expect(screen.getByTestId("sale-lot-picker")).toBeInTheDocument();
    expect(screen.getByTestId("sale-customer-picker-search")).toBeInTheDocument();
    expect(screen.getByTestId("sale-method")).toBeInTheDocument();
    expect(screen.getByTestId("sale-date")).toBeInTheDocument();
    expect(screen.getByTestId("sale-time")).toBeInTheDocument();
  });

  it("disables the Reference input when method is cash", () => {
    render(<SaleForm />);
    const ref = screen.getByTestId("sale-reference") as HTMLInputElement;
    expect(ref).toBeDisabled();
  });

  it("enables the Reference input when method is check", async () => {
    const user = userEvent.setup();
    render(<SaleForm />);
    const method = screen.getByTestId("sale-method") as HTMLSelectElement;
    await user.selectOptions(method, "check");
    const ref = screen.getByTestId("sale-reference") as HTMLInputElement;
    expect(ref).not.toBeDisabled();
  });

  it("price is read-only for non-admin roles", () => {
    render(<SaleForm userRoles={["office_staff"]} />);
    const price = screen.getByTestId("sale-price-input") as HTMLInputElement;
    expect(price).toHaveAttribute("readonly");
  });

  it("price is editable for admin roles", () => {
    render(<SaleForm userRoles={["admin"]} />);
    const price = screen.getByTestId("sale-price-input") as HTMLInputElement;
    expect(price).not.toHaveAttribute("readonly");
  });
});

describe("SaleForm — submit flow", () => {
  it("opens the preview modal on Review receipt and closes on Cancel without calling the mutation", async () => {
    lotsQueryResult = SAMPLE_LOTS;
    customersQueryResult = SAMPLE_CUSTOMERS;

    render(<SaleForm userRoles={["office_staff"]} />);

    // Pick the lot (option is rendered)
    const lotSelect = screen.getByTestId("sale-lot-picker") as HTMLSelectElement;
    fireEvent.change(lotSelect, { target: { value: "lots:1" } });

    // Type in the customer search and pick the result
    const customerSearch = screen.getByTestId(
      "sale-customer-picker-search",
    ) as HTMLInputElement;
    fireEvent.change(customerSearch, { target: { value: "Mar" } });
    // The debounce hook updates asynchronously; await the result button.
    const pickBtn = await screen.findByTestId(
      "sale-customer-picker-result-customers:1",
    );
    fireEvent.click(pickBtn);

    // Form is now valid — submit opens the modal.
    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));

    expect(await screen.findByTestId("receipt-preview-body")).toBeInTheDocument();

    // Cancel closes without calling the mutation.
    fireEvent.click(screen.getByTestId("receipt-preview-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("receipt-preview-body")).toBeNull(),
    );
    expect(mutationSpy).not.toHaveBeenCalled();
  });

  it("commits the sale and navigates on Generate & Print", async () => {
    lotsQueryResult = SAMPLE_LOTS;
    customersQueryResult = SAMPLE_CUSTOMERS;

    mutationSpy.mockResolvedValue({
      contractId: "contracts:new",
      contractNumber: "CON-XYZ",
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000101",
    });

    render(<SaleForm userRoles={["office_staff"]} />);

    fireEvent.change(screen.getByTestId("sale-lot-picker"), {
      target: { value: "lots:1" },
    });
    fireEvent.change(screen.getByTestId("sale-customer-picker-search"), {
      target: { value: "Mari" },
    });
    const pickBtn = await screen.findByTestId(
      "sale-customer-picker-result-customers:1",
    );
    fireEvent.click(pickBtn);

    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));

    await waitFor(() => expect(mutationSpy).toHaveBeenCalledTimes(1));
    const args = mutationSpy.mock.calls[0]![0] as {
      lotId: string;
      customerId: string;
      totalPriceCents: number;
      method: string;
    };
    expect(args.lotId).toBe("lots:1");
    expect(args.customerId).toBe("customers:1");
    expect(args.totalPriceCents).toBe(150_000_00);
    expect(args.method).toBe("cash");

    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith("/contracts/contracts:new"),
    );
  });

  it("surfaces the conflict banner when the mutation throws ILLEGAL_STATE_TRANSITION", async () => {
    lotsQueryResult = SAMPLE_LOTS;
    customersQueryResult = SAMPLE_CUSTOMERS;

    const err = Object.assign(new Error("conflict"), {
      data: { code: "ILLEGAL_STATE_TRANSITION" },
    });
    mutationSpy.mockRejectedValue(err);

    render(<SaleForm userRoles={["office_staff"]} />);
    fireEvent.change(screen.getByTestId("sale-lot-picker"), {
      target: { value: "lots:1" },
    });
    fireEvent.change(screen.getByTestId("sale-customer-picker-search"), {
      target: { value: "Mari" },
    });
    fireEvent.click(
      await screen.findByTestId("sale-customer-picker-result-customers:1"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("sale-form-submit")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("sale-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));

    expect(
      await screen.findByTestId("sale-form-conflict"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("sale-form-refresh")).toBeInTheDocument();
  });
});
