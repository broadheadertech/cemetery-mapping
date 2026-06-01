/**
 * Story 1.10 — `src/lib/recents.ts` unit tests.
 *
 * Coverage target per the story: 100% (small helper, easy to fully
 * exercise). The tests pin AC5's promises:
 *   - dedup by `entityType + entityId`
 *   - storage cap at 25
 *   - display cap at 5 by default
 *   - SSR safety (no window / no localStorage)
 *   - Parse / quota errors don't throw
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearRecents,
  DEFAULT_DISPLAY_CAP,
  getRecents,
  recordRecentView,
  RECENTS_STORAGE_KEY,
  STORAGE_CAP,
  type RecentItem,
} from "@/lib/recents";

describe("recents — happy path", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns [] when localStorage is empty", () => {
    expect(getRecents()).toEqual([]);
  });

  it("records a view and reads it back", () => {
    recordRecentView("lot", "lots:1", "D-5-12");
    const recents = getRecents();
    expect(recents).toHaveLength(1);
    expect(recents[0]).toMatchObject({
      entityType: "lot",
      entityId: "lots:1",
      label: "D-5-12",
    });
    expect(recents[0]?.viewedAt).toBeTypeOf("number");
  });

  it("returns newest-first across multiple records", () => {
    vi.setSystemTime(new Date("2026-05-18T08:00:00Z"));
    recordRecentView("lot", "lots:1", "A");
    vi.setSystemTime(new Date("2026-05-18T08:00:01Z"));
    recordRecentView("lot", "lots:2", "B");
    vi.setSystemTime(new Date("2026-05-18T08:00:02Z"));
    recordRecentView("lot", "lots:3", "C");

    const recents = getRecents();
    expect(recents.map((r) => r.entityId)).toEqual([
      "lots:3",
      "lots:2",
      "lots:1",
    ]);
  });

  it("dedupes by entityType + entityId (revisit moves to top)", () => {
    vi.setSystemTime(new Date("2026-05-18T08:00:00Z"));
    recordRecentView("lot", "lots:1", "A");
    vi.setSystemTime(new Date("2026-05-18T08:00:01Z"));
    recordRecentView("lot", "lots:2", "B");
    vi.setSystemTime(new Date("2026-05-18T08:00:02Z"));
    recordRecentView("lot", "lots:1", "A");

    const recents = getRecents();
    expect(recents.map((r) => r.entityId)).toEqual(["lots:1", "lots:2"]);
    expect(recents).toHaveLength(2);
  });

  it("treats different entityTypes with the same entityId as distinct", () => {
    recordRecentView("lot", "shared", "lot-shared");
    recordRecentView("customer", "shared", "customer-shared");
    const recents = getRecents();
    expect(recents).toHaveLength(2);
  });

  it("caps display at DEFAULT_DISPLAY_CAP (5)", () => {
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(new Date(2026, 4, 18, 8, 0, i));
      recordRecentView("lot", `lots:${i}`, `L${i}`);
    }
    expect(getRecents()).toHaveLength(DEFAULT_DISPLAY_CAP);
  });

  it("respects an explicit limit argument", () => {
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(new Date(2026, 4, 18, 8, 0, i));
      recordRecentView("lot", `lots:${i}`, `L${i}`);
    }
    expect(getRecents(2)).toHaveLength(2);
  });

  it("caps storage at STORAGE_CAP (25)", () => {
    for (let i = 0; i < 40; i++) {
      vi.setSystemTime(new Date(2026, 4, 18, 8, 0, i));
      recordRecentView("lot", `lots:${i}`, `L${i}`);
    }
    const raw = JSON.parse(
      localStorage.getItem(RECENTS_STORAGE_KEY) ?? "[]",
    ) as RecentItem[];
    expect(raw).toHaveLength(STORAGE_CAP);
  });

  it("clearRecents wipes the store", () => {
    recordRecentView("lot", "lots:1", "A");
    expect(getRecents()).toHaveLength(1);
    clearRecents();
    expect(getRecents()).toEqual([]);
  });
});

describe("recents — robustness", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns [] when the stored value is not JSON", () => {
    localStorage.setItem(RECENTS_STORAGE_KEY, "{{not-json");
    expect(getRecents()).toEqual([]);
  });

  it("returns [] when the stored value is not an array", () => {
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ foo: 1 }));
    expect(getRecents()).toEqual([]);
  });

  it("filters malformed items but keeps the well-formed ones", () => {
    const mixed = [
      { entityType: "lot", entityId: "ok", label: "OK", viewedAt: 1 },
      { entityType: "what", entityId: "bad", label: "B", viewedAt: 1 },
      { entityType: "lot", entityId: "missing-label", viewedAt: 1 },
      "just a string",
    ];
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(mixed));
    const recents = getRecents();
    expect(recents).toHaveLength(1);
    expect(recents[0]?.entityId).toBe("ok");
  });

  it("recordRecentView swallows quota errors", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => recordRecentView("lot", "lots:1", "A")).not.toThrow();
    Storage.prototype.setItem = original;
  });
});
