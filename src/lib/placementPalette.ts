/**
 * Colouring the map by how well a position is known.
 *
 * The survey view proves every lot it draws is somewhere real, and then
 * says nothing at all about how confident that is. A corner measured by
 * a surveyor and a phone fix taken beside a wall render as the same
 * solid box. So does a row somebody drew on a map with a mouse.
 *
 * Switching the map to this palette answers a question nothing else
 * can: which parts of the park are actually surveyed, and which are
 * standing on a guess. It is an auditing view, not a prettier one.
 *
 * Deliberately NOT the status palette with different shades. Status and
 * confidence are different questions and a reader must never be in
 * doubt about which one the colours are answering — hence a legend that
 * swaps wholesale rather than a second dimension smuggled into the
 * existing colours.
 */

export type ColourMode = "status" | "placement";

/** The four ways a lot can come to have a position, plus not knowing. */
export type PlacementKind =
  | "imported"
  | "gps"
  | "drawn"
  | "clicked"
  | "unknown";

export interface PlacementBand {
  kind: PlacementKind;
  /** Scene colour, as a hex integer. */
  color: number;
  label: string;
  /** What the colour is claiming, in one line. */
  meaning: string;
}

/**
 * Ordered best-known to least, which is the order the legend reads and
 * the order somebody working through the park would fix them in.
 */
export const PLACEMENT_BANDS: readonly PlacementBand[] = [
  {
    kind: "imported",
    color: 0x1d5c4d,
    label: "Surveyed",
    meaning: "Measured outline and angle, from a survey file.",
  },
  {
    kind: "drawn",
    color: 0x6b8f7a,
    label: "Drawn",
    meaning:
      "Laid along a row drawn on the map. The angle is real; nobody stood here.",
  },
  {
    kind: "gps",
    color: 0xd9a441,
    label: "Phone",
    meaning: "Captured on a phone at the lot, accurate to a few metres.",
  },
  {
    kind: "clicked",
    color: 0x94a3b8,
    label: "Pointed at",
    meaning: "A point clicked on a map. The shape is assumed.",
  },
  {
    kind: "unknown",
    color: 0xcf5b5b,
    label: "Unrecorded",
    meaning: "Placed before the source was tracked — nothing says how.",
  },
];

const BY_KIND = new Map(PLACEMENT_BANDS.map((b) => [b.kind, b]));

/**
 * The band a stored source falls into.
 *
 * An unrecognised value lands in `unknown` rather than being dropped or
 * guessed at. A lot the map cannot classify is exactly the lot somebody
 * needs to look at, so it should be conspicuous rather than invisible.
 */
export function placementBand(source: string | null): PlacementBand {
  return BY_KIND.get((source ?? "unknown") as PlacementKind) ??
    BY_KIND.get("unknown")!;
}

/**
 * How far a phone fix could be out, in metres, for drawing a ring
 * around it.
 *
 * Only GPS carries a radius. A survey has an outline instead, and a
 * drawn or clicked position has no measured uncertainty at all — a ring
 * on those would invent a number nobody recorded.
 */
export function uncertaintyRadiusM(
  source: string | null,
  accuracyM: number | null,
): number | null {
  if (source !== "gps") return null;
  if (accuracyM === null || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    return null;
  }
  return accuracyM;
}

/**
 * How much of the park is standing on something measured.
 *
 * One number for the whole map, so the honest answer to "is this map
 * any good yet" does not require clicking through two thousand lots.
 */
export function placementSummary(
  lots: ReadonlyArray<{ source: string | null }>,
): {
  total: number;
  counts: Record<PlacementKind, number>;
  /** Share placed by something better than a guess. */
  measuredShare: number;
} {
  const counts: Record<PlacementKind, number> = {
    imported: 0,
    gps: 0,
    drawn: 0,
    clicked: 0,
    unknown: 0,
  };
  for (const lot of lots) counts[placementBand(lot.source).kind] += 1;
  const total = lots.length;
  return {
    total,
    counts,
    // Only a real survey counts as measured. A drawn row has a true
    // bearing but no measured plot, and calling that "measured" would
    // be the exact overstatement this palette exists to prevent.
    measuredShare: total === 0 ? 0 : counts.imported / total,
  };
}
