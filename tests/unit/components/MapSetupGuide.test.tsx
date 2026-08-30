/**
 * The walkthrough that replaced six tabs.
 *
 * The point of these tests is that the page cannot flatter you. Every
 * step's state is derived from counts the server did, so there is no
 * path by which somebody marks step 3 done and the map stays empty.
 * A regression here would not throw or look broken — it would just
 * quietly say "Done" next to work nobody has done, which is the one
 * failure mode a checklist has.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const createSectionMock = vi.fn(async () => ({ sectionId: "sections:new" }));
const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
  useMutation: () => createSectionMock,
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

// The 3D scene is WebGL and has no place in a jsdom run; the button
// that reveals it is what these tests care about.
vi.mock("next/dynamic", () => ({
  default: () => function Stub() {
    return <div data-testid="phase3d-stub">map</div>;
  },
}));

import { MapSetupGuide } from "@/components/MapSetupGuide";

beforeEach(() => {
  createSectionMock.mockClear();
  useQueryMock.mockReset();
});

interface SectionOver {
  sectionId?: string;
  displayName?: string;
  gridColumns?: number | null;
  gridRows?: number | null;
  lotCount?: number;
  photoCount?: number;
  surveyedCount?: number;
}

function sec(over: SectionOver = {}) {
  return {
    sectionId: over.sectionId ?? "sections:faith",
    name: "garden-of-faith",
    displayName: over.displayName ?? "Garden of Faith",
    sortOrder: 1,
    kind: "standard",
    gridColumns: over.gridColumns ?? null,
    gridRows: over.gridRows ?? null,
    lotCount: over.lotCount ?? 0,
    photoCount: over.photoCount ?? 0,
    surveyedCount: over.surveyedCount ?? 0,
  };
}

function progress(
  sections: ReturnType<typeof sec>[],
  orphanSections: Array<{ section: string; lotCount: number }> = [],
) {
  return {
    sections,
    orphanSections,
    totals: {
      sectionCount: sections.length,
      laidOutCount: sections.filter(
        (s) => s.gridColumns !== null && s.gridRows !== null,
      ).length,
      lotCount: sections.reduce((n, s) => n + s.lotCount, 0),
      photoCount: sections.reduce((n, s) => n + s.photoCount, 0),
      surveyedCount: sections.reduce((n, s) => n + s.surveyedCount, 0),
    },
  };
}

function state(n: number): string {
  return (
    screen.getByTestId(`map-setup-step-${n}`).getAttribute("data-state") ?? ""
  );
}

// --- the steps report the data, not a claim ---------------------------

describe("what each step says", () => {
  it("starts everything at to-do on an empty park", () => {
    useQueryMock.mockReturnValue(progress([]));
    render(<MapSetupGuide />);
    expect(state(1)).toBe("todo");
    expect(state(2)).toBe("todo");
    expect(state(3)).toBe("todo");
    expect(state(4)).toBe("todo");
  });

  it("marks step 1 done once a garden exists", () => {
    useQueryMock.mockReturnValue(progress([sec()]));
    render(<MapSetupGuide />);
    expect(state(1)).toBe("done");
  });

  it("holds step 2 at IN PROGRESS while any garden is unarranged", () => {
    // The failure this guards: one garden configured, the rest guessed,
    // and a green tick saying the map is laid out.
    useQueryMock.mockReturnValue(
      progress([
        sec({ gridColumns: 6, gridRows: 5, lotCount: 28 }),
        sec({
          sectionId: "sections:hope",
          displayName: "Garden of Hope",
          lotCount: 10,
        }),
      ]),
    );
    render(<MapSetupGuide />);
    expect(state(2)).toBe("partial");
  });

  it("marks step 2 done only when every garden is arranged", () => {
    useQueryMock.mockReturnValue(
      progress([sec({ gridColumns: 6, gridRows: 5, lotCount: 28 })]),
    );
    render(<MapSetupGuide />);
    expect(state(2)).toBe("done");
  });

  it("NAMES the gardens that still have no lots", () => {
    // Otherwise "in progress" sends somebody off to work out which of
    // eleven gardens it meant.
    useQueryMock.mockReturnValue(
      progress([
        sec({ lotCount: 28 }),
        sec({
          sectionId: "sections:hope",
          displayName: "Garden of Hope",
          lotCount: 0,
        }),
      ]),
    );
    render(<MapSetupGuide />);
    expect(state(3)).toBe("partial");
    expect(screen.getByTestId("map-setup-empty-gardens")).toHaveTextContent(
      "Garden of Hope",
    );
    expect(screen.getByTestId("map-setup-empty-gardens")).not.toHaveTextContent(
      "Garden of Faith",
    );
  });

  it("counts photographs per garden rather than in one lump", () => {
    useQueryMock.mockReturnValue(
      progress([sec({ lotCount: 28, photoCount: 12 })]),
    );
    render(<MapSetupGuide />);
    expect(state(5)).toBe("partial");
    expect(screen.getByTestId("map-setup-photos")).toHaveTextContent(
      "12 of 28 photographed",
    );
  });

  it("keeps step 6 optional however little is surveyed", () => {
    // The 3D map does not need coordinates. Showing this as outstanding
    // work would push somebody into a survey they do not need.
    useQueryMock.mockReturnValue(
      progress([sec({ lotCount: 28, surveyedCount: 0 })]),
    );
    render(<MapSetupGuide />);
    expect(state(6)).toBe("optional");
    expect(screen.getByTestId("map-setup-surveyed")).toHaveTextContent(
      "0 of 28",
    );
  });
});

// --- the map itself ----------------------------------------------------

describe("the map preview", () => {
  it("does not load WebGL until asked", () => {
    useQueryMock.mockReturnValue(progress([sec({ lotCount: 28 })]));
    render(<MapSetupGuide />);
    expect(screen.queryByTestId("phase3d-stub")).toBeNull();
    fireEvent.click(screen.getByTestId("map-setup-show-map"));
    expect(screen.getByTestId("phase3d-stub")).toBeInTheDocument();
  });

  it("offers nothing to look at when there are no lots", () => {
    useQueryMock.mockReturnValue(progress([sec()]));
    render(<MapSetupGuide />);
    expect(screen.queryByTestId("map-setup-show-map")).toBeNull();
  });
});

// --- lots that cannot be drawn ----------------------------------------

describe("lots belonging to no garden", () => {
  it("says so at the top, with the name and the count", () => {
    useQueryMock.mockReturnValue(
      progress([sec({ lotCount: 28 })], [
        { section: "Garden of Nowhere", lotCount: 40 },
      ]),
    );
    render(<MapSetupGuide />);
    const alert = screen.getByTestId("map-setup-orphans");
    expect(alert).toHaveTextContent("Garden of Nowhere");
    expect(alert).toHaveTextContent("40 lots");
  });

  it("stays quiet when every lot has a garden", () => {
    useQueryMock.mockReturnValue(progress([sec({ lotCount: 28 })]));
    render(<MapSetupGuide />);
    expect(screen.queryByTestId("map-setup-orphans")).toBeNull();
  });
});

// --- creating a garden without leaving ---------------------------------

describe("adding a garden", () => {
  it("opens the form on this page", () => {
    useQueryMock.mockReturnValue(progress([]));
    render(<MapSetupGuide />);
    fireEvent.click(screen.getByTestId("map-setup-add-garden"));
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  });
});
