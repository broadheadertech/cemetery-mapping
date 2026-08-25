"use client";

/**
 * Reconciliation banner — Story 5.5 follow-up (FR60, NFR-R4).
 *
 * Renders a red, dismiss-resistant warning at the top of the dashboard
 * when the reconciliation register holds at least one open (un-
 * acknowledged) failure. The banner subscribes via Convex `useQuery`
 * to `reconciliation:listOpenReconciliationFailures` so the count
 * updates in real time the moment the daily cron writes (or the admin
 * acknowledges) a row.
 *
 * Why this component (rather than inlining in the dashboard page):
 *
 *   - The banner is intentionally a top-of-page surface — separating
 *     it from the KPI grid makes the layout easier to scan + makes the
 *     "this is a system-health warning" tone unambiguous.
 *   - The same banner can be reused on any future page that needs to
 *     surface "money integrity drift in progress" (e.g. /payments,
 *     /reports). Keeping it a small focused component aligns with the
 *     architecture's "design for reuse" principle.
 *
 * Auth posture:
 *   `reconciliation:listOpenReconciliationFailures` is admin-only, and
 *   the dashboard this banner sits on is not — office staff and field
 *   workers open it every day.
 *
 *   An earlier version simply ran the query and treated `undefined` as
 *   "loading or not permitted". That was wrong about how Convex
 *   behaves: `useQuery` does not swallow a rejected query into
 *   `undefined`, it THROWS during render. So every non-admin who
 *   opened the dashboard in production got an uncaught
 *   `FORBIDDEN` ConvexError instead of a dashboard.
 *
 *   The query is now gated on the caller's own roles, read through
 *   `users:getCurrentUserRoles` — a `requireAuth` self-read that any
 *   signed-in user may call. Non-admins pass `"skip"`, so the
 *   subscription never opens and there is nothing to reject. This is
 *   the same pattern the sidebar badge uses in
 *   `src/components/Sidebar/nav-items.ts`.
 */

import type { ReactElement } from "react";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface ListOpenReconciliationFailuresResult {
  count: number;
  // Row shape is opaque to the banner; the admin queue page renders
  // the full detail. The banner only consumes `count`.
  rows: unknown[];
}

const listOpenReconciliationFailuresRef = makeFunctionReference<
  "query",
  { limit?: number },
  ListOpenReconciliationFailuresResult
>("reconciliation:listOpenReconciliationFailures");

/**
 * Self-read of the caller's own roles. Gated on `requireAuth`, not on a
 * role, so it is safe for every signed-in user.
 */
const getCurrentUserRolesRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { userId: string; roles: string[]; isActive: boolean }
>("users:getCurrentUserRoles");

export function ReconciliationBanner(): ReactElement | null {
  const me = useQuery(getCurrentUserRolesRef, {});
  const isAdmin = me?.roles.includes("admin") ?? false;

  // `"skip"` keeps the hook call unconditional while leaving the
  // subscription closed for anyone who may not read the register.
  // Running it and hoping for `undefined` is what broke the dashboard
  // for every non-admin — see this file's auth note.
  //
  // `limit` is left unset: the filter and sort dominate the server-side
  // cost, so capping rows saves nothing, and the server already caps
  // the payload at 50.
  const failures = useQuery(
    listOpenReconciliationFailuresRef,
    isAdmin ? {} : "skip",
  );

  // Still resolving the caller, not permitted, or nothing open — the
  // banner only ever asserts itself, it never blocks the page.
  if (!isAdmin) return null;
  if (failures === undefined) return null;
  if (failures.count === 0) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="dashboard-reconciliation-banner"
      className="flex flex-wrap items-center gap-3 rounded-md border border-[#FDE68A] bg-[#FFFBEB] px-[18px] py-[13px] text-[13.5px] font-medium text-[#78350F]"
    >
      <AlertTriangle
        className="h-[18px] w-[18px] shrink-0 text-[#B45309]"
        aria-hidden="true"
      />
      <span className="flex-1">
        <strong className="font-semibold">Reconciliation drift:</strong>{" "}
        {failures.count === 1
          ? "1 unacknowledged reconciliation failure is open"
          : `${failures.count} unacknowledged reconciliation failures are open`}{" "}
        awaiting acknowledgement.
      </span>
      <Link
        href="/admin/reconciliation"
        data-testid="dashboard-reconciliation-banner-link"
        className="shrink-0 font-semibold text-[#1D5C4D] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96B] focus-visible:ring-offset-2"
      >
        Review
      </Link>
    </div>
  );
}
