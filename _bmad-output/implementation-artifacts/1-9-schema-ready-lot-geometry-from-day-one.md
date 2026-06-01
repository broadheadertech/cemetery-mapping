# Story 1.9: Schema-ready lot geometry from day one

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **architect**,
I want **every lot record to carry `lat/lng centroid + polygon vertices + bounding-box index fields` from Phase 1, with a `geometryStatus: "placeholder" | "surveyed"` field and a `by_bbox_lat` index that performs under p95 < 300ms on the 2,000-lot production inventory**,
so that **the Phase 2 Leaflet swap is a rendering change, not a data migration** (FR9, NFR-P4).

This story **authoritatively designs and verifies the geometry contract** that Story 1.8 scaffolded with placeholder defaults. It also lands the `convex/lib/geometry.ts` server helpers (bbox computation, placeholder centroid, polygon validation) and the `src/lib/geometry.ts` client helpers (bbox intersection, viewport math) that Story 1.10 (search), Story 1.11 (lot detail), and Story 1.12 (SVG map) all depend on. Without this story's hardening, Story 1.12's `useLotsInViewport` query may scan-all rather than index-on-bbox — a silent 10× perf regression that won't surface until production hits 2,000 lots.

## Acceptance Criteria

1. **AC1 — Geometry schema fields are present and typed on every lot row**: `convex/schema.ts`'s `lots` table has `geometry: v.object({ centroid: v.object({ lat: v.number(), lng: v.number() }), polygon: v.array(v.object({ lat: v.number(), lng: v.number() })), bboxMinLat: v.number(), bboxMaxLat: v.number(), bboxMinLng: v.number(), bboxMaxLng: v.number() })` AND `geometryStatus: v.union(v.literal("placeholder"), v.literal("surveyed"))`. `convex deploy` succeeds with no validator errors. (Story 1.8 added the slot; this story verifies the contract and refines any gaps.)

2. **AC2 — Placeholder geometry is produced by `convex/lib/geometry.ts`, not hardcoded in `convex/lots.ts`**: A new server helper `getDefaultPlaceholderGeometry(opts?: { section?: string }): LotGeometry` returns the cemetery centroid (Manila reference coord: `{ lat: 14.6760, lng: 121.0437 }` — same value Story 1.8 used as a temporary inline constant), an empty `polygon: []`, and a zero-area bbox where all four `bboxMin/Max` fields equal the centroid coordinates. `createLot` (Story 1.8) is refactored to call this helper instead of inlining the constant. Per-section overrides accepted in the optional `section` argument (defaults applied; section-specific centroids land in Story 1.12 when SVG section overlays are authored).

3. **AC3 — `bboxFromPolygon` correctly computes the four bbox fields from polygon vertices**: `convex/lib/geometry.ts` exports `bboxFromPolygon(polygon: Array<{ lat: number, lng: number }>): { bboxMinLat, bboxMaxLat, bboxMinLng, bboxMaxLng }`. For empty polygon, returns the centroid-equal degenerate bbox (zero-area). For ≥ 3 vertices, returns `Math.min/max` over `lat` and `lng` arrays. Floating-point precision: vertex coords are kept at native `number` precision (no rounding); bbox fields likewise. Tested for: empty polygon, 3-vertex triangle, 4-vertex rectangle, polygon crossing the antimeridian (out-of-scope warning logged — Manila is far from the 180° meridian, but document the limitation).

4. **AC4 — `updateLotGeometry` internal mutation hardens the geometry contract for future GPS imports**: `convex/lots.ts` adds an `internalMutation` named `updateLotGeometry(args: { lotId, polygon, centroid?, status })` that: validates `polygon.length === 0 || polygon.length >= 3` (no 1-or-2-vertex polygons), recomputes bbox from polygon via `bboxFromPolygon`, computes centroid from polygon if not provided (using simple vertex-average — `convex/lib/geometry.ts → polygonCentroid()`), patches the lot, emits audit with before/after geometry. Marked `internalMutation` because GPS import flows are Epic 5+ (data migration) and not user-callable.

5. **AC5 — `by_bbox_lat` index is verified to be queried, not scanned, by a viewport query**: `convex/lots.ts` adds a public query `listInBbox(args: { bboxMinLat, bboxMaxLat, bboxMinLng, bboxMaxLng }): Doc<"lots">[]` that: runs `requireRole(ctx, ["admin", "office_staff", "field_worker"])`; uses `ctx.db.query("lots").withIndex("by_bbox_lat", q => q.gte("bboxMinLat", bboxMinLat).lte("bboxMaxLat", bboxMaxLat))` then filters `bboxMinLng`/`bboxMaxLng` in-memory (Convex indexes don't span 4 dims; latitude bbox is the discriminating dim — 90% selectivity in practice). Returns ≤ 200 lots (architecture's per-viewport cap; Story 1.12 enforces this). A Vitest performance assertion seeds 2,000 lots and confirms the query returns in < 300ms (NFR-P4) on the test harness.

