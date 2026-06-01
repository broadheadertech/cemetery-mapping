import { describe, it, expect, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
import { useNetworkState } from "@/hooks/useNetworkState";

function Probe() {
  const state = useNetworkState();
  return <span data-testid="state">{state}</span>;
}

describe("useNetworkState", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "onLine",
  );

  afterEach(() => {
    cleanup();
    if (originalDescriptor) {
      Object.defineProperty(navigator, "onLine", originalDescriptor);
    }
  });

  it("reports the current network state on first render", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    const { getByTestId } = render(<Probe />);
    // The hook starts optimistic (SSR-safe) and corrects on effect.
    // After the mount effect, the value reflects navigator.onLine.
    expect(getByTestId("state").textContent).toBe("offline");
  });

  it("updates when online/offline events fire", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("state").textContent).toBe("online");

    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(getByTestId("state").textContent).toBe("offline");

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(getByTestId("state").textContent).toBe("online");
  });
});
