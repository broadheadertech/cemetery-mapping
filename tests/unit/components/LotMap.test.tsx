import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import type { LotForMap } from "@/hooks/useLotsInViewport";
import { SvgRenderer } from "@/components/LotMap/SvgRenderer";
import { LotMap } from "@/components/LotMap/LotMap";
import { DEFAULT_CEMETERY_BBOX } from "@/lib/geometry";

/**
 * Story 1.12 — LotMap + SvgRenderer tests.
 *
 * `convex/react` is mocked at the module boundary so the renderer
 * works without a Convex provider. Each test sets the mock return
 * before rendering.
 */

const mockUseQuery = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (
    ...args: Parameters<typeof mockUseQuery>
  ): ReturnType<typeof mockUseQuery> => mockUseQuery(...args),
}));

function makePlaceholderLot(overrides: Partial<LotForMap> = {}): LotForMap {
  return {
    _id: "lot_placeholder_1",
    code: "D-5-12",
    section: "D",
    block: "5",
    row: "12",
    type: "single",
    status: "available",
    geometryStatus: "placeholder",
    geometry: {
      centroid: { lat: 14.6760, lng: 121.0437 },
      polygon: [],
      bboxMinLat: 14.6760,
      bboxMaxLat: 14.6760,
      bboxMinLng: 121.0437,
      bboxMaxLng: 121.0437,
    },
    ...overrides,
  };
}

function makeSurveyedLot(overrides: Partial<LotForMap> = {}): LotForMap {
  return {
    _id: "lot_surveyed_1",
    code: "D-5-13",
    section: "D",
    block: "5",
    row: "13",
    type: "single",
    status: "reserved",
    geometryStatus: "surveyed",
    geometry: {
      centroid: { lat: 14.6765, lng: 121.0440 },
      polygon: [
        { lat: 14.6764, lng: 121.0439 },
        { lat: 14.6766, lng: 121.0439 },
        { lat: 14.6766, lng: 121.0441 },
        { lat: 14.6764, lng: 121.0441 },
      ],
      bboxMinLat: 14.6764,
      bboxMaxLat: 14.6766,
      bboxMinLng: 121.0439,
      bboxMaxLng: 121.0441,
    },
    ...overrides,
  };
}

