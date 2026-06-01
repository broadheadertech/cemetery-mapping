import { describe, it, expect, vi, afterEach } from "vitest";
import { registerServiceWorker } from "@/lib/pwa";

/**
 * Only meaningful assertions in jsdom are that registration is gated by
 * `NODE_ENV === "production"` and short-circuits when `serviceWorker`
 * is unavailable. `vi.stubEnv` is the supported way to mutate
 * `process.env` under Vitest 2.x — direct assignment is blocked.
 */

describe("registerServiceWorker", () => {
  const originalSW = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalSW === undefined) {
      delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    } else {
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: originalSW,
      });
    }
  });

  it("is a no-op in non-production NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "development");
    const register = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it("is a no-op when serviceWorker is absent in the browser", () => {
    vi.stubEnv("NODE_ENV", "production");
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it("calls navigator.serviceWorker.register in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const register = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });
    registerServiceWorker();
    expect(register).toHaveBeenCalledWith("/sw.js");
  });
});
