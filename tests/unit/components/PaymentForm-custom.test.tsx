/**
 * Story 3.10 — `PaymentForm` custom-allocation toggle tests.
 *
 * Coverage focus:
 *   - `validateCustomAllocation` pure helper (sum match, per-row
 *     ceiling, paid/waived rejection, missing installment, negative,
 *     non-integer, zero-amount handling).
 *   - The "Custom allocation" toggle is visible when at least one
 *     unpaid installment exists.
 *   - Toggling on swaps the auto preview for the editable rows and
 *     seeds the inputs from the FIFO default.
 *   - Submit stays disabled while sum != amount; enabled once they
 *     match.
 *   - Submit dispatches to `recordPaymentWithCustomAllocation` with the
 *     non-zero rows the staff entered.
 *
 * Mocking strategy mirrors `PaymentForm.test.tsx` (Story 3.9):
 *   - `convex/react`'s `useMutation` / `useQuery` are stub-controlled.
 *   - `next/navigation`'s `useRouter` is mocked.
 *   - `makeFunctionReference` is downgraded to a string-token so the
 *     dispatcher can route by function-name suffix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  validateCustomAllocation,
  type AllocationInstallmentInput,
  type CustomAllocationRow,
} from "@/components/PaymentForm/allocation";

const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceSpy }),
}));

const autoMutationSpy = vi.fn();
const customMutationSpy = vi.fn();
let contractQueryResult: unknown = null;
let installmentsQueryResult: unknown = [];
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const refStr = String(ref);
    if (refStr.includes("recordPaymentWithCustomAllocation")) {
      return customMutationSpy;
    }
    return autoMutationSpy;
  },
  useQuery: (ref: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const refStr = String(ref);
    if (refStr.includes("contracts:getContract")) {
      return contractQueryResult;
    }
    if (refStr.includes("installments:listContractInstallments")) {
      return installmentsQueryResult;
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
    makeFunctionReference: (path: string) => ({
      toString: () => path,
    }),
  };
});

import { PaymentForm } from "@/components/PaymentForm";

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date("2026-06-01T08:00:00").getTime();

const SAMPLE_CONTRACT = {
  contractId: "contracts:1",
  contractNumber: "CON-2026-0001",
  lotId: "lots:1",
  lotCode: "A-1-1",
  customerId: "customers:1",
  customerFullName: "Maria Reyes",
  kind: "installment" as const,
  totalPriceCents: 96_000_00,
  state: "active" as const,
  createdAt: T0,
};

function sampleInstallments() {
  // #1 paid, #2 paid, #3 overdue ₱4,000, #4 pending ₱4,000.
  return [
    {
      installmentId: "installments:1",
      contractId: "contracts:1",
      installmentNumber: 1,
      dueDate: T0 - 30 * 24 * HOUR_MS,
      principalCents: 4_000_00,
      paidCents: 4_000_00,
      status: "paid" as const,
      paidAt: T0 - 25 * 24 * HOUR_MS,
    },
    {
      installmentId: "installments:2",
      contractId: "contracts:1",
      installmentNumber: 2,
      dueDate: T0 - 5 * 24 * HOUR_MS,
      principalCents: 4_000_00,
      paidCents: 4_000_00,
      status: "paid" as const,
      paidAt: T0 - 3 * 24 * HOUR_MS,
    },
    {
      installmentId: "installments:3",
      contractId: "contracts:1",
      installmentNumber: 3,
      dueDate: T0 + 1 * 24 * HOUR_MS,
      principalCents: 4_000_00,
      paidCents: 0,
      status: "overdue" as const,
    },
    {
      installmentId: "installments:4",
      contractId: "contracts:1",
      installmentNumber: 4,
      dueDate: T0 + 30 * 24 * HOUR_MS,
      principalCents: 4_000_00,
      paidCents: 0,
      status: "pending" as const,
    },
  ];
}

beforeEach(() => {
  cleanup();
  replaceSpy.mockReset();
  autoMutationSpy.mockReset();
  customMutationSpy.mockReset();
  contractQueryResult = SAMPLE_CONTRACT;
  installmentsQueryResult = sampleInstallments();
});

afterEach(() => {
  cleanup();
});

describe("validateCustomAllocation", () => {
  function unpaidInstallments(): AllocationInstallmentInput[] {
    return sampleInstallments().map((row) => ({
      installmentId: row.installmentId,
      installmentNumber: row.installmentNumber,
      dueDate: row.dueDate,
      principalCents: row.principalCents,
      paidCents: row.paidCents,
      status: row.status,
    }));
  }

  it("returns ok when allocations sum to the payment amount", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:4", amountCents: 4_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      4_000_00,
    );
    expect(result.ok).toBe(true);
    expect(result.remainderCents).toBe(0);
    expect(result.totalAllocatedCents).toBe(4_000_00);
  });

  it("flags sum mismatch when the rows under-allocate", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:4", amountCents: 1_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      4_000_00,
    );
    expect(result.ok).toBe(false);
    expect(result.remainderCents).toBe(3_000_00);
    expect(result.formErrors).toContain("sum_mismatch");
  });

  it("flags sum mismatch when the rows over-allocate", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:3", amountCents: 4_000_00 },
      { installmentId: "installments:4", amountCents: 4_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      4_000_00,
    );
    expect(result.ok).toBe(false);
    expect(result.remainderCents).toBe(-4_000_00);
    expect(result.formErrors).toContain("sum_mismatch");
  });

  it("flags exceeds_outstanding when a row over-allocates a single installment", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:4", amountCents: 5_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      5_000_00,
    );
    expect(result.ok).toBe(false);
    expect(result.rowErrors["installments:4"]).toBe("exceeds_outstanding");
  });

  it("flags not_payable when a row targets a paid installment", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:1", amountCents: 1_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      1_000_00,
    );
    expect(result.ok).toBe(false);
    expect(result.rowErrors["installments:1"]).toBe("not_payable");
  });

  it("flags not_payable when a row references a non-existent installment", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:9999", amountCents: 1_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      1_000_00,
    );
    expect(result.ok).toBe(false);
    expect(result.rowErrors["installments:9999"]).toBe("not_payable");
  });

  it("flags negative on a negative per-row amount", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:4", amountCents: -100 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      -100,
    );
    expect(result.ok).toBe(false);
    expect(result.rowErrors["installments:4"]).toBe("negative");
  });

  it("flags not_integer when a row carries NaN", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:4", amountCents: Number.NaN },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      4_000_00,
    );
    expect(result.ok).toBe(false);
    expect(result.rowErrors["installments:4"]).toBe("not_integer");
  });

  it("flags amount_not_positive_integer when paymentAmountCents is zero", () => {
    const result = validateCustomAllocation(unpaidInstallments(), [], 0);
    expect(result.ok).toBe(false);
    expect(result.formErrors).toContain("amount_not_positive_integer");
  });

  it("treats zero-amount rows as allocator no-ops", () => {
    const allocations: CustomAllocationRow[] = [
      { installmentId: "installments:3", amountCents: 0 },
      { installmentId: "installments:4", amountCents: 4_000_00 },
    ];
    const result = validateCustomAllocation(
      unpaidInstallments(),
      allocations,
      4_000_00,
    );
    expect(result.ok).toBe(true);
    expect(result.totalAllocatedCents).toBe(4_000_00);
  });
});

describe("PaymentForm — custom-allocation toggle", () => {
  it("shows the Custom allocation toggle when unpaid installments exist", async () => {
    render(<PaymentForm contractId="contracts:1" />);
    expect(
      await screen.findByTestId("payment-form-toggle-custom"),
    ).toBeInTheDocument();
  });

  it("toggling on swaps the auto preview for the editable rows", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    // Enter an amount so the form has something to validate against.
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    // Auto preview is visible.
    expect(screen.getByTestId("allocation-preview")).toBeInTheDocument();
    // Click the toggle.
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    // Auto preview is now gone; the custom editor is shown with one
    // row per unpaid installment (#3 + #4).
    expect(screen.queryByTestId("allocation-preview")).not.toBeInTheDocument();
    expect(screen.getByTestId("custom-allocation-editor")).toBeInTheDocument();
    expect(
      screen.getByTestId("custom-allocation-row-3"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("custom-allocation-row-4"),
    ).toBeInTheDocument();
  });

  it("seeds the custom editor with the FIFO default (installment #3 = 4000)", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    const input3 = screen.getByTestId(
      "custom-allocation-input-3",
    ) as HTMLInputElement;
    const input4 = screen.getByTestId(
      "custom-allocation-input-4",
    ) as HTMLInputElement;
    expect(input3.value).toBe("4000.00");
    expect(input4.value).toBe("");
  });

  it("disables submit while the sum does not match the payment amount", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    // Set #3 to 1000 instead of 4000 -> sum mismatch.
    const input3 = screen.getByTestId(
      "custom-allocation-input-3",
    ) as HTMLInputElement;
    fireEvent.change(input3, { target: { value: "1000" } });
    expect(
      screen.getByTestId("custom-allocation-sum-mismatch"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("payment-form-submit")).toBeDisabled();
  });

  it("enables submit once the row sum matches the payment amount", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    // Move the 4000 from #3 to #4.
    const input3 = screen.getByTestId(
      "custom-allocation-input-3",
    ) as HTMLInputElement;
    const input4 = screen.getByTestId(
      "custom-allocation-input-4",
    ) as HTMLInputElement;
    fireEvent.change(input3, { target: { value: "0" } });
    fireEvent.change(input4, { target: { value: "4000" } });
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    expect(
      screen.queryByTestId("custom-allocation-sum-mismatch"),
    ).not.toBeInTheDocument();
  });

  it("flags exceeds_outstanding inline when a row exceeds the installment balance", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "5000");
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    const input4 = screen.getByTestId(
      "custom-allocation-input-4",
    ) as HTMLInputElement;
    fireEvent.change(input4, { target: { value: "5000" } });
    expect(
      await screen.findByTestId("custom-allocation-row-error-4"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("payment-form-submit")).toBeDisabled();
  });

  it("submitting custom allocation dispatches the custom mutation with the rows", async () => {
    const user = userEvent.setup();
    customMutationSpy.mockResolvedValue({
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000123",
      contractClosed: false,
      allocations: [
        {
          installmentId: "installments:4",
          installmentNumber: 4,
          amountAppliedCents: 4_000_00,
          installmentMarkedPaid: true,
        },
      ],
    });
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    // Redirect the full 4000 from #3 to #4.
    fireEvent.change(screen.getByTestId("custom-allocation-input-3"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("custom-allocation-input-4"), {
      target: { value: "4000" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("payment-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));
    await waitFor(() => {
      expect(customMutationSpy).toHaveBeenCalledTimes(1);
    });
    expect(autoMutationSpy).not.toHaveBeenCalled();
    const arg = customMutationSpy.mock.calls[0]![0] as {
      contractId: string;
      amountCents: number;
      paymentMethod: string;
      idempotencyKey: string;
      allocations: Array<{ installmentId: string; amountCents: number }>;
    };
    expect(arg.contractId).toBe("contracts:1");
    expect(arg.amountCents).toBe(4_000_00);
    expect(arg.paymentMethod).toBe("cash");
    expect(arg.idempotencyKey.length).toBeGreaterThan(0);
    // Only the non-zero rows make it over the network.
    expect(arg.allocations).toEqual([
      { installmentId: "installments:4", amountCents: 4_000_00 },
    ]);
    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/contracts/contracts:1");
    });
  });

  it("toggling off restores the auto preview and the auto mutation path", async () => {
    const user = userEvent.setup();
    autoMutationSpy.mockResolvedValue({
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000124",
      contractClosed: false,
      allocations: [
        {
          installmentId: "installments:3",
          installmentNumber: 3,
          amountAppliedCents: 4_000_00,
          installmentMarkedPaid: true,
        },
      ],
    });
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    // Toggle on then off.
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    fireEvent.click(screen.getByTestId("payment-form-toggle-custom"));
    // Auto preview is back.
    expect(screen.getByTestId("allocation-preview")).toBeInTheDocument();
    expect(
      screen.queryByTestId("custom-allocation-editor"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("payment-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));
    await waitFor(() => {
      expect(autoMutationSpy).toHaveBeenCalledTimes(1);
    });
    expect(customMutationSpy).not.toHaveBeenCalled();
  });
});
