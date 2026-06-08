/**
 * Global search domain (Story 1.10, FR7, UX-DR12).
 *
 * Powers the Cmd-K / Ctrl-K palette mounted in `(staff)/layout.tsx`.
 * Search is the primary navigation path across the staff app — sidebar
 * is secondary (UX-DR12). The palette consumes `searchAll` reactively
 * via `useQuery`, debouncing input by 80ms client-side.
 *
 * Scope matrix:
 *   - lots       — Phase 1 (this story); indexed prefix + in-memory
 *                  substring filter.
 *   - customers  — stubbed `[]` in Phase 1; Story 2.1 fills in.
 *   - contracts  — `[]` until Epic 3.
 *   - receipts   — `[]` until Epic 3.
 *
 * Indexing strategy (architecture compliance):
 *   1. If the query looks like a lot-code prefix (uppercase chars +
 *      dashes), use `by_code` with a `gte` / `lt` range against the
 *      `q` and `q + "￿"` bookends. `￿` is the maximum
 *      Unicode codepoint, so any code starting with `q` sorts ≤ that
 *      boundary.
 *   2. Else if the query looks like a section prefix (a single
 *      letter A–Z), use `by_section_block` with the same range trick
 *      on `section`.
 *   3. Else, fall through to a full-table scan + in-memory substring
 *      filter. At 2,000 lots this is acceptable; ADR-0009 documents
 *      the deferral of Convex's full-text-search index.
 *
 * PII boundary (NFR-S3):
 *   Search results NEVER include gov ID, full address, or phone. The
 *   lot projection is minimal (`_id, code, section, type, status`) so
 *   the wire payload stays under 5 KB for 20 rows. Story 2.1 enforces
 *   the same minimalism on customers (`_id, displayName` only).
 */

import {
  type DataModelFromSchemaDefinition,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type QueryCtx } from "./lib/auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type LotDoc = DataModel["lots"]["document"];

/**
 * Maximum results returned per entity type. Twenty rows is the
 * shadcn/ui `Command` palette's comfortable scroll budget; beyond
 * that the user should refine the query rather than scroll. Mirrors
 * the architecture's "small bounded result sets" principle.
 */
const RESULT_LIMIT = 20;

/**
 * Minimal lot projection sent over the wire. The palette only renders
 * `code`, `section`, `type`, `status` — and the `_id` for navigation
 * — so projecting here keeps the payload < 5 KB at 20 rows.
 */
export interface LotSearchHit {
  _id: LotDoc["_id"];
  code: string;
  section: string;
  block: string;
  row: string;
  type: LotDoc["type"];
  status: LotDoc["status"];
}

/**
 * Aggregate search result shape. Each scope's array is independently
 * capped at `RESULT_LIMIT`. Empty scopes return `[]` so the client
 * renders no group header (cleaner UI than empty headings).
 */
export interface SearchResults {
  lots: LotSearchHit[];
  /** Story 2.1 fills this in. Type is intentionally open here. */
  customers: Array<{ _id: string; displayName: string }>;
  /** Epic 3 fills this in. */
  contracts: Array<{ _id: string; serialNumber: string }>;
  /** Epic 3 fills this in. */
  receipts: Array<{ _id: string; serialNumber: string }>;
}

const scopeValidator = v.union(
  v.literal("lots"),
  v.literal("customers"),
  v.literal("contracts"),
  v.literal("receipts"),
);

type Scope = "lots" | "customers" | "contracts" | "receipts";

/**
 * Public reactive search query.
 *
 * Args:
 *   - `query` — caller-typed string. Trimmed + uppercased before any
 *     index comparison; the lot `code` column is always uppercase by
 *     architecture convention.
 *   - `scopes` — optional restriction. Defaults to all four. The
 *     palette uses this when only certain scopes are relevant (e.g.
 *     "lots" only on the field worker's mobile shortcut).
 *
 * Auth:
 *   `requireRole(ctx, ["admin", "office_staff", "field_worker"])`.
 *   Customers are intentionally excluded — Phase 3's customer portal
 *   will have its own scoped search query.
 */
export const searchAll = queryGeneric({
  args: {
    query: v.string(),
    scopes: v.optional(v.array(scopeValidator)),
  },
  handler: async (
    ctx: QueryCtx,
    args: { query: string; scopes?: Scope[] },
  ): Promise<SearchResults> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const scopes: Scope[] =
      args.scopes ?? ["lots", "customers", "contracts", "receipts"];
    const q = args.query.trim().toUpperCase();

    const empty: SearchResults = {
      lots: [],
      customers: [],
      contracts: [],
      receipts: [],
    };
    if (q.length === 0) return empty;

    const result: SearchResults = {
      lots: scopes.includes("lots") ? await searchLots(ctx, q, RESULT_LIMIT) : [],
      customers: scopes.includes("customers")
        ? await searchCustomers(ctx, q, RESULT_LIMIT)
        : [],
      contracts: [],
      receipts: [],
    };
    return result;
  },
});

/**
 * One grave hit for the "find a grave" map search. Carries the lot's
 * centroid so the map can fly straight to it, plus the lot code + status
 * so the result row is meaningful and the action menu can open.
 */
export interface GraveHit {
  occupantName: string;
  dateOfInterment?: number;
  lotId: LotDoc["_id"];
  lotCode: string;
  section: string;
  status: LotDoc["status"];
  centroid: { lat: number; lng: number };
}

