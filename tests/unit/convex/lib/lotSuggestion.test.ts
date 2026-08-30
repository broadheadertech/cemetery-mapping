/**
 * Suggesting a lot to a family.
 *
 * These are not cosmetic ranking tests. The output is read aloud across
 * a desk to someone arranging a burial, so the properties that matter
 * are: never offer what they cannot have, never offer what will not
 * hold their family, and always be able to say why.
 */

import { describe, it, expect } from "vitest";

import {
  distanceMetres,
  suggestLots,
  type SuggestionCandidate,
} from "../../../../convex/lib/lotSuggestion";
import { UNITS_PER_BODY } from "../../../../convex/lib/lotCapacity";

function lot(over: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return {
    lotId: over.code ?? "lots:1",
    code: "A-101",
    type: "single",
    section: "Garden of Grace",
    basePriceCents: 45_000_00,
    status: "available",
    isRetired: false,
    occupants: [],
    centroid: { lat: 16.3958, lng: 120.3586 },
    ...over,
  };
}

describe("hard requirements are filters, never scores", () => {
  it("never suggests a lot over budget", () => {
    // A lot they cannot buy is not a suggestion at any rank; offering
    // one starts a conversation that ends badly.
    const out = suggestLots([lot({ basePriceCents: 90_000_00 })], {
      maxPriceCents: 50_000_00,
    });
    expect(out).toEqual([]);
  });

  it("never suggests a lot that cannot hold the family", () => {
    const full = lot({
      occupants: [
        { intermentKind: "body", isRemoved: false },
        { intermentKind: "body", isRemoved: false },
      ],
    });
    const out = suggestLots([full], {
      requiredCapacityUnits: UNITS_PER_BODY,
    });
    expect(out).toEqual([]);
  });

  it("never suggests a lot that is not available", () => {
    expect(suggestLots([lot({ status: "sold" })], {})).toEqual([]);
    expect(suggestLots([lot({ status: "occupied" })], {})).toEqual([]);
  });

  it("never suggests a retired lot", () => {
    expect(suggestLots([lot({ isRetired: true })], {})).toEqual([]);
  });

  it("returns nothing rather than something poor", () => {
    // Staff can say "nothing in that budget holds three" out loud. A
    // bad suggestion just wastes the family's time.
    const out = suggestLots([lot({ basePriceCents: 90_000_00 })], {
      maxPriceCents: 10_000_00,
    });
    expect(out).toHaveLength(0);
  });
});

describe("preferences move a lot up, never onto, the list", () => {
  it("ranks the preferred garden above another", () => {
    const grace = lot({ code: "A-101", section: "Garden of Grace" });
    const faith = lot({ code: "B-101", section: "Garden of Faith" });
    const out = suggestLots([grace, faith], {
      preferredSection: "Garden of Faith",
    });
    expect(out[0]!.code).toBe("B-101");
  });

  it("ranks the preferred type above another", () => {
    const single = lot({ code: "A-101", type: "single" });
    const family = lot({ code: "F-101", type: "family" });
    const out = suggestLots([single, family], { preferredType: "family" });
    expect(out[0]!.code).toBe("F-101");
  });

  it("still offers a lot that matches nothing, if it qualifies", () => {
    const out = suggestLots([lot({ section: "Garden of Hope" })], {
      preferredSection: "Garden of Faith",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(0);
  });
});

describe("near the family plot", () => {
  const anchor = { lat: 16.3958, lng: 120.3586 };

  it("prefers the closer lot", () => {
    const nearby = lot({ code: "A-101", centroid: anchor });
    const across = lot({
      code: "Z-101",
      centroid: { lat: 16.3988, lng: 120.3626 },
    });
    const out = suggestLots([across, nearby], { near: anchor });
    expect(out[0]!.code).toBe("A-101");
  });

  it("reports the distance so staff can say it out loud", () => {
    const out = suggestLots([lot({ centroid: anchor })], { near: anchor });
    expect(out[0]!.distanceMetres).toBeDefined();
    expect(out[0]!.distanceMetres!).toBeLessThan(1);
  });

  it("does not fall over on a lot with no geometry", () => {
    const noGeo = lot({ code: "N-1", centroid: undefined });
    const out = suggestLots([noGeo], { near: anchor });
    expect(out).toHaveLength(1);
    expect(out[0]!.distanceMetres).toBeUndefined();
  });
});

describe("every suggestion explains itself", () => {
  it("gives reasons in words, not scores", () => {
    const out = suggestLots(
      [lot({ section: "Garden of Faith", type: "family" })],
      {
        preferredSection: "Garden of Faith",
        preferredType: "family",
        maxPriceCents: 90_000_00,
      },
    );
    const labels = out[0]!.reasons.map((r) => r.label);
    expect(labels.some((l) => /Garden of Faith/.test(l))).toBe(true);
    expect(labels.some((l) => /family lot, as asked/i.test(l))).toBe(true);
    // A relevance score is not something you read to a grieving family.
    for (const label of labels) {
      expect(label).not.toMatch(/score|points|0\.\d/i);
    }
  });

  it("shows the price in pesos in the budget reason", () => {
    const out = suggestLots([lot({ basePriceCents: 45_000_00 })], {
      maxPriceCents: 90_000_00,
    });
    const budget = out[0]!.reasons.find((r) => /within budget/i.test(r.label));
    expect(budget?.label).toContain("₱45,000");
  });
});

describe("ordering is stable and sensible", () => {
  it("prefers the cheaper lot when the fit is identical", () => {
    const cheap = lot({ code: "A-102", basePriceCents: 30_000_00 });
    const dear = lot({ code: "A-101", basePriceCents: 60_000_00 });
    const out = suggestLots([dear, cheap], {});
    expect(out[0]!.code).toBe("A-102");
  });

  it("does not reshuffle between identical queries", () => {
    // Two lots alike in every way must come back in the same order, or
    // a staffer re-running a search sees a different recommendation.
    const a = lot({ code: "A-101", lotId: "lots:a" });
    const b = lot({ code: "A-102", lotId: "lots:b" });
    const first = suggestLots([a, b], {}).map((s) => s.code);
    const second = suggestLots([b, a], {}).map((s) => s.code);
    expect(first).toEqual(second);
  });

  it("honours the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      lot({ code: `A-${100 + i}`, lotId: `lots:${i}` }),
    );
    expect(suggestLots(many, {}, 3)).toHaveLength(3);
  });
});

describe("distanceMetres", () => {
  it("is zero for the same point", () => {
    const p = { lat: 16.3958, lng: 120.3586 };
    expect(distanceMetres(p, p)).toBeCloseTo(0, 6);
  });

  it("measures a short hop across the park sensibly", () => {
    // ~0.001° of latitude is a little over 100 m.
    const d = distanceMetres(
      { lat: 16.3958, lng: 120.3586 },
      { lat: 16.3968, lng: 120.3586 },
    );
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });
});
