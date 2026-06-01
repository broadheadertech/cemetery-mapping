"use client";

/**
 * TrendChart — Story 9.9 (FR48).
 *
 * Pure-SVG presentational chart that renders the trailing-12-month
 * sales / collections / expenses / net series produced by
 * `convex/trends.ts → getTrendData`. We deliberately avoid Recharts,
 * Chart.js, D3, and friends:
 *
 *   1. Bundle size — Phase 1 budget is tight; a 12-bucket chart with
 *      no zooming / panning / per-point drag does not justify a
 *      ≥ 80 KB dependency.
 *   2. NFR-A2 compliance — we control every visual encoding (color +
 *      shape + line-style + numeric label) directly in SVG so a
 *      colorblind audit reads the same source the test asserts on.
 *   3. SSR-friendliness — an SVG tree renders identically on the
 *      Next.js server and the React client without dynamic-import
 *      gymnastics.
 *
 * The chart is a multi-series LINE chart with explicit per-series
 * shape markers and a numeric data table fallback that doubles as the
 * screen-reader affordance (story Task 9 "View as table"). Both
 * representations stay mounted; the toggle controls a `hidden`
 * attribute so a keyboard user can flip back and forth without losing
 * focus context.
 *
 * Pure presentational — no Convex hooks here. The hosting page wires
 * `useQuery(api.trends.getTrendData)` and passes the resulting
 * buckets in. This keeps the component testable with hand-rolled
 * fixtures.
 */

import { useMemo, useState } from "react";

import { formatPeso } from "@/lib/money";

/**
 * One bucket as fed to the chart. Mirrors `TrendBucket` from
 * `convex/trends.ts` but kept narrow so the client component is not
 * coupled to the server module's full type.
 */
export interface TrendChartBucket {
  monthLabel: string; // "YYYY-MM"
  startMs: number;
  endMs: number;
  salesCents: number;
  collectionsCents: number;
  expensesCents: number;
  netCents: number;
}

/**
 * Series-key union — keep this list closed so a future
 * "arBalance" series is a deliberate extension and not a string
 * sprinkled into consumers.
 */
export type TrendSeriesKey =
  | "sales"
  | "collections"
  | "expenses"
  | "net";

interface SeriesStyle {
  key: TrendSeriesKey;
  label: string;
  /** Token-class color for the stroke + marker fill. */
  strokeColor: string;
  /** SVG marker shape — one of "circle" / "square" / "triangle" / "diamond". */
  marker: "circle" | "square" | "triangle" | "diamond";
  /** SVG `stroke-dasharray` value — empty string for solid. */
  dashArray: string;
}

/**
 * Colorblind-safe palette derived from the Okabe-Ito 8-color set
 * referenced by the story spec. Each series pairs a distinct hue with
 * a distinct shape + line style so a deuteranope / protanope can
 * still tell them apart by shape alone (NFR-A2).
 *
 *   - sales       — Okabe-Ito vermillion #D55E00, circle, solid
 *   - collections — Okabe-Ito blue       #0072B2, square, dashed
 *   - expenses    — Okabe-Ito orange     #E69F00, triangle, dotted
 *   - net         — Okabe-Ito bluish-grn #009E73, diamond, dash-dot
 */
const SERIES_STYLES: ReadonlyArray<SeriesStyle> = [
  {
    key: "sales",
    label: "Sales",
    strokeColor: "#D55E00",
    marker: "circle",
    dashArray: "",
  },
  {
    key: "collections",
    label: "Collections",
    strokeColor: "#0072B2",
    marker: "square",
    dashArray: "6 4",
  },
  {
    key: "expenses",
    label: "Expenses",
    strokeColor: "#E69F00",
    marker: "triangle",
    dashArray: "2 4",
  },
  {
    key: "net",
    label: "Net (collections − expenses)",
    strokeColor: "#009E73",
    marker: "diamond",
    dashArray: "8 3 2 3",
  },
];

export interface TrendChartProps {
  /** 12 buckets oldest → newest. Undefined renders the loading skeleton. */
  buckets: ReadonlyArray<TrendChartBucket> | undefined;
  /**
   * Optional CSS class hook for the wrapper — the page composes
   * surrounding chrome (card border, padding, etc.) and the chart
   * fills its container.
   */
  className?: string;
}

