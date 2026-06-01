/**
 * Story 6.3 — `/reports/sales` page tests.
 *
 * Coverage (AC4 UX states + AC1 grouping + AC2 agent gating + AC3 drill-down):
 *   - Loading: page renders the loading indicator while the query is
 *     undefined.
 *   - Empty: empty range shows the calm "No sales" copy.
 *   - Loaded — toggle off: lot-type + section rows render, agent rows
 *     do NOT render, the §10 Q5 footnote is shown.
 *   - Loaded — toggle on: agent rows expand from section rows.
 *   - Drill-down: clicking a lot-type link routes to /sales with the
 *     filter query string.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockUseQuery = vi.fn();
const mockMutation = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => mockMutation,
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

// ExportSheet renders against a Convex hook we don't want to exercise
// here. Stub to a no-op marker so the suite focuses on the report
// rendering.
vi.mock("@/components/ExportSheet", () => ({
  ExportSheet: ({ exportId }: { exportId: string }) => (
    <div data-testid={`export-sheet-${exportId}`} />
  ),
}));

import SalesReportPage from "../../../src/app/(staff)/reports/sales/page";

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    from: 1,
    to: 2,
    generatedAt: 3,
    salesAgentTrackingEnabled: false,
    totalCount: 4,
    totalAmountCents: 1_000_000,
    lotTypes: [
      {
        lotType: "single",
        count: 3,
        totalAmountCents: 500_000,
        sections: [
          { section: "A", count: 2, totalAmountCents: 250_000 },
          { section: "B", count: 1, totalAmountCents: 250_000 },
        ],
      },
      {
        lotType: "family",
        count: 1,
        totalAmountCents: 500_000,
        sections: [
          { section: "A", count: 1, totalAmountCents: 500_000 },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mockUseQuery.mockReset();
  mockMutation.mockReset();
  mockPush.mockReset();
});

describe("/reports/sales — UX states", () => {
  it("renders a loading state while the query is undefined", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<SalesReportPage />);
    expect(screen.getByTestId("report-loading")).toBeInTheDocument();
  });

  it("renders the empty copy when totalCount === 0", () => {
    mockUseQuery.mockReturnValue(makeReport({ totalCount: 0, lotTypes: [] }));
    render(<SalesReportPage />);
    expect(screen.getByTestId("report-empty")).toHaveTextContent(
      /No sales in this date range/,
    );
  });

  it("renders the agent-tracking footnote when the toggle is off", () => {
    mockUseQuery.mockReturnValue(makeReport());
    render(<SalesReportPage />);
    expect(screen.getByTestId("report-agent-footnote")).toHaveTextContent(
      /§10 Q5/,
    );
  });

  it("renders lot-type and section rows; does NOT render agent rows when toggle off", () => {
    mockUseQuery.mockReturnValue(makeReport());
    render(<SalesReportPage />);
    expect(screen.getByTestId("report-lottype-single")).toBeInTheDocument();
    expect(screen.getByTestId("report-lottype-family")).toBeInTheDocument();
    expect(screen.getByTestId("report-section-single-A")).toBeInTheDocument();
    // Agent rows don't exist when the toggle is off. (Match data-testid
    // values shaped `report-agent-<lotType>-<section>-<agentId>` — the
    // footnote testid `report-agent-footnote` must NOT match here.)
    expect(screen.queryByTestId(/^report-agent-[a-z]+-/)).toBeNull();
  });

  it("renders agent rows when the toggle is on and agents are populated", async () => {
    mockUseQuery.mockReturnValue(
      makeReport({
        salesAgentTrackingEnabled: true,
        lotTypes: [
          {
            lotType: "single",
            count: 2,
            totalAmountCents: 300_000,
            sections: [
              {
                section: "A",
                count: 2,
                totalAmountCents: 300_000,
                agents: [
                  {
                    agentId: "users:agent1",
                    agentName: "Alice Cruz",
                    count: 2,
                    totalAmountCents: 300_000,
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    render(<SalesReportPage />);
    // Section row is collapsed by default; expand it to render the
    // nested agent row.
    const sectionToggle = screen.getByTestId("report-section-single-A");
    const toggleBtn = sectionToggle.querySelector("button[aria-expanded]");
    expect(toggleBtn).not.toBeNull();
    await userEvent.click(toggleBtn!);
    expect(
      screen.getByTestId("report-agent-single-A-users:agent1"),
    ).toHaveTextContent("Alice Cruz");
    expect(screen.queryByTestId("report-agent-footnote")).toBeNull();
  });

  it("drill-down: clicking a lot-type link routes to /sales with filters", async () => {
    mockUseQuery.mockReturnValue(makeReport());
    render(<SalesReportPage />);
    await userEvent.click(screen.getByTestId("report-lottype-link-single"));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const dest = mockPush.mock.calls[0]![0] as string;
    expect(dest.startsWith("/sales?")).toBe(true);
    expect(dest).toContain("lotType=single");
    expect(dest).toContain("from=");
    expect(dest).toContain("to=");
  });
});
