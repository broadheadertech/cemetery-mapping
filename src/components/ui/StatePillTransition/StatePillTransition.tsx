"use client";

import {
  ReactiveHighlight,
  type ReactiveHighlightProps,
} from "@/components/ui/ReactiveHighlight";
import { StatusPill, type StatusPillProps } from "@/components/ui/StatusPill";

/**
 * StatePillTransition — auxiliary wrapper that combines
 * `<StatusPill>` with `<ReactiveHighlight>` so a status change fires
 * BOTH motion signals at once:
 *
 *   1. The pill's baked-in 300ms colour crossfade (from `StatusPill`'s
 *      `transition-[background-color,color,border-color]` utilities).
 *   2. The 600ms amber surround flash from `ReactiveHighlight`, re-keyed
 *      on the `status` value.
 *
 * Per UX § Component Strategy item 9, most consumers DO NOT need this —
 * `<StatusPill>` alone already animates colour. Reach for the wrapper
 * when the surrounding section should also draw the eye (e.g. a lot
 * detail header, a list-row status that may change via cross-tab
 * reactive updates, a Cmd-K search result whose state ticks live).
 *
 * Composition rules (UX § "Compose, don't customize"):
 *   - All `<StatusPill>` props pass through verbatim — no per-call
 *     `durationMs` override on the pill itself (300ms is canonical).
 *   - `flashDurationMs` controls ONLY the outer `ReactiveHighlight`
 *     flash; defaults to its 600ms standard.
 *   - `prefers-reduced-motion: reduce` is inherited from both children
 *     via `globals.css` — no per-component branching here.
 */
export interface StatePillTransitionProps extends StatusPillProps {
  /**
   * Outer `ReactiveHighlight` flash duration in ms. Defaults to the
   * `ReactiveHighlight` default (600ms). Override sparingly — the
   * motion language is calibrated; per-page tweaks fragment it.
   */
  flashDurationMs?: ReactiveHighlightProps["durationMs"];
  /** Optional class applied to the outer `ReactiveHighlight` wrapper. */
  wrapperClassName?: string;
}

/**
 * Wraps `<ReactiveHighlight watch={status}>` around
 * `<StatusPill status={status} ... />`. The wrapper is intentionally
 * thin: it forwards every `StatusPill` prop through, owns the `watch`
 * wiring so consumers never have to remember it, and exposes only one
 * extra prop (`flashDurationMs`) for the rare case the surrounding
 * flash needs tuning.
 */
export function StatePillTransition({
  flashDurationMs,
  wrapperClassName,
  ...statusPillProps
}: StatePillTransitionProps) {
  return (
    <ReactiveHighlight
      watch={statusPillProps.status}
      durationMs={flashDurationMs}
      className={wrapperClassName}
    >
      <StatusPill {...statusPillProps} />
    </ReactiveHighlight>
  );
}
