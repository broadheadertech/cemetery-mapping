import { describe, it, expect } from "vitest";
import {
  classifyCacheAge,
  formatCacheAge,
  isServedFromCacheMessage,
  STALENESS_THRESHOLD_MS,
} from "@/lib/offline-cache";

/**
 * Story 1.13 — offline cache policy unit tests.
 *
 * The 24h staleness threshold is the single biggest UX boundary in the
 * field-worker journey (NFR-R6). Tests pin the edge cases so a future
 * refactor of `classifyCacheAge` can't silently widen the policy.
 */

describe("classifyCacheAge", () => {
  const now = 1_700_000_000_000; // arbitrary fixed epoch

  it("returns online when cachedAt is null/undefined", () => {
    expect(classifyCacheAge(null, now)).toEqual({ status: "online" });
    expect(classifyCacheAge(undefined, now)).toEqual({ status: "online" });
  });

  it("returns cached-fresh for an entry written one minute ago", () => {
    const r = classifyCacheAge(now - 60_000, now);
    expect(r.status).toBe("cached-fresh");
    expect(r.ageMs).toBe(60_000);
    expect(r.cachedAt).toBe(now - 60_000);
  });

  it("returns cached-fresh at the boundary just under 24h", () => {
    const r = classifyCacheAge(now - (STALENESS_THRESHOLD_MS - 1), now);
    expect(r.status).toBe("cached-fresh");
  });

  it("returns cached-stale at the 24h boundary", () => {
    const r = classifyCacheAge(now - STALENESS_THRESHOLD_MS, now);
    expect(r.status).toBe("cached-stale");
  });

  it("returns cached-stale for an entry > 24h old", () => {
    const r = classifyCacheAge(now - 2 * STALENESS_THRESHOLD_MS, now);
    expect(r.status).toBe("cached-stale");
    expect(r.ageMs).toBe(2 * STALENESS_THRESHOLD_MS);
  });

  it("clamps a future-dated cachedAt to age 0", () => {
    const r = classifyCacheAge(now + 5_000, now);
    expect(r.ageMs).toBe(0);
    expect(r.status).toBe("cached-fresh");
  });

  it("treats NaN as online (defensive)", () => {
    expect(classifyCacheAge(NaN, now)).toEqual({ status: "online" });
  });
});

describe("formatCacheAge", () => {
  it("renders 'just now' for under a minute", () => {
    expect(formatCacheAge(45_000)).toBe("just now");
  });
  it("renders Xm for minute-resolution ages", () => {
    expect(formatCacheAge(12 * 60_000)).toBe("12m ago");
  });
  it("renders Xh for hour-resolution ages", () => {
    expect(formatCacheAge(3 * 60 * 60_000)).toBe("3h ago");
  });
  it("renders Xd for day-resolution ages", () => {
    expect(formatCacheAge(2 * 24 * 60 * 60_000)).toBe("2d ago");
  });
});

describe("isServedFromCacheMessage", () => {
  it("accepts a well-formed message", () => {
    expect(
      isServedFromCacheMessage({
        type: "served-from-cache",
        url: "https://app/lots",
        cachedAt: 1,
        stale: false,
      }),
    ).toBe(true);
  });

  it("rejects messages with the wrong type", () => {
    expect(
      isServedFromCacheMessage({
        type: "other",
        url: "x",
        cachedAt: 1,
        stale: false,
      }),
    ).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isServedFromCacheMessage(null)).toBe(false);
    expect(isServedFromCacheMessage(undefined)).toBe(false);
    expect(isServedFromCacheMessage("string")).toBe(false);
  });

  it("rejects messages missing required fields", () => {
    expect(
      isServedFromCacheMessage({ type: "served-from-cache", url: "x" }),
    ).toBe(false);
  });
});
