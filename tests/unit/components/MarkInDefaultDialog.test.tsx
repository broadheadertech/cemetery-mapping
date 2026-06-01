/**
 * Story 4.4 — `MarkInDefaultDialog` component tests (FR37).
 *
 * Coverage:
 *   - Renders the warning block with the contract number, lot code,
 *     and customer name + the critical "default ≠ reclaim" copy
 *     ("stays sold," "Audit log captures").
 *   - Confirm button is disabled until the reason is ≥ 10 characters
 *     (whitespace-only stays disabled).
 *   - Confirm fires the `onConfirm` callback with the trimmed reason.
 *   - Mutation errors surface inline as `role="alert"` without
 *     locking the form in `Marking…` state forever.
 *   - Cancel button fires `onClose`.
 *   - Enter key inside the dialog does NOT trigger a confirm —
 *     destructive contract-state changes require an explicit click.
 *   - The character counter updates as the user types.
 *   - The 500-char `maxLength` is enforced by the DOM.
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

import { MarkInDefaultDialog } from "../../../src/components/MarkInDefaultDialog";

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
    <MarkInDefaultDialog
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

describe("MarkInDefaultDialog", () => {
  it("renders the warning block with contract number, lot code, and customer name + default≠reclaim copy", () => {
    renderDialog();
    const warning = screen.getByTestId("mark-in-default-warning");
    expect(warning).toHaveTextContent("D-5-12");
    expect(warning).toHaveTextContent("Juan Dela Cruz");
    expect(warning).toHaveTextContent(/stays sold/i);
    expect(warning).toHaveTextContent(/Audit log captures/i);
    expect(warning).toHaveTextContent(/Reclaim lot/i);

    const dialog = screen.getByTestId("mark-in-default-dialog");
    expect(dialog).toHaveTextContent("CON-20260601-D-5-12-1234");
  });

  it("disables the confirm button until the reason is at least 10 chars after trim", async () => {
    const user = userEvent.setup();
    renderDialog();

    const confirm = screen.getByTestId("mark-in-default-confirm");
    expect(confirm).toBeDisabled();

    const reasonField = screen.getByTestId("mark-in-default-reason");
    await user.type(reasonField, "too short");
    expect(confirm).toBeDisabled();

    await user.type(reasonField, " — and now enough");
    expect(confirm).toBeEnabled();
  });

  it("keeps the confirm button disabled for whitespace-only reasons", async () => {
    const user = userEvent.setup();
    renderDialog();
    const confirm = screen.getByTestId("mark-in-default-confirm");
    await user.type(
      screen.getByTestId("mark-in-default-reason"),
      "                    ",
    );
    expect(confirm).toBeDisabled();
  });

  it("fires onConfirm with the trimmed reason when confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();

    await user.type(
      screen.getByTestId("mark-in-default-reason"),
      "   Customer has not responded after 3 follow-ups.   ",
    );
    await user.click(screen.getByTestId("mark-in-default-confirm"));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0]![0]).toBe(
      "Customer has not responded after 3 follow-ups.",
    );
  });

  it("surfaces server errors inline as role=alert without locking the submit button", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new Error(
        "ILLEGAL_STATE_TRANSITION — contract is no longer active.",
      );
    });
    renderDialog({ onConfirm });

    await user.type(
      screen.getByTestId("mark-in-default-reason"),
      "Severely overdue — escalating.",
    );
    await user.click(screen.getByTestId("mark-in-default-confirm"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "ILLEGAL_STATE_TRANSITION — contract is no longer active.",
    );
    // Form is not stuck — confirm button re-enables after the failure.
    expect(screen.getByTestId("mark-in-default-confirm")).toBeEnabled();
  });

  it("calls onClose when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();
    await user.click(screen.getByTestId("mark-in-default-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT confirm when Enter is pressed inside the dialog", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const reasonField = screen.getByTestId("mark-in-default-reason");
    await user.type(reasonField, "Severely overdue — escalating.");
    // Confirm is enabled now, but Enter must not submit.
    fireEvent.keyDown(screen.getByTestId("mark-in-default-dialog"), {
      key: "Enter",
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("updates the character counter as the user types", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(
      screen.getByTestId("mark-in-default-reason"),
      "Hello world",
    );
    expect(
      screen.getByTestId("mark-in-default-reason-counter"),
    ).toHaveTextContent("11 / 500");
  });

  it("enforces the 500-char maxLength via the DOM attribute", () => {
    renderDialog();
    const reasonField = screen.getByTestId(
      "mark-in-default-reason",
    ) as HTMLTextAreaElement;
    expect(reasonField.maxLength).toBe(500);
  });
});
