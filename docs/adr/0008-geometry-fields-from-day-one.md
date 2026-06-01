# ADR 0008: Lot Geometry Fields From Day One

- **Status:** Accepted
- **Date:** 2026-05-19
- **Story:** 1.9
- **Supersedes:** Story 1.8's inline placeholder constant inside `convex/lots.ts`

## Context

The Cemetery Management System ships Phase 1 with a static SVG map renderer and Phase 2 with a Leaflet renderer driven by real GPS-surveyed polygons (Epic 8). Two architectural commitments shape this ADR:

- **FR9** requires lot geometry — centroid + polygon + bounding box — to be present on every lot row from day one, even before survey data exists.
- **NFR-P4** caps Convex viewport queries at p95 < 300ms on the 2,000-lot production inventory.

Story 1.8 created the `lots` table with the geometry slot already validated by the schema, plus a `by_bbox_lat` index on `(geometry.bboxMinLat, geometry.bboxMaxLat)`. However, Story 1.8 inlined the placeholder centroid `{ lat: 14.6760, lng: 121.0437 }` directly inside `convex/lots.ts → createLot`, and never exercised the `by_bbox_lat` index with a real viewport query. Story 1.9 hardens that scaffolding:

1. Move the placeholder centroid into a dedicated helper module so changing the cemetery's reference coordinate is a one-line edit in one file.
2. Add `bboxFromPolygon` / `polygonCentroid` / `validatePolygon` helpers for the GPS import flow (Epic 5+) to consume.
3. Add an `updateLotGeometry` internal mutation that the GPS import will call.
4. Add a public `listInBbox` viewport query that Story 1.12's SVG map and the future Leaflet map both call via `useLotsInViewport`, and that verifies the `by_bbox_lat` index works.

Several alternatives were considered:

1. **Defer geometry until Phase 2.** Rejected — the schema lock-in cost is highest after data exists. Adding nullable fields and back-filling 2,000 rows is a real migration, not a schema swap.
2. **Use PostGIS + Postgres for the lot table specifically.** Rejected — architecture's stack lock forbids a separate DB. Convex's `v.object` validator + scalar bbox fields + dotted-path index is sufficient for 2,000 lots at Phase 1.
3. **Ship `turf` / `proj4` for projection-aware math.** Rejected — Manila is far from the poles and the antimeridian; `Math.min/max` over `lat` / `lng` is correct. The dependency cost (bundle weight + supply-chain surface) is non-trivial for foundation code.
4. **Compute centroid from bbox center.** Rejected — for non-rectangular polygons the bbox centre is not the geometric centroid. Vertex-average centroid is within centimetre for rectangular cemetery lots and is the algorithm `polygonCentroid` implements.

## Decision

### 1. Geometry shape (frozen)

Every `lots` row carries:

```ts
geometry: {
  centroid: { lat: number, lng: number },
  polygon: Array<{ lat: number, lng: number }>,  // empty when unsurveyed
  bboxMinLat: number,
  bboxMaxLat: number,
  bboxMinLng: number,
  bboxMaxLng: number,
},
geometryStatus: "placeholder" | "surveyed",
```

The four bbox scalars live flat on the `geometry` object (not nested) so they can be reached by the `by_bbox_lat` index via the dotted-path notation `"geometry.bboxMinLat"`. Convex indexes support dotted paths; nesting under a `bbox` sub-object would not be indexable.

### 2. Placeholder helper lives in `convex/lib/geometry.ts`

`getDefaultPlaceholderGeometry({ section? })` returns the cemetery centroid + an empty polygon + a zero-area bbox at the centroid. The `section` argument is accepted for forward compatibility — Story 1.12 will wire section-specific centroids via SVG overlay metadata; until then every section maps to the default.

