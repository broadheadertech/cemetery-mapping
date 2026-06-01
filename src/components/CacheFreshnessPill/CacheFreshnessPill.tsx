"use client";

import { useOfflineCache } from "@/hooks/useOfflineCache";
import { formatCacheAge } from "@/lib/offline-cache";
import { cn } from "@/lib/cn";

/**
 * CacheFreshnessPill — UX-DR22 banner-style indicator.
 *
 * Lives at the top of each cached staff page (rendered once in the
 * (staff) layout via the `ServiceWorkerBootstrap` client wrapper). When
 * the current page is served from the SW cache, this pill renders a
 * one-line status bar.
 *
 * Variants:
 *   - "online"        → renders nothing.
 *   - "cached-fresh"  → amber bar with "Cached Xm ago".
 *   - "cached-stale"  → red bar with "Cached, may be outdated".
 *
 * The component is intentionally self-contained: it reads its state
 * from `useOfflineCache()` and emits no callbacks. UX wants the pill
 * to be a passive indicator; user dismissal would let a stale-cache
 * warning fall off the screen for the rest of the session.
 */
export function CacheFreshnessPill(): React.ReactElement | null {
  const cache = useOfflineCache();

  if (cache.status === "online") return null;

  const isStale = cache.status === "cached-stale";
  const ageLabel =
    !isStale && typeof cache.ageMs === "number"
      ? formatCacheAge(cache.ageMs)
      : null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="cache-freshness-pill"
      data-cache-state={cache.status}
      className={cn(
        "sticky top-0 z-20 w-full px-4 py-2 text-center text-xs font-medium",
        isStale
          ? "bg-red-50 text-red-800 border-b border-red-200"
          : "bg-amber-50 text-amber-900 border-b border-amber-200",
      )}
    >
      {isStale ? "Cached, may be outdated" : `Cached ${ageLabel ?? "recently"}`}
    </div>
  );
}
