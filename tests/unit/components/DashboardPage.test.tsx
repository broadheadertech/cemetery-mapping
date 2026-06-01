/**
 * Story 5.2 — `/dashboard` page tests.
 *
 * Coverage:
 *   - Loading state: skeleton cards render while the queries are
 *     `undefined`.
 *   - Loaded state: every tile label + value is present, money fields
 *     are peso-formatted by the consumer (not by KpiCard), AR aging
 *     row labels render in canonical order.
 *   - Period toggle: clicking YTD swaps the URL via `router.replace`,
 *     clicking MTD removes the param.
 *   - Aria-live announcement updates with the period.
 *   - Empty-state flagged tile renders the "stay vigilant" copy.
 *
 * Story 5.3 extends this file with drill-through navigation coverage:
 *   - Each clickable KPI tile navigates via `router.push` to the
 *     filtered list destination, preserving the current period in the
 *     URL query.
 *   - The Net tile remains non-clickable (informational only).
 *   - AR aging bucket rows route to `/ar-aging?bucket=…`, with `+` in
 *     the `90+` key URL-encoded as `%2B`.
 *   - The Flagged-for-Follow-up tile routes to `/flagged-followups`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub the Convex hook used by the page. Each test sets the return
// values via the mock controls below.
const mockUseQuery = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

// Stub the Next.js navigation hooks. `useRouter` exposes `replace` for
// the period-toggle tests and `push` for the Story 5.3 drill-down
// tests. `useSearchParams` is a controlled mock so each test picks the
// period.
const mockReplace = vi.fn();
const mockPush = vi.fn();
const mockGetSearchParam = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  useSearchParams: () => ({
    get: (key: string) => mockGetSearchParam(key),
    toString: () => "",
  }),
}));

import DashboardPage from "../../../src/app/(staff)/dashboard/page";

// ----------------------------------------------------------------------
// Fixture builders.
// ----------------------------------------------------------------------

function makeKpiResult(overrides: Record<string, unknown> = {}) {
  return {
    period: "mtd",
    periodStartMs: 0,
    periodEndMs: 1,
    lotsTotal: 100,
    lotsAvailable: 40,
    lotsReserved: 10,
    lotsSold: 30,
    lotsOccupied: 20,
    contractsActive: 25,
    contractsInDefault: 2,
    contractsPaidInFull: 18,
    salesCents: 340_000_00,
    collectionsCents: 285_000_00,
    arBalanceCents: 1_825_000_00,
    expensesCents: 48_000_00,
    netCents: 237_000_00,
    netIsNegative: false,
    salesDeltaCents: 16_000_00,
    collectionsDeltaCents: 12_000_00,
    expensesDeltaCents: 4_000_00,
    netDeltaCents: 8_000_00,
    netDeltaIsNegative: false,
    ...overrides,
  };
}

function makeAgingResult(overrides: Record<string, unknown> = {}) {
  return {
    buckets: [
      { key: "1-30", count: 0, totalCents: 0, withLoggedActionCount: 0 },
      { key: "31-60", count: 0, totalCents: 0, withLoggedActionCount: 0 },
      { key: "61-90", count: 0, totalCents: 0, withLoggedActionCount: 0 },
      { key: "90+", count: 0, totalCents: 0, withLoggedActionCount: 0 },
    ],
    isPlaceholder: true,
    ...overrides,
  };
}

function makeFlaggedResult(overrides: Record<string, unknown> = {}) {
  return {
    count: 0,
    mostRecentComment: null,
    mostRecentFlaggedAt: null,
    isPlaceholder: true,
    ...overrides,
  };
}

// Choose the appropriate return value based on the function reference
// the page passed to `useQuery`. Convex's `makeFunctionReference` stores
// the function path on the well-known Symbol.for("functionName") key.
const FUNCTION_NAME_SYMBOL = Symbol.for("functionName");

function setUseQueryHandlers(opts: {
  kpis?: unknown;
  aging?: unknown;
  flagged?: unknown;
}) {
  mockUseQuery.mockImplementation((ref: unknown) => {
    const refRecord = ref as Record<symbol, unknown>;
    const name = String(refRecord?.[FUNCTION_NAME_SYMBOL] ?? "");
    if (name.includes("getDashboardKpis")) return opts.kpis;
    if (name.includes("getArAgingSummary")) return opts.aging;
    if (name.includes("getFlaggedForFollowupSummary"))
      return opts.flagged;
    return undefined;
  });
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockReplace.mockReset();
  mockPush.mockReset();
  mockGetSearchParam.mockReset();
  // Default: no `?period=` query string ⇒ MTD.
  mockGetSearchParam.mockReturnValue(null);
});

// ----------------------------------------------------------------------
// Tests.
// ----------------------------------------------------------------------

describe("DashboardPage — loading state (AC1)", () => {
  it("renders skeleton cards while any query is undefined", () => {
    setUseQueryHandlers({
      kpis: undefined,
      aging: undefined,
      flagged: undefined,
    });
    render(<DashboardPage />);
    const skeletons = screen.getAllByTestId("dashboard-skeleton-card");
    // 5 money + 4 inventory = 9 skeleton cards when both KPI grids are
    // loading.
    expect(skeletons.length).toBe(9);
    // The bucket-list skeleton is its own primitive.
    expect(
      screen.getByTestId("dashboard-ar-aging-skeleton"),
    ).toBeInTheDocument();
  });
});

describe("DashboardPage — loaded MTD state (AC1, AC3)", () => {
  beforeEach(() => {
    setUseQueryHandlers({
      kpis: makeKpiResult(),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
  });

  it("renders the Dashboard h1", () => {
    render(<DashboardPage />);
    expect(
      screen.getByRole("heading", { name: "Dashboard", level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders all five money tile labels for MTD by default", () => {
    render(<DashboardPage />);
    expect(screen.getByText("MTD Sales")).toBeInTheDocument();
    expect(screen.getByText("MTD Collections")).toBeInTheDocument();
    expect(screen.getByText("AR Balance")).toBeInTheDocument();
    expect(screen.getByText("MTD Expenses")).toBeInTheDocument();
    expect(screen.getByText("MTD Net")).toBeInTheDocument();
  });

  it("formats money values via formatPeso (consumer formats, not KpiCard)", () => {
    render(<DashboardPage />);
    // 340_000_00 centavos = ₱340,000.00. The peso glyph + grouping
    // commas come from Intl.NumberFormat. Use partial match because
    // Intl may insert a non-breaking space depending on locale.
    const moneyTiles = screen.getByTestId("dashboard-money-tiles");
    expect(within(moneyTiles).getByText(/340,000\.00/)).toBeInTheDocument();
    expect(within(moneyTiles).getByText(/285,000\.00/)).toBeInTheDocument();
    expect(
      within(moneyTiles).getByText(/1,825,000\.00/),
    ).toBeInTheDocument();
    expect(within(moneyTiles).getByText(/48,000\.00/)).toBeInTheDocument();
    expect(within(moneyTiles).getByText(/237,000\.00/)).toBeInTheDocument();
  });

  it("renders all four inventory tiles with counts", () => {
    render(<DashboardPage />);
    const tiles = screen.getByTestId("dashboard-inventory-tiles");
    expect(within(tiles).getByText("Lots Available")).toBeInTheDocument();
    expect(within(tiles).getByText("Lots Sold")).toBeInTheDocument();
    expect(within(tiles).getByText("Lots Occupied")).toBeInTheDocument();
    expect(within(tiles).getByText("Active Contracts")).toBeInTheDocument();
    expect(within(tiles).getByText("40")).toBeInTheDocument();
    expect(within(tiles).getByText("30")).toBeInTheDocument();
    // "20" — lots occupied
    expect(within(tiles).getByText("20")).toBeInTheDocument();
    // "25" — active contracts
    expect(within(tiles).getByText("25")).toBeInTheDocument();
  });

  it("renders the AR aging bucket rows in canonical order", () => {
    render(<DashboardPage />);
    expect(
      screen.getByTestId("dashboard-ar-bucket-1-30"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dashboard-ar-bucket-31-60"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dashboard-ar-bucket-61-90"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("dashboard-ar-bucket-90+"),
    ).toBeInTheDocument();
  });

  it("shows the placeholder hint when aging.isPlaceholder is true", () => {
    render(<DashboardPage />);
    expect(
      screen.getByText("Epic 4 will populate live data."),
    ).toBeInTheDocument();
  });

  it("renders the empty-state flagged tile copy when count is 0", () => {
    render(<DashboardPage />);
    expect(
      screen.getByText("No open flags. Stay vigilant."),
    ).toBeInTheDocument();
  });

  it("renders the Net tile as non-clickable (Story 5.3 AC1: derived metric)", () => {
    render(<DashboardPage />);
    // Net is intentionally a static <div>; the surrounding label
    // appears with the literal value but no <button> wraps it.
    const moneyTiles = screen.getByTestId("dashboard-money-tiles");
    const netLabel = within(moneyTiles).getByText("MTD Net");
    // Climb to the nearest enclosing element — when Net is clickable
    // it would be a <button>. We assert closest("button") returns null.
    expect(netLabel.closest("button")).toBeNull();
  });

  it("renders four money tiles as clickable buttons (Story 5.3 AC1)", () => {
    render(<DashboardPage />);
    // Sales, Collections, AR Balance, Expenses → buttons.
    // Net → static div.
    const moneyTiles = screen.getByTestId("dashboard-money-tiles");
    expect(moneyTiles.querySelectorAll("button").length).toBe(4);
  });

  it("renders inventory tiles as non-clickable (Story 5.3 AC1: no drill targets)", () => {
    render(<DashboardPage />);
    const inventoryTiles = screen.getByTestId("dashboard-inventory-tiles");
    // Inventory tiles have no drill destinations in Story 5.3 AC1's
    // mapping — they stay informational.
    expect(inventoryTiles.querySelectorAll("button").length).toBe(0);
  });
});

describe("DashboardPage — drill-down navigation (Story 5.3 AC1)", () => {
  beforeEach(() => {
    setUseQueryHandlers({
      kpis: makeKpiResult(),
      aging: makeAgingResult({
        buckets: [
          { key: "1-30", count: 1, totalCents: 1000, withLoggedActionCount: 1 },
          { key: "31-60", count: 0, totalCents: 0, withLoggedActionCount: 0 },
          { key: "61-90", count: 2, totalCents: 2000, withLoggedActionCount: 0 },
          { key: "90+", count: 3, totalCents: 3000, withLoggedActionCount: 1 },
        ],
        isPlaceholder: false,
      }),
      flagged: makeFlaggedResult({ count: 2, isPlaceholder: false }),
    });
  });

  it("clicking MTD Sales pushes /sales?period=mtd by default", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByRole("button", { name: /MTD Sales:/ }),
    );
    expect(mockPush).toHaveBeenCalledWith("/sales?period=mtd");
  });

  it("clicking MTD Collections pushes /payments?period=mtd", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByRole("button", { name: /MTD Collections:/ }),
    );
    expect(mockPush).toHaveBeenCalledWith("/payments?period=mtd");
  });

  it("clicking AR Balance pushes /contracts?state=active,in_default", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByRole("button", { name: /AR Balance:/ }),
    );
    expect(mockPush).toHaveBeenCalledWith(
      "/contracts?state=active,in_default",
    );
  });

  it("clicking MTD Expenses pushes /expenses?period=mtd", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByRole("button", { name: /MTD Expenses:/ }),
    );
    expect(mockPush).toHaveBeenCalledWith("/expenses?period=mtd");
  });

  it("preserves YTD in the drill-down URL when the dashboard is YTD", async () => {
    mockGetSearchParam.mockReturnValue("ytd");
    setUseQueryHandlers({
      kpis: makeKpiResult({ period: "ytd" }),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByRole("button", { name: /YTD Sales:/ }),
    );
    expect(mockPush).toHaveBeenCalledWith("/sales?period=ytd");
  });

  it("AR aging bucket row routes to /ar-aging?bucket=<key>", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByTestId("dashboard-ar-bucket-button-61-90"),
    );
    expect(mockPush).toHaveBeenCalledWith("/ar-aging?bucket=61-90");
  });

  it("90+ AR aging bucket URL-encodes the + as %2B", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByTestId("dashboard-ar-bucket-button-90+"),
    );
    expect(mockPush).toHaveBeenCalledWith("/ar-aging?bucket=90%2B");
  });

  it("Flagged-for-Follow-up tile routes to /flagged-followups?status=open", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByTestId("dashboard-flagged-tile-button"),
    );
    expect(mockPush).toHaveBeenCalledWith(
      "/flagged-followups?status=open",
    );
  });

  it("uses router.push (not router.replace) so back-button restores the dashboard", async () => {
    // AC4 guards against `router.replace`, which would discard the
    // dashboard from history.
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(
      screen.getByRole("button", { name: /MTD Sales:/ }),
    );
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledTimes(1);
  });
});

describe("DashboardPage — flagged tile populated (AC2)", () => {
  it("renders count + most-recent comment when count > 0", () => {
    setUseQueryHandlers({
      kpis: makeKpiResult(),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult({
        count: 3,
        mostRecentComment: "Customer asked to renegotiate by Friday",
        mostRecentFlaggedAt: Date.now(),
        isPlaceholder: false,
      }),
    });
    render(<DashboardPage />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(
      screen.getByText(/Customer asked to renegotiate by Friday/),
    ).toBeInTheDocument();
  });
});

describe("DashboardPage — net negative rendering", () => {
  it("renders the net value with a minus sign when netIsNegative is true", () => {
    setUseQueryHandlers({
      kpis: makeKpiResult({
        netCents: 25_000_00,
        netIsNegative: true,
      }),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
    render(<DashboardPage />);
    expect(screen.getByText(/−.*25,000\.00/)).toBeInTheDocument();
  });
});

describe("DashboardPage — period toggle (AC4)", () => {
  beforeEach(() => {
    setUseQueryHandlers({
      kpis: makeKpiResult(),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
  });

  it("renders the period toggle with two buttons (44px touch targets)", () => {
    render(<DashboardPage />);
    const toggle = screen.getByTestId("dashboard-period-toggle");
    const mtdBtn = within(toggle).getByTestId("dashboard-period-mtd");
    const ytdBtn = within(toggle).getByTestId("dashboard-period-ytd");
    expect(mtdBtn.className).toContain("min-h-[44px]");
    expect(ytdBtn.className).toContain("min-h-[44px]");
  });

  it("MTD button is aria-pressed=true by default; YTD is false", () => {
    render(<DashboardPage />);
    expect(
      screen.getByTestId("dashboard-period-mtd"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByTestId("dashboard-period-ytd"),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking YTD calls router.replace with ?period=ytd", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(screen.getByTestId("dashboard-period-ytd"));
    expect(mockReplace).toHaveBeenCalledWith("/dashboard?period=ytd");
  });

  it("clicking the already-active period is a no-op", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(screen.getByTestId("dashboard-period-mtd"));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("clicking MTD from a YTD URL replaces back to /dashboard (no param)", async () => {
    mockGetSearchParam.mockReturnValue("ytd");
    setUseQueryHandlers({
      kpis: makeKpiResult({ period: "ytd" }),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
    const user = userEvent.setup();
    render(<DashboardPage />);
    await user.click(screen.getByTestId("dashboard-period-mtd"));
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });

  it("renders YTD tile labels when ?period=ytd is in the URL", () => {
    mockGetSearchParam.mockReturnValue("ytd");
    setUseQueryHandlers({
      kpis: makeKpiResult({ period: "ytd" }),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
    render(<DashboardPage />);
    expect(screen.getByText("YTD Sales")).toBeInTheDocument();
    expect(screen.getByText("YTD Collections")).toBeInTheDocument();
    expect(screen.getByText("YTD Expenses")).toBeInTheDocument();
    expect(screen.getByText("YTD Net")).toBeInTheDocument();
  });
});

describe("DashboardPage — period announcement (AC4)", () => {
  it("renders Showing month-to-date by default", () => {
    setUseQueryHandlers({
      kpis: makeKpiResult(),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
    render(<DashboardPage />);
    expect(
      screen.getByText("Showing month-to-date"),
    ).toBeInTheDocument();
  });

  it("renders Showing year-to-date when period=ytd", () => {
    mockGetSearchParam.mockReturnValue("ytd");
    setUseQueryHandlers({
      kpis: makeKpiResult({ period: "ytd" }),
      aging: makeAgingResult(),
      flagged: makeFlaggedResult(),
    });
    render(<DashboardPage />);
    expect(
      screen.getByText("Showing year-to-date"),
    ).toBeInTheDocument();
  });
});