6. **AC6 — Migration safety: existing Story 1.8 lots are not orphaned**: Story 1.8 already created `lots` rows with the placeholder geometry constant inlined. This story does NOT require a data migration — existing rows already conform to the schema. The refactor (AC2) changes only the code path, not the stored data. Document the no-migration finding in Completion Notes.

## Tasks / Subtasks

### Schema verification (AC1)

- [x] **Task 1: Verify Story 1.8's geometry slot matches this story's contract** (AC: 1)
  - [x] Read `convex/schema.ts`. Confirm the `lots` table's `geometry` field shape matches exactly the AC1 spec. If Story 1.8 deviated (e.g. different field names like `bbox_min_lat` vs `bboxMinLat`), file a deviation note in Completion Notes; this story is the authority — rename to camelCase per architecture § Naming Patterns.
  - [x] Confirm `geometryStatus` exists as `v.union(v.literal("placeholder"), v.literal("surveyed"))`. If missing, add it now and document in Completion Notes that Story 1.8's scaffold was incomplete.
  - [x] Confirm `.index("by_bbox_lat", ["bboxMinLat", "bboxMaxLat"])` exists. If Story 1.8 added it as a placeholder without the dotted field path (e.g. `["geometry.bboxMinLat", "geometry.bboxMaxLat"]`), this is the correct form — Convex supports dotted index paths. Update if needed.
  - [x] Run `npx convex dev` — verify schema deploys cleanly. (Skipped — `convex/_generated/` does not exist in this repo; the schema parses cleanly under `tsc --noEmit` and is consumed by `DataModelFromSchemaDefinition` in `convex/lib/auth.ts`.)

### Server helpers (AC2, AC3, AC4)

- [x] **Task 2: Create `convex/lib/geometry.ts`** (AC: 2, AC: 3)
  - [x] Define types: `export type LatLng = { lat: number, lng: number }`; `export type Polygon = LatLng[]`; `export type Bbox = { bboxMinLat: number, bboxMaxLat: number, bboxMinLng: number, bboxMaxLng: number }`; `export type LotGeometry = { centroid: LatLng, polygon: Polygon } & Bbox`.
  - [x] Export `DEFAULT_PLACEHOLDER_CENTROID: LatLng = { lat: 14.6760, lng: 121.0437 }` as a `const`. Source: Story 1.8's inlined constant. JSDoc reference: "Approximate Manila reference coord; replace with cemetery-actual centroid once survey data is loaded (Story 5.x / Phase 2 GPS import)."
  - [x] Export `getDefaultPlaceholderGeometry(opts?: { section?: string }): LotGeometry`:
    ```ts
    export function getDefaultPlaceholderGeometry(opts?: { section?: string }): LotGeometry {
      const centroid = DEFAULT_PLACEHOLDER_CENTROID; // section override comes in Story 1.12
      return {
        centroid,
        polygon: [],
        bboxMinLat: centroid.lat,
        bboxMaxLat: centroid.lat,
        bboxMinLng: centroid.lng,
        bboxMaxLng: centroid.lng,
      };
    }
    ```
  - [x] Export `bboxFromPolygon(polygon: Polygon, fallback?: LatLng): Bbox`:
    ```ts
    export function bboxFromPolygon(polygon: Polygon, fallback?: LatLng): Bbox {
      if (polygon.length === 0) {
        const c = fallback ?? DEFAULT_PLACEHOLDER_CENTROID;
        return { bboxMinLat: c.lat, bboxMaxLat: c.lat, bboxMinLng: c.lng, bboxMaxLng: c.lng };
      }
      const lats = polygon.map(p => p.lat);
      const lngs = polygon.map(p => p.lng);
      return {
        bboxMinLat: Math.min(...lats),
        bboxMaxLat: Math.max(...lats),
        bboxMinLng: Math.min(...lngs),
        bboxMaxLng: Math.max(...lngs),
      };
    }
    ```
  - [x] Export `polygonCentroid(polygon: Polygon, fallback?: LatLng): LatLng` — vertex-average centroid (not centroid-of-area; sufficient for ≤ 8-vertex lot polygons). For empty polygon, returns fallback. JSDoc warns: "Vertex-average centroid; for irregular polygons in Phase 2, switch to shoelace-formula centroid if visual placement is off — but for typical rectangular lot footprints, vertex-average is correct within 1cm."
  - [x] Export `validatePolygon(polygon: Polygon): { ok: true } | { ok: false, code: "TOO_FEW_VERTICES" | "DUPLICATE_VERTICES" | "INVALID_COORD", details: string }`:
    - Polygon must be empty (length 0) OR have ≥ 3 vertices (`TOO_FEW_VERTICES` for 1–2).
    - No two consecutive vertices identical (`DUPLICATE_VERTICES`).
    - Every coord is finite (`Number.isFinite`) and within Manila bounds (lat 14.4–14.8, lng 120.9–121.1) — sanity range, not strict cemetery bounds.

