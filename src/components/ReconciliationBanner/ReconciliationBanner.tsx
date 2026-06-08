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
 *   The underlying query is admin-only. On non-admin caller the
 *   query throws FORBIDDEN, which Convex's React adapter surfaces as
 *   `undefined` (loading) → error boundary. To avoid bubbling that
 *   into the dashboard error surface for office staff who can render
 *   the dashboard but not see this banner, we render `null` when the
 *   query result is `undefined` (loading) — the banner only ever
 *   ASSERTS itself; it never blocks the page on missing data.
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

export function ReconciliationBanner(): ReactElement | null {
  // `limit: 0` would still cost the same query work server-side
  // (the filter + sort dominate), so we just pass `undefined` and let
  // the server cap the row payload at its default of 50.
  const failures = useQuery(listOpenReconciliationFailuresRef, {});
  // Loading OR non-admin caller (Convex returns `undefined` while the
  // first call is in flight; error states route to the nearest
  // boundary). Render nothing so the page layout is unchanged.
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
