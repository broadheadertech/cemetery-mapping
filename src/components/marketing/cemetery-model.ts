/**
 * The brochure-side cemetery plan — one source of truth for both the
 * 2D sketch and the 3D view.
 *
 * This model used to live inside `CemeteryMapSVG`. It was lifted out
 * when the 3D view landed, for the obvious reason: two renderers each
 * deriving their own gardens and lot statuses would drift, and a
 * visitor toggling between the two would watch lots change status in
 * front of them.
 *
 * ## This is a sketch, not the cemetery
 *
 * Real lot geometry lives in Convex — every lot document carries a
 * lat/lng centroid and polygon vertices (ADR-0008). What is modelled
 * here is a hand-tuned wayfinding illustration: six named gardens laid
 * out on an 800×500 plan, with a plausible spread of statuses. It
 * exists so the public page can show the shape of the park without
 * publishing the inventory.
 *
 * Wiring this to live data is a deliberate future step, not an
 * oversight — it needs a public query exposing lot status, which is a
 * decision about what the cemetery publishes rather than a piece of
 * missing code. The renderers take their data through these functions,
 * so that swap lands here and nowhere else.
 */

export type LotStatus = "available" | "reserved" | "occupied";

export interface CemeterySectionPick {
  section: string;
  id: string;
  status: LotStatus;
}

export interface PlanSection {
  /** Single-letter section key; the prefix of every lot code in it. */
  id: string;
  /** Plan-space rectangle, in the 800×500 coordinate system. */
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

/** The plan, in an 800×500 coordinate space. */
export const PLAN_WIDTH = 800;
export const PLAN_HEIGHT = 500;

export const SECTIONS: ReadonlyArray<PlanSection> = [
  { id: "A", x: 60, y: 80, w: 200, h: 140, label: "GARDEN OF GRACE" },
  { id: "B", x: 280, y: 80, w: 240, h: 140, label: "GARDEN OF FAITH" },
  { id: "C", x: 540, y: 80, w: 180, h: 140, label: "GARDEN OF HOPE" },
  { id: "D", x: 60, y: 260, w: 220, h: 160, label: "COLUMBARIUM EAST" },
  { id: "E", x: 300, y: 260, w: 240, h: 160, label: "GARDEN OF PEACE" },
  { id: "F", x: 560, y: 260, w: 160, h: 160, label: "MAUSOLEUM ROW" },
];

/**
 * Lot grid geometry, shared so the two views space lots identically.
 *
 * How many lots a garden holds is DERIVED from how much room it has,
 * rather than declared. Each garden used to carry a hand-picked count
 * of six to twelve, which filled the top two rows and left the rest of
 * the plot empty. Flat on paper that passed for white space; standing
 * up in the 3D view it read as an unfinished park — acres of blank
 * slab with a handful of plots in one corner.
 *
 * A garden now holds what fits, which is also how a real plan works:
 * the ground decides, not a number someone typed.
 */
const TARGET_CELL_WIDTH = 38;
const ROW_HEIGHT = 16;
const ROW_GAP = 4;
const PAD_X = 10;
const PAD_TOP = 18;
const PAD_BOTTOM = 10;

/** Columns and rows a garden's rectangle has room for. */
export function gridOf(section: PlanSection): {
  columns: number;
  rows: number;
} {
  const usableWidth = section.w - PAD_X * 2;
  const usableHeight = section.h - PAD_TOP - PAD_BOTTOM;
  return {
    columns: Math.max(2, Math.floor(usableWidth / TARGET_CELL_WIDTH)),
    rows: Math.max(1, Math.floor(usableHeight / (ROW_HEIGHT + ROW_GAP))),
  };
}

/** How many lots a garden holds. */
export function lotCountOf(section: PlanSection): number {
  const { columns, rows } = gridOf(section);
  return columns * rows;
}

export interface PlanLot {
  /** Lot code, e.g. `B-104`. */
  id: string;
  status: LotStatus;
  sectionId: string;
  sectionLabel: string;
  /** Plan-space rectangle of this lot's cell. */
  x: number;
  y: number;
  w: number;
  h: number;
  column: number;
  row: number;
}

/**
 * Status for the lot at a given position in a garden.
 *
 * A fixed pattern rather than randomness: the page must look the same
 * on every visit and on every render, or the two views disagree and the
 * server markup mismatches on hydration.
 *
 * Keyed on COLUMN AND ROW, not on the running index. Indexing by
 * position alone means the pattern's period can line up with a garden's
 * column count — `index % 5` in a five-column garden marks column zero
 * of every row, and the 3D view renders that as a solid wall of
 * headstones down one edge rather than a scatter of plots. Mixing
 * column, row, and a per-garden seed breaks that alignment whatever
 * width a garden happens to be.
 */
function statusFor(sectionId: string, column: number, row: number): LotStatus {
  const seed = sectionId.charCodeAt(0) - 65;
  const n = (column * 5 + row * 3 + seed) % 13;
  if (n === 2 || n === 9) return "occupied";
  if (n === 6) return "reserved";
  return "available";
}

/** Every lot in a section, positioned in plan space. */
export function lotsOf(section: PlanSection): PlanLot[] {
  const { columns } = gridOf(section);
  const cellWidth = (section.w - PAD_X * 2) / columns;
  return Array.from({ length: lotCountOf(section) }, (_, i) => {
    const column = i % columns;
    const row = Math.floor(i / columns);
    return {
      id: `${section.id}-${100 + i}`,
      status: statusFor(section.id, column, row),
      sectionId: section.id,
      sectionLabel: section.label,
      x: section.x + PAD_X + column * cellWidth,
      y: section.y + PAD_TOP + row * (ROW_HEIGHT + ROW_GAP),
      w: cellWidth - ROW_GAP,
      h: ROW_HEIGHT,
      column,
      row,
    };
  });
}

/** Every lot in the park, flattened. */
export function allLots(): PlanLot[] {
  return SECTIONS.flatMap(lotsOf);
}

/** The park's brand colours, as the renderers need them. */
export const PLAN_COLORS = {
  emerald: "#1D5C4D",
  gold: "#C9A96B",
  stone: "#B8B6AF",
  moss: "#4A8270",
  paper: "#FFFFFF",
  ivoryDeep: "#EDE7DA",
  ivory: "#F6F2EA",
} as const;

/** Status → fill, shared so a colour never means two things. */
export const STATUS_COLOR: Record<LotStatus, string> = {
  occupied: PLAN_COLORS.emerald,
  reserved: PLAN_COLORS.gold,
  available: PLAN_COLORS.paper,
};
