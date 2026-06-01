"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Faq } from "./data";

/**
 * Single-open FAQ accordion. Keyboard-friendly (real <button>), and
 * collapses every other panel when one opens — matches the prototype's
 * "one at a time" behavior.
 */
export function FaqAccordion({
  items,
  defaultOpenIndex = 0,
}: {
  items: ReadonlyArray<Faq>;
  defaultOpenIndex?: number;
}) {
  const [open, setOpen] = useState(defaultOpenIndex);
  return (
    <div className="mx-auto max-w-3xl">
      {items.map((f, i) => {
        const expanded = open === i;
        return (
          <div
            key={f.q}
            className="border-b border-surface-border first:border-t"
          >
            <h3>
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={`faq-panel-${i}`}
                onClick={() => setOpen(expanded ? -1 : i)}
                className="flex w-full items-center justify-between gap-6 py-5 text-left font-display text-xl font-light text-text-default transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <span>{f.q}</span>
                <span aria-hidden className="shrink-0 text-text-muted">
                  {expanded ? (
                    <Minus size={18} />
                  ) : (
                    <Plus size={18} />
                  )}
                </span>
              </button>
            </h3>
            <div
              id={`faq-panel-${i}`}
              hidden={!expanded}
              className={cn(
                "pb-6 text-base leading-relaxed text-text-muted",
                expanded ? "block" : "hidden",
              )}
            >
              {f.a}
            </div>
          </div>
        );
      })}
    </div>
  );
}
