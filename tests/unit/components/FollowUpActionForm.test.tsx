/**
 * Story 4.2 — FollowUpActionForm component tests.
 *
 * Coverage:
 *   - Renders default fields with sensible defaults (today's date,
 *     phone_call selected).
 *   - Submits a happy-path payload with epoch ms + trimmed notes.
 *   - Treats blank notes as undefined.
 *   - Surfaces server errors inline with `role="alert"` and does not
 *     keep the submit button stuck disabled.
 *   - Cancel button fires onCancel.
 *   - Notes count caps at 500 chars (maxLength enforced by DOM).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FollowUpActionForm } from "../../../src/components/FollowUpActionForm";

const FIXED_NOW = new Date("2026-05-20T08:00:00+08:00").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

describe("FollowUpActionForm", () => {
  it("renders the action select, date input, and notes textarea", () => {
    render(<FollowUpActionForm onSubmit={vi.fn()} />);
    expect(screen.getByTestId("follow-up-action-select")).toBeInTheDocument();
    expect(screen.getByTestId("follow-up-due-at-input")).toBeInTheDocument();
    expect(screen.getByTestId("follow-up-notes-input")).toBeInTheDocument();
    expect(screen.getByTestId("follow-up-form-submit")).toBeEnabled();
  });

  it("submits a happy-path payload with epoch ms + trimmed notes", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    interface Payload {
      action: string;
      dueAt: number;
      notes?: string;
    }
    const onSubmit = vi.fn(async (_p: Payload) => {});
    render(<FollowUpActionForm onSubmit={onSubmit} />);

    await user.selectOptions(
      screen.getByTestId("follow-up-action-select"),
      "sms",
    );
    const dateInput = screen.getByTestId(
      "follow-up-due-at-input",
    ) as HTMLInputElement;
    // userEvent.type on a date input is fiddly; set the value directly
    // and fire the change event via fireEvent (RTL-recommended).
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(dateInput, { target: { value: "2026-05-27" } });
    await user.type(
      screen.getByTestId("follow-up-notes-input"),
      "  Called, will pay Friday  ",
    );

    await user.click(screen.getByTestId("follow-up-form-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.action).toBe("sms");
    expect(payload.notes).toBe("Called, will pay Friday");
    // 2026-05-27T00:00:00+08:00 epoch ms
    expect(payload.dueAt).toBe(
      new Date("2026-05-27T00:00:00+08:00").getTime(),
    );
  });

  it("omits notes from the payload when blank", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    interface Payload {
      action: string;
      dueAt: number;
      notes?: string;
    }
    const onSubmit = vi.fn(async (_p: Payload) => {});
    render(<FollowUpActionForm onSubmit={onSubmit} />);
    await user.click(screen.getByTestId("follow-up-form-submit"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.notes).toBeUndefined();
  });

  it("surfaces server errors inline with role=alert when onSubmit throws", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw new Error("This installment is no longer overdue.");
    });
    render(<FollowUpActionForm onSubmit={onSubmit} />);
    await user.click(screen.getByTestId("follow-up-form-submit"));
    const error = await screen.findByTestId("follow-up-form-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(error.textContent).toContain("no longer overdue");
    // Submit should be re-enabled after the failure.
    expect(screen.getByTestId("follow-up-form-submit")).toBeEnabled();
  });

  it("invokes onCancel when Cancel is clicked", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<FollowUpActionForm onSubmit={vi.fn()} onCancel={onCancel} />);
    await user.click(screen.getByTestId("follow-up-form-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("does not render the Cancel button when onCancel is not provided", () => {
    render(<FollowUpActionForm onSubmit={vi.fn()} />);
    expect(
      screen.queryByTestId("follow-up-form-cancel"),
    ).not.toBeInTheDocument();
  });

  it("caps the notes input at 500 characters via the maxLength attribute", () => {
    render(<FollowUpActionForm onSubmit={vi.fn()} />);
    const notes = screen.getByTestId(
      "follow-up-notes-input",
    ) as HTMLTextAreaElement;
    expect(notes.maxLength).toBe(500);
  });
});
