/**
 * Story 8.1 — `<GpsImportPanel>` component + parser tests.
 *
 * Covers:
 *   - parser: native batch, GeoJSON FeatureCollection, mixed errors.
 *   - component: parse → preview → submit flow happy path.
 *   - component: server error surfaces in the error panel.
 *   - component: server result with skipped + errors renders grouped.
 *
 * Convex's `useMutation` is mocked at the module level — jsdom has no
 * Convex client connection. The mock returns a captured spy so the
 * test can assert on the mutation args.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { ConvexError } from "convex/values";

import {
  parseGpsBatch,
  GpsImportParseError,
} from "@/components/GpsImport/parser";

const importMutationMock = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => importMutationMock,
}));

import { GpsImportPanel } from "@/components/GpsImport";

beforeEach(() => {
  cleanup();
  importMutationMock.mockReset();
});

describe("parseGpsBatch — native batch shape", () => {
  it("parses a well-formed { items: [...] } payload", () => {
    const result = parseGpsBatch(
      JSON.stringify({
        items: [
          {
            lotCode: "D-5-12",
            polygon: [
              { lat: 14.6758, lng: 121.0398 },
              { lat: 14.6762, lng: 121.0398 },
              { lat: 14.6762, lng: 121.0402 },
              { lat: 14.6758, lng: 121.0402 },
            ],
          },
        ],
      }),
    );
    expect(result.format).toBe("native");
    expect(result.items).toHaveLength(1);
    expect(result.featureErrors).toHaveLength(0);
    expect(result.items[0]!.lotCode).toBe("D-5-12");
    expect(result.items[0]!.polygon).toHaveLength(4);
  });

  it("accepts an optional per-item centroid when it agrees with the polygon", () => {
    // Triangle polygon centroid is (lat 14.67606..., lng 121.039933...).
    // The supplied centroid is within the < 0.00005° (~5 m) sanity
    // tolerance — Story 8.1 (HIGH-fix) rejects centroids that drift
    // further (surveyor copy-paste check).
    const result = parseGpsBatch(
      JSON.stringify({
        items: [
          {
            lotCode: "D-5-12",
            polygon: [
              { lat: 14.6758, lng: 121.0398 },
              { lat: 14.6762, lng: 121.0398 },
              { lat: 14.6762, lng: 121.0402 },
            ],
            centroid: { lat: 14.67607, lng: 121.03993 },
          },
        ],
      }),
    );
    expect(result.featureErrors).toHaveLength(0);
    expect(result.items[0]!.centroid).toEqual({
      lat: 14.67607,
      lng: 121.03993,
    });
  });

  it("rejects an operator-supplied centroid that drifts > 5m from the polygon centroid (Story 8.1 HIGH-fix)", () => {
    // Same triangle as above; the supplied centroid is ~50 m off in
    // both axes — well past the 0.00005° (~5 m) tolerance.
    const result = parseGpsBatch(
      JSON.stringify({
        items: [
          {
            lotCode: "D-5-12",
            polygon: [
              { lat: 14.6758, lng: 121.0398 },
              { lat: 14.6762, lng: 121.0398 },
              { lat: 14.6762, lng: 121.0402 },
            ],
            centroid: { lat: 14.677, lng: 121.041 },
          },
        ],
      }),
    );
    // Item is dropped — a bogus centroid signals a bogus row.
    expect(result.items).toHaveLength(0);
    expect(result.featureErrors).toHaveLength(1);
    expect(result.featureErrors[0]!.lotCode).toBe("D-5-12");
    expect(result.featureErrors[0]!.reason.toLowerCase()).toContain(
      "centroid",
    );
  });

  it("collects per-item parse errors without aborting", () => {
    const result = parseGpsBatch(
      JSON.stringify({
        items: [
          { lotCode: "D-5-12", polygon: [{ lat: 14.6758, lng: 121.0398 }] },
          { polygon: [] }, // missing lotCode
          { lotCode: "D-5-13", polygon: "not-an-array" },
        ],
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.featureErrors).toHaveLength(2);
  });
});

describe("parseGpsBatch — GeoJSON shape", () => {
  it("parses a FeatureCollection with one Polygon feature", () => {
    const result = parseGpsBatch(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { lotCode: "D-5-12" },
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [121.0398, 14.6758],
                  [121.0398, 14.6762],
                  [121.0402, 14.6762],
                  [121.0402, 14.6758],
                  [121.0398, 14.6758], // closing duplicate
                ],
              ],
            },
          },
        ],
      }),
    );
    expect(result.format).toBe("geojson");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.lotCode).toBe("D-5-12");
    // GeoJSON closing-duplicate vertex is trimmed.
    expect(result.items[0]!.polygon).toHaveLength(4);
    // [lng,lat] -> {lat,lng} translation.
    expect(result.items[0]!.polygon[0]!.lat).toBeCloseTo(14.6758);
    expect(result.items[0]!.polygon[0]!.lng).toBeCloseTo(121.0398);
  });

  it("rejects MultiPolygon features as feature-level errors", () => {
    const result = parseGpsBatch(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { lotCode: "D-5-12" },
            geometry: {
              type: "MultiPolygon",
              coordinates: [[[[0, 0]]]],
            },
          },
        ],
      }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.featureErrors).toHaveLength(1);
    expect(result.featureErrors[0]!.reason).toMatch(/MultiPolygon/i);
  });

  it("rejects features missing properties.lotCode", () => {
    const result = parseGpsBatch(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[[0, 0]]],
            },
          },
        ],
      }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.featureErrors).toHaveLength(1);
    expect(result.featureErrors[0]!.reason).toMatch(/lotCode/);
  });
});

describe("parseGpsBatch — top-level errors", () => {
  it("throws INVALID_JSON for malformed input", () => {
    expect(() => parseGpsBatch("{ not json")).toThrowError(GpsImportParseError);
  });

  it("throws EMPTY for an empty string", () => {
    expect(() => parseGpsBatch("   ")).toThrowError(GpsImportParseError);
  });

  it("throws UNKNOWN_SHAPE for a JSON array (neither shape)", () => {
    expect(() => parseGpsBatch("[]")).toThrowError(GpsImportParseError);
  });
});

describe("parseGpsBatch — CSV shape (Story 8.1 HIGH-fix)", () => {
  it("parses a CSV with lotCode + polygonWKT", () => {
    const csv = [
      "lotCode,polygonWKT",
      'D-5-12,"POLYGON((121.0398 14.6758, 121.0398 14.6762, 121.0402 14.6762, 121.0398 14.6758))"',
    ].join("\n");
    const result = parseGpsBatch(csv);
    expect(result.format).toBe("csv");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.lotCode).toBe("D-5-12");
    // WKT closing duplicate vertex is trimmed.
    expect(result.items[0]!.polygon).toHaveLength(3);
    // WKT is lng-first; the parser flips to {lat,lng}.
    expect(result.items[0]!.polygon[0]!.lat).toBeCloseTo(14.6758);
    expect(result.items[0]!.polygon[0]!.lng).toBeCloseTo(121.0398);
  });

  it("parses an optional centroid from lat/lng columns", () => {
    // Polygon centroid is (14.676066..., 121.039933...); the supplied
    // centroid sits within the 0.00005° tolerance.
    const csv = [
      "lotCode,lat,lng,polygonWKT",
      'D-5-12,14.67607,121.03993,"POLYGON((121.0398 14.6758, 121.0398 14.6762, 121.0402 14.6762))"',
    ].join("\n");
    const result = parseGpsBatch(csv);
    expect(result.featureErrors).toHaveLength(0);
    expect(result.items[0]!.centroid).toEqual({
      lat: 14.67607,
      lng: 121.03993,
    });
  });

  it("auto-generates a footprint from lat/lng when polygonWKT is blank (centre-point path)", () => {
    const csv = ["lotCode,lat,lng,polygonWKT", "A-101,16.4205,120.3412,"].join(
      "\n",
    );
    const result = parseGpsBatch(csv);
    expect(result.featureErrors).toHaveLength(0);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.lotCode).toBe("A-101");
    // A 4-corner box is generated around the supplied centre point.
    expect(result.items[0]!.polygon).toHaveLength(4);
    expect(result.items[0]!.centroid).toEqual({ lat: 16.4205, lng: 120.3412 });
  });

  it("accepts a CSV with no polygonWKT column at all (lat/lng only)", () => {
    const csv = ["lotCode,lat,lng", "A-102,16.4205,120.3414"].join("\n");
    const result = parseGpsBatch(csv);
    expect(result.featureErrors).toHaveLength(0);
    expect(result.items[0]!.polygon).toHaveLength(4);
  });

  it("errors a row carrying neither polygonWKT nor lat/lng", () => {
    const csv = ["lotCode,lat,lng,polygonWKT", "A-103,,,"].join("\n");
    const result = parseGpsBatch(csv);
    expect(result.items).toHaveLength(0);
    expect(result.featureErrors).toHaveLength(1);
    expect(result.featureErrors[0]!.lotCode).toBe("A-103");
  });

  it("reports a feature error for a malformed WKT polygon", () => {
    const csv = ["lotCode,polygonWKT", "D-5-12,not-a-polygon"].join("\n");
    const result = parseGpsBatch(csv);
    expect(result.items).toHaveLength(0);
    expect(result.featureErrors).toHaveLength(1);
    expect(result.featureErrors[0]!.reason).toMatch(/polygonWKT|POLYGON/i);
  });

  it("throws INVALID_CSV when the header is missing required columns", () => {
    expect(() => parseGpsBatch("foo,bar\n1,2")).toThrowError(
      GpsImportParseError,
    );
  });
});

describe("<GpsImportPanel>", () => {
  it("renders the source panel by default", () => {
    render(<GpsImportPanel />);
    expect(screen.getByText(/Source/)).toBeTruthy();
    expect(screen.getByTestId("gps-import-file-input")).toBeTruthy();
  });

  it("parses pasted JSON into the preview panel", async () => {
    render(<GpsImportPanel />);
    const textarea = screen.getByLabelText(/paste JSON/i);
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          items: [
            {
              lotCode: "D-5-12",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Parse pasted JSON/i }));
    await waitFor(() => {
      expect(screen.getByTestId("gps-import-preview-table")).toBeTruthy();
    });
    expect(screen.getByText("D-5-12")).toBeTruthy();
  });

  it("submits parsed items and shows the result panel on success", async () => {
    importMutationMock.mockResolvedValue({
      totalItems: 1,
      updated: 1,
      skippedAlreadySurveyed: [],
      errors: [],
    });

    render(<GpsImportPanel />);
    const textarea = screen.getByLabelText(/paste JSON/i);
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          items: [
            {
              lotCode: "D-5-12",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Parse pasted JSON/i }));
    await waitFor(() => {
      expect(screen.getByTestId("gps-import-run-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("gps-import-run-button"));

    await waitFor(() => {
      expect(importMutationMock).toHaveBeenCalledTimes(1);
    });
    expect(importMutationMock.mock.calls[0]![0]).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ lotCode: "D-5-12" }),
      ]),
    });

    await waitFor(() => {
      expect(screen.getByTestId("gps-import-result")).toBeTruthy();
    });
    expect(screen.getByText(/Import complete/)).toBeTruthy();
  });

  it("passes force=true when the override checkbox is enabled", async () => {
    importMutationMock.mockResolvedValue({
      totalItems: 1,
      updated: 1,
      skippedAlreadySurveyed: [],
      errors: [],
    });

    render(<GpsImportPanel />);
    fireEvent.change(screen.getByLabelText(/paste JSON/i), {
      target: {
        value: JSON.stringify({
          items: [
            {
              lotCode: "D-5-12",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Parse pasted JSON/i }));
    await waitFor(() => {
      expect(screen.getByTestId("gps-import-force-checkbox")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("gps-import-force-checkbox"));
    fireEvent.click(screen.getByTestId("gps-import-run-button"));

    await waitFor(() => {
      expect(importMutationMock).toHaveBeenCalled();
    });
    expect(importMutationMock.mock.calls[0]![0]).toMatchObject({ force: true });
  });

  it("renders the server's error groups in the result panel", async () => {
    importMutationMock.mockResolvedValue({
      totalItems: 3,
      updated: 1,
      skippedAlreadySurveyed: [
        {
          lotCode: "D-5-13",
          reason: "ALREADY_SURVEYED",
          details: "Already surveyed.",
        },
      ],
      errors: [
        {
          lotCode: "GHOST-99",
          reason: "NOT_FOUND",
          details: "No lot exists with code \"GHOST-99\".",
        },
      ],
    });

    render(<GpsImportPanel />);
    fireEvent.change(screen.getByLabelText(/paste JSON/i), {
      target: {
        value: JSON.stringify({
          items: [
            {
              lotCode: "D-5-12",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
            {
              lotCode: "D-5-13",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
            {
              lotCode: "GHOST-99",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Parse pasted JSON/i }));
    await waitFor(() => {
      expect(screen.getByTestId("gps-import-run-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("gps-import-run-button"));

    await waitFor(() => {
      expect(screen.getByTestId("gps-import-result")).toBeTruthy();
    });
    expect(screen.getByTestId("gps-import-errors-NOT_FOUND")).toBeTruthy();
    expect(screen.getByText(/Skipped — already surveyed \(1\)/)).toBeTruthy();
  });

  it("surfaces a translated server error in the error panel", async () => {
    importMutationMock.mockRejectedValue(
      new ConvexError({
        code: "FORBIDDEN",
        message: "Your role does not permit this action.",
      }),
    );

    render(<GpsImportPanel />);
    fireEvent.change(screen.getByLabelText(/paste JSON/i), {
      target: {
        value: JSON.stringify({
          items: [
            {
              lotCode: "D-5-12",
              polygon: [
                { lat: 14.6758, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0398 },
                { lat: 14.6762, lng: 121.0402 },
              ],
            },
          ],
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Parse pasted JSON/i }));
    await waitFor(() => {
      expect(screen.getByTestId("gps-import-run-button")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("gps-import-run-button"));

    await waitFor(() => {
      expect(screen.getByTestId("gps-import-error")).toBeTruthy();
    });
  });

  it("surfaces a parse error in the error panel", async () => {
    render(<GpsImportPanel />);
    fireEvent.change(screen.getByLabelText(/paste JSON/i), {
      target: { value: "{ not valid json" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Parse pasted JSON/i }));
    await waitFor(() => {
      expect(screen.getByTestId("gps-import-error")).toBeTruthy();
    });
  });
});
