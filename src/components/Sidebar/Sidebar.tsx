"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserMenu } from "@/components/UserMenu";
import {
  NAV_GROUPS,
  filterNavGroups,
  isNavItemActive,
  type NavItem,
} from "./nav-items";

/**
 * Sidebar — desktop navigation chassis.
 *
 * Operations design system (the Claude handoff): deep-emerald rail, ivory
 * text, rationed gold. The nav is grouped into mono-uppercase sections
 * (Overview / Sales & Records / Finance / Operations / Admin); the active
 * item carries a gold left-edge accent bar.
 *
 * Global search (Cmd-K) and the collapse toggle live in the DESKTOP TOP
 * BAR per the design — not in the rail. The rail therefore runs masthead →
 * grouped nav → user menu, with nothing between the wordmark and the
 * first section.
 *
 * This component renders both as the always-visible desktop sidebar AND as
 * the body of the mobile hamburger Sheet (MobileTopBar forces
 * `forceExpanded` in that context).
 */

export interface SidebarProps {
  /** Desktop collapsed (icon-rail) state. Ignored when `forceExpanded`. */
  collapsed: boolean;
  /** User's roles — drives nav-item visibility. */
  roles: ReadonlyArray<string>;
  /** Force-expanded rendering — used when the sidebar is portaled inside
   *  the mobile hamburger Sheet. */
  forceExpanded?: boolean;
  /** User's display name + email for the bottom user menu. */
  user: { name: string; email: string };
}

export function Sidebar({
  collapsed,
  roles,
  forceExpanded = false,
  user,
}: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const effectivelyCollapsed = collapsed && !forceExpanded;
  const groups = filterNavGroups(NAV_GROUPS, roles);

  return (
    <aside
      aria-label="Primary"
      className={cn(
        // Brand operations design system: deep-emerald sidebar, ivory
        // text, rationed gold. Matches the Claude operations design.
        "flex h-screen flex-col border-r border-[rgba(201,169,107,0.18)] bg-[#144437] text-[#F6F2EA]",
        effectivelyCollapsed ? "w-[72px]" : "w-[248px]",
      )}
      data-collapsed={effectivelyCollapsed ? "true" : "false"}
    >
      {/* Masthead — Apostle Paul brand mark + wordmark. A gold hairline
          beneath the header is the only gold surface (rationed). Cormorant
          Garamond at ceremonial tracking carries the institutional voice. */}
      <Link
        href="/dashboard"
        className={cn(
          "flex h-[76px] shrink-0 items-center border-b border-[rgba(201,169,107,0.2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#C9A96B]",
          effectivelyCollapsed ? "justify-center px-2" : "px-[18px]",
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
            <span className="font-display text-[16px] font-semibold uppercase tracking-ceremonial text-[#F6F2EA]">
              Apostle Paul
            </span>
            <span className="mt-[3px] font-mono text-[8.5px] font-medium uppercase tracking-[0.22em] text-[#D4BC85]">
              Operations · Est. 1987
            </span>
          </span>
        )}
      </Link>

      {/* Grouped nav list — mono-uppercase section headers, gold-edged
          active item. Empty groups are pre-filtered out by role. */}
      <nav
        className="flex-1 overflow-y-auto px-3 pb-5 pt-2"
        aria-label="Main"
      >
        {groups.map((group) => (
          <div key={group.label}>
            <div
              className={cn(
                "px-[10px] pb-[7px] pt-4 font-mono text-[9px] font-medium uppercase tracking-[0.2em] text-[rgba(212,188,133,0.55)]",
                effectivelyCollapsed && "px-0 text-center text-[7px]",
              )}
              aria-hidden={effectivelyCollapsed ? "true" : undefined}
            >
              {effectivelyCollapsed ? "·" : group.label}
            </div>
            <ul className="flex flex-col gap-px">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    item={item}
                    active={isNavItemActive(item, pathname)}
                    collapsed={effectivelyCollapsed}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* User menu — pinned to the bottom. */}
      <div className="border-t border-[rgba(201,169,107,0.2)] p-2">
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
    "group relative flex items-center rounded-md text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96B] focus-visible:ring-offset-1 focus-visible:ring-offset-[#144437]",
    collapsed ? "h-10 w-10 justify-center" : "gap-3 px-[10px] py-[9px]",
    active
      ? "bg-[#1D5C4D] text-[#F6F2EA]"
      : "text-[rgba(246,242,234,0.78)] hover:bg-[rgba(246,242,234,0.07)] hover:text-[#F6F2EA]",
    // Rationed-gold active accent bar at the sidebar's left edge.
    active &&
      !collapsed &&
      "before:absolute before:left-[-8px] before:top-1/2 before:h-5 before:w-[3px] before:-translate-y-1/2 before:rounded-r before:bg-[#C9A96B]",
    disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
  );

  const content = (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          {item.comingSoon && (
            <span className="ml-auto rounded bg-[rgba(0,0,0,0.2)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[#D4BC85]">
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
