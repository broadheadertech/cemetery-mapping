"use client";

import Link from "next/link";
import { Menu, Search, Bell } from "lucide-react";
import { cn } from "@/lib/cn";
import { useIsMac } from "@/hooks/useIsMac";

/**
 * DesktopTopBar — the operations design's top strip (≥ md).
 *
 * Layout (left → right): a hamburger that collapses/expands the rail, a
 * centred Cmd-K search affordance ("Search lots, customers, contracts…"),
 * and a notifications bell. Sticky + translucent ivory with a backdrop
 * blur so content scrolls beneath it.
 *
 * The search affordance is a button, not an input — it opens the global
 * Cmd-K palette (the real search surface). The keyboard hint is platform-
 * aware (⌘ on Mac, Ctrl elsewhere).
 *
 * On mobile (< md) the {@link MobileTopBar} takes over instead; this bar
 * is hidden by the parent's `hidden md:flex` wrapper.
 */

export interface DesktopTopBarProps {
  /** Toggle the desktop sidebar collapsed state. */
  onToggleCollapse: () => void;
  /** Open the global Cmd-K palette. */
  onOpenSearch: () => void;
  /** Whether the rail is currently collapsed (drives the a11y label). */
  collapsed: boolean;
  /** When true, a gold dot marks the bell as having unread attention. */
  hasNotifications?: boolean;
}

export function DesktopTopBar({
  onToggleCollapse,
  onOpenSearch,
  collapsed,
  hasNotifications = false,
}: DesktopTopBarProps) {
  const isMac = useIsMac();
  const kbdKey = isMac ? "⌘" : "Ctrl";

  return (
    <header
      className="sticky top-0 z-30 flex h-[60px] items-center gap-4 border-b border-[#E1DAC8] bg-[rgba(246,242,234,0.85)] px-6 backdrop-blur-md backdrop-saturate-150"
      data-testid="desktop-topbar"
    >
      <button
        type="button"
        onClick={onToggleCollapse}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-pressed={collapsed}
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md text-[#8E8C85] transition-colors hover:bg-[#EFEADd] hover:text-[#1D5C4D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96B]"
        data-testid="desktop-topbar-collapse"
      >
        <Menu className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onOpenSearch}
        className="flex h-[38px] max-w-[460px] flex-1 items-center gap-2.5 rounded-md border border-[#E1DAC8] bg-white px-3.5 text-left text-[13px] text-[#8E8C85] transition-colors hover:border-[#C9A96B] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96B]"
        data-testid="desktop-topbar-search"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 truncate">
          Search lots, customers, contracts…
        </span>
        <kbd className="ml-auto inline-flex h-5 items-center rounded border border-[#E1DAC8] bg-[#F6F2EA] px-1.5 font-mono text-[10px] font-medium text-[#8E8C85]">
          {kbdKey} K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <Link
          href="/flagged-followups?status=open"
          aria-label="Alerts and follow-ups"
          className="relative flex h-9 w-9 items-center justify-center rounded-md text-[#8E8C85] transition-colors hover:bg-[#EFEADd] hover:text-[#1D5C4D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96B]"
          data-testid="desktop-topbar-bell"
        >
          <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
          {hasNotifications && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute right-2 top-[7px] h-[7px] w-[7px] rounded-full border-[1.5px] border-[#F6F2EA] bg-[#C9A96B]",
              )}
            />
          )}
        </Link>
      </div>
    </header>
  );
}
