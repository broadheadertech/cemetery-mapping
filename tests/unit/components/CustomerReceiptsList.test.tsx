/**
 * Story 9.3 — `<CustomerReceiptsList>` component tests.
 *
 * Coverage of the customer-portal receipts card surface:
 *   - Loading skeleton renders when the query is still resolving
 *     (`undefined` / no prop).
 *   - Empty-state copy renders when the customer has 0 receipts.
 *   - Non-empty list renders one card per receipt with the peso-
 *     formatted amount, receipt number, contract number, and a link
 *     to the detail page.
 *   - Voided receipts show a `Voided` badge with the role="status"
 *     accessibility hook.
 *   - The `pdfReady` flag controls the "Receipt is being generated…"
 *     vs. "PDF available" affordance copy.
 *   - The amount cell is wrapped in `<ReactiveHighlight>` so the
 *     `data-testid="reactive-highlight"` selector resolves.
 *   - Touch-target class signal (NFR-A4) — `min-h-[88px]` present.
 *
 * The `useQuery` hook is mocked at the module level so the test can
 * inject precise data without going through Convex; the pattern
 * mirrors `CustomerContractsList.test.tsx` exactly.
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

import { CustomerReceiptsList } from "@/components/CustomerPortal/CustomerReceiptsList";
import type { CustomerReceiptListRow } from "@/components/CustomerPortal/CustomerReceiptsList";

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

function makeRow(
  overrides: Partial<CustomerReceiptListRow> = {},
): CustomerReceiptListRow {
  return {
    receiptId: "receipts:r1",
    receiptNumber: "OR-0000123",
    receiptSerial: 123,
    issuedAt: T0 - 100,
    amountCents: 500_000,
    paymentId: "payments:p1",
    contractId: "contracts:c1",
    contractNumber: "CN-0001",
    isVoided: false,
    voidedAt: null,
    pdfReady: true,
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

describe("CustomerReceiptsList — loading", () => {
  it("renders a skeleton while the query is undefined", () => {
    useQueryMock.mockReturnValue(undefined);
    render(<CustomerReceiptsList />);
    const list = screen.getByLabelText("Loading your receipts");
    expect(list.getAttribute("aria-busy")).toBe("true");
  });
});

describe("CustomerReceiptsList — empty state", () => {
  it("renders the reverent empty copy when receipts is []", () => {
    render(<CustomerReceiptsList receipts={[]} />);
    expect(
      screen.getByText("The estate holds no receipts in your name yet."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Receipts will rest here once the Estate Office records a contribution/,
      ),
    ).toBeTruthy();
  });
});

describe("CustomerReceiptsList — non-empty list", () => {
  it("renders one card per receipt with peso-formatted amount", () => {
    render(
      <CustomerReceiptsList
        receipts={[
          makeRow({ receiptId: "receipts:r1", amountCents: 250_000 }),
          makeRow({
            receiptId: "receipts:r2",
            receiptNumber: "OR-0000124",
            amountCents: 100_000,
          }),
        ]}
      />,
    );
    const list = screen.getByLabelText("Receipts held in your name");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(list).getByText("₱2,500.00")).toBeTruthy();
    expect(within(list).getByText("₱1,000.00")).toBeTruthy();
  });

  it("links each card to /portal/receipts/[receiptId]", () => {
    render(
      <CustomerReceiptsList
        receipts={[makeRow({ receiptId: "receipts:abc" })]}
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/portal/receipts/receipts:abc");
  });

  it("renders the receipt number + contract number on the card", () => {
    render(
      <CustomerReceiptsList
        receipts={[
          makeRow({
            receiptNumber: "OR-0000999",
            contractNumber: "CN-0042",
          }),
        ]}
      />,
    );
    expect(screen.getByText("OR-0000999")).toBeTruthy();
    expect(screen.getByText(/Contract CN-0042/)).toBeTruthy();
  });

  it("wraps the amount in <ReactiveHighlight> (data-testid present)", () => {
    render(
      <CustomerReceiptsList
        receipts={[makeRow({ amountCents: 123_400 })]}
      />,
    );
    const highlights = screen.getAllByTestId("reactive-highlight");
    expect(highlights.length).toBeGreaterThanOrEqual(1);
  });
});

describe("CustomerReceiptsList — voided badge", () => {
  it("shows the Voided badge with role=status for voided receipts", () => {
    render(
      <CustomerReceiptsList
        receipts={[
          makeRow({
            receiptId: "receipts:voided",
            isVoided: true,
            voidedAt: T0 - 500,
          }),
        ]}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-label")).toBe("Voided receipt");
    expect(status.textContent).toBe("Voided");
  });

  it("omits the badge for non-voided receipts", () => {
    render(
      <CustomerReceiptsList
        receipts={[makeRow({ isVoided: false })]}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("CustomerReceiptsList — PDF readiness affordance", () => {
  it("shows 'PDF available' when pdfReady is true", () => {
    render(
      <CustomerReceiptsList receipts={[makeRow({ pdfReady: true })]} />,
    );
    expect(screen.getByText(/PDF ready for keeping/)).toBeTruthy();
  });

  it("shows the 'Receipt is being generated' copy when pdfReady is false", () => {
    render(
      <CustomerReceiptsList receipts={[makeRow({ pdfReady: false })]} />,
    );
    expect(screen.getByText(/The estate is preparing your receipt/)).toBeTruthy();
  });
});

describe("CustomerReceiptsList — touch target + accessibility", () => {
  it("uses min-h-[88px] on each card so the touch target exceeds 48px", () => {
    render(<CustomerReceiptsList receipts={[makeRow()]} />);
    const link = screen.getByRole("link");
    expect(link.className).toMatch(/min-h-\[88px\]/);
  });

  it("each card carries a descriptive aria-label", () => {
    render(
      <CustomerReceiptsList
        receipts={[
          makeRow({
            receiptNumber: "OR-0000777",
            amountCents: 350_000,
          }),
        ]}
      />,
    );
    const link = screen.getByRole("link");
    const label = link.getAttribute("aria-label") ?? "";
    expect(label).toContain("OR-0000777");
    expect(label).toContain("₱3,500.00");
  });

  it("aria-label includes (voided) for voided receipts", () => {
    render(
      <CustomerReceiptsList
        receipts={[
          makeRow({
            receiptNumber: "OR-VOIDED-1",
            isVoided: true,
          }),
        ]}
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("aria-label") ?? "").toContain("(voided)");
  });
});
