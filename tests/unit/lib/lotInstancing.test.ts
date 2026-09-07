/**
 * Drawing two thousand graves without two thousand objects.
 *
 * Instancing is the difference between a map that works at the size of
 * a real park and one that stops working the moment the park is mapped.
 * It also moves the lot↔object relationship from "one group each" to
 * "an index into a shared buffer", and that is where the danger is: an
 * index off by one selects the WRONG GRAVE, and the map looks perfectly
 * correct while doing it.
 *
 * So these tests are mostly about bookkeeping and matrices, both of
 * which are checkable with numbers, and neither of which is checkable
 * by looking at a screenshot.
 */

import { describe, expect, it } from "vitest";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  baseSize,
  composeMatrix,
  hiddenMatrix,
  instanceMatrix,
  PARTS,
  partsForLot,
  partTransform,
  planInstances,
  type LotShape,
} from "@/lib/lotInstancing";

function lot(over: Partial<LotShape> = {}): LotShape {
  return { lotId: "lots:a", type: "single", stone: false, ...over };
}

const DIMS = { baseW: 2.1, baseD: 2.6, wallH: 3.4 };

describe("what a lot is built from", () => {
  it("gives every lot a slab and an inlay", () => {
    expect(partsForLot(lot())).toEqual(["base", "inset"]);
  });

  it("builds a mausoleum, not a slab with a stone", () => {
    const parts = partsForLot(lot({ type: "mausoleum", stone: true }));
    expect(parts).toContain("wall");
    expect(parts).toContain("roof");
    expect(parts).not.toContain("headstone");
  });

  it("gives a sold lot a headstone and a mausoleum none", () => {
    expect(partsForLot(lot({ stone: true }))).toContain("headstone");
    expect(partsForLot(lot({ type: "mausoleum", stone: true }))).not.toContain(
      "headstone",
    );
  });

  it("leaves an available lot bare", () => {
    // Nothing is sold here yet; a headstone would be a claim.
    expect(partsForLot(lot({ stone: false }))).toEqual(["base", "inset"]);
  });

  it("names only parts the renderer knows", () => {
    for (const shape of [
      lot(),
      lot({ stone: true }),
      lot({ type: "mausoleum", stone: true }),
      lot({ type: "family", stone: true }),
    ]) {
      for (const p of partsForLot(shape)) {
        expect(PARTS).toContain(p);
      }
    }
  });
});

describe("assigning instance slots", () => {
  it("counts each part across every lot", () => {
    const plan = planInstances([
      lot({ lotId: "a" }),
      lot({ lotId: "b", stone: true }),
      lot({ lotId: "c", type: "mausoleum", stone: true }),
    ]);
    expect(plan.counts.base).toBe(3);
    expect(plan.counts.inset).toBe(3);
    expect(plan.counts.headstone).toBe(1);
    expect(plan.counts.wall).toBe(1);
  });

  it("remembers every slot a lot occupies", () => {
    // Selecting a lot has to lift ALL of its pieces. A missed slot
    // leaves a headstone behind while its slab rises.
    const plan = planInstances([lot({ lotId: "a", stone: true })]);
    expect(plan.slotsByLot.get("a")?.map((s) => s.part)).toEqual([
      "base",
      "inset",
      "headstone",
      "cap",
      "stake",
      "flag",
    ]);
  });

  it("maps a part's index BACK to the right lot", () => {
    // This is the pick path: raycasting the base mesh returns an
    // instance index, and this is what turns it into a grave. Off by
    // one here selects the neighbour.
    const plan = planInstances([
      lot({ lotId: "a" }),
      lot({ lotId: "b" }),
      lot({ lotId: "c" }),
    ]);
    expect(plan.lotIdsByPart.base).toEqual(["a", "b", "c"]);
    const slot = plan.slotsByLot.get("b")!.find((s) => s.part === "base")!;
    expect(plan.lotIdsByPart.base![slot.index]).toBe("b");
  });

  it("keeps indices dense when lots need different parts", () => {
    // The lot with no stone must not leave a hole in the headstone
    // buffer — a gap would shift every later lot's stone onto the wrong
    // grave.
    const plan = planInstances([
      lot({ lotId: "a", stone: true }),
      lot({ lotId: "b", stone: false }),
      lot({ lotId: "c", stone: true }),
    ]);
    expect(plan.lotIdsByPart.headstone).toEqual(["a", "c"]);
    expect(plan.counts.headstone).toBe(2);
  });

  it("preserves the caller's order", () => {
    // Code order is row order. A shuffle makes an index unstable across
    // a rebuild, which selects the wrong grave after a refresh.
    const ids = ["z", "m", "a"];
    const plan = planInstances(ids.map((lotId) => lot({ lotId })));
    expect(plan.lotIdsByPart.base).toEqual(ids);
  });

  it("REFUSES a duplicate lot rather than losing one", () => {
    // The second would overwrite the first's slots, leaving its pieces
    // stuck visible, unselectable and unfilterable.
    expect(() =>
      planInstances([lot({ lotId: "a" }), lot({ lotId: "a" })]),
    ).toThrow(/duplicate/i);
  });

  it("plans nothing for no lots", () => {
    const plan = planInstances([]);
    expect(plan.counts.base).toBeUndefined();
    expect(plan.slotsByLot.size).toBe(0);
  });
});

