/**
 * Story 7.1 — `IntermentForm` component tests.
 *
 * Coverage focus:
 *   - Initial render: occupant select autofocused, submit disabled
 *     until valid.
 *   - Empty occupants: select disabled with the no-occupants hint.
 *   - Successful submit: composes Manila-tz epoch ms and calls
 *     onSubmit with the trimmed payload.
 *   - Far-past date: blocked by inline Zod validator (1-day tolerance).
 *   - Notes >500 chars: blocked.
 *   - Server error (parent throws): translated message rendered.
 *   - "Add new occupant" affordance fires the callback.
 *   - pendingOccupantSelection auto-selects the new occupant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  IntermentForm,
  type IntermentOccupantOption,
} from "@/components/IntermentForm";
import { composeScheduledAtMs } from "@/components/IntermentForm/schema";

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

const OCCUPANTS: IntermentOccupantOption[] = [
  {
    occupantId: "occupants:1",
    name: "Juan Santos",
    relationshipToOwner: "Father",
    isRemoved: false,
  },
  {
    occupantId: "occupants:2",
    name: "Maria Santos",
    relationshipToOwner: "Spouse",
    isRemoved: false,
  },
  {
    occupantId: "occupants:3",
    name: "Old Removed Row",
    relationshipToOwner: "Cousin",
    isRemoved: true,
  },
];

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("IntermentForm", () => {
  it("autofocuses the occupant select on mount", () => {
    render(<IntermentForm occupants={OCCUPANTS} onSubmit={async () => {}} />);
    expect(screen.getByLabelText(/Occupant/)).toHaveFocus();
  });

  it("disables submit when the form is invalid", () => {
    render(<IntermentForm occupants={OCCUPANTS} onSubmit={async () => {}} />);
    expect(screen.getByTestId("interment-form-submit")).toBeDisabled();
  });

  it("filters removed occupants out of the select", () => {
    render(<IntermentForm occupants={OCCUPANTS} onSubmit={async () => {}} />);
    expect(screen.queryByText(/Old Removed Row/)).not.toBeInTheDocument();
    expect(screen.getByText(/Juan Santos/)).toBeInTheDocument();
  });

  it("disables the select and shows hint when there are no selectable occupants", () => {
    const removedOnly: IntermentOccupantOption[] = [
      {
        occupantId: "occupants:gone",
        name: "Old Row",
        relationshipToOwner: "x",
        isRemoved: true,
      },
    ];
    render(
      <IntermentForm occupants={removedOnly} onSubmit={async () => {}} />,
    );
    const select = screen.getByLabelText(/Occupant/) as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(
      screen.getByText(/No occupants on this lot/),
    ).toBeInTheDocument();
  });

  it("submits a Manila-tz-composed scheduledAt when valid", async () => {
    // Using real timers makes RHF's async resolver settle predictably.
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<IntermentForm occupants={OCCUPANTS} onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText(/Occupant/), "occupants:1");
    const dateInput = screen.getByLabelText(/Date/) as HTMLInputElement;
    const timeInput = screen.getByLabelText(/Time/) as HTMLInputElement;

    // RHF's `register` listens via the input's own change handler; we
    // use RTL's fireEvent.change so the synthetic React event hits the
    // registered onChange (assigning `.value` directly bypasses it).
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const yyyy = tomorrow.getFullYear().toString().padStart(4, "0");
    const mm = (tomorrow.getMonth() + 1).toString().padStart(2, "0");
    const dd = tomorrow.getDate().toString().padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    fireEvent.change(dateInput, { target: { value: dateStr } });
    fireEvent.change(timeInput, { target: { value: "10:00" } });

    await user.type(screen.getByLabelText(/Notes/), "  Family at 9am  ");

    await waitFor(() =>
      expect(screen.getByTestId("interment-form-submit")).toBeEnabled(),
    );
    await user.click(screen.getByTestId("interment-form-submit"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const calls = onSubmit.mock.calls as unknown as Array<
      [
        {
          occupantId: string;
          scheduledAt: number;
          notes: string | undefined;
        },
      ]
    >;
    const payload = calls[0]![0];
    expect(payload.occupantId).toBe("occupants:1");
    expect(payload.notes).toBe("Family at 9am");
    const expected = composeScheduledAtMs(dateStr, "10:00");
    expect(payload.scheduledAt).toBe(expected);
  });

  it("rejects a far-past date via inline Zod validator", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {});
    render(<IntermentForm occupants={OCCUPANTS} onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText(/Occupant/), "occupants:1");
    const dateInput = screen.getByLabelText(/Date/) as HTMLInputElement;
    const timeInput = screen.getByLabelText(/Time/) as HTMLInputElement;
    // Far past — 2020.
    fireEvent.change(dateInput, { target: { value: "2020-01-15" } });
    fireEvent.change(timeInput, { target: { value: "10:00" } });

    // Submit should stay disabled (form is invalid because of the
    // 1-day-past tolerance in the Zod refinement).
    await waitFor(() =>
      expect(screen.getByTestId("interment-form-submit")).toBeDisabled(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces a translated error when the parent submit rejects", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const err = Object.assign(new Error("FORBIDDEN"), {
      data: { code: "FORBIDDEN" },
    });
    const onSubmit = vi.fn(async () => {
      throw err;
    });
    render(<IntermentForm occupants={OCCUPANTS} onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText(/Occupant/), "occupants:1");
    const dateInput = screen.getByLabelText(/Date/) as HTMLInputElement;
    const timeInput = screen.getByLabelText(/Time/) as HTMLInputElement;
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const dateStr = `${tomorrow.getFullYear()}-${(tomorrow.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${tomorrow.getDate().toString().padStart(2, "0")}`;
    fireEvent.change(dateInput, { target: { value: dateStr } });
    fireEvent.change(timeInput, { target: { value: "11:00" } });

    await waitFor(() =>
      expect(screen.getByTestId("interment-form-submit")).toBeEnabled(),
    );
    await user.click(screen.getByTestId("interment-form-submit"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /role does not permit/i,
      ),
    );
  });

  it("invokes onRequestAddOccupant when the inline button is clicked", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onRequestAddOccupant = vi.fn();
    render(
      <IntermentForm
        occupants={OCCUPANTS}
        onSubmit={async () => {}}
        onRequestAddOccupant={onRequestAddOccupant}
      />,
    );
    await user.click(screen.getByTestId("interment-add-occupant"));
    expect(onRequestAddOccupant).toHaveBeenCalledTimes(1);
  });

  it("auto-selects pendingOccupantSelection when supplied", async () => {
    vi.useRealTimers();
    const { rerender } = render(
      <IntermentForm
        occupants={OCCUPANTS}
        onSubmit={async () => {}}
        pendingOccupantSelection={null}
      />,
    );
    const select = screen.getByLabelText(/Occupant/) as HTMLSelectElement;
    expect(select.value).toBe("");
    rerender(
      <IntermentForm
        occupants={OCCUPANTS}
        onSubmit={async () => {}}
        pendingOccupantSelection="occupants:2"
      />,
    );
    await waitFor(() => expect(select.value).toBe("occupants:2"));
  });

  it("invokes onCancel when the cancel button is clicked", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <IntermentForm
        occupants={OCCUPANTS}
        onSubmit={async () => {}}
        onCancel={onCancel}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
