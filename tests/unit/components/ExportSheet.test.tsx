/**
 * Story 6.4 — `<ExportSheet>` UI states (P1-4 retry cap surface).
 *
 * Strategy: stub `useQuery` to return a fixture row and `useMutation`
 * to be a noop. The component is otherwise pure; the only behaviour
 * we lock in here is the Retry button rendering rule (visible when
 * the row is failed AND `retryCount < MAX_RETRY_COUNT`, hidden + a
 * final-failure banner otherwise).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockUseQuery = vi.fn();
const mockMutation = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => mockMutation,
}));

// Sheet primitives are presentation-only; stub to avoid pulling in the
// Radix portal machinery during jsdom tests.
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children, ...rest }: { children: React.ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("@/lib/errors", () => ({
  translateError: () => ({ headline: "Err", detail: "x" }),
}));

import { ExportSheet } from "../../../src/components/ExportSheet/ExportSheet";

beforeEach(() => {
  mockUseQuery.mockReset();
  mockMutation.mockReset();
});

const RETRY_PROP = {
  reportType: "sales_by_dimension" as const,
  format: "pdf" as const,
  args: { from: 1, to: 2 },
  onRetried: vi.fn(),
};

describe("ExportSheet — retry cap UI (P1-4)", () => {
  it("renders the Retry button when retryCount < cap", () => {
    mockUseQuery.mockReturnValue({
      _id: "exports:1",
      reportType: "sales_by_dimension",
      format: "pdf",
      status: "failed",
      requestedAt: 1,
      readyAt: null,
      downloadCount: 0,
      retryCount: 1,
      lastError: "boom",
    });
    render(
      <ExportSheet exportId="exports:1" onClose={vi.fn()} retry={RETRY_PROP} />,
    );
    expect(screen.getByTestId("export-sheet-retry")).toBeInTheDocument();
    expect(screen.queryByTestId("export-sheet-retry-cap")).toBeNull();
  });

  it("hides the Retry button and renders the final-failure banner when retryCount >= cap", () => {
    mockUseQuery.mockReturnValue({
      _id: "exports:1",
      reportType: "sales_by_dimension",
      format: "pdf",
      status: "failed",
      requestedAt: 1,
      readyAt: null,
      downloadCount: 0,
      retryCount: 3,
      lastError: "boom",
    });
    render(
      <ExportSheet exportId="exports:1" onClose={vi.fn()} retry={RETRY_PROP} />,
    );
    expect(screen.queryByTestId("export-sheet-retry")).toBeNull();
    expect(screen.getByTestId("export-sheet-retry-cap")).toHaveTextContent(
      /failed 3 times/,
    );
  });
});
