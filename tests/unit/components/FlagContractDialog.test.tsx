/**
 * Story 5.4 — `FlagContractDialog` component tests (FR44, Journey 4).
 *
 * Coverage:
 *   - Renders the dialog with the contract number + the 280-char counter.
 *   - Confirm button is disabled until the textarea has a non-empty
 *     reason (whitespace-only stays disabled).
 *   - Confirm fires `onConfirm` with the trimmed reason.
 *   - Pre-fills the textarea from `initialReason` when re-flagging.
 *   - Mutation errors surface inline as `role="alert"` without locking
 *     the dialog in `Flagging…` state forever.
 *   - Cancel button fires `onClose`.
 *   - 280-char maxLength is enforced by the DOM (`maxLength` attribute).
 *   - The character counter updates as the user types.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FlagContractDialog } from "../../../src/components/FlagContractDialog";

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
    initialReason: string;
  }> = {},
): Setup {
  const onClose = vi.fn();
  const onConfirm = vi.fn(async (_reason: string) => {});
  render(
    <FlagContractDialog
      open={overrides.open ?? true}
      onClose={overrides.onClose ?? onClose}
      onConfirm={overrides.onConfirm ?? onConfirm}
      contractNumber={overrides.contractNumber ?? "CON-20260520-A-1-0001"}
      initialReason={overrides.initialReason}
    />,
  );
  return { onClose, onConfirm };
}

beforeEach(() => {
  cleanup();
});

describe("FlagContractDialog", () => {
  it("renders the dialog with the contract number and a 0/280 character counter", () => {
    renderDialog();
    const dialog = screen.getByTestId("flag-contract-dialog");
    expect(dialog).toHaveTextContent("CON-20260520-A-1-0001");
    expect(screen.getByTestId("flag-contract-reason-counter")).toHaveTextContent(
      "0 / 280",
    );
  });

  it("disables the confirm button until the reason has at least one non-whitespace character", async () => {
    const user = userEvent.setup();
    renderDialog();

    const confirm = screen.getByTestId("flag-contract-confirm");
    expect(confirm).toBeDisabled();

    const reasonField = screen.getByTestId("flag-contract-reason");
    // Whitespace-only must keep the button disabled.
    await user.type(reasonField, "   ");
    expect(confirm).toBeDisabled();

    await user.type(reasonField, "Confirm date");
    expect(confirm).toBeEnabled();
  });

  it("fires onConfirm with the trimmed reason when confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.type(
      screen.getByTestId("flag-contract-reason"),
      "   Customer called about installment 5 — confirm date   ",
    );
    await user.click(screen.getByTestId("flag-contract-confirm"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]![0]).toBe(
      "Customer called about installment 5 — confirm date",
    );
  });

  it("pre-fills the textarea from initialReason for re-flagging", () => {
    renderDialog({ initialReason: "Existing reason — refine me" });
    const reasonField = screen.getByTestId(
      "flag-contract-reason",
    ) as HTMLTextAreaElement;
    expect(reasonField.value).toBe("Existing reason — refine me");
    // Counter reflects pre-fill length.
    expect(screen.getByTestId("flag-contract-reason-counter")).toHaveTextContent(
      "27 / 280",
    );
    // Confirm starts enabled because the pre-fill is already valid.
    expect(screen.getByTestId("flag-contract-confirm")).toBeEnabled();
  });

  it("surfaces server errors inline as role=alert without locking the submit button", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new Error("FORBIDDEN — only admins can flag contracts.");
    });
    renderDialog({ onConfirm });

    await user.type(
      screen.getByTestId("flag-contract-reason"),
      "Routing this to staff.",
    );
    await user.click(screen.getByTestId("flag-contract-confirm"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "FORBIDDEN — only admins can flag contracts.",
    );
    // Form is not stuck — confirm button re-enables after the failure.
    expect(screen.getByTestId("flag-contract-confirm")).toBeEnabled();
  });

  it("calls onClose when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByTestId("flag-contract-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("enforces the 280-char maxLength via the DOM attribute", () => {
    renderDialog();
    const reasonField = screen.getByTestId(
      "flag-contract-reason",
    ) as HTMLTextAreaElement;
    expect(reasonField.maxLength).toBe(280);
  });

  it("updates the character counter as the user types", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(
      screen.getByTestId("flag-contract-reason"),
      "Hello",
    );
    expect(
      screen.getByTestId("flag-contract-reason-counter"),
    ).toHaveTextContent("5 / 280");
  });
});
