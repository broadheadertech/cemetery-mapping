/**
 * Telling somebody what a lot is before asking them to describe one.
 *
 * The form asked for a code, a block and a row with no explanation of
 * any of them. "Block" in particular is a word every cemetery uses
 * slightly differently, and a park that does not use blocks at all had
 * nothing to tell them what to type.
 *
 * The load-bearing one is the code's ORDERING. Every other field here
 * can be edited afterwards with no consequence; the codes decide how
 * the 3D map arranges an unsurveyed garden, and they are awkward to
 * change once contracts reference them. Nothing on the form said so.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
  useMutation: () => vi.fn(async () => null),
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

import { LotForm } from "@/components/LotForm";

beforeEach(() => {
  useQueryMock.mockReset();
  useQueryMock.mockReturnValue([
    { _id: "sections:a", name: "garden-of-faith", displayName: "Garden of Faith" },
  ]);
});

function create() {
  return <LotForm mode="create" onSubmit={vi.fn(async () => undefined)} />;
}

describe("explaining a lot before asking for one", () => {
  it("says what a garden, block, row and code each are", () => {
    render(create());
    const guide = screen.getByTestId("lot-form-guide");
    expect(guide).toHaveTextContent(/garden/i);
    expect(guide).toHaveTextContent(/block/i);
    expect(guide).toHaveTextContent(/row/i);
    expect(guide).toHaveTextContent(/code/i);
  });

  it("tells a park that does not use blocks what to type", () => {
    // Otherwise the field is a blocker: a required box whose meaning
    // does not apply, with no stated way through.
    render(create());
    expect(screen.getByTestId("lot-form-guide")).toHaveTextContent(
      /does not use blocks/i,
    );
  });

  it("WARNS that the code ordering is the map's arrangement", () => {
    // The one field with consequences beyond being a label.
    render(create());
    expect(screen.getByTestId("lot-form-guide")).toHaveTextContent(
      /order the lots physically sit/i,
    );
  });

  it("gives block and row their own hints on the fields themselves", () => {
    // The panel is read once, at the top; the hint has to be there when
    // somebody is IN the box wondering what to put. Located by id
    // rather than by text, because the two deliberately say the same
    // thing and a text search matches both.
    const { container } = render(create());
    expect(container.querySelector("#lot-block-hint")).toHaveTextContent(
      /path or driveway separates/i,
    );
    expect(container.querySelector("#lot-row-hint")).toHaveTextContent(
      /label, not a calculation/i,
    );
  });

  it("says what the dimensions are actually used for", () => {
    // They are not decorative: they become the square metres a family
    // is quoted and the footprint drawn when the lot is placed.
    render(create());
    expect(screen.getByText(/footprint drawn around the point/i)).toBeInTheDocument();
    expect(screen.getByText(/2\.5m × 1\.2m/)).toBeInTheDocument();
  });

  it("says base price excludes discounts and plans", () => {
    render(create());
    expect(
      screen.getByText(/before any discount, promo or payment plan/i),
    ).toBeInTheDocument();
  });

  it("connects each field to its hint for a screen reader", () => {
    render(create());
    const block = screen.getByLabelText("Block");
    expect(block.getAttribute("aria-describedby")).toContain("lot-block-hint");
  });

  it("drops the primer when EDITING, and says the code is now fixed", () => {
    // Somebody editing a lot has met all this. What they need instead
    // is why the code is greyed out.
    render(
      <LotForm
        mode="edit"
        onSubmit={vi.fn(async () => undefined)}
        defaultValues={{
          code: "A-1-01",
          section: "Garden of Faith",
          sectionId: "sections:a",
          block: "1",
          row: "01",
          type: "single",
          dimensions: { widthM: 2.5, depthM: 1.2 },
          basePriceCents: 88_000_00,
        }}
      />,
    );
    expect(screen.queryByTestId("lot-form-guide")).toBeNull();
    expect(screen.getByText(/already reference it/i)).toBeInTheDocument();
  });
});