/**
 * Find-a-grave — search interred occupants by name and return the lot
 * each rests in, with coordinates so the map can fly there (Map cockpit,
 * #2). Staff-scoped (the family-facing public variant is a separate
 * portal query).
 *
 * A full scan of `occupants` with an in-memory substring match — the
 * same approach `searchLots` takes for free-text, acceptable at the
 * architecture's ~2,000-row target (ADR-0009 defers full-text search).
 * `centroid` is always present (placeholder lots carry the default
 * centroid), so a fly-to always has somewhere to go.
 */
export const findGrave = queryGeneric({
  args: { query: v.string() },
  handler: async (
    ctx: QueryCtx,
    args: { query: string },
  ): Promise<GraveHit[]> => {
    await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
    const q = args.query.trim().toLowerCase();
    // Two-char floor keeps a single keystroke from scanning the table.
    if (q.length < 2) return [];

    const occupants = await ctx.db.query("occupants").collect();
    const matches = occupants
      .filter((o) => !o.isRemoved && o.name.toLowerCase().includes(q))
      .slice(0, RESULT_LIMIT);

    const hits: GraveHit[] = [];
    for (const o of matches) {
      const lot = await ctx.db.get(o.lotId);
      if (lot === null || lot.isRetired) continue;
      const hit: GraveHit = {
        occupantName: o.name,
        lotId: lot._id,
        lotCode: lot.code,
        section: lot.section,
        status: lot.status,
        centroid: {
          lat: lot.geometry.centroid.lat,
          lng: lot.geometry.centroid.lng,
        },
      };
      if (o.dateOfInterment !== undefined) {
        hit.dateOfInterment = o.dateOfInterment;
      }
      hits.push(hit);
    }
    return hits;
  },
});

/**
 * Looks like a lot-code prefix when it is at least one character of
 * `[A-Z0-9-]`. A single capital letter such as `D` qualifies — the
 * `by_code` range will then pick up every code starting with `D`,
 * which is the user's likely intent for typing one letter into the
 * palette.
 *
 * The "uppercase or digit or dash, only" predicate keeps free-text
 * queries (e.g. "family") on the substring path.
 */
function looksLikeCodePrefix(q: string): boolean {
  return /^[A-Z0-9-]+$/.test(q);
}

/**
 * Looks like a section prefix when it is a single A–Z letter. We
 * intentionally narrow this to one character — a multi-char section
 * (the cemetery uses single letters today) is unlikely and would
 * collide with code prefixes anyway.
 */
function looksLikeSectionPrefix(q: string): boolean {
  return /^[A-Z]$/.test(q);
}

/**
 * Performs the actual lot search. Tries the most-selective index
 * first, then falls back to in-memory substring matching.
 *
 * The `￿` upper-bound sentinel is the Convex idiom for an index
 * prefix range — see the story's "Disaster prevention" notes.
 */
async function searchLots(
  ctx: QueryCtx,
  q: string,
  limit: number,
): Promise<LotSearchHit[]> {
  let candidates: LotDoc[] = [];

  if (looksLikeCodePrefix(q)) {
    // Prefix range on the `by_code` index. The upper bound uses the
    // max Unicode codepoint so any code starting with `q` is included.
    // We collect-then-cap (rather than `.take(N)`) so the slice
    // happens after the `!isRetired` filter below — `.take` would
    // count retired rows toward the cap and could under-fill the
    // result. At 2,000 lots a `.collect()` here is bounded by the
    // prefix range anyway (typically a handful of rows).
    candidates = await ctx.db
      .query("lots")
      .withIndex("by_code", (idx) =>
        idx.gte("code", q).lt("code", q + "￿"),
      )
      .collect();
  } else if (looksLikeSectionPrefix(q)) {
    // Single-letter section query. `by_section_block` is keyed on
    // `[section, block]`; a `.eq("section", q)` is the safe range.
    candidates = await ctx.db
      .query("lots")
      .withIndex("by_section_block", (idx) => idx.eq("section", q))
      .collect();
  } else {
    // Free-text fallthrough: full-table scan. Acceptable at the
    // architecture's 2,000-row target; ADR-0009 documents the FTS
    // deferral.
    const all = await ctx.db.query("lots").collect();
    candidates = all.filter(
      (l) =>
        l.code.toUpperCase().includes(q) ||
        l.section.toUpperCase().includes(q) ||
        l.block.toUpperCase().includes(q) ||
        l.row.toUpperCase().includes(q),
    );
  }

  const hits: LotSearchHit[] = [];
  for (const lot of candidates) {
    if (lot.isRetired) continue;
    hits.push({
      _id: lot._id,
      code: lot.code,
      section: lot.section,
      block: lot.block,
      row: lot.row,
      type: lot.type,
      status: lot.status,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Customer search stub.
 *
 * Story 2.1 implements when the `customers` table lands. The palette
 * already wires up the slot so Epic 2 can drop in real results
 * without re-architecting the search query or the client.
 *
 * **No PII** — even when implemented, this must return only `_id` and
 * `displayName`. Gov ID, address, phone are NEVER part of the search
 * payload.
 */
async function searchCustomers(
  _ctx: QueryCtx,
  _q: string,
  _limit: number,
): Promise<Array<{ _id: string; displayName: string }>> {
  // TODO (Story 2.1): query `customers` table once it exists.
  return [];
}
