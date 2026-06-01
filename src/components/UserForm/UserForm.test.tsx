/**
 * UserForm — Story 1.3 component tests.
 *
 * Coverage:
 *   - Required fields surface inline validation errors.
 *   - Submit handler receives a normalised payload (lowercased email,
 *     trimmed name, role list).
 *   - Server error from `onSubmit` is translated and rendered.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UserForm, type UserFormSubmitPayload } from "./UserForm";

describe("UserForm", () => {
  it("requires name, email, and at least one role before submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<UserForm onSubmit={onSubmit} />);

    await user.click(screen.getByRole("button", { name: /create user/i }));

    await screen.findByText(/name is required/i);
    expect(await screen.findAllByText(/required/i)).not.toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("normalises the payload (trim name, lowercase email, role list) on submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: UserFormSubmitPayload) => {});
    render(<UserForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/name/i), "  Maria Reyes  ");
    await user.type(screen.getByLabelText(/email/i), "  MARIA@Example.COM  ");
    // Roles fieldset — pick Office Staff.
    await user.click(screen.getByLabelText(/office staff/i));

    await user.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      name: "Maria Reyes",
      email: "maria@example.com",
      roles: ["office_staff"],
    });
  });

  it("supports multiple roles", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async (_p: UserFormSubmitPayload) => {});
    render(<UserForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/name/i), "Multi");
    await user.type(screen.getByLabelText(/email/i), "multi@example.com");
    await user.click(screen.getByLabelText(/admin/i));
    await user.click(screen.getByLabelText(/office staff/i));

    await user.click(screen.getByRole("button", { name: /create user/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const arg = onSubmit.mock.calls[0]![0] as UserFormSubmitPayload;
    expect(arg.roles.sort()).toEqual(["admin", "office_staff"]);
  });

  it("renders submit error from onSubmit via translateError", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw Object.assign(new Error("server"), {
        data: { code: "VALIDATION" },
      });
    });
    render(<UserForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/name/i), "Maria");
    await user.type(screen.getByLabelText(/email/i), "maria@example.com");
    await user.click(screen.getByLabelText(/office staff/i));

    await user.click(screen.getByRole("button", { name: /create user/i }));

    await screen.findByTestId("user-form-error");
  });

  it("calls onCancel when the Cancel button is pressed", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onSubmit = vi.fn(async () => {});
    render(<UserForm onSubmit={onSubmit} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
