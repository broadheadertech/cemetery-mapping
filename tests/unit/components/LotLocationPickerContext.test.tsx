/**
 * Placing a lot with something to place it against.
 *
 * The picker showed a bare tile map and one marker. Nothing on screen
 * said which way the rows ran, where the garden started, or whether the
 * lot next door had already been placed two metres away — so the only
 * reference was a road layout a hundred metres off, and every position
 * was effectively a guess made confidently.
 *
 * The neighbours are the reference. These tests are about them being
 * the RIGHT neighbours: an unplaced lot has no position to draw, and
 * drawing one on its placeholder centroid would put a phantom grave in
 * the middle of the park for somebody to line up against.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
  useMutation: () => vi.fn(async () => null),
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Leaflet needs a real browser; the chrome around it is what is tested.
vi.mock("leaflet", () => ({ default: {} }));

import { LotLocationPicker } from "@/components/LotLocationPicker/LotLocationPicker";

const AT = { lat: 16.3959, lng: 120.3556 };

function neighbour(over: Record<string, unknown> = {}) {
  return {
    _id: "lots:n1",
    code: "A-02",
    section: "Garden of Faith",
    status: "occupied",
    geometry: { centroid: { lat: AT.lat + 0.00002, lng: AT.lng } },
    geometryStatus: "surveyed",
    ...over,
  };
}

function view() {
  return (
    <LotLocationPicker
      lotId="lots:a"
      lotCode="A-01"
      initial={AT}
      surveyed={false}
    />
  );
}

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("the lots around the one being placed", () => {
  it("counts the ones it can draw", () => {
    useQueryMock.mockReturnValue([neighbour(), neighbour({ _id: "lots:n2" })]);
    render(view());
    expect(screen.getByTestId("picker-context-count")).toHaveTextContent(
      "2 shown",
    );
  });

  it("EXCLUDES lots nobody has placed", () => {
    // Their centroid is a placeholder pointing at the middle of the
    // park. Drawing it would put a phantom grave on screen for somebody
    // to line the real one up against.
    useQueryMock.mockReturnValue([
      neighbour(),
      neighbour({ _id: "lots:n2", geometryStatus: "placeholder" }),
    ]);
    render(view());
    expect(screen.getByTestId("picker-context-count")).toHaveTextContent(
      "1 shown",
    );
  });

  it("excludes the lot being placed from its own context", () => {
    // Otherwise it appears twice — once as the marker being dragged and
    // once as a fixed dot at its old position.
    useQueryMock.mockReturnValue([
      neighbour({ _id: "lots:a", code: "A-01" }),
      neighbour({ _id: "lots:n2" }),
    ]);
    render(view());
    expect(screen.getByTestId("picker-context-count")).toHaveTextContent(
      "1 shown",
    );
  });

  it("says plainly when this is the first lot placed", () => {
    // Distinct from still loading: one means keep waiting, the other
    // means there is genuinely nothing to line up against.
    useQueryMock.mockReturnValue([]);
    render(view());
    expect(screen.getByTestId("picker-context-empty")).toHaveTextContent(
      /first/i,
    );
  });

  it("distinguishes loading from empty", () => {
    useQueryMock.mockReturnValue(undefined);
    render(view());
    expect(screen.getByTestId("picker-context-empty")).toHaveTextContent(
      /loading/i,
    );
  });

  it("reads a window around the lot, not the whole park", () => {
    useQueryMock.mockReturnValue([]);
    render(view());
    const args = useQueryMock.mock.calls[0]![1] as {
      bboxMinLat: number;
      bboxMaxLat: number;
      limit: number;
    };
    expect(args.bboxMinLat).toBeLessThan(AT.lat);
    expect(args.bboxMaxLat).toBeGreaterThan(AT.lat);
    // A few hundred metres, not the cemetery.
    expect(args.bboxMaxLat - args.bboxMinLat).toBeLessThan(0.01);
    expect(args.limit).toBeGreaterThan(0);
  });

  it("can be hidden, for when the marker is under the crowd", () => {
    useQueryMock.mockReturnValue([neighbour()]);
    render(view());
    const toggle = screen.getByTestId("picker-context-toggle");
    expect(toggle).toHaveTextContent(/hide/i);
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent(/show/i);
  });
});

describe("capturing instead of clicking", () => {
  it("offers GPS capture on the screen that asks where the lot is", () => {
    // The screen's whole question is "where is this lot", and its only
    // answer was a click — which means being somewhere else and
    // pointing. Somebody standing at the grave had to go elsewhere to
    // give the better answer.
    useQueryMock.mockReturnValue([]);
    render(view());
    expect(screen.getByTestId("lot-gps-capture")).toBeInTheDocument();
    expect(screen.getByTestId("gps-start")).toHaveTextContent(
      /use my location/i,
    );
  });
});
