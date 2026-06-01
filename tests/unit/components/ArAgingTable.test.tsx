/**
 * Story 4.8 — `ArAgingTable` component contract.
 *
 * Pure-presentation component. Coverage:
 *   1. Renders sub-header with `totalCount overdue · needsActionCount need follow-up`.
 *   2. Loading state renders the skeleton row.
 *   3. Empty state renders the calm "Stay vigilant" confirmation.
 *   4. Rows WITHOUT follow-up render the red-overdue `StatusPill`
 *      + red left border (`data-has-active-follow-up="false"`).
 *   5. Rows WITH follow-up render the amber `StatusPill` + the
 *      truncated action note (`Action: …`).
 *   6. Sorting via header click toggles direction (default desc).
 *   7. Each row carries an "Open" link to `/contracts/{contractId}`.
 *   8. Mobile cards rendered as `<Link>` elements (md:hidden / hidden md:block).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ArAgingTable } from "@/components/ArAgingTable";
import type { ArAgingDetailRow } from "@/components/ArAgingTable";

// Stub Next.js's <Link> to a plain anchor — keeps the component tree
// free of the App Router context.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    onClick,
    className,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: (e: React.MouseEvent) => void;
    className?: string;
    "data-testid"?: string;
    "aria-label"?: string;
  }) => (
    <a
      href={href}
      onClick={onClick}
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </a>
  ),
}));

// Story 4.8 AC3 / Epic 4 adversarial-review fix (2026-05-24): the
// component reads sort state from `useSearchParams` and writes via
// `useRouter`. Both hooks are mocked here so each test can prime an
// initial search-param string and assert on the resulting
// `router.push` calls.
//
// `currentSearch` is mutated INSIDE `router.push` so a follow-up
// sort-click test could re-render against the new state — every test
// resets it in `beforeEach`.
let currentSearch = "";
const pushMock = vi.fn((url: string) => {
  const qIdx = url.indexOf("?");
  currentSearch = qIdx === -1 ? "" : url.slice(qIdx + 1);
});

vi.mock("next/navigation", () => ({
  __esModule: true,
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

beforeEach(() => {
  currentSearch = "";
  pushMock.mockClear();
});

const T = new Date("2026-05-18T08:00:00+08:00").getTime();
const DAY = 24 * 60 * 60 * 1000;

function makeRow(overrides: Partial<ArAgingDetailRow> = {}): ArAgingDetailRow {
  return {
    contractId: "contracts:1",
    contractNumber: "CTR-001",
    customerId: "customers:1",
    customerFullName: "Ana Reyes",
    lotId: "lots:1",
    lotCode: "A-1-01",
    bucket: "90+",
    totalOverdueCents: 50_000_00,
    currentBalanceCents: 75_000_00,
    daysOverdue: 120,
    hasActiveFollowUp: false,
    followUpActionNote: undefined,
    lastPaymentAt: T - 90 * DAY,
    contractState: "active",
    ...overrides,
  };
}

describe("ArAgingTable (Story 4.8)", () => {
  it("renders the loading state when result is undefined", () => {
    render(<ArAgingTable result={undefined} bucket="90+" />);
    expect(screen.getByTestId("ar-aging-table-loading")).toBeInTheDocument();
  });

  it("renders the calm empty-state when totalCount is 0", () => {
    render(
      <ArAgingTable
        result={{ rows: [], totalCount: 0, needsActionCount: 0 }}
        bucket="90+"
      />,
    );
    expect(screen.getByTestId("ar-aging-table-empty")).toBeInTheDocument();
    expect(
      screen.getByText("No overdue contracts in this bucket."),
    ).toBeInTheDocument();
    expect(screen.getByText("Stay vigilant.")).toBeInTheDocument();
    // Must NOT show an alert icon / apologetic copy. We check the
    // absence of common failure phrases here as a regression guard.
    expect(screen.queryByText(/oops/i)).toBeNull();
    expect(screen.queryByText(/sorry/i)).toBeNull();
  });

  it("renders sub-header with totalCount + needsActionCount framing", () => {
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({ contractId: "contracts:1", hasActiveFollowUp: false }),
            makeRow({
              contractId: "contracts:2",
              customerFullName: "Ben Lopez",
              hasActiveFollowUp: true,
              followUpActionNote: "Sent SMS reminder, waiting on reply",
            }),
            makeRow({
              contractId: "contracts:3",
              customerFullName: "Carla Reyes",
              hasActiveFollowUp: false,
            }),
          ],
          totalCount: 3,
          needsActionCount: 2,
        }}
        bucket="90+"
      />,
    );
    const subheader = screen.getByTestId("ar-aging-table-subheader");
    expect(subheader.textContent).toContain("3 contracts overdue");
    expect(subheader.textContent).toContain("2 need follow-up");
  });

  it("tints rows red WITHOUT an active follow-up and amber WITH one", () => {
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({ contractId: "contracts:silent", hasActiveFollowUp: false }),
            makeRow({
              contractId: "contracts:action",
              customerFullName: "Ben Lopez",
              hasActiveFollowUp: true,
              followUpActionNote: "Phone call scheduled Friday",
            }),
          ],
          totalCount: 2,
          needsActionCount: 1,
        }}
        bucket="90+"
      />,
    );
    // Desktop and mobile views both render rows, so getAllByTestId.
    const silentRows = screen.getAllByTestId("ar-aging-row-contracts:silent");
    const actionRows = screen.getAllByTestId("ar-aging-row-contracts:action");
    expect(silentRows.length).toBeGreaterThan(0);
    expect(actionRows.length).toBeGreaterThan(0);
    expect(silentRows[0]!.getAttribute("data-has-active-follow-up")).toBe(
      "false",
    );
    expect(actionRows[0]!.getAttribute("data-has-active-follow-up")).toBe(
      "true",
    );
    // The action row should render the truncated action note as
    // additional text, so accessible meaning never depends on color.
    const actionRow = actionRows[0]!;
    expect(
      within(actionRow).getByTestId(
        "ar-aging-row-contracts:action-action-note",
      ).textContent,
    ).toContain("Action:");
  });

  it("renders each row's StatusPill with the right semantic status (overdue vs overdue-action)", () => {
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({ contractId: "contracts:silent", hasActiveFollowUp: false }),
            makeRow({
              contractId: "contracts:action",
              customerFullName: "Ben Lopez",
              hasActiveFollowUp: true,
              followUpActionNote: "Call scheduled",
            }),
          ],
          totalCount: 2,
          needsActionCount: 1,
        }}
        bucket="90+"
      />,
    );
    // StatusPill renders the label inside the span — we check by
    // text since the component owns its data-status attribute.
    expect(screen.getAllByLabelText("Overdue").length).toBeGreaterThan(0);
    expect(
      screen.getAllByLabelText("Overdue (action)").length,
    ).toBeGreaterThan(0);
  });

  it("renders an Open link per row pointing to /contracts/{contractId}", () => {
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({ contractId: "contracts:1" }),
            makeRow({ contractId: "contracts:2", customerFullName: "Ben" }),
          ],
          totalCount: 2,
          needsActionCount: 2,
        }}
        bucket="90+"
      />,
    );
    expect(
      screen.getByTestId("ar-aging-open-contracts:1"),
    ).toHaveAttribute("href", "/contracts/contracts:1");
    expect(
      screen.getByTestId("ar-aging-open-contracts:2"),
    ).toHaveAttribute("href", "/contracts/contracts:2");
  });

  it("default sort places highest daysOverdue first (largest financial risk variant: rows with biggest amount surface)", () => {
    // Default sort key is `daysOverdue` desc per the task contract; we
    // assert by reading the sub-header arrow indicator presence on the
    // active column.
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({
              contractId: "contracts:young",
              daysOverdue: 35,
              totalOverdueCents: 1_000_00,
              customerFullName: "Young Customer",
            }),
            makeRow({
              contractId: "contracts:old",
              daysOverdue: 200,
              totalOverdueCents: 9_999_00,
              customerFullName: "Old Customer",
            }),
          ],
          totalCount: 2,
          needsActionCount: 2,
        }}
        bucket="90+"
      />,
    );
    // The desktop tbody is the first table; its first `tr` should be
    // the "old" row.
    const desktopRows = screen
      .getByTestId("ar-aging-table")
      .querySelectorAll("tbody tr");
    expect(desktopRows[0]!.getAttribute("data-testid")).toBe(
      "ar-aging-row-contracts:old",
    );
    expect(desktopRows[1]!.getAttribute("data-testid")).toBe(
      "ar-aging-row-contracts:young",
    );
  });

  it("clicking the days-overdue header pushes ?sort=daysOverdue&dir=asc to the URL (toggle from default desc)", async () => {
    const user = userEvent.setup();
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({
              contractId: "contracts:young",
              daysOverdue: 35,
              customerFullName: "Young",
            }),
            makeRow({
              contractId: "contracts:old",
              daysOverdue: 200,
              customerFullName: "Old",
            }),
          ],
          totalCount: 2,
          needsActionCount: 2,
        }}
        bucket="90+"
      />,
    );
    // Default sort key is daysOverdue desc; clicking the same header
    // flips direction to asc.
    await user.click(screen.getByTestId("ar-aging-sort-daysOverdue"));
    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushed = pushMock.mock.calls[0]![0] as string;
    expect(pushed).toContain("sort=daysOverdue");
    expect(pushed).toContain("dir=asc");
  });

  it("re-clicking days-overdue from asc collapses back to the compact default URL (no sort/dir params)", async () => {
    const user = userEvent.setup();
    currentSearch = "sort=daysOverdue&dir=asc";
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({
              contractId: "contracts:young",
              daysOverdue: 35,
              customerFullName: "Young",
            }),
          ],
          totalCount: 1,
          needsActionCount: 1,
        }}
        bucket="90+"
      />,
    );
    await user.click(screen.getByTestId("ar-aging-sort-daysOverdue"));
    // Toggle back to (daysOverdue, desc) — that matches the default,
    // so the helper drops the params and pushes the bare "/ar-aging".
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0]![0]).toBe("/ar-aging");
  });

  it("clicking the customer header switches the URL to ?sort=customerFullName&dir=desc", async () => {
    const user = userEvent.setup();
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({
              contractId: "contracts:zara",
              customerFullName: "Zara Cruz",
              daysOverdue: 200,
            }),
            makeRow({
              contractId: "contracts:ana",
              customerFullName: "Ana Reyes",
              daysOverdue: 50,
            }),
          ],
          totalCount: 2,
          needsActionCount: 2,
        }}
        bucket="90+"
      />,
    );
    await user.click(screen.getByTestId("ar-aging-sort-customerFullName"));
    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushed = pushMock.mock.calls[0]![0] as string;
    expect(pushed).toContain("sort=customerFullName");
    expect(pushed).toContain("dir=desc");
  });

  it("URL search params drive the initial sort (no client click needed)", () => {
    // Prime the URL with an asc sort by customerFullName — the
    // component should render rows in that order without any
    // interaction.
    currentSearch = "sort=customerFullName&dir=asc";
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({
              contractId: "contracts:zara",
              customerFullName: "Zara Cruz",
              daysOverdue: 200,
            }),
            makeRow({
              contractId: "contracts:ana",
              customerFullName: "Ana Reyes",
              daysOverdue: 50,
            }),
          ],
          totalCount: 2,
          needsActionCount: 2,
        }}
        bucket="90+"
      />,
    );
    const desktopRows = screen
      .getByTestId("ar-aging-table")
      .querySelectorAll("tbody tr");
    expect(desktopRows[0]!.getAttribute("data-testid")).toBe(
      "ar-aging-row-contracts:ana",
    );
    expect(desktopRows[1]!.getAttribute("data-testid")).toBe(
      "ar-aging-row-contracts:zara",
    );
  });

  it("preserves other search params (e.g. bucket) when pushing a new sort", async () => {
    const user = userEvent.setup();
    currentSearch = "bucket=61-90";
    render(
      <ArAgingTable
        result={{
          rows: [
            makeRow({
              contractId: "contracts:1",
              customerFullName: "Ana",
              daysOverdue: 80,
            }),
          ],
          totalCount: 1,
          needsActionCount: 1,
        }}
        bucket="61-90"
      />,
    );
    await user.click(screen.getByTestId("ar-aging-sort-customerFullName"));
    expect(pushMock).toHaveBeenCalledTimes(1);
    const pushed = pushMock.mock.calls[0]![0] as string;
    expect(pushed).toContain("bucket=61-90");
    expect(pushed).toContain("sort=customerFullName");
  });

  it("renders mobile card stack alongside the desktop table (each visible via responsive Tailwind classes)", () => {
    render(
      <ArAgingTable
        result={{
          rows: [makeRow({ contractId: "contracts:1" })],
          totalCount: 1,
          needsActionCount: 1,
        }}
        bucket="90+"
      />,
    );
    expect(screen.getByTestId("ar-aging-card-contracts:1")).toBeInTheDocument();
    expect(
      screen.getByTestId("ar-aging-card-contracts:1").getAttribute("href"),
    ).toBe("/contracts/contracts:1");
  });

  it("uses the bucketLabelOverride when supplied", () => {
    render(
      <ArAgingTable
        result={{
          rows: [makeRow()],
          totalCount: 1,
          needsActionCount: 1,
        }}
        bucket={null}
        bucketLabelOverride="Custom heading"
      />,
    );
    expect(
      screen.getByTestId("ar-aging-table-subheader").textContent,
    ).toContain("Custom heading");
  });
});
