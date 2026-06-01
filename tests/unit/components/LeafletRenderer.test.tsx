import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { LotForMap } from "@/hooks/useLotsInViewport";
import { LotMap } from "@/components/LotMap/LotMap";

/**
 * Story 8.2 — LotMap renderer-dispatch tests.
 *
 * The Leaflet renderer itself is lazy-loaded via `next/dynamic({ ssr:
 * false })`, which renders its `loading:` placeholder synchronously
 * during a unit test (the dynamic chunk never actually resolves in
 * jsdom). That's exactly what we want to assert: the orchestrator
 * makes the correct renderer choice based on the surveyed flag, and
 * the Leaflet bundle path is only entered when at least one lot is
 * surveyed.
 *
 * Full Leaflet runtime behaviour (tile loading, pan/zoom, polygon
 * click) is validated in the Playwright e2e suite — jsdom can't
 * render Leaflet's canvas reliably.
 *
 * `convex/react` is mocked at the module boundary so the orchestrator
 * works without a Convex provider, matching the pattern from the
 * Phase 1 LotMap tests.
 */

const mockUseQuery = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (
    ...args: Parameters<typeof mockUseQuery>
  ): ReturnType<typeof mockUseQuery> => mockUseQuery(...args),
}));

// `next/dynamic` returns a component that, in the unit-test environment,
// renders the `loading:` fallback while the dynamic import settles. We
// don't want to actually resolve `./LeafletRenderer` in jsdom (Leaflet
// would call `window` / DOM APIs that don't exist). Stub `next/dynamic`
// to return a synchronous marker component instead — that lets us
// assert the orchestrator chose the Leaflet branch without booting the
// real module.
vi.mock("next/dynamic", () => ({
  default: () => {
    const Stub = (_props: unknown) => (
      <div data-testid="leaflet-stub">leaflet</div>
    );
    Stub.displayName = "LeafletRendererStub";
    return Stub;
  },
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

describe("LotMap renderer dispatch (Story 8.2)", () => {
  beforeEach(() => {
    mockUseQuery.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the SVG renderer when no lot is surveyed", async () => {
    mockUseQuery.mockReturnValue([
      makePlaceholderLot({ _id: "p1" }),
      makePlaceholderLot({ _id: "p2", code: "D-5-13" }),
    ]);
    const { container } = render(<LotMap onLotClick={vi.fn()} />);

    // Wait for debounce (250ms) + a small buffer.
    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(screen.queryByTestId("leaflet-stub")).toBeNull();
    expect(container.querySelector("svg[role='img']")).not.toBeNull();
  });

  it("switches to the Leaflet renderer when ANY lot is surveyed", async () => {
    mockUseQuery.mockReturnValue([
      makePlaceholderLot({ _id: "p1" }),
      makeSurveyedLot({ _id: "s1" }),
    ]);
    render(<LotMap onLotClick={vi.fn()} />);

    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(screen.getByTestId("leaflet-stub")).not.toBeNull();
  });

  it("respects forceRenderer='svg' even when surveyed lots are present", async () => {
    mockUseQuery.mockReturnValue([makeSurveyedLot()]);
    const { container } = render(
      <LotMap onLotClick={vi.fn()} forceRenderer="svg" />,
    );

    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(screen.queryByTestId("leaflet-stub")).toBeNull();
    expect(container.querySelector("svg[role='img']")).not.toBeNull();
  });

  it("respects forceRenderer='leaflet' even when no lot is surveyed", async () => {
    mockUseQuery.mockReturnValue([makePlaceholderLot()]);
    render(<LotMap onLotClick={vi.fn()} forceRenderer="leaflet" />);

    await new Promise((resolve) => setTimeout(resolve, 320));

    expect(screen.getByTestId("leaflet-stub")).not.toBeNull();
  });
});
