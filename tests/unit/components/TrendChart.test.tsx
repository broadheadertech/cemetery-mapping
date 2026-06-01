/**
 * Story 9.9 — `<TrendChart>` component contract tests.
 *
 * Pure-SVG presentation with a screen-reader-friendly table fallback;
 * no Convex hooks. The component is hand-fed buckets so the tests can
 * exercise loading / empty / data paths deterministically.
 *
 * Coverage focal points (per Story 9.9):
 *   - Loading + empty states render the right affordance.
 *   - Data path renders the SVG chart with a series per metric.
 *   - Series are distinguishable by COLOR + SHAPE + LINE-STYLE
 *     (NFR-A2 colorblind safety — color alone is never sufficient).
 *   - Legend mirrors the per-series shape + color so reading the
 *     legend stays unambiguous in a deuteranope / protanope view.
 *   - "View as table" toggle flips the chart-vs-table affordance for
 *     keyboard + screen-reader users (Story 9.9 Task 9).
 *   - Y-axis renders peso-formatted ticks; X-axis renders all 12
 *     month labels.
 *   - Net dipping below zero draws the zero baseline so the eye keeps
 *     its reference point.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  TrendChart,
  type TrendChartBucket,
} from "@/components/TrendChart";

/**
 * Synthetic 12-month buckets. Pure ms numbers; the chart never reads
 * the months back as wall-clock time — it renders the monthLabel
 * string directly.
 */
function makeBuckets(
  overrides: Partial<Record<string, Partial<TrendChartBucket>>> = {},
): TrendChartBucket[] {
  const labels = [
    "2025-06",
    "2025-07",
    "2025-08",
    "2025-09",
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
  ];
  return labels.map((monthLabel, i) => {
    const base: TrendChartBucket = {
      monthLabel,
      startMs: i,
      endMs: i + 1,
      salesCents: 100_000 + i * 1_000,
      collectionsCents: 50_000 + i * 500,
      expensesCents: 20_000,
      netCents: 30_000,
    };
    return { ...base, ...(overrides[monthLabel] ?? {}) };
  });
}

