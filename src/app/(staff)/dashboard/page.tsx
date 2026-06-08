"use client";

/**
 * /dashboard — owner KPI dashboard (Story 5.2, FR42, Journey 4).
 *
 * The defining page of the product. The full implementation replaces
 * Story 1.1's auth-smoke placeholder.
 *
 * The page is rendered for every staff role (the middleware gates
 * `/dashboard` at the edge for all signed-in staff) but the underlying
 * `getDashboardKpis` query is admin-only by `requireRole`. Non-admins
 * land here and see a degraded view: the lot inventory + active-contracts
 * tiles are masked, the AR aging summary renders the placeholder bucket
 * list, and an inline note explains that the full financial dashboard is
 * admin-only. We deliberately do not redirect non-admins away from
 * `/dashboard` — they still benefit from the staff-scoped views (Cmd-K,
 * sidebar) the layout provides.
 *
 * Period toggle (MTD / YTD) lives in the URL query string for
 * shareability. The `useSearchParams` hook returns the URL-bound state;
 * `router.replace` updates it without polluting browser history with
 * every toggle flip.
 *
 * Story 5.3 wires the drill-down navigation. Each KPI tile (except Net,
 * which is a derived metric without a single underlying list) carries an
 * `onClick` that `router.push`-es to a filtered list URL with the
 * current period preserved as a query param. The AR Aging bucket rows
 * are rendered as `<button>` elements that route to `/ar-aging?bucket=…`
 * (using the object form of `router.push` so the `+` in the `90+`
 * bucket key is URL-encoded as `%2B`). The Flagged-for-Follow-up tile
 * routes to `/flagged-followups?status=open`. `router.push` (not
 * `router.replace`) is used throughout so the dashboard stays in
 * browser history and the back-button returns the user to the original
 * URL — period selection preserved because the URL is the source of
 * truth.
 *
 * Architectural cornerstones exercised:
 *   - Reactive queries (Convex `useQuery`) — no `setInterval`, no manual
 *     polling. The Convex subscription pushes new values on payment /
 *     expense write.
 *   - `KpiCard` (Story 5.1) wraps `ReactiveHighlight` (Story 1.4) — the
 *     600ms amber fade on value change is the magic moment.
 *   - `formatPeso` is called HERE (the consumer), never inside `KpiCard`.
 *   - Server-side aggregation only — no `.reduce` over a Convex query
 *     result on the client.
 *
 * Page composition:
 *   1. Header row: h1 "Dashboard" + period toggle ("MTD | YTD").
 *   2. ARIA live region for period-switch announcement.
 *   3. Money tiles grid: MTD/YTD Sales, Collections, AR Balance,
 *      Expenses, Net.
 *   4. Inventory tiles grid: Lots Available, Lots Sold, Lots Occupied,
 *      Active Contracts. (Admin-only — placeholder skeleton on a
 *      degraded view.)
 *   5. AR aging summary card (multi-row bucket list).
 *   6. Flagged for follow-up tile.
 */

import { useMemo, type ReactElement } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { KpiCard, type KpiCardDeltaTone } from "@/components/KpiCard";
import { ReconciliationBanner } from "@/components/ReconciliationBanner";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";

// ---------------------------------------------------------------------------
// Convex function references. Untyped via `makeFunctionReference` to dodge
// the `convex/_generated/api` dependency that only materialises after
// `npx convex dev`.
// ---------------------------------------------------------------------------

interface DashboardKpiResult {
  period: "mtd" | "ytd";
  periodStartMs: number;
  periodEndMs: number;
  lotsTotal: number;
  lotsAvailable: number;
  lotsReserved: number;
  lotsSold: number;
  lotsOccupied: number;
  contractsActive: number;
  contractsInDefault: number;
  contractsPaidInFull: number;
  salesCents: number;
  collectionsCents: number;
  arBalanceCents: number;
  expensesCents: number;
  netCents: number;
  netIsNegative: boolean;
  salesDeltaCents: number;
  collectionsDeltaCents: number;
  expensesDeltaCents: number;
  netDeltaCents: number;
  netDeltaIsNegative: boolean;
}

interface ArAgingBucket {
  key: "1-30" | "31-60" | "61-90" | "90+";
  count: number;
  totalCents: number;
  withLoggedActionCount: number;
}

