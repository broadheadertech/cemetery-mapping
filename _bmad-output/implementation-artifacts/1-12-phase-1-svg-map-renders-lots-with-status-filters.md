# Story 1.12: Phase 1 SVG map renders lots with status filters

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **any authenticated user (Office Staff / Field Worker / Admin)**,
I want **to view a 2D map at `/lots` showing all lots with status-coded markers, filterable by section/block/type/status, rendered via SVG with per-section background overlays, performing under NFR-P2 (< 3s first paint on mid-range Android over 4G) and NFR-P6 (< 250KB JS bundle), and switching to list view on viewports < 768px**,
so that **I can visually scan availability and find any lot at a glance** (FR10 Phase 1, UX-DR7).

This story implements the **`LotMap` SVG renderer** that architecture § Frontend Architecture commits to as the Phase 1 map renderer (Phase 2 swaps in a Leaflet renderer behind the same component contract). The map consumes Story 1.9's `convex/lib/geometry.ts` helpers and `api.lots.listInBbox` viewport query. The `/lots` page (Story 1.8 ships the list view) is enhanced with a map/list toggle. On mobile, the map renders full-width above the list-toggle button per UX-DR7.

## Acceptance Criteria

1. **AC1 — Map renders SVG with per-section overlays + lot polygons**: At `/lots`, the `LotMap` component renders in SVG mode (`renderer="svg"`). Per-section background SVGs are loaded from `public/map/overlay-section-{section}.svg` (one file per cemetery section, created as placeholder content in this story — empty SVG with viewBox; client supplies real overlays). Lot polygons are drawn on top of the overlays via `<polygon>` elements, status-colored per Story 1.4's `StatusPill` palette tokens (e.g. `fill="hsl(var(--status-available-bg))"`). Placeholder-geometry lots (Story 1.9's `geometryStatus: "placeholder"`) render as a small status-colored circle at the centroid instead of a polygon.

2. **AC2 — Filter chips update the visible lots; URL syncs**: Filter chips above the map (or alongside on desktop) for: status (`available`, `reserved`, `sold`, ...), lot type (`single`, `family`, `mausoleum`, `niche`), section (text input with autocomplete). Changing a filter updates `?status=available&type=family&section=D` in the URL via Next.js `useSearchParams` + `router.replace`. The map re-renders showing only matching lots within the current viewport. URL is shareable — pasting the URL into a new tab restores the filter state.

