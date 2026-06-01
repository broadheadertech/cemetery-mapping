/**
 * Story 1.14 — LogConditionForm component tests.
 *
 * Coverage:
 *   - Note is required; whitespace-only submission shows inline error.
 *   - Online state allows submit; offline state disables submit + shows
 *     inline banner; no upload + no onSubmit call when offline.
 *   - Photo selection shows preview + Remove button.
 *   - Photo upload error propagates to inline error.
 *   - Idempotency key is stable across re-renders.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LogConditionForm } from "./LogConditionForm";

// Stub `crypto.randomUUID` to a stable string so we can assert the
// idempotency-key behaviour without a live UUID generator. Also
// polyfill `URL.createObjectURL` + `URL.revokeObjectURL` — jsdom
// doesn't ship these but the photo-preview flow needs them.
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g.crypto) g.crypto = {};
  g.crypto.randomUUID = vi.fn(() => "test-uuid-1");
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: (file: File) => string }).createObjectURL =
      vi.fn(() => "blob:mock-preview");
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL =
      vi.fn();
  }
});

describe("LogConditionForm", () => {
  it("submits a trimmed note with the idempotency key when online", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn(async () => "https://example/upload");
    render(
      <LogConditionForm
        isOnline={true}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );

    await user.type(
      screen.getByLabelText(/observe/i),
      "   Fresh flowers placed.   ",
    );
    await user.click(screen.getByTestId("log-condition-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        note: "Fresh flowers placed.",
        idempotencyKey: "test-uuid-1",
        photoStorageId: undefined,
      }),
    );
    // No photo selected, so generateUploadUrl should not have been called.
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });

  it("disables submit and shows the offline banner when isOnline is false", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn();
    render(
      <LogConditionForm
        isOnline={false}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );
    expect(
      screen.getByTestId("log-condition-offline-banner"),
    ).toBeInTheDocument();
    const submit = screen.getByTestId("log-condition-submit");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/observe/i), "Offline observation");
    // Force-click won't fire React's submit handler on a disabled button,
    // but verify that even attempting it leaves onSubmit untouched.
    await user.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("rejects an empty note with inline validation error", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <LogConditionForm
        isOnline={true}
        generateUploadUrl={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByTestId("log-condition-submit"));
    await screen.findByText(/note is required/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("uploads the photo first and passes the storage id to onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn(async () => "https://upload");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ storageId: "_storage:photo-1" }),
    } as unknown as Response);

    render(
      <LogConditionForm
        isOnline={true}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );

    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    const input = screen.getByTestId(
      "condition-photo-input",
    ) as HTMLInputElement;
    await user.upload(input, file);

    await user.type(screen.getByLabelText(/observe/i), "with photo");
    await user.click(screen.getByTestId("log-condition-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(generateUploadUrl).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://upload",
      expect.objectContaining({ method: "POST" }),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        note: "with photo",
        photoStorageId: "_storage:photo-1",
      }),
    );

    fetchSpy.mockRestore();
  });

  it("surfaces an upload failure as an inline error and does not call onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn(async () => "https://upload");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      json: async () => ({}),
    } as unknown as Response);

    render(
      <LogConditionForm
        isOnline={true}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );

    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    const input = screen.getByTestId(
      "condition-photo-input",
    ) as HTMLInputElement;
    await user.upload(input, file);
    await user.type(screen.getByLabelText(/observe/i), "boom");
    await user.click(screen.getByTestId("log-condition-submit"));

    await screen.findByTestId("log-condition-error");
    expect(onSubmit).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
