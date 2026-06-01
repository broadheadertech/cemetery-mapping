"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNetworkState } from "@/hooks/useNetworkState";
import { useOfflineCache } from "@/hooks/useOfflineCache";
import { formatCacheAge } from "@/lib/offline-cache";
import { cn } from "@/lib/cn";

/**
 * NetworkIndicator — the live "Cached / Live" pill that slots into the
 * `MobileTopBar`'s `[data-network-state]` placeholder (UX-DR22).
 *
 * Why a portal:
 *   - `MobileTopBar` already renders a stable DOM slot with the
 *     `data-network-state` attribute. The story's ownership rules
 *     forbid editing that component directly. A portal lets us replace
 *     the placeholder content without touching the source.
 *   - The fallback (when the slot isn't on screen, e.g. on desktop)
 *     simply renders nothing — the desktop sidebar carries no offline
 *     indicator in Phase 1 per UX, and Story 1.5's chrome already
 *     surfaces enough state context for the desktop "Mr. Reyes" path.
 *
 * The pill's three visual states correspond to `useOfflineCache()`:
 *   - "online"          → not rendered (DOM placeholder shows nothing).
 *   - "cached-fresh"    → amber pill, "Cached Xm ago".
 *   - "cached-stale"    → red pill, "Cached, may be outdated".
 *
 * When the browser reports offline AND we have no cache age, we still
 * surface a slate-gray "Offline" pill so the user isn't told everything
 * is fine when in fact write attempts will be blocked.
 */
export function NetworkIndicator(): React.ReactElement | null {
  const network = useNetworkState();
  const cache = useOfflineCache();
  const slot = useNetworkStateSlot();

  // Choose the rendered variant.
  let content: React.ReactNode = null;

  if (cache.status === "cached-stale") {
    content = (
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800",
        )}
      >
        Cached, may be outdated
      </span>
    );
  } else if (cache.status === "cached-fresh") {
    const ageLabel =
      typeof cache.ageMs === "number" ? formatCacheAge(cache.ageMs) : "recently";
    content = (
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "inline-flex items-center rounded-full bg-status-reserved-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-status-reserved-text",
        )}
      >
        Cached {ageLabel}
      </span>
    );
  } else if (network === "offline") {
    content = (
      <span
        role="status"
        aria-live="polite"
        data-testid="network-offline-pill"
        className={cn(
          "inline-flex items-center rounded-full bg-surface-emphasis px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted",
        )}
      >
        Offline
      </span>
    );
  }

  if (content === null) return null;
  if (slot === null) {
    // No mobile-top-bar slot on this page (e.g. desktop layout). Render
    // a sticky pill at the top-right of the viewport so the user still
    // sees the offline state.
    return (
      <div
        aria-hidden={false}
        className="pointer-events-none fixed right-3 top-3 z-40 md:hidden"
      >
        {content}
      </div>
    );
  }
  return createPortal(content, slot);
}

/**
 * Finds the MobileTopBar's `data-network-state` placeholder. Returns
 * `null` until the element is mounted (first paint) or on desktop where
 * MobileTopBar is hidden. Re-checks via a mutation observer so route
 * transitions that remount the top bar don't strand the pill.
 */
function useNetworkStateSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    function findSlot(): HTMLElement | null {
      return document.querySelector<HTMLElement>("[data-network-state]");
    }

    setSlot(findSlot());

    const observer = new MutationObserver(() => {
      const next = findSlot();
      setSlot((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  return slot;
}
