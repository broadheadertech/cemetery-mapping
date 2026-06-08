"use client";

import { useState } from "react";
import { Menu, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Sidebar } from "@/components/Sidebar";
import { VisuallyHidden } from "@/components/LotSearchCommand/VisuallyHidden";

/**
 * MobileTopBar — < 768px navigation chrome.
 *
 * UX § Navigation Patterns > Mobile layout: hamburger left, page title
 * centre, search icon right. The hamburger opens a left-anchored Sheet
 * containing the same Sidebar (force-expanded). The search icon opens
 * the global Cmd-K palette as a fullscreen sheet — wired by the parent
 * via `onOpenSearch`.
 *
 * Per UX-DR22 the top bar carries a "Cached / Live" indicator pill;
 * Story 1.13 will wire its real logic. For now we render a static
 * placeholder `<span>` with a stable DOM slot (`data-network-state`)
 * so Story 1.13 can target it without restructuring this component.
 */

export interface MobileTopBarProps {
  onOpenSearch: () => void;
  pageTitle: string;
  roles: ReadonlyArray<string>;
  user: { name: string; email: string };
}

export function MobileTopBar({
  onOpenSearch,
  pageTitle,
  roles,
  user,
}: MobileTopBarProps) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-surface-border bg-surface-base px-3",
      )}
    >
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          onClick={() => setNavOpen(true)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-default hover:bg-surface-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <SheetContent side="left" hideCloseButton className="w-72 p-0">
          <VisuallyHidden>
            <SheetTitle>Navigation</SheetTitle>
          </VisuallyHidden>
          {/* Render the sidebar in force-expanded mode so the mobile
              drawer always shows full labels regardless of the desktop
              collapsed preference. The collapse toggle is hidden via
              `forceExpanded`. */}
          <Sidebar
            collapsed={false}
            roles={roles}
            forceExpanded
            user={user}
          />
        </SheetContent>
      </Sheet>

      <div className="flex flex-1 items-center justify-center">
        <span className="truncate text-sm font-semibold text-text-default">
          {pageTitle}
        </span>
        {/* UX-DR22: stable DOM slot for Story 1.13 to replace with the
            real Cached / Live indicator. Static "Live" placeholder. */}
        <span
          data-network-state="live"
          className="ml-2 hidden text-[10px] font-medium uppercase tracking-wide text-text-muted sm:inline"
        >
          Live
        </span>
      </div>

      <button
        type="button"
        aria-label="Open search"
        onClick={onOpenSearch}
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-text-default hover:bg-surface-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Search className="h-5 w-5" aria-hidden="true" />
      </button>
    </header>
  );
}
