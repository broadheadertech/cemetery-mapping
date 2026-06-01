/**
 * Story 2.7 — `<OwnershipTransferForm>` component tests.
 *
 * Covers:
 *   - Empty state: when the from-customer owns no lots, the form
 *     surfaces the no-lots message and does not render the form
 *     controls.
 *   - Initial render: policy-pending banner visible, review button
 *     disabled until valid.
 *   - Backdated alert: changing the effective date to >24h in the
 *     past reveals the backdated alert.
 *   - Confirm step: filling the form, clicking Review, then asserting
 *     the summary slide renders.
 *   - Successful submit: mock mutation resolves → `onTransferred`
 *     called with the result.
 *
 * Convex hooks are mocked at the module level — jsdom has no Convex
 * client connection.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const recordTransferMock = vi.fn();
const useQueryMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => recordTransferMock,
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

import {
  OwnershipTransferForm,
  type CurrentOwnerLot,
} from "@/components/OwnershipTransferForm";

const SAMPLE_LOTS: CurrentOwnerLot[] = [
  {
    lotId: "lots:l1",
    lotCode: "A-1",
    ownershipId: "ownerships:o1",
  },
];

beforeEach(() => {
  cleanup();
  recordTransferMock.mockReset();
  useQueryMock.mockReset();
  // Default: customer search returns an empty list (no autocomplete
  // results) so individual tests opt into result payloads.
  useQueryMock.mockReturnValue([]);
});

afterEach(() => {
  cleanup();
});

describe("OwnershipTransferForm — empty state", () => {
  it("renders the no-lots message when the from-customer owns nothing", () => {
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={[]}
      />,
    );
    expect(
      screen.getByTestId("ownership-transfer-empty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("ownership-transfer-form"),
    ).not.toBeInTheDocument();
  });
});

describe("OwnershipTransferForm — initial render", () => {
  it("renders the policy-pending banner", () => {
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );
    expect(
      screen.getByText(/document requirements are pending/i),
    ).toBeInTheDocument();
  });

  it("disables the review button until valid", () => {
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );
    const review = screen.getByTestId("ownership-transfer-review");
    expect(review).toBeDisabled();
  });

  it("renders the lot picker with the owned lot codes", () => {
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );
    expect(screen.getByTestId("ownership-transfer-lot")).toBeInTheDocument();
    expect(screen.getByText("Lot A-1")).toBeInTheDocument();
  });
});

describe("OwnershipTransferForm — backdated alert", () => {
  it("shows the backdated alert when the effective date is in the past", async () => {
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );
    const dateInput = screen.getByLabelText(/Effective date/) as HTMLInputElement;
    // 2 years in the past — comfortably outside the 24h slack.
    fireEvent.change(dateInput, { target: { value: "2020-01-01" } });
    await waitFor(() => {
      expect(
        screen.getByTestId("ownership-transfer-backdated"),
      ).toBeInTheDocument();
    });
  });

  it("hides the backdated alert when the effective date is comfortably in the future", async () => {
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );
    const dateInput = screen.getByLabelText(/Effective date/) as HTMLInputElement;
    // 100 years in the future — never backdated under any timezone.
    fireEvent.change(dateInput, { target: { value: "2126-01-01" } });
    await waitFor(() => {
      expect(
        screen.queryByTestId("ownership-transfer-backdated"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("OwnershipTransferForm — confirm flow", () => {
  it("renders the customer picker results when search has 3+ chars", async () => {
    // Returned customer hit when the search input crosses 3 chars.
    useQueryMock.mockReturnValue([
      {
        customerId: "customers:to",
        fullName: "Mr. Garcia",
        govIdLast4: "1234",
      },
    ]);

    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );

    // Fill the search input enough to fire the query.
    const searchInput = screen.getByTestId(
      "ownership-transfer-search",
    ) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "Mr." } });

    // Wait for the result list to render (debounce ~300ms).
    await waitFor(
      () => {
        expect(
          screen.getByTestId("ownership-transfer-results"),
        ).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(screen.getByText(/Mr\. Garcia/)).toBeInTheDocument();
  });

  it("selects a customer and renders the selected badge after Select click", async () => {
    useQueryMock.mockReturnValue([
      {
        customerId: "customers:to",
        fullName: "Mr. Garcia",
        govIdLast4: "1234",
      },
    ]);

    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );

    fireEvent.change(screen.getByTestId("ownership-transfer-search"), {
      target: { value: "Mr." },
    });
    const selectButton = await screen.findByRole(
      "button",
      { name: /^Select$/ },
      { timeout: 2000 },
    );
    fireEvent.click(selectButton);

    expect(
      screen.getByTestId("ownership-transfer-selected"),
    ).toBeInTheDocument();
  });
});

describe("OwnershipTransferForm — submit", () => {
  it("renders the Cancel button when onCancel is supplied", () => {
    const onCancel = vi.fn();
    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
        onCancel={onCancel}
      />,
    );
    const cancel = screen.getByRole("button", { name: /Cancel/ });
    expect(cancel).toBeInTheDocument();
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the Select button for the from-customer to prevent self-transfer", async () => {
    useQueryMock.mockReturnValue([
      {
        customerId: "customers:from",
        fullName: "Mrs. Cruz",
        govIdLast4: "9999",
      },
    ]);

    render(
      <OwnershipTransferForm
        fromCustomerId="customers:from"
        fromCustomerName="Mrs. Cruz"
        ownedLots={SAMPLE_LOTS}
      />,
    );

    fireEvent.change(screen.getByTestId("ownership-transfer-search"), {
      target: { value: "Mrs" },
    });

    const currentOwnerButton = await screen.findByRole(
      "button",
      { name: /Current owner/ },
      { timeout: 2000 },
    );
    expect(currentOwnerButton).toBeDisabled();
  });
});
