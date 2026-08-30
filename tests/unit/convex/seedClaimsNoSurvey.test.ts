/**
 * Demo data may invent a name. It may not invent a measurement.
 *
 * The seed wrote `geometryStatus: "surveyed"` over coordinates
 * generated from each lot's index — every lot nine metres further north
 * than the last, cycling east in fours. That is not a cemetery, it is a
 * staircase, and because the index runs across sections it interleaved
 * all three gardens through each other.
 *
 * It went unnoticed for as long as the map drew everything on a grid
 * and ignored geometry entirely. The moment the map started drawing
 * measured positions it drew these, faithfully, and the demo park came
 * out as a scatter of nine lots under three overlapping labels.
 *
 * Inventing a customer is fine. Inventing a MEASUREMENT is different in
 * kind: it makes the map assert something about the ground.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The seed with its comments stripped.
 *
 * The comment explaining this fix quotes the very string being banned,
 * so a naive read of the file matches its own documentation and the
 * test fails on prose rather than on code.
 */
const SEED = readFileSync(
  path.resolve(__dirname, "../../../convex/seed.ts"),
  "utf8",
)
  .split(String.fromCharCode(10))
  .filter((line) => {
    const t = line.trim();
    return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
  })
  .join(String.fromCharCode(10));

describe("the demo seed", () => {
  it("does NOT claim its invented coordinates were surveyed", () => {
    expect(SEED).not.toMatch(/geometryStatus:\s*"surveyed"/);
  });

  it("writes them as placeholders", () => {
    expect(SEED).toMatch(/geometryStatus:\s*"placeholder"/);
  });

  it("claims no capture source either", () => {
    // `geometrySource` is how the app tells a survey from a guess. Demo
    // data must not appear in any of those categories.
    expect(SEED).not.toMatch(/geometrySource:/);
    expect(SEED).not.toMatch(/geometryAccuracyM:/);
  });

  it("still writes SOME geometry, because the schema requires it", () => {
    // The fix is the claim, not the coordinates: every lot document
    // needs a geometry object whether or not anybody measured it.
    expect(SEED).toMatch(/geometryAround\(/);
  });
});
