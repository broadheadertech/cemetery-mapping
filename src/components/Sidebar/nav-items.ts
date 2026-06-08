"use client";

import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  MapPin,
  Users,
  Receipt,
  CreditCard,
  TrendingUp,
  Wallet,
  FileBarChart,
  FileText,
  Building2,
  Shield,
  CalendarDays,
  PhoneCall,
  ClipboardCheck,
  LineChart,
  Boxes,
} from "lucide-react";
import type { Role } from "@/types/role";

/**
 * Sidebar nav items — the single source of truth for the desktop and
 * mobile navigation lists.
 *
 * Each item declares the roles allowed to *see* the link. Server-side
 * enforcement still applies on the destination page; this is purely a
 * UI affordance ("don't show what you can't use").
 *
 * `comingSoon` items render disabled with a Phase tag — the URL points
 * at the canonical destination so the link will work once the
 * corresponding epic lands. This keeps the sidebar feeling complete
 * during Phase 1 without 404s.
 *
 * `Search` is intentionally absent — UX § Search & Filtering flags
 * "Separate Search page" as an anti-pattern. Search lives in Cmd-K.
 */
/**
 * Reactive badge sources a nav item can opt into. Sidebar renderers
 * can read `useNavItemBadgeCount(item)` to fetch the current count;
 * a return value of `0` means "hide the badge", `null`/`undefined`
 * means "not applicable / still loading". Story 6.7 adds the
 * `pendingExpenseApprovals` source — wired to
 * `convex/expenses.ts → listPendingApprovals`.
 */
export type NavItemBadgeSource = "pendingExpenseApprovals";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see the item. Empty array = visible to everyone. */
  requiredRoles: ReadonlyArray<Role>;
  /** Optional Phase / Story label rendered as a muted suffix. */
  comingSoon?: string;
  /**
   * Optional badge source. Renderers should call
   * `useNavItemBadgeCount(item)` to read the live count and render a
   * small numeric pill next to the label when the value is > 0. The
   * badge is auto-hidden when the count is zero (operator should not
   * see a "0" pill — a clean queue should look clean).
   */
  badgeSource?: NavItemBadgeSource;
}

/**
 * A titled cluster of nav items. The operations design system groups the
 * sidebar into labelled sections (Overview / Sales & Records / Finance /
 * Operations / Admin) with a mono uppercase section header above each —
 * this is the single source of truth for that structure.
 */
export interface NavGroup {
  /** Section header (mono uppercase in the rail). */
  label: string;
  items: ReadonlyArray<NavItem>;
}

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  {
    label: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        requiredRoles: ["admin", "office_staff", "field_worker"],
      },
      {
        href: "/lots",
        label: "Lots",
        icon: MapPin,
        requiredRoles: ["admin", "office_staff", "field_worker"],
      },
    ],
  },
  {
    label: "Sales & Records",
    items: [
      {
        href: "/customers",
        label: "Customers",
        icon: Users,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/sales",
        label: "Sales",
        icon: Receipt,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/contracts",
        label: "Contracts",
        icon: FileText,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/family-estates",
        label: "Family Estates",
        icon: Building2,
        requiredRoles: ["admin", "office_staff"],
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        href: "/payments",
        label: "Payments",
        icon: CreditCard,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/receipts",
        label: "Receipts",
        icon: Receipt,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/ar-aging",
        label: "AR Aging",
        icon: TrendingUp,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/follow-ups",
        label: "Follow-ups",
        icon: PhoneCall,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        href: "/expenses",
        label: "Expenses",
        icon: Wallet,
        requiredRoles: ["admin", "office_staff"],
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/interments",
        label: "Interments",
        icon: CalendarDays,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        // Story 7.5 — combined consecration + interment calendar.
        href: "/ceremonies/calendar",
        label: "Ceremonies",
        icon: CalendarDays,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        // Phase Planning — development-parcel runway, survey pipeline, and
        // the 6-step mapping playbook. Back-office surface (no field worker).
        href: "/phase-planning",
        label: "Phase Planning",
        icon: Boxes,
        requiredRoles: ["admin", "office_staff"],
      },
    ],
  },
  {
    label: "Admin",
    items: [
      {
        href: "/reports",
        label: "Reports",
        icon: FileBarChart,
        requiredRoles: ["admin"],
      },
      {
        href: "/admin/expense-approvals",
        label: "Expense approvals",
        icon: ClipboardCheck,
        requiredRoles: ["admin"],
        badgeSource: "pendingExpenseApprovals",
      },
      {
        // Story 9.9 — trailing-12-month trend visualisation. Admin-only;
        // the destination page hosts the SVG chart driven by
        // `convex/trends.ts → getTrendData`.
        href: "/admin/trends",
        label: "Trends",
        icon: LineChart,
        requiredRoles: ["admin"],
      },
      {
        // The admin hub — staff accounts, settings, compliance, and the
        // back-office tools (incl. bounced-email follow-ups) that don't
        // each warrant a top-level rail entry.
        href: "/admin",
        label: "Admin",
        icon: Shield,
        requiredRoles: ["admin"],
      },
    ],
  },
];

