"use client";

import * as React from "react";
import {
  Command as CommandPrimitive,
  CommandEmpty as CommandPrimitiveEmpty,
  CommandGroup as CommandPrimitiveGroup,
  CommandInput as CommandPrimitiveInput,
  CommandItem as CommandPrimitiveItem,
  CommandList as CommandPrimitiveList,
  CommandSeparator as CommandPrimitiveSeparator,
} from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * shadcn/ui-style Command palette primitives, wrapping `cmdk`.
 *
 * The primitives below are the building blocks Story 1.10 will fill
 * with real result rows (lots, customers, contracts, receipts). This
 * story only renders the scaffolded shell.
 *
 * Accessibility: `cmdk` provides ARIA combobox semantics out of the
 * box — listbox, options, aria-selected as you arrow through. We layer
 * only visual tokens; do not add custom keyboard handlers.
 */

const Command = React.forwardRef<
  React.ElementRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(function Command({ className, ...props }, ref) {
  return (
    <CommandPrimitive
      ref={ref}
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-surface-base text-text-default",
        className,
      )}
      {...props}
    />
  );
});

const CommandInput = React.forwardRef<
  React.ElementRef<typeof CommandPrimitiveInput>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveInput>
>(function CommandInput({ className, ...props }, ref) {
  return (
    <div
      className="flex items-center border-b border-surface-border px-3"
      data-cmdk-input-wrapper
    >
      <Search
        className="mr-2 h-4 w-4 shrink-0 text-text-muted"
        aria-hidden="true"
      />
      <CommandPrimitiveInput
        ref={ref}
        className={cn(
          "flex h-11 w-full bg-transparent py-3 text-sm outline-none placeholder:text-text-subtle disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
});

const CommandList = React.forwardRef<
  React.ElementRef<typeof CommandPrimitiveList>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveList>
>(function CommandList({ className, ...props }, ref) {
  return (
    <CommandPrimitiveList
      ref={ref}
      className={cn(
        "max-h-[300px] overflow-y-auto overflow-x-hidden",
        className,
      )}
      {...props}
    />
  );
});

const CommandEmpty = React.forwardRef<
  React.ElementRef<typeof CommandPrimitiveEmpty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveEmpty>
>(function CommandEmpty({ className, ...props }, ref) {
  return (
    <CommandPrimitiveEmpty
      ref={ref}
      className={cn(
        "py-6 text-center text-sm text-text-muted",
        className,
      )}
      {...props}
    />
  );
});

const CommandGroup = React.forwardRef<
  React.ElementRef<typeof CommandPrimitiveGroup>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveGroup>
>(function CommandGroup({ className, ...props }, ref) {
  return (
    <CommandPrimitiveGroup
      ref={ref}
      className={cn(
        "overflow-hidden p-1 text-text-default [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-text-muted",
        className,
      )}
      {...props}
    />
  );
});

const CommandSeparator = React.forwardRef<
  React.ElementRef<typeof CommandPrimitiveSeparator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveSeparator>
>(function CommandSeparator({ className, ...props }, ref) {
  return (
    <CommandPrimitiveSeparator
      ref={ref}
      className={cn("-mx-1 h-px bg-surface-border", className)}
      {...props}
    />
  );
});

const CommandItem = React.forwardRef<
  React.ElementRef<typeof CommandPrimitiveItem>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitiveItem>
>(function CommandItem({ className, ...props }, ref) {
  return (
    <CommandPrimitiveItem
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-emphasis data-[selected=true]:text-text-default",
        className,
      )}
      {...props}
    />
  );
});

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
};