The legacy alias `defaultPlaceholderGeometry()` (no opts, Story 1.8's name) is preserved as a thin delegating wrapper to keep old call sites compilable through future refactors.

### 3. `bboxFromPolygon` + `polygonCentroid` + `validatePolygon`

The three pure helpers cover the GPS-import flow's needs:

- `bboxFromPolygon(polygon, fallback?)` — `Math.min/max` across vertices; empty polygon collapses to a zero-area bbox at the fallback (or the cemetery placeholder centroid).
- `polygonCentroid(polygon, fallback?)` — vertex-average. JSDoc explicitly warns that this is NOT the geometric centroid; for irregular Phase 2 polygons a future story will add `polygonGeometricCentroid` as a sibling rather than mutating this one's behaviour.
- `validatePolygon(polygon)` — empty OR ≥ 3 vertices, no consecutive duplicates, every coord finite + within the Manila sanity range (lat 14.4–14.8, lng 120.9–121.1). Returns a discriminated result; the convenience wrapper `assertPolygonValid` routes failures through `throwError(ErrorCode.INVARIANT_VIOLATION, ...)` for callers that prefer the throw style.

The Manila sanity range is NOT the cemetery footprint — it is a loose envelope designed to catch degrees-vs-decimal-degrees data-entry mistakes. A future story can tighten this once the cemetery's actual GeoJSON outline is known.

### 4. `updateLotGeometry` is `internalMutationGeneric`

GPS-import flows are server-to-server (Epic 5+ migration scripts), not user-callable. Exposing this as a public mutation without explicit `requireRole(["admin"])` gating would let any signed-in user rewrite a lot's polygon — and lot boundaries are legal evidence in ownership disputes.

A future "field worker re-surveyed this lot from their phone" capability is a NEW public mutation: admin-only, captures a `reason`, possibly routes through a `geometryStatus: placeholder → surveyed` state machine entry. All out of scope for Story 1.9.

The mutation:
1. Calls `assertPolygonValid` to enforce the polygon contract.
2. Loads the existing lot (throws `NOT_FOUND` if missing).
3. Computes the new bbox from the polygon. Uses the caller-supplied centroid when provided; otherwise vertex-averages.
4. Patches `geometry` + `geometryStatus` in one mutation.
5. Emits an audit with action `"update"` and a before / after payload carrying the full geometry + status. Audit readers distinguish geometry rewrites from other lot updates by the presence of a `geometry` field in `before` / `after`.

A future ADR amendment can add `"update_geometry"` to the `AuditAction` enum in `convex/lib/audit.ts`; until then `"update"` is the closest enum member.

### 5. `listInBbox` public query and the 0.1° index pad

The query is a `queryGeneric` exposed under `api.lots.listInBbox`. Roles: `admin | office_staff | field_worker`. The handler:

1. Calls `requireRole` as its first awaited statement.
2. Reads candidates via `withIndex("by_bbox_lat", q => q.gte("geometry.bboxMinLat", lower).lte("geometry.bboxMinLat", upper))`.
3. Filters retired lots, `bboxMaxLat` overlap, `bboxMinLng / bboxMaxLng` overlap, and the optional `statusFilter` in memory.
4. Caps the result at `limit` (default 200, ceiling 500).

The index range uses a **0.1° pad on the lower bound** because placeholder-geometry lots have zero-area bboxes (`bboxMin == bboxMax == centroid`). Without the pad, a viewport that does NOT contain any lot's `bboxMinLat` would return zero candidates even when many lots overlap it. The pad covers the largest plausible cemetery section (~10 km, ~0.09° at Manila latitude) plus margin. Once GPS data lands (Story 8.1+), polygons get real intervals and the pad can shrink.

The query returns whole `Doc<"lots">` documents (not a projection). At 200 lots × ~1 KB each = ~200 KB on the wire, this is acceptable for Phase 1. A future `listInBboxMinimal` companion query can project just the four map-rendering fields if bundle pressure becomes a concern.

### 6. No data migration

Story 1.8 created lots with the (correct) placeholder geometry constant. The schema validator already matches Story 1.9's contract. The only stored-value difference is that Story 1.8's `createLot` wrote `polygon: [centroid]` (1 vertex) while Story 1.9 writes `polygon: []`. The schema accepts both; no migration is required. Going forward, new placeholder lots get the empty-polygon shape; existing lots stay as they are until a future GPS import overwrites them.

## Consequences

- **Positive:** The Phase 2 Leaflet swap (Story 8.2) is a rendering change. Data layout, indexes, and the read query are already production-ready.
- **Positive:** GPS import in Epic 5+ wires up to a known internal mutation. Survey corrections leave an audit trail without per-script audit-emission boilerplate.
- **Positive:** Geometry rewrites are bottlenecked through a single mutation; the audit-log invariants in Story 5.5 will catch any out-of-band `ctx.db.patch(lotId, { geometry: ... })` if it ever appears.
- **Positive:** The `listInBbox` query is the canonical answer to "which lots are in this viewport". Story 1.12's map, Story 1.13's offline cache, and any future analytics view all consume one query.
- **Negative:** The `by_bbox_lat` index covers only latitude; longitude is filtered in memory. For 2,000 lots this is well under the NFR-P4 budget. For 50,000-lot scale (out of current scope), a `by_section` index combined with a section-keyed viewport scope would be the path forward.
- **Negative:** The 0.1° pad on the index lower bound is a heuristic, not a proof. It works for placeholder-bbox lots because Manila cemetery sections are ≪ 10 km; if a future cemetery profile has sections spanning > 10 km the pad will need to be re-tuned.
- **Negative:** `polygonCentroid` is vertex-average, not geometric. For Phase 2's curved cemetery sections the visual placement may be slightly off; the JSDoc documents the limitation and a sibling `polygonGeometricCentroid` is the migration path.
- **Negative:** The `AuditAction` enum does not yet carry `"update_geometry"`. Audit readers distinguish geometry rewrites by inspecting the `before` / `after` payload shape; a future ADR amendment will add the dedicated action.

## Implementation plan

| Story | Deliverable |
|-------|-------------|
| 1.9 (this) | `convex/lib/geometry.ts` extensions (`getDefaultPlaceholderGeometry`, `bboxFromPolygon`, `polygonCentroid`, `validatePolygon`, types). `convex/lots.ts` refactor (`createLot` uses the helper) + new `listInBbox` query + new `updateLotGeometry` internal mutation. 100% test coverage on `geometry.ts`. ADR. |
| 1.10 | Search palette consumes `listLots`; no direct geometry coupling but search-result preview cards may render a marker icon based on `geometryStatus`. |
| 1.11 | Lot detail page renders the `geometryStatus` pill. |
| 1.12 | SVG map renderer + `useLotsInViewport` hook that calls `api.lots.listInBbox`. Adds `src/lib/geometry.ts` client mirror with bbox-intersection / viewport math. |
| 1.13 | Offline cache layer caches `listInBbox` responses with a 24h TTL keyed by bbox. |
| 5.x | Perf-test runner setup; flip `tests/unit/convex/lots.perf.test.ts → it.skip` to `it`. |
| 8.1 | GPS-surveyed lot geometry import — first real consumer of `updateLotGeometry`. |
| 8.2 | Leaflet renderer reads `geometryStatus === "surveyed"` to decide polygon vs marker fallback. |

## Future amendments

Adding fields to `geometry` (e.g. `elevationM` for 3D Phase 2 visualizations) is an ADR amendment, not a drive-by edit. Adding a new bounding-box index (e.g. `by_bbox_lng` if section-scoped queries need it) is similarly an ADR amendment — the query layer needs to know which index to call.

Adding `"update_geometry"` to the `AuditAction` enum is a separate ADR amendment that touches `convex/lib/audit.ts` and the audit log readers (Story 6.5).

## References

- [PRD § Functional Requirements > 2. Lot Inventory & Mapping (FR9)](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Non-Functional Requirements > Performance (NFR-P4)](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Data Architecture](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § Scope & Scale Parameters > Geospatial viewport queries](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § Decision Impact Analysis](../../_bmad-output/planning-artifacts/architecture.md)
- [Story 1.6 audit-log helper](../../_bmad-output/implementation-artifacts/1-6-audit-log-emission-helper.md)
- [Story 1.7 state machines](../../_bmad-output/implementation-artifacts/1-7-state-machine-transition-guards.md)
- [Story 1.8 lot CRUD](../../_bmad-output/implementation-artifacts/1-8-office-staff-creates-and-edits-lot-records.md)
- [ADR-0002 RBAC pattern](./0002-rbac-pattern.md)
- [ADR-0004 audit-log pattern](./0004-audit-log-pattern.md)
- [ADR-0006 state machines](./0006-state-machine-transitions.md)
- Convex docs: [Indexes](https://docs.convex.dev/database/indexes/), [Schema validators](https://docs.convex.dev/database/schemas)
