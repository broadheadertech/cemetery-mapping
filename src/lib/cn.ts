import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Compose Tailwind classNames with conflict resolution.
 *
 * - `clsx` handles falsy / conditional / array / object inputs cleanly.
 * - `tailwind-merge` deduplicates conflicting utilities so later
 *   overrides win (e.g. `cn("p-2", "p-4") === "p-4"`).
 *
 * Used by every component that accepts a `className` prop so caller
 * overrides reliably win over the component's own defaults.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
