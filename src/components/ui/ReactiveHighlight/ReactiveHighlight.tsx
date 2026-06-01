"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface ReactiveHighlightProps {
  /**
   * The value to watch. Whenever its identity changes (`Object.is`
   * comparison) the wrapper triggers a single amber-50 flash that
   * fades to transparent over `durationMs`. First render NEVER flashes.
   */
  watch: string | number | boolean | null | undefined;
  /** Children rendered inside the highlighted region. */
  children: ReactNode;
  /** Flash duration in milliseconds. Defaults to 600. */
  durationMs?: number;
  /** Optional className for the wrapper span. */
  className?: string;
}

/**
 * ReactiveHighlight — wraps a value and flashes amber on change.
 *
 * Pattern: re-key the inner span every time `watch` changes so the
 * CSS animation restarts cleanly. Toggling a className on the SAME
 * element does not retrigger an in-flight animation; re-keying does.
 *
 * The wrapper itself has `aria-live="polite"` so screen readers
 * announce the new value once when it changes, then quiet down
 * (NFR-A6). We use a `<span>` rather than `<output>` because some
 * screen readers attach form-output semantics to the latter.
 *
 * `prefers-reduced-motion: reduce` collapses the animation duration
 * globally via the rule in `globals.css` — no per-component check.
 */
export function ReactiveHighlight({
  watch,
  children,
  durationMs = 600,
  className,
}: ReactiveHighlightProps) {
  const prevWatch = useRef<typeof watch>(watch);
  const isFirstRender = useRef(true);
  const [flashKey, setFlashKey] = useState(0);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevWatch.current = watch;
      return;
    }
    if (!Object.is(prevWatch.current, watch)) {
      prevWatch.current = watch;
      // Incrementing the key on the inner span forces a remount,
      // which restarts the CSS animation from frame 0.
      setFlashKey((k) => k + 1);
    }
  }, [watch]);

  return (
    <span
      aria-live="polite"
      data-testid="reactive-highlight"
      className={cn("inline-block", className)}
    >
      <span
        key={flashKey}
        data-flash-key={flashKey}
        // `flashKey === 0` is the SSR / first-render state — no animation.
        // Subsequent values re-mount the element AND apply the keyframe.
        className={flashKey === 0 ? undefined : "animate-flash-fade rounded"}
        style={
          flashKey === 0
            ? undefined
            : ({
                ["--flash-duration" as string]: `${durationMs}ms`,
              } as React.CSSProperties)
        }
      >
        {children}
      </span>
    </span>
  );
}
