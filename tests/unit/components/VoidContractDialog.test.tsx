/**
 * Story 3.7 — `VoidContractDialog` component tests.
 *
 * Coverage:
 *   - Renders the warning block with the lot code + customer name.
 *   - Confirm button is disabled until the reason is ≥ 10 characters.
 *   - Confirm fires the `onConfirm` callback with the trimmed reason.
 *   - Mutation errors surface inline (role="alert") without locking
 *     the form in `Voiding…` state forever.
 *   - Cancel button fires `onClose`.
 *   - Enter key inside the dialog does NOT trigger a confirm — the
 *     UX contract (§ 1050 confidence-loop) demands an explicit click.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { VoidContractDialog } from "../../../src/components/VoidContractDialog";

interface Setup {
  onClose: ReturnType<typeof vi.fn>;
  onConfirm: ReturnType<typeof vi.fn>;
}

function renderDialog(
  overrides: Partial<{
    open: boolean;
    onConfirm: (reason: string) => Promise<void>;
    onClose: () => void;
    contractNumber: string;
    lotCode: string;
    customerName: string;
  }> = {},
): Setup {
  const onClose = vi.fn();
  const onConfirm = vi.fn(async (_reason: string) => {});
  render(
    <VoidContractDialog
      open={overrides.open ?? true}
      onClose={overrides.onClose ?? onClose}
      onConfirm={overrides.onConfirm ?? onConfirm}
      contractNumber={overrides.contractNumber ?? "CON-20260601-D-5-12-1234"}
      lotCode={overrides.lotCode ?? "D-5-12"}
      customerName={overrides.customerName ?? "Juan Dela Cruz"}
    />,
  );
  return { onClose, onConfirm };
}

beforeEach(() => {
  cleanup();
});

describe("VoidContractDialog", () => {
  it("renders the warning block with lot code and customer name", () => {
    renderDialog();
    const warning = screen.getByTestId("void-contract-warning");
    expect(warning).toHaveTextContent("D-5-12");
    expect(warning).toHaveTextContent("Juan Dela Cruz");
    expect(warning).toHaveTextContent(/Available/);
    expect(warning).toHaveTextContent(/Refunds must be processed separately/i);
  });

  it("disables the confirm button until the reason is at least 10 chars", async () => {
    const user = userEvent.setup();
    renderDialog();

    const confirm = screen.getByTestId("void-contract-confirm");
    expect(confirm).toBeDisabled();

    const reasonField = screen.getByTestId("void-contract-reason");
    await user.type(reasonField, "too short");
    expect(confirm).toBeDisabled();

    await user.type(reasonField, " — yet more text");
    expect(confirm).toBeEnabled();
  });

  it("fires onConfirm with the trimmed reason when confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.type(
      screen.getByTestId("void-contract-reason"),
      "   Customer changed their mind after walk-through   ",
    );

    await user.click(screen.getByTestId("void-contract-confirm"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]![0]).toBe(
      "Customer changed their mind after walk-through",
    );
  });

  it("surfaces mutation errors inline as role=alert without locking submit", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new Error("Cannot void — lot has been interred.");
    });
    renderDialog({ onConfirm });

    await user.type(
      screen.getByTestId("void-contract-reason"),
      "Trying to void with an interment.",
    );
    await user.click(screen.getByTestId("void-contract-confirm"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Cannot void — lot has been interred.");
    // Form is not stuck in `Voiding…` — confirm button re-enables.
    expect(screen.getByTestId("void-contract-confirm")).toBeEnabled();
  });

  it("calls onClose when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByTestId("void-contract-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT confirm when Enter is pressed inside the dialog", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    const reason = screen.getByTestId("void-contract-reason");
    await user.type(reason, "A long enough reason for confirmation here.");

    // Pressing Enter must not trigger the confirm callback.
    fireEvent.keyDown(reason, { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId("void-contract-dialog"), {
      key: "Enter",
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
