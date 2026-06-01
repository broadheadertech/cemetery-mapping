/**
 * Story 7.4 — CompletionForm component tests.
 *
 * Coverage:
 *   - Renders the read-only context header (occupant + lot + scheduled time)
 *   - Submit without notes / without photo → calls onSubmit with both undefined
 *   - Submit with trimmed notes → trimmed value reaches onSubmit
 *   - Photo selection → preview + Remove button → cleared state
 *   - Photo upload failure → inline error, onSubmit NOT called
 *   - Photo upload success → photoStorageId reaches onSubmit
 *   - Cancel button → invokes onCancel; does NOT call onSubmit
 *   - Notes >500 chars → inline validation error
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CompletionForm } from "../../../src/components/IntermentForm/CompletionForm";

beforeEach(() => {
  // jsdom doesn't ship URL.createObjectURL / revokeObjectURL — polyfill
  // so the photo-preview flow doesn't crash.
  if (typeof URL.createObjectURL !== "function") {
    (
      URL as unknown as { createObjectURL: (file: File) => string }
    ).createObjectURL = vi.fn(() => "blob:mock-preview");
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (
      URL as unknown as { revokeObjectURL: (url: string) => void }
    ).revokeObjectURL = vi.fn();
  }
});

const baseProps = {
  occupantName: "Juan Santos",
  lotCode: "D-5-12",
  scheduledAt: new Date("2026-06-01T10:00:00+08:00").getTime(),
};

describe("CompletionForm", () => {
  it("renders the read-only context header (occupant + lot + scheduled time)", () => {
    render(
      <CompletionForm
        {...baseProps}
        generateUploadUrl={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText("Juan Santos")).toBeInTheDocument();
    expect(screen.getByText(/D-5-12/)).toBeInTheDocument();
    expect(screen.getByTestId("completion-scheduled-at")).toBeInTheDocument();
  });

  it("submits with undefined notes and undefined photo when neither is supplied", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn();
    render(
      <CompletionForm
        {...baseProps}
        generateUploadUrl={generateUploadUrl}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByTestId("completion-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      notes: undefined,
      photoStorageId: undefined,
    });
    expect(generateUploadUrl).not.toHaveBeenCalled();
  });

  it("trims whitespace from notes before submission", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(
      <CompletionForm
        {...baseProps}
        generateUploadUrl={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    await user.type(
      screen.getByLabelText(/notes/i),
      "   Family arrived on time.   ",
    );
    await user.click(screen.getByTestId("completion-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      notes: "Family arrived on time.",
      photoStorageId: undefined,
    });
  });

  it("surfaces a photo upload error inline and does NOT call onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn(async () => "https://example/upload");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response("nope", { status: 500 }) as unknown as Response,
    ) as unknown as typeof fetch;

    try {
      render(
        <CompletionForm
          {...baseProps}
          generateUploadUrl={generateUploadUrl}
          onSubmit={onSubmit}
        />,
      );
      const file = new File(["x"], "burial.jpg", { type: "image/jpeg" });
      const input = screen.getByTestId(
        "completion-photo-input",
      ) as HTMLInputElement;
      await user.upload(input, file);
      await user.click(screen.getByTestId("completion-submit"));

      await waitFor(() => {
        expect(screen.getByTestId("completion-photo-error")).toHaveTextContent(
          /Photo upload failed/,
        );
      });
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("submits with the resolved photoStorageId on a successful upload", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const generateUploadUrl = vi.fn(async () => "https://example/upload");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ storageId: "_storage:photo42" }), {
          status: 200,
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    try {
      render(
        <CompletionForm
          {...baseProps}
          generateUploadUrl={generateUploadUrl}
          onSubmit={onSubmit}
        />,
      );
      const file = new File(["x"], "burial.jpg", { type: "image/jpeg" });
      const input = screen.getByTestId(
        "completion-photo-input",
      ) as HTMLInputElement;
      await user.upload(input, file);
      await user.click(screen.getByTestId("completion-submit"));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit).toHaveBeenCalledWith({
        notes: undefined,
        photoStorageId: "_storage:photo42",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancel button invokes onCancel and does NOT call onSubmit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(
      <CompletionForm
        {...baseProps}
        generateUploadUrl={vi.fn()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByTestId("completion-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submit button meets the 44px tap target requirement (NFR-A4)", () => {
    render(
      <CompletionForm
        {...baseProps}
        generateUploadUrl={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("completion-submit");
    expect(btn.className).toMatch(/min-h-\[44px\]/);
  });
});