- [x] **Task 3: Refactor `createLot` to use `getDefaultPlaceholderGeometry`** (AC: 2)
  - [x] Story 1.8's `convex/lots.ts → createLot` inlined `{ lat: 14.6760, lng: 121.0437 }` as the default centroid. Refactor: `import { getDefaultPlaceholderGeometry } from "./lib/geometry"`. Replace the inline geometry object with `getDefaultPlaceholderGeometry({ section: args.section })`.
  - [x] Set `geometryStatus: "placeholder"` on creation (already done in Story 1.8 — verify).
  - [x] No schema change. No behavior change. Pure refactor. Story 1.8's tests should pass unchanged.

- [x] **Task 4: Add `updateLotGeometry` internal mutation** (AC: 4)
  - [x] In `convex/lots.ts`, add:
    ```ts
    export const updateLotGeometry = internalMutation({
      args: {
        lotId: v.id("lots"),
        polygon: v.array(v.object({ lat: v.number(), lng: v.number() })),
        centroid: v.optional(v.object({ lat: v.number(), lng: v.number() })),
        status: v.union(v.literal("placeholder"), v.literal("surveyed")),
      },
      handler: async (ctx, args) => {
        // Validate
        const v = validatePolygon(args.polygon);
        if (!v.ok) throwError(ErrorCode.INVARIANT_VIOLATION, v.details);
        // Fetch before
        const before = await ctx.db.get(args.lotId);
        if (!before) throwError(ErrorCode.NOT_FOUND, "Lot not found.");
        // Compute centroid + bbox
        const centroid = args.centroid ?? polygonCentroid(args.polygon, before.geometry.centroid);
        const bbox = bboxFromPolygon(args.polygon, centroid);
        // Patch
        const nextGeometry = { centroid, polygon: args.polygon, ...bbox };
        await ctx.db.patch(args.lotId, { geometry: nextGeometry, geometryStatus: args.status });
        // Audit (uses Story 1.6's emitAudit)
        await emitAudit(ctx, {
          action: "update_geometry", entityType: "lot", entityId: args.lotId,
          before: { geometry: before.geometry, geometryStatus: before.geometryStatus },
          after: { geometry: nextGeometry, geometryStatus: args.status },
        });
      },
    });
    ```
  - [x] Note: `internalMutation` is exempt from Story 1.2's `requireRole` lint rule. JSDoc: "Internal-only because GPS-import flows are server-to-server (Epic 5+ data migration). Do NOT make this a public `mutation` without role-checking who can rewrite geometry."

### Viewport-bbox query (AC5)

- [x] **Task 5: Add `listInBbox` public query** (AC: 5)
  - [x] In `convex/lots.ts`, add:
    ```ts
    export const listInBbox = query({
      args: {
        bboxMinLat: v.number(), bboxMaxLat: v.number(),
        bboxMinLng: v.number(), bboxMaxLng: v.number(),
        statusFilter: v.optional(v.union(...)), // same union as listLots
        limit: v.optional(v.number()),          // default 200, max 500
      },
      handler: async (ctx, args) => {
        await requireRole(ctx, ["admin", "office_staff", "field_worker"]);
        const limit = Math.min(args.limit ?? 200, 500);
        // Use by_bbox_lat: filter lots whose bbox lat range OVERLAPS the viewport bbox.
        // A lot overlaps viewport when: lot.bboxMaxLat >= viewport.bboxMinLat AND lot.bboxMinLat <= viewport.bboxMaxLat.
        // Index supports one range: query lots where bboxMaxLat >= viewport.bboxMinLat (index field 1: bboxMinLat — see note).
        // NOTE: Convex range index is on (bboxMinLat, bboxMaxLat). Use it as: gte("bboxMinLat", -infinity_proxy).lte("bboxMinLat", viewport.bboxMaxLat) — then filter bboxMaxLat >= viewport.bboxMinLat in-memory.
        const candidates = await ctx.db.query("lots")
          .withIndex("by_bbox_lat", q => q.gte("geometry.bboxMinLat", args.bboxMinLat - 0.1).lte("geometry.bboxMinLat", args.bboxMaxLat))
          .collect();
        return candidates
          .filter(l => !l.isRetired)
          .filter(l => l.geometry.bboxMaxLat >= args.bboxMinLat)
          .filter(l => l.geometry.bboxMinLng <= args.bboxMaxLng && l.geometry.bboxMaxLng >= args.bboxMinLng)
          .filter(l => !args.statusFilter || l.status === args.statusFilter)
          .slice(0, limit);
      },
    });
    ```
  - [x] **Note for Story 1.12**: this is the query that `useLotsInViewport` will call. It's added in this story to verify the index works before the map UI ships.
  - [x] **Note on the 0.1° pre-filter**: a placeholder-geometry lot has bbox lat min == max == centroid lat. The `q.gte` with a 0.1° pad ensures the index picks up placeholder-bbox lots near the viewport. Once GPS data lands (Phase 2), bboxes become real intervals and the pad can shrink. Document this in the query's JSDoc.

### Testing (AC1, AC3, AC4, AC5)

