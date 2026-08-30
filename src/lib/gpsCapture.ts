/**
 * Standing at a lot and capturing where it is.
 *
 * The browser will hand a phone's position straight over. The whole
 * difficulty is that a phone is not accurate enough for what it is
 * being asked to do, and says so in a number most software throws away.
 *
 * A single grave here is 2.5 metres wide. A phone under open sky
 * typically reports 3–10 metres, and under trees or beside a wall,
 * worse. So one tap routinely lands a lot or three from the truth —
 * and lands there silently, because a coordinate looks equally precise
 * however it was obtained.
 *
 * Everything in this module exists to keep that visible: sample rather
 * than snap, weight good fixes over bad, refuse the hopeless ones, and
 * never report a precision the samples do not support.
 */

export interface GpsSample {
  lat: number;
  lng: number;
  /** The radius the device itself claims, in metres. */
  accuracyM: number;
  at: number;
}

/** A single grave's width. The yardstick every quality band is set by. */
export const GRAVE_WIDTH_M = 2.5;

/**
 * Beyond this a fix is not a position, it is a neighbourhood.
 *
 * Ten graves' width. Saving one would put a marker in the wrong block
 * with the same confidence as a surveyed corner.
 */
export const MAX_USABLE_ACCURACY_M = 25;

/** How long to stand still. Long enough for the fix to settle. */
export const SAMPLE_WINDOW_MS = 15_000;

/** Below this many usable fixes, the average is not worth the name. */
export const MIN_SAMPLES = 3;

export type GpsQuality = "good" | "usable" | "coarse" | "unusable";

export interface QualityBand {
  quality: GpsQuality;
  /** What the number means for somebody standing in a cemetery. */
  meaning: string;
}

/**
 * What a radius means in graves, which is the only unit that matters
 * to the person holding the phone.
 */
export function qualityOf(accuracyM: number): QualityBand {
  if (!Number.isFinite(accuracyM) || accuracyM <= 0) {
    return {
      quality: "unusable",
      meaning: "The phone did not report how accurate this is.",
    };
  }
  if (accuracyM > MAX_USABLE_ACCURACY_M) {
    return {
      quality: "unusable",
      meaning:
        "Too rough to place a lot — this could be anywhere within several blocks.",
    };
  }
  if (accuracyM <= 3) {
    return {
      quality: "good",
      meaning:
        "About as good as a phone gets. Still roughly one grave's width, so check the code on the marker.",
    };
  }
  if (accuracyM <= 10) {
    return {
      quality: "usable",
      meaning:
        "Right row, probably. Could be a lot or two out either side.",
    };
  }
  return {
    quality: "coarse",
    meaning: "Right block, but not the right lot. Worth another try.",
  };
}

export interface GpsFix {
  lat: number;
  lng: number;
  /** The radius this fix can honestly claim. */
  accuracyM: number;
  /** Samples that counted toward it. */
  usedCount: number;
  /** Samples thrown out as too rough. */
  rejectedCount: number;
}

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG_EQ = 111_320;

function metresApart(a: GpsSample, b: { lat: number; lng: number }): number {
  const cos = Math.cos((b.lat * Math.PI) / 180);
  const dx = (a.lng - b.lng) * M_PER_DEG_LNG_EQ * cos;
  const dz = (a.lat - b.lat) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * The best position a set of samples supports, and how much to trust it.
 *
 * Two decisions worth stating.
 *
 * The average is weighted by 1/accuracy², so a ±4m fix counts for far
 * more than a ±20m one. Averaging them evenly lets the worst readings
 * drag the answer around, which is the opposite of what more samples
 * are for.
 *
 * The reported accuracy is the WORSE of two things: the best single
 * sample, and how far the samples actually spread. Combining variances
 * the textbook way would claim sub-metre precision from ten ±8m fixes,
 * which is arithmetically tidy and false — GPS error is correlated
 * between readings taken seconds apart, so ten samples are nothing like
 * ten independent measurements. When the samples disagree by fifteen
 * metres, fifteen metres is the honest number.
 */
export function summarise(samples: readonly GpsSample[]): GpsFix | null {
  const usable = samples.filter(
    (s) =>
      Number.isFinite(s.accuracyM) &&
      s.accuracyM > 0 &&
      s.accuracyM <= MAX_USABLE_ACCURACY_M,
  );
  const rejectedCount = samples.length - usable.length;
  if (usable.length === 0) return null;

  let wSum = 0;
  let latSum = 0;
  let lngSum = 0;
  for (const s of usable) {
    const w = 1 / (s.accuracyM * s.accuracyM);
    wSum += w;
    latSum += s.lat * w;
    lngSum += s.lng * w;
  }
  const lat = latSum / wSum;
  const lng = lngSum / wSum;

  const bestClaimed = Math.min(...usable.map((s) => s.accuracyM));
  const spread = Math.max(...usable.map((s) => metresApart(s, { lat, lng })));

  return {
    lat,
    lng,
    accuracyM: Math.max(bestClaimed, spread),
    usedCount: usable.length,
    rejectedCount,
  };
}

/**
 * Whether a fix may be saved at all.
 *
 * Separate from `summarise` on purpose: the screen shows a running
 * estimate the whole time somebody is standing there, and showing it is
 * not the same as letting them keep it.
 */
export function canSave(fix: GpsFix | null): boolean {
  return (
    fix !== null &&
    fix.usedCount >= MIN_SAMPLES &&
    fix.accuracyM <= MAX_USABLE_ACCURACY_M
  );
}

/** Why a fix cannot be saved yet, in words for the person holding it. */
export function blockedReason(fix: GpsFix | null): string | null {
  if (fix === null) {
    return "No usable reading yet. Step into the open if you can — walls and trees block the signal.";
  }
  if (fix.usedCount < MIN_SAMPLES) {
    return `Only ${fix.usedCount} good reading${fix.usedCount === 1 ? "" : "s"} so far. Keep still for a few more seconds.`;
  }
  if (fix.accuracyM > MAX_USABLE_ACCURACY_M) {
    return "The readings are too spread out to place a lot. Try again in the open.";
  }
  return null;
}
