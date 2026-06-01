/**
 * Story 3.12 — `VoidReceiptDialog` component tests.
 *
 * Coverage:
 *   - Renders the summary block with receipt number, customer name,
 *     amount, and issued-at.
 *   - Renders the warning block with the FR29 messaging (serial
 *     consumed; payment flagged not deleted).
 *   - Confirm button is disabled until the reason is ≥ 10 chars
 *     (trimmed).
 *   - Confirm fires the `onConfirm` callback with the trimmed reason.
 *   - Mutation errors surface inline (role="alert") and re-enable the
 *     confirm button so the operator can retry.
 *   - Cancel button fires `onClose`.
 *   - Enter key inside the dialog does NOT trigger a confirm — the UX
 *     contract demands an explicit click on the destructive button.
 *   - Customer name handles `null` (rare — defensive).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VoidReceiptDialog } from "../../../src/components/VoidReceiptDialog";

interface Setup {
  onClose: ReturnType<typeof vi.fn>;
  onConfirm: ReturnType<typeof vi.fn>;
}

function renderDialog(
  overrides: Partial<{
    open: boolean;
    onConfirm: (reason: string) => Promise<void>;
    onClose: () => void;
    receiptNumber: string;
    amountFormatted: string;
    customerName: string | null;
    issuedAtFormatted: string;
  }> = {},
): Setup {
  const onClose = vi.fn();
  const onConfirm = vi.fn(async (_reason: string) => {});
  render(
    <VoidReceiptDialog
      open={overrides.open ?? true}
      onClose={overrides.onClose ?? onClose}
      onConfirm={overrides.onConfirm ?? onConfirm}
      receiptNumber={overrides.receiptNumber ?? "OR-0000123"}
      amountFormatted={overrides.amountFormatted ?? "₱2,500.00"}
      customerName={
        overrides.customerName === undefined
          ? "Juan Dela Cruz"
          : overrides.customerName
      }
      issuedAtFormatted={
        overrides.issuedAtFormatted ?? "May 18, 2026, 9:14 AM"
      }
    />,
  );
  return { onClose, onConfirm };
}

beforeEach(() => {
  cleanup();
});

describe("VoidReceiptDialog", () => {
  it("renders the summary block with receipt number, customer, amount, issued-at", () => {
    renderDialog();
    const summary = screen.getByTestId("void-receipt-summary");
    expect(summary).toHaveTextContent("OR-0000123");
    expect(summary).toHaveTextContent("Juan Dela Cruz");
    expect(summary).toHaveTextContent("₱2,500.00");
    expect(summary).toHaveTextContent("May 18, 2026, 9:14 AM");
  });

  it("renders the warning block with FR29 messaging", () => {
    renderDialog();
    const warning = screen.getByTestId("void-receipt-warning");
    expect(warning).toHaveTextContent(/never re-issued/i);
    expect(warning).toHaveTextContent(/not.*delete/i);
    expect(warning).toHaveTextContent(/VOIDED/);
  });

  it("falls back gracefully when the customer name is null", () => {
    renderDialog({ customerName: null });
    expect(screen.getByTestId("void-receipt-summary")).toHaveTextContent(
      "(no linked customer)",
    );
  });

  it("disables the confirm button until the reason is at least 10 trimmed chars", async () => {
    const user = userEvent.setup();
    renderDialog();

    const confirm = screen.getByTestId("void-receipt-confirm");
    expect(confirm).toBeDisabled();

    const reasonField = screen.getByTestId("void-receipt-reason");
    await user.type(reasonField, "too short");
    expect(confirm).toBeDisabled();

    await user.type(reasonField, " — more text now");
    expect(confirm).toBeEnabled();
  });

  it("fires onConfirm with the trimmed reason when confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.type(
      screen.getByTestId("void-receipt-reason"),
      "   Customer disputed the wrong amount on the OR.   ",
    );
    await user.click(screen.getByTestId("void-receipt-confirm"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]![0]).toBe(
      "Customer disputed the wrong amount on the OR.",
    );
  });

  it("surfaces mutation errors inline as role=alert without locking submit", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new Error("Receipt is already voided.");
    });
    renderDialog({ onConfirm });

    await user.type(
      screen.getByTestId("void-receipt-reason"),
      "Trying to void a receipt that was already voided.",
    );
    await user.click(screen.getByTestId("void-receipt-confirm"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Receipt is already voided.");
    // Form is not stuck in `Voiding…` — confirm re-enables for retry.
    expect(screen.getByTestId("void-receipt-confirm")).toBeEnabled();
  });

  it("calls onClose when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByTestId("void-receipt-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT confirm when Enter is pressed inside the dialog", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    const reason = screen.getByTestId("void-receipt-reason");
    await user.type(
      reason,
      "A long enough reason that would otherwise submit.",
    );

    // Enter must be swallowed; the destructive action requires a click.
    fireEvent.keyDown(reason, { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("void-receipt-dialog"), {
      key: "Enter",
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
