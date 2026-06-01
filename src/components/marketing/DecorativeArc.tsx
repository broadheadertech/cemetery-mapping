import { cn } from "@/lib/cn";

/**
 * Ornamental concentric-circles motif sourced from the brand guide
 * (the "compass" treatment that frames the dove). Used behind hero
 * sections at very low opacity.
 */
export function DecorativeArc({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 800 800"
      fill="none"
      aria-hidden
      className={cn("pointer-events-none", className)}
    >
      <circle
        cx="400"
        cy="400"
        r="380"
        stroke="#1D5C4D"
        strokeOpacity="0.4"
        strokeWidth="1"
      />
      <circle
        cx="400"
        cy="400"
        r="320"
        stroke="#1D5C4D"
        strokeOpacity="0.35"
        strokeWidth="1"
        strokeDasharray="2 6"
      />
      <circle
        cx="400"
        cy="400"
        r="260"
        stroke="#C9A96B"
        strokeOpacity="0.5"
        strokeWidth="1"
      />
      <line
        x1="400"
        y1="20"
        x2="400"
        y2="780"
        stroke="#1D5C4D"
        strokeOpacity="0.3"
        strokeWidth="0.5"
      />
      <line
        x1="20"
        y1="400"
        x2="780"
        y2="400"
        stroke="#1D5C4D"
        strokeOpacity="0.3"
        strokeWidth="0.5"
      />
    </svg>
  );
}
