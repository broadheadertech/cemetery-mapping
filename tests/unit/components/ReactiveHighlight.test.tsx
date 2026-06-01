import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

/**
 * ReactiveHighlight contract:
 *   1. First render NEVER flashes (would announce stale values).
 *   2. Subsequent `watch` changes apply `animate-flash-fade` + the
 *      `--flash-duration` inline style.
 *   3. Same value (Object.is equal) does NOT re-flash.
 *   4. Wrapper carries `aria-live="polite"` so screen readers
 *      announce the new value once and quiet down.
 *   5. Custom `durationMs` is reflected in the inline style.
 *   6. Children render unaltered in both states.
 */

describe("ReactiveHighlight", () => {
  it("does NOT apply the flash class on first render", () => {
    render(
      <ReactiveHighlight watch="initial">
        <span>value</span>
      </ReactiveHighlight>,
    );
    const wrapper = screen.getByTestId("reactive-highlight");
    const inner = wrapper.firstElementChild as HTMLElement;
    expect(inner).not.toBeNull();
    expect(inner.className ?? "").not.toContain("animate-flash-fade");
    expect(inner.getAttribute("data-flash-key")).toBe("0");
  });

  it("renders children content untouched", () => {
    render(
      <ReactiveHighlight watch={1}>
        <span>₱12,345</span>
      </ReactiveHighlight>,
    );
    expect(screen.getByText("₱12,345")).toBeInTheDocument();
  });

  it("sets aria-live=polite on the wrapper", () => {
    render(
      <ReactiveHighlight watch={1}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    expect(screen.getByTestId("reactive-highlight")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  it("applies the flash class once watch changes", () => {
    const { rerender } = render(
      <ReactiveHighlight watch={1}>
        <span>x</span>
      </ReactiveHighlight>,
    );

    let inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.className ?? "").not.toContain("animate-flash-fade");

    rerender(
      <ReactiveHighlight watch={2}>
        <span>x</span>
      </ReactiveHighlight>,
    );

    inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.className ?? "").toContain("animate-flash-fade");
    expect(inner.getAttribute("data-flash-key")).toBe("1");
  });

  it("does NOT re-flash when watch stays identical", () => {
    const { rerender } = render(
      <ReactiveHighlight watch="same">
        <span>x</span>
      </ReactiveHighlight>,
    );
    rerender(
      <ReactiveHighlight watch="same">
        <span>x</span>
      </ReactiveHighlight>,
    );
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.getAttribute("data-flash-key")).toBe("0");
    expect(inner.className ?? "").not.toContain("animate-flash-fade");
  });

  it("re-flashes on every distinct change", () => {
    const { rerender } = render(
      <ReactiveHighlight watch={1}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    rerender(
      <ReactiveHighlight watch={2}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    rerender(
      <ReactiveHighlight watch={3}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.getAttribute("data-flash-key")).toBe("2");
  });

  it("threads custom durationMs into the inline --flash-duration style", () => {
    const { rerender } = render(
      <ReactiveHighlight watch={1} durationMs={1200}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    rerender(
      <ReactiveHighlight watch={2} durationMs={1200}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.style.getPropertyValue("--flash-duration")).toBe("1200ms");
  });

  it("uses the default 600ms duration when durationMs is omitted", () => {
    const { rerender } = render(
      <ReactiveHighlight watch={1}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    rerender(
      <ReactiveHighlight watch={2}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.style.getPropertyValue("--flash-duration")).toBe("600ms");
  });

  it("supports boolean watch values", () => {
    const { rerender } = render(
      <ReactiveHighlight watch={false}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    rerender(
      <ReactiveHighlight watch={true}>
        <span>x</span>
      </ReactiveHighlight>,
    );
    const inner = screen.getByTestId("reactive-highlight")
      .firstElementChild as HTMLElement;
    expect(inner.getAttribute("data-flash-key")).toBe("1");
  });

  it("applies a caller className to the wrapper", () => {
    render(
      <ReactiveHighlight watch={1} className="ml-2 text-sm">
        <span>x</span>
      </ReactiveHighlight>,
    );
    const wrapper = screen.getByTestId("reactive-highlight");
    expect(wrapper.className).toContain("ml-2");
    expect(wrapper.className).toContain("text-sm");
  });
});
