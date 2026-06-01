"use client";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import { cn } from "@/lib/cn";

/**
 * Tone of the optional delta row. Maps to the semantic colour tokens
 * established in Story 1.4 — keep this list closed so a future
 * "warning" / "info" delta is a deliberate design extension and not
 * a one-off literal sprinkled into a consumer.
 */
export type KpiCardDeltaTone = "positive" | "negative" | "neutral";

export interface KpiCardDelta {
  /** Pre-formatted delta string, e.g. "+₱16,000 today" or "-3 this week". */
  text: string;
  /** Tone determines the colour token applied to the delta row. */
  tone: KpiCardDeltaTone;
}

export interface KpiCardProps {
  /** Short, glanceable label. ≤ 30 chars; truncates defensively if longer. */
  label: string;
  /**
   * Pre-formatted display value. The caller owns formatting
   * (`formatPeso` from `src/lib/money.ts`, count formatters, etc.).
   * `KpiCard` deliberately does no string manipulation on the value —
   * keeps the component reusable for money, counts, percentages, dates.
   */
  value: string;
  /**
   * Optional delta row. When provided, renders below the value in a
   * tone-coloured `tabular-nums` line.
   */
  delta?: KpiCardDelta;
  /**
   * When provided, renders the card as a `<button type="button">`
   * with a 44px touch target, focus ring, and an `aria-label`
   * composed from label + value + delta. When omitted, renders a
   * non-interactive `<div>` with no `role` / `tabIndex` / hover affordance.
   */
  onClick?: () => void;
}

/**
 * Maps each delta tone to the semantic colour token established in
 * Story 1.4. Kept as a flat record so the type checker forces every
 * tone to have a mapping; adding a tone without a class will fail
 * compile.
 */
const DELTA_TONE_CLASS: Record<KpiCardDeltaTone, string> = {
  positive: "text-emerald-700",
  negative: "text-red-700",
  neutral: "text-slate-600",
};

/**
 * KpiCard — dashboard tile with the 600ms amber reactive-flash on
 * value change (UX-DR9, "magic moment" — Journey 4).
 *
 * Pure presentation: no Convex queries, no formatting, no loading /
 * error states (caller renders a skeleton or inline error in place
 * of `KpiCard` when data is absent — see Story 5.2).
 *
 * Composes `ReactiveHighlight` from Story 1.4 with `watch={value}`,
 * so any prop change to `value` triggers the calm-reactivity fade
 * exactly once. First render never flashes. `prefers-reduced-motion`
 * suppression is delegated to the wrapper via globals.css.
 *
 * Consumers: `/dashboard` tiles (Story 5.2), AR aging header tiles,
 * drill-down summary headers, report-page headers.
 *
 * @example
 *   // Clickable tile that navigates to the AR aging page.
 *   <KpiCard
 *     label="AR balance"
 *     value="₱1,825,000"
 *     delta={{ text: "+₱30,000 vs. last week", tone: "negative" }}
 *     onClick={() => router.push("/ar-aging")}
 *   />
 *
 * @example
 *   // Non-interactive tile (no drill-down target).
 *   <KpiCard label="Active contracts" value="412" />
 */
export function KpiCard({ label, value, delta, onClick }: KpiCardProps) {
  const ariaLabel = delta
    ? `${label}: ${value}, ${delta.text}`
    : `${label}: ${value}`;

  const inner = (
    <div className="flex flex-col gap-0.5">
      <span className="truncate text-xs leading-tight text-slate-500">
        {label}
      </span>
      <ReactiveHighlight watch={value} className="mt-1">
        <span className="text-2xl font-bold leading-tight tabular-nums md:text-3xl">
          {value}
        </span>
      </ReactiveHighlight>
      {delta && (
        <span
          className={cn(
            "text-xs leading-tight tabular-nums",
            DELTA_TONE_CLASS[delta.tone],
          )}
          data-tone={delta.tone}
        >
          {delta.text}
        </span>
      )}
    </div>
  );

  // Shared visual styling. Touch target floor (NFR-A4) is enforced on
  // the button variant only — the static `<div>` carries no tap-target
  // expectation per the story disaster-prevention notes.
  const baseClasses =
    "block w-full rounded-lg border border-surface-border bg-surface-base p-4 text-left shadow-[var(--shadow-card)]";

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={cn(
          baseClasses,
          "min-h-[44px]",
          "transition-colors hover:bg-surface-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
        )}
      >
        {inner}
      </button>
    );
  }

  return <div className={baseClasses}>{inner}</div>;
}
