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
  MessageSquare,
  Sparkles,
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
 * `convex/expenses.ts → listPendingApprovals`. `newEnquiries` is wired
 * to `convex/enquiries.ts → getEnquiryCounts`.
 */
export type NavItemBadgeSource =
  | "pendingExpenseApprovals"
  | "newEnquiries";

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
        // Ranks available lots against what a family has said they need.
        // Sits beside Sales because that is the conversation it serves.
        href: "/lots/suggest",
        label: "Suggest a lot",
        icon: Sparkles,
        requiredRoles: ["admin", "office_staff"],
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
        href: "/family-estates",
        label: "Family Estates",
        icon: Building2,
        requiredRoles: ["admin", "office_staff"],
      },
      {
        // Visit requests and pricing questions from the public site.
        // Badged because every unanswered row is a person who was told
        // we would call them back.
        href: "/enquiries",
        label: "Enquiries",
        icon: MessageSquare,
        requiredRoles: ["admin", "office_staff"],
        badgeSource: "newEnquiries",
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
        // Families who have finished paying and have no certificate yet.
        // A work list, not a dashboard tile — each row is a person owed
        // a document.
        href: "/certificates",
        label: "Certificates",
        icon: FileText,
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
        // Inventory analytics — the sales rate measured from contracts,
        // and the runway that falls out of it. Sits beside Phase
        // Planning deliberately: the plan's absorption figure is typed
        // in by hand, and this is where it gets checked.
        href: "/analytics",
        label: "Inventory",
        icon: LineChart,
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
        // What the cemetery charges, and the offers on top. Admin-only:
        // office staff read plans to fill a sale form and must not be
        // able to mint one on the way to closing a sale.
        href: "/admin/settings/payment-plans",
        label: "Payment plans",
        icon: Wallet,
        requiredRoles: ["admin"],
      },
      {
        // The park's own certificate blank and its field placements.
        // Admin-only: this file becomes every certificate the park
        // issues, so replacing it is a decision, not a task.
        href: "/admin/settings/certificate",
        label: "Certificate",
        icon: FileText,
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
 * New-enquiry count. A dedicated counts query rather than a list —
 * unlike the approvals badge above, there was no existing list query
 * to borrow, and counting is all the rail needs.
 */
const enquiryCountsForBadgeRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { new: number; contacted: number }
>("enquiries:getEnquiryCounts");

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
  const approvalsEnabled = item.badgeSource === "pendingExpenseApprovals";
  const enquiriesEnabled = item.badgeSource === "newEnquiries";
  const pending = useQuery(
    listPendingApprovalsForBadgeRef,
    approvalsEnabled ? {} : "skip",
  );
  const enquiryCounts = useQuery(
    enquiryCountsForBadgeRef,
    enquiriesEnabled ? {} : "skip",
  );
  if (approvalsEnabled) {
    return pending === undefined ? undefined : pending.length;
  }
  if (enquiriesEnabled) {
    return enquiryCounts === undefined ? undefined : enquiryCounts.new;
  }
  return undefined;
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