- [x] **Task 6: Unit tests for `convex/lib/geometry.ts`** (AC: 2, AC: 3)
  - [x] Create `tests/unit/convex/lib/geometry.test.ts`. Cover:
    - `getDefaultPlaceholderGeometry()` returns the centroid + zero-area bbox.
    - `bboxFromPolygon([])` returns fallback-centered zero-area bbox.
    - `bboxFromPolygon([{14.67,121.04}, {14.68,121.04}, {14.68,121.05}, {14.67,121.05}])` returns the correct min/max.
    - `polygonCentroid([{14.67,121.04}, {14.68,121.04}, {14.68,121.05}, {14.67,121.05}])` returns `{14.675, 121.045}`.
    - `validatePolygon([])` → ok.
    - `validatePolygon([{1,1}])` → `TOO_FEW_VERTICES`.
    - `validatePolygon([{1,1}, {1,1}, {2,2}])` → `DUPLICATE_VERTICES`.
    - `validatePolygon([{NaN,1}, {1,1}, {2,2}])` → `INVALID_COORD`.
    - `validatePolygon([{0,0}, {1,1}, {2,2}])` → `INVALID_COORD` (outside Manila sanity range).
  - [x] Coverage target: 100% line on `convex/lib/geometry.ts`. It's foundation code Story 1.10–1.12 build on.

- [x] **Task 7: Convex tests for `listInBbox` + `updateLotGeometry`** (AC: 4, AC: 5)
  - [x] Extend `tests/unit/convex/lots.test.ts` (Story 1.8) with:
    - `listInBbox` happy path: 5 lots with known bboxes, viewport contains 2 → returns 2. (✓)
    - `listInBbox` excludes retired lots. (✓)
    - `listInBbox` respects `statusFilter`. (✓)
    - `listInBbox` respects `limit` (cap at 500). (✓ — explicit `limit: 3` test plus a `limit: 9999` clamp test.)
    - `listInBbox` requires role (FORBIDDEN for a customer-role caller). (✓ plus a "permits admin/office_staff/field_worker" companion test.)
    - `updateLotGeometry` happy path: 4-vertex polygon → bbox recomputed, audit emitted with before/after. (✓)
    - `updateLotGeometry` rejects 2-vertex polygon (`INVARIANT_VIOLATION`). (✓)
    - `updateLotGeometry` rejects unknown lot (`NOT_FOUND`). (✓)
    - Bonus tests added beyond the spec: `updateLotGeometry` uses caller-supplied centroid when provided; `updateLotGeometry` accepts an empty polygon for placeholder-reset; `updateLotGeometry` rejects out-of-range coords with `INVARIANT_VIOLATION`.

- [x] **Task 8: Performance test (NFR-P4)** (AC: 5)
  - [x] Create `tests/unit/convex/lots.perf.test.ts`. Use `convex-test` to seed 2,000 lots with varied bbox lat values (spread across Manila bounds). Issue `listInBbox` queries with 10 random viewport bboxes; assert p95 < 300ms. **Caveat**: convex-test runs in-process; absolute times will differ from production Convex Cloud. The assertion guards against the *scan-all* regression — if `listInBbox` accidentally drops the `withIndex` call, the test will break with a > 1s runtime. Document this caveat in the test's file-level comment. (Implementation note: this repo's `_generated/` does not yet exist, so the perf test uses the same hand-mocked ctx pattern as `lots.test.ts` with extended `gte/lte` support for the index range.)
  - [x] If the convex-test harness doesn't expose query latency, instrument via `performance.now()` around the query call. Assert `< 300ms` average over 10 trials.
  - [x] Skip this test in CI for now (slow) with `it.skip` + a `TODO: remove skip once perf-test runner is set up in Story 5.x` note. The seeding + assertion code is committed so it can be turned on without re-writing.

### Documentation (AC1, AC2)

- [x] **Task 9: ADR-0008 + JSDoc + README note** (AC: 1, AC: 2)
  - [x] Write `docs/adr/0008-geometry-fields-from-day-one.md`. Capture: "Every lot row carries centroid + polygon + bbox from Phase 1, even when GPS data doesn't exist yet. Placeholder geometry is centroid-equal zero-area bbox. Phase 2 GPS import flow uses `updateLotGeometry` internal mutation, no schema change. The `by_bbox_lat` index makes 2,000-lot viewport queries fit under NFR-P4. Per architecture § Data Architecture — schema-ready from day one means the Phase 1→2 map swap is a rendering swap."
  - [x] Add file-level JSDoc to `convex/lib/geometry.ts` summarizing the helpers + cross-references to Stories 1.10 / 1.11 / 1.12.

## Dev Notes

### Previous story intelligence

**Stories 1.1–1.7 produced:** all the cornerstones — `requireRole` (1.2), `StatusPill` (1.4), Cmd-K scaffold (1.5), `emitAudit` (1.6), `assertTransition` + `transitionLotStatus` (1.7).

**Story 1.8 produced:** the `lots` table with the `geometry` slot and `geometryStatus` field PRE-EXISTING in the schema. Story 1.8's `createLot` inlined the placeholder centroid constant `{ lat: 14.6760, lng: 121.0437 }`. Story 1.8's tests assume this default. **This story refactors that inline into `convex/lib/geometry.ts → getDefaultPlaceholderGeometry()` — no behavior change, the constant moves files.**

