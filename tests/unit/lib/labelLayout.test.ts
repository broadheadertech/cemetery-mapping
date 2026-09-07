/**
 * Garden labels that do not pile up.
 *
 * With three gardens close together the labels landed on the same few
 * pixels and stacked into an unreadable heap — which is what the map
 * actually looked like. Nothing throws; the names are simply illegible,
 * and the one on top is whichever the loop happened to write last.
 *
 * The rules being checked are about STABILITY as much as separation. A
 * label that flips sides as the camera drifts, or that keeps its place
 * one frame and loses it the next, reads as a glitch even when every
 * individual frame is technically fine.
 */

import { describe, expect, it } from "vitest";
import {
  LABEL_GAP_PX,
  layoutLabels,
  MAX_NUDGE_PX,
  type LabelBox,
} from "@/lib/labelLayout";

const VIEW = { width: 1000, height: 600 };

function box(over: Partial<LabelBox> = {}): LabelBox {
  return {
    key: "a",
    x: 500,
    y: 300,
    width: 180,
    height: 24,
    depth: 10,
    behind: false,
    ...over,
  };
}

function find(out: ReturnType<typeof layoutLabels>, key: string) {
  const hit = out.find((p) => p.key === key);
  expect(hit, `no placement for ${key}`).toBeDefined();
  return hit!;
}

describe("labels that do not collide", () => {
  it("leaves a lone label exactly where it projected", () => {
    const out = layoutLabels([box()], VIEW);
    expect(find(out, "a")).toMatchObject({ x: 500, y: 300, visible: true });
  });

  it("moves the FARTHER label when two land on each other", () => {
    // The near garden is the one being looked at; it keeps its place.
    const out = layoutLabels(
      [
        box({ key: "near", depth: 5 }),
        box({ key: "far", depth: 50 }),
      ],
      VIEW,
    );
    expect(find(out, "near").y).toBe(300);
    expect(find(out, "far").y).toBeLessThan(300);
  });

  it("separates them by enough to read", () => {
    const out = layoutLabels(
      [box({ key: "near", depth: 5 }), box({ key: "far", depth: 50 })],
      VIEW,
    );
    const gap = Math.abs(find(out, "near").y - find(out, "far").y);
    expect(gap).toBeGreaterThanOrEqual(24 + LABEL_GAP_PX - 8);
  });

  it("keeps three labels apart, not just two", () => {
    // The reported case: three gardens, one heap.
    const out = layoutLabels(
      [
        box({ key: "a", depth: 5 }),
        box({ key: "b", depth: 10 }),
        box({ key: "c", depth: 15 }),
      ],
      VIEW,
    );
    const ys = ["a", "b", "c"]
      .map((k) => find(out, k))
      .filter((p) => p.visible)
      .map((p) => p.y)
      .sort((m, n) => m - n);
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]! - ys[i - 1]!).toBeGreaterThan(8);
    }
  });

  it("does not move a label that has room", () => {
    // Nudging everything on principle would make the map twitch as the
    // camera drifts.
    const out = layoutLabels(
      [box({ key: "a", x: 100 }), box({ key: "b", x: 800 })],
      VIEW,
    );
    expect(find(out, "a").y).toBe(300);
    expect(find(out, "b").y).toBe(300);
  });
});

describe("labels that should not be drawn at all", () => {
  it("hides one whose garden is behind the camera", () => {
    // Projection wraps a point behind the viewer round to the front, so
    // without this the label appears over a garden that is not there.
    const out = layoutLabels([box({ behind: true })], VIEW);
    expect(find(out, "a").visible).toBe(false);
  });

  it("hides one projected off the canvas", () => {
    const out = layoutLabels([box({ x: -900 }), box({ key: "b", y: 5000 })], VIEW);
    expect(find(out, "a").visible).toBe(false);
    expect(find(out, "b").visible).toBe(false);
  });

  it("DROPS a label rather than shoving it away from its garden", () => {
    // A label forty pixels from its garden is still a label. One two
    // hundred pixels away names the wrong thing, confidently.
    const many = Array.from({ length: 12 }, (_, i) =>
      box({ key: `g${i}`, depth: i }),
    );
    const out = layoutLabels(many, VIEW);
    const visible = out.filter((p) => p.visible);
    expect(visible.length).toBeLessThan(many.length);
    for (const p of visible) {
      expect(300 - p.y).toBeLessThanOrEqual(MAX_NUDGE_PX);
    }
  });

  it("never lets a hidden label block a visible one's place", () => {
    // A dropped label still occupying space would push the next one
    // away for no reason a reader can see.
    const out = layoutLabels(
      [box({ key: "gone", behind: true }), box({ key: "here", depth: 99 })],
      VIEW,
    );
    expect(find(out, "here")).toMatchObject({ y: 300, visible: true });
  });
});

describe("staying steady", () => {
  it("returns placements in the order it was given", () => {
    // The caller maps these onto existing DOM nodes by index; reordering
    // would move every label to the wrong garden.
    const out = layoutLabels(
      [box({ key: "z", depth: 90 }), box({ key: "a", depth: 1 })],
      VIEW,
    );
    expect(out.map((p) => p.key)).toEqual(["z", "a"]);
  });

  it("gives the same answer twice for the same input", () => {
    const boxes = [
      box({ key: "a", depth: 5 }),
      box({ key: "b", depth: 5 }),
      box({ key: "c", depth: 5 }),
    ];
    expect(layoutLabels(boxes, VIEW)).toEqual(layoutLabels(boxes, VIEW));
  });

  it("breaks depth ties on a stable key, not on array order", () => {
    // Equal depths are common — gardens laid side by side. Without a
    // tiebreak the winner changes frame to frame and the labels swap
    // places while nothing moves.
    const a = layoutLabels(
      [box({ key: "a", depth: 5 }), box({ key: "b", depth: 5 })],
      VIEW,
    );
    const b = layoutLabels(
      [box({ key: "b", depth: 5 }), box({ key: "a", depth: 5 })],
      VIEW,
    );
    expect(find(a, "a").y).toBe(find(b, "a").y);
    expect(find(a, "b").y).toBe(find(b, "b").y);
  });
});
