/**
 * How much a lot can hold, and what is already in it.
 *
 * ## The rule
 *
 * Two sets of bones occupy the space of one body. A standard lot holds
 * two bodies. So a lot is full at any of:
 *
 *   - 2 bodies
 *   - 1 body + 2 sets of bones
 *   - 4 sets of bones
 *
 * Bone transfer is ordinary practice here: years after burial the
 * remains are exhumed, reduced, and re-interred in a smaller container,
 * freeing space in the same family plot. The capacity rule has to model
 * that, or the office cannot tell a family what their lot still has room
 * for.
 *
 * ## Why integers
 *
 * The obvious encoding — a body is 1.0 and bones are 0.5 — puts floating
 * point between a family and the question "can my mother be buried with
 * my father". `0.1 + 0.2 !== 0.3`, and a lot that reports 0.999999
 * remaining is a lot that refuses a burial it should allow.
 *
 * So capacity is counted in HALF-BODY UNITS, all integers:
 *
 *   body  = 2 units
 *   bones = 1 unit
 *   a standard lot = 4 units
 *
 * Nothing here divides. The same reasoning as money being counted in
 * centavos rather than pesos.
 *
 * ## Capacity lives on the lot
 *
 * Each lot carries its own `capacityUnits`, defaulted from its type when
 * created and editable afterwards — a cemetery has odd plots, and the
 * type is a starting point rather than a law. `DEFAULT_CAPACITY_UNITS`
 * holds those starting points.
 */

export type IntermentKind = "body" | "bones";

/** A body fills half a standard lot; a set of bones fills half of that. */
export const UNITS_PER_BODY = 2;
export const UNITS_PER_BONES = 1;

export function unitsFor(kind: IntermentKind): number {
  return kind === "body" ? UNITS_PER_BODY : UNITS_PER_BONES;
}

export type LotType = "single" | "family" | "mausoleum" | "niche";

/**
 * Starting capacity by lot type, in half-body units.
 *
 * A `single` is the two-body lot the rule describes. The larger types
 * scale from what the product already advertises — a family estate at
 * six interments, a mausoleum at twelve crypts — and a niche holds one
 * set of cremated remains and nothing else.
 */
export const DEFAULT_CAPACITY_UNITS: Record<LotType, number> = {
  single: 2 * UNITS_PER_BODY,
  family: 6 * UNITS_PER_BODY,
  mausoleum: 12 * UNITS_PER_BODY,
  niche: UNITS_PER_BONES,
};

/** Capacity for a lot: its own value when set, otherwise its type's. */
export function capacityUnitsOf(lot: {
  type: string;
  capacityUnits?: number;
}): number {
  if (
    typeof lot.capacityUnits === "number" &&
    Number.isInteger(lot.capacityUnits) &&
    lot.capacityUnits >= 0
  ) {
    return lot.capacityUnits;
  }
  const fallback = DEFAULT_CAPACITY_UNITS[lot.type as LotType];
  return fallback ?? DEFAULT_CAPACITY_UNITS.single;
}

/** An occupant as capacity cares about it. */
export interface CapacityOccupant {
  intermentKind?: string;
  isRemoved: boolean;
}

/**
 * Units consumed by the current occupants.
 *
 * An occupant with no recorded kind counts as a BODY. Records predating
 * this rule do not say which they are, and assuming the larger of the
 * two is the safe direction: the cost of guessing high is that staff
 * must correct a record before adding someone, which is a conversation.
 * The cost of guessing low is promising a family space that does not
 * exist, which is a graveside problem.
 */
export function usedUnits(occupants: ReadonlyArray<CapacityOccupant>): number {
  return occupants
    .filter((o) => !o.isRemoved)
    .reduce(
      (total, o) =>
        total + unitsFor(o.intermentKind === "bones" ? "bones" : "body"),
      0,
    );
}

export interface CapacityReport {
  capacityUnits: number;
  usedUnits: number;
  remainingUnits: number;
  /** Whole bodies that would still fit. */
  bodiesRemaining: number;
  /** Sets of bones that would still fit. */
  bonesRemaining: number;
  isFull: boolean;
}

export function capacityReport(
  lot: { type: string; capacityUnits?: number },
  occupants: ReadonlyArray<CapacityOccupant>,
): CapacityReport {
  const capacity = capacityUnitsOf(lot);
  const used = usedUnits(occupants);
  const remaining = Math.max(0, capacity - used);
  return {
    capacityUnits: capacity,
    usedUnits: used,
    remainingUnits: remaining,
    bodiesRemaining: Math.floor(remaining / UNITS_PER_BODY),
    bonesRemaining: Math.floor(remaining / UNITS_PER_BONES),
    isFull: remaining <= 0,
  };
}

export interface AdmitResult {
  ok: boolean;
  /** Plain-language reason, for the message staff actually read. */
  reason?: string;
  report: CapacityReport;
}

/** Whether one more interment of `kind` fits. */
export function canAdmit(
  lot: { type: string; capacityUnits?: number },
  occupants: ReadonlyArray<CapacityOccupant>,
  kind: IntermentKind,
): AdmitResult {
  const report = capacityReport(lot, occupants);
  const needed = unitsFor(kind);
  if (report.remainingUnits >= needed) return { ok: true, report };

  return {
    ok: false,
    reason: describeFull(report, kind),
    report,
  };
}

/**
 * Why it does not fit, in words an office staffer can repeat to a
 * family. "Capacity 4, used 4" is true and useless at a counter.
 */
function describeFull(report: CapacityReport, kind: IntermentKind): string {
  const wanted = kind === "body" ? "another body" : "another set of remains";
  if (report.remainingUnits <= 0) {
    return `This lot is full — ${describeContents(report)}. There is no room for ${wanted}.`;
  }
  // Only reachable asking for a body with half a body of room left.
  return (
    `This lot has room for ${report.bonesRemaining} more set` +
    `${report.bonesRemaining === 1 ? "" : "s"} of remains, but not ${wanted}.`
  );
}

function describeContents(report: CapacityReport): string {
  const bodies = Math.floor(report.capacityUnits / UNITS_PER_BODY);
  return `it holds ${bodies} ${bodies === 1 ? "interment" : "interments"}`;
}
