/**
 * Laying a row of graves along a line somebody drew.
 *
 * The practical answer to mapping an irregular park by hand. A cemetery
 * is rows of near-identical plots, so the useful unit of work is not one
 * lot — it is "this row, from here to here". Two clicks place twenty
 * graves at real coordinates, at the real angle the row runs, which no
 * grid can express and which two hundred separate GPS captures would
 * take a week to collect.
 *
 * The one decision worth stating: lots are laid at their REAL widths and
 * the drawn line supplies the START and the BEARING, not the spacing.
 *
 * Stretching or squeezing the plots to fill whatever line got drawn
 * would be easier and would always look tidy — and it would make the map
 * lie about how big the graves are, which is the number families are
 * quoted and the number that decides whether a family plot fits where
 * somebody thinks it does. So the row is drawn true and the caller is
 * told how far it actually reaches, which is a fact they can act on.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LotSize {
  widthM: number;
  depthM: number;
}

export interface RowPlacement {
  centroid: LatLng;
  /** Four corners, turned to the row's bearing. */
  polygon: LatLng[];
}

export interface RowLayout {
  placements: RowPlacement[];
  /** How far the row reaches at true size, in metres. */
  rowLengthM: number;
  /** How long the drawn line was, in metres. */
  drawnLengthM: number;
  /** The row's compass bearing, in radians east of north. */
  bearingRad: number;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_EQ = 111_320;

function metresPerDegLng(lat: number): number {
  return M_PER_DEG_LNG_EQ * Math.cos((lat * Math.PI) / 180);
}

/** East/north metres from `origin` to `p`. */
function toMetres(p: LatLng, origin: LatLng): { e: number; n: number } {
  return {
    e: (p.lng - origin.lng) * metresPerDegLng(origin.lat),
    n: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Back to a coordinate, from east/north metres relative to `origin`. */
function toLatLng(e: number, n: number, origin: LatLng): LatLng {
  return {
    lat: origin.lat + n / M_PER_DEG_LAT,
    lng: origin.lng + e / metresPerDegLng(origin.lat),
  };
}

/**
 * Place `sizes.length` lots in a row beginning at `start`, running
 * toward `end`.
 *
 * Each lot's WIDTH lies along the row — graves stand shoulder to
 * shoulder — and its DEPTH runs perpendicular, which is the direction a
 * grave is dug and the direction a headstone faces. Getting those two
 * the wrong way round produces a row that looks plausible and is turned
 * ninety degrees from the truth.
 */
export function layoutRow(
  start: LatLng,
  end: LatLng,
  sizes: readonly LotSize[],
): RowLayout {
  const d = toMetres(end, start);
  const drawnLengthM = Math.sqrt(d.e * d.e + d.n * d.n);

  // A line with no length has no bearing. Default to due east so the
  // caller gets a usable row rather than NaN coordinates; the fit report
  // makes the degenerate input obvious.
  const bearingRad =
    drawnLengthM === 0 ? Math.PI / 2 : Math.atan2(d.e, d.n);

  // Unit vector along the row, and its perpendicular.
  const ue = drawnLengthM === 0 ? 1 : d.e / drawnLengthM;
  const un = drawnLengthM === 0 ? 0 : d.n / drawnLengthM;
  // Rotated ninety degrees: the depth axis.
  const pe = -un;
  const pn = ue;

  const placements: RowPlacement[] = [];
  let along = 0;

  for (const size of sizes) {
    const w = Number.isFinite(size.widthM) && size.widthM > 0 ? size.widthM : 0;
    const dep =
      Number.isFinite(size.depthM) && size.depthM > 0 ? size.depthM : 0;

    // The lot's centre sits half its own width further along.
    const centreAt = along + w / 2;
    const ce = ue * centreAt;
    const cn = un * centreAt;
    const centroid = toLatLng(ce, cn, start);

    const hw = w / 2;
    const hd = dep / 2;
    const polygon = (
      [
        [-hw, -hd],
        [hw, -hd],
        [hw, hd],
        [-hw, hd],
      ] as Array<[number, number]>
    ).map(([dw, dd]) =>
      toLatLng(ce + ue * dw + pe * dd, cn + un * dw + pn * dd, start),
    );

    placements.push({ centroid, polygon });
    along += w;
  }

  return { placements, rowLengthM: along, drawnLengthM, bearingRad };
}

/**
 * How badly the drawn line and the real row disagree, as a ratio.
 *
 * 1 means the lots exactly fill what was drawn. Above 1 they overrun it,
 * below 1 they stop short. Worth showing rather than correcting: a big
 * mismatch usually means the wrong number of lots was selected, and
 * silently rescaling them would hide that.
 */
export function fitRatio(layout: RowLayout): number {
  if (layout.drawnLengthM === 0) return Infinity;
  return layout.rowLengthM / layout.drawnLengthM;
}

/** Beyond this the drawn line and the row disagree enough to mention. */
export const FIT_TOLERANCE = 0.15;

/** A sentence about the fit, or null when it is close enough. */
export function fitWarning(layout: RowLayout): string | null {
  const ratio = fitRatio(layout);
  if (!Number.isFinite(ratio)) {
    return "That line has no length — click two separate points to set the row's direction.";
  }
  if (Math.abs(ratio - 1) <= FIT_TOLERANCE) return null;
  const row = Math.round(layout.rowLengthM);
  const drawn = Math.round(layout.drawnLengthM);
  return ratio > 1
    ? `These lots are ${row}m of ground and you drew ${drawn}m, so the row runs past where you stopped. Fewer lots, or a longer line.`
    : `These lots are ${row}m of ground and you drew ${drawn}m, so the row stops short of where you stopped. More lots, or a shorter line.`;
}
