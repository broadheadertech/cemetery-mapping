/**
 * "Which lot should we offer them?"
 *
 * A family sits down with a budget, a number of people the plot has to
 * hold, sometimes a garden they feel drawn to, and very often a wish to
 * be near someone already buried here. Answering that today means
 * paging through inventory while they wait.
 *
 * This asks the same questions once and returns a short ranked list,
 * each entry carrying the reasons it scored well — because the answer
 * gets read aloud across a desk, not consumed by a machine.
 *
 * The ranking itself is plain arithmetic in `lib/lotSuggestion.ts`, and
 * deliberately so: a scoring function can be read, argued with, and
 * tested, which matters when the thing being ranked is where someone's
 * mother will be buried.
 */

import {
  type DataModelFromSchemaDefinition,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type QueryCtx } from "./lib/auth";
import {
  type Suggestion,
  type SuggestionCandidate,
  suggestLots,
} from "./lib/lotSuggestion";
import { UNITS_PER_BODY, UNITS_PER_BONES } from "./lib/lotCapacity";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotDoc = DataModel["lots"]["document"];

/**
 * Scanning cap.
 *
 * The park is ~2,000 lots, so reading the available ones and scoring in
 * memory is well within a query's budget and far simpler than
 * maintaining a search index that would drift from the capacity rules.
 * The cap is a backstop against a future inventory this was not sized
 * for, and it is reported so a truncated answer never passes for a
 * complete one.
 */
const MAX_SCANNED = 2500;

export interface SuggestLotsResult {
  suggestions: Suggestion[];
  /** How many available lots were considered. */
  considered: number;
  /** True when the scan hit its cap and the ranking may be partial. */
  truncated: boolean;
  /**
   * The `nearLotCode` given matched no lot. The ranking still ran,
   * without the proximity term — so the UI can say "that code was not
   * found, here is what fits otherwise" rather than showing nothing.
   */
  nearLotNotFound: boolean;
  /** Echoed back so the UI can say what it searched for. */
  criteria: {
    maxPriceCents?: number;
    requiredBodies?: number;
    requiredBones?: number;
    preferredType?: string;
    preferredSection?: string;
    nearLotCode?: string;
  };
}

export const suggestLotsForFamily = queryGeneric({
  args: {
    /** Hard ceiling — nothing above it is suggested at any rank. */
    maxPriceCents: v.optional(v.number()),
    /** How many bodies the plot must hold. */
    requiredBodies: v.optional(v.number()),
    /** How many sets of transferred remains it must hold. */
    requiredBones: v.optional(v.number()),
    preferredType: v.optional(v.string()),
    preferredSection: v.optional(v.string()),
    /** "Near my father" — the code of a lot the family already has. */
    nearLotCode: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      maxPriceCents?: number;
      requiredBodies?: number;
      requiredBones?: number;
      preferredType?: string;
      preferredSection?: string;
      nearLotCode?: string;
      limit?: number;
    },
  ): Promise<SuggestLotsResult> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    // Resolve "near my father's plot" to a point on the ground.
    let near: { lat: number; lng: number } | undefined;
    let nearLotNotFound = false;
    if (
      typeof args.nearLotCode === "string" &&
      args.nearLotCode.trim().length > 0
    ) {
      const code = args.nearLotCode.trim();
      const anchor = await ctx.db
        .query("lots")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      // A mistyped code is expected input from someone reading a
      // handwritten record, not an exceptional condition. Throwing here
      // would reject the query, and a rejected `useQuery` throws during
      // render — the family's adviser would get a crash screen for a
      // typo. Report it and rank without the proximity term instead.
      if (anchor === null) {
        nearLotNotFound = true;
      } else {
        near = anchor.geometry.centroid;
      }
    }

    const required =
      (args.requiredBodies ?? 0) * UNITS_PER_BODY +
      (args.requiredBones ?? 0) * UNITS_PER_BONES;

    // Only available lots can be suggested, so let the index do that
    // rather than scanning the whole park and filtering after.
    const available = await ctx.db
      .query("lots")
      .withIndex("by_status", (q) => q.eq("status", "available"))
      .take(MAX_SCANNED);

    const candidates: SuggestionCandidate[] = [];
    for (const lot of available as LotDoc[]) {
      if (lot.isRetired) continue;
      const occupants = await ctx.db
        .query("occupants")
        .withIndex("by_lot", (q) => q.eq("lotId", lot._id))
        .collect();
      const candidate: SuggestionCandidate = {
        lotId: lot._id,
        code: lot.code,
        type: lot.type,
        section: lot.section,
        basePriceCents: lot.basePriceCents,
        status: lot.status,
        isRetired: lot.isRetired,
        centroid: lot.geometry.centroid,
        occupants,
      };
      if (typeof lot.capacityUnits === "number") {
        candidate.capacityUnits = lot.capacityUnits;
      }
      if (lot.sectionId !== undefined) candidate.sectionId = lot.sectionId;
      candidates.push(candidate);
    }

    const criteria: Parameters<typeof suggestLots>[1] = {};
    if (args.maxPriceCents !== undefined) {
      criteria.maxPriceCents = args.maxPriceCents;
    }
    if (required > 0) criteria.requiredCapacityUnits = required;
    if (args.preferredType !== undefined) {
      criteria.preferredType = args.preferredType;
    }
    if (args.preferredSection !== undefined) {
      criteria.preferredSection = args.preferredSection;
    }
    if (near !== undefined) criteria.near = near;

    const suggestions = suggestLots(candidates, criteria, args.limit ?? 5);

    const echoed: SuggestLotsResult["criteria"] = {};
    if (args.maxPriceCents !== undefined) {
      echoed.maxPriceCents = args.maxPriceCents;
    }
    if (args.requiredBodies !== undefined) {
      echoed.requiredBodies = args.requiredBodies;
    }
    if (args.requiredBones !== undefined) {
      echoed.requiredBones = args.requiredBones;
    }
    if (args.preferredType !== undefined) {
      echoed.preferredType = args.preferredType;
    }
    if (args.preferredSection !== undefined) {
      echoed.preferredSection = args.preferredSection;
    }
    if (args.nearLotCode !== undefined) echoed.nearLotCode = args.nearLotCode;

    return {
      suggestions,
      considered: candidates.length,
      truncated: available.length >= MAX_SCANNED,
      nearLotNotFound,
      criteria: echoed,
    };
  },
});