// --- the matrices ------------------------------------------------------

/** Three.js reads these column-major: translation sits at 12, 13, 14. */
function translationOf(m: number[]) {
  return { x: m[12]!, y: m[13]!, z: m[14]! };
}

describe("composing a transform", () => {
  it("puts translation where Three.js reads it", () => {
    // Row-major would look almost right — lots roughly in place,
    // rotations subtly wrong — which survives a glance at the screen.
    const m = composeMatrix(3, 4, 5, 0, 1, 1, 1);
    expect(translationOf(m)).toEqual({ x: 3, y: 4, z: 5 });
    expect(m[15]).toBe(1);
  });

  it("scales along the diagonal when unrotated", () => {
    const m = composeMatrix(0, 0, 0, 0, 2, 3, 4);
    expect(m[0]).toBeCloseTo(2, 9);
    expect(m[5]).toBeCloseTo(3, 9);
    expect(m[10]).toBeCloseTo(4, 9);
  });

  it("rotates about Y, leaving height alone", () => {
    const m = composeMatrix(0, 0, 0, Math.PI / 2, 1, 1, 1);
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[2]).toBeCloseTo(-1, 9);
    expect(m[5]).toBeCloseTo(1, 9); // Y untouched
    expect(m[8]).toBeCloseTo(1, 9);
  });

  it("keeps scale and rotation from cancelling each other", () => {
    // A 4×1 plot turned 90° should measure 1 across and 4 deep.
    const m = composeMatrix(0, 0, 0, Math.PI / 2, 4, 1, 1);
    expect(Math.hypot(m[0]!, m[2]!)).toBeCloseTo(4, 9);
  });
});

describe("agreeing with Three.js", () => {
  it("composes the same matrix Three.js would", () => {
    /*
     * The one assumption everything else rests on.
     *
     * These matrices are hand-built so they can be checked with
     * numbers, but that only helps if the convention matches the
     * library actually reading them. A row-major array would place
     * every lot in roughly the right spot with subtly wrong rotations
     * — wrong in a way that looks like a rendering quirk rather than a
     * bug, and that no unit test of my own arithmetic would catch,
     * because it would be consistent with itself.
     */
    const mine = composeMatrix(10, 5, -6, 0.7, 2, 3, 4);
    const theirs = new Matrix4()
      .compose(
        new Vector3(10, 5, -6),
        new Quaternion().setFromEuler(new Euler(0, 0.7, 0)),
        new Vector3(2, 3, 4),
      )
      .elements;
    for (let i = 0; i < 16; i++) {
      expect(mine[i]).toBeCloseTo(theirs[i]!, 12);
    }
  });
});

