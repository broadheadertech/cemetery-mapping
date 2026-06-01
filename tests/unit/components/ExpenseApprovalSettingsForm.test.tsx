/**
 * ExpenseApprovalSettingsForm — Story 6.6 component tests.
 *
 * Coverage:
 *   - Required category in create mode.
 *   - Threshold input converts pesos → centavos on submit.
 *   - `requiresApproval === false` still produces a valid submit.
 *   - Default mode locks category + shows the default note.
 *   - Edit mode locks the category input.
 *   - Server error from `onSubmit` surfaces inline via translateError.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ExpenseApprovalSettingsForm,
  type ExpenseApprovalSettingsFormSubmitPayload,
} from "../../../src/components/ExpenseApprovalSettingsForm";

describe("ExpenseApprovalSettingsForm — create mode", () => {
  it("requires a non-empty category before submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<ExpenseApprovalSettingsForm mode="create" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /add setting/i }));

    await screen.findByText(/category is required/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("converts threshold pesos to centavos in the submitted payload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(
      async (_p: ExpenseApprovalSettingsFormSubmitPayload) => {},
    );
    render(<ExpenseApprovalSettingsForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Category"), "Utilities");
    // Enable requiresApproval so the threshold input is editable.
    await user.click(
      screen.getByLabelText(/require approval for this category/i),
    );
    const thresholdInput = screen.getByLabelText(/threshold/i);
    await user.clear(thresholdInput);
    await user.type(thresholdInput, "5000");

    await user.click(screen.getByRole("button", { name: /add setting/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      category: "Utilities",
      thresholdCents: 500_000,
      requiresApproval: true,
    });
  });

  it("submits with requiresApproval=false even when threshold is empty/zero", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(
      async (_p: ExpenseApprovalSettingsFormSubmitPayload) => {},
    );
    render(<ExpenseApprovalSettingsForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText("Category"), "Salaries");
    await user.click(screen.getByRole("button", { name: /add setting/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      category: "Salaries",
      thresholdCents: 0,
      requiresApproval: false,
    });
  });

  it("does not show the default-row note in create mode", () => {
    render(<ExpenseApprovalSettingsForm mode="create" onSubmit={vi.fn()} />);
    expect(
      screen.queryByText(/applied to any expense category that does not have/i),
    ).toBeNull();
  });
});

describe("ExpenseApprovalSettingsForm — default mode", () => {
  it("shows the default-row note and locks the category input", () => {
    render(
      <ExpenseApprovalSettingsForm
        mode="default"
        defaultValues={{
          category: "__default__",
          thresholdPesos: 1000,
          requiresApproval: true,
        }}
        onSubmit={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/setting applied to any expense category/i),
    ).toBeInTheDocument();
    const categoryInput = screen.getByLabelText("Category");
    expect(categoryInput).toHaveAttribute("readonly");
  });
});

describe("ExpenseApprovalSettingsForm — edit mode", () => {
  it("locks the category input when editing an existing row", () => {
    render(
      <ExpenseApprovalSettingsForm
        mode="edit"
        defaultValues={{
          category: "Utilities",
          thresholdPesos: 2500,
          requiresApproval: true,
        }}
        onSubmit={vi.fn()}
      />,
    );
    const categoryInput = screen.getByLabelText("Category");
    expect(categoryInput).toHaveAttribute("readonly");
  });

  it("surfaces server error from onSubmit via translateError", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw Object.assign(new Error("server"), {
        data: { code: "VALIDATION" },
      });
    });
    render(
      <ExpenseApprovalSettingsForm
        mode="edit"
        defaultValues={{
          category: "Utilities",
          thresholdPesos: 1000,
          requiresApproval: true,
        }}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await screen.findByTestId("expense-approval-settings-form-error");
  });
});
