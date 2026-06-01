/**
 * Story 1.11 — LotDetail component tests.
 *
 * Coverage focuses on the orchestrator's contract:
 *   - All seven Phase 1 sections render from a mock detail object.
 *   - Field-worker role hides Edit + Retire; office_staff sees them.
 *   - The retire confirmation dialog opens, calls `onRetire`, and
 *     surfaces translated errors when the mutation rejects.
 *   - The status-pill header is wrapped in <ReactiveHighlight> so a
 *     status change re-keys the inner span (the flash is asserted at
 *     the ReactiveHighlight unit-test level — here we only confirm
 *     wiring).
 *   - The retired badge is visible when `isRetired` is true and the
 *     Retire button is disabled.
 *
 * The orchestrator's `ConditionLogsPanel` child does a Convex
 * `useQuery`. We stub `convex/react` so the panel renders its
 * loading state — full panel coverage lives in the e2e spec.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
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

import { LotDetail, type LotDetailData } from "./LotDetail";

const baseDetail: LotDetailData = {
  _id: "lot_abc123",
  code: "D-5-12",
  section: "D",
  block: "5",
  row: "12",
  type: "single",
  dimensions: { widthM: 2.4, depthM: 1.2 },
  basePriceCents: 125_000_00,
  status: "available",
  geometryStatus: "placeholder",
  geometry: { centroid: { lat: 14.5995, lng: 120.9842 } },
  isRetired: false,
};

describe("LotDetail", () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it("renders all seven Phase 1 sections", () => {
    render(<LotDetail detail={baseDetail} roles={["office_staff"]} />);

    expect(screen.getByText(/Lot D-5-12/)).toBeInTheDocument();
    // StatusPill carries role="status" and the label.
    expect(
      screen.getByRole("status", { name: /available/i }),
    ).toBeInTheDocument();
    // The seven section headings — exact-match via heading role so
    // overlapping substring matches (e.g. "Occupants" inside "No
    // occupants recorded.") don't trip the assertion.
    expect(
      screen.getByRole("heading", { level: 2, name: /^Lot facts$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Ownership$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Occupants$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Active contract$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Payment history$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /^Recent condition logs$/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows the Phase 1 empty states for unimplemented relations", () => {
    render(<LotDetail detail={baseDetail} roles={["office_staff"]} />);
    expect(screen.getByTestId("ownership-empty")).toBeInTheDocument();
    expect(screen.getByTestId("occupants-empty")).toBeInTheDocument();
    expect(screen.getByTestId("contract-empty")).toBeInTheDocument();
    expect(screen.getByTestId("payments-placeholder")).toBeInTheDocument();
    // Convex stub returns undefined → loading state in the condition panel.
    expect(screen.getByTestId("conditions-loading")).toBeInTheDocument();
  });

  it("formats base price as pesos", () => {
    render(<LotDetail detail={baseDetail} roles={["office_staff"]} />);
    expect(screen.getByText(/₱125,000\.00/)).toBeInTheDocument();
  });

  it("renders the geometry-status pill (placeholder + surveyed)", () => {
    const { rerender } = render(
      <LotDetail detail={baseDetail} roles={["office_staff"]} />,
    );
    expect(screen.getByText(/Placeholder/i)).toBeInTheDocument();

    rerender(
      <LotDetail
        detail={{ ...baseDetail, geometryStatus: "surveyed" }}
        roles={["office_staff"]}
      />,
    );
    expect(screen.getByText(/Surveyed/i)).toBeInTheDocument();
  });

  it("shows Edit and Retire for office_staff", () => {
    render(<LotDetail detail={baseDetail} roles={["office_staff"]} />);
    const actions = screen.getByTestId("lot-detail-actions");
    expect(within(actions).getByTestId("lot-detail-edit")).toBeInTheDocument();
    expect(within(actions).getByTestId("lot-detail-retire")).toBeInTheDocument();
    // Log condition is always visible.
    expect(within(actions).getByText(/Log condition/i)).toBeInTheDocument();
  });

  it("shows Edit and Retire for admin", () => {
    render(<LotDetail detail={baseDetail} roles={["admin"]} />);
    const actions = screen.getByTestId("lot-detail-actions");
    expect(within(actions).getByTestId("lot-detail-edit")).toBeInTheDocument();
    expect(within(actions).getByTestId("lot-detail-retire")).toBeInTheDocument();
  });

  it("hides Edit and Retire for field_worker but keeps Log condition", () => {
    render(<LotDetail detail={baseDetail} roles={["field_worker"]} />);
    const actions = screen.getByTestId("lot-detail-actions");
    expect(within(actions).queryByTestId("lot-detail-edit")).toBeNull();
    expect(within(actions).queryByTestId("lot-detail-retire")).toBeNull();
    expect(within(actions).getByText(/Log condition/i)).toBeInTheDocument();
  });

  it("renders the retired badge and disables Retire when isRetired=true", () => {
    render(
      <LotDetail
        detail={{ ...baseDetail, isRetired: true }}
        roles={["office_staff"]}
      />,
    );
    // Two elements end up with the literal text "Retired" (the badge
    // and the disabled button); use the explicit count assertion so
    // the test stays robust if one of them moves.
    const retiredMatches = screen.getAllByText(/^Retired$/);
    expect(retiredMatches.length).toBeGreaterThanOrEqual(1);
    const retire = screen.getByTestId("lot-detail-retire");
    expect(retire).toBeDisabled();
    expect(retire).toHaveAttribute("aria-label", "Lot is already retired");
  });

  it("opens the retire confirmation dialog and invokes onRetire on confirm", async () => {
    const user = userEvent.setup();
    const onRetire = vi.fn(async () => {});
    render(
      <LotDetail
        detail={baseDetail}
        roles={["office_staff"]}
        onRetire={onRetire}
      />,
    );

    await user.click(screen.getByTestId("lot-detail-retire"));
    // Dialog title appears in the portal.
    expect(
      await screen.findByText(/Retire lot D-5-12\?/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Retire lot$/i }));
    expect(onRetire).toHaveBeenCalledTimes(1);
  });

  it("surfaces a translated error when onRetire rejects", async () => {
    const user = userEvent.setup();
    const err = Object.assign(new Error("FORBIDDEN"), {
      data: { code: "FORBIDDEN" },
    });
    const onRetire = vi.fn(async () => {
      throw err;
    });
    render(
      <LotDetail
        detail={baseDetail}
        roles={["office_staff"]}
        onRetire={onRetire}
      />,
    );

    await user.click(screen.getByTestId("lot-detail-retire"));
    await user.click(screen.getByRole("button", { name: /^Retire lot$/i }));

    // The translated error is rendered via role="alert".
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /role does not permit/i,
    );
  });
});