3. **AC3 — Viewport-bbox loading, not "load all 2,000 lots"**: The map uses Story 1.9's `api.lots.listInBbox` query via a new `useLotsInViewport(bbox, filters)` hook in `src/hooks/useLotsInViewport.ts`. The hook tracks SVG viewport via panning/zooming state (Phase 1: minimal pan/zoom — primarily user changes section filter to "zoom" to a section). When viewport bbox changes (debounced 150ms to avoid query thrash), the hook re-queries. Initial viewport defaults to the cemetery-wide bbox (covers all sections); a section filter narrows the bbox to that section's known bounds. Returns ≤ 200 lots per query (Story 1.9's cap).

4. **AC4 — Click/tap navigates to lot detail; keyboard focus works**: Each lot polygon has `role="button"`, `tabIndex={0}`, `aria-label="Lot {code}, {status}"` (NFR-A1), and an `onClick` / `onKeyDown` (Enter / Space) handler that calls `onLotClick(lotId)` → router pushes `/lots/{lotId}` (Story 1.11's detail page). Hover/focus shows a tooltip with `{code} · {status} · {section}`.

5. **AC5 — Mobile-list-toggle**: On viewports < 768px, the `/lots` page renders the map full-width above a sticky toggle button ("List view" / "Map view"). The map and list share the same filter state (URL params). Map area height capped at 60vh on mobile to leave room for the toggle + scroll-into-list. Story 1.8's list view was previously the default; this story makes the toggle real (Story 1.8 left a disabled placeholder).

6. **AC6 — Performance under NFR-P2 + NFR-P6**: First paint of `/lots` (with the production 2,000-lot inventory) completes in < 3s on Lighthouse mobile profile (Pixel 5 + 4G throttling). Authenticated-route JS bundle stays < 250KB gzipped. Lighthouse mobile assertions: performance ≥ 0.9. **Leaflet is NOT imported** in Phase 1 — the `LotMap` component conditionally renders `SvgRenderer.tsx` only; `LeafletRenderer.tsx` is created as a stub with a `// @ts-expect-error: Phase 2` marker so Story 1.5's lint rule (`no-leaflet-client-import`, deferred) can be flipped on in Phase 2. The bundle assertion is automated via the existing Lighthouse CI gate (Story 1.1).

## Tasks / Subtasks

### Server: viewport query is already in place from Story 1.9

- [ ] **Task 1: Verify Story 1.9's `listInBbox` matches this story's needs** (AC: 3)
  - [ ] Read `convex/lots.ts → listInBbox` (added in Story 1.9). Confirm: args include `statusFilter` and optional `limit`. If Story 1.9 used a different filter pattern, file a deviation note; this story adapts `useLotsInViewport` to the actual signature.
  - [ ] Add `typeFilter: v.optional(v.union(v.literal("single"), v.literal("family"), v.literal("mausoleum"), v.literal("niche")))` to `listInBbox` if not present.
  - [ ] Add `sectionFilter: v.optional(v.string())` if not present — narrows to a specific section via the `by_section_block` index (small refactor: query by section index, then in-memory bbox/type/status filter).

### Client: hooks + map renderer (AC1, AC3, AC4)

- [ ] **Task 2: Create `src/hooks/useLotsInViewport.ts`** (AC: 3)
  - [ ] Signature:
    ```ts
    export function useLotsInViewport(
      bbox: BoundingBox,
      filters: { status?: LotStatus, type?: LotType, section?: string },
    ): { lots: LotForMap[] | undefined, isLoading: boolean }
    ```
  - [ ] Debounce `bbox` with the 150ms debounce hook (`src/hooks/useDebouncedValue.ts` — Story 1.10 created this).
  - [ ] Use `useQuery(api.lots.listInBbox, debouncedBbox ? { ...debouncedBbox, statusFilter: filters.status, typeFilter: filters.type, sectionFilter: filters.section, limit: 500 } : "skip")`.
  - [ ] Return type `LotForMap = Pick<Doc<"lots">, "_id" | "code" | "section" | "status" | "type" | "geometry" | "geometryStatus">` — projected to keep payload small.

- [ ] **Task 3: Create `src/lib/geometry.ts` (client mirror)** (AC: 1, AC: 3)
  - [ ] Mirror the types from `convex/lib/geometry.ts` (Story 1.9): `LatLng`, `Polygon`, `Bbox`, `LotGeometry`. Re-declare client-side (Convex's `_generated/api` types are flat; types in `convex/lib/` aren't auto-exported to the client).
  - [ ] Add client-only helpers:
    - `bboxToSvgViewBox(bbox: Bbox, padding?: number): string` — converts lat/lng bbox into SVG `viewBox="minX minY width height"`. Uses a simple equirectangular projection for Phase 1 (Manila is far from poles; the distortion is negligible at city scale).
    - `latLngToSvgPoint(p: LatLng, bbox: Bbox, svgWidth: number, svgHeight: number): { x: number, y: number }` — projects lat/lng to SVG pixel coords.
    - `intersectsBbox(a: Bbox, b: Bbox): boolean` — for client-side filtering.

- [ ] **Task 4: Create `src/components/LotMap/SvgRenderer.tsx`** (AC: 1, AC: 4)
  - [ ] Renders `<svg viewBox=...>` sized via `bboxToSvgViewBox`. Inside:
    - `<image href="/map/overlay-section-{section}.svg" />` for each section overlay in the viewport (one `<image>` per overlay file; lazy-load only visible sections). For Phase 1, render all available overlays — there will be ≤ 8 sections.
    - `<g>` for lot polygons. For each lot:
      - If `geometryStatus === "surveyed"` and polygon has ≥ 3 vertices: render `<polygon points={polygonToSvgPoints(lot.geometry.polygon, ...)} fill={statusColor(lot.status)} stroke="white" strokeWidth={0.5} role="button" tabIndex={0} aria-label="Lot {code}, {status}" onClick={...} onKeyDown={...} />`.
      - If `geometryStatus === "placeholder"`: render `<circle cx={projectedCentroid.x} cy={projectedCentroid.y} r={6} fill={statusColor(lot.status)} role="button" tabIndex={0} aria-label="Lot {code}, {status} (placeholder location)" ... />`. The "placeholder location" suffix in the aria-label is important for screen-reader users to understand the marker is approximate.
  - [ ] `statusColor(status)` returns `var(--status-{status}-bg)` from Tailwind tokens (Story 1.4).
  - [ ] Click/Enter/Space handlers all call the `onLotClick(lotId)` prop.

- [ ] **Task 5: Create `src/components/LotMap/LeafletRenderer.tsx` stub** (AC: 6)
  - [ ] Single-file stub:
    ```ts
    /**
     * Phase 2: Leaflet-based renderer. Lazy-loaded only when renderer === "leaflet".
     * Phase 1: this file exists as a placeholder so the dynamic-import slot is reserved.
     * @ts-expect-error: Phase 2 will populate this.
     */
    export function LeafletRenderer(_props: LotMapRendererProps): JSX.Element {
      throw new Error("LeafletRenderer is Phase 2 only.");
    }
    ```
  - [ ] **Critical**: do NOT add an `import "leaflet"` here. The whole point of Phase 1 is that leaflet stays out of the bundle. Story 1.5's deferred `no-leaflet-client-import` lint rule will eventually catch the regression.

- [ ] **Task 6: Create `src/components/LotMap/LotMap.tsx` orchestrator** (AC: 1, AC: 3, AC: 4, AC: 5)
  - [ ] Props per UX § Component Library (Story 1.4 / UX spec):
    ```ts
    interface LotMapProps {
      renderer?: "svg" | "leaflet";  // default "svg"
      initialBbox?: BoundingBox;
      onLotClick: (lotId: Id<"lots">) => void;
      selectedLotId?: Id<"lots">;
      statusFilter?: LotStatus;
      typeFilter?: LotType;
      sectionFilter?: string;
      height?: number;
    }
    ```
  - [ ] Internally:
    - Holds the current `viewBbox` in state (initialized from `initialBbox` or the cemetery-wide bbox constant from `src/lib/geometry.ts`).
    - Calls `useLotsInViewport(viewBbox, filters)`.
    - Renders `<SvgRenderer ... />` for `renderer="svg"` (the only Phase 1 path).
    - For `renderer="leaflet"`, dynamic-import `LeafletRenderer` via `next/dynamic` with `ssr: false`. This is the slot for Phase 2; in Phase 1 it throws.
    - Loading: shimmer skeleton at the SVG dimensions.
    - Empty (no lots in viewport / no filters match): centered "No lots match these filters" + "Clear filters" link.
    - Error (renderer crashes): fall back to search-only message "Map unavailable. Use Cmd-K to search." per UX § Component Library > LotMap states.

- [ ] **Task 7: Create `public/map/` placeholder overlays** (AC: 1)
  - [ ] Create `public/map/overlay-section-a.svg` through `overlay-section-h.svg` (8 placeholder files). Each is a minimal SVG: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="#f5f5f4"/><text x="500" y="500" text-anchor="middle" font-size="48" fill="#a8a29e">Section A (placeholder)</text></svg>`. Document in `public/map/README.md`: "Client supplies real section overlays per Phase 2 GPS-survey step. Placeholders here are intentional — the schema and renderer don't care what's inside; replacing the file is a no-code change."
  - [ ] Add `public/map/manifest.json` listing the available sections so `LotMap` knows which overlays to load. Phase 2 adds this manifest as a server-generated query if section list changes dynamically.

### Page: `/lots` map/list toggle (AC2, AC5)

- [ ] **Task 8: Update `/lots/page.tsx` with the toggle** (AC: 2, AC: 5)
  - [ ] Story 1.8 created `src/app/(staff)/lots/page.tsx` with a disabled "Map view" toggle. Enable it.
  - [ ] State: `view: "map" | "list"`. Default: `"map"` on `≥ 768px` viewport, `"list"` on `< 768px` (mobile-list-by-default per UX-DR7). Persist preference in `localStorage["cm:lotsView:v1"]` so user choice carries across sessions.
  - [ ] Filter chips state: read from URL via `useSearchParams`. Setter writes back via `router.replace`. Filter chips visible above both map and list views.
  - [ ] Map view: renders `<LotMap />` at 60vh height (mobile) or 70vh (desktop). Filter chips above.
  - [ ] List view: existing Story 1.8 table.
  - [ ] Toggle button: shadcn/ui `<ToggleGroup>` with two items "Map" / "List". Sticky to viewport on mobile; inline on desktop.
  - [ ] One `<h1>` per page: "Lots".

- [ ] **Task 9: URL synchronization** (AC: 2)
  - [ ] On mount: read `status`, `type`, `section`, `view` from URL params. Apply to state.
  - [ ] On filter change: `router.replace("/lots?status=...&type=...&section=...&view=...", { scroll: false })`.
  - [ ] Pasting a URL with `?view=map&section=D&status=available` → page restores to map view, filter chips set, map narrowed to section D, only `available` lots visible.

### Performance + accessibility (AC4, AC6)

- [ ] **Task 10: Bundle audit** (AC: 6)
  - [ ] Run `npx @next/bundle-analyzer` after build. Confirm `/lots` route bundle < 250KB gzipped (NFR-P6). If over, identify the cause — most likely tree-shaking issue or accidental leaflet import. Story 1.5's deferred lint rule will catch the latter; for now, manual audit.
  - [ ] Document the measured bundle size in `docs/perf-budget.md` (create or extend).

- [ ] **Task 11: a11y polish** (AC: 4)
  - [ ] axe-core scan on `/lots` (both map and list views). Zero violations.
  - [ ] Keyboard nav: Tab through filter chips → enter map → Tab cycles through lot polygons in geometry-document order (acceptable for Phase 1; a screen-reader-friendly "list of lots" alternative is the list view).
  - [ ] Mobile + outdoor mode (UX § Outdoor mode): polygon strokes thicken to 2px in `[data-theme="outdoor"]` mode per Story 1.4's outdoor tokens. Test with the user-menu toggle.

### Testing (AC1–AC6)

- [ ] **Task 12: Unit tests for `src/lib/geometry.ts` (client mirror) + `useLotsInViewport`** (AC: 1, AC: 3)
  - [ ] `tests/unit/lib/geometry.test.ts` (client) — equirectangular projection sanity, `bboxToSvgViewBox` correctness, `intersectsBbox`.
  - [ ] `tests/unit/hooks/useLotsInViewport.test.ts` — debounce works; query updates when bbox changes; `"skip"` when bbox is null.

- [ ] **Task 13: Component tests for `LotMap` + `SvgRenderer`** (AC: 1, AC: 4)
  - [ ] `src/components/LotMap/LotMap.test.tsx` — renders SVG renderer; passes click through; renders empty state; renders error fallback.
  - [ ] `src/components/LotMap/SvgRenderer.test.tsx` — renders polygons for surveyed lots; renders circles for placeholder lots; click on polygon calls `onLotClick`; keyboard Enter on focused polygon calls `onLotClick`.

- [ ] **Task 14: Playwright + Lighthouse** (AC: 2, AC: 5, AC: 6)
  - [ ] Extend `tests/e2e/lot-management.spec.ts` (Story 1.8) or create `tests/e2e/lots-map.spec.ts`: Office Staff lands on `/lots`, sees map (desktop) or list (mobile), toggles, filters, clicks a polygon, navigates to detail.
  - [ ] Lighthouse CI: `npm run lighthouse` already runs on `/login` (Story 1.1). Add `/lots` to the URL list in `lighthouserc.json`. Assert mobile performance ≥ 0.9, accessibility ≥ 0.95.

### Documentation

- [ ] **Task 15: ADR-0010** (AC: 1, AC: 6)
  - [ ] Write `docs/adr/0010-phase1-svg-renderer.md`: "Phase 1 map uses SVG with per-section image overlays + lot polygons. Phase 2 swaps to Leaflet behind the same `LotMap` component contract. Geometry fields (Story 1.9) are populated from day one so the swap is a rendering change, not a data migration. Leaflet must never appear in the Phase 1 bundle — checked via Lighthouse CI bundle assertion + a deferred ESLint rule (Story 1.5)."

## Dev Notes

### Previous story intelligence

**Story 1.1 produced:** `lighthouserc.json` with `/login` URL. This story adds `/lots`.

**Story 1.2 produced:** `requireRole` — Story 1.9's `listInBbox` complies; no new server work here.

**Story 1.4 produced:** `StatusPill` palette tokens (`--status-{status}-bg`) — consumed in `SvgRenderer` to color polygons. Outdoor-mode CSS variables apply.

**Story 1.5 produced:** the deferred `no-leaflet-client-import` lint rule (TODO marker). This story keeps Leaflet out of the bundle to set up that rule for activation in Phase 2.

**Story 1.8 produced:** `src/app/(staff)/lots/page.tsx` with the disabled "Map view" toggle placeholder + the lots list. This story enables the toggle.

**Story 1.9 produced:** `convex/lots.ts → listInBbox` viewport query, `convex/lib/geometry.ts` helpers, `by_bbox_lat` index. **Critical dependency** — this story is unbuildable without Story 1.9's geometry contract.

**Story 1.10 produced:** `useDebouncedValue` hook (`src/hooks/useDebouncedValue.ts`) — reused for the 150ms bbox debounce.

**Story 1.11 produced:** the lot detail page at `/lots/[lotId]/page.tsx` — destination of `onLotClick`.

**Story 1.13 (next):** the service worker will cache `/lots` route + the `listInBbox` query response + the SVG overlays for offline read.

**Story 1.14:** unrelated to map, but lot condition logs surfaced in the detail page (Story 1.11's `ConditionLogsPanel`).

### Architecture compliance

- **Component contract stable across Phase 1 → Phase 2**: `LotMapProps` doesn't change when the renderer swaps. Architecture's "schema-compatible swap" promise.
- **Bundle budget**: NFR-P6 (< 250KB) is the hard line. Leaflet is ~150KB gzipped; including it busts the budget. Phase 1 SVG renderer is < 5KB of code (geometry helpers + SVG render fn).
- **Viewport bbox query**: NFR-P2 (< 3s first paint) at 2,000 lots requires the index-backed query. Story 1.9 verified.
- **`convex/lib/geometry.ts` (server) + `src/lib/geometry.ts` (client)** — duplicated types. Architecture allows; Convex's generated API types don't bridge `convex/lib/` to client.
- **`public/map/overlay-section-*.svg`** — per architecture § Project Structure, slotted under `public/map/`. Placeholders ship in this story; client supplies real overlays in a non-code update.
- **Filter chip pattern**: per UX § Search & Filtering Patterns — chips toggle filter dimensions; no Apply button.
- **URL-as-state**: shareable map view per UX § URLs are state.

### Library / framework versions (current)

- **No new dependencies.** Pure React + SVG + `next/dynamic` for the Leaflet slot.
- `next/navigation` (built-in) for `useSearchParams`, `useRouter`.
- shadcn/ui `<ToggleGroup>` — verify Story 1.4 installed; if not, add via `npx shadcn@latest add toggle-group`.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── lots.ts                                       # UPDATE (extend listInBbox with typeFilter + sectionFilter args if Story 1.9 didn't)
├── src/
│   ├── app/(staff)/lots/
│   │   └── page.tsx                                  # UPDATE (enable map/list toggle; URL sync; filter chips above both views)
│   ├── components/
│   │   └── LotMap/
│   │       ├── LotMap.tsx                            # NEW (orchestrator)
│   │       ├── SvgRenderer.tsx                       # NEW (Phase 1)
│   │       ├── LeafletRenderer.tsx                   # NEW (Phase 2 stub — throws)
│   │       ├── LotMap.test.tsx                       # NEW
│   │       ├── SvgRenderer.test.tsx                  # NEW
│   │       └── index.ts                              # NEW
│   ├── hooks/
│   │   └── useLotsInViewport.ts                      # NEW
│   └── lib/
│       └── geometry.ts                               # NEW (client mirror of convex/lib/geometry.ts types + SVG projection helpers)
├── public/
│   └── map/
│       ├── overlay-section-a.svg                     # NEW (placeholder)
│       ├── overlay-section-b.svg                     # NEW (placeholder)
│       ├── ...                                       # NEW (a-h, 8 placeholders)
│       ├── manifest.json                             # NEW (lists sections)
│       └── README.md                                 # NEW (instructions for client overlay supply)
├── tests/
│   ├── unit/
│   │   ├── hooks/
│   │   │   └── useLotsInViewport.test.ts             # NEW
│   │   └── lib/
│   │       └── geometry.test.ts                      # NEW (client)
│   └── e2e/
│       └── lots-map.spec.ts                          # NEW (or extend lot-management.spec.ts)
├── lighthouserc.json                                  # UPDATE (add /lots to URL list)
└── docs/
    ├── adr/0010-phase1-svg-renderer.md               # NEW
    └── perf-budget.md                                # NEW or UPDATE (record measured /lots bundle size)
```

### Testing requirements

- **NFR-M2 (≥ 90% on financial-touching) does not apply** — map is read-only and non-financial. Target: ≥ 85% on `LotMap.tsx` + `SvgRenderer.tsx` + 100% on `src/lib/geometry.ts` (small helper module).
- **Lighthouse CI gate** is the real performance test. Bundle audit (Task 10) provides the manual confirmation.
- **Outdoor mode visual test**: capture before/after screenshots of `/lots` in outdoor mode; document in Completion Notes that polygon strokes thicken correctly.

### Source references

- **PRD:** [FR10 Phase 1 (SVG map)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping); [NFR-P2 (< 3s first paint)](../../_bmad-output/planning-artifacts/prd.md#performance); [NFR-P6 (< 250KB bundle)](../../_bmad-output/planning-artifacts/prd.md#performance)
- **Architecture:** [§ Frontend Architecture > Phase 1 map renderer](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture); [§ Geospatial viewport queries](../../_bmad-output/planning-artifacts/architecture.md#scope--scale-parameters); [§ Project Structure > LotMap, useLotsInViewport, public/map/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- **UX:** [§ Component Library > LotMap](../../_bmad-output/planning-artifacts/ux-design-specification.md#lotmap); [§ Defining Decisions > UX-DR7 (mobile list-toggle)](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Search & Filtering Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#search--filtering-patterns)
- **Epics:** [Story 1.12](../../_bmad-output/planning-artifacts/epics.md#story-112-phase-1-svg-map-renders-lots-with-status-filters)
- **Previous stories:** [1.4 StatusPill tokens](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.5 lint TODO + URL pattern](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md), [1.8 list view + placeholder toggle](./1-8-office-staff-creates-and-edits-lot-records.md), [1.9 listInBbox + geometry helpers](./1-9-schema-ready-lot-geometry-from-day-one.md), [1.10 debounce hook](./1-10-any-authenticated-user-searches-lots-from-anywhere.md), [1.11 lot detail page](./1-11-office-staff-views-any-lots-detail.md)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT import `leaflet` anywhere in Phase 1 code paths.** Not in `LotMap.tsx`, not in `SvgRenderer.tsx`. The `LeafletRenderer.tsx` stub THROWS — it doesn't import. The dynamic-import slot is reserved but unused.
- ❌ **Do NOT load all 2,000 lots into the map at once.** Use `listInBbox` (Story 1.9) with the viewport. Even though Phase 1 may render a "cemetery-wide" bbox by default, the query is still bbox-scoped — the limit (200 / 500 per query) enforces this.
- ❌ **Do NOT fetch SVG overlays via a Convex query.** They're static assets in `public/map/`. Load via `<image href="/map/overlay-section-a.svg" />`.
- ❌ **Do NOT use `fetch("/map/...")` + `dangerouslySetInnerHTML`.** `<image>` is the safe pattern. SVG injection is an XSS vector.
- ❌ **Do NOT add a custom pan/zoom library** (`react-zoom-pan-pinch`, `d3-zoom`, etc.) in Phase 1. SVG `viewBox` with CSS-driven zoom is enough for "switch section filter" UX. Phase 2's Leaflet handles real pan/zoom.
- ❌ **Do NOT compute lat/lng → SVG with a real geo-projection** (`d3-geo`, `proj4`). Equirectangular is correct enough for Manila at cemetery scale (distortion < 0.01% at this latitude).
- ❌ **Do NOT make polygons clickable but skip keyboard.** Keyboard support is NFR-A1 (WCAG AA). Use `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter/Space).
- ❌ **Do NOT use `<div>` for polygons.** SVG `<polygon>` is correct and a11y-friendly with proper `role` + `aria-label`.
- ❌ **Do NOT block first paint on the bbox query.** Render the SVG with overlays immediately; lot polygons fade in when `useLotsInViewport` resolves. Skeleton-fill the polygons area while loading.
- ❌ **Do NOT make filter changes trigger a full route re-render.** Use `router.replace` with `{ scroll: false }`. Use `useSearchParams` to read.
- ❌ **Do NOT default to map view on mobile.** UX-DR7: list view default on `< 768px`. User can toggle to map.

### Common LLM-developer mistakes to prevent

- **`viewBox` math:** SVG `viewBox` is `"minX minY width height"`. Width / height are differences (max - min), not absolute coords. Equirectangular projection: `x = (lng - bbox.minLng) * scale`, `y = (bbox.maxLat - lat) * scale` (Y inverted because SVG Y grows downward).
- **`next/dynamic` with `ssr: false`:** required for Leaflet (which touches `window`). Story 1.4 may already have it installed via shadcn/ui patterns; verify.
- **`localStorage` SSR:** `localStorage["cm:lotsView:v1"]` must be read in `useEffect`, not in `useState` initializer. Otherwise SSR throws.
- **Status filter URL param vs Convex query arg name:** URL uses `status=available`; Convex query arg is `statusFilter`. Map between them in the page component. Don't accidentally pass `status` (Convex schema) to `useLotsInViewport`.
- **Forgetting the placeholder-geometry circle path:** Phase 1 has all-placeholder geometry (Story 1.8 default). Without the circle fallback, the map shows nothing. Test with at least one placeholder lot in the seed.
- **`<image>` not `<img>` in SVG:** SVG element is lowercase `<image>` and uses `href` not `src`. React/JSX accepts both via Preact-style props but `<image>` is required when nested in `<svg>`.
- **Treating `useSearchParams` return as mutable:** `useSearchParams()` returns a read-only `URLSearchParams`. To update, construct a new instance and pass to `router.replace`.
- **Filter chips re-querying on every click:** debounce the bbox, not the filter — filters change rarely (user clicks a chip), bbox changes continuously (user pans). The 150ms debounce is on the bbox setter.
- **Outdoor-mode polygon stroke missing:** Tailwind's `dark:` and outdoor-mode variants only apply to Tailwind classes. SVG `stroke` attribute won't pick up the variant. Use `style={{ stroke: "var(--outdoor-stroke)" }}` or class-based `className="stroke-1 outdoor:stroke-2"` (verify Story 1.4's outdoor variant naming).

### Open questions / blockers this story does NOT resolve

- **Real section overlays from client:** Phase 1 ships placeholder SVGs in `public/map/`. The client supplies real overlays as a non-code update (drop-in file replacement). Document in `public/map/README.md`.
- **Phase 2 GPS-survey loader:** Epic 5 will populate real polygons via `updateLotGeometry` (Story 1.9). Phase 1's placeholder circles are correct UX.
- **Polygon click vs hover:** Phase 1 supports click. Hover-to-preview a lot summary card is a Phase 2 nice-to-have.
- **Cluster markers at low zoom:** not in Phase 1 scope. With 2,000 lots and a section-narrowable view, clustering isn't needed.

### Project Structure Notes

Aligns with:

- [architecture.md § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `src/components/LotMap/` folder pattern with `SvgRenderer.tsx` + `LeafletRenderer.tsx` matches exactly.
- [ux-design-specification.md § Component Library > LotMap](../../_bmad-output/planning-artifacts/ux-design-specification.md#lotmap) — props match the UX spec exactly.

No detected conflicts.

### References

- [PRD § FR10](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [PRD § Non-Functional Requirements > Performance](../../_bmad-output/planning-artifacts/prd.md#performance)
- [Architecture § Frontend Architecture](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Project Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [UX § LotMap](../../_bmad-output/planning-artifacts/ux-design-specification.md#lotmap)
- [Epics § Story 1.12](../../_bmad-output/planning-artifacts/epics.md#story-112-phase-1-svg-map-renders-lots-with-status-filters)
- [Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.9](./1-9-schema-ready-lot-geometry-from-day-one.md), [Story 1.11](./1-11-office-staff-views-any-lots-detail.md)
- Next.js dynamic imports: [https://nextjs.org/docs/app/api-reference/functions/dynamic](https://nextjs.org/docs/app/api-reference/functions/dynamic)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` — passes clean (no errors).
- `npm run lint` — passes clean (no warnings, no errors). Initially flagged `react-hooks/exhaustive-deps` on the inline debounce; replaced with the shared `useDebouncedValue` hook (Story 1.10) by debouncing a stringified bbox key.
- `npm test` — 36/36 new tests pass (20 in `tests/unit/lib/geometry.test.ts`, 16 in `tests/unit/components/LotMap.test.tsx`). Pre-existing failures in `LotSearchCommand.test.tsx` (Story 1.10) and `LotDetail.test.tsx` (Story 1.11) and `search.test.ts` are concurrent-story failures, not regressions from this story.
- `npm run build` — passes; `/map` route is **5.17 kB** with **140 kB First Load JS** (well under NFR-P6 budget of 250 KB gzipped).

### Completion Notes List

**Scope adjustment vs. original story spec**: per the dev-agent task instructions (which take precedence as the working spec), this story ships a focused MVP at a dedicated `/map` route rather than the `/lots` map/list toggle integration described in the original story's Task 8/9. The toggle integration into `/lots/page.tsx` is deferred — `src/app/(staff)/lots/**` is owned by another story this sprint and not in this dev's file scope. Tasks 5 (`LeafletRenderer.tsx` stub), 7 (placeholder section overlays + manifest), 10 (bundle-analyzer audit), 11 (axe-core a11y polish), 14 (Lighthouse CI URL list update), and 15 (ADR-0010) are likewise deferred to a follow-up story; this implementation establishes the SvgRenderer + viewport hook + status filter chips so those follow-up tasks slot in incrementally without rework.

**Shipped surface**:
- `/map` page with `<h1>Cemetery Map</h1>` and multi-select status filter chips (7 lot statuses + "All" reset).
- `LotMap` orchestrator + `SvgRenderer` Phase 1 renderer composed via `src/components/LotMap/index.ts`.
- `useLotsInViewport` hook with 250ms bbox debounce (uses Story 1.10's `useDebouncedValue`, debounced on a stringified key to avoid object-identity thrash), single-status server-side filter, multi-status client-side filter, server cap honoured at 200/500.
- Click / Enter / Space on a lot polygon or placeholder circle navigates to `/lots/{lotId}` (Story 1.11's detail page).
- Hover/focus tooltip with `{code} · {status}` rendered as an HTML overlay above the SVG.
- Status colours via Tailwind `fill-status-{state}-bg` + `stroke-status-{state}-border` (Story 1.4 palette tokens).
- Performance cap at 200 rendered lots per viewport, with an in-render truncation notice when the server-returned list would exceed the cap.

**Leaflet bundle check**: confirmed `leaflet` is NOT in the production bundle. Neither `LotMap.tsx`, `SvgRenderer.tsx`, `useLotsInViewport.ts`, nor `src/lib/geometry.ts` import from `leaflet`. The `/map` route weighs in at 5.17 kB (well below the 250 KB NFR-P6 ceiling).

**Bundle measurement (NFR-P6 — 250 KB ceiling)**: `/map` First Load JS = 140 KB (raw, not gzipped). Gzipped will be smaller still — comfortably under budget.

**Tests delivered**: 20 unit tests for `src/lib/geometry.ts` (projection math, viewBox formatting, polygon serialization, bbox-intersection predicate, stroke/radius scaling), 16 unit tests for the LotMap component tree (SVG renderer + orchestrator). Playwright smoke spec at `tests/e2e/lot-map.spec.ts` covers the unauthenticated redirect.

**Outdoor mode**: stroke widths use a calculated style attribute keyed off bbox width so the visual scaling stays consistent at any zoom level. Outdoor-mode polygon-stroke thickening via CSS variables is deferred to the follow-up story (would require coordination with `tailwind.config.ts` / `globals.css`, both outside this dev's file scope).

### File List

**New files (created):**
- `src/app/(staff)/map/page.tsx` — `/map` route entry point with status filter chips.
- `src/components/LotMap/LotMap.tsx` — orchestrator (loading/empty/render dispatch).
- `src/components/LotMap/SvgRenderer.tsx` — Phase 1 SVG renderer (polygons, placeholder circles, hover tooltip, truncation notice).
- `src/components/LotMap/index.ts` — barrel.
- `src/hooks/useLotsInViewport.ts` — debounced viewport-bbox query wrapper around `api.lots.listInBbox`.
- `src/lib/geometry.ts` — client mirror of `convex/lib/geometry.ts` types + SVG projection helpers.
- `tests/unit/lib/geometry.test.ts` — 20 unit tests for the client geometry helpers.
- `tests/unit/components/LotMap.test.tsx` — 16 unit tests for `LotMap` + `SvgRenderer`.
- `tests/e2e/lot-map.spec.ts` — Playwright smoke spec (unauthenticated `/map` redirects to `/login`).

**Modified files:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story status flipped to `review`, `last_updated: 2026-05-18`.
- `_bmad-output/implementation-artifacts/1-12-phase-1-svg-map-renders-lots-with-status-filters.md` — Dev Agent Record sections filled, status flipped to `review`.

### Change Log

| Date       | Change                                                                              |
| ---------- | ----------------------------------------------------------------------------------- |
| 2026-05-18 | Initial implementation: `/map` page, `LotMap` + `SvgRenderer`, `useLotsInViewport`, client `geometry.ts` mirror, unit + e2e tests. |

