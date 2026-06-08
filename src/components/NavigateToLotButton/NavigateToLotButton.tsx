"use client";

/**
 * NavigateToLotButton — Story 8.3.
 *
 * Reusable "Open in Maps" action for the field worker. Tapping the
 * button on a phone hands the lot's GPS centroid off to whatever
 * native map / nav app the user has installed (Google Maps, Apple
 * Maps, Waze, Maps.me, …). The app deliberately does NOT ship its own
 * turn-by-turn navigation (FR12).
 *
 * Behaviour:
 *   - `geometryStatus === "placeholder"` or no centroid → button is
 *     disabled and wrapped in a tooltip explaining why. The label
 *     stays "Open in Maps" so the affordance is obvious; the disabled
 *     state communicates "data missing", not "wrong page".
 *   - Otherwise → click computes the deep link via `navigateToLot`
 *     (pure helper, fully unit-tested). For `geo:` / `maps:` schemes
 *     we use `window.location.href` because new-tab opens don't
 *     handle non-HTTP protocols correctly. For the cross-platform
 *     `https://` fallback (desktop / unclassified UA) we use
 *     `window.open(url, "_blank", "noopener,noreferrer")` so the
 *     current page (which Junior may want to come back to) is
 *     preserved.
 *
 * Mobile-first UI:
 *   - 44×44 px minimum touch target (NFR-A4).
 *   - Primary-action styling (slate-900 background) so it visually
 *     dominates the lot facts panel when active. When disabled the
 *     button uses muted slate to communicate the unavailable state
 *     without yelling.
 *   - Leading `MapPin` icon (Lucide — already a Phase 1 dependency).
 *
 * Server-side coordinate gating (story AC4) is intentionally left to
 * a follow-up: this story's file-ownership scope does not include
 * `convex/lots.ts`. Today the client gates on `geometryStatus`; the
 * server-side redaction will land alongside Story 9.2 / a follow-up
 * convex-owned story.
 */

import { useCallback, useRef, useState } from "react";
import { MapPin } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { navigateToLot } from "@/lib/navigateToLot";

export interface NavigateToLotButtonProps {
  /** Lot's human-readable code, used inside the map-app label. */
  lotCode: string;
  /** Whether the lot has real surveyed GPS coordinates. */
  geometryStatus: "placeholder" | "surveyed";
  /** GPS centroid, undefined for un-surveyed lots. */
  centroid?: { lat: number; lng: number };
  /** Optional className override (merged via tailwind-merge). */
  className?: string;
  /**
   * Optional click-handler injection for tests — defaults to the real
   * `window` open/navigate behaviour. Tests can pass a spy to assert
   * the URL without jsdom intercepting native navigation.
   */
  onNavigate?: (url: string) => void;
}

/**
 * Default click handler. Picks the right window API based on the URL
 * scheme:
 *   - `http://` / `https://` → open in a new tab (preserves the
 *     current page).
 *   - everything else (`geo:`, `maps:`) → assign to
 *     `window.location.href` since those schemes hand off to a native
 *     handler that takes over the foreground.
 */
function defaultNavigate(url: string): void {
  if (typeof window === "undefined") return;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  // The geo: / maps: hand-off — let the OS pick the registered handler.
  window.location.href = url;
}

export function NavigateToLotButton({
  lotCode,
  geometryStatus,
  centroid,
  className,
  onNavigate,
}: NavigateToLotButtonProps) {
  const [busy, setBusy] = useState(false);
  // Re-entrancy guard: rapid taps (the outdoor double-tap of a frustrated
  // field worker) should not fire the handler twice. Ref + busy state
  // together keep this robust against React-18 strict-mode double-fire.
  const inFlight = useRef(false);

  const disabled = geometryStatus !== "surveyed" || centroid === undefined;
  const disabledReason =
    geometryStatus !== "surveyed"
      ? "GPS coordinates not yet surveyed for this lot."
      : "GPS coordinates unavailable for this lot.";

  const handleClick = useCallback(() => {
    if (disabled || inFlight.current || centroid === undefined) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const { url } = navigateToLot({
        lat: centroid.lat,
        lng: centroid.lng,
        lotCode,
      });
      // Story 8.3 brief: client-side analytics deferred to Story 5.x;
      // for now leave a single, structured debug record so field tests
      // can confirm the handler fired. Lat/lng intentionally redacted
      // from the log per the story's "do not log coordinates" rule.
      if (typeof console !== "undefined") {
        console.debug("[NavigateToLotButton] handoff", { lotCode });
      }
      (onNavigate ?? defaultNavigate)(url);
    } finally {
      // Release the in-flight guard on the next tick — the native
      // handler has already taken over by then, and a 50ms re-entry
      // window matches the "rapid double tap" use case.
      window.setTimeout(() => {
        inFlight.current = false;
        setBusy(false);
      }, 50);
    }
  }, [centroid, disabled, lotCode, onNavigate]);

  const buttonClass = cn(
    "inline-flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-md px-4 py-2 text-sm font-medium",
    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    disabled
      ? "cursor-not-allowed border border-slate-200 bg-slate-100 text-slate-400"
      : "border border-[#1D5C4D] bg-[#1D5C4D] text-white hover:bg-[#144437] focus-visible:ring-slate-900",
    className,
  );

  const buttonLabel = "Open in Maps";

  const button = (
    <button
      type="button"
      data-testid="navigate-to-lot-button"
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      aria-label={
        disabled
          ? `Open in Maps for lot ${lotCode}, disabled — ${disabledReason}`
          : `Open in Maps for lot ${lotCode}`
      }
      disabled={disabled || busy}
      onClick={handleClick}
      className={buttonClass}
    >
      <MapPin aria-hidden="true" className="h-4 w-4" />
      <span>{buttonLabel}</span>
    </button>
  );

  if (!disabled) {
    return button;
  }

  // Disabled state: Radix Tooltip's TooltipTrigger requires a focusable
  // child; a `disabled` button is not focusable, so we wrap it in a
  // span with tabIndex={0} that picks up keyboard focus. The visible
  // disabled styling stays on the button itself.
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            data-testid="navigate-to-lot-disabled-trigger"
            className="inline-block"
          >
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
