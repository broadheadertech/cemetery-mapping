/**
 * NavigateToLotButton — Story 8.3 component tests.
 *
 * Coverage target: ≥ 80% (NFR-M2). Exercises:
 *   - Enabled rendering + click → onNavigate receives the correct URL.
 *   - Disabled rendering for placeholder geometry.
 *   - Disabled rendering when centroid is undefined.
 *   - Tooltip-wrapped disabled state preserves keyboard focusability
 *     via a span(tabIndex=0) — required because <button disabled> is
 *     not focusable but Radix TooltipTrigger needs a focusable child.
 *   - Touch-target size (44×44 px floor) — NFR-A4.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NavigateToLotButton } from "@/components/NavigateToLotButton";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function setUserAgent(ua: string) {
  // jsdom allows overriding navigator.userAgent via defineProperty.
  Object.defineProperty(window.navigator, "userAgent", {
    value: ua,
    configurable: true,
  });
}

describe("NavigateToLotButton", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders an enabled button with the 'Open in Maps' label when surveyed + centroid present", () => {
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="surveyed"
        centroid={{ lat: 14.6, lng: 120.9 }}
      />,
    );

    const button = screen.getByTestId("navigate-to-lot-button");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Open in Maps");
    expect(button).toHaveAttribute(
      "aria-label",
      "Open in Maps for lot D-5-12",
    );
  });

  it("renders 44×44 minimum touch target (NFR-A4)", () => {
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="surveyed"
        centroid={{ lat: 14.6, lng: 120.9 }}
      />,
    );
    const button = screen.getByTestId("navigate-to-lot-button");
    expect(button.className).toContain("min-h-[44px]");
    expect(button.className).toContain("min-w-[44px]");
  });

  it("calls onNavigate with the Android geo: URL on click", async () => {
    const user = userEvent.setup();
    setUserAgent(ANDROID_UA);
    const onNavigate = vi.fn();
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="surveyed"
        centroid={{ lat: 14.5995, lng: 120.9842 }}
        onNavigate={onNavigate}
      />,
    );

    await user.click(screen.getByTestId("navigate-to-lot-button"));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    const url = onNavigate.mock.calls[0]?.[0] as string;
    expect(url).toContain("geo:14.599500,120.984200");
    expect(url).toContain("(Lot%20D-5-12)");
  });

  it("renders disabled when geometryStatus === 'placeholder'", () => {
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="placeholder"
        centroid={{ lat: 14.6, lng: 120.9 }}
      />,
    );
    const button = screen.getByTestId("navigate-to-lot-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.getAttribute("aria-label")).toMatch(/disabled/i);
    expect(button.getAttribute("aria-label")).toMatch(/not yet surveyed/i);
  });

  it("renders disabled when centroid is undefined even if surveyed (defense in depth)", () => {
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="surveyed"
        // centroid intentionally omitted
      />,
    );
    const button = screen.getByTestId("navigate-to-lot-button");
    expect(button).toBeDisabled();
  });

  it("wraps the disabled button in a focusable tooltip trigger", () => {
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="placeholder"
      />,
    );
    // The span wrapper makes the disabled button reachable by keyboard
    // so the Radix tooltip can fire on focus.
    const trigger = screen.getByTestId("navigate-to-lot-disabled-trigger");
    expect(trigger.tagName).toBe("SPAN");
    expect(trigger).toHaveAttribute("tabIndex", "0");
  });

  it("does NOT wrap the enabled button in a tooltip trigger (no extra DOM)", () => {
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="surveyed"
        centroid={{ lat: 14.6, lng: 120.9 }}
      />,
    );
    expect(
      screen.queryByTestId("navigate-to-lot-disabled-trigger"),
    ).toBeNull();
  });

  it("does not fire onNavigate when disabled and clicked", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="placeholder"
        onNavigate={onNavigate}
      />,
    );
    await user.click(screen.getByTestId("navigate-to-lot-button"));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("guards against re-entrancy: synchronous duplicate fire is swallowed", () => {
    // The component's `inFlight` ref blocks re-entry inside the same
    // sync handler. We exercise this by invoking the button's
    // onClick handler twice in quick succession (synthetic event
    // dispatch) and asserting onNavigate fires exactly once.
    const onNavigate = vi.fn();
    render(
      <NavigateToLotButton
        lotCode="D-5-12"
        geometryStatus="surveyed"
        centroid={{ lat: 14.6, lng: 120.9 }}
        onNavigate={onNavigate}
      />,
    );
    const button = screen.getByTestId("navigate-to-lot-button");
    // Direct dispatch — the second click hits while the first is
    // still in-flight (handler hasn't returned to the setTimeout
    // callback yet). The inFlight ref + busy state should swallow it.
    act(() => {
      button.click();
      button.click();
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