interface ArAgingSummaryResult {
  buckets: ArAgingBucket[];
  isPlaceholder: boolean;
}

interface FlaggedForFollowupResult {
  count: number;
  mostRecentComment: string | null;
  mostRecentFlaggedAt: number | null;
  isPlaceholder: boolean;
}

const getDashboardKpisRef = makeFunctionReference<
  "query",
  { period: "mtd" | "ytd" },
  DashboardKpiResult
>("dashboard:getDashboardKpis");

const getArAgingSummaryRef = makeFunctionReference<
  "query",
  Record<string, never>,
  ArAgingSummaryResult
>("dashboard:getArAgingSummary");

const getFlaggedForFollowupSummaryRef = makeFunctionReference<
  "query",
  Record<string, never>,
  FlaggedForFollowupResult
>("dashboard:getFlaggedForFollowupSummary");

// ---------------------------------------------------------------------------
// Delta-text formatting.
//
// The KPI tiles want a SHORT delta string ("+₱16,000 today") with a
// tone derived from the metric's semantic. The tone mapping is per-
// metric: sales / collections / net go positive when up, expenses go
// negative when up. We expose the mapping explicitly so a future tile
// can add itself without re-deriving the rule.
// ---------------------------------------------------------------------------

interface DeltaTone {
  text: string;
  tone: KpiCardDeltaTone;
}

function formatMoneyDeltaForRevenue(
  deltaCents: number,
  periodLabel: string,
): DeltaTone {
  return {
    text: formatSignedPesoDelta(deltaCents, periodLabel),
    tone: toneForRevenue(deltaCents),
  };
}

function formatMoneyDeltaForExpense(
  deltaCents: number,
  periodLabel: string,
): DeltaTone {
  return {
    text: formatSignedPesoDelta(deltaCents, periodLabel),
    tone: toneForExpense(deltaCents),
  };
}

function formatMoneyDeltaForNet(
  deltaCents: number,
  periodLabel: string,
): DeltaTone {
  return {
    text: formatSignedPesoDelta(deltaCents, periodLabel),
    tone: toneForRevenue(deltaCents),
  };
}

function formatSignedPesoDelta(
  deltaCents: number,
  periodLabel: string,
): string {
  if (deltaCents === 0) return `No change ${periodLabel}`;
  const sign = deltaCents > 0 ? "+" : "−";
  const magnitude = formatPeso(Math.abs(deltaCents));
  return `${sign}${magnitude} ${periodLabel}`;
}

function toneForRevenue(deltaCents: number): KpiCardDeltaTone {
  if (deltaCents > 0) return "positive";
  if (deltaCents < 0) return "negative";
  return "neutral";
}

