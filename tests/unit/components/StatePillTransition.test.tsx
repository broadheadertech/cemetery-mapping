import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach } from "vitest";

import { StatePillTransition } from "@/components/ui/StatePillTransition";

/**
 * StatePillTransition is a thin composition wrapper:
 *   - It must render the `StatusPill` underneath (correct label,
 *     aria-label, status-aware class chunk).
 *   - It must wire the outer `ReactiveHighlight` to `watch={status}`
 *     so a status change re-keys the inner span and triggers the
 *     amber flash (asserted via the `animate-flash-fade` class).
 *   - First render NEVER flashes (would announce stale values per
 *     `ReactiveHighlight`'s contract).
 *   - `flashDurationMs` threads through to the inner span's inline
 *     `--flash-duration` custom property when the value ticks.
 *   - StatusPill prop pass-through: `size` and `showIcon` propagate.
 *
 * The 300ms colour crossfade on the pill itself is verified at the
 * `StatusPill` unit-test level; here we only assert the wrapper
 * composition shape, not the underlying CSS animation.
 */

describe("StatePillTransition", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the underlying StatusPill with correct label + aria-label", () => {
    render(<StatePillTransition status="available" size="md" />);
    const pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("aria-label", "Available");
    expect(pill).toHaveTextContent("Available");
    expect(pill).toHaveAttribute("data-status", "available");
  });

  it("passes the `size` prop through to StatusPill", () => {
    render(<StatePillTransition status="reserved" size="lg" />);
    const pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("data-size", "lg");
  });

  it("passes the `showIcon={false}` prop through to StatusPill", () => {
    const { container } = render(
      <StatePillTransition status="sold" showIcon={false} />,
    );
    // With showIcon=false the only child of the pill is the <span> label.
    const pill = screen.getByRole("status");
    expect(pill.querySelector("svg")).toBeNull();
    // sanity: container still rendered
    expect(container.firstChild).not.toBeNull();
  });

  it("wraps the pill in a ReactiveHighlight (aria-live polite wrapper)", () => {
    render(<StatePillTransition status="available" />);
    const wrapper = screen.getByTestId("reactive-highlight");
    expect(wrapper).toHaveAttribute("aria-live", "polite");
    // The pill is inside the wrapper.
    expect(wrapper.querySelector("[role='status']")).not.toBeNull();
  });

  it("does NOT flash on first render", () => {
    render(<StatePillTransition status="available" />);
    const wrapper = screen.getByTestId("reactive-highlight");
    const inner = wrapper.firstElementChild as HTMLElement;
    expect(inner).not.toBeNull();
    expect(inner.className ?? "").not.toContain("animate-flash-fade");
    expect(inner.getAttribute("data-flash-key")).toBe("0");
  });

  it("applies the amber-flash class AND swaps to the new status palette when status changes", () => {
    const { rerender } = render(
      <StatePillTransition status="available" size="md" />,
    );
    // Initial render — pill carries the `available` palette.
    let pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("data-status", "available");
    expect(pill.className).toContain("bg-status-available-bg");

    // Status transitions: available → sold.
    rerender(<StatePillTransition status="sold" size="md" />);

    // Outer ReactiveHighlight re-keyed → flash class present.
    const wrapper = screen.getByTestId("reactive-highlight");
    const inner = wrapper.firstElementChild as HTMLElement;
    expect(inner.className ?? "").toContain("animate-flash-fade");
    expect(inner.getAttribute("data-flash-key")).toBe("1");

    // Inner StatusPill swapped to the new status palette + label.
    pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("data-status", "sold");
    expect(pill).toHaveAttribute("aria-label", "Sold");
    expect(pill.className).toContain("bg-status-sold-bg");
  });

  it("does NOT re-flash when the same status renders twice", () => {
    const { rerender } = render(
      <StatePillTransition status="reserved" />,
    );
    rerender(<StatePillTransition status="reserved" />);
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.getAttribute("data-flash-key")).toBe("0");
    expect(inner.className ?? "").not.toContain("animate-flash-fade");
  });

  it("threads `flashDurationMs` into the ReactiveHighlight inline --flash-duration on change", () => {
    const { rerender } = render(
      <StatePillTransition status="available" flashDurationMs={1200} />,
    );
    rerender(
      <StatePillTransition status="sold" flashDurationMs={1200} />,
    );
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.style.getPropertyValue("--flash-duration")).toBe("1200ms");
  });

  it("uses the ReactiveHighlight default (600ms) when flashDurationMs is omitted", () => {
    const { rerender } = render(<StatePillTransition status="available" />);
    rerender(<StatePillTransition status="reserved" />);
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.style.getPropertyValue("--flash-duration")).toBe("600ms");
  });

  it("applies `wrapperClassName` to the outer ReactiveHighlight wrapper", () => {
    render(
      <StatePillTransition
        status="available"
        wrapperClassName="ml-2 inline-block"
      />,
    );
    const wrapper = screen.getByTestId("reactive-highlight");
    expect(wrapper.className).toContain("ml-2");
  });

  it("retains the StatusPill's 300ms colour crossfade utility on the pill itself", () => {
    render(<StatePillTransition status="available" />);
    const pill = screen.getByRole("status");
    // The StatusPill applies a property-scoped transition for bg/color/border.
    expect(pill.className).toContain(
      "transition-[background-color,color,border-color]",
    );
    expect(pill.className).toContain("duration-300");
  });
});
