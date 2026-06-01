"use client";

import * as React from "react";

/**
 * Renders children visible to assistive technology but hidden from
 * sighted users. Used to attach an `aria-labelledby` target (DialogTitle)
 * without intruding on the palette's visual design — a Radix Dialog
 * requires a Title for accessibility, but our palette uses the input
 * placeholder as the visible label.
 *
 * The class string follows the standard `sr-only` recipe rather than
 * pulling in Radix's `VisuallyHidden` so the component stays free of
 * extra wrappers.
 */
export function VisuallyHidden({ children }: { children: React.ReactNode }) {
  return (
    <span className="absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 [clip:rect(0,0,0,0)] [clip-path:inset(50%)]">
      {children}
    </span>
  );
}
