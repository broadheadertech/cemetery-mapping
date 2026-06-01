/**
 * Story 2.6 — `OccupantsPanel` component tests.
 *
 * The panel self-fetches `lotId` from the route (via `useParams`)
 * and the caller's auth payload (via `useQuery`), then subscribes to
 * `occupants:listLotOccupants`. We mock the entire surface so the
 * tests stay deterministic and don't require a Convex / Next.js
 * router runtime.
 *
 * Cases:
 *   - Empty state when no occupants returned.
 *   - List render with multiple occupants (dated + undated rows).
 *   - "Add occupant" button is gated on role.
 *   - "Show removed" toggle exposes the removed rows.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

interface ListedOccupantRow {
  occupantId: string;
  name: string;
  dateOfInterment: number | undefined;
  relationshipToOwner: string;
  notes: string | undefined;
  isRemoved: boolean;
  removedReason: string | undefined;
  createdAt: number;
}

interface AuthPayload {
  userId: string;
  user: { name?: string; email?: string };
  roles: string[];
}

// Hoisted state that the mocks read from. Each test sets these via
// the `setMockState` helper before rendering.
const state: {
  lotId: string | undefined;
  auth: AuthPayload | null | undefined;
  occupants: ListedOccupantRow[] | undefined;
} = {
  lotId: "lots:test",
  auth: { userId: "u1", user: {}, roles: ["office_staff"] },
  occupants: [],
};

vi.mock("next/navigation", () => ({
  useParams: () => (state.lotId !== undefined ? { lotId: state.lotId } : {}),
}));

vi.mock("convex/react", () => ({
  useQuery: (
    ref: { _name?: string } | unknown,
    args: unknown,
  ): unknown => {
    // The ref's serialised name is encoded via `makeFunctionReference`
    // — we can't introspect it reliably, so we dispatch on the args
    // shape: `{}` is auth, `{ lotId, includeRemoved? }` is the list.
    if (args === "skip") return undefined;
    if (typeof args === "object" && args !== null && "lotId" in args) {
      return state.occupants;
    }
    return state.auth;
  },
  useMutation: () => async () => ({ occupantId: "occupants:new" }),
}));

import { OccupantsPanel } from "./OccupantsPanel";

function setMockState(opts: {
  lotId?: string | undefined;
  auth?: AuthPayload | null;
  occupants?: ListedOccupantRow[] | undefined;
}): void {
  if ("lotId" in opts) state.lotId = opts.lotId;
  if ("auth" in opts) state.auth = opts.auth ?? null;
  if ("occupants" in opts) state.occupants = opts.occupants;
}

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();

describe("OccupantsPanel", () => {
  beforeEach(() => {
    cleanup();
    // Reset state to defaults.
    setMockState({
      lotId: "lots:test",
      auth: { userId: "u1", user: {}, roles: ["office_staff"] },
      occupants: [],
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("renders the calm empty state when no occupants exist", () => {
    setMockState({ occupants: [] });
    render(<OccupantsPanel />);
    expect(screen.getByTestId("occupants-empty")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Occupants$/i }),
    ).toBeInTheDocument();
  });

  it("renders a list with one row per occupant (dated + undated)", () => {
    setMockState({
      occupants: [
        {
          occupantId: "occupants:1",
          name: "Maria Santos",
          dateOfInterment: T0 - 365 * 24 * 60 * 60 * 1000,
          relationshipToOwner: "Spouse",
          notes: undefined,
          isRemoved: false,
          removedReason: undefined,
          createdAt: T0 - 100 * 24 * 60 * 60 * 1000,
        },
        {
          occupantId: "occupants:2",
          name: "Cruz Santos",
          dateOfInterment: undefined,
          relationshipToOwner: "Grandparent",
          notes: undefined,
          isRemoved: false,
          removedReason: undefined,
          createdAt: T0 - 50 * 24 * 60 * 60 * 1000,
        },
      ],
    });
    render(<OccupantsPanel />);
    expect(screen.getByTestId("occupants-list")).toBeInTheDocument();
    expect(screen.getAllByTestId("occupants-row")).toHaveLength(2);
    expect(screen.getByText(/Maria Santos/)).toBeInTheDocument();
    expect(screen.getByText(/Cruz Santos/)).toBeInTheDocument();
    expect(screen.getByText(/Date unknown/i)).toBeInTheDocument();
  });

  it("shows the Add occupant button for office_staff", () => {
    setMockState({
      auth: { userId: "u1", user: {}, roles: ["office_staff"] },
    });
    render(<OccupantsPanel />);
    expect(screen.getByTestId("occupants-add-button")).toBeInTheDocument();
  });

  it("hides the Add occupant button for field_worker", () => {
    setMockState({
      auth: { userId: "u1", user: {}, roles: ["field_worker"] },
    });
    render(<OccupantsPanel />);
    expect(screen.queryByTestId("occupants-add-button")).toBeNull();
  });

  it("hides the Add occupant button when no lotId is available (e.g. no router context)", () => {
    setMockState({ lotId: undefined });
    render(<OccupantsPanel />);
    expect(screen.queryByTestId("occupants-add-button")).toBeNull();
    // Empty-state placeholder is preserved.
    expect(screen.getByTestId("occupants-empty")).toBeInTheDocument();
  });

  it("renders removed rows with the line-through style when included", () => {
    setMockState({
      occupants: [
        {
          occupantId: "occupants:r",
          name: "Removed Person",
          dateOfInterment: T0,
          relationshipToOwner: "Spouse",
          notes: undefined,
          isRemoved: true,
          removedReason: "Data entry mistake",
          createdAt: T0,
        },
      ],
    });
    render(<OccupantsPanel />);
    const row = screen.getByTestId("occupants-row");
    expect(row).toHaveAttribute("data-removed", "true");
  });
});
