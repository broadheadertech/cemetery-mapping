"use client";

/**
 * /admin/trends — Story 9.9 (FR48).
 *
 * Admin-only trend visualization. Renders the trailing-12-month
 * sales / collections / expenses / net series fetched reactively from
 * `convex/trends.ts → getTrendData`. Admins use this page to see the
 * business's monthly trajectory at a glance, supplementing the
 * Story 5.2 dashboard's single-period KPI tiles.
 *
 * Reactive: any mid-view payment / expense / contract mutation
 * triggers a server-side re-evaluation and the chart re-renders.
 *
 * Server-side enforcement: `convex/trends.ts → getTrendData` calls
 * `requireRole(ctx, ["admin"])` as its first line; the page-level
 * role gate is the AppShell + middleware combo (NFR-S4 defense in
 * depth — see Story 1.5 / 1.2).
 *
 * The Convex `_generated/` ambient module is not committed in this
 * repo. We reference the query via `makeFunctionReference`, the same
 * pattern used by `/admin/expense-approvals` and `/admin/expense-categories`.
 */

import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { TrendChart, type TrendChartBucket } from "@/components/TrendChart";
import { formatPeso } from "@/lib/money";

/**
 * Row shape returned by `convex/trends.ts → getTrendData`. Mirrored
 * here so the page does not depend on the server module's full
 * type surface (the Convex codegen path is not present in this repo;
 * we type the reference manually for parity with sibling admin pages).
 */
interface TrendDataResult {
  buckets: TrendChartBucket[];
  arBalanceCents: number;
  generatedAtMs: number;
}

const getTrendDataRef = makeFunctionReference<
  "query",
  Record<string, never>,
  TrendDataResult
>("trends:getTrendData");

const GENERATED_AT_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  dateStyle: "medium",
  timeStyle: "short",
});

export default function AdminTrendsPage() {
  const data = useQuery(getTrendDataRef, {});
  const buckets = data === undefined ? undefined : data.buckets;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            Trend analysis
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Trailing 12 calendar months of sales, collections, expenses
            and net cash flow. Buckets are anchored to the cemetery&apos;s
            Manila timezone and update reactively as new payments and
            expenses post.
          </p>
        </div>
        {data !== undefined && (
          <div
            className="text-right text-xs text-slate-500"
            data-testid="trends-generated-at"
          >
            <div>Last refreshed</div>
            <div className="font-medium text-slate-700">
              {GENERATED_AT_FORMATTER.format(new Date(data.generatedAtMs))}
            </div>
          </div>
        )}
      </div>

      <section
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        aria-label="Twelve-month trend chart"
      >
        <TrendChart buckets={buckets} />
      </section>

      <section
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
        aria-label="Current AR balance"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
              Current AR balance
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Sum of all active and in-default contract balances. AR is a
              point-in-time snapshot, not a flow — a monthly AR-delta
              series is a Phase 4 follow-up that owns the rollup table.
            </p>
          </div>
          <div
            className="text-2xl font-semibold tabular-nums text-slate-900"
            data-testid="trends-ar-balance"
          >
            {data === undefined ? "—" : formatPeso(data.arBalanceCents)}
          </div>
        </div>
      </section>
    </div>
  );
}
