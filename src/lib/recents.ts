/**
 * Recently-viewed entities — client-side ring buffer in localStorage.
 *
 * Powers the Cmd-K palette's "RECENT" group when the query is empty
 * (Story 1.10 AC5). Cross-device sync is OUT OF SCOPE — Phase 1 keeps
 * recents per-browser; a future `userRecents` Convex table would
 * promote this to a server-side history if user feedback demands.
 *
 * Storage shape:
 *   - key   `cm:recents:v1` (version suffix so we can ship a v2 shape
 *           without colliding with old rows).
 *   - value JSON-encoded `RecentItem[]`, newest-first, capped at
 *           `STORAGE_CAP` to keep the array bounded.
 *
 * Safety:
 *   - SSR guard: every helper checks `typeof window !== "undefined"`
 *     before touching `localStorage`. Reading storage at the top of a
 *     module would crash Next.js server rendering.
 *   - Quota guard: `recordRecentView` wraps `setItem` in try/catch so
 *     a private-browsing quota error doesn't tank the palette.
 *   - Parse guard: bad JSON or shape mismatch falls back to `[]` and
 *     overwrites the slot on next write — never throws into a render.
 */

export type RecentEntityType = "lot" | "customer" | "contract" | "receipt";

export interface RecentItem {
  entityType: RecentEntityType;
  entityId: string;
  label: string;
  viewedAt: number;
}

/** Storage key. Bump suffix on shape changes. */
export const RECENTS_STORAGE_KEY = "cm:recents:v1";

/**
 * Storage cap. Larger than the display cap so a user with a long
 * history can still see their previous-but-not-most-recent items
 * after refining a search. 25 is a soft estimate of the user's
 * useful "what did I just look at" range.
 */
export const STORAGE_CAP = 25;

/** Default display cap shown in the palette. AC5 specifies 5. */
export const DEFAULT_DISPLAY_CAP = 5;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function isRecentEntityType(value: unknown): value is RecentEntityType {
  return (
    value === "lot" ||
    value === "customer" ||
    value === "contract" ||
    value === "receipt"
  );
}

function isRecentItem(value: unknown): value is RecentItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isRecentEntityType(v.entityType) &&
    typeof v.entityId === "string" &&
    typeof v.label === "string" &&
    typeof v.viewedAt === "number"
  );
}

/**
 * Reads the recents list from localStorage. Returns `[]` on SSR,
 * private-mode quota errors, or malformed JSON. Always returns
 * newest-first.
 */
export function getRecents(limit: number = DEFAULT_DISPLAY_CAP): RecentItem[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items = parsed.filter(isRecentItem);
    // Sort newest-first defensively; the writer should already do
    // this, but a corrupted file shouldn't render out-of-order.
    items.sort((a, b) => b.viewedAt - a.viewedAt);
    return items.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Records a recent view. Deduplicates by `entityType + entityId`
 * (revisiting an item moves it to the top, doesn't duplicate). Caps
 * at `STORAGE_CAP`. No-op on SSR / quota errors.
 *
 * Callers: the palette's `onSelect` (for "I clicked through from
 * search") AND every detail page on mount (for "I navigated via URL
 * or sidebar"). Both call sites are required — the palette alone
 * misses URL / back-button navigations.
 */
export function recordRecentView(
  entityType: RecentEntityType,
  entityId: string,
  label: string,
): void {
  if (!isBrowser()) return;
  try {
    const existing = readAll();
    const next: RecentItem[] = [
      { entityType, entityId, label, viewedAt: Date.now() },
      ...existing.filter(
        (i) => !(i.entityType === entityType && i.entityId === entityId),
      ),
    ].slice(0, STORAGE_CAP);
    localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode quota / disabled storage — silently skip.
  }
}

/** Internal: reads the full (uncapped-for-display) list. */
function readAll(): RecentItem[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(RECENTS_STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentItem);
  } catch {
    return [];
  }
}

/**
 * Clears all recents. Exposed primarily for tests; a future "Clear
 * history" UI affordance can reuse this.
 */
export function clearRecents(): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(RECENTS_STORAGE_KEY);
  } catch {
    // Same swallow rationale as `recordRecentView`.
  }
}
