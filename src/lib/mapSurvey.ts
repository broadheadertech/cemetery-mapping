/**
 * Drawing the park as it actually is, rather than as a grid.
 *
 * A grid cannot draw an irregular garden honestly. Curved edges, angled
 * rows, blocks that do not line up — every arrangement of squares still
 * puts them in straight lines, and a garden drawn in the wrong shape
 * looks exactly as confident as one drawn right. That is worse than not
 * drawing it, because somebody trusts it.
 *
 * So the map has two modes and says which one it is in. This module is
 * the arithmetic behind that: turning measured coordinates into scene
 * metres, and deciding which mode the data can honestly support.
 *
 * It is pure on purpose. The Three.js scene is untestable in jsdom, so
 * everything that could be wrong in a way nobody would notice lives
 * here instead, where it can be checked against numbers.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** Scene coordinates, in metres, x east and z south. */
export interface ScenePoint {
  x: number;
  z: number;
}

/**
 * Metres per degree of latitude.
 *
 * Constant enough at any one park: the variation between the equator
 * and the poles is under one percent, and a cemetery spans a few
 * hundred metres.
 */
const M_PER_DEG_LAT = 110_574;

/** Metres per degree of longitude at the equator, before the cosine. */
const M_PER_DEG_LNG_EQ = 111_320;

/**
 * A coordinate as metres from an origin.
 *
 * Equirectangular, which is exact enough over a few hundred metres and
 * has the property that matters here: straight lines on the ground stay
 * straight on screen, so a row of lots surveyed in a line draws as one.
 *
 * `z` runs SOUTH so that north is −z, matching how the scene's camera
 * looks down the negative axis. Getting this backwards mirrors the park
 * front to back, which is exactly the sort of error that looks fine
 * until somebody walks it.
 */
export function projectToScene(p: LatLng, origin: LatLng): ScenePoint {
  const latRad = (origin.lat * Math.PI) / 180;
  return {
    x: (p.lng - origin.lng) * M_PER_DEG_LNG_EQ * Math.cos(latRad),
    z: -(p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** The distance between two coordinates, in metres. */
export function metresBetween(a: LatLng, b: LatLng): number {
  const p = projectToScene(b, a);
  return Math.sqrt(p.x * p.x + p.z * p.z);
}

export interface Extent {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
  depth: number;
}

/** The bounding box of projected points, for framing the camera. */
export function extentOf(points: readonly ScenePoint[]): Extent | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return {
    minX,
    maxX,
    minZ,
    maxZ,
    width: maxX - minX,
    depth: maxZ - minZ,
  };
}

/**
 * A lot's footprint in the scene, from its measured outline.
 *
 * Returns null when the survey recorded only a centre point. The caller
 * draws a rectangle from the lot's dimensions in that case — a real
 * position with an assumed shape, which is a different and lesser claim
 * than a measured outline, and the map should not present them alike.
 */
export function footprintOf(
  polygon: readonly LatLng[],
  origin: LatLng,
): ScenePoint[] | null {
  if (polygon.length < 3) return null;
  return polygon.map((p) => projectToScene(p, origin));
}

/**
 * The compass bearing of a footprint's longest edge, in radians.
 *
 * A surveyed lot is rarely square to north, and drawing it as though it
 * were is the visible half of "the map is not a survey". Used to rotate
 * the box drawn for a lot that has a footprint.
 */
export function bearingOf(footprint: readonly ScenePoint[]): number {
  let best = 0;
  let bestLen = -1;
  for (let i = 0; i < footprint.length; i++) {
    const a = footprint[i]!;
    const b = footprint[(i + 1) % footprint.length]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = dx * dx + dz * dz;
    if (len > bestLen) {
      bestLen = len;
      best = Math.atan2(dz, dx);
    }
  }
  return best;
}

// --- which mode the data can honestly support -------------------------

export type MapMode = "survey" | "arrangement";

export interface SectionCounts {
  name: string;
  displayName: string;
  placedCount: number;
  unplacedCount: number;
}

export interface ModeDecision {
  mode: MapMode;
  /** True when the reader may switch to the other mode and see something. */
  canSwitch: boolean;
  /** Gardens the survey view cannot draw, because nothing in them is placed. */
  missingSections: string[];
  placedCount: number;
  unplacedCount: number;
}

/**
 * Which view to open on, and what the other one would cost.
 *
 * The rule is deliberately simple: if anything at all has been
 * surveyed, that is the truth and the map opens on it. An arrangement
 * is a stand-in, and a stand-in should not win over a measurement
 * because there is more of it.
 *
 * But a park mid-rollout must not lose its map, so switching stays
 * available in both directions, and the gardens the survey view cannot
 * draw are NAMED rather than quietly absent.
 */
export function decideMode(
  sections: readonly SectionCounts[],
  preferred?: MapMode,
): ModeDecision {
  const placedCount = sections.reduce((n, s) => n + s.placedCount, 0);
  const unplacedCount = sections.reduce((n, s) => n + s.unplacedCount, 0);

  const missingSections = sections
    .filter((s) => s.placedCount === 0 && s.unplacedCount > 0)
    .map((s) => s.displayName);

  const anySurveyed = placedCount > 0;
  const anyUnsurveyed = unplacedCount > 0;

  // Nothing measured: only the arrangement exists, and switching to a
  // survey view would show an empty park.
  if (!anySurveyed) {
    return {
      mode: "arrangement",
      canSwitch: false,
      missingSections,
      placedCount,
      unplacedCount,
    };
  }

  const mode: MapMode = preferred ?? "survey";
  return {
    mode,
    // A fully surveyed park has no arrangement worth switching to: the
    // grid would be a worse drawing of lots we know the real place of.
    canSwitch: anyUnsurveyed,
    missingSections,
    placedCount,
    unplacedCount,
  };
}
