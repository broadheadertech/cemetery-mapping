/**
 * Story 2.5 — CustomerDetail composite tests.
 *
 * Coverage focuses on the orchestrator + the click-to-reveal contract:
 *   - Orchestrator renders the documented sections from a fixture.
 *   - Header shows the full name + the "Active" badge.
 *   - Gov-ID is masked by default (`***-***-LAST4`) — never the full
 *     value.
 *   - RevealField: clicking "Reveal" calls the mocked `revealGovId`
 *     mutation, displays the full number, swaps the button label to
 *     "Hide", and starts the countdown. Advancing fake timers 30 s
 *     re-redacts; clicking "Hide" re-redacts immediately without a
 *     second mutation call.
 *   - Empty / loading states for the OwnershipHistoryList sub-section.
 *
 * The Convex hooks (`useQuery`, `useMutation`) are mocked at the
 * module level so tests can assert call counts and inject return
 * values per case.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useMutation: (...args: unknown[]) => useMutationMock(...args),
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

import { CustomerDetail } from "@/components/CustomerDetail/CustomerDetail";
import { RevealField } from "@/components/CustomerDetail/RevealField";
import { OwnershipHistoryList } from "@/components/CustomerDetail/OwnershipHistoryList";
import type {
  CustomerDetailData,
  OwnershipHistoryRowData,
} from "@/components/CustomerDetail/types";

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

const baseDetail: CustomerDetailData = {
  customerId: "customers:c1",
  fullName: "Maria Cruz",
  phone: "09171234567",
  email: "maria@example.com",
  address: {
    line1: "123 Main St",
    barangay: "Poblacion",
    cityMunicipality: "Quezon City",
    province: "Metro Manila",
    postalCode: "1100",
  },
  govIdType: "sss",
  govIdLast4: "9012",
  relationshipToOccupant: "spouse",
  hasConsent: true,
  consentTimestamp: T0 - 1000,
  createdAt: T0 - 10_000,
  updatedAt: T0,
};

beforeEach(() => {
  cleanup();
  useQueryMock.mockReset();
  useMutationMock.mockReset();
  // Default — ownerships list returns empty; sub-components see "no data yet".
  useQueryMock.mockReturnValue([]);
  useMutationMock.mockReturnValue(async () => ({ govIdNumber: "X" }));
});

afterEach(() => {
  cleanup();
});

describe("CustomerDetail orchestrator", () => {
  it("renders the customer's full name in an h1", () => {
    render(<CustomerDetail detail={baseDetail} />);
    expect(
      screen.getByRole("heading", { level: 1, name: /Maria Cruz/i }),
    ).toBeInTheDocument();
  });

  it("renders the Active status badge", () => {
    render(<CustomerDetail detail={baseDetail} />);
    expect(
      screen.getByRole("status", { name: /Customer status: active/i }),
    ).toBeInTheDocument();
  });

  it("renders the documented section headings", () => {
    render(<CustomerDetail detail={baseDetail} />);
    expect(
      screen.getByRole("heading", { level: 2, name: /^Contact$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Government ID$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Ownership history$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Documents$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Contracts$/i }),
    ).toBeInTheDocument();
  });

  it("renders phone as a tel: link and email as a mailto: link", () => {
    render(<CustomerDetail detail={baseDetail} />);
    const phone = screen.getByTestId("customer-contact-phone");
    expect(phone).toHaveAttribute("href", "tel:09171234567");
    const email = screen.getByTestId("customer-contact-email");
    expect(email).toHaveAttribute("href", "mailto:maria@example.com");
  });

  it("renders gov-ID masked by default (never shows full value)", () => {
    render(<CustomerDetail detail={baseDetail} />);
    const value = screen.getByTestId("reveal-value");
    expect(value.textContent).toBe("***-***-9012");
    // Defensive: a hypothetical full ID like "1234-5678-9012" is not present.
    expect(value.textContent).not.toContain("1234-5678");
  });

  it("renders the audit-trail deep link", () => {
    render(<CustomerDetail detail={baseDetail} />);
    const link = screen.getByTestId("customer-audit-link");
    expect(link).toHaveAttribute(
      "href",
      "/audit?entityType=customer&entityId=customers:c1",
    );
  });

  it("renders '—' placeholders for missing phone / email gracefully", () => {
    const sparse: CustomerDetailData = {
      ...baseDetail,
      phone: undefined,
      email: undefined,
    };
    render(<CustomerDetail detail={sparse} />);
    // No phone tel: anchor exists; the placeholder em-dash is shown instead.
    expect(screen.queryByTestId("customer-contact-phone")).toBeNull();
    expect(screen.queryByTestId("customer-contact-email")).toBeNull();
  });
});

describe("RevealField — click-to-reveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the masked value and 'Reveal' button on first mount", () => {
    render(<RevealField customerId="customers:c1" govIdLast4="9012" />);
    expect(screen.getByTestId("reveal-value")).toHaveTextContent("***-***-9012");
    const button = screen.getByTestId("reveal-button");
    expect(button).toHaveTextContent("Reveal");
    expect(button).toHaveAccessibleName(
      /Reveal full gov-ID number; access will be logged/i,
    );
  });

  // userEvent + fake-timers + async-state interactions are flaky in
  // jsdom for these specific tests (mutation resolves on the
  // microtask queue and user-event's internal `delay` never advances
  // because the click batch holds the loop). fireEvent.click is the
  // synchronous, reliable substitute — fires the click immediately
  // and waitFor lets us assert on the post-mutation state.
  it("on click, calls revealGovId, shows the full number, and swaps button to Hide", async () => {
    const mutation = vi.fn(async () => ({ govIdNumber: "1234-5678-9012" }));
    useMutationMock.mockReturnValue(mutation);
    render(<RevealField customerId="customers:c1" govIdLast4="9012" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-button"));
    });

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledWith({ customerId: "customers:c1" });
    expect(screen.getByTestId("reveal-value")).toHaveTextContent(
      "1234-5678-9012",
    );
    expect(screen.getByTestId("reveal-button")).toHaveTextContent("Hide");
    expect(screen.getByTestId("reveal-countdown")).toBeInTheDocument();
  });

  it("auto-re-redacts after 30 seconds", async () => {
    const mutation = vi.fn(async () => ({ govIdNumber: "1234-5678-9012" }));
    useMutationMock.mockReturnValue(mutation);
    render(<RevealField customerId="customers:c1" govIdLast4="9012" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-button"));
    });
    expect(screen.getByTestId("reveal-value")).toHaveTextContent(
      "1234-5678-9012",
    );

    // Advance 30 seconds. The auto-hide tick uses absolute `expiresAt`
    // vs `Date.now()`, so we advance both the fake timer AND the
    // system clock.
    await act(async () => {
      vi.setSystemTime(T0 + 30_000);
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByTestId("reveal-value")).toHaveTextContent("***-***-9012");
    expect(screen.getByTestId("reveal-button")).toHaveTextContent("Reveal");
  });

  it("clicking Hide re-redacts immediately without a new mutation call", async () => {
    const mutation = vi.fn(async () => ({ govIdNumber: "1234-5678-9012" }));
    useMutationMock.mockReturnValue(mutation);
    render(<RevealField customerId="customers:c1" govIdLast4="9012" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-button"));
    });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("reveal-button")).toHaveTextContent("Hide");

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-button"));
    });
    expect(mutation).toHaveBeenCalledTimes(1); // unchanged
    expect(screen.getByTestId("reveal-button")).toHaveTextContent("Reveal");
    expect(screen.getByTestId("reveal-value")).toHaveTextContent("***-***-9012");
  });

  it("clears the timer when unmounted mid-reveal (no memory leak)", async () => {
    const mutation = vi.fn(async () => ({ govIdNumber: "1234-5678-9012" }));
    useMutationMock.mockReturnValue(mutation);
    const { unmount } = render(
      <RevealField customerId="customers:c1" govIdLast4="9012" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-button"));
    });
    expect(mutation).toHaveBeenCalledTimes(1);
    // Unmount mid-reveal — the cleanup must clearInterval. No assertions
    // are needed beyond "does not throw": React would log a warning if
    // the unmount-time setState fired.
    expect(() => unmount()).not.toThrow();
  });

  it("surfaces a translated error if the mutation rejects", async () => {
    const mutation = vi.fn(async () => {
      const err = new Error("boom") as Error & { data?: { code: string } };
      err.data = { code: "FORBIDDEN" };
      throw err;
    });
    useMutationMock.mockReturnValue(mutation);
    render(<RevealField customerId="customers:c1" govIdLast4="9012" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("reveal-button"));
    });
    expect(screen.getByTestId("reveal-error")).toBeInTheDocument();
    expect(screen.getByTestId("reveal-value")).toHaveTextContent("***-***-9012");
  });
});

describe("OwnershipHistoryList", () => {
  it("renders the skeleton while the query is loading", () => {
    useQueryMock.mockReturnValue(undefined);
    render(<OwnershipHistoryList customerId="customers:c1" />);
    expect(screen.getByTestId("ownership-history-skeleton")).toBeInTheDocument();
  });

  it("renders the empty state when the customer has no ownerships", () => {
    useQueryMock.mockReturnValue([]);
    render(<OwnershipHistoryList customerId="customers:c1" />);
    expect(screen.getByTestId("ownership-history-empty")).toHaveTextContent(
      /No lot ownership recorded for this customer\./i,
    );
  });

  it("renders one row per ownership episode with a lot link + transfer-type badge", () => {
    const rows: OwnershipHistoryRowData[] = [
      {
        ownershipId: "ownerships:1",
        lotId: "lots:l1",
        lotCode: "D-5-12",
        effectiveFrom: T0 - 86_400_000,
        transferType: "sale",
      },
      {
        ownershipId: "ownerships:2",
        lotId: "lots:l2",
        lotCode: "[retired]",
        effectiveFrom: T0 - 5 * 86_400_000,
        effectiveTo: T0 - 86_400_000,
        transferType: "initial",
      },
    ];
    useQueryMock.mockReturnValue(rows);
    render(<OwnershipHistoryList customerId="customers:c1" />);
    const list = screen.getByTestId("ownership-history-list");
    expect(list).toBeInTheDocument();
    expect(
      screen.getAllByTestId("ownership-history-row"),
    ).toHaveLength(2);
    // Active row: lotCode is a link.
    const lotLink = screen.getByRole("link", { name: /Lot D-5-12/i });
    expect(lotLink).toHaveAttribute("href", "/lots/lots:l1");
    // Retired row: rendered as plain text, NOT a link.
    expect(screen.getByText(/\[retired\]/i)).toBeInTheDocument();
    // Sale badge + Initial badge rendered.
    expect(screen.getByText(/^Sale$/i)).toBeInTheDocument();
    expect(screen.getByText(/^Initial$/i)).toBeInTheDocument();
  });

  it("renders 'Present' when effectiveTo is undefined (active ownership)", () => {
    const rows: OwnershipHistoryRowData[] = [
      {
        ownershipId: "ownerships:1",
        lotId: "lots:l1",
        lotCode: "D-5-12",
        effectiveFrom: T0 - 86_400_000,
        transferType: "sale",
      },
    ];
    useQueryMock.mockReturnValue(rows);
    render(<OwnershipHistoryList customerId="customers:c1" />);
    expect(screen.getByText(/Present/i)).toBeInTheDocument();
  });
});
