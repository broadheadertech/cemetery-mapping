/**
 * Story 7.3 — IntermentCalendar component tests.
 *
 * Coverage focus:
 *   - Loading state renders the skeleton row when `events` is undefined.
 *   - Day cells render a count badge + truncated occupant list.
 *   - "+N more" overflow surfaces when a day has more than three rows.
 *   - Clicking a populated day cell opens the drill-in Sheet.
 *   - Empty cells stay non-interactive.
 *   - Prev / Next / Today buttons fire parent callbacks.
 *   - Cancelled events are dropped defensively even if the parent
 *     passes them (server already excludes by default).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  IntermentCalendar,
  type IntermentCalendarEvent,
} from "@/components/IntermentCalendar";

// Anchor "now" inside June 2026 (Manila) so the calendar always
// focuses on the same month regardless of the host clock.
const NOW_MS = new Date("2026-06-15T10:00:00+08:00").getTime();

function makeEvent(
  overrides: Partial<IntermentCalendarEvent> = {},
): IntermentCalendarEvent {
  return {
    intermentId: overrides.intermentId ?? "interments:e1",
    scheduledAt:
      overrides.scheduledAt ??
      new Date("2026-06-10T09:00:00+08:00").getTime(),
    status: overrides.status ?? "scheduled",
    occupantId: overrides.occupantId ?? "occupants:o1",
    occupantName: overrides.occupantName ?? "Juan Santos",
    lotId: overrides.lotId ?? "lots:l1",
    lotCode: overrides.lotCode ?? "D-5-12",
    lotSection: overrides.lotSection ?? "D",
  };
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("IntermentCalendar", () => {
  it("renders the loading skeleton when events is undefined", () => {
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={undefined}
        todayMs={NOW_MS}
      />,
    );
    expect(screen.getByTestId("calendar-loading")).toBeInTheDocument();
  });

  it("renders the month name + year header", () => {
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={[]}
        todayMs={NOW_MS}
      />,
    );
    expect(screen.getByText("June 2026")).toBeInTheDocument();
  });

  it("renders a count badge on days with events", () => {
    const events = [
      makeEvent({
        intermentId: "interments:a",
        scheduledAt: new Date("2026-06-10T09:00:00+08:00").getTime(),
        occupantName: "Alice",
      }),
      makeEvent({
        intermentId: "interments:b",
        scheduledAt: new Date("2026-06-10T11:30:00+08:00").getTime(),
        occupantName: "Bob",
      }),
    ];
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={events}
        todayMs={NOW_MS}
      />,
    );
    const badge = screen.getByTestId("calendar-count-2026-06-10");
    expect(badge).toHaveTextContent("2");
    expect(screen.getByTestId("calendar-event-interments:a")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-interments:b")).toBeInTheDocument();
  });

  it("surfaces a '+N more' indicator when day events exceed the inline limit", () => {
    const baseMs = new Date("2026-06-12T08:00:00+08:00").getTime();
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        intermentId: `interments:m${i}`,
        scheduledAt: baseMs + i * 60_000,
        occupantName: `Person ${i}`,
      }),
    );
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={events}
        todayMs={NOW_MS}
      />,
    );
    // Three rendered inline + "+2 more" indicator.
    expect(screen.getByTestId("calendar-event-interments:m0")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-interments:m2")).toBeInTheDocument();
    expect(
      screen.queryByTestId("calendar-event-interments:m3"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("opens the drill-in Sheet listing all events for the clicked day", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent({
        intermentId: "interments:a",
        scheduledAt: new Date("2026-06-10T09:00:00+08:00").getTime(),
        occupantName: "Alice",
        lotCode: "A-1-1",
      }),
      makeEvent({
        intermentId: "interments:b",
        scheduledAt: new Date("2026-06-10T11:30:00+08:00").getTime(),
        occupantName: "Bob",
        lotCode: "A-1-2",
      }),
    ];
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={events}
        todayMs={NOW_MS}
      />,
    );

    await user.click(screen.getByTestId("calendar-cell-2026-06-10"));
    const sheet = await screen.findByTestId("calendar-day-sheet");
    expect(within(sheet).getByText(/2 interments scheduled/)).toBeInTheDocument();
    expect(
      within(sheet).getByTestId("calendar-sheet-event-interments:a"),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByTestId("calendar-sheet-event-interments:b"),
    ).toBeInTheDocument();
    expect(within(sheet).getByText(/A-1-1/)).toBeInTheDocument();
    expect(within(sheet).getByText(/A-1-2/)).toBeInTheDocument();
  });

  it("renders an 'Open lot' link in the drill-in Sheet pointing at the lot", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent({
        intermentId: "interments:a",
        scheduledAt: new Date("2026-06-10T09:00:00+08:00").getTime(),
        lotId: "lots:abc",
      }),
    ];
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={events}
        todayMs={NOW_MS}
      />,
    );
    await user.click(screen.getByTestId("calendar-cell-2026-06-10"));
    const link = await screen.findByTestId(
      "calendar-sheet-lot-link-interments:a",
    );
    expect(link).toHaveAttribute("href", "/lots/lots:abc");
  });

  it("leaves empty day cells non-interactive", () => {
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={[]}
        todayMs={NOW_MS}
      />,
    );
    const cell = screen.getByTestId("calendar-cell-2026-06-10");
    expect(cell).toBeDisabled();
  });

  it("fires prev / next / today callbacks on navigation buttons", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onToday = vi.fn();
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={[]}
        onPrevMonth={onPrev}
        onNextMonth={onNext}
        onToday={onToday}
        todayMs={NOW_MS}
      />,
    );
    fireEvent.click(screen.getByTestId("calendar-prev"));
    fireEvent.click(screen.getByTestId("calendar-next"));
    fireEvent.click(screen.getByTestId("calendar-today"));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("drops cancelled events defensively even when handed in", () => {
    const events = [
      makeEvent({
        intermentId: "interments:s",
        scheduledAt: new Date("2026-06-10T09:00:00+08:00").getTime(),
        status: "scheduled",
      }),
      makeEvent({
        intermentId: "interments:c",
        scheduledAt: new Date("2026-06-10T11:30:00+08:00").getTime(),
        status: "cancelled",
      }),
    ];
    render(
      <IntermentCalendar
        year={2026}
        month={6}
        events={events}
        todayMs={NOW_MS}
      />,
    );
    const badge = screen.getByTestId("calendar-count-2026-06-10");
    expect(badge).toHaveTextContent("1");
    expect(
      screen.queryByTestId("calendar-event-interments:c"),
    ).not.toBeInTheDocument();
  });
});
