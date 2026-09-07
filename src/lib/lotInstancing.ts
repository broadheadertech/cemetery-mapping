/**
 * Drawing a whole cemetery without one object per grave.
 *
 * The scene built a `THREE.Group` of about nine meshes for every lot: a
 * slab, an inlay, and then either a mausoleum's wall, roof and finial or
 * a headstone, its cap, a stake and a flag. With nine lots on screen
 * that is ninety objects and nobody notices. At two thousand lots it is
 * roughly eighteen thousand, each its own draw call, and the map stops
 * being usable at exactly the moment the park is finally mapped.
 *
 * The fix is instancing: one mesh per PART, drawn N times from a buffer
 * of transforms. Nine draw calls instead of eighteen thousand.
 *
 * Two things make that collapse work, and both are decisions rather
 * than details:
 *
 *   - Every geometry is a UNIT shape and its real size lives in the
 *     instance's scale. A family plot and a single differ only by three
 *     numbers, and a mausoleum's wall height is randomised per lot —
 *     with a unit box those are all the same geometry.
 *
 *   - Colour is per instance, not per material. Five statuses across
 *     nine parts would otherwise be forty-five meshes again.
 *
 * This module is the arithmetic and the bookkeeping, kept apart from
 * Three.js because none of it can run in jsdom and the failure it
 * guards against is silent: an index off by one selects the wrong
 * grave, and the map looks perfectly fine while doing it.
 */

/** Every kind of piece a lot can be built from. */
export const PARTS = [
  "base",
  "inset",
  "wall",
  "roof",
  "fin",
  "headstone",
  "cap",
  "stake",
  "flag",
] as const;

export type Part = (typeof PARTS)[number];

export interface LotShape {
  lotId: string;
  /** single | family | mausoleum | niche */
  type: string;
  /** Whether this status is drawn with a headstone. */
  stone: boolean;
}

/**
 * Which pieces a given lot is made of.
 *
 * A mausoleum is a building; everything else is a slab that may or may
 * not carry a stone. Nothing here is cosmetic — the count decides how
 * big each instance buffer has to be, and a part missed here is a part
 * that silently never draws.
 */
export function partsForLot(lot: LotShape): Part[] {
  const parts: Part[] = ["base", "inset"];
  if (lot.type === "mausoleum") {
    parts.push("wall", "roof", "fin");
  } else if (lot.stone) {
    parts.push("headstone", "cap", "stake", "flag");
  }
  return parts;
}

/** Where one lot's piece sits in its part's instance buffer. */
export interface Slot {
  part: Part;
  index: number;
}

export interface InstancePlan {
  /** How many instances each part needs. Parts with none are absent. */
  counts: Partial<Record<Part, number>>;
  /** Every slot a lot occupies, so selecting it can move all of them. */
  slotsByLot: Map<string, Slot[]>;
  /**
   * The lot at each index of a part's buffer.
   *
   * Picking hit-tests the `base` mesh and gets back an instance index;
   * this is what turns that number into a grave.
   */
  lotIdsByPart: Partial<Record<Part, string[]>>;
}

/**
 * Assign every lot a slot in each part buffer it needs.
 *
 * Order is the caller's order, which is code order, which is the order
 * the rows were laid out. Keeping it means an instance index is stable
 * across a rebuild that did not change the lot set — and an index that
 * shuffles is an index that selects the wrong grave.
 */
export function planInstances(lots: readonly LotShape[]): InstancePlan {
  const counts: Partial<Record<Part, number>> = {};
  const lotIdsByPart: Partial<Record<Part, string[]>> = {};
  const slotsByLot = new Map<string, Slot[]>();

  for (const lot of lots) {
    const slots: Slot[] = [];
    for (const part of partsForLot(lot)) {
      const index = counts[part] ?? 0;
      counts[part] = index + 1;
      (lotIdsByPart[part] ??= []).push(lot.lotId);
      slots.push({ part, index });
    }
    // A duplicate id would overwrite the first lot's slots and leave
    // its pieces unreachable — stuck visible, unselectable, unfilterable.
    if (slotsByLot.has(lot.lotId)) {
      throw new Error(`Duplicate lot in instance plan: ${lot.lotId}`);
    }
    slotsByLot.set(lot.lotId, slots);
  }

  return { counts, slotsByLot, lotIdsByPart };
}

/**
 * A column-major 4×4 transform: translate, then rotate about Y, then
 * scale.
 *
 * Written by hand rather than through Three.js so it can be checked
 * against numbers. Three.js stores matrices column-major, and a
 * row-major array here would look almost right — lots in roughly the
 * correct places, rotations subtly wrong — which is the kind of error
 * that survives a glance at the screen.
 */
