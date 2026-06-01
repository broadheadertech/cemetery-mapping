/**
 * Story 4.6 — ExpenseForm component tests.
 *
 * Coverage:
 *   - Renders all fields + the placeholder banner.
 *   - Validation errors for missing amount / vendor / category.
 *   - Successful submit with centavo + epoch-ms conversion + idempotency
 *     key forwarded.
 *   - Offline state disables submit and surfaces a banner.
 *   - Photo upload two-step: generateUploadUrl → fetch → onSubmit gets
 *     the storageId.
 *   - Cancel callback fires on cancel click.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExpenseForm } from "../../../src/components/ExpenseForm/ExpenseForm";

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.crypto) g.crypto = {};
  g.crypto.randomUUID = vi.fn(() => "expense-uuid-1");
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: (file: File) => string }).createObjectURL =
      vi.fn(() => "blob:mock-preview");
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL =
      vi.fn();
  }
});

const DEFAULT_PROPS = {
  categories: ["Utilities", "Maintenance", "Supplies", "Salaries", "Other"],
  isPlaceholderCategories: true,
  callerRoles: ["office_staff"],
  isOnline: true,
};

describe("ExpenseForm", () => {
  it("renders the placeholder banner when categories are not yet managed", () => {
    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        generateUploadUrl={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("expense-categories-banner")).toBeInTheDocument();
  });

  it("does not render the banner when categories are managed", () => {
    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        isPlaceholderCategories={false}
        generateUploadUrl={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId("expense-categories-banner"),
    ).not.toBeInTheDocument();
  });

  it("blocks submit with empty vendor / amount / category", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        generateUploadUrl={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByTestId("expense-form-submit"));
    // Multiple inline errors should appear; only assert that no submit
    // happened (the field-level error text is locale-dependent).
    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it("submits with centavo + epoch-ms + idempotency key on happy path", async () => {
    const user = userEvent.setup();
    interface SubmitPayload {
      paidAt: number;
      amountCents: number;
      vendor: string;
      category: string;
      idempotencyKey: string;
      photoStorageId?: string;
    }
    const onSubmit = vi.fn(async (_payload: SubmitPayload) => {});
    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        generateUploadUrl={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/amount/i), "2500.50");
    await user.type(screen.getByLabelText(/vendor/i), "  Meralco  ");
    await user.selectOptions(screen.getByLabelText(/category/i), "Utilities");

    await user.click(screen.getByTestId("expense-form-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const calls = onSubmit.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const payload = calls[0]![0];
    expect(payload.amountCents).toBe(250_050);
    expect(payload.vendor).toBe("Meralco");
    expect(payload.category).toBe("Utilities");
    expect(payload.idempotencyKey).toBe("expense-uuid-1");
    expect(typeof payload.paidAt).toBe("number");
    expect(Number.isFinite(payload.paidAt)).toBe(true);
    expect(payload.photoStorageId).toBeUndefined();
  });

  it("disables submit + shows offline banner when isOnline is false", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        isOnline={false}
        generateUploadUrl={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByTestId("expense-offline-banner")).toBeInTheDocument();
    expect(screen.getByTestId("expense-form-submit")).toBeDisabled();

    await user.type(screen.getByLabelText(/amount/i), "100");
    await user.type(screen.getByLabelText(/vendor/i), "x");
    await user.selectOptions(screen.getByLabelText(/category/i), "Other");
    await user.click(screen.getByTestId("expense-form-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uploads a photo first and passes the storage id to onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn(async () => "https://upload");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: "_storage:photo-1" }),
    } as unknown as Response);

    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/amount/i), "100");
    await user.type(screen.getByLabelText(/vendor/i), "Hardware");
    await user.selectOptions(screen.getByLabelText(/category/i), "Maintenance");

    const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
    const input = screen.getByTestId("expense-photo-input") as HTMLInputElement;
    await user.upload(input, file);

    await user.click(screen.getByTestId("expense-form-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(generateUploadUrl).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://upload",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 100_00,
        vendor: "Hardware",
        category: "Maintenance",
        photoStorageId: "_storage:photo-1",
      }),
    );
    fetchSpy.mockRestore();
  });

  it("surfaces an upload failure as an inline error and does not call onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const generateUploadUrl = vi.fn(async () => "https://upload");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as unknown as Response);

    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/amount/i), "100");
    await user.type(screen.getByLabelText(/vendor/i), "x");
    await user.selectOptions(screen.getByLabelText(/category/i), "Other");
    const file = new File(["x"], "r.jpg", { type: "image/jpeg" });
    await user.upload(
      screen.getByTestId("expense-photo-input") as HTMLInputElement,
      file,
    );
    await user.click(screen.getByTestId("expense-form-submit"));

    await screen.findByTestId("expense-form-error");
    expect(onSubmit).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("invokes onCancel when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ExpenseForm
        {...DEFAULT_PROPS}
        generateUploadUrl={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
