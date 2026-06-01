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

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
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
    // Story 9.8 — customers whose reminder email hard-bounced; staff
    // follow up by phone. Driven by `reminders:getBouncedEmailCustomers`.
    href: "/admin/reports/email-bounces",
    label: "Bounced emails",
    icon: PhoneCall,
    requiredRoles: ["admin", "office_staff"],
  },
  {
    href: "/admin",
    label: "Admin",
    icon: Shield,
    requiredRoles: ["admin"],
  },
];

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
  // Hooks must be called unconditionally — we always call the query
  // and short-circuit on the source check. When the source is not
  // `pendingExpenseApprovals`, Convex returns `skip: true` semantics
  // by way of the query body itself; here we just discard the result.
  const pending = useQuery(listPendingApprovalsForBadgeRef, {});
  if (item.badgeSource !== "pendingExpenseApprovals") {
    return undefined;
  }
  if (pending === undefined) {
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