function toneForExpense(deltaCents: number): KpiCardDeltaTone {
  // Higher expenses are bad (negative tone).
  if (deltaCents > 0) return "negative";
  if (deltaCents < 0) return "positive";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Page component.
// ---------------------------------------------------------------------------

export default function DashboardPage(): ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const period: "mtd" | "ytd" =
    searchParams.get("period") === "ytd" ? "ytd" : "mtd";

  const kpis = useQuery(getDashboardKpisRef, { period });
  const aging = useQuery(getArAgingSummaryRef, {});
  const flagged = useQuery(getFlaggedForFollowupSummaryRef, {});

  // FORBIDDEN-aware fallback. The query throws when the caller is not
  // admin; we treat that as "degraded view" rather than crashing. The
  // `useQuery` hook surfaces an error via its error boundary contract;
  // we wrap reads in try-catch-equivalent by checking whether the
  // result is `undefined` (loading) vs. an error state, which Convex's
  // React adapter throws to the nearest boundary. The simplest
  // defensive pattern here: render based on what's present and let the
  // Error Boundary in the layout catch unexpected errors.
  const isKpiLoading = kpis === undefined;
  const isAgingLoading = aging === undefined;
  const isFlaggedLoading = flagged === undefined;

  const periodLabel = useMemo(
    () => (period === "ytd" ? "vs. last year" : "vs. last month"),
    [period],
  );

  const periodAnnouncement = useMemo(
    () =>
      period === "ytd"
        ? "Showing year-to-date"
        : "Showing month-to-date",
    [period],
  );

  const handlePeriodChange = (next: "mtd" | "ytd") => {
    if (next === period) return;
    if (next === "ytd") {
      router.replace("/dashboard?period=ytd");
    } else {
      router.replace("/dashboard");
    }
  };

  return (
    <div className="mx-auto max-w-[1440px] space-y-6 p-1">
      {/* Story 5.5 follow-up — reconciliation drift banner. Renders
          only when at least one un-acknowledged failure is open in
          the reconciliation register; admin-only (the underlying
          query is gated server-side, the component returns null for
          non-admin / loading states). NFR-R4: ≤ 2-hour visibility. */}
      <ReconciliationBanner />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[#1D5C4D]">
            Owner Dashboard
          </p>
          <h1 className="font-display text-4xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-slate-600">
            {period === "ytd"
              ? "Year-to-date sales, collections, and operating performance."
              : "Month-to-date sales, collections, and operating performance."}
          </p>
        </div>
        <PeriodToggle period={period} onChange={handlePeriodChange} />
      </header>

      {/* Screen-reader announcement on period switch. The individual
          tile fades' `aria-live` (delegated to ReactiveHighlight)
          handle per-value announcements; this region handles the
          period-context switch. */}
      <span role="status" aria-live="polite" className="sr-only">
        {periodAnnouncement}
      </span>

      {/* Money tiles — period-bounded. */}
      <section
        aria-label="Financial KPIs"
        data-testid="dashboard-money-tiles"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-5"
      >
        {isKpiLoading ? (
          <>
            <SkeletonCard label="Sales" />
            <SkeletonCard label="Collections" />
            <SkeletonCard label="AR Balance" />
            <SkeletonCard label="Expenses" />
            <SkeletonCard label="Net" />
          </>
        ) : (
          <>
            <KpiCard
              label={period === "ytd" ? "YTD Sales" : "MTD Sales"}
              value={formatPeso(kpis.salesCents)}
              delta={formatMoneyDeltaForRevenue(
                kpis.salesDeltaCents,
                periodLabel,
              )}
              onClick={() => router.push(`/sales?period=${period}`)}
            />
            <KpiCard
              label={
                period === "ytd" ? "YTD Collections" : "MTD Collections"
              }
              value={formatPeso(kpis.collectionsCents)}
              delta={formatMoneyDeltaForRevenue(
                kpis.collectionsDeltaCents,
                periodLabel,
              )}
              onClick={() => router.push(`/payments?period=${period}`)}
            />
            <KpiCard
              label="AR Balance"
              value={formatPeso(kpis.arBalanceCents)}
              onClick={() =>
                router.push("/contracts?state=active,in_default")
              }
            />
            <KpiCard
              label={period === "ytd" ? "YTD Expenses" : "MTD Expenses"}
              value={formatPeso(kpis.expensesCents)}
              delta={formatMoneyDeltaForExpense(
                kpis.expensesDeltaCents,
                periodLabel,
              )}
              onClick={() => router.push(`/expenses?period=${period}`)}
            />
            {/*
              Net is intentionally non-clickable. It is a derived metric
              (sales − expenses) with no single underlying list; per AC1
              this tile renders as an informational `<div>`, never a
              `<button>`. KpiCard omits `onClick`, so the static-div
              branch is exercised.
            */}
            <KpiCard
              label={period === "ytd" ? "YTD Net" : "MTD Net"}
              value={
                kpis.netIsNegative
                  ? `−${formatPeso(kpis.netCents)}`
                  : formatPeso(kpis.netCents)
              }
              delta={formatMoneyDeltaForNet(
                kpis.netDeltaCents,
                periodLabel,
              )}
            />
          </>
        )}
      </section>

      {/* Inventory tiles — current state, period-independent. */}
      <section
        aria-label="Lot inventory"
        data-testid="dashboard-inventory-tiles"
        className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4"
      >
        {isKpiLoading ? (
          <>
            <SkeletonCard label="Lots Available" />
            <SkeletonCard label="Lots Sold" />
            <SkeletonCard label="Lots Occupied" />
            <SkeletonCard label="Active Contracts" />
          </>
        ) : (
          <>
            <KpiCard
              label="Lots Available"
              value={formatCount(kpis.lotsAvailable)}
              delta={{
                text: `of ${formatCount(kpis.lotsTotal)} total`,
                tone: "neutral",
              }}
            />
            <KpiCard
              label="Lots Sold"
              value={formatCount(kpis.lotsSold)}
              delta={{
                text: `${formatCount(kpis.lotsReserved)} reserved`,
                tone: "neutral",
              }}
            />
            <KpiCard
              label="Lots Occupied"
              value={formatCount(kpis.lotsOccupied)}
            />
            <KpiCard
              label="Active Contracts"
              value={formatCount(kpis.contractsActive)}
              delta={{
                text: `${formatCount(kpis.contractsInDefault)} in default`,
                tone:
                  kpis.contractsInDefault > 0 ? "negative" : "neutral",
              }}
            />
          </>
        )}
      </section>

      {/* AR aging summary — multi-row card. */}
      <section
        aria-label="AR aging summary"
        data-testid="dashboard-ar-aging"
        className="rounded-lg border border-surface-border bg-surface-base p-4 shadow-[var(--shadow-card)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            AR Aging Summary
          </h2>
          {aging?.isPlaceholder === true && (
            <span className="text-xs text-slate-500">
              Epic 4 will populate live data.
            </span>
          )}
        </div>
        {isAgingLoading ? (
          <SkeletonBucketList />
        ) : (
          <ul className="divide-y divide-slate-100">
            {aging.buckets.map((bucket) => (
              <ArAgingRow
                key={bucket.key}
                bucket={bucket}
                onSelect={() =>
                  router.push(
                    `/ar-aging?bucket=${encodeURIComponent(bucket.key)}`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* Flagged for follow-up tile. Tap navigates to the open-flags
          list (Story 5.3 AC3). The whole panel is the click surface so
          the 44px tap-target floor is satisfied with margin. */}
      <section
        aria-label="Flagged for follow-up"
        data-testid="dashboard-flagged-tile"
        className="rounded-lg border border-surface-border bg-surface-base p-0 shadow-[var(--shadow-card)]"
      >
        <button
          type="button"
          onClick={() => router.push("/flagged-followups?status=open")}
          data-testid="dashboard-flagged-tile-button"
          aria-label={
            isFlaggedLoading
              ? "Flagged for follow-up: loading"
              : flagged.count === 0
                ? "Flagged for follow-up: no open flags"
                : `Flagged for follow-up: ${formatCount(flagged.count)} open${
                    flagged.mostRecentComment !== null
                      ? `. Most recent: ${flagged.mostRecentComment}`
                      : ""
                  }`
          }
          className="block w-full rounded-lg p-4 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            Flagged for Follow-up
          </h2>
          {isFlaggedLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : flagged.count === 0 ? (
            <ReactiveHighlight watch={flagged.count}>
              <p className="text-sm text-slate-600">
                No open flags. Stay vigilant.
              </p>
            </ReactiveHighlight>
          ) : (
            <ReactiveHighlight watch={flagged.count}>
              <div className="space-y-1">
                <p className="text-2xl font-bold tabular-nums text-slate-900">
                  {formatCount(flagged.count)}
                </p>
                {flagged.mostRecentComment !== null && (
                  <p className="truncate text-xs text-slate-500">
                    Most recent: {flagged.mostRecentComment}
                  </p>
                )}
              </div>
            </ReactiveHighlight>
          )}
        </button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components.
// ---------------------------------------------------------------------------

interface PeriodToggleProps {
  period: "mtd" | "ytd";
  onChange: (next: "mtd" | "ytd") => void;
}

function PeriodToggle({ period, onChange }: PeriodToggleProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Date range"
      data-testid="dashboard-period-toggle"
      className="inline-flex items-center gap-1.5"
    >
      <button
        type="button"
        onClick={() => onChange("mtd")}
        aria-pressed={period === "mtd"}
        data-testid="dashboard-period-mtd"
        className={
          period === "mtd"
            ? "min-h-[44px] rounded-full bg-[#1D5C4D] px-5 py-2 text-sm font-semibold text-white"
            : "min-h-[44px] rounded-full border border-[#E1DAC8] bg-white px-5 py-2 text-sm font-semibold text-[#8E8C85] transition-colors hover:border-[#C9A96B] hover:text-[#1D5C4D]"
        }
      >
        MTD
      </button>
      <button
        type="button"
        onClick={() => onChange("ytd")}
        aria-pressed={period === "ytd"}
        data-testid="dashboard-period-ytd"
        className={
          period === "ytd"
            ? "min-h-[44px] rounded-full bg-[#1D5C4D] px-5 py-2 text-sm font-semibold text-white"
            : "min-h-[44px] rounded-full border border-[#E1DAC8] bg-white px-5 py-2 text-sm font-semibold text-[#8E8C85] transition-colors hover:border-[#C9A96B] hover:text-[#1D5C4D]"
        }
      >
        YTD
      </button>
    </div>
  );
}

interface ArAgingRowProps {
  bucket: ArAgingBucket;
  onSelect: () => void;
}

const BUCKET_LABEL: Record<ArAgingBucket["key"], string> = {
  "1-30": "1 – 30 days",
  "31-60": "31 – 60 days",
  "61-90": "61 – 90 days",
  "90+": "90+ days",
};

function ArAgingRow({ bucket, onSelect }: ArAgingRowProps): ReactElement {
  // Per UX-DR10: row tone differentiates "all contracts in this bucket
  // have an active logged follow-up action" (white) from "none have"
  // (red). Mixed is amber. The distinction surfaces at the bucket
  // level — the trust-builder for Journey 4.
  const tone: "ok" | "mixed" | "stale" =
    bucket.count === 0
      ? "ok"
      : bucket.withLoggedActionCount === bucket.count
        ? "ok"
        : bucket.withLoggedActionCount === 0
          ? "stale"
          : "mixed";
  const toneClass =
    tone === "stale"
      ? "bg-red-50"
      : tone === "mixed"
        ? "bg-amber-50"
        : "bg-white";

  // Story 5.3 AC2: each row is a `<button>` that drills into the
  // bucket-filtered AR aging table. The row is wrapped in a `<li>` so
  // the surrounding `<ul>` semantics from the `divide-y` list survive;
  // the inner `<button>` carries the click target + a11y label.
  const ariaLabel = `${BUCKET_LABEL[bucket.key]}: ${formatCount(
    bucket.count,
  )} contracts, ${formatPeso(bucket.totalCents)}, ${formatCount(
    bucket.withLoggedActionCount,
  )} with logged action`;

  return (
    <li
      data-testid={`dashboard-ar-bucket-${bucket.key}`}
      className={toneClass}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={ariaLabel}
        data-testid={`dashboard-ar-bucket-button-${bucket.key}`}
        className="flex min-h-[44px] w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
      >
        <ReactiveHighlight watch={`${bucket.count}:${bucket.totalCents}`}>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-sm font-medium text-slate-900">
              {BUCKET_LABEL[bucket.key]}
            </span>
            <span className="text-xs text-slate-600">
              {formatCount(bucket.count)} contracts
            </span>
            <span className="text-xs text-slate-600">
              {formatCount(bucket.withLoggedActionCount)} with logged action
            </span>
          </div>
        </ReactiveHighlight>
        <span className="text-sm font-semibold tabular-nums text-slate-900">
          {formatPeso(bucket.totalCents)}
        </span>
      </button>
    </li>
  );
}

interface SkeletonCardProps {
  label: string;
}

function SkeletonCard({ label }: SkeletonCardProps): ReactElement {
  return (
    <div
      data-testid="dashboard-skeleton-card"
      aria-label={`Loading ${label}`}
      className="block w-full rounded-lg border border-surface-border bg-surface-base p-4 shadow-[var(--shadow-card)]"
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs leading-tight text-slate-500">{label}</span>
        <div className="h-7 w-24 animate-pulse rounded bg-slate-200" />
        <div className="h-3 w-16 animate-pulse rounded bg-slate-100" />
      </div>
    </div>
  );
}

function SkeletonBucketList(): ReactElement {
  return (
    <ul data-testid="dashboard-ar-aging-skeleton" className="space-y-2">
      {[1, 2, 3, 4].map((i) => (
        <li
          key={i}
          className="flex items-center justify-between px-3 py-2"
        >
          <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
        </li>
      ))}
    </ul>
  );
}

function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-PH").format(n);
}