/**
 * Flattened nav list — derived from {@link NAV_GROUPS} so the grouped
 * sidebar and any flat consumer (search palette, tests) share one source
 * of truth. Order matches top-to-bottom rail order.
 */
export const NAV_ITEMS: ReadonlyArray<NavItem> = NAV_GROUPS.flatMap(
  (group) => group.items,
);

/**
 * Convex function reference for the pending-approvals count. Defined
 * via `makeFunctionReference` because `convex/_generated/` is not yet
 * present in the repo (matches the pattern used by
 * `/admin/expense-approval-settings`).
 *
 * The query returns the full row projection; the hook below derives
 * the count from `array.length`. Phase 1 queues are sub-1K rows so
 * this is comfortably within Convex's reactivity budget. If the
 * pending queue ever exceeds that ballpark we will swap in a
 * dedicated count query without changing the hook's contract.
 */
const listPendingApprovalsForBadgeRef = makeFunctionReference<
  "query",
  { limit?: number },
  ReadonlyArray<{ _id: string }>
>("expenses:listPendingApprovals");

/**
 * Reactive nav-item badge count.
 *
 * Returns `undefined` while the underlying query is loading, and a
 * non-negative integer otherwise. `0` means "no pending approvals —
 * hide the badge". Renderers can treat `undefined` as "do not show a
 * placeholder spinner"; the badge only ever flicks on once data lands.
 *
 * Today only `pendingExpenseApprovals` is wired. Add a new branch
 * here when a future story introduces another reactive badge.
 */
export function useNavItemBadgeCount(item: NavItem): number | undefined {
  // Hooks must be called unconditionally, but the query MUST NOT run for
  // items without this badge source — `listPendingApprovals` is admin-
  // gated and would throw FORBIDDEN (or SESSION_EXPIRED on a stale auth
  // token) for every other nav item. Passing `"skip"` keeps the hook
  // call unconditional while leaving the subscription dormant unless the
  // item genuinely opts in.
  const enabled = item.badgeSource === "pendingExpenseApprovals";
  const pending = useQuery(
    listPendingApprovalsForBadgeRef,
    enabled ? {} : "skip",
  );
  if (!enabled || pending === undefined) {
    return undefined;
  }
  return pending.length;
}

/**
 * Filter the nav items by the caller's roles. An item is shown if the
 * user has at least one of the item's `requiredRoles`.
 */
export function filterNavItems(
  items: ReadonlyArray<NavItem>,
  roles: ReadonlyArray<string>,
): ReadonlyArray<NavItem> {
  if (roles.length === 0) return [];
  return items.filter((item) =>
    item.requiredRoles.some((required) => roles.includes(required)),
  );
}

/**
 * Filter nav GROUPS by the caller's roles: each group keeps only the
 * items the user may see, and groups left empty are dropped entirely so
 * the rail never renders a dangling section header.
 */
export function filterNavGroups(
  groups: ReadonlyArray<NavGroup>,
  roles: ReadonlyArray<string>,
): ReadonlyArray<NavGroup> {
  if (roles.length === 0) return [];
  return groups
    .map((group) => ({
      ...group,
      items: filterNavItems(group.items, roles),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Active-item matcher. A nav item is "active" when the current pathname
 * is an exact match for `href` OR a descendant (`/lots/d-5-12` is under
 * `/lots`). The Dashboard root is a special case — it only matches its
 * exact path so `/lots/...` doesn't also light up Dashboard.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
