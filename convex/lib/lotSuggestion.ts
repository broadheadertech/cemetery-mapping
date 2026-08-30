/**
 * Suggesting a lot to a family.
 *
 * A family arrives with a handful of things in mind — what they can
 * spend, how many the plot has to hold, sometimes a garden they have a
 * feeling about, very often "somewhere near my father". Finding the
 * lots that satisfy all of that means paging through inventory while
 * they wait. This does it in one pass and hands back a short, ranked
 * list.
 *
 * ## Not a black box
 *
 * Every suggestion carries the reasons it scored well, in plain words,
 * because the output is not read by a machine — it is read aloud across
 * a desk to someone who has just lost a parent. "Lot B-104, ₱45,000,
 * in Garden of Faith as you asked, forty metres from the Reyes plot,
 * room for two" is usable. A relevance score of 0.87 is not.
 *
 * It is also plain arithmetic, deliberately. Ranking cemetery plots for
 * a grieving family is not a place for something that cannot explain
 * itself, and a scoring function can be read, argued with, and tested.
 *
 * ## What it will not do
 *
 * Hard requirements are filters, not scores. A lot that costs more than
 * the family said, or cannot hold the number they need, is never
 * suggested at any rank — a cheap lot that fits nobody is not a good
 * suggestion, and offering one over budget invites a conversation that
 * ends badly. Preferences (a garden, nearness) move a lot up the list
 * but never onto it.
 */

import { capacityReport, type CapacityOccupant } from "./lotCapacity";

export interface SuggestionCandidate {
  lotId: string;
  code: string;
  type: string;
  section: string;
  sectionId?: string;
  basePriceCents: number;
  status: string;
  isRetired: boolean;
  capacityUnits?: number;
  centroid?: { lat: number; lng: number };
  occupants: ReadonlyArray<CapacityOccupant>;
}

export interface SuggestionCriteria {
  /** Hard ceiling. A lot above this is never suggested. */
  maxPriceCents?: number;
  /** Hard floor on room, in half-body units. */
  requiredCapacityUnits?: number;
  /** Preferred lot type. A preference, not a filter. */
  preferredType?: string;
  /** Preferred garden, matched on the section label. */
  preferredSection?: string;
  /** Somewhere near this point — usually an existing family lot. */
  near?: { lat: number; lng: number };
}

export interface SuggestionReason {
  /** Short phrase for the UI, e.g. "In Garden of Faith". */
  label: string;
  /** Points this contributed, for the explain view. */
  points: number;
}

export interface Suggestion {
  lotId: string;
  code: string;
  section: string;
  basePriceCents: number;
  score: number;
  reasons: SuggestionReason[];
  /** Metres from `near`, when a reference point was given. */
  distanceMetres?: number;
  bodiesRemaining: number;
}

/** Points available for each thing a family said mattered. */
const WEIGHTS = {
  type: 30,
  section: 25,
  proximity: 25,
  budgetHeadroom: 12,
  roomToSpare: 8,
} as const;

/**
 * Great-circle distance in metres.
 *
 * The park is a few hundred metres across, where the earth is
 * effectively flat — but the equirectangular shortcut goes wrong near
 * the poles and this is cheap enough not to bother being clever.
 */
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nearness scores full at the next plot and fades out across the park. */
const NEAR_FULL_METRES = 15;
const NEAR_ZERO_METRES = 250;

function proximityPoints(metres: number): number {
  if (metres <= NEAR_FULL_METRES) return WEIGHTS.proximity;
  if (metres >= NEAR_ZERO_METRES) return 0;
  const span = NEAR_ZERO_METRES - NEAR_FULL_METRES;
  const fade = 1 - (metres - NEAR_FULL_METRES) / span;
  return Math.round(WEIGHTS.proximity * fade);
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function peso(cents: number): string {
  return "₱" + Math.round(cents / 100).toLocaleString("en-PH");
}

function metresLabel(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * Rank the lots that genuinely suit, best first.
 *
 * Returns nothing rather than something poor: if no lot satisfies the
 * hard requirements the answer is an empty list, which staff can say
 * out loud ("nothing in that budget holds three") instead of a
 * suggestion that wastes everyone's time.
 */
export function suggestLots(
  candidates: ReadonlyArray<SuggestionCandidate>,
  criteria: SuggestionCriteria,
  limit = 5,
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const lot of candidates) {
    // ---- hard requirements --------------------------------------
    if (lot.isRetired) continue;
    if (lot.status !== "available") continue;
    if (
      criteria.maxPriceCents !== undefined &&
      lot.basePriceCents > criteria.maxPriceCents
    ) {
      continue;
    }

    const report = capacityReport(lot, lot.occupants);
    const needed = criteria.requiredCapacityUnits ?? 0;
    if (report.remainingUnits < needed) continue;

    // ---- preferences --------------------------------------------
    const reasons: SuggestionReason[] = [];
    let score = 0;

    if (
      criteria.preferredType !== undefined &&
      normalise(lot.type) === normalise(criteria.preferredType)
    ) {
      score += WEIGHTS.type;
      reasons.push({
        label: `A ${lot.type} lot, as asked`,
        points: WEIGHTS.type,
      });
    }

    if (
      criteria.preferredSection !== undefined &&
      normalise(lot.section) === normalise(criteria.preferredSection)
    ) {
      score += WEIGHTS.section;
      reasons.push({ label: `In ${lot.section}`, points: WEIGHTS.section });
    }

    let distance: number | undefined;
    if (criteria.near !== undefined && lot.centroid !== undefined) {
      distance = distanceMetres(criteria.near, lot.centroid);
      const points = proximityPoints(distance);
      if (points > 0) {
        score += points;
        reasons.push({
          label: `${metresLabel(distance)} from the family plot`,
          points,
        });
      }
    }

    // Comfortably inside the budget, rather than scraping it. A family
    // that said "up to 50" is usually glad to hear about 42.
    if (criteria.maxPriceCents !== undefined && criteria.maxPriceCents > 0) {
      const headroom =
        (criteria.maxPriceCents - lot.basePriceCents) / criteria.maxPriceCents;
      const points = Math.round(WEIGHTS.budgetHeadroom * Math.max(0, headroom));
      if (points > 0) {
        score += points;
        reasons.push({
          label: `${peso(lot.basePriceCents)}, within budget`,
          points,
        });
      }
    }

    // A little room beyond what they need today. Families come back.
    if (needed > 0 && report.remainingUnits > needed) {
      score += WEIGHTS.roomToSpare;
      reasons.push({
        label: `Room for ${report.bodiesRemaining} interment${report.bodiesRemaining === 1 ? "" : "s"}`,
        points: WEIGHTS.roomToSpare,
      });
    }

    const suggestion: Suggestion = {
      lotId: lot.lotId,
      code: lot.code,
      section: lot.section,
      basePriceCents: lot.basePriceCents,
      score,
      reasons,
      bodiesRemaining: report.bodiesRemaining,
    };
    if (distance !== undefined) suggestion.distanceMetres = distance;
    suggestions.push(suggestion);
  }

  suggestions.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Same fit: the cheaper lot, then a stable tiebreak on code so the
    // list does not reshuffle between identical queries.
    if (a.basePriceCents !== b.basePriceCents) {
      return a.basePriceCents - b.basePriceCents;
    }
    return a.code.localeCompare(b.code);
  });

  return suggestions.slice(0, Math.max(1, limit));
}
