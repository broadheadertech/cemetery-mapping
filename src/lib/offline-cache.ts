/**
 * Client-side helpers for reasoning about cache freshness (Story 1.13).
 *
 * The actual cache writes happen inside the service worker (`src/sw.ts`)
 * via the Cache API. The client never writes directly. What we DO need
 * is to consume the SW's `served-from-cache` messages and translate
 * raw timestamps into UI-facing freshness tiers.
 *
 * Why this lives in `lib/` and not inside the hook:
 *   - The thresholds (24h staleness) are policy, not React state. Tests
 *     can exercise them without rendering anything.
 *   - Future stories may need the same translator from non-React
 *     surfaces (e.g. a debug menu page).
 */

/**
 * 24h staleness threshold per NFR-R6. Above this age, the freshness
 * pill escalates from "Cached Xm ago" (amber) to "Cached, may be
 * outdated" (red).
 */
export const STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type CacheFreshness = "online" | "cached-fresh" | "cached-stale";

export interface CacheStatusSnapshot {
  status: CacheFreshness;
  cachedAt?: number;
  ageMs?: number;
}

/**
 * Convert a `cachedAt` epoch into a freshness tier. `now` defaults to
 * `Date.now()` but is injectable for deterministic tests.
 */
export function classifyCacheAge(
  cachedAt: number | null | undefined,
  now: number = Date.now(),
): CacheStatusSnapshot {
  if (cachedAt === null || cachedAt === undefined || Number.isNaN(cachedAt)) {
    return { status: "online" };
  }
  const ageMs = Math.max(0, now - cachedAt);
  return {
    status: ageMs >= STALENESS_THRESHOLD_MS ? "cached-stale" : "cached-fresh",
    cachedAt,
    ageMs,
  };
}

/**
 * Format a millisecond age as "Xm ago" / "Xh ago" / "Xd ago" for the
 * freshness pill. We deliberately keep the resolution coarse — sub-
 * minute precision would jitter every render.
 */
export function formatCacheAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Shape of the `postMessage` payload the service worker sends when it
 * serves a request from cache. Defined here so both the SW source
 * (`src/sw.ts`) and the consuming hook stay in sync.
 */
export interface ServedFromCacheMessage {
  type: "served-from-cache";
  url: string;
  cachedAt: number;
  stale: boolean;
}

export function isServedFromCacheMessage(
  value: unknown,
): value is ServedFromCacheMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<ServedFromCacheMessage>;
  return (
    v.type === "served-from-cache" &&
    typeof v.url === "string" &&
    typeof v.cachedAt === "number" &&
    typeof v.stale === "boolean"
  );
}
