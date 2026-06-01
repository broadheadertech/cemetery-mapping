import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CacheFreshnessPill } from "@/components/CacheFreshnessPill";

/**
 * The pill is a pure consumer of `useOfflineCache()`. The hook is
 * mocked here so we can exercise the three render branches without
 * setting up a full SW + cache-message harness.
 */

const useOfflineCache = vi.fn();
vi.mock("@/hooks/useOfflineCache", () => ({
  useOfflineCache: () => useOfflineCache(),
}));

describe("CacheFreshnessPill", () => {
  afterEach(() => {
    cleanup();
    useOfflineCache.mockReset();
  });

  it("renders nothing when online", () => {
    useOfflineCache.mockReturnValue({ status: "online" });
    const { container } = render(<CacheFreshnessPill />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the amber 'Cached Xm ago' state when fresh", () => {
    useOfflineCache.mockReturnValue({
      status: "cached-fresh",
      cachedAt: Date.now() - 5 * 60_000,
      ageMs: 5 * 60_000,
    });
    const { getByTestId } = render(<CacheFreshnessPill />);
    const pill = getByTestId("cache-freshness-pill");
    expect(pill.textContent).toContain("Cached 5m ago");
    expect(pill.dataset.cacheState).toBe("cached-fresh");
  });

  it("renders the red 'may be outdated' state when stale", () => {
    useOfflineCache.mockReturnValue({
      status: "cached-stale",
      cachedAt: 0,
      ageMs: 999_999_999,
    });
    const { getByTestId } = render(<CacheFreshnessPill />);
    const pill = getByTestId("cache-freshness-pill");
    expect(pill.textContent).toContain("Cached, may be outdated");
    expect(pill.dataset.cacheState).toBe("cached-stale");
  });
});
