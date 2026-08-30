/**
 * The map must survive its own data loading.
 *
 * Zooming the Leaflet map reloaded it. Every zoom changes the bbox,
 * which changes the query args, which makes Convex's `useQuery` return
 * `undefined` again — and the map replaced itself with "Loading map…"
 * on `undefined`. Leaflet was unmounted and rebuilt on every zoom step,
 * refetching its tiles and resetting the view, so the gesture appeared
 * to reload the page underneath you.
 *
 * Two more of the same shape were sitting next to it: an empty viewport
 * swapped the map for a message with no zoom control (no way back out
 * but a page reload), and panning into placeholder-only lots flipped
 * the renderer from Leaflet to SVG mid-gesture.
 *
 * None of these throw. They just make the map unusable, so they are
 * checked by identity — the same DOM node before and after — rather
 * than by anything the eye would catch in a screenshot.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

// Leaflet needs a real browser. The identity of the node standing in
// for it is the whole point: if it is torn down and remade, the test
// sees a different element.
vi.mock("next/dynamic", () => ({
  default: () =>
    function LeafletStub(props: { lots: unknown[] }) {
      return (
        <div data-testid="leaflet" data-lots={(props.lots ?? []).length}>
          leaflet
        </div>
      );
    },
}));

import { LotMap } from "@/components/LotMap/LotMap";

const BBOX = {
  bboxMinLat: 16.39,
  bboxMaxLat: 16.4,
  bboxMinLng: 120.35,
  bboxMaxLng: 120.36,
};

function lot(over: Record<string, unknown> = {}) {
  return {
    _id: "lots:a",
    code: "A-01",
    section: "Garden of Faith",
    block: "1",
    row: "1",
    type: "single",
    status: "available",
    geometry: {
      centroid: { lat: 16.395, lng: 120.355 },
      polygon: [],
      bboxMinLat: 16.395,
      bboxMaxLat: 16.395,
      bboxMinLng: 120.355,
      bboxMaxLng: 120.355,
    },
    geometryStatus: "surveyed",
    ...over,
  };
}

beforeEach(() => {
  useQueryMock.mockReset();
});

describe("zooming the map", () => {
  it("KEEPS the map mounted while the new viewport loads", () => {
    // The reported bug, in one assertion: the same node before and
    // after. A new node means Leaflet was rebuilt, its tiles refetched
    // and its view reset — which is what "it reloads" looked like.
    useQueryMock.mockReturnValue([lot()]);
    const { rerender } = render(
      <LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />,
    );
    const before = screen.getByTestId("leaflet");

    // The zoom: new bbox, query in flight.
    useQueryMock.mockReturnValue(undefined);
    rerender(<LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />);

    const during = screen.getByTestId("leaflet");
    expect(during).toBe(before);
    expect(screen.queryByTestId("map-loading")).toBeNull();
  });

  it("says it is updating without covering the map", () => {
    useQueryMock.mockReturnValue([lot()]);
    const { rerender } = render(
      <LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />,
    );
    useQueryMock.mockReturnValue(undefined);
    rerender(<LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />);

    expect(screen.getByTestId("map-refreshing")).toBeInTheDocument();
    expect(screen.getByTestId("leaflet")).toBeInTheDocument();
  });

  it("still blocks before the very first result", () => {
    // There is genuinely nothing to show yet, and no map to protect.
    useQueryMock.mockReturnValue(undefined);
    render(<LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />);
    expect(screen.getByTestId("map-loading")).toBeInTheDocument();
  });

  it("keeps the map when the new viewport turns out to be EMPTY", () => {
    // The trap that had no way out: the empty-state box has no zoom
    // control, so zooming into a bare corner stranded you there.
    useQueryMock.mockReturnValue([lot()]);
    const { rerender } = render(
      <LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />,
    );
    const before = screen.getByTestId("leaflet");

    useQueryMock.mockReturnValue([]);
    rerender(<LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />);

    expect(screen.getByTestId("leaflet")).toBe(before);
    expect(screen.queryByTestId("map-empty")).toBeNull();
    expect(screen.getByTestId("map-empty-overlay")).toBeInTheDocument();
  });

  it("does not swap Leaflet for the SVG renderer mid-gesture", () => {
    // Auto mode picks Leaflet once anything is surveyed. Panning into
    // placeholder-only lots used to un-pick it and tear the map down.
    useQueryMock.mockReturnValue([lot()]);
    const { rerender } = render(<LotMap bbox={BBOX} onLotClick={() => {}} />);
    const before = screen.getByTestId("leaflet");

    useQueryMock.mockReturnValue([
      lot({ _id: "lots:b", code: "B-01", geometryStatus: "placeholder" }),
    ]);
    rerender(<LotMap bbox={BBOX} onLotClick={() => {}} />);

    expect(screen.getByTestId("leaflet")).toBe(before);
  });

  it("hands the map the lots it already had, not an empty list", () => {
    // Blanking the markers for the length of the query would flicker
    // every lot off and on again on every zoom step.
    useQueryMock.mockReturnValue([lot(), lot({ _id: "lots:b", code: "A-02" })]);
    const { rerender } = render(
      <LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />,
    );
    useQueryMock.mockReturnValue(undefined);
    rerender(<LotMap bbox={BBOX} forceRenderer="leaflet" onLotClick={() => {}} />);

    expect(screen.getByTestId("leaflet")).toHaveAttribute("data-lots", "2");
  });
});
