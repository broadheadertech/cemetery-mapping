/**
 * How much a lot holds.
 *
 * Two sets of bones occupy the space of one body; a standard lot holds
 * two bodies. Until this shipped there was NO capacity check anywhere —
 * the only guard on interments was a double-booking check on time, which
 * says nothing about space. A lot could be filled indefinitely.
 *
 * These tests are the rule, written down. The arithmetic is integer
 * half-body units on purpose: a family asking whether their mother fits
 * beside their father should never be answered by floating point.
 */

import { describe, it, expect } from "vitest";

import {
  canAdmit,
  capacityReport,
  capacityUnitsOf,
  DEFAULT_CAPACITY_UNITS,
  unitsFor,
  UNITS_PER_BODY,
  UNITS_PER_BONES,
  usedUnits,
} from "../../../../convex/lib/lotCapacity";

const single = { type: "single" };
const body = { intermentKind: "body", isRemoved: false };
const bones = { intermentKind: "bones", isRemoved: false };

describe("the rule", () => {
  it("counts two sets of bones as one body", () => {
    expect(unitsFor("bones") * 2).toBe(unitsFor("body"));
  });

  it("uses integers, never halves", () => {
    // The whole point of counting in half-bodies. A 0.5 here would put
    // `0.1 + 0.2 !== 0.3` between a family and a burial.
    expect(Number.isInteger(UNITS_PER_BODY)).toBe(true);
    expect(Number.isInteger(UNITS_PER_BONES)).toBe(true);
    for (const v of Object.values(DEFAULT_CAPACITY_UNITS)) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("gives a standard lot room for two bodies", () => {
    expect(DEFAULT_CAPACITY_UNITS.single).toBe(2 * UNITS_PER_BODY);
  });
});

describe("what fits in a standard lot", () => {
  it("takes two bodies", () => {
    expect(canAdmit(single, [body], "body").ok).toBe(true);
    expect(canAdmit(single, [body, body], "body").ok).toBe(false);
  });

  it("takes one body plus two sets of bones", () => {
    expect(canAdmit(single, [body], "bones").ok).toBe(true);
    expect(canAdmit(single, [body, bones], "bones").ok).toBe(true);
    expect(canAdmit(single, [body, bones, bones], "bones").ok).toBe(false);
  });

  it("takes four sets of bones", () => {
    expect(canAdmit(single, [bones, bones, bones], "bones").ok).toBe(true);
    expect(
      canAdmit(single, [bones, bones, bones, bones], "bones").ok,
    ).toBe(false);
  });

  it("refuses a body when only half a body of room is left", () => {
    // One body and one set of bones leaves a single unit — enough for
    // more bones, not for a person.
    const occupants = [body, bones];
    expect(canAdmit(single, occupants, "bones").ok).toBe(true);
    expect(canAdmit(single, occupants, "body").ok).toBe(false);
  });

  it("works the other way round too", () => {
    // Two sets of bones free exactly one body's worth of space.
    expect(canAdmit(single, [bones, bones], "body").ok).toBe(true);
  });
});

describe("reporting what is left", () => {
  it("reports an empty lot", () => {
    const r = capacityReport(single, []);
    expect(r.bodiesRemaining).toBe(2);
    expect(r.bonesRemaining).toBe(4);
    expect(r.isFull).toBe(false);
  });

  it("reports a lot holding one body", () => {
    const r = capacityReport(single, [body]);
    expect(r.bodiesRemaining).toBe(1);
    expect(r.bonesRemaining).toBe(2);
    expect(r.isFull).toBe(false);
  });

  it("reports a full lot", () => {
    const r = capacityReport(single, [body, body]);
    expect(r.remainingUnits).toBe(0);
    expect(r.bodiesRemaining).toBe(0);
    expect(r.isFull).toBe(true);
  });

  it("never reports negative room, even if a lot was overfilled before", () => {
    // Records predating the rule could exceed capacity. The report has
    // to describe that honestly without producing nonsense like "-1
    // bodies remaining".
    const r = capacityReport(single, [body, body, body]);
    expect(r.remainingUnits).toBe(0);
    expect(r.bodiesRemaining).toBe(0);
    expect(r.isFull).toBe(true);
  });
});

describe("removed occupants", () => {
  it("free their space", () => {
    // Exhumation and transfer are why this rule exists; a removed
    // occupant must give the lot its room back.
    const removed = { intermentKind: "body", isRemoved: true };
    expect(usedUnits([body, removed])).toBe(UNITS_PER_BODY);
    expect(canAdmit(single, [body, removed], "body").ok).toBe(true);
  });
});

describe("records that predate the rule", () => {
  it("counts an occupant with no recorded kind as a body", () => {
    // The safe direction. Guessing high costs a correction at the
    // counter; guessing low promises a family space that is not there.
    const unknown = { isRemoved: false };
    expect(usedUnits([unknown])).toBe(UNITS_PER_BODY);
    expect(canAdmit(single, [unknown, unknown], "bones").ok).toBe(false);
  });
});

describe("capacity per lot", () => {
  it("defaults from the lot's type", () => {
    expect(capacityUnitsOf({ type: "family" })).toBe(
      DEFAULT_CAPACITY_UNITS.family,
    );
    expect(capacityUnitsOf({ type: "niche" })).toBe(
      DEFAULT_CAPACITY_UNITS.niche,
    );
  });

  it("lets an individual lot override its type", () => {
    // A cemetery has odd plots; the type is a starting point, not a law.
    expect(capacityUnitsOf({ type: "single", capacityUnits: 10 })).toBe(10);
  });

  it("honours a deliberately sealed lot", () => {
    const sealed = { type: "single", capacityUnits: 0 };
    expect(capacityUnitsOf(sealed)).toBe(0);
    expect(canAdmit(sealed, [], "bones").ok).toBe(false);
  });

  it("falls back rather than trusting a nonsense value", () => {
    expect(capacityUnitsOf({ type: "single", capacityUnits: -3 })).toBe(
      DEFAULT_CAPACITY_UNITS.single,
    );
    expect(capacityUnitsOf({ type: "single", capacityUnits: 1.5 })).toBe(
      DEFAULT_CAPACITY_UNITS.single,
    );
  });

  it("falls back for an unknown lot type", () => {
    expect(capacityUnitsOf({ type: "gazebo" })).toBe(
      DEFAULT_CAPACITY_UNITS.single,
    );
  });

  it("gives a niche room for remains but never a body", () => {
    const niche = { type: "niche" };
    expect(canAdmit(niche, [], "bones").ok).toBe(true);
    expect(canAdmit(niche, [], "body").ok).toBe(false);
  });
});

describe("the message staff read", () => {
  it("explains a refusal in words, not in units", () => {
    const refusal = canAdmit(single, [body, body], "body");
    expect(refusal.ok).toBe(false);
    // "capacity 4, used 4" is true and useless at a counter.
    expect(refusal.reason).toMatch(/full/i);
    expect(refusal.reason).not.toMatch(/unit/i);
  });

  it("says when only remains will fit", () => {
    const refusal = canAdmit(single, [body, bones], "body");
    expect(refusal.reason).toMatch(/remains/i);
  });
});
