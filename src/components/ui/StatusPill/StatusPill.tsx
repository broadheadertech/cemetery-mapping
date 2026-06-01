import { cn } from "@/lib/cn";
import {
  ICON_COLOR,
  ICON_MAP,
  LABEL_MAP,
  VARIANT_CLASSES,
  type PillStatus,
} from "./icons";

/**
 * Size token applied to padding, height, text, and the icon SVG.
 *
 * Each size keeps the touch target ≥ 44px when wrapped by an
 * interactive parent — the pill itself is a non-interactive label,
 * but consumers (filter chips, table-row click targets) must layer
 * `min-h-[44px]` on the wrapper, not on the pill.
 */
export type StatusPillSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<StatusPillSize, string> = {
  sm: "h-4 text-[10px] leading-none px-2 py-0.5 gap-1",
  md: "h-6 text-xs leading-none px-2.5 py-1 gap-1.5",
  lg: "h-8 text-sm leading-none px-3 py-1.5 gap-2",
};

const ICON_SIZE_PX: Record<StatusPillSize, number> = {
  sm: 10,
  md: 12,
  lg: 14,
};

export interface StatusPillProps {
  status: PillStatus;
  /** Visual size — defaults to `md`, the dashboard / table baseline. */
  size?: StatusPillSize;
  /** Hide the leading icon. Defaults to `true`; only override for
   *  dense tabular contexts where the row already carries the colour. */
  showIcon?: boolean;
  /** Caller override class. Wins over the component's defaults via
   *  `tailwind-merge` so conflicting utilities resolve correctly. */
  className?: string;
}

/**
 * StatusPill — the cornerstone status indicator.
 *
 * Pairs three signals (background tint, dark text, coloured icon) so
 * the meaning survives:
 *   - missing colour vision (icon + label)
 *   - greyscale printing (icon shape + label)
 *   - high-contrast outdoor mode (border thickness changes via CSS var)
 *
 * The 300ms colour crossfade fires whenever the `status` prop changes;
 * `prefers-reduced-motion: reduce` globally collapses the transition
 * duration via the rule in globals.css (no per-component branching).
 */
export function StatusPill({
  status,
  size = "md",
  showIcon = true,
  className,
}: StatusPillProps) {
  const Icon = ICON_MAP[status];
  const label = LABEL_MAP[status];

  return (
    <span
      role="status"
      aria-label={label}
      data-status={status}
      data-size={size}
      className={cn(
        // Layout
        "inline-flex items-center justify-center rounded-full font-medium whitespace-nowrap",
        // Outdoor mode: pulls border thickness from `--pill-border-width`,
        // which is 0 indoors and 2px outdoors. Style is `solid` always —
        // collapses to invisible when width is 0.
        "border-solid border-[length:var(--pill-border-width)]",
        // 300ms crossfade on status changes only — never `transition-all`.
        "transition-[background-color,color,border-color] duration-300 ease-out",
        SIZE_CLASSES[size],
        VARIANT_CLASSES[status],
        className,
      )}
    >
      {showIcon && (
        <Icon
          aria-hidden="true"
          focusable="false"
          width={ICON_SIZE_PX[size]}
          height={ICON_SIZE_PX[size]}
          className={cn("shrink-0", ICON_COLOR[status])}
        />
      )}
      <span>{label}</span>
    </span>
  );
}
