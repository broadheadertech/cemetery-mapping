import { describe, it, expect, vi, afterEach } from "vitest";
import {
  readNetworkState,
  subscribeToNetworkState,
} from "@/lib/network-state";

describe("readNetworkState", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "onLine",
  );

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, "onLine", originalDescriptor);
    }
  });

  it("returns 'online' when navigator reports online", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    expect(readNetworkState()).toBe("online");
  });

  it("returns 'offline' when navigator reports offline", () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    expect(readNetworkState()).toBe("offline");
  });
});

describe("subscribeToNetworkState", () => {
  it("notifies callback on online + offline transitions", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeToNetworkState(callback);

    window.dispatchEvent(new Event("offline"));
    expect(callback).toHaveBeenLastCalledWith("offline");

    window.dispatchEvent(new Event("online"));
    expect(callback).toHaveBeenLastCalledWith("online");

    unsubscribe();
    window.dispatchEvent(new Event("offline"));
    // After unsubscribe the callback should not fire again — call count
    // stays at two.
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