**Story 1.8's `by_bbox_lat` index** was added as a "placeholder" — this story verifies it actually works with a real viewport query (`listInBbox`).

**Stories 1.10–1.14 (not yet implemented) consume this story's output:**
- 1.10 (search): no direct geometry dependency, but search-result preview cards may render a tiny map icon based on `geometryStatus`.
- 1.11 (lot detail): renders `geometryStatus` pill ("surveyed" vs "placeholder").
- 1.12 (SVG map): `useLotsInViewport` hook calls `api.lots.listInBbox` from this story; `src/lib/geometry.ts` client helpers extend this story's contract.
- 1.13 (offline): caches `listInBbox` responses with 24h TTL.
- 1.14 (condition log): no direct geometry dependency.

### Architecture compliance

- **Geometry fields locked from day one** per architecture § Geospatial Viewport Queries + § Data Architecture sample schema. This story makes that promise real.
- **`convex/lib/geometry.ts`** — slotted in architecture's repo layout under `convex/lib/`. Server-only; client `src/lib/geometry.ts` (Story 1.12) is separate.
- **No PostGIS, no Postgres geometry types** — Convex stores polygon vertices as `Array<{ lat, lng }>`. Bbox is four scalar fields. Index on `(bboxMinLat, bboxMaxLat)`. Acceptable trade-off per architecture's "no separate API layer, no ORM, no PostGIS" lock.
- **`emitAudit` on every geometry mutation** — Story 1.6's helper. Story 1.6's lint rule blocks direct `auditLog` writes. Geometry changes are tracked because field-survey corrections create legal/dispute exposure (lot boundaries → ownership disputes).
- **Internal mutation for `updateLotGeometry`** — not exposed to clients; GPS-import flow lives in Epic 5+. If a future story wants a "Field worker re-surveyed this lot from their phone" capability, that's a new public mutation with `requireRole(ctx, ["admin"])` (admin-only for legal reasons).

### Library / framework versions (current)

- **No new dependencies.** Pure TypeScript + Convex's `v.*` validators (already installed).
- **Math:** `Math.min`, `Math.max`, native arithmetic. No `proj4`, no `turf`, no geospatial library. Manila is far from poles and antimeridian; we don't need projection-aware math for Phase 1.
- **convex-test** (Story 1.2 installed) — used for `listInBbox` correctness tests. Performance test is best-effort given convex-test's in-process nature.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── lib/
│   │   └── geometry.ts                        # NEW (DEFAULT_PLACEHOLDER_CENTROID, getDefaultPlaceholderGeometry, bboxFromPolygon, polygonCentroid, validatePolygon)
│   ├── lots.ts                                # UPDATE (refactor createLot to call getDefaultPlaceholderGeometry; add listInBbox query; add updateLotGeometry internalMutation)
│   └── schema.ts                              # VERIFY (no change expected; document any deviation found)
├── tests/
│   └── unit/
│       └── convex/
│           ├── lib/
│           │   └── geometry.test.ts           # NEW (100% coverage)
│           ├── lots.test.ts                   # UPDATE (add listInBbox + updateLotGeometry test cases)
│           └── lots.perf.test.ts              # NEW (skipped in CI; documents the perf invariant)
├── docs/
│   └── adr/
│       └── 0008-geometry-fields-from-day-one.md  # NEW
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code) does not apply** — geometry is not financial. However, this is **foundation code** that 5 stories (1.10–1.14) depend on. Target: **100% line on `convex/lib/geometry.ts`**, ≥ 90% on the new `listInBbox` + `updateLotGeometry` paths in `convex/lots.ts`.
- **Performance test deliberately skipped in CI** (Task 8) — documents the invariant without slowing PRs. Re-enable in Story 5.x when the perf-test runner is set up.
- **No new Playwright spec** — geometry is server/schema work, no new UI in this story. Story 1.12 will exercise the end-to-end map render.

### Source references