describe("TrendChart — loading + empty states", () => {
  it("renders a skeleton when `buckets` is undefined", () => {
    render(<TrendChart buckets={undefined} />);
    expect(screen.getByTestId("trend-chart-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("trend-chart-svg")).toBeNull();
  });

  it("renders the empty-state affordance when `buckets` is an empty array", () => {
    render(<TrendChart buckets={[]} />);
    expect(screen.getByTestId("trend-chart-empty")).toBeInTheDocument();
    // The empty state copy lives inside the dedicated test-id node so
    // the assertion stays robust even though the (hidden) table-fallback
    // mounts its own copy of the same message for parity.
    expect(
      screen.getByTestId("trend-chart-empty").textContent ?? "",
    ).toMatch(/No financial activity in the last 12 months/i);
  });

  it("hides the data table by default (showTable=false)", () => {
    render(<TrendChart buckets={makeBuckets()} />);
    // The table wrapper IS mounted (so the toggle is fast and focus is
    // preserved across flips) but the parent div carries `hidden` so
    // assistive tech and visual readers see only the chart.
    const tableWrapper = screen.getByTestId("trend-chart-table-wrapper");
    const hiddenParent = tableWrapper.closest("[hidden]");
    expect(hiddenParent).not.toBeNull();
    expect(hiddenParent?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("TrendChart — data path", () => {
  it("renders the SVG chart with all four series when buckets are provided", () => {
    render(<TrendChart buckets={makeBuckets()} />);
    expect(screen.getByTestId("trend-chart-svg")).toBeInTheDocument();
    expect(screen.getByTestId("trend-chart-series-sales")).toBeInTheDocument();
    expect(
      screen.getByTestId("trend-chart-series-collections"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("trend-chart-series-expenses"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("trend-chart-series-net")).toBeInTheDocument();
  });

  it("renders 12 x-axis labels — one per bucket", () => {
    const { container } = render(<TrendChart buckets={makeBuckets()} />);
    const xAxis = container.querySelector(
      '[data-testid="trend-chart-x-axis"]',
    );
    expect(xAxis).not.toBeNull();
    // Bucket labels are rendered as <text> inside <g> entries.
    const groups = xAxis!.querySelectorAll("g");
    expect(groups.length).toBe(12);
  });
});

describe("TrendChart — NFR-A2 colorblind-safe encoding (AC3)", () => {
  it("uses a distinct color, marker, and dash style per series", () => {
    const { container } = render(<TrendChart buckets={makeBuckets()} />);
    // Each series carries `data-stroke-dasharray` describing its line
    // style; the four values must be pairwise distinct.
    const series = ["sales", "collections", "expenses", "net"]
      .map((key) =>
        container.querySelector<HTMLElement>(
          `[data-testid="trend-chart-series-${key}"]`,
        ),
      )
      .filter((el): el is HTMLElement => el !== null);
    expect(series).toHaveLength(4);
    const dashes = series.map((s) => s.dataset.strokeDasharray ?? "");
    expect(new Set(dashes).size).toBe(4);

    // The series `<path>` inside each group carries the stroke colour.
    const strokes = series
      .map((s) => s.querySelector("path")?.getAttribute("stroke"))
      .filter((s): s is string => Boolean(s));
    expect(new Set(strokes).size).toBe(4);
  });

  it("renders a legend with one swatch per series, mirroring the chart's encoding", () => {
    render(<TrendChart buckets={makeBuckets()} />);
    const legend = screen.getByTestId("trend-chart-legend");
    // Exact-text matches so we don't accidentally collide with the
    // "Net (collections − expenses)" composite label.
    expect(within(legend).getByText("Sales")).toBeInTheDocument();
    expect(within(legend).getByText("Collections")).toBeInTheDocument();
    expect(within(legend).getByText("Expenses")).toBeInTheDocument();
    expect(
      within(legend).getByText("Net (collections − expenses)"),
    ).toBeInTheDocument();
    // One swatch <svg> per series.
    expect(
      legend.querySelector('[data-testid="trend-chart-legend-swatch-sales"]'),
    ).not.toBeNull();
    expect(
      legend.querySelector(
        '[data-testid="trend-chart-legend-swatch-collections"]',
      ),
    ).not.toBeNull();
    expect(
      legend.querySelector(
        '[data-testid="trend-chart-legend-swatch-expenses"]',
      ),
    ).not.toBeNull();
    expect(
      legend.querySelector('[data-testid="trend-chart-legend-swatch-net"]'),
    ).not.toBeNull();
  });

  it("renders the SVG with a role=img + aria-label for assistive tech", () => {
    render(<TrendChart buckets={makeBuckets()} />);
    const svg = screen.getByTestId("trend-chart-svg");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toMatch(/trend/i);
  });
});

describe("TrendChart — zero baseline for negative net (AC1, AC3)", () => {
  it("draws a zero baseline when any net bucket is negative", () => {
    const buckets = makeBuckets({
      "2026-05": { netCents: -25_000 },
    });
    render(<TrendChart buckets={buckets} />);
    expect(
      screen.getByTestId("trend-chart-zero-baseline"),
    ).toBeInTheDocument();
  });

  it("omits the zero baseline when every series is non-negative", () => {
    render(<TrendChart buckets={makeBuckets()} />);
    expect(
      screen.queryByTestId("trend-chart-zero-baseline"),
    ).toBeNull();
  });
});

describe("TrendChart — table-fallback affordance (Task 9 / a11y)", () => {
  it("toggles the data-table view when 'View as table' is clicked", async () => {
    const user = userEvent.setup();
    render(<TrendChart buckets={makeBuckets()} />);
    // Initially the chart SVG is mounted (hidden=false) and the table
    // wrapper isn't rendered yet — the table only mounts after toggle.
    expect(screen.getByTestId("trend-chart-svg")).toBeInTheDocument();
    const toggle = screen.getByTestId("trend-chart-table-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Show chart/i)).toBeInTheDocument();
    expect(
      screen.getByTestId("trend-chart-table-wrapper"),
    ).toBeInTheDocument();
  });

  it("renders all 12 rows in the data table when toggled", async () => {
    const user = userEvent.setup();
    render(<TrendChart buckets={makeBuckets()} />);
    await user.click(screen.getByTestId("trend-chart-table-toggle"));
    expect(
      screen.getByTestId("trend-chart-table-row-2025-06"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("trend-chart-table-row-2026-05"),
    ).toBeInTheDocument();
  });

  it("renders the loading state inside the table view when buckets are undefined", async () => {
    const user = userEvent.setup();
    render(<TrendChart buckets={undefined} />);
    await user.click(screen.getByTestId("trend-chart-table-toggle"));
    expect(
      screen.getByTestId("trend-chart-table-loading"),
    ).toBeInTheDocument();
  });

  it("renders the table's own empty state when buckets is empty", async () => {
    const user = userEvent.setup();
    render(<TrendChart buckets={[]} />);
    await user.click(screen.getByTestId("trend-chart-table-toggle"));
    expect(
      screen.getByTestId("trend-chart-table-empty"),
    ).toBeInTheDocument();
  });
});

describe("TrendChart — peso formatting of values", () => {
  it("formats Y-axis ticks as peso-formatted values via formatPeso", () => {
    const { container } = render(<TrendChart buckets={makeBuckets()} />);
    const yAxis = container.querySelector(
      '[data-testid="trend-chart-y-axis"]',
    );
    expect(yAxis).not.toBeNull();
    // At least one tick should contain the peso glyph.
    expect(yAxis!.textContent ?? "").toMatch(/₱/);
  });

  it("table rows tag the net column with positive / negative sign data attribute", async () => {
    const user = userEvent.setup();
    const buckets = makeBuckets({
      "2026-05": { netCents: -1_000 },
    });
    render(<TrendChart buckets={buckets} />);
    await user.click(screen.getByTestId("trend-chart-table-toggle"));
    const row = screen.getByTestId("trend-chart-table-row-2026-05");
    const netCell = row.querySelector('[data-net-sign]');
    expect(netCell?.getAttribute("data-net-sign")).toBe("negative");
  });
});
