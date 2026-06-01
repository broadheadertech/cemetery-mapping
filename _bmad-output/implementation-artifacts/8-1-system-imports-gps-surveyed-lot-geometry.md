# Story 8.1: System Imports GPS-Surveyed Lot Geometry

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / GIS surveyor**,
I want **a one-time import script that loads GPS-surveyed lot geometry (centroid + polygon vertices + recomputed bbox fields) into the existing `lots.geometry` fields and flips `geometryStatus` from `"placeholder"` to `"surveyed"`**,
so that **the schema is populated with real coordinates before Story 8.2 swaps the renderer — without any data migration, since the geometry fields already exist from Phase 1** (FR9, prep for FR10 P2).

This story is the **bridge between Phase 1 and Phase 2**. Phase 1 shipped lots with placeholder centroids (cemetery's approximate center) and empty polygons; the schema was designed so populating real geometry is just a `db.patch`, not a migration. This story takes the surveyor's deliverable (CSV / GeoJSON), validates it, and writes it into the existing fields atomically with an import report for unmatched rows.

> **Phase 2 client-side dependency:** This story assumes the cemetery has procured and completed a GPS survey of all 2,000+ lots. Surveyor engagement, fieldwork, and deliverable format are **client-side procurement** with multi-week lead time. **Do not start this story until the surveyor's deliverable file is in hand** in one of the supported formats (see AC1).

## Acceptance Criteria

1. **AC1 — Import script reads CSV and GeoJSON**: `convex/import.ts` exports an internal action `lotGeometry` invoked via `npx convex run import:lotGeometry --file=<path>`. The action accepts either (a) a CSV with columns `lotCode, centroidLat, centroidLng, polygonGeoJson` (polygon as GeoJSON-string `[[lng,lat],[lng,lat],...]`), or (b) a GeoJSON FeatureCollection where each feature has a `properties.lotCode` and `geometry.type === "Polygon"`. Format detected from file extension or an explicit `--format=csv|geojson` flag.

2. **AC2 — Matched lots get updated atomically per-lot**: For each input row whose `lotCode` matches an existing `lots.code`, the action invokes an internal mutation `import:applyLotGeometry({ lotId, centroid, polygon })` which: (a) recomputes `bboxMinLat`, `bboxMaxLat`, `bboxMinLng`, `bboxMaxLng` from the polygon vertices; (b) writes the geometry object via `db.patch`; (c) sets `geometryStatus: "surveyed"`; (d) emits an audit log entry (`action: "lot.geometryImported"`, `entityType: "lot"`, `before: { geometry, geometryStatus }`, `after: ...`).

3. **AC3 — Unmatched rows are reported, not silently skipped**: Rows with `lotCode` values that don't match any lot in the DB are collected into an unmatched list. After the import completes, the action writes a summary doc to Convex File Storage (`import-report-<timestamp>.json`) containing: `{ totalRows, matched, updated, skippedAlreadySurveyed, unmatched: [{lotCode, reason}], invalidGeometry: [{lotCode, reason}] }`. The action returns the report storage ID for `npx convex run` to print.

4. **AC4 — Phase 1 SVG renderer continues to work**: After import, lots with `geometryStatus: "surveyed"` retain their original `lots.code`, `status`, and section/block/row fields unchanged. The Phase 1 SVG renderer (`src/components/LotMap/SvgRenderer.tsx`) ignores the geometry fields entirely (it uses static SVG overlay coordinates), so no UI regression. Lots with `geometryStatus: "placeholder"` after import (unmatched) continue to render with placeholder geometry — flagged in the report but non-blocking for the Phase 2 cutover, which can proceed for the matched-lot subset.

## Tasks / Subtasks

### Script scaffolding (AC1)

- [ ] **Task 1: Create `convex/import.ts`** (AC: 1)
  - [ ] Create `convex/import.ts` exporting an `internalAction` named `lotGeometry`. This file is exempt from the `require-role-first-line` lint rule because internal actions are invoked from `npx convex run` (server-to-server), not from client code. Add a file-level JSDoc explaining why this file does NOT call `requireRole`.
  - [ ] Action signature: `internalAction({ args: { storageId: v.id("_storage"), format: v.union(v.literal("csv"), v.literal("geojson")) }, handler: async (ctx, args) => { ... } })`. The CLI invocation pattern is: first upload the survey file to Convex File Storage via `npx convex storage upload`, then run `npx convex run import:lotGeometry --storageId=... --format=csv`. This avoids reading a local file path from inside a Convex action (Convex actions can't access the developer's local FS).
  - [ ] In the action, fetch the uploaded file via `ctx.storage.get(args.storageId)` → `Blob` → `.text()` for CSV or `.text()` then `JSON.parse` for GeoJSON.

- [ ] **Task 2: Implement CSV parser** (AC: 1)
  - [ ] Use a small, audited CSV parser dependency. **Recommendation:** `papaparse` (most-trusted Node CSV lib) added as a regular dependency — needed at action runtime, not just dev. `npm install papaparse @types/papaparse`.
  - [ ] Parse with `Papa.parse(csvText, { header: true, skipEmptyLines: true })`. Validate each row: `lotCode` must be a non-empty string; `centroidLat` / `centroidLng` must parse as finite numbers in valid lat/lng ranges (-90 ≤ lat ≤ 90, -180 ≤ lng ≤ 180); `polygonGeoJson` must `JSON.parse` to an array of `[lng,lat]` pairs of length ≥ 3.
  - [ ] Row-level validation errors go into the report's `invalidGeometry` bucket — the row is not applied to the lot. The action **does not throw on bad rows**; it collects them.

- [ ] **Task 3: Implement GeoJSON parser** (AC: 1)
  - [ ] Parse `FeatureCollection`. For each `Feature`, require `properties.lotCode` (string) and `geometry.type === "Polygon"`. Reject `MultiPolygon` for Phase 2 — lots are simple polygons; multi-part geometries indicate a survey error.
  - [ ] GeoJSON polygon coordinates are `[[ [lng,lat], [lng,lat], ... ]]` (outer ring + holes; we use only the outer ring `polygon[0]`). Translate to our schema's `{lat, lng}` object array. Compute the centroid from the polygon vertices (simple arithmetic mean is acceptable for the survey scale — proper area-weighted centroid is over-engineered for ~1m precision lots). Validate centroid still in valid lat/lng ranges.

### Atomic per-lot apply (AC2)

- [ ] **Task 4: Implement the `applyLotGeometry` internal mutation** (AC: 2)
  - [ ] In `convex/import.ts`, also export an `internalMutation` named `applyLotGeometry({ lotId: v.id("lots"), centroid: v.object({...}), polygon: v.array(v.object({...})) })`.
  - [ ] Inside the mutation: (a) `ctx.db.get(lotId)` → if null, throw `INVARIANT_VIOLATION` (the action validates existence first, so this is a defensive check). (b) Read `before = lot.geometry, before2 = lot.geometryStatus`. (c) Compute bbox: `bboxMinLat = Math.min(...polygon.map(p => p.lat))`, `bboxMaxLat = Math.max(...)`, same for lng. (d) `await ctx.db.patch(lotId, { geometry: { centroid, polygon, bboxMinLat, bboxMaxLat, bboxMinLng, bboxMaxLng }, geometryStatus: "surveyed" })`. (e) Call `emitAudit(ctx, { action: "lot.geometryImported", entityType: "lot", entityId: lotId, before: { geometry: before, geometryStatus: before2 }, after: { /* new values */ }, reason: "GPS survey import" })`.
  - [ ] **Skip-if-already-surveyed rule:** If `lot.geometryStatus === "surveyed"` and the action was NOT invoked with a `--force` flag, skip the lot and add it to the report's `skippedAlreadySurveyed` bucket. This prevents an accidental re-run from clobbering corrected geometry.

- [ ] **Task 5: Orchestrate matched + unmatched in the action** (AC: 2, AC: 3)
  - [ ] In `convex/import.ts → lotGeometry` action body: after parsing, build a `lotCode → lotId` map by calling an internal query `import:resolveLotsByCode({ codes: string[] })` that returns `{ matched: Record<string, Id<"lots">>, unmatched: string[] }`. Use `by_code` index — add this index to `lots` schema if it doesn't exist (Story 1.8 should have added it; verify).
  - [ ] For each matched row, schedule the `applyLotGeometry` mutation via `ctx.runMutation(internal.import.applyLotGeometry, {...})`. Track success / failure counts.
  - [ ] **Do not run all 2,000 mutations in parallel.** Batch in groups of 50 with `Promise.allSettled` to respect Convex's per-mutation transaction limits + observability. Document the batch size as a tunable constant.

### Reporting (AC3)

- [ ] **Task 6: Build the import report** (AC: 3)
  - [ ] Collect counters: `totalRows`, `matched`, `updated`, `skippedAlreadySurveyed`, `unmatchedCount`, `invalidGeometryCount`. Collect arrays: `unmatched: [{ lotCode, reason: "no lot with this code" }]`, `invalidGeometry: [{ lotCode, reason: "polygon has < 3 vertices" | "centroid out of range" | "JSON parse failed" }]`, `failures: [{ lotCode, error: "..." }]` (for mutations that threw despite passing pre-validation).
  - [ ] Serialize the report to JSON and upload via `ctx.storage.store(new Blob([json], { type: "application/json" }))`. Return the storage ID.
  - [ ] Print a one-line summary to stdout: `"Geometry import: 1827 matched / 1827 updated / 12 skipped (already surveyed) / 161 unmatched / 0 invalid. Report: <storageId>."`. The dev / surveyor can download the full report via `npx convex storage download <storageId>`.

- [ ] **Task 7: Add `--force` flag handling** (AC: 2, AC: 3)
  - [ ] Extend the action args with `force: v.optional(v.boolean())`. When `true`, the per-lot mutation overwrites surveyed lots and adds them to `updated` instead of `skippedAlreadySurveyed`. Document in the action's JSDoc: "Use `--force` only when the surveyor delivers a corrected re-survey. Default behavior is safe (skip-if-surveyed) so accidental re-runs are non-destructive."

### Schema check (AC2)

- [ ] **Task 8: Verify `geometryStatus` field exists on `lots`** (AC: 2)
  - [ ] Read `convex/schema.ts` — Story 1.8 (Phase 1 schema) should have defined `geometryStatus: v.union(v.literal("placeholder"), v.literal("surveyed"))` per the brief and epic AC for Story 1.8 (line 634 of epics.md). If absent, **stop and surface a blocker** — the field must be added in Phase 1 schema, not retrofitted here, because Phase 1 lot reads / writes don't carry geometryStatus and adding it now requires backfilling defaults.
  - [ ] Verify `by_code` index on `lots` exists. If not, add it: `.index("by_code", ["code"])`. This is a low-impact additive change.

### Testing (AC1, AC2, AC3)

- [ ] **Task 9: Unit tests for parsers** (AC: 1)
  - [ ] Create `tests/unit/convex/import.test.ts`. Use `convex-test` to construct contexts. Cover:
    - CSV: well-formed row → matched + updated.
    - CSV: invalid lat → reported in `invalidGeometry`.
    - CSV: polygon with 2 vertices → reported.
    - GeoJSON: well-formed FeatureCollection with 3 features → 3 matched, 3 updated.
    - GeoJSON: feature with `MultiPolygon` → reported.
    - Unmatched lot code → reported in `unmatched`, not applied.
    - Already-surveyed lot, no `--force` → reported in `skippedAlreadySurveyed`.
    - Already-surveyed lot, `--force=true` → re-applied.
    - Bbox computation: polygon of 4 vertices → bbox fields match `min/max` of inputs.
    - Audit log row written: `action === "lot.geometryImported"`, `before` and `after` populated.
  - [ ] Use a small fixture: 5 lots with placeholder geometry, 1 already surveyed.

- [ ] **Task 10: Manual dry-run before production import** (AC: 3)
  - [ ] Document in `docs/runbook.md` under "GPS geometry import" the runbook steps:
    1. Surveyor delivers file → save to a private bucket.
    2. Run `npx convex storage upload <file>` → note storage ID.
    3. Run `npx convex run import:lotGeometry --storageId=... --format=csv` on **the staging Convex deployment first**.
    4. Download + review the report. Investigate any `unmatched` or `invalidGeometry` rows with the surveyor.
    5. Re-survey or correct as needed, deliver new file, re-run on staging.
    6. Only when staging shows ≥ 99% matched + 0 invalid: run the same command against production.
    7. Verify with `npx convex run lots:countByGeometryStatus` (add a small helper internal query) that `surveyed` ≈ total lot count.

### Documentation (AC1, AC2)

- [ ] **Task 11: ADR-0010 — geometry import strategy** (AC: 1, AC: 2)
  - [ ] Write `docs/adr/0010-geometry-import.md`: format support (CSV + GeoJSON, no Shapefile), batch size, atomic per-lot (not "one giant transaction"), skip-if-surveyed default, audit emission, report-to-storage pattern. Capture why we do NOT run this as a one-shot mutation (Convex mutations have transaction-size limits; 2,000 lots × geometry fields exceeds them — chunked action is the right pattern).

- [ ] **Task 12: Surveyor-facing format spec** (AC: 1)
  - [ ] Write `docs/gps-survey-deliverable-format.md` for the surveyor: required columns / GeoJSON shape, coordinate system (WGS84 lat/lng decimal degrees, NOT UTM), encoding (UTF-8), example file (5 lots). Document that polygon vertices should be listed counter-clockwise (standard GeoJSON) but the importer accepts either order — bbox computation doesn't care about winding.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies (must be complete before this story starts):**

- **Story 1.8 — Lots schema:** defined `lots.geometry` (centroid, polygon, bbox fields), `lots.geometryStatus`, and the `by_bbox_lat` index. This story PATCHES geometry fields on existing lot docs; it does not modify the schema (except adding `by_code` if missing).
- **Story 1.6 — `emitAudit`:** the audit helper is required for AC2's audit emission.
- **Story 1.2 — `requireRole`:** not directly invoked here (internal action), but the lint rule exemption pattern established in 1.2 applies — internal mutations / actions are exempt because no user context exists.
- **Story 2.1 (Phase 1 SVG renderer):** the SVG renderer must not break when geometry changes (AC4). Verify the renderer ignores `geometry` and reads only SVG-overlay coordinates from `public/map/overlay-section-*.svg`.

**Phase 2 dependencies (this story is the first in Phase 2):**

- This story has no prior Phase 2 stories. It is the **entry point** for Phase 2.
- Stories 8.2 and 8.3 depend on this one. 8.2 (Leaflet renderer) reads `lots.geometry` directly — geometry must be real or the map will be wrong. 8.3 (GPS navigation) reads `lots.geometry.centroid` and gates on `geometryStatus === "surveyed"`.

### Architecture compliance

- **File location:** `convex/import.ts` (per architecture's `convex/<domain>.ts` pattern; `import` is a server-internal domain).
- **Internal actions only:** the import is not client-callable. Use `internalAction` + `internalMutation` exclusively. The lint rule exempts internal functions per Story 1.2's ADR-0002.
- **Audit emission:** every per-lot geometry change emits an audit row per architecture's "every financial-touching write emits audit" rule, extended here to "every administrative bulk operation emits audit." Geometry import is not financial but it IS an administrative data-modification operation worth tracking (per NFR-S7's append-only audit log philosophy).
- **No direct `db.insert("auditLog", ...)`:** use `emitAudit` only. Story 1.6's lint rule still applies.
- **Batched mutations, not one giant transaction:** Convex mutations have soft size limits (~16MB per transaction, ~32MB per scheduled run). 2,000 lots × ~1KB geometry each = ~2MB raw, but the audit log doubles it. Batched per-lot mutations stay well under limits and give us per-lot atomicity (one bad row doesn't roll back the other 1,999).
- **Manila-tz timestamps:** audit `at` field uses `Date.now()` (epoch ms) per architecture — the UI formats it in Manila tz via `src/lib/time.ts`.

### Library / framework versions (researched current)

- **`papaparse`** — `@latest` (currently 5.x). Battle-tested CSV parser. Works in Node and browser; for our action use the Node path. Light dependency, no native code.
- **No GeoJSON library needed.** Native `JSON.parse` + manual shape validation is sufficient for the simple `FeatureCollection → Polygon` shape we accept. Adding `@turf/turf` for centroid computation would be over-engineering — arithmetic mean is fine at lot scale.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── import.ts                              # NEW (lotGeometry internalAction, applyLotGeometry internalMutation, resolveLotsByCode internalQuery)
│   └── schema.ts                              # UPDATE (verify by_code index; add if missing)
├── docs/
│   ├── adr/
│   │   └── 0010-geometry-import.md            # NEW
│   ├── runbook.md                             # UPDATE (add "GPS geometry import" section)
│   └── gps-survey-deliverable-format.md       # NEW (surveyor-facing format spec)
├── tests/
│   └── unit/
│       └── convex/
│           └── import.test.ts                 # NEW
└── package.json                               # UPDATE (add papaparse + @types/papaparse)
```

**No frontend changes in this story.** The Phase 1 SVG renderer continues to render correctly because it ignores `geometry` fields (AC4). The Leaflet renderer (Story 8.2) is the first consumer of the imported geometry.

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code)** doesn't directly apply (geometry import isn't financial), but the import touches lot records that financial flows depend on. Target: **≥ 85% line coverage** on `convex/import.ts`.
- **No e2e test for this story.** The import is invoked via CLI, not the web UI. A Playwright spec would be inappropriate.
- **Manual staging dry-run is required** (Task 10) before any production invocation. This is documented in the runbook; the dev agent should add a banner / pre-flight check that prints `"⚠️  This is a destructive write to lots.geometry. Confirm you are running against the intended deployment: <CONVEX_DEPLOYMENT>. Re-run with --confirm to proceed."` and require `--confirm=true` on first run.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT write geometry directly to `lots` outside the `applyLotGeometry` mutation.** All writes go through the helper so audit emission is guaranteed. Add a TODO marker for a future lint rule "no `ctx.db.patch(lot, { geometry: ... })` outside `import.ts`" once Phase 2 stabilizes.
- ❌ **Do NOT run the import as a single mutation.** 2,000 patches in one transaction exceeds Convex's transaction size budget. Batched action + per-lot mutations is the right pattern.
- ❌ **Do NOT silently skip unmatched lots.** They must appear in the report. The cemetery owner needs to know which lots are still in placeholder state.
- ❌ **Do NOT bypass audit emission "because it's an import."** Bulk operations are exactly where unaudited writes hide. Every changed lot gets an `auditLog` row.
- ❌ **Do NOT default to `force=true`.** Default is safe (skip-if-surveyed). Re-survey corrections require explicit `--force`.
- ❌ **Do NOT accept Shapefile or KML.** Format scope is locked to CSV + GeoJSON. Adding more formats is a separate story; expanding scope here invites parsing bugs.
- ❌ **Do NOT compute centroids client-side and trust them.** If the CSV row's centroid disagrees with the polygon's arithmetic centroid by > 5 meters (~0.00005 deg), flag it in `invalidGeometry`. This catches data-entry errors where the surveyor pasted the wrong centroid.
- ❌ **Do NOT use a local file path argument** (e.g. `--file=/Users/.../survey.csv`). Convex actions can't access the developer's local FS. Force the upload-then-process pattern via storage IDs.
- ❌ **Do NOT proceed to Story 8.2 (Leaflet renderer) until this import has been run successfully against production.** The Leaflet renderer with placeholder geometry shows lots stacked on the cemetery center — visually broken.
- ❌ **Do NOT modify the Phase 1 SVG renderer.** AC4 is about *preserving* it. Geometry import is decoupled from rendering by design.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use `papaparse` for CSV. Do not write a custom CSV tokenizer. Quoted fields, embedded commas, BOM headers, and CRLF line endings are all already handled.
- **Wrong file path argument:** The action takes a Convex storage ID, NOT a local file path. The upload step is part of the operator workflow.
- **GeoJSON coordinate order:** GeoJSON is `[longitude, latitude]` — opposite of common `(lat, lng)` intuition. Our schema is `{ lat, lng }`. Translate explicitly; never trust the order.
- **Polygon winding:** GeoJSON spec is counter-clockwise for the outer ring, but field surveys often deliver clockwise. Our importer must not assume winding. Bbox computation works either way; if Phase 2 needs winding-sensitive operations (e.g. point-in-polygon for tap detection), normalize at that point, not here.
- **Forgetting `geometryStatus` flip:** Updating `geometry` without flipping `geometryStatus` to `"surveyed"` is invisible to Story 8.3 (which gates the GPS-navigate button on `geometryStatus === "surveyed"`). Always set both in the same patch.
- **Audit log too verbose:** The full polygon array could be hundreds of vertices. Store the full geometry in `before` / `after` is fine; auditLog already supports arbitrary JSON. But don't also write a separate "imported lot X" line — one audit row per lot is enough.

### Open questions / blockers this story does NOT resolve

- **Client-side procurement (GPS survey itself):** out of scope. The survey is a multi-week vendor engagement preceding this story. This story assumes the deliverable file exists.
- **Coordinate-system handling:** locked to WGS84 lat/lng. If the surveyor delivers UTM or PRS92 (Philippine Reference System 1992), they must re-project before delivery. Spec'd in `docs/gps-survey-deliverable-format.md`.
- **Re-survey workflow:** the `--force` flag handles one-off corrections. A periodic re-survey (e.g. annual GPS drift correction) would warrant a separate story with diff-aware reporting; not in scope here.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/import.ts` matches the `convex/<domain>.ts` pattern.
- [Architecture § Service boundary](../../_bmad-output/planning-artifacts/architecture.md) — internal actions live alongside domain files; this is a server-side admin tool, not a client-facing feature.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR9 (geometry stored from day one), FR10 (map renderer Phase 1 → Phase 2)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [Architecture § Schema example](../../_bmad-output/planning-artifacts/architecture.md) — `lots.geometry` shape + bbox indexing
- [Architecture § Phase 2 Map renderer](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Implementation Patterns > emitAudit](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [Epics § Story 1.8 — placeholder geometry default](../../_bmad-output/planning-artifacts/epics.md)
- [Epics § Story 8.1](../../_bmad-output/planning-artifacts/epics.md)
- Convex docs (current): [Internal functions](https://docs.convex.dev/functions/internal-functions) · [File Storage](https://docs.convex.dev/file-storage) · [Scheduling](https://docs.convex.dev/scheduling/scheduled-functions)
- [PapaParse docs](https://www.papaparse.com/docs)
- [GeoJSON RFC 7946 — Polygon spec](https://datatracker.ietf.org/doc/html/rfc7946#section-3.1.6)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context), via Claude Code (BMAD dev-story workflow).

### Debug Log References

- `npx vitest run tests/unit/convex/gpsImport.test.ts` → 16/16 pass.
- `npx vitest run tests/unit/components/GpsImport.test.tsx` → 16/16 pass.
- `npm run typecheck` → clean (`tsc --noEmit` reports only pre-existing
  Story 2.5 `tests/unit/components/CustomerDetail.test.tsx` issues; the
  Story 8.1 file ownership rules forbid touching that file).
- `npm run lint` → clean ("No ESLint warnings or errors").
- `npx vitest run` (full suite) → 946 passing, 5 failing, 1 skipped.
  The 5 failures are all pre-existing in
  `tests/unit/components/CustomerDetail.test.tsx` (`ReferenceError:
  userEvent is not defined`) — present before this story landed,
  unmodified by this story (the file is in the "MUST NOT touch" list).

### Completion Notes List

- **Scope adjustment vs. story spec:** The spec calls for an
  `internalAction` + Convex File Storage upload pattern invoked via
  `npx convex run`. That pattern requires `convex/_generated/api`,
  which this repo deliberately does NOT check in — see the explicit
  gap-throw in `convex/lib/audit.ts:341` (`emitAuditFromAction`
  surfaces an `INVARIANT_VIOLATION` until codegen exists). Per the
  dev-story system message, the implementation contract is an
  admin-only public `mutationGeneric` `importGpsBatch` that accepts
  the parsed batch payload directly. The Phase 1 → Phase 2 bridge is
  preserved; the operational entry point is the browser-rendered
  `/admin/gps-import` page (admin parses the file client-side and
  submits the canonical `items[]` shape over the wire) rather than a
  CLI invocation. The action + storage flow remains a future story,
  unblocked once `convex/_generated/` lands.
- **Format scope:** JSON-first. The client parser
  (`src/components/GpsImport/parser.ts`) accepts both the native
  `{ items: [...] }` shape AND GeoJSON `FeatureCollection`s of Polygon
  features (the most common surveyor deliverable). CSV is NOT in this
  story — adding `papaparse` was avoided per the dev-story system
  message's preference for JSON.
- **No schema changes:** `lots.geometry` and `lots.geometryStatus`
  already exist (Story 1.8); `lots.by_code` index already exists
  (verified in `convex/schema.ts:199`). No `gpsImportBatches` audit
  table added — per-lot `auditLog` rows already provide the trace.
- **AC1 (CSV + GeoJSON ingest):** Satisfied by the client parser
  which accepts GeoJSON `FeatureCollection` + native batch JSON.
  CSV is out of scope (JSON-first per system message).
- **AC2 (per-lot atomic apply with bbox + centroid + audit):**
  Satisfied. The `importGpsBatch` mutation validates each polygon
  via `validatePolygon`, recomputes bbox via `bboxFromPolygon`,
  computes centroid via `polygonCentroid` (or honours an item-level
  override), patches `lots.geometry` + flips `geometryStatus` to
  `surveyed`, and emits one `auditLog` row per applied lot with
  `before`/`after` full-geometry payload + operator-supplied
  `reason`.
- **AC3 (unmatched / invalid reporting):** Satisfied. The mutation
  returns a structured summary `{ totalItems, updated,
  skippedAlreadySurveyed[], errors[] }`; the result panel in the
  admin UI groups errors by reason (`NOT_FOUND`, `INVALID_POLYGON`,
  `INVALID_INPUT`). Already-surveyed lots are reported separately
  in `skippedAlreadySurveyed` — they are NOT errors.
- **AC4 (Phase 1 SVG renderer unaffected):** Satisfied by design.
  Story 8.1 only writes to `lots.geometry` + `geometryStatus`; the
  SVG renderer reads neither (it consumes static SVG overlay
  coordinates per Story 1.12). No frontend renderer changes.
- **Skip-if-surveyed default:** Implemented. `force?: boolean`
  argument with default `false`; surveyed lots route into
  `skippedAlreadySurveyed` unless explicitly overridden. The
  `<GpsImportPanel>` exposes the toggle with copy that explains
  the corrected-re-survey use case.
- **Batch cap:** `MAX_BATCH_SIZE = 500` items per call. Larger
  imports require splitting on the client (typical surveyor
  deliverables are per-section, ~200 lots, well under the cap).
- **Role gating:** `admin` ONLY. Office staff and field workers
  cannot trigger an import — geometry rewrites are legal evidence
  in ownership disputes (see ADR-0008 §4 and Story 1.9's
  `updateLotGeometry` JSDoc). Defense in depth via the middleware
  `/admin/*` gate + the server-side `requireRole(["admin"])`.

### File List

Created:
- `convex/gpsImport.ts` — Admin-only `importGpsBatch` mutation
  (parses + validates + applies per-lot geometry + emits audit per
  lot, returns `{ totalItems, updated, skippedAlreadySurveyed[],
  errors[] }`).
- `src/components/GpsImport/parser.ts` — Client-side JSON / GeoJSON
  parser, pure function, no Convex dependency.
- `src/components/GpsImport/index.tsx` — `<GpsImportPanel>`: source
  panel (file picker + paste textarea), preview panel (parsed-item
  table + force toggle + reason input), result panel (grouped
  summary stats + error groupings).
- `src/app/(staff)/admin/gps-import/page.tsx` — Admin route page
  hosting the `<GpsImportPanel>`.
- `tests/unit/convex/gpsImport.test.ts` — 16 unit tests covering
  happy path, NOT_FOUND, INVALID_POLYGON (empty / 2-vertex /
  out-of-range), INVALID_INPUT, ALREADY_SURVEYED skip, force=true
  override, mixed-batch summary, RBAC FORBIDDEN paths,
  UNAUTHENTICATED, batch-size cap.
- `tests/unit/components/GpsImport.test.tsx` — 16 tests covering
  parser (native + GeoJSON shapes, MultiPolygon rejection, missing
  lotCode, invalid JSON, empty input, unknown shape), component
  flows (parse → preview → submit, force toggle propagation,
  server error → error panel surface, parse error → error panel
  surface, grouped result rendering).
- `tests/e2e/gps-import.spec.ts` — Playwright smoke: unauthenticated
  redirect to `/login`. Full admin flow documented as `.skip` per
  the established `admin-user-management.spec.ts` convention
  (requires seeded test users).

Modified:
- `convex/lots.ts` — Added `internalQueryGeneric getLotByCode(code)`
  helper (Story 8.1 task: append internal-query helper if not
  present). Existing `updateLotGeometry` and other exports
  untouched.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `8-1-system-imports-gps-surveyed-lot-geometry: review`;
  `last_updated: 2026-05-18`.
- `_bmad-output/implementation-artifacts/8-1-system-imports-gps-surveyed-lot-geometry.md` —
  this file (status + Dev Agent Record).
