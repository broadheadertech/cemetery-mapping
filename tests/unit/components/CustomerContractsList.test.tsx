/**
 * Story 9.2 — `<CustomerContractsList>` component tests.
 *
 * Coverage of the dashboard card surface:
 *   - Loading skeleton renders when the query is still resolving
 *     (`undefined` / no prop).
 *   - Empty-state copy renders when the customer has 0 contracts.
 *   - Non-empty list renders one card per contract with peso-formatted
 *     balance, lot reference, and a link to the detail page.
 *   - StatusPill maps `paid_in_full` / `in_default` / `cancelled` /
 *     active+balance / active+0-balance to the correct pill vocabulary
 *     (NFR-A2).
 *   - Installment contracts surface the "X of Y installments remaining"
 *     line + next due date; full-payment contracts surface the
 *     contract type instead.
 *   - The balance figure is wrapped in `<ReactiveHighlight>` (asserted
 *     by `data-testid="reactive-highlight"`).
 *
 * The `useQuery` hook is mocked at the module level so the test can
 * inject precise data without going through Convex.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

const useQueryMock = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CustomerContractsList } from "@/components/CustomerPortal/CustomerContractsList";
import type { CustomerContractListRow } from "@/components/CustomerPortal/CustomerContractsList";

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

function makeRow(
  overrides: Partial<CustomerContractListRow> = {},
): CustomerContractListRow {
  return {
    contractId: "contracts:c1",
    contractNumber: "CN-0001",
    kind: "installment",
    state: "active",
    totalPriceCents: 1_000_000,
    outstandingBalanceCents: 500_000,
    nextDueDate: T0 + 30 * 24 * 60 * 60 * 1000,
    remainingInstallments: 5,
    totalInstallments: 12,
    createdAt: T0 - 100_000,
    lot: {
      lotId: "lots:l1",
      code: "A-1",
      section: "D",
      block: "12",
      row: "3",
      centroid: { lat: 14.5, lng: 121.0 },
    },
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  useQueryMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CustomerContractsList — loading", () => {
  it("renders a skeleton while the query is undefined", () => {
    useQueryMock.mockReturnValue(undefined);
    render(<CustomerContractsList />);
    const list = screen.getByLabelText("Loading your contracts");
    expect(list.getAttribute("aria-busy")).toBe("true");
  });
});

describe("CustomerContractsList — empty state", () => {
  it("renders the reverent empty copy when contracts is []", () => {
    render(<CustomerContractsList contracts={[]} />);
    expect(
      screen.getByText("The estate holds no active contracts in your name."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Should this seem in error, please write to the Estate Office.",
      ),
    ).toBeTruthy();
  });
});

describe("CustomerContractsList — non-empty list", () => {
  it("renders one card per contract with peso-formatted balance", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({
            contractId: "contracts:c1",
            outstandingBalanceCents: 250_000,
          }),
          makeRow({
            contractId: "contracts:c2",
            contractNumber: "CN-0002",
            outstandingBalanceCents: 0,
            state: "paid_in_full",
            remainingInstallments: 0,
            totalInstallments: 12,
          }),
        ]}
      />,
    );
    const list = screen.getByLabelText("Contracts held in your name");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Peso formatter writes ₱2,500.00 / ₱0.00 for the two balances.
    expect(within(list).getByText("₱2,500.00")).toBeTruthy();
    expect(within(list).getByText("₱0.00")).toBeTruthy();
  });

  it("links each card to /portal/contracts/[contractId]", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({ contractId: "contracts:abc" }),
        ]}
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/portal/contracts/contracts:abc");
  });

  it("renders the lot reference (code + section + block + row)", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({
            lot: {
              lotId: "lots:l1",
              code: "A-1",
              section: "D",
              block: "12",
              row: "3",
              centroid: { lat: 0, lng: 0 },
            },
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/A-1 · Section D · Block 12 · Row 3/),
    ).toBeTruthy();
  });

  it("wraps the balance in <ReactiveHighlight> (data-testid present)", () => {
    render(
      <CustomerContractsList
        contracts={[makeRow({ outstandingBalanceCents: 123_400 })]}
      />,
    );
    const highlights = screen.getAllByTestId("reactive-highlight");
    expect(highlights.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CustomerContractsList — StatusPill mapping", () => {
  it("maps state=paid_in_full → Paid pill", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({ state: "paid_in_full", outstandingBalanceCents: 0 }),
        ]}
      />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Paid");
  });

  it("maps state=in_default → Defaulted pill", () => {
    render(
      <CustomerContractsList
        contracts={[makeRow({ state: "in_default" })]}
      />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Defaulted",
    );
  });

  it("maps state=cancelled → Cancelled pill", () => {
    render(
      <CustomerContractsList
        contracts={[makeRow({ state: "cancelled" })]}
      />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Cancelled",
    );
  });

  it("maps active + balance=0 → Current pill", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({ state: "active", outstandingBalanceCents: 0 }),
        ]}
      />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Current",
    );
  });

  it("maps active + balance>0 → Due pill", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({ state: "active", outstandingBalanceCents: 1 }),
        ]}
      />,
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("Due");
  });
});

describe("CustomerContractsList — installment vs. full-payment surface", () => {
  it("shows X of Y installments remaining for installment contracts", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({
            kind: "installment",
            remainingInstallments: 4,
            totalInstallments: 12,
          }),
        ]}
      />,
    );
    expect(screen.getByText(/4 of 12 remaining/)).toBeTruthy();
  });

  it("shows the contract type instead of installments for full-payment contracts", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({
            kind: "full_payment",
            remainingInstallments: undefined,
            totalInstallments: undefined,
            nextDueDate: undefined,
          }),
        ]}
      />,
    );
    expect(screen.getByText("Full payment")).toBeTruthy();
  });

  it("renders the unavailable-lot fallback when lot is null", () => {
    render(
      <CustomerContractsList
        contracts={[makeRow({ lot: null })]}
      />,
    );
    expect(screen.getByText("Lot details unavailable")).toBeTruthy();
  });
});

describe("CustomerContractsList — touch target + accessibility", () => {
  it("uses min-h-[88px] on each card so the touch target exceeds 48px", () => {
    render(<CustomerContractsList contracts={[makeRow()]} />);
    const link = screen.getByRole("link");
    // The Tailwind class string must include the min-height utility so
    // the rendered card meets NFR-A4. We can't assert pixel size in
    // JSDOM, but the class presence is a load-bearing static signal.
    expect(link.className).toMatch(/min-h-\[88px\]/);
  });

  it("each card carries a descriptive aria-label", () => {
    render(
      <CustomerContractsList
        contracts={[
          makeRow({
            contractNumber: "CN-0042",
            outstandingBalanceCents: 750_000,
          }),
        ]}
      />,
    );
    const link = screen.getByRole("link");
    const label = link.getAttribute("aria-label") ?? "";
    expect(label).toContain("CN-0042");
    expect(label).toContain("₱7,500.00");
  });
});
