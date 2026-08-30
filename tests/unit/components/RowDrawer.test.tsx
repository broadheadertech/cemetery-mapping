/**
 * The screen that draws a row of graves.
 *
 * Its job is to be trustworthy before it is used, not after. Twenty
 * lots are written in one press, so what the preview says about the fit
 * has to be what the server will do — and the one temptation worth
 * guarding against is a row that always looks tidy.
 *
 * Stretching the plots to fill whatever line got drawn would do that.
 * It would also make the map misstate how big a grave is, which is the
 * figure families are quoted and the one that decides whether a family
 * plot fits where somebody thinks it does.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const placeRowMock = vi.fn(
  async (_args: {
    lotIds: string[];
    start: { lat: number; lng: number };
    end: { lat: number; lng: number };
  }) => ({ placed: _args.lotIds.length }),
);
const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
  useMutation: () => placeRowMock,
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

vi.mock("leaflet", () => ({ default: {} }));

import { RowDrawer } from "@/components/RowDrawer";

const CENTRE = { lat: 16.3959, lng: 120.3556 };

function candidate(i: number, over: Record<string, unknown> = {}) {
  return {
    _id: `lots:${i}`,
    code: `A-1-${String(i).padStart(2, "0")}`,
    block: "1",
    row: String(i),
    status: "available",
    type: "single",
    widthM: 2.5,
    depthM: 1.2,
    placed: false,
    source: null,
    ...over,
  };
}

/** Answer the candidates query with these; boundaries with none. */
function withCandidates(rows: unknown[]) {
  useQueryMock.mockImplementation((ref) => {
    const name = String((ref as { name?: string })?.name ?? "");
    return name.includes("listForRowDrawing") ? rows : [];
  });
}

function view() {
  return (
    <RowDrawer
      sectionName="Garden of Faith"
      displayName="Garden of Faith"
      fallbackCentre={CENTRE}
    />
  );
}

beforeEach(() => {
  placeRowMock.mockClear();
  useQueryMock.mockReset();
});

describe("choosing which lots to place", () => {
  it("counts the lots still waiting for a position", () => {
    withCandidates([candidate(1), candidate(2), candidate(3, { placed: true })]);
    render(view());
    expect(screen.getByTestId("row-available")).toHaveTextContent(
      "2 lots in Garden of Faith still have no position",
    );
  });

  it("takes the next unplaced lots in CODE order", () => {
    // Code order is row order. Any other selection makes "A-1-01 to
    // A-1-10" mean something different on screen than on the ground.
    withCandidates([candidate(1), candidate(2), candidate(3)]);
    render(view());
    fireEvent.change(screen.getByTestId("row-count"), {
      target: { value: "2" },
    });
    expect(screen.getByTestId("row-selection")).toHaveTextContent("A-1-01");
    expect(screen.getByTestId("row-selection")).toHaveTextContent("A-1-02");
  });

  it("never selects more lots than are waiting", () => {
    // Asking for twenty when five remain should place five, not fail on
    // submit with a server error about lots that were never there.
    withCandidates([candidate(1), candidate(2)]);
    render(view());
    fireEvent.change(screen.getByTestId("row-count"), {
      target: { value: "20" },
    });
    expect(screen.getByTestId("row-place")).toHaveTextContent("Place 2 lots");
  });

  it("skips lots that already have a position", () => {
    withCandidates([candidate(1, { placed: true }), candidate(2)]);
    render(view());
    fireEvent.change(screen.getByTestId("row-count"), {
      target: { value: "5" },
    });
    expect(screen.getByTestId("row-selection")).toHaveTextContent("A-1-02");
    expect(screen.getByTestId("row-selection")).not.toHaveTextContent("A-1-01");
  });

  it("says plainly when the garden is fully placed", () => {
    withCandidates([candidate(1, { placed: true })]);
    render(view());
    expect(screen.getByTestId("row-available")).toHaveTextContent(
      /already has a position/i,
    );
  });
});

describe("before anything is written", () => {
  it("will not place without a drawn line", () => {
    // The count alone is not a row. Without two points there is no
    // bearing, and a row with no bearing is not a placement.
    withCandidates([candidate(1), candidate(2)]);
    render(view());
    expect(screen.getByTestId("row-place")).toBeDisabled();
    expect(placeRowMock).not.toHaveBeenCalled();
  });

  it("will not place when no lots are left", () => {
    withCandidates([candidate(1, { placed: true })]);
    render(view());
    expect(screen.getByTestId("row-place")).toBeDisabled();
  });
});
