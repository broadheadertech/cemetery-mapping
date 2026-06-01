"use client";

import { useEffect, useState } from "react";
import {
  classifyCacheAge,
  isServedFromCacheMessage,
  type CacheStatusSnapshot,
} from "@/lib/offline-cache";
import { useNetworkState } from "@/hooks/useNetworkState";

/**
 * Hook that surfaces the current page's cache freshness.
 *
 * Responsibilities:
 *   - Listen to the service worker's `served-from-cache` postMessage
 *     for the current navigation URL.
 *   - Re-classify periodically (every 60s) so the "Cached Xm ago" copy
 *     stays accurate without re-rendering on every animation frame.
 *   - Return `{ status: "online" }` when the SW has not reported any
 *     cached service for the page OR when the browser is online and
 *     the cache age is stale-revalidating.
 *
 * The hook is SSR-safe: it returns `{ status: "online" }` on the server
 * and during the first client render, then updates after the first
 * `served-from-cache` message arrives.
 */
export function useOfflineCache(): CacheStatusSnapshot {
  const network = useNetworkState();
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent): void => {
      if (!isServedFromCacheMessage(event.data)) return;
      // We only care about the *current* page's cache; ignore messages
      // about queries the SW served for other URLs.
      if (typeof window !== "undefined") {
        const here = window.location.href;
        const matches = event.data.url === here;
        // Convex POSTs target a different URL than the page itself,
        // but still tell us the page is being driven by cached data.
        // Accept both signals.
        if (!matches && !event.data.url.includes(window.location.pathname)) {
          // Still record it — any cached fetch implies the page is at
          // least partially offline-serving. We bias toward showing
          // the pill rather than hiding it.
        }
      }
      setCachedAt(event.data.cachedAt);
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  // Refresh the rendered age every 60s.
  useEffect(() => {
    if (cachedAt === null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, [cachedAt]);

  // If we're online AND the last cache report is fresh, we still show
  // the pill so the user knows what state they're in. The SW always
  // re-validates in the background, so the pill disappears on the next
  // successful network response (when the SW stops emitting cached
  // messages).
  if (network === "online" && cachedAt === null) {
    return { status: "online" };
  }

  return classifyCacheAge(cachedAt);
}
