/**
 * The two controls that make the 3D map usable without a developer.
 *
 * A garden's arrangement and a lot's photograph were both things only I
 * could set. These are the screens that hand them over.
 *
 * The tests are mostly about honesty in the copy. This map is a VISUAL
 * REPRESENTATION, not a survey — lots sit where their code puts them in
 * a grid, not where they stand in the ground. A control that let
 * somebody believe otherwise would be worse than no control, because
 * they would trust a picture that is not telling them what they think
 * it is.
 */

import { type ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const setLayoutMock = vi.fn(async () => ({ sectionId: "sections:a" }));
const setPhotoMock = vi.fn(async () => ({ lotId: "lots:a" }));
const uploadUrlMock = vi.fn(async () => "https://upload.test/one-time");
const useQueryMock = vi.fn<(ref: unknown, args: unknown) => unknown>();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) => useQueryMock(ref, args),
  useMutation: (ref: unknown) => {
    const name = String((ref as { name?: string })?.name ?? "");
    if (name.includes("setSectionLayout")) return setLayoutMock;
    if (name.includes("generateLotPhotoUploadUrl")) return uploadUrlMock;
    return setPhotoMock;
  },
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

import { SectionLayoutControl } from "@/components/SectionLayoutControl";
import { LotPhotoPanel } from "@/components/LotDetail/LotPhotoPanel";

beforeEach(() => {
  setLayoutMock.mockClear();
  setPhotoMock.mockClear();
  uploadUrlMock.mockClear();
  useQueryMock.mockReset();
});

function layout(over: Partial<{
  gridColumns: number | null;
  gridRows: number | null;
  lotCount: number;
}> = {}): ReactElement {
  return (
    <SectionLayoutControl
      sectionId="sections:a"
      displayName="Garden of Faith"
      gridColumns={over.gridColumns ?? null}
      gridRows={over.gridRows ?? null}
      lotCount={over.lotCount ?? 28}
    />
  );
}

// --- the layout control ------------------------------------------------

