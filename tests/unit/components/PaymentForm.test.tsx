/**
 * Story 3.9 — `PaymentForm` component tests.
 *
 * Coverage focus:
 *   - `previewAllocation` pure helper exhaustive cases (oldest-unpaid
 *     first, partial, cascade, all-paid, overpay).
 *   - Form renders amount / method / date / reference inputs with the
 *     expected test ids.
 *   - Reference disabled when method is cash; enabled when method is
 *     check.
 *   - AllocationPreview shows the line that would be applied and the
 *     overpay warning when the amount exceeds the outstanding balance.
 *   - "Review receipt" submit opens the preview modal; "Cancel" closes
 *     it without calling the mutation.
 *   - Successful commit calls the mutation with the expected args and
 *     navigates to the contract detail page.
 *
 * Mocking strategy mirrors `SaleForm.test.tsx`:
 *   - `convex/react`'s `useMutation` / `useQuery` are stub-controlled.
 *   - `next/navigation`'s `useRouter` is mocked.
 *   - `makeFunctionReference` is downgraded to a string-token for the
 *     query dispatcher.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { previewAllocation } from "@/components/PaymentForm/allocation";

const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceSpy }),
}));

const mutationSpy = vi.fn();
let contractQueryResult: unknown = null;
let installmentsQueryResult: unknown = [];
vi.mock("convex/react", () => ({
  useMutation: () => mutationSpy,
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

function sampleInstallments(
  overrides: Partial<{ overdue3: boolean }> = {},
) {
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
      status: (overrides.overdue3 ? "overdue" : "pending") as
        | "overdue"
        | "pending",
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
  mutationSpy.mockReset();
  contractQueryResult = SAMPLE_CONTRACT;
  installmentsQueryResult = sampleInstallments();
});

afterEach(() => {
  cleanup();
});

describe("previewAllocation", () => {
  const installments = sampleInstallments();

  it("applies the full amount to the oldest unpaid installment when amount equals the balance", () => {
    const result = previewAllocation(installments, 4_000_00);
    expect(result.totalAppliedCents).toBe(4_000_00);
    expect(result.remainingCents).toBe(0);
    expect(result.wouldOverpay).toBe(false);
    const touched = result.entries.filter((e) => e.amountAppliedCents > 0);
    expect(touched).toHaveLength(1);
    expect(touched[0]!.installmentNumber).toBe(3);
    expect(touched[0]!.willMarkPaid).toBe(true);
  });

  it("partial allocation leaves the row not-marked-paid", () => {
    const result = previewAllocation(installments, 2_000_00);
    expect(result.totalAppliedCents).toBe(2_000_00);
    const row3 = result.entries.find((e) => e.installmentNumber === 3)!;
    expect(row3.amountAppliedCents).toBe(2_000_00);
    expect(row3.willMarkPaid).toBe(false);
  });

  it("cascades when the amount exceeds the oldest row's balance", () => {
    const result = previewAllocation(installments, 6_000_00);
    expect(result.totalAppliedCents).toBe(6_000_00);
    const row3 = result.entries.find((e) => e.installmentNumber === 3)!;
    const row4 = result.entries.find((e) => e.installmentNumber === 4)!;
    expect(row3.amountAppliedCents).toBe(4_000_00);
    expect(row3.willMarkPaid).toBe(true);
    expect(row4.amountAppliedCents).toBe(2_000_00);
    expect(row4.willMarkPaid).toBe(false);
  });

  it("flags overpay when the amount exceeds all outstanding balances", () => {
    const result = previewAllocation(installments, 100_000_00);
    expect(result.wouldOverpay).toBe(true);
    expect(result.remainingCents).toBeGreaterThan(0);
  });

  it("treats already-paid rows as untouched + closes contract when last row would close", () => {
    const allPaid = installments.map((row) => ({
      ...row,
      paidCents: row.principalCents,
      status: "paid" as const,
    }));
    const result = previewAllocation(allPaid, 1);
    expect(result.totalAppliedCents).toBe(0);
    expect(result.wouldOverpay).toBe(true);
    expect(result.wouldCloseContract).toBe(true);
  });

  it("handles a zero amount with all-zero applied entries", () => {
    const result = previewAllocation(installments, 0);
    expect(result.totalAppliedCents).toBe(0);
    expect(result.remainingCents).toBe(0);
    expect(result.wouldOverpay).toBe(false);
    expect(result.entries.every((e) => e.amountAppliedCents === 0)).toBe(true);
  });

  it("handles overdue rows the same as pending", () => {
    const result = previewAllocation(
      sampleInstallments({ overdue3: true }),
      4_000_00,
    );
    const row3 = result.entries.find((e) => e.installmentNumber === 3)!;
    expect(row3.amountAppliedCents).toBe(4_000_00);
    expect(row3.willMarkPaid).toBe(true);
  });

  it("returns an empty result for an empty installment array", () => {
    const result = previewAllocation([], 5_000_00);
    expect(result.entries).toHaveLength(0);
    expect(result.totalAppliedCents).toBe(0);
    expect(result.wouldOverpay).toBe(true);
    expect(result.wouldCloseContract).toBe(false);
  });
});

describe("PaymentForm — rendering", () => {
  it("renders contract summary + amount / method / date / reference inputs", async () => {
    render(<PaymentForm contractId="contracts:1" />);
    expect(
      await screen.findByTestId("payment-form-contract-summary"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("payment-amount-input")).toBeInTheDocument();
    expect(screen.getByTestId("payment-method")).toBeInTheDocument();
    expect(screen.getByTestId("payment-date")).toBeInTheDocument();
    expect(screen.getByTestId("payment-reference")).toBeInTheDocument();
  });

  it("loads with the loading state until both queries resolve", () => {
    contractQueryResult = undefined;
    installmentsQueryResult = undefined;
    render(<PaymentForm contractId="contracts:1" />);
    expect(screen.getByTestId("payment-form-loading")).toBeInTheDocument();
  });

  it("disables Reference when method is cash, enables when method is check", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const reference = (await screen.findByTestId(
      "payment-reference",
    )) as HTMLInputElement;
    expect(reference.disabled).toBe(true);
    await user.selectOptions(screen.getByTestId("payment-method"), "check");
    expect(reference.disabled).toBe(false);
  });

  it("surfaces the allocation preview row for the touched installment", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    expect(
      await screen.findByTestId("allocation-preview-applied-3"),
    ).toBeInTheDocument();
  });

  it("renders the overpay warning when the amount exceeds the outstanding balance", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "100000");
    expect(
      await screen.findByTestId("allocation-preview-overpay-warning"),
    ).toBeInTheDocument();
  });

  it("blocks submission when the contract is not active", async () => {
    contractQueryResult = { ...SAMPLE_CONTRACT, state: "paid_in_full" };
    render(<PaymentForm contractId="contracts:1" />);
    expect(await screen.findByTestId("payment-form-blocked")).toBeInTheDocument();
    expect(screen.queryByTestId("payment-form")).not.toBeInTheDocument();
  });
});

describe("PaymentForm — submit + commit", () => {
  it("opens the receipt-preview modal on Review receipt click", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("payment-form-submit"));
    expect(
      await screen.findByTestId("receipt-preview-body"),
    ).toBeInTheDocument();
    expect(mutationSpy).not.toHaveBeenCalled();
  });

  it("commit calls the mutation with the expected args + navigates to the contract", async () => {
    const user = userEvent.setup();
    mutationSpy.mockResolvedValue({
      paymentId: "payments:1",
      receiptId: "receipts:1",
      receiptNumber: "OR-0000123",
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
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("payment-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));
    await waitFor(() => {
      expect(mutationSpy).toHaveBeenCalledTimes(1);
    });
    const arg = mutationSpy.mock.calls[0]![0] as {
      contractId: string;
      amountCents: number;
      paymentMethod: string;
      idempotencyKey: string;
    };
    expect(arg.contractId).toBe("contracts:1");
    expect(arg.amountCents).toBe(4_000_00);
    expect(arg.paymentMethod).toBe("cash");
    expect(arg.idempotencyKey.length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(replaceSpy).toHaveBeenCalledWith("/contracts/contracts:1");
    });
  });

  it("commit surfaces the overpay inline message when the mutation throws INVARIANT_VIOLATION with overpay:true", async () => {
    const user = userEvent.setup();
    mutationSpy.mockRejectedValue({
      data: {
        code: "INVARIANT_VIOLATION",
        message: "Overpay",
        details: { overpay: true, excessCents: 96_000_00 },
      },
    });
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("payment-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-commit"));
    const errorBanner = await screen.findByTestId("receipt-preview-error");
    expect(errorBanner.textContent).toMatch(/exceeds/i);
  });

  it("cancel button closes the modal without calling the mutation", async () => {
    const user = userEvent.setup();
    render(<PaymentForm contractId="contracts:1" />);
    const amount = await screen.findByTestId("payment-amount-input");
    await user.type(amount, "4000");
    await waitFor(() => {
      expect(screen.getByTestId("payment-form-submit")).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId("payment-form-submit"));
    fireEvent.click(await screen.findByTestId("receipt-preview-cancel"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("receipt-preview-body"),
      ).not.toBeInTheDocument();
    });
    expect(mutationSpy).not.toHaveBeenCalled();
  });
});