describe("hiding an instance", () => {
  it("collapses it to nothing", () => {
    // An instance cannot be removed — the buffer is fixed — so a
    // filtered lot is scaled away. A sliver would still rasterise and
    // still catch a raycast.
    const m = hiddenMatrix();
    expect(m[0]).toBe(0);
    expect(m[5]).toBe(0);
    expect(m[10]).toBe(0);
  });

  it("also moves it out of the scene", () => {
    // Belt and braces: zero scale at the origin can still register as a
    // degenerate hit in some raycasters.
    expect(translationOf(hiddenMatrix()).y).toBeLessThan(-100);
  });
});

describe("placing a lot's pieces", () => {
  it("sizes the slab from the lot's type", () => {
    expect(baseSize("family")).toEqual({ baseW: 2.6, baseD: 3.0 });
    expect(baseSize("single").baseW).toBeLessThan(baseSize("family").baseW);
  });

  it("puts the slab at the lot's position", () => {
    const m = instanceMatrix("base", DIMS, { x: 10, z: -4, rotY: 0 });
    expect(translationOf(m).x).toBeCloseTo(10, 6);
    expect(translationOf(m).z).toBeCloseTo(-4, 6);
  });

  it("stands the headstone at the HEAD of the grave", () => {
    // Offset along -Z in the lot's own frame. Ignoring that would put
    // it in the middle of the plot.
    const m = instanceMatrix("headstone", DIMS, { x: 0, z: 0, rotY: 0 });
    expect(translationOf(m).z).toBeCloseTo(-DIMS.baseD / 2 + 0.35, 6);
    expect(translationOf(m).y).toBeGreaterThan(0.5);
  });

  it("ROTATES the offset with the grave, not just the shape", () => {
    // The whole reason survey mode exists: a row runs at an angle. A
    // headstone whose offset ignored the bearing would sit beside its
    // own grave instead of at the head of it.
    const straight = instanceMatrix("headstone", DIMS, {
      x: 0,
      z: 0,
      rotY: 0,
    });
    const turned = instanceMatrix("headstone", DIMS, {
      x: 0,
      z: 0,
      rotY: Math.PI / 2,
    });
    // Turned a quarter, the offset that was along -Z now runs along -X.
    expect(translationOf(turned).x).toBeCloseTo(translationOf(straight).z, 6);
    expect(translationOf(turned).z).toBeCloseTo(0, 6);
  });

  it("raises the wall by half its own height so it stands on the slab", () => {
    const m = instanceMatrix("wall", DIMS, { x: 0, z: 0, rotY: 0 });
    expect(translationOf(m).y).toBeCloseTo(0.3 + DIMS.wallH / 2, 6);
  });

  it("puts the roof above the wall, whatever height it got", () => {
    // Wall height is randomised per lot; a roof at a fixed height would
    // float over the short ones and sink into the tall ones.
    const tall = instanceMatrix("roof", { ...DIMS, wallH: 4 }, {
      x: 0,
      z: 0,
      rotY: 0,
    });
    const short = instanceMatrix("roof", { ...DIMS, wallH: 3 }, {
      x: 0,
      z: 0,
      rotY: 0,
    });
    expect(translationOf(tall).y - translationOf(short).y).toBeCloseTo(1, 6);
  });

  it("lifts every piece together when a lot is selected", () => {
    // The lift used to be one group's Y. Applied to only some parts, a
    // slab rises and leaves its headstone in the ground.
    for (const part of partsForLot(lot({ stone: true }))) {
      const rest = instanceMatrix(part, DIMS, { x: 0, z: 0, rotY: 0 });
      const up = instanceMatrix(part, DIMS, { x: 0, z: 0, rotY: 0, lift: 0.5 });
      expect(translationOf(up).y - translationOf(rest).y).toBeCloseTo(0.5, 6);
    }
  });

  it("gives every part a real size", () => {
    // A zero on any axis is an invisible piece, and invisible is
    // exactly what a filtered instance looks like.
    for (const part of PARTS) {
      const t = partTransform(part, DIMS);
      for (const s of t.scale) expect(s).toBeGreaterThan(0);
    }
  });
});
