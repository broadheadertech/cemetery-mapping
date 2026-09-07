/**
 * What the flat map should draw at a given zoom.
 *
 * A grave is 2.5 metres wide. At the zoom the map opens on, that is
 * well under a pixel — so the cemetery renders as a scatter of coloured
 * specks in an empty field, with nothing to say which garden they
 * belong to or even that they belong together. Zoomed all the way in
 * they are legible shapes, but still unlabelled, so finding A-1-14
 * means clicking squares until one of them is it.
 *
 * The answer is not one rendering that compromises at both ends. It is
 * three, chosen by how much a metre is currently worth in pixels.
 */

export type DetailLevel = "gardens" | "lots" | "labelled";

/**
 * Below this, one marker per garden.
 *
 * At zoom 17 a 2.5m plot is roughly a pixel and a half — small enough
 * that a hundred of them read as noise rather than as a cemetery.
 */
export const GARDEN_MARKER_MAX_ZOOM = 17;

/** At and above this, every lot carries its code. */
export const LABEL_MIN_ZOOM = 19;

/**
 * Which of the three views a zoom level calls for.
 *
 * Deliberately a step function rather than a fade. A lot that is half
 * drawn, or a label that is half legible, is worse than either state:
 * it reads as the map struggling rather than as the map deciding.
 */
export function detailLevelFor(zoom: number): DetailLevel {
  if (zoom <= GARDEN_MARKER_MAX_ZOOM) return "gardens";
  if (zoom >= LABEL_MIN_ZOOM) return "labelled";
  return "lots";
}

/**
 * The most lots that can carry a visible code at once.
 *
 * Leaflet has no label-collision handling: every tooltip is drawn where
 * its lot is, and when lots are 2.5m apart the codes land on top of
 * each other and on the lots they belong to. Past this many in view, a
 * labelled map is less readable than an unlabelled one — so the codes
 * wait until somebody has zoomed in far enough to be looking at a row
 * rather than a garden.
 */
export const MAX_LABELLED_LOTS = 40;

/**
 * Whether to draw lot codes at all.
 *
 * Zoom alone is not enough: a dense garden at zoom 19 still stacks
 * forty codes into the space of a few, and the reader ends up with
 * neither the codes nor a clear view of the plots.
 */
export function shouldLabelLots(zoom: number, lotsInView: number): boolean {
  return detailLevelFor(zoom) === "labelled" && lotsInView <= MAX_LABELLED_LOTS;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Bounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * The extent of some points, or null when there are none.
 *
 * Used to frame the map on what actually exists. The map used to open
 * on a fixed cemetery-wide box, which put a park a hundred metres
 * across inside a view of the whole town — technically correct and
 * useless, since the thing you came to look at was four pixels near the
 * middle.
 */
export function boundsOf(points: readonly LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * The same extent, never collapsed to a point.
 *
 * A single lot — or several sharing a centroid — gives a zero-size box,
 * and fitting to that either does nothing or zooms to the maximum and
 * shows a texture. The pad is about ten metres, which frames one grave
 * with its surroundings rather than filling the screen with it.
 */
export function paddedBounds(b: Bounds | null, padDeg = 0.0001): Bounds | null {
  if (b === null) return null;
  const flatLat = b.maxLat - b.minLat < padDeg;
  const flatLng = b.maxLng - b.minLng < padDeg;
  return {
    minLat: flatLat ? b.minLat - padDeg : b.minLat,
    maxLat: flatLat ? b.maxLat + padDeg : b.maxLat,
    minLng: flatLng ? b.minLng - padDeg : b.minLng,
    maxLng: flatLng ? b.maxLng + padDeg : b.maxLng,
  };
}

export interface GardenSummary {
  section: string;
  centre: LatLng;
  lotCount: number;
  /** Lots in this garden that are still for sale. */
  availableCount: number;
}

/**
 * One marker's worth of information per garden.
 *
 * The centre is the mean of the garden's own lots rather than of its
 * traced outline: a marker should sit where the graves are, and a
 * garden shaped like an L has an outline centre standing in the gap.
 */
export function summariseGardens(
  lots: ReadonlyArray<{
    section: string;
    status: string;
    lat: number;
    lng: number;
  }>,
): GardenSummary[] {
  const byName = new Map<
    string,
    { latSum: number; lngSum: number; n: number; available: number }
  >();

  for (const lot of lots) {
    if (!Number.isFinite(lot.lat) || !Number.isFinite(lot.lng)) continue;
    const acc = byName.get(lot.section) ?? {
      latSum: 0,
      lngSum: 0,
      n: 0,
      available: 0,
    };
    acc.latSum += lot.lat;
    acc.lngSum += lot.lng;
    acc.n += 1;
    if (lot.status === "available") acc.available += 1;
    byName.set(lot.section, acc);
  }

  return [...byName.entries()]
    .map(([section, a]) => ({
      section,
      centre: { lat: a.latSum / a.n, lng: a.lngSum / a.n },
      lotCount: a.n,
      availableCount: a.available,
    }))
    .sort((x, y) => x.section.localeCompare(y.section));
}
