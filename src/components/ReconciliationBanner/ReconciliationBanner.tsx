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
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-sm"
    >
      <div className="space-y-1">
        <p className="font-semibold">
          Reconciliation drift detected
        </p>
        <p className="text-red-800">
          {failures.count === 1
            ? "1 unacknowledged reconciliation failure is currently open."
            : `${failures.count} unacknowledged reconciliation failures are currently open.`}{" "}
          Review and acknowledge each one to clear this banner.
        </p>
      </div>
      <a
        href="/admin/reconciliation"
        data-testid="dashboard-reconciliation-banner-link"
        className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2"
      >
        Review failures
      </a>
    </div>
  );
}
