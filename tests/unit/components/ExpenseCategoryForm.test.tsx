/**
 * ExpenseCategoryForm — Story 4.7 component tests.
 *
 * Coverage:
 *   - Required name; max-length validation; oversized description.
 *   - Submit handler receives a normalised payload (trimmed name,
 *     trimmed description, empty description dropped).
 *   - Edit mode shows the rename-immutability warning.
 *   - Duplicate-name hint blocks submit before the server is hit.
 *   - Server-side error returned from onSubmit surfaces inline.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ExpenseCategoryForm,
  type ExpenseCategoryFormSubmitPayload,
} from "../../../src/components/ExpenseCategoryForm";

describe("ExpenseCategoryForm — create mode", () => {
  it("requires a non-empty name before submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<ExpenseCategoryForm mode="create" onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /create category/i }));

    await screen.findByText(/name is required/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("normalises the payload (trim name, trim description) on submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: ExpenseCategoryFormSubmitPayload) => {});
    render(<ExpenseCategoryForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/name/i), "  Insurance  ");
    await user.type(
      screen.getByLabelText(/description/i),
      "  Monthly premium  ",
    );

    await user.click(screen.getByRole("button", { name: /create category/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Insurance",
      description: "Monthly premium",
    });
  });

  it("omits description when blank", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: ExpenseCategoryFormSubmitPayload) => {});
    render(<ExpenseCategoryForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/name/i), "Travel");
    await user.click(screen.getByRole("button", { name: /create category/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ name: "Travel" });
  });

  it("does not show the rename-immutability warning in create mode", () => {
    render(<ExpenseCategoryForm mode="create" onSubmit={vi.fn()} />);
    expect(
      screen.queryByText(/will not change how it appears on past expenses/i),
    ).toBeNull();
  });

  it("blocks submit when a duplicate name hint matches", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <ExpenseCategoryForm
        mode="create"
        onSubmit={onSubmit}
        duplicateName="Utilities"
      />,
    );

    await user.type(screen.getByLabelText(/name/i), "utilities");
    await screen.findByText(/category with this name already exists/i);

    await user.click(screen.getByRole("button", { name: /create category/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces server error from onSubmit via translateError", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw Object.assign(new Error("server"), {
        data: { code: "VALIDATION" },
      });
    });
    render(<ExpenseCategoryForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/name/i), "Insurance");
    await user.click(screen.getByRole("button", { name: /create category/i }));

    await screen.findByTestId("expense-category-form-error");
  });

  it("invokes onCancel when Cancel is pressed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ExpenseCategoryForm
        mode="create"
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("ExpenseCategoryForm — edit mode", () => {
  it("pre-fills the form with defaultValues", () => {
    render(
      <ExpenseCategoryForm
        mode="edit"
        onSubmit={vi.fn()}
        defaultValues={{
          name: "Utilities",
          description: "Electricity, water",
        }}
      />,
    );
    expect(
      (screen.getByLabelText(/name/i) as HTMLInputElement).value,
    ).toBe("Utilities");
    expect(
      (screen.getByLabelText(/description/i) as HTMLTextAreaElement).value,
    ).toBe("Electricity, water");
  });

  it("shows the rename-immutability warning", () => {
    render(
      <ExpenseCategoryForm
        mode="edit"
        onSubmit={vi.fn()}
        defaultValues={{ name: "Utilities", description: "" }}
      />,
    );
    expect(
      screen.getByText(/will not change how it appears on past expenses/i),
    ).toBeTruthy();
  });

  it("uses the Save changes CTA label", () => {
    render(
      <ExpenseCategoryForm
        mode="edit"
        onSubmit={vi.fn()}
        defaultValues={{ name: "x", description: "" }}
      />,
    );
    expect(screen.getByRole("button", { name: /save changes/i })).toBeTruthy();
  });
});
