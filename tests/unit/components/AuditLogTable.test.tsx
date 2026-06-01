/**
 * Story 6.5 — AuditLogTable component contract.
 *
 * Pure-presentation component. Coverage:
 *   1. Renders header + a row per fixture entry.
 *   2. Loading state shows the skeleton row.
 *   3. Empty state shows the "no entries" copy.
 *   4. Filter chips render and dismiss correctly.
 *   5. Pagination buttons disable / enable based on isDone + hasPrevPage.
 *   6. Entity-id renders as a `<a>` for the known entity types
 *      (lot / customer / contract) and as plain text for the rest.
 *   7. `onRowClick` fires when the row body is clicked, but not when
 *      the entity-id link is clicked (stopPropagation).
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AuditLogTable, type AuditLogRow } from "@/components/AuditLogTable";

// Next.js's <Link> needs the App Router context if you go the
// production route; for unit tests we stub it to a plain anchor so
// rendering doesn't drag in the router.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    onClick,
    className,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: (e: React.MouseEvent) => void;
    className?: string;
    "data-testid"?: string;
  }) => (
    <a href={href} onClick={onClick} className={className} data-testid={testId}>
      {children}
    </a>
  ),
}));

const T = new Date("2026-05-18T08:00:00+08:00").getTime();

function makeRow(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    _id: "auditLog:1",
    _creationTime: T,
    actor: "users:admin1",
    actorName: "Maria Admin",
    timestamp: T,
    action: "update",
    entityType: "lot",
    entityId: "lots:abc123",
    before: { status: "available" },
    after: { status: "sold" },
    reason: "Customer purchase",
    ...overrides,
  };
}

describe("AuditLogTable", () => {
  it("renders a row per fixture with all the documented columns", () => {
    render(
      <AuditLogTable
        rows={[
          makeRow({ _id: "auditLog:1", action: "create" }),
          makeRow({
            _id: "auditLog:2",
            action: "void",
            entityType: "receipt",
            entityId: "receipts:r-7",
          }),
        ]}
        isLoading={false}
        isDone={true}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    const rows = screen.getAllByTestId("audit-log-row");
    expect(rows).toHaveLength(2);
    // Both actions visible.
    expect(within(rows[0]!).getByText("create")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("void")).toBeInTheDocument();
    // Receipt is a no-detail-link entity in Phase 1 — should be plain
    // text, not an <a>.
    expect(
      within(rows[1]!).queryByTestId("audit-log-entity-link"),
    ).toBeNull();
    // Lot has a detail page — should render as a link.
    expect(
      within(rows[0]!).getByTestId("audit-log-entity-link"),
    ).toHaveAttribute("href", "/lots/lots:abc123");
  });

  it("shows the loading row when isLoading is true", () => {
    render(
      <AuditLogTable
        rows={[]}
        isLoading={true}
        isDone={false}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    expect(screen.getByTestId("audit-log-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-log-empty")).toBeNull();
  });

  it("shows the empty row when there are no rows and not loading", () => {
    render(
      <AuditLogTable
        rows={[]}
        isLoading={false}
        isDone={true}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    expect(screen.getByTestId("audit-log-empty")).toBeInTheDocument();
  });

  it("renders dismissable filter chips and surfaces removal events", async () => {
    const user = userEvent.setup();
    const onRemoveFilter = vi.fn();
    render(
      <AuditLogTable
        rows={[]}
        isLoading={false}
        isDone={true}
        filterChips={[
          { key: "entityType", label: "Type: Lot" },
          { key: "actor", label: "Actor: users:admin1" },
        ]}
        onRemoveFilter={onRemoveFilter}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    const chipsContainer = screen.getByTestId("audit-log-filter-chips");
    const chips = within(chipsContainer).getAllByRole("button");
    expect(chips).toHaveLength(2);
    await user.click(chips[0]!);
    expect(onRemoveFilter).toHaveBeenCalledWith("entityType");
  });

  it("disables Next when isDone is true, and Previous when no prev cursor", () => {
    render(
      <AuditLogTable
        rows={[makeRow()]}
        isLoading={false}
        isDone={true}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    expect(screen.getByTestId("audit-log-next")).toBeDisabled();
    expect(screen.getByTestId("audit-log-prev")).toBeDisabled();
  });

  it("enables Next + Previous when more pages exist", async () => {
    const user = userEvent.setup();
    const onNextPage = vi.fn();
    const onPrevPage = vi.fn();
    render(
      <AuditLogTable
        rows={[makeRow()]}
        isLoading={false}
        isDone={false}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={onNextPage}
        onPrevPage={onPrevPage}
        hasPrevPage={true}
      />,
    );
    const next = screen.getByTestId("audit-log-next");
    const prev = screen.getByTestId("audit-log-prev");
    expect(next).not.toBeDisabled();
    expect(prev).not.toBeDisabled();
    await user.click(next);
    expect(onNextPage).toHaveBeenCalledTimes(1);
    await user.click(prev);
    expect(onPrevPage).toHaveBeenCalledTimes(1);
  });

  it("falls back to '(unknown user)' when actorName is null", () => {
    render(
      <AuditLogTable
        rows={[makeRow({ actorName: null })]}
        isLoading={false}
        isDone={true}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    expect(screen.getByText("(unknown user)")).toBeInTheDocument();
  });

  it("surfaces both before and after preview when both are present", () => {
    render(
      <AuditLogTable
        rows={[
          makeRow({
            before: { status: "available" },
            after: { status: "sold" },
          }),
        ]}
        isLoading={false}
        isDone={true}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
      />,
    );
    expect(screen.getByTestId("audit-log-before")).toBeInTheDocument();
    expect(screen.getByTestId("audit-log-after")).toBeInTheDocument();
  });

  it("invokes onRowClick when the row is clicked, but stops on entity-id link click", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <AuditLogTable
        rows={[makeRow({ entityType: "lot", entityId: "lots:abc123" })]}
        isLoading={false}
        isDone={true}
        filterChips={[]}
        onRemoveFilter={() => {}}
        onNextPage={() => {}}
        onPrevPage={() => {}}
        hasPrevPage={false}
        onRowClick={onRowClick}
      />,
    );
    // Click the row body (timestamp cell) — should fire.
    const row = screen.getByTestId("audit-log-row");
    await user.click(row);
    expect(onRowClick).toHaveBeenCalledTimes(1);
    // Click the link — should NOT fire the row click (stopPropagation).
    onRowClick.mockClear();
    const link = screen.getByTestId("audit-log-entity-link");
    await user.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