export function composeMatrix(
  tx: number,
  ty: number,
  tz: number,
  rotY: number,
  sx: number,
  sy: number,
  sz: number,
): number[] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [
    c * sx, 0, -s * sx, 0,
    0, sy, 0, 0,
    s * sz, 0, c * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * A transform that draws nothing.
 *
 * Filtering used to hide a lot by removing its group from the scene.
 * An instance cannot be removed — the buffer is fixed — so a hidden lot
 * is scaled to nothing instead. Zero rather than a tiny number: a
 * sliver still rasterises, and still catches a raycast.
 */
export function hiddenMatrix(): number[] {
  return composeMatrix(0, -1000, 0, 0, 0, 0, 0);
}

/** The unit-space size and offset of each part, before a lot's own size. */
export interface PartTransform {
  /** Offset from the lot's centre, in metres, before rotation. */
  offset: [number, number, number];
  /** Size in metres. */
  scale: [number, number, number];
  /** Extra rotation about Y, in radians, on top of the lot's bearing. */
  spin?: number;
}

export interface LotDimensions {
  /** Slab width and depth, from the lot's type. */
  baseW: number;
  baseD: number;
  /** Mausoleum wall height. Ignored by every other part. */
  wallH: number;
}

/** The slab under a lot, sized by its type. */
export function baseSize(type: string): { baseW: number; baseD: number } {
  return type === "family"
    ? { baseW: 2.6, baseD: 3.0 }
    : { baseW: 2.1, baseD: 2.6 };
}

/**
 * Where each piece sits and how big it is, in the lot's own frame.
 *
 * Lifted verbatim from the per-lot construction it replaces, so the
 * instanced scene draws the same cemetery as the one before it. The
 * `lift` is how far the whole lot rises when selected or hovered — it
 * used to be a group's y position and is now folded into each piece.
 */
export function partTransform(
  part: Part,
  dims: LotDimensions,
): PartTransform {
  const { baseW, baseD, wallH } = dims;
  const headW = baseW * 0.62;

  switch (part) {
    case "base":
      return { offset: [0, 0.15, 0], scale: [baseW, 0.3, baseD] };
    case "inset":
      return {
        offset: [0, 0.33, 0],
        scale: [baseW - 0.5, 0.06, baseD - 0.5],
      };
    case "wall":
      return {
        offset: [0, 0.3 + wallH / 2, 0],
        scale: [baseW - 0.2, wallH, baseD - 0.4],
      };
    case "roof":
      return {
        offset: [0, 0.3 + wallH + 0.42, 0],
        scale: [baseW * 0.78, 0.85, baseW * 0.78],
        spin: Math.PI / 4,
      };
    case "fin":
      return { offset: [0, 0.3 + wallH + 1.0, 0], scale: [0.1, 0.6, 0.1] };
    case "headstone":
      return {
        offset: [0, 0.9, -baseD / 2 + 0.35],
        scale: [headW, 1.2, 0.32],
      };
    case "cap":
      return {
        offset: [0, 1.5, -baseD / 2 + 0.35],
        scale: [headW, 0.32, headW],
      };
    case "stake":
      return {
        offset: [baseW / 2 - 0.25, 0.6, -baseD / 2 + 0.25],
        scale: [0.1, 0.6, 0.1],
      };
    case "flag":
      return {
        offset: [baseW / 2 - 0.05, 0.8, -baseD / 2 + 0.25],
        scale: [0.4, 0.26, 0.02],
      };
  }
}

/**
 * The full transform for one piece of one lot, in world space.
 *
 * The piece's offset is rotated by the lot's bearing before being added
 * to its position — a surveyed row runs at an angle, and a headstone
 * that ignored that would sit beside its own grave rather than at the
 * head of it.
 */
export function instanceMatrix(
  part: Part,
  dims: LotDimensions,
  lot: { x: number; z: number; rotY: number; lift?: number },
): number[] {
  const t = partTransform(part, dims);
  const [ox, oy, oz] = t.offset;
  const c = Math.cos(lot.rotY);
  const s = Math.sin(lot.rotY);
  return composeMatrix(
    lot.x + ox * c + oz * s,
    oy + (lot.lift ?? 0),
    lot.z - ox * s + oz * c,
    lot.rotY + (t.spin ?? 0),
    t.scale[0],
    t.scale[1],
    t.scale[2],
  );
}
