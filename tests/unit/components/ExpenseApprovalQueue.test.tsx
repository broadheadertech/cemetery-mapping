/**
 * Story 6.7 — `ExpenseApprovalQueue` component tests (FR41).
 *
 * Coverage:
 *   - Renders loading state when rows are undefined.
 *   - Renders empty-state message when rows is an empty array.
 *   - Renders one row per pending expense with vendor / amount /
 *     category / paid-date / submitter columns.
 *   - Clicking Approve calls `onApprove` with the row id.
 *   - Approve button shows the busy label while the mutation is in
 *     flight and re-enables on completion.
 *   - Approve surface displays a banner when the mutation throws.
 *   - Clicking Reject opens the reject dialog and seeds it with the
 *     selected row's vendor.
 *   - Reject confirm is disabled when the reason is empty / blank.
 *   - Reject confirm fires `onReject` with the trimmed reason.
 *   - Reject dialog surfaces server errors inline without locking the
 *     submit button.
 *   - Reject dialog's character counter updates live; respects the
 *     500-char maxLength.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ExpenseApprovalQueue,
  type PendingApprovalRow,
} from "../../../src/components/ExpenseApprovalQueue";

beforeEach(() => {
  cleanup();
});

const ROW_A: PendingApprovalRow = {
  _id: "exp_a",
  paidAt: new Date("2026-05-12T03:00:00+08:00").getTime(),
  amountCents: 5_50000, // ₱5,500.00
  vendor: "Acme Hardware",
  category: "Maintenance",
  recordedByName: "Maria Reyes",
};

const ROW_B: PendingApprovalRow = {
  _id: "exp_b",
  paidAt: new Date("2026-05-10T03:00:00+08:00").getTime(),
  amountCents: 12_00000, // ₱12,000.00
  vendor: "Manila Power Co.",
  category: "Utilities",
  recordedByName: "Maria Reyes",
};

interface RenderOptions {
  rows?: ReadonlyArray<PendingApprovalRow> | undefined;
  onApprove?: (expenseId: string) => Promise<void>;
  onReject?: (expenseId: string, reason: string) => Promise<void>;
}

function renderQueue(options: RenderOptions = {}) {
  const onApprove = options.onApprove ?? vi.fn(async () => {});
  const onReject = options.onReject ?? vi.fn(async () => {});
  const utils = render(
    <ExpenseApprovalQueue
      rows={options.rows}
      onApprove={onApprove}
      onReject={onReject}
    />,
  );
  return { ...utils, onApprove, onReject };
}

describe("ExpenseApprovalQueue", () => {
  it("shows the loading state while rows are undefined", () => {
    renderQueue({ rows: undefined });
    expect(
      screen.getByTestId("expense-approval-queue-loading"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("expense-approval-queue-empty"),
    ).not.toBeInTheDocument();
  });

  it("renders the empty state when there are no pending expenses", () => {
    renderQueue({ rows: [] });
    expect(
      screen.getByTestId("expense-approval-queue-empty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("expense-approval-queue-loading"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("expense-approval-queue-table-wrapper"),
    ).not.toBeInTheDocument();
  });

  it("renders one row per pending expense with vendor + amount + category", () => {
    renderQueue({ rows: [ROW_A, ROW_B] });
    const rowA = screen.getByTestId(`expense-approval-row-${ROW_A._id}`);
    const rowB = screen.getByTestId(`expense-approval-row-${ROW_B._id}`);
    expect(rowA).toHaveTextContent("Acme Hardware");
    expect(rowA).toHaveTextContent("Maintenance");
    expect(rowA).toHaveTextContent("5,500"); // peso formatting
    expect(rowA).toHaveTextContent("Maria Reyes");
    expect(rowB).toHaveTextContent("Manila Power Co.");
    expect(rowB).toHaveTextContent("Utilities");
    expect(rowB).toHaveTextContent("12,000");
  });

  it("calls onApprove with the row id when Approve is clicked", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn(async (_expenseId: string) => {});
    renderQueue({ rows: [ROW_A], onApprove });
    await user.click(
      screen.getByTestId(`expense-approval-approve-${ROW_A._id}`),
    );
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect(onApprove.mock.calls[0]![0]).toBe(ROW_A._id);
  });

  it("disables the approve button while the mutation is in flight", async () => {
    const user = userEvent.setup();
    let resolveMutation: () => void = () => {};
    const onApprove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMutation = resolve;
        }),
    );
    renderQueue({ rows: [ROW_A], onApprove });
    const approveBtn = screen.getByTestId(
      `expense-approval-approve-${ROW_A._id}`,
    );
    await user.click(approveBtn);
    expect(approveBtn).toBeDisabled();
    expect(approveBtn).toHaveTextContent(/approving/i);
    resolveMutation();
    await waitFor(() => expect(approveBtn).not.toBeDisabled());
  });

  it("surfaces an inline alert when the approve mutation throws", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn(async () => {
      throw new Error("FORBIDDEN — only admins can approve.");
    });
    renderQueue({ rows: [ROW_A], onApprove });
    await user.click(
      screen.getByTestId(`expense-approval-approve-${ROW_A._id}`),
    );
    const alert = await screen.findByTestId("expense-approval-queue-error");
    expect(alert).toBeInTheDocument();
    // Button re-enables after the failure so the operator can retry
    // once the cause is resolved.
    expect(
      screen.getByTestId(`expense-approval-approve-${ROW_A._id}`),
    ).not.toBeDisabled();
  });

  it("opens the reject dialog seeded with the vendor when Reject is clicked", async () => {
    const user = userEvent.setup();
    renderQueue({ rows: [ROW_A] });
    expect(
      screen.queryByTestId("expense-approval-reject-dialog"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByTestId(`expense-approval-reject-${ROW_A._id}`),
    );
    const dialog = await screen.findByTestId("expense-approval-reject-dialog");
    expect(dialog).toHaveTextContent("Acme Hardware");
  });

  it("disables the reject confirm button until the reason is non-empty", async () => {
    const user = userEvent.setup();
    renderQueue({ rows: [ROW_A] });
    await user.click(
      screen.getByTestId(`expense-approval-reject-${ROW_A._id}`),
    );
    const confirm = await screen.findByTestId(
      "expense-approval-reject-confirm",
    );
    expect(confirm).toBeDisabled();
    const reasonField = screen.getByTestId("expense-approval-reject-reason");
    // Whitespace-only must keep the button disabled.
    await user.type(reasonField, "   ");
    expect(confirm).toBeDisabled();
    await user.type(reasonField, "Receipt unreadable");
    expect(confirm).toBeEnabled();
  });

  it("fires onReject with the trimmed reason when confirm is clicked", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn(async (_expenseId: string, _reason: string) => {});
    renderQueue({ rows: [ROW_A], onReject });
    await user.click(
      screen.getByTestId(`expense-approval-reject-${ROW_A._id}`),
    );
    await user.type(
      await screen.findByTestId("expense-approval-reject-reason"),
      "   Receipt photo is unreadable   ",
    );
    await user.click(screen.getByTestId("expense-approval-reject-confirm"));
    await waitFor(() => expect(onReject).toHaveBeenCalledTimes(1));
    expect(onReject.mock.calls[0]![0]).toBe(ROW_A._id);
    expect(onReject.mock.calls[0]![1]).toBe("Receipt photo is unreadable");
  });

  it("surfaces server errors inline in the reject dialog without locking the submit button", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn(async () => {
      throw new Error("FORBIDDEN — only admins can reject expenses.");
    });
    renderQueue({ rows: [ROW_A], onReject });
    await user.click(
      screen.getByTestId(`expense-approval-reject-${ROW_A._id}`),
    );
    await user.type(
      await screen.findByTestId("expense-approval-reject-reason"),
      "Routing this to staff.",
    );
    await user.click(screen.getByTestId("expense-approval-reject-confirm"));
    const inlineError = await screen.findByTestId(
      "expense-approval-reject-error",
    );
    expect(inlineError).toBeInTheDocument();
    expect(
      screen.getByTestId("expense-approval-reject-confirm"),
    ).toBeEnabled();
  });

  it("updates the live character counter and enforces the 500-char maxLength", async () => {
    const user = userEvent.setup();
    renderQueue({ rows: [ROW_A] });
    await user.click(
      screen.getByTestId(`expense-approval-reject-${ROW_A._id}`),
    );
    const reasonField = (await screen.findByTestId(
      "expense-approval-reject-reason",
    )) as HTMLTextAreaElement;
    expect(reasonField.maxLength).toBe(500);
    await user.type(reasonField, "Hello");
    expect(
      screen.getByTestId("expense-approval-reject-reason-counter"),
    ).toHaveTextContent("5 / 500");
  });

  it("closes the reject dialog when Cancel is clicked", async () => {
    const user = userEvent.setup();
    renderQueue({ rows: [ROW_A] });
    await user.click(
      screen.getByTestId(`expense-approval-reject-${ROW_A._id}`),
    );
    await user.click(
      await screen.findByTestId("expense-approval-reject-cancel"),
    );
    await waitFor(() =>
      expect(
        screen.queryByTestId("expense-approval-reject-dialog"),
      ).not.toBeInTheDocument(),
    );
  });
});