describe("setting a garden's arrangement", () => {
  it("says plainly when nobody has set one", () => {
    // The map is guessing. That must be visible, or a guessed shape
    // gets mistaken for a decision the park made.
    render(layout());
    expect(screen.getByTestId("section-layout-toggle")).toHaveTextContent(
      "not set",
    );
    expect(screen.getByTestId("section-layout-derived")).toHaveTextContent(
      /guessing a shape/i,
    );
  });

  it("shows the configured grid when there is one", () => {
    render(layout({ gridColumns: 6, gridRows: 5 }));
    expect(screen.getByTestId("section-layout-toggle")).toHaveTextContent(
      "6 × 5",
    );
    expect(screen.queryByTestId("section-layout-derived")).toBeNull();
  });

  it("saves the grid", async () => {
    render(layout());
    fireEvent.click(screen.getByTestId("section-layout-toggle"));
    fireEvent.change(screen.getByTestId("section-layout-columns"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByTestId("section-layout-rows"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("section-layout-save"));
    await waitFor(() =>
      expect(setLayoutMock).toHaveBeenCalledWith({
        sectionId: "sections:a",
        gridColumns: 6,
        gridRows: 5,
      }),
    );
  });

  it("says how the grid fits the garden BEFORE saving", () => {
    // 6 × 5 is thirty cells for twenty-eight lots. Knowing that two
    // will be turf beats discovering it on the map.
    render(layout({ lotCount: 28 }));
    fireEvent.click(screen.getByTestId("section-layout-toggle"));
    fireEvent.change(screen.getByTestId("section-layout-columns"), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByTestId("section-layout-rows"), {
      target: { value: "5" },
    });
    expect(screen.getByTestId("section-layout-fit")).toHaveTextContent(
      "30 cells for 28 lots",
    );
    expect(screen.getByTestId("section-layout-fit")).toHaveTextContent(
      "2 will be turf",
    );
  });

  it("WARNS when the grid is too small to draw every lot", () => {
    // The failure that is invisible on the map: lots that simply are
    // not there, with nothing saying so.
    render(layout({ lotCount: 28 }));
    fireEvent.click(screen.getByTestId("section-layout-toggle"));
    fireEvent.change(screen.getByTestId("section-layout-columns"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByTestId("section-layout-rows"), {
      target: { value: "5" },
    });
    expect(screen.getByTestId("section-layout-fit")).toHaveTextContent(
      /3 lots will not be drawn/i,
    );
  });

  it("refuses to save a grid outside the drawable range", () => {
    render(layout());
    fireEvent.click(screen.getByTestId("section-layout-toggle"));
    fireEvent.change(screen.getByTestId("section-layout-columns"), {
      target: { value: "0" },
    });
    fireEvent.change(screen.getByTestId("section-layout-rows"), {
      target: { value: "5" },
    });
    expect(screen.getByTestId("section-layout-save")).toBeDisabled();
  });

  it("refuses a grid too wide to read", () => {
    render(layout());
    fireEvent.click(screen.getByTestId("section-layout-toggle"));
    fireEvent.change(screen.getByTestId("section-layout-columns"), {
      target: { value: "80" },
    });
    fireEvent.change(screen.getByTestId("section-layout-rows"), {
      target: { value: "5" },
    });
    expect(screen.getByTestId("section-layout-save")).toBeDisabled();
  });

  it("says the codes are the arrangement", () => {
    // The single most load-bearing sentence on this control. Somebody
    // setting a grid needs to know the map is not a survey.
    render(layout());
    fireEvent.click(screen.getByTestId("section-layout-toggle"));
    expect(
      screen.getByText(/visual representation, not a survey/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/codes are the/i)).toBeInTheDocument();
  });
});

// --- the photograph ----------------------------------------------------

function photoView(over: Record<string, unknown> = {}) {
  return {
    photoUrl: null,
    photoUpdatedAt: null,
    geometryStatus: "placeholder",
    lat: null,
    lng: null,
    areaSqm: 3,
    widthM: 2.5,
    depthM: 1.2,
    ...over,
  };
}

describe("a lot's photograph", () => {
  it("invites one when there is none", () => {
    useQueryMock.mockReturnValue(photoView());
    render(<LotPhotoPanel lotId="lots:a" />);
    expect(screen.getByTestId("lot-photo-empty")).toHaveTextContent(
      /more to make this lot findable than any coordinate/i,
    );
  });

  it("shows the picture when there is one", () => {
    useQueryMock.mockReturnValue(
      photoView({ photoUrl: "https://files.test/p1", photoUpdatedAt: 1 }),
    );
    render(<LotPhotoPanel lotId="lots:a" />);
    expect(screen.getByTestId("lot-photo-image")).toHaveAttribute(
      "src",
      "https://files.test/p1",
    );
  });

  it("shows the size beside it", () => {
    useQueryMock.mockReturnValue(photoView());
    render(<LotPhotoPanel lotId="lots:a" />);
    expect(screen.getByText(/2\.5m × 1\.2m · 3 sqm/)).toBeInTheDocument();
  });

  it("says NOT SURVEYED rather than inventing a position", () => {
    // The rail used to print a hardcoded "14.06° N" on every lot. A
    // coordinate nobody measured is worse than none: it sends somebody
    // to the wrong part of the park with confidence.
    useQueryMock.mockReturnValue(photoView());
    render(<LotPhotoPanel lotId="lots:a" />);
    expect(screen.getByTestId("lot-photo-position")).toHaveTextContent(
      "Not surveyed",
    );
  });

  it("shows the real coordinates once surveyed", () => {
    useQueryMock.mockReturnValue(
      photoView({ geometryStatus: "surveyed", lat: 16.3, lng: 120.3 }),
    );
    render(<LotPhotoPanel lotId="lots:a" />);
    expect(screen.getByTestId("lot-photo-position")).toHaveTextContent(
      "16.300000, 120.300000",
    );
  });

  it("uploads and attaches a picture", async () => {
    useQueryMock.mockReturnValue(photoView());
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ storageId: "_storage:new" }),
    })) as unknown as typeof fetch;

    render(<LotPhotoPanel lotId="lots:a" />);
    const file = new File(["x"], "lot.jpg", { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("lot-photo-input"), {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(setPhotoMock).toHaveBeenCalledWith({
        lotId: "lots:a",
        storageId: "_storage:new",
      }),
    );
  });

  it("says a replacement replaces, rather than adding", () => {
    // A lot has ONE representative picture. Somebody expecting a
    // gallery should be told before they upload.
    useQueryMock.mockReturnValue(
      photoView({ photoUrl: "https://files.test/p1" }),
    );
    render(<LotPhotoPanel lotId="lots:a" />);
    expect(screen.getByText(/replaces this one/i)).toBeInTheDocument();
  });

  it("mentions a very large photo without refusing it", async () => {
    // A phone photo can be 12MB. It works, and it costs the field
    // worker their data — worth saying, not worth blocking.
    useQueryMock.mockReturnValue(photoView());
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ storageId: "_storage:big" }),
    })) as unknown as typeof fetch;

    render(<LotPhotoPanel lotId="lots:a" />);
    const big = new File([new Uint8Array(9 * 1024 * 1024)], "big.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(screen.getByTestId("lot-photo-input"), {
      target: { files: [big] },
    });

    expect(screen.getByTestId("lot-photo-notice")).toHaveTextContent(/MB/);
    // And it still uploads.
    await waitFor(() => expect(setPhotoMock).toHaveBeenCalled());
  });

  it("hides the upload when the reader may not edit", () => {
    useQueryMock.mockReturnValue(photoView());
    render(<LotPhotoPanel lotId="lots:a" canEdit={false} />);
    expect(screen.queryByTestId("lot-photo-input")).toBeNull();
  });
});
