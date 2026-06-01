/**
 * Story 6.3 — `/sales` page URL-param drill-down filter tests (P1-7).
 *
 * The Sales by dimension report links into this page with `from`, `to`,
 * `lotType`, `section`, `agentId` query-string filters. Before P1-7
 * these params were silently ignored; this suite locks in the
 * client-side filter pipeline.
 *
 * Strategy: stub `useSearchParams` + `useQuery` so the page can be
 * rendered head-only without a real Convex client. We mount the page
 * twice with different param shapes and assert the resulting filtered
 * row set.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockUseQuery = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const mockSearchParamsMap = new Map<string, string>();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => mockSearchParamsMap.get(key) ?? null,
  }),
}));

import SalesListPage from "../../../src/app/(staff)/sales/page";

interface ContractFixture {
  contractId: string;
  contractNumber: string;
  lotId: string;
  lotCode: string;
  customerId: string;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state: "active" | "paid_in_full" | "cancelled" | "voided" | "in_default";
  createdAt: number;
}

const T0 = new Date("2026-05-15T08:00:00+08:00").getTime();

const CONTRACTS: ContractFixture[] = [
  {
    contractId: "contracts:1",
    contractNumber: "C-2026-0001",
    lotId: "lots:single-a",
    lotCode: "A-1-1",
    customerId: "customers:1",
    customerFullName: "Cruz",
    kind: "full_payment",
    totalPriceCents: 100_000,
    state: "active",
    createdAt: T0 - 60 * 1000,
  },
  {
    contractId: "contracts:2",
    contractNumber: "C-2026-0002",
    lotId: "lots:family-a",
    lotCode: "A-2-1",
    customerId: "customers:2",
    customerFullName: "Dela Cruz",
    kind: "installment",
    totalPriceCents: 500_000,
    state: "active",
    createdAt: T0 - 5 * 60 * 1000,
  },
  {
    contractId: "contracts:3",
    contractNumber: "C-2026-0003",
    lotId: "lots:single-b",
    lotCode: "B-1-1",
    customerId: "customers:3",
    customerFullName: "Reyes",
    kind: "full_payment",
    totalPriceCents: 200_000,
    state: "paid_in_full",
    createdAt: T0 - 10 * 60 * 1000,
  },
];

const LOTS = [
  { _id: "lots:single-a", code: "A-1-1", section: "A", type: "single" },
  { _id: "lots:family-a", code: "A-2-1", section: "A", type: "family" },
  { _id: "lots:single-b", code: "B-1-1", section: "B", type: "single" },
];

beforeEach(() => {
  mockUseQuery.mockReset();
  mockSearchParamsMap.clear();
});

describe("/sales — URL-param drill-down filters (P1-7)", () => {
  it("applies lotType filter from the URL", () => {
    mockSearchParamsMap.set("lotType", "family");
    // First useQuery call → listContracts; second → listLots.
    mockUseQuery
      .mockReturnValueOnce(CONTRACTS)
      .mockReturnValueOnce(LOTS);
    render(<SalesListPage />);
    expect(screen.getByTestId("sales-drilldown-banner")).toBeInTheDocument();
    expect(screen.getByTestId("sales-drill-lotType")).toHaveTextContent(
      /family/,
    );
    // Only the family contract (contracts:2) should render.
    expect(screen.queryByText("C-2026-0001")).toBeNull();
    expect(screen.getByText("C-2026-0002")).toBeInTheDocument();
    expect(screen.queryByText("C-2026-0003")).toBeNull();
  });

  it("applies section filter from the URL", () => {
    mockSearchParamsMap.set("section", "B");
    mockUseQuery
      .mockReturnValueOnce(CONTRACTS)
      .mockReturnValueOnce(LOTS);
    render(<SalesListPage />);
    expect(screen.getByTestId("sales-drill-section")).toHaveTextContent(/B/);
    expect(screen.getByText("C-2026-0003")).toBeInTheDocument();
    expect(screen.queryByText("C-2026-0001")).toBeNull();
    expect(screen.queryByText("C-2026-0002")).toBeNull();
  });

  it("applies from/to date-range filter on createdAt", () => {
    // Range that only includes contracts:1 (createdAt T0 - 60_000).
    // HIGH-D (Epic 5 review): the period + explicit `from`/`to` filter
    // is now pushed into the server query, so the mocked `useQuery`
    // returns the already-filtered set (mirrors what the live
    // `contracts:listContracts` index range scan would return).
    mockSearchParamsMap.set("from", String(T0 - 120 * 1000));
    mockSearchParamsMap.set("to", String(T0 - 30 * 1000));
    mockUseQuery.mockReturnValueOnce([CONTRACTS[0]]);
    render(<SalesListPage />);
    expect(screen.getByTestId("sales-drill-from")).toBeInTheDocument();
    expect(screen.getByTestId("sales-drill-to")).toBeInTheDocument();
    expect(screen.getByText("C-2026-0001")).toBeInTheDocument();
    expect(screen.queryByText("C-2026-0002")).toBeNull();
    expect(screen.queryByText("C-2026-0003")).toBeNull();
  });

  it("composes lotType + section filters together", () => {
    mockSearchParamsMap.set("lotType", "single");
    mockSearchParamsMap.set("section", "A");
    mockUseQuery
      .mockReturnValueOnce(CONTRACTS)
      .mockReturnValueOnce(LOTS);
    render(<SalesListPage />);
    // Only contracts:1 is single + section A.
    expect(screen.getByText("C-2026-0001")).toBeInTheDocument();
    expect(screen.queryByText("C-2026-0002")).toBeNull();
    expect(screen.queryByText("C-2026-0003")).toBeNull();
  });

  it("does not render the banner when no drill-down params are set", () => {
    mockUseQuery.mockReturnValueOnce(CONTRACTS);
    render(<SalesListPage />);
    expect(screen.queryByTestId("sales-drilldown-banner")).toBeNull();
    // All rows render.
    expect(screen.getByText("C-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("C-2026-0002")).toBeInTheDocument();
    expect(screen.getByText("C-2026-0003")).toBeInTheDocument();
  });
});
