"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserMenu } from "@/components/UserMenu";
import {
  NAV_ITEMS,
  filterNavItems,
  isNavItemActive,
  type NavItem,
} from "./nav-items";
import { useIsMac } from "@/hooks/useIsMac";

/**
 * Sidebar — desktop navigation chassis.
 *
 * UX § Navigation Patterns specifies the desktop sidebar:
 *   - 240px expanded / 64px collapsed (icon-rail)
 *   - Logo at top
 *   - Cmd-K trigger immediately under the logo (button styled like a
 *     muted search-input affordance with a keyboard hint)
 *   - Nav items, role-filtered, single-level
 *   - User menu pinned to the bottom (Outdoor mode toggle, Sign out)
 *
 * Active-item highlight uses `bg-surface-emphasis` (Story 1.4 token).
 * The collapse control is the chevron at the sidebar footer, between
 * the nav and the user menu.
 *
 * This component is rendered both as the always-visible desktop
 * sidebar AND as the body of the mobile hamburger Sheet (MobileTopBar
 * forces `collapsed={false}` in that context).
 */

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Trigger the Cmd-K palette open. The keyboard handler lives in
   *  the parent layout so the listener stays global. */
  onOpenSearch: () => void;
  /** User's roles — drives nav-item visibility. */
  roles: ReadonlyArray<string>;
  /** Force-expanded rendering — used when the sidebar is portaled
   *  inside the mobile hamburger Sheet. */
  forceExpanded?: boolean;
  /** User's display name + email for the bottom user menu. */
  user: { name: string; email: string };
}

export function Sidebar({
  collapsed,
  onToggleCollapse,
  onOpenSearch,
  roles,
  forceExpanded = false,
  user,
}: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const effectivelyCollapsed = collapsed && !forceExpanded;
  const items = filterNavItems(NAV_ITEMS, roles);
  const isMac = useIsMac();
  const kbdKey = isMac ? "⌘" : "Ctrl";

  return (
    <aside
      aria-label="Primary"
      className={cn(
        "flex h-screen flex-col border-r border-surface-border bg-surface-base",
        effectivelyCollapsed ? "w-16" : "w-60",
      )}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      {/* Masthead — Apostle Paul brand mark + wordmark. The gold
          hairline beneath the header is the only gold surface in the
          sidebar (rationed). Cormorant Garamond at ceremonial tracking
          carries the institutional voice. */}
      <div
        className={cn(
          "flex h-16 shrink-0 items-center border-b border-accent-gold",
          effectivelyCollapsed ? "justify-center px-2" : "px-4",
        )}
      >
        <Image
          src="/brand/mark.svg"
          alt=""
          width={32}
          height={32}
          priority
          aria-hidden="true"
          className="h-8 w-8 shrink-0"
        />
        {!effectivelyCollapsed && (
          <span className="ml-3 flex min-w-0 flex-col leading-none">
            <span className="font-display text-[13px] font-medium tracking-ceremonial text-primary">
              APOSTLE PAUL
            </span>
            <span className="mt-1 font-display text-[10px] font-medium tracking-wide-mark text-support-forest">
              MEMORIAL PARK
            </span>
          </span>
        )}
      </div>

      {/* Cmd-K trigger — visually a muted search box. Opens the global
          palette via the parent's handler. Keyboard hint is platform-
          aware (⌘ on Mac, Ctrl elsewhere). */}
      <div className={cn("px-2 py-3", effectivelyCollapsed && "flex justify-center")}>
        {effectivelyCollapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenSearch}
                aria-label="Open search"
                className="flex h-10 w-10 items-center justify-center rounded-md text-text-muted hover:bg-surface-emphasis hover:text-text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
              >
                <Search className="h-4 w-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              Search ({kbdKey} K)
            </TooltipContent>
          </Tooltip>
        ) : (
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex w-full items-center gap-2 rounded-md border border-surface-border bg-surface-muted px-3 py-2 text-left text-sm text-text-muted hover:bg-surface-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 truncate">Search…</span>
            <kbd className="ml-auto inline-flex h-5 items-center rounded border border-surface-border bg-surface-base px-1.5 text-[10px] font-medium text-text-muted">
              {kbdKey} K
            </kbd>
          </button>
        )}
      </div>

      {/* Nav list */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Main">
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.href}>
              <NavLink
                item={item}
                active={isNavItemActive(item, pathname)}
                collapsed={effectivelyCollapsed}
              />
            </li>
          ))}
        </ul>
      </nav>

      {/* Collapse toggle — hidden in mobile sheet (forceExpanded). */}
      {!forceExpanded && (
        <div className="border-t border-surface-border px-2 py-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-2 text-sm text-text-muted hover:bg-surface-emphasis hover:text-text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1",
              effectivelyCollapsed ? "w-full justify-center" : "w-full",
            )}
          >
            {effectivelyCollapsed ? (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* User menu — pinned to the bottom. */}
      <div className="border-t border-surface-border p-2">
        <UserMenu
          name={user.name}
          email={user.email}
          collapsed={effectivelyCollapsed}
        />
      </div>
    </aside>
  );
}

interface NavLinkProps {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}

function NavLink({ item, active, collapsed }: NavLinkProps) {
  const Icon = item.icon;
  const disabled = !!item.comingSoon;
  const linkClasses = cn(
    "group flex items-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1",
    collapsed ? "h-10 w-10 justify-center" : "gap-3 px-3 py-2",
    active
      ? "bg-surface-emphasis text-text-default"
      : "text-text-muted hover:bg-surface-emphasis hover:text-text-default",
    disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
  );

  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.comingSoon && (
            <span className="ml-auto rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-medium text-text-subtle">
              {item.comingSoon}
            </span>
          )}
        </>
      )}
    </>
  );

  // Disabled items render as a non-interactive span; later stories
  // will flip `comingSoon` off as the destination pages ship.
  const inner = disabled ? (
    <span
      className={linkClasses}
      aria-disabled="true"
      role="link"
      title={item.comingSoon ? `${item.label} (${item.comingSoon})` : item.label}
    >
      {content}
    </span>
  ) : (
    <Link
      href={item.href}
      className={linkClasses}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent side="right">
          {item.label}
          {item.comingSoon ? ` (${item.comingSoon})` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }
  return inner;
}
