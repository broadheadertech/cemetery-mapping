import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useCmdK } from "@/hooks/useCmdK";

function Probe({ onOpen }: { onOpen: () => void }) {
  useCmdK(onOpen);
  return <input data-testid="probe-input" />;
}

function dispatchChord(key = "k", opts: KeyboardEventInit = { metaKey: true }) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(event);
  return event;
}

describe("useCmdK", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it("opens the palette on Cmd+K", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    dispatchChord("k", { metaKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens the palette on Ctrl+K", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    dispatchChord("k", { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("ignores plain K presses", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    dispatchChord("k", {});
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("does NOT open while typing in an input", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<Probe onOpen={onOpen} />);
    const input = getByTestId("probe-input") as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    dispatchChord("k", { metaKey: true });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("preventDefaults the chord so the browser doesn't intercept it", () => {
    const onOpen = vi.fn();
    render(<Probe onOpen={onOpen} />);
    const event = dispatchChord("k", { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
  });
});
