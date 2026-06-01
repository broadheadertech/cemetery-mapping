"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/cn";

/**
 * shadcn/ui-style Tooltip primitives, thinly wrapping Radix.
 *
 * UX § Modal & Overlay Patterns specifies tooltips are single-line
 * labels for icon-only controls. We default `delayDuration` to a snappy
 * 200ms so the collapsed-sidebar reveal feels responsive.
 *
 * Consumers must wrap interactive children with `TooltipProvider` once
 * near the top of the tree (the (staff) layout does this for us).
 */

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(function TooltipContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-md bg-primary px-2 py-1 text-xs text-primary-fg shadow-md",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
});

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
