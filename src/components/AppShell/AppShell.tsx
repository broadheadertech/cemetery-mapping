"use client";

import { useCallback, useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/components/Sidebar";
import { MobileTopBar } from "@/components/MobileTopBar";
import { LotSearchCommand } from "@/components/LotSearchCommand";
import { useCollapsedSidebar } from "@/hooks/useCollapsedSidebar";
import { useCmdK } from "@/hooks/useCmdK";

/**
 * AppShell — the staff route group's primary chrome.
 *
 * Composition:
 *   - Skip-to-content link (sr-only until focused)
 *   - Desktop sidebar (`hidden md:flex`) — Story 1.5 Task 3
 *   - Mobile top bar (`md:hidden`) — Story 1.5 Task 6
 *   - Main content slot with `id="main"` so the skip-link works
 *   - Global Cmd-K palette mounted once
 *
 * State:
 *   - sidebar collapsed (localStorage-persisted)
 *   - palette open/closed
 *
 * The shell is a client component because it owns ephemeral UI state
 * (collapsed, palette open) and consumes the cross-tab `localStorage`
 * sync hook. The (staff) server layout supplies the user identity so
 * the shell never refetches what the server already knows.
 *
 * Per UX § Navigation Patterns, no JS-based viewport detection — the
 * sidebar/topbar swap purely via Tailwind's `md:` breakpoint to avoid
 * hydration mismatch.
 */

export interface AppShellProps {
  /** Server-resolved user identity. */
  user: {
    name: string;
    email: string;
    roles: ReadonlyArray<string>;
  };
  /** Title shown in the mobile top bar. Falls back to the Apostle Paul
   *  wordmark when not provided. Per-page overrides land with a context
   *  in a later story; today every page sets this implicitly via its
   *  h1. */
  pageTitle?: string;
  children: React.ReactNode;
}

export function AppShell({
  user,
  pageTitle = "Apostle Paul Memorial Park",
  children,
}: AppShellProps) {
  const { collapsed, toggleCollapsed } = useCollapsedSidebar();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  // Global Cmd-K binding. Hook handles input-element guarding +
  // preventDefault so Chrome doesn't open its URL bar.
  useCmdK(openPalette);

  return (
    <TooltipProvider delayDuration={200}>
      {/* AC5: skip-to-content link as the first focusable element. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg focus:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
      >
        Skip to main content
      </a>

      <div className="flex min-h-screen">
        {/* Desktop sidebar — hidden < md. Sticky to viewport so the
            scroll happens inside <main>. */}
        <div className="hidden md:sticky md:top-0 md:flex md:h-screen md:shrink-0">
          <Sidebar
            collapsed={collapsed}
            onToggleCollapse={toggleCollapsed}
            onOpenSearch={openPalette}
            roles={user.roles}
            user={{ name: user.name, email: user.email }}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Mobile top bar — hidden >= md. */}
          <div className="md:hidden">
            <MobileTopBar
              onOpenSearch={openPalette}
              pageTitle={pageTitle}
              roles={user.roles}
              user={{ name: user.name, email: user.email }}
            />
          </div>

          <main
            id="main"
            tabIndex={-1}
            className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6 md:px-8"
          >
            {children}
          </main>
        </div>
      </div>

      <LotSearchCommand
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
      />
    </TooltipProvider>
  );
}