const CHART_VIEWBOX_WIDTH = 720;
const CHART_VIEWBOX_HEIGHT = 320;
const CHART_PADDING_LEFT = 64;
const CHART_PADDING_RIGHT = 16;
const CHART_PADDING_TOP = 16;
const CHART_PADDING_BOTTOM = 48;

/**
 * Renders the multi-series trend chart + the screen-reader-friendly
 * fallback table. Both representations stay mounted; the toggle
 * controls `hidden`.
 */
export function TrendChart({ buckets, className }: TrendChartProps) {
  const [showTable, setShowTable] = useState(false);

  const isLoading = buckets === undefined;
  const isEmpty = !isLoading && buckets.length === 0;

  // Compute the y-axis scale based on the max absolute value across
  // every visible series. Net can be negative, so we include the
  // signed extremes when computing the scale.
  const yScale = useMemo(() => {
    if (isLoading || isEmpty) {
      return { min: 0, max: 0, span: 1 };
    }
    let min = 0;
    let max = 0;
    for (const b of buckets!) {
      max = Math.max(max, b.salesCents, b.collectionsCents, b.expensesCents);
      max = Math.max(max, b.netCents);
      min = Math.min(min, b.netCents);
    }
    // Pad the top 5% so markers never clip against the upper edge.
    max = Math.ceil(max * 1.05);
    if (min < 0) {
      min = Math.floor(min * 1.05);
    }
    const span = Math.max(1, max - min);
    return { min, max, span };
  }, [buckets, isLoading, isEmpty]);

  const innerWidth =
    CHART_VIEWBOX_WIDTH - CHART_PADDING_LEFT - CHART_PADDING_RIGHT;
  const innerHeight =
    CHART_VIEWBOX_HEIGHT - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;

  const xForIndex = (i: number, total: number): number => {
    if (total <= 1) {
      return CHART_PADDING_LEFT + innerWidth / 2;
    }
    return CHART_PADDING_LEFT + (innerWidth * i) / (total - 1);
  };
  const yForCents = (cents: number): number => {
    // Map `cents` into chart coords, with `max` at the top of the
    // inner area and `min` at the bottom. When `min === 0` the
    // origin sits flush with the x-axis baseline.
    const t = (cents - yScale.min) / yScale.span;
    return CHART_PADDING_TOP + innerHeight - t * innerHeight;
  };

  return (
    <div
      className={className ?? ""}
      data-testid="trend-chart"
      data-loading={isLoading ? "true" : "false"}
      data-empty={isEmpty ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <Legend />
        <button
          type="button"
          onClick={() => setShowTable((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-pressed={showTable}
          data-testid="trend-chart-table-toggle"
        >
          {showTable ? "Show chart" : "View as table"}
        </button>
      </div>

      <div hidden={showTable} aria-hidden={showTable ? "true" : "false"}>
        {isLoading ? (
          <SkeletonChart />
        ) : isEmpty ? (
          <EmptyState />
        ) : (
          <svg
            viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
            role="img"
            aria-label="Twelve-month trend of sales, collections, expenses, and net cash flow"
            data-testid="trend-chart-svg"
            className="w-full h-auto"
          >
            <YAxis
              minCents={yScale.min}
              maxCents={yScale.max}
              padTop={CHART_PADDING_TOP}
              padLeft={CHART_PADDING_LEFT}
              innerHeight={innerHeight}
              innerWidth={innerWidth}
            />
            <XAxis
              buckets={buckets!}
              padBottom={CHART_PADDING_BOTTOM}
              padTop={CHART_PADDING_TOP}
              innerHeight={innerHeight}
              xForIndex={(i) => xForIndex(i, buckets!.length)}
            />
            {/* Zero baseline — visible when min < 0 so net can dip
                below it without losing the eye's reference point. */}
            {yScale.min < 0 && (
              <line
                x1={CHART_PADDING_LEFT}
                x2={CHART_PADDING_LEFT + innerWidth}
                y1={yForCents(0)}
                y2={yForCents(0)}
                stroke="#94a3b8"
                strokeDasharray="2 2"
                strokeWidth={1}
                data-testid="trend-chart-zero-baseline"
              />
            )}
            {SERIES_STYLES.map((series) => (
              <Series
                key={series.key}
                series={series}
                buckets={buckets!}
                xForIndex={(i) => xForIndex(i, buckets!.length)}
                yForCents={yForCents}
              />
            ))}
          </svg>
        )}
      </div>

      <div hidden={!showTable} aria-hidden={showTable ? "false" : "true"}>
        <DataTable buckets={buckets} />
      </div>
    </div>
  );
}

function Legend() {
  return (
    <ul
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
      data-testid="trend-chart-legend"
      aria-label="Chart legend"
    >
      {SERIES_STYLES.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <svg
            width={20}
            height={12}
            viewBox="0 0 20 12"
            aria-hidden="true"
            data-testid={`trend-chart-legend-swatch-${s.key}`}
          >
            <line
              x1={0}
              y1={6}
              x2={20}
              y2={6}
              stroke={s.strokeColor}
              strokeWidth={2}
              strokeDasharray={s.dashArray}
            />
            <Marker
              shape={s.marker}
              cx={10}
              cy={6}
              size={5}
              color={s.strokeColor}
            />
          </svg>
          <span className="text-slate-700">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

function YAxis({
  minCents,
  maxCents,
  padTop,
  padLeft,
  innerHeight,
  innerWidth,
}: {
  minCents: number;
  maxCents: number;
  padTop: number;
  padLeft: number;
  innerHeight: number;
  innerWidth: number;
}) {
  // Five horizontal gridlines including the top + bottom edges. Each
  // tick carries its peso-formatted label.
  const ticks = 5;
  const step = (maxCents - minCents) / (ticks - 1);
  return (
    <g data-testid="trend-chart-y-axis">
      {Array.from({ length: ticks }).map((_, i) => {
        const value = minCents + step * i;
        const y = padTop + innerHeight - ((value - minCents) * innerHeight) / Math.max(1, maxCents - minCents);
        return (
          <g key={i}>
            <line
              x1={padLeft}
              x2={padLeft + innerWidth}
              y1={y}
              y2={y}
              stroke="#e2e8f0"
              strokeWidth={1}
            />
            <text
              x={padLeft - 8}
              y={y + 4}
              fontSize={11}
              textAnchor="end"
              fill="#475569"
            >
              {formatPeso(Math.round(value))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function XAxis({
  buckets,
  padBottom,
  padTop,
  innerHeight,
  xForIndex,
}: {
  buckets: ReadonlyArray<TrendChartBucket>;
  padBottom: number;
  padTop: number;
  innerHeight: number;
  xForIndex: (i: number) => number;
}) {
  const y = padTop + innerHeight;
  return (
    <g data-testid="trend-chart-x-axis">
      {buckets.map((b, i) => {
        const x = xForIndex(i);
        return (
          <g key={b.monthLabel}>
            <line x1={x} x2={x} y1={padTop} y2={y} stroke="#f1f5f9" />
            <text
              x={x}
              y={y + 16}
              fontSize={11}
              textAnchor="middle"
              fill="#475569"
            >
              {formatMonthShort(b.monthLabel)}
            </text>
          </g>
        );
      })}
      {/* Axis baseline. */}
      <line
        x1={xForIndex(0)}
        x2={xForIndex(buckets.length - 1)}
        y1={y}
        y2={y}
        stroke="#cbd5e1"
        strokeWidth={1}
      />
      {/* SR-only x-axis label so the chart is self-describing for
          assistive tech that walks the SVG. */}
      <text
        x={xForIndex(Math.floor((buckets.length - 1) / 2))}
        y={y + 32}
        fontSize={11}
        textAnchor="middle"
        fill="#64748b"
        data-testid="trend-chart-x-axis-caption"
      >
        Trailing 12 months (Asia/Manila)
      </text>
      <text x={0} y={padBottom - 1000} className="sr-only" aria-hidden="true">
        Month
      </text>
    </g>
  );
}

function Series({
  series,
  buckets,
  xForIndex,
  yForCents,
}: {
  series: SeriesStyle;
  buckets: ReadonlyArray<TrendChartBucket>;
  xForIndex: (i: number) => number;
  yForCents: (cents: number) => number;
}) {
  const points = buckets.map((b, i) => {
    const cents = readCents(b, series.key);
    return { x: xForIndex(i), y: yForCents(cents), cents, b };
  });
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
    .join(" ");
  return (
    <g
      data-testid={`trend-chart-series-${series.key}`}
      data-stroke-dasharray={series.dashArray}
    >
      <path
        d={path}
        fill="none"
        stroke={series.strokeColor}
        strokeWidth={2}
        strokeDasharray={series.dashArray || undefined}
      />
      {points.map((p, i) => (
        <g key={i}>
          <Marker
            shape={series.marker}
            cx={p.x}
            cy={p.y}
            size={4}
            color={series.strokeColor}
          />
          <title>{`${series.label}: ${formatPeso(p.cents)} (${formatMonthShort(p.b.monthLabel)})`}</title>
        </g>
      ))}
    </g>
  );
}

function Marker({
  shape,
  cx,
  cy,
  size,
  color,
}: {
  shape: SeriesStyle["marker"];
  cx: number;
  cy: number;
  size: number;
  color: string;
}) {
  if (shape === "circle") {
    return <circle cx={cx} cy={cy} r={size} fill={color} />;
  }
  if (shape === "square") {
    return (
      <rect
        x={cx - size}
        y={cy - size}
        width={size * 2}
        height={size * 2}
        fill={color}
      />
    );
  }
  if (shape === "triangle") {
    const half = size + 1;
    const points = `${cx},${cy - half} ${cx - half},${cy + half} ${cx + half},${cy + half}`;
    return <polygon points={points} fill={color} />;
  }
  // diamond
  const d = size + 1;
  const points = `${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}`;
  return <polygon points={points} fill={color} />;
}

function SkeletonChart() {
  // Lightweight 16:7 placeholder rectangle with a pulsing tint —
  // matches the visual rhythm of other dashboard skeletons.
  return (
    <div
      role="status"
      aria-label="Loading trend data"
      data-testid="trend-chart-skeleton"
      className="w-full aspect-[16/7] animate-pulse rounded-md bg-slate-100"
    />
  );
}

function EmptyState() {
  return (
    <div
      data-testid="trend-chart-empty"
      className="w-full rounded-md border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600"
    >
      No financial activity in the last 12 months.
    </div>
  );
}

function DataTable({
  buckets,
}: {
  buckets: ReadonlyArray<TrendChartBucket> | undefined;
}) {
  if (buckets === undefined) {
    return (
      <div
        role="status"
        aria-label="Loading trend data"
        className="w-full rounded-md bg-slate-100 p-6 text-sm text-slate-500"
        data-testid="trend-chart-table-loading"
      >
        Loading…
      </div>
    );
  }
  if (buckets.length === 0) {
    return (
      <p
        data-testid="trend-chart-table-empty"
        className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-sm text-slate-600"
      >
        No financial activity in the last 12 months.
      </p>
    );
  }
  return (
    <div
      className="overflow-x-auto"
      data-testid="trend-chart-table-wrapper"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Trailing 12-month trend: sales, collections, expenses, and net
          per Manila calendar month.
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-600">
            <th scope="col" className="px-2 py-2 font-medium">
              Month
            </th>
            {SERIES_STYLES.map((s) => (
              <th
                key={s.key}
                scope="col"
                className="px-2 py-2 font-medium text-right"
              >
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => (
            <tr
              key={b.monthLabel}
              className="border-b border-slate-100"
              data-testid={`trend-chart-table-row-${b.monthLabel}`}
            >
              <th scope="row" className="px-2 py-2 font-medium text-slate-700">
                {formatMonthShort(b.monthLabel)}
              </th>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatPeso(b.salesCents)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatPeso(b.collectionsCents)}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatPeso(b.expensesCents)}
              </td>
              <td
                className="px-2 py-2 text-right tabular-nums"
                data-net-sign={b.netCents < 0 ? "negative" : "positive"}
              >
                {formatPeso(b.netCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function readCents(b: TrendChartBucket, key: TrendSeriesKey): number {
  if (key === "sales") return b.salesCents;
  if (key === "collections") return b.collectionsCents;
  if (key === "expenses") return b.expensesCents;
  return b.netCents;
}

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
});

function formatMonthShort(monthLabel: string): string {
  // "2026-05" → "May 2026" via Intl (anchored to Manila so the label
  // matches the bucket's timezone semantics).
  const m = monthLabel.match(/^(\d{4})-(\d{2})$/);
  if (m === null) return monthLabel;
  const iso = `${m[1]}-${m[2]}-15T12:00:00+08:00`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return monthLabel;
  return MONTH_LABEL_FORMATTER.format(new Date(ms));
}