describe("SvgRenderer", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders an <svg> with the role 'img' and aria-label including the lot count", () => {
    render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot(), makeSurveyedLot()]}
        onLotClick={vi.fn()}
      />,
    );
    const svg = screen.getByRole("img");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("aria-label")).toContain("2 lots");
  });

  it("renders a circle for placeholder geometry and a polygon for surveyed geometry", () => {
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot(), makeSurveyedLot()]}
        onLotClick={vi.fn()}
      />,
    );
    expect(container.querySelector("circle[data-lot-id]")).not.toBeNull();
    expect(container.querySelector("polygon[data-lot-id]")).not.toBeNull();
  });

  it("each lot element has role='button', tabIndex=0, and an aria-label", () => {
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot(), makeSurveyedLot()]}
        onLotClick={vi.fn()}
      />,
    );
    const circle = container.querySelector("circle[data-lot-id]")!;
    const polygon = container.querySelector("polygon[data-lot-id]")!;
    expect(circle.getAttribute("role")).toBe("button");
    expect(circle.getAttribute("tabindex")).toBe("0");
    expect(circle.getAttribute("aria-label")).toContain("D-5-12");
    expect(polygon.getAttribute("role")).toBe("button");
    expect(polygon.getAttribute("tabindex")).toBe("0");
    expect(polygon.getAttribute("aria-label")).toContain("D-5-13");
  });

  it("placeholder lots include the 'approximate location' suffix in the aria-label", () => {
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot()]}
        onLotClick={vi.fn()}
      />,
    );
    const circle = container.querySelector("circle[data-lot-id]")!;
    expect(circle.getAttribute("aria-label")).toContain("approximate location");
  });

  it("calls onLotClick(lotId) when a polygon is clicked", () => {
    const onLotClick = vi.fn();
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makeSurveyedLot({ _id: "lot_xyz" })]}
        onLotClick={onLotClick}
      />,
    );
    const polygon = container.querySelector("polygon[data-lot-id]")!;
    fireEvent.click(polygon);
    expect(onLotClick).toHaveBeenCalledWith("lot_xyz");
  });

  it("calls onLotClick(lotId) when a circle is clicked", () => {
    const onLotClick = vi.fn();
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot({ _id: "lot_p" })]}
        onLotClick={onLotClick}
      />,
    );
    const circle = container.querySelector("circle[data-lot-id]")!;
    fireEvent.click(circle);
    expect(onLotClick).toHaveBeenCalledWith("lot_p");
  });

  it("calls onLotClick when Enter is pressed on a focused lot", () => {
    const onLotClick = vi.fn();
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot({ _id: "lot_k" })]}
        onLotClick={onLotClick}
      />,
    );
    const circle = container.querySelector("circle[data-lot-id]")!;
    fireEvent.keyDown(circle, { key: "Enter" });
    expect(onLotClick).toHaveBeenCalledWith("lot_k");
  });

  it("calls onLotClick when Space is pressed on a focused lot", () => {
    const onLotClick = vi.fn();
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot({ _id: "lot_s" })]}
        onLotClick={onLotClick}
      />,
    );
    const circle = container.querySelector("circle[data-lot-id]")!;
    fireEvent.keyDown(circle, { key: " " });
    expect(onLotClick).toHaveBeenCalledWith("lot_s");
  });

  it("ignores other key presses", () => {
    const onLotClick = vi.fn();
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot()]}
        onLotClick={onLotClick}
      />,
    );
    const circle = container.querySelector("circle[data-lot-id]")!;
    fireEvent.keyDown(circle, { key: "Tab" });
    fireEvent.keyDown(circle, { key: "Escape" });
    fireEvent.keyDown(circle, { key: "a" });
    expect(onLotClick).not.toHaveBeenCalled();
  });

  it("shows a tooltip on hover with the lot code and status", () => {
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makeSurveyedLot()]}
        onLotClick={vi.fn()}
      />,
    );
    const polygon = container.querySelector("polygon[data-lot-id]")!;
    fireEvent.mouseEnter(polygon);
    const tooltip = screen.getByTestId("lot-tooltip");
    expect(within(tooltip).getByText("D-5-13")).not.toBeNull();
    expect(within(tooltip).getByText("Reserved")).not.toBeNull();
    fireEvent.mouseLeave(polygon);
    expect(screen.queryByTestId("lot-tooltip")).toBeNull();
  });

  it("applies the status fill colour class for each lot", () => {
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[
          makePlaceholderLot({ _id: "a", status: "available" }),
          makeSurveyedLot({ _id: "r", status: "reserved" }),
        ]}
        onLotClick={vi.fn()}
      />,
    );
    const available = container.querySelector('[data-lot-id="a"]')!;
    const reserved = container.querySelector('[data-lot-id="r"]')!;
    expect(available.getAttribute("class")).toContain(
      "fill-status-available-bg",
    );
    expect(reserved.getAttribute("class")).toContain("fill-status-reserved-bg");
  });

  it("caps rendered lots at 200 and shows a truncation notice", () => {
    const many: LotForMap[] = Array.from({ length: 205 }, (_, i) =>
      makePlaceholderLot({ _id: `lot_${i}`, code: `LOT-${i}` }),
    );
    const { container } = render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={many}
        onLotClick={vi.fn()}
      />,
    );
    expect(container.querySelectorAll("[data-lot-id]")).toHaveLength(200);
    expect(screen.getByTestId("renderer-truncation-notice")).not.toBeNull();
  });

  it("does NOT show the truncation notice when below the cap", () => {
    render(
      <SvgRenderer
        bbox={DEFAULT_CEMETERY_BBOX}
        lots={[makePlaceholderLot()]}
        onLotClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("renderer-truncation-notice")).toBeNull();
  });
});

describe("LotMap orchestrator", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading state while useQuery returns undefined", () => {
    mockUseQuery.mockReturnValue(undefined);
    render(<LotMap onLotClick={vi.fn()} />);
    expect(screen.getByTestId("map-loading")).not.toBeNull();
  });

  it("renders the empty state when the query resolves to []", async () => {
    mockUseQuery.mockReturnValue([]);
    render(<LotMap onLotClick={vi.fn()} />);
    // Empty state appears only after the debounced query lands. The
    // hook's default debounce is 250ms; wait for it to flush.
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(screen.getByTestId("map-empty")).not.toBeNull();
  });

  it("forwards onLotClick from the SvgRenderer", async () => {
    const lot = makeSurveyedLot();
    mockUseQuery.mockReturnValue([lot]);
    const onLotClick = vi.fn();
    // Story 8.2: with a surveyed lot in view the orchestrator would
    // route to Leaflet — pin to SVG explicitly so this Phase 1
    // assertion (polygon DOM node + click forwarding) still applies.
    const { container } = render(
      <LotMap onLotClick={onLotClick} forceRenderer="svg" />,
    );

    // Wait for debounce + query resolution to flush through.
    await new Promise((resolve) => setTimeout(resolve, 320));

    const polygon = container.querySelector("polygon[data-lot-id]");
    expect(polygon).not.toBeNull();
    fireEvent.click(polygon!);
    expect(onLotClick).toHaveBeenCalledWith(lot._id);
  });
});
