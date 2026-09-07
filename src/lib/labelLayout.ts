/**
 * Keeping garden labels off each other.
 *
 * The 3D scene projects one DOM label per garden onto the canvas. When
 * two gardens sit close together, or the camera flattens toward the
 * horizon, their labels land on the same few pixels and stack into an
 * unreadable pile — which is exactly what the map looked like with
 * three gardens in it.
 *
 * The fix is not clever placement. It is a stable rule about who moves
 * and who gets dropped, applied every frame without the labels
 * jittering as the camera turns.
 *
 * Pure on purpose: the scene it belongs to cannot run in jsdom, and
 * "two labels overlap" is a thing to check with numbers rather than by
 * squinting at a screenshot.
 */

export interface LabelBox {
  /** Stable identity — the garden. Ordering ties break on it. */
  key: string;
  /** Where the projection put it, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Distance from the camera. Nearer labels win a collision: they
   * belong to the gardens the reader is looking at.
   */
  depth: number;
  /** True when the anchor is behind the camera. */
  behind: boolean;
}

export interface PlacedLabel {
  key: string;
  x: number;
  y: number;
  visible: boolean;
}

/** How far a label may be nudged upward before it is dropped instead. */
export const MAX_NUDGE_PX = 44;

/** Vertical breathing room between two labels, in pixels. */
export const LABEL_GAP_PX = 6;

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width &&
    Math.abs(a.y - b.y) * 2 < a.height + b.height + LABEL_GAP_PX
  );
}

/**
 * Decide where each label actually goes.
 *
 * Nearest first, so a garden in the foreground keeps its place and the
 * ones behind it move. A label that cannot be moved clear within
 * `MAX_NUDGE_PX` is hidden rather than shoved somewhere it no longer
 * points at anything — a label forty pixels from its garden is still a
 * label; one two hundred pixels away is a lie about which garden it
 * names.
 *
 * Labels are nudged UP only. Alternating up and down would halve the
 * collisions and double the jitter, because a label that flips sides as
 * the camera drifts reads as a glitch.
 */
export function layoutLabels(
  boxes: readonly LabelBox[],
  viewport: { width: number; height: number },
): PlacedLabel[] {
  const order = [...boxes].sort(
    (a, b) => a.depth - b.depth || a.key.localeCompare(b.key),
  );

  const placed: Array<LabelBox & { visible: boolean }> = [];

  for (const box of order) {
    if (box.behind) {
      placed.push({ ...box, visible: false });
      continue;
    }

    // Off the canvas entirely: nothing to collide with and nothing to
    // read.
    if (
      box.x < -box.width ||
      box.x > viewport.width + box.width ||
      box.y < -box.height ||
      box.y > viewport.height + box.height
    ) {
      placed.push({ ...box, visible: false });
      continue;
    }

    let y = box.y;
    let nudged = 0;
    let clear = false;

    while (nudged <= MAX_NUDGE_PX) {
      const candidate = { x: box.x, y, width: box.width, height: box.height };
      const hit = placed.some(
        (p) => p.visible && overlaps(candidate, { x: p.x, y: p.y, width: p.width, height: p.height }),
      );
      if (!hit) {
        clear = true;
        break;
      }
      const step = Math.min(8, MAX_NUDGE_PX - nudged + 1);
      y -= step;
      nudged += step;
    }

    placed.push({ ...box, y, visible: clear });
  }

  // Back to the caller's order, so the DOM nodes keep their identity.
  const byKey = new Map(placed.map((p) => [p.key, p]));
  return boxes.map((b) => {
    const p = byKey.get(b.key)!;
    return { key: b.key, x: p.x, y: p.y, visible: p.visible };
  });
}