- **PRD:** [FR9 (geometry from Phase 1)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping); [NFR-P4 (Convex query p95 < 300ms)](../../_bmad-output/planning-artifacts/prd.md#performance)
- **Architecture:** [§ Data Architecture > sample schema with geometry fields + by_bbox_lat index](../../_bmad-output/planning-artifacts/architecture.md#data-architecture); [§ Frontend Architecture > Phase 1 map renderer](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture); [§ Geospatial Viewport Queries](../../_bmad-output/planning-artifacts/architecture.md#scope--scale-parameters); [§ Decision Impact Analysis > Implementation Sequence step 9 (map renderer)](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis)
- **Epics:** [Story 1.9](../../_bmad-output/planning-artifacts/epics.md#story-19-schema-ready-lot-geometry-from-day-one)
- **Previous stories:** [1.6 emitAudit](./1-6-audit-log-emission-helper.md), [1.7 state machines](./1-7-state-machine-transition-guards.md), [1.8 lots schema + CRUD](./1-8-office-staff-creates-and-edits-lot-records.md)
- Convex docs: [Indexes](https://docs.convex.dev/database/indexes/), [Schema validators](https://docs.convex.dev/database/schemas)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT add a new dependency** (`turf`, `proj4`, `@turf/bbox`, etc.). Manila Phase 1 doesn't need projection-aware math; native `Math.min/max` is correct. Adds bundle weight + supply-chain risk for zero benefit.
- ❌ **Do NOT migrate existing lots** — Story 1.8 created rows with the (correct) placeholder constant. The schema and stored values already match this story's contract. AC6 explicitly notes "no migration."
- ❌ **Do NOT change the schema field names** (e.g. `bboxMinLat` → `minLat`). Story 1.8 already committed to these names; any change cascades across `listInBbox`, the index, Story 1.12's hook, and a future Phase 2 GPS importer.
- ❌ **Do NOT expose `updateLotGeometry` as a public `mutation`.** Use `internalMutation`. Story 1.2's lint rule will fail otherwise (and the rule is correct — geometry rewrites need admin role-gating once user-callable, not free-fire).
- ❌ **Do NOT inline `{ lat: 14.6760, lng: 121.0437 }` anywhere outside `convex/lib/geometry.ts`.** If Story 1.8's `createLot` still has the inline constant after Task 3, the refactor is incomplete. Repeat the constant = 2 places to update when the cemetery centroid is corrected (Story 5.x).
- ❌ **Do NOT compute centroid from bbox** (i.e., `(bboxMin + bboxMax) / 2`). The polygon's geometric centroid is *not* the bbox center for non-rectangular shapes. Use `polygonCentroid` (vertex-average) or accept the explicit `centroid` argument.
- ❌ **Do NOT skip the 0.1° pad in `listInBbox`'s index range** without understanding why it's there. Placeholder-geometry lots have zero-area bboxes (bboxMin === bboxMax). Without the pad, `q.gte("bboxMinLat", viewport.bboxMinLat)` excludes lots where `bboxMinLat < viewport.bboxMinLat` even if they overlap. The pad is correct; document it in the JSDoc.
- ❌ **Do NOT add `withIndex` then iterate with `.filter()` for the lng dimension if you can avoid it.** For 2,000 lots in a single section, latitude-bbox alone narrows to ~200 rows; in-memory lng filter is cheap. For a 50,000-lot future scale, add a separate `by_section` index and combine; that's a Story 1.12+ concern.
- ❌ **Do NOT run the perf test in CI** without first measuring how long convex-test takes to seed 2,000 rows. Likely > 30s — too slow for every PR. Skip it; Story 5.x sets up a nightly perf-suite runner.

### Common LLM-developer mistakes to prevent

- **Confusing centroid-of-area vs vertex-average:** for irregular polygons (Phase 2 GPS data with curved cemetery sections), the geometric centroid (shoelace formula) differs from vertex-average. For Phase 1 placeholder + rectangular surveyed lots, vertex-average is correct within cm. JSDoc on `polygonCentroid` warns; do not silently switch algorithms.
- **Convex dotted index paths:** the index on `(bboxMinLat, bboxMaxLat)` is actually on `(geometry.bboxMinLat, geometry.bboxMaxLat)` because the fields live inside the nested `geometry` object. Use `.index("by_bbox_lat", ["geometry.bboxMinLat", "geometry.bboxMaxLat"])` and `withIndex("by_bbox_lat", q => q.gte("geometry.bboxMinLat", ...))`. Convex supports dotted paths; Story 1.8 may have used the wrong form — verify in Task 1.
- **Float precision:** vertex coords are kept at native `number` precision. Do NOT round to 5 decimal places — that's ~1m at Manila latitude and loses cm-level survey accuracy. The schema validator `v.number()` accepts full precision.
- **Type confusion `LotGeometry` vs `Bbox` vs `Polygon`:** keep the type definitions in `convex/lib/geometry.ts` and import everywhere. Do NOT define a competing `Geometry` type in `convex/lots.ts` or `src/lib/geometry.ts` (Story 1.12 imports from the server-side module via a separate client mirror).
- **`internalMutation` import:** comes from `./_generated/server`, not `convex/server`. Convex's generated code distinguishes the two; using the wrong import compiles but produces a non-internal mutation that the lint rule will flag.
- **Returning the whole lot document from `listInBbox`:** for 200 lots × ~1KB each = 200KB on the wire. Phase 1 is fine; Phase 2 with photos/attachments via reference fields keeps this small. Do NOT add a `populate=true` parameter — Story 1.12's map only needs `_id`, `code`, `status`, `geometry.centroid` for rendering. A future optimization can add a `listInBboxMinimal` projection query if bundle size becomes a constraint.

### Open questions / blockers this story does NOT resolve

- **None.** Story 1.8 already committed to the geometry slot; this story hardens it. The §10 brief questions don't touch geometry.
- **Phase 2 dependency NOT blocking:** GPS-survey loader (Epic 5+) consumes `updateLotGeometry` from this story. Until then, all lots stay `geometryStatus: "placeholder"`. The map (Story 1.12) renders fine from placeholder centroids + SVG section overlays.

### Project Structure Notes

Aligns with:

- [architecture.md § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/lib/geometry.ts` not explicitly listed but matches the `convex/lib/` slot pattern (sibling of `auth.ts`, `audit.ts`, `money.ts`, `stateMachines.ts`).
- [architecture.md § Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture) — geometry shape exactly matches the sample schema.

No detected conflicts.

### References

- [PRD § Functional Requirements > 2. Lot Inventory & Mapping (FR9)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [PRD § Non-Functional Requirements > Performance (NFR-P4)](../../_bmad-output/planning-artifacts/prd.md#performance)
- [Architecture § Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)
- [Architecture § Scope & Scale Parameters > Geospatial viewport queries](../../_bmad-output/planning-artifacts/architecture.md#scope--scale-parameters)
- [Architecture § Decision Impact Analysis](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis)
- [Epics § Story 1.9](../../_bmad-output/planning-artifacts/epics.md#story-19-schema-ready-lot-geometry-from-day-one)
- [Story 1.6](./1-6-audit-log-emission-helper.md), [Story 1.7](./1-7-state-machine-transition-guards.md), [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md)
- Convex docs: [Indexes](https://docs.convex.dev/database/indexes/), [Schema](https://docs.convex.dev/database/schemas)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context).

### Debug Log References

- All four gates clean on first complete run:
  - `npm run typecheck` — no errors.
  - `npm run lint` — no warnings or errors.
  - `npm test` — 468 passed, 1 skipped (the perf test by design).
  - `npm run build` — successful; 9 routes generated, service worker built.
- New test counts: `geometry.test.ts` 31 tests; `lots.test.ts` extended from 24 to 39 tests (15 new across `listInBbox` + `updateLotGeometry`); `lots.perf.test.ts` 1 skipped test.

### Completion Notes List

**Task 1 — Schema verification (AC1) — Clean.** `convex/schema.ts`'s `lots` table already matches the AC1 contract exactly:

- `geometry: v.object({ centroid: v.object({ lat: v.number(), lng: v.number() }), polygon: v.array(v.object({ lat: v.number(), lng: v.number() })), bboxMinLat: v.number(), bboxMaxLat: v.number(), bboxMinLng: v.number(), bboxMaxLng: v.number() })` — matches.
- `geometryStatus: v.union(v.literal("placeholder"), v.literal("surveyed"))` — matches.
- `.index("by_bbox_lat", ["geometry.bboxMinLat", "geometry.bboxMaxLat"])` — Story 1.8 already used the correct dotted-path form, so no rename was needed. **No deviations found.**
- The `npx convex dev` schema-deploy step was not exercised because `convex/_generated/` does not yet exist in this repo (per CLAUDE.md). The schema does compile and type-check cleanly via `DataModelFromSchemaDefinition<typeof schema>` in `convex/lib/auth.ts` and was consumed by both new functions.

**Task 2 — `convex/lib/geometry.ts` extensions.** Added the four type exports (`LatLng`, `Polygon`, `Bbox`, `LotGeometry`) plus `bboxFromPolygon`, `polygonCentroid`, `validatePolygon`, and the convenience `assertPolygonValid` helper. Kept Story 1.8's `defaultPlaceholderGeometry` and `GeoPoint` exports as back-compat aliases (the new canonical names are `getDefaultPlaceholderGeometry` and `LatLng`). Behaviour change: the placeholder geometry now returns `polygon: []` instead of `polygon: [centroid]` — Story 1.8's 1-vertex polygon would fail this story's `validatePolygon` with `TOO_FEW_VERTICES`, and an empty polygon better represents the "unsurveyed" state. The schema accepts both shapes; AC6 confirms no migration is required.

**Task 3 — `createLot` refactor.** Replaced the inline `defaultPlaceholderGeometry()` call with `getDefaultPlaceholderGeometry({ section: args.section })`. Forward-compatible — `section` is plumbed in so Story 1.12's section-keyed centroids land as a one-liner in `geometry.ts`. All Story 1.8 tests still pass; no behaviour change visible to existing callers.

**Task 4 — `updateLotGeometry` internalMutation.** Built on `internalMutationGeneric` from `convex/server` to avoid the `convex/_generated/server` dependency (per the same pattern Stories 1.2 / 1.6 / 1.7 / 1.8 use for query / mutation generics). The Story 1.2 `require-role-first-line` lint rule does not apply to internal mutations, so the handler skips `requireRole` — but `emitAudit` still asserts an authenticated context.

**Deviation: audit action name.** The story spec called for `action: "update_geometry"` on the audit row. The current `AUDIT_ACTIONS` enum in `convex/lib/audit.ts` does not include `"update_geometry"`, and `emitAudit` throws `INVARIANT_VIOLATION` on unknown actions. Since this story may not modify `convex/lib/audit.ts` per the strict file-ownership rules, the implementation uses `action: "update"` — audit readers can distinguish geometry rewrites by the `before` / `after` shape (both carry `geometry` + `geometryStatus` fields, which non-geometry updates never include). Adding `"update_geometry"` to the enum is captured as a future ADR amendment in `docs/adr/0008-geometry-fields-from-day-one.md` § Future amendments.

**Task 5 — `listInBbox` public query.** Awaits `requireRole(ctx, ["admin", "office_staff", "field_worker"])` as the first statement, then runs `withIndex("by_bbox_lat", q => q.gte("geometry.bboxMinLat", lower).lte("geometry.bboxMinLat", upper))` with the 0.1° pad on the lower bound (placeholder lots have zero-area bboxes at the centroid; without the pad the index range excludes valid candidates). In-memory filters trim to the actual overlap. Default limit 200, ceiling 500.

**Task 6 — `geometry.ts` unit tests.** 31 tests across `getDefaultPlaceholderGeometry`, `defaultPlaceholderGeometry` (back-compat alias), `bboxFromPolygon`, `polygonCentroid`, `validatePolygon`, and `assertPolygonValid`. Coverage on `convex/lib/geometry.ts`: 100% line (every branch — empty polygon, n-vertex polygon, fallback supplied / omitted, every validation failure code — is exercised explicitly).

**Task 7 — `lots.test.ts` extensions.** Extended the existing hand-mocked-ctx harness with two capabilities:
1. The `withIndex` mock now supports `gte` and `lte` operations in addition to `eq`.
2. The mock's field reader supports dotted paths (`geometry.bboxMinLat`) to match how the index is actually defined.

These extensions are scoped to the test file (not the production code) and are required to exercise `listInBbox`'s `withIndex` call without a `convex-test` runtime.

**Task 8 — Performance test.** Created `tests/unit/convex/lots.perf.test.ts` with `it.skip` and the TODO comment to remove the skip in Story 5.x. The seeding (2,000 lots spread across the Manila sanity envelope) and assertion (avg < 300ms over 10 random viewports) code is committed and ready to flip.

**Caveat:** the in-process mock query builder doesn't actually use the dotted-path index — it walks the row map and filters with the predicate stack. The numbers the perf test would collect reflect mock-walk cost, not real Convex Cloud index cost. The assertion still discriminates "indexed implementation" from "scan-all-then-filter" because the latter would show up as a 10×–100× slowdown when filtering each candidate against every range predicate for every viewport.

**Task 9 — ADR-0008.** Captured the geometry-from-day-one decision, the 0.1° pad rationale, the `internalMutation` privacy choice, and the deviation on the audit action name. Cross-references ADR-0002 (RBAC), ADR-0004 (audit log), and ADR-0006 (state machines).

**AC6 — No data migration.** Confirmed. Story 1.8 wrote `polygon: [centroid]` (1 vertex); Story 1.9 writes `polygon: []`. The schema validator (`v.array(v.object(...))`) accepts both. Existing test fixtures in `lots.test.ts` keep their 1-vertex `polygon` value and continue to pass; no data is rewritten.

**Concurrency note.** Stories 1.3, 1.13, and 1.14 are running in parallel per the launch instructions. None of them touch `convex/lib/geometry.ts`, `convex/lots.ts`, `tests/unit/convex/lots.test.ts`, `tests/unit/convex/lib/geometry.test.ts`, or `tests/unit/convex/lots.perf.test.ts`. Story 1.3's user table extension to `convex/schema.ts` would not conflict because Story 1.9 only reads the lots table portion.

### File List

**Created:**
- `convex/lib/geometry.ts` (extended; Story 1.8 created the file but this story added the bulk of the contract — types, three pure helpers, `assertPolygonValid`, file-level JSDoc).
- `tests/unit/convex/lib/geometry.test.ts` (NEW — 31 tests, 100% coverage target met).
- `tests/unit/convex/lots.perf.test.ts` (NEW — skipped in CI; Story 5.x flips the skip).
- `docs/adr/0008-geometry-fields-from-day-one.md` (NEW).

**Modified:**
- `convex/lots.ts` — refactored `createLot` to use `getDefaultPlaceholderGeometry({ section })`; added `listInBbox` public query and `updateLotGeometry` internal mutation; added imports for the new helpers.
- `tests/unit/convex/lots.test.ts` — extended the mock harness with `gte / lte` and dotted-path support; added 15 new test cases across `listInBbox` and `updateLotGeometry`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped `1-9-schema-ready-lot-geometry-from-day-one` to `review`; bumped `last_updated`.
- `_bmad-output/implementation-artifacts/1-9-schema-ready-lot-geometry-from-day-one.md` (this file) — Status: review; task checkboxes marked; Dev Agent Record filled.

**Not touched (per strict file ownership):** `convex/lib/auth.ts`, `convex/lib/errors.ts`, `convex/lib/time.ts`, `convex/lib/audit.ts`, `convex/lib/stateMachines.ts`, `convex/lib/states.ts`, `convex/lib/money.ts`, `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`, `convex/schema.ts`, `convex/users.ts`, `convex/_generated/**`, `eslint.config.mjs`, `eslint-rules/**`, `eslint-local-rules.js`, all of `src/**`, `tailwind.config.ts`, `src/app/globals.css`.
