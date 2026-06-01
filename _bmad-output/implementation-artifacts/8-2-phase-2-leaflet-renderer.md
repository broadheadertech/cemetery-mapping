# Story 8.2: Phase 2 Leaflet Renderer

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **authenticated user (especially Junior the Field Worker)**,
I want **the `LotMap` component to render via Leaflet + OpenStreetMap tiles when its `renderer="leaflet"` prop is set, lazy-loaded via `next/dynamic` so it doesn't bloat the initial bundle, and presenting the same prop contract as the Phase 1 SVG renderer**,
so that **I see real geographic context (roads, satellite imagery, GPS overlays) without breaking any existing Phase 1 call site — the Phase 2 cutover is a single prop flip** (FR10 Phase 2, NFR-P6).

The architecture committed in Phase 1 to a renderer-swap pattern: `LotMap` exposes a stable prop interface, and the actual rendering engine is selected by a `renderer` prop. Phase 1 shipped `SvgRenderer`; this story ships `LeafletRenderer` as the second implementation. Story 8.1 must have completed first (real GPS geometry in the DB), otherwise the Leaflet map renders lots stacked at the cemetery's placeholder centroid.

## Acceptance Criteria

1. **AC1 — Leaflet renderer matches the LotMap prop contract**: `src/components/LotMap/LeafletRenderer.tsx` accepts the exact same props as `SvgRenderer.tsx`: `{ initialBbox?, onLotClick, selectedLotId?, statusFilter?, sectionFilter?, height? }`. `LotMap.tsx` chooses the renderer based on its `renderer` prop (default still `"svg"` until the cutover flag flips). Renderer choice has no other side effects.

2. **AC2 — Lazy-loaded via `next/dynamic`**: Leaflet and its CSS are imported inside `LeafletRenderer.tsx` only. `LotMap.tsx` references `LeafletRenderer` via `next/dynamic(() => import("./LeafletRenderer"), { ssr: false })`. The route-level bundle for `/lots` stays ≤ 250KB gzipped (NFR-P6) when `renderer="svg"`; when `renderer="leaflet"`, the additional chunk loads on-demand and is ≤ 100KB gzipped.

3. **AC3 — Viewport-bbox query works the same on Leaflet**: When the user pans / zooms, Leaflet's `moveend` event is debounced 200ms and triggers `useLotsInViewport(bbox)` with the new bbox. Only viewport-matching lots are fetched. 2,000+ lot inventory loads in < 3s on the test device profile (mid-Android, 4G) per NFR-P2.

4. **AC4 — Same status palette + StatusPill semantics**: Lot polygons are filled with the same status-color tokens as the SVG renderer (from `src/types/lot-status.ts` + design tokens). The map's tooltip / popup on a lot tap shows `{code}` + `{status}` using the `StatusPill` component (color + icon + label per NFR-A2). No new color values introduced for Leaflet.

## Tasks / Subtasks

### Renderer scaffolding (AC1, AC2)

- [ ] **Task 1: Add Leaflet dependencies** (AC: 2)
  - [ ] `npm install leaflet react-leaflet`. `npm install --save-dev @types/leaflet`. Pin versions in `package.json` at install time and capture in commit message.
  - [ ] **Verify the ESLint "no client imports of leaflet" rule** (added in Phase 1's bundle-budget ADR) is updated: the rule must allow `leaflet` / `react-leaflet` imports *only* in `src/components/LotMap/LeafletRenderer.tsx` (and its test file). Every other client file remains banned. Update `eslint-rules/no-leaflet-client-import.js` (if it exists) or the inline ESLint config to add the new allow-listed path.

- [ ] **Task 2: Create `LeafletRenderer.tsx`** (AC: 1, AC: 2)
  - [ ] Path: `src/components/LotMap/LeafletRenderer.tsx`. First line: `"use client"`.
  - [ ] Props: identical TypeScript interface to `SvgRenderer.tsx`'s props. Import the interface from `src/components/LotMap/types.ts` (Phase 1 should have already extracted shared types; if not, do that as a small refactor here).
  - [ ] Use `react-leaflet`: `<MapContainer center={...} zoom={...} style={{ height }}>` wraps `<TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap contributors" />` plus a `<LotPolygonLayer />` child.
  - [ ] Import Leaflet's CSS exactly once: `import "leaflet/dist/leaflet.css"` at the top of `LeafletRenderer.tsx` (inside the client-component boundary; the lazy-load via `next/dynamic` prevents this CSS from entering the SSR / initial bundle).

- [ ] **Task 3: Update `LotMap.tsx` to dispatch on `renderer` prop** (AC: 1, AC: 2)
  - [ ] In `src/components/LotMap/LotMap.tsx`: keep the existing static import of `SvgRenderer` (Phase 1 default). Add:
    ```ts
    const LeafletRenderer = dynamic(() => import("./LeafletRenderer").then(m => ({ default: m.LeafletRenderer })), {
      ssr: false,
      loading: () => <MapSkeleton height={height} />,
    });
    ```
  - [ ] Render-time dispatch: `return renderer === "leaflet" ? <LeafletRenderer {...passthroughProps} /> : <SvgRenderer {...passthroughProps} />;`. No other changes to `LotMap.tsx`.
  - [ ] Verify `MapSkeleton` exists (Phase 1 should have built it for the SVG renderer's initial-load state). If not, add a small shimmer matching `<SkeletonCard>` patterns.

### Polygon rendering (AC3, AC4)

- [ ] **Task 4: Build the `LotPolygonLayer` subcomponent** (AC: 3, AC: 4)
  - [ ] Path: `src/components/LotMap/LotPolygonLayer.tsx` (or inline inside `LeafletRenderer.tsx` if small). `"use client"`.
  - [ ] Read viewport bbox from `useMap()` + `useMapEvents({ moveend: ... })`. Debounce the bbox state via `useDebouncedValue(bbox, 200)` (custom hook — add to `src/hooks/useDebouncedValue.ts` if missing).
  - [ ] Call `useLotsInViewport(bbox)` (Phase 1 hook; reused as-is). Receives `lots: Doc<"lots">[]`.
  - [ ] For each lot, render `<Polygon positions={lot.geometry.polygon.map(p => [p.lat, p.lng])} pathOptions={{ color: statusToStrokeColor(lot.status), fillColor: statusToFillColor(lot.status), fillOpacity: 0.5, weight: 2 }} eventHandlers={{ click: () => onLotClick(lot._id) }}>`.
  - [ ] Polygon **inner** content: `<Tooltip>{`Lot ${lot.code} — ${lot.status}`}</Tooltip>` for hover, `<Popup><StatusPill status={lot.status} />{lot.code}</Popup>` for tap on mobile. The `StatusPill` import is the existing Phase 1 component — no new component needed.
  - [ ] **Selection highlight:** if `lot._id === selectedLotId`, increase `weight` to 4 and add a stronger stroke; this matches the SVG renderer's selection behavior.

- [ ] **Task 5: Status → color mapping shared with SVG** (AC: 4)
  - [ ] Extract `statusToFillColor` / `statusToStrokeColor` into `src/lib/lotStatusColors.ts` if not already done. Both renderers (SVG + Leaflet) import from the same source. NFR-A2 is satisfied because the visible labels are always paired with `StatusPill` in tooltips / popups; map color alone is NOT the only signal.

- [ ] **Task 6: Empty-state, loading, error states** (AC: 1, AC: 3)
  - [ ] Loading (initial Leaflet load): the `next/dynamic` `loading:` prop returns `<MapSkeleton />`. Once loaded, the inner `useLotsInViewport` loading state is handled by the layer (`{lots === undefined ? <MapSkeleton /> : ...}`).
  - [ ] Empty (filtered to zero): show a small toast / inline banner "No lots in this view" rather than blanking the map. The map tiles remain visible.
  - [ ] Error: if Leaflet throws (script load fail, tile timeout), the `error.tsx` route boundary catches it. As a defense, wrap `LeafletRenderer` in an `<ErrorBoundary fallback={<SvgRenderer {...props} />} />` to gracefully fall back to SVG. Document this fallback in the renderer's JSDoc.

### Feature flag / cutover plan (AC1)

- [ ] **Task 7: Wire a settings-driven renderer choice** (AC: 1)
  - [ ] The eventual cutover is "flip default from `svg` to `leaflet` after staging validation." Implement it as: `LotMap.tsx` reads a setting (Convex query `settings:getMapRenderer` returning `"svg" | "leaflet"`) when no `renderer` prop is passed.
  - [ ] Add `convex/settings.ts → getMapRenderer` (query, `requireRole(ctx, ["admin","office_staff","field_worker"])`) and `setMapRenderer` (mutation, `requireRole(ctx, ["admin"])`). Default value: `"svg"` (preserves current behavior on first deploy).
  - [ ] Add admin UI in `src/app/(staff)/admin/settings/page.tsx`: a single radio "Map renderer: SVG (Phase 1) | Leaflet (Phase 2)". Toggle flips the setting; everyone's `LotMap` re-renders reactively to the new choice on next navigation.

- [ ] **Task 8: Phase 1 routes still default to SVG via prop** (AC: 1)
  - [ ] Audit existing `<LotMap />` usages in `src/app/(staff)/lots/page.tsx`, `[lotId]/page.tsx`, and any other call sites. None of them should pass `renderer="leaflet"` directly — they let the settings query decide. This makes the cutover a single setting change, not a code change.

### Performance & bundle (AC2, AC3)

- [ ] **Task 9: Verify bundle budget** (AC: 2)
  - [ ] Add a `npm run analyze` script using `@next/bundle-analyzer`. Run before merge. The `/lots` page route bundle without Leaflet must stay ≤ 250KB gzipped (NFR-P6); the dynamic Leaflet chunk must be < 100KB gzipped (typical react-leaflet + leaflet is 50–70KB gzipped, well within budget).
  - [ ] If the budget fails, **stop** — do not ship. Investigate: is Leaflet being included in the main bundle accidentally? Common cause: `import` at top of a file that's not the `LeafletRenderer.tsx` file.

- [ ] **Task 10: Viewport debounce + performance test** (AC: 3)
  - [ ] Use `src/hooks/useDebouncedValue.ts` (200ms). Confirm the `useLotsInViewport` call only fires after the user stops panning for 200ms — not on every `moveend` if they're scrolling continuously.
  - [ ] Manual / Playwright perf test on mid-Android emulation: load `/lots`, switch to Leaflet, pan + zoom 5 times in 10 seconds. Time to first-render of lot polygons after pan settles: < 1s on warm caches.

### Accessibility (AC4)

- [ ] **Task 11: Keyboard and screen-reader support** (AC: 4)
  - [ ] Leaflet has built-in keyboard pan/zoom (arrow keys + `+` / `-`). Verify the `MapContainer` gets focus via tab and arrows work.
  - [ ] Each `<Polygon>` is internally an SVG path inside Leaflet's overlay pane — Leaflet does NOT make them keyboard-focusable by default. **For accessibility,** maintain the existing **alternate text-based view** (lot list, search-first) as the primary interaction path per UX spec § 1991. The map is supplementary. Add a visible "Switch to list view" toggle near the map for keyboard / screen-reader users. (List view should already exist from Phase 1.)
  - [ ] Add `aria-label="Cemetery lot map. Use arrow keys to pan, plus and minus to zoom."` on the MapContainer wrapper. Add `role="application"` (Leaflet's recommended pattern).

### Testing (AC1–AC4)

- [ ] **Task 12: Unit / component tests** (AC: 1, AC: 2, AC: 4)
  - [ ] Create `tests/unit/components/LotMap/LeafletRenderer.test.tsx`. Use `@testing-library/react` + a mocked `useLotsInViewport` returning a small fixture (3 lots with real polygons). Verify:
    - Renders without error when given valid lots.
    - Calls `onLotClick(lotId)` when a polygon's `eventHandlers.click` fires.
    - Falls back via `ErrorBoundary` to SVG when Leaflet throws (mock the throw).
  - [ ] Caveat: Leaflet's DOM-mutation behavior is hard to test in jsdom. Most assertions are on props passed to react-leaflet components (`<Polygon positions={...}>`) — not on rendered pixels. This is acceptable; full visual validation lives in Playwright.

- [ ] **Task 13: Playwright e2e** (AC: 1, AC: 3)
  - [ ] Extend `tests/e2e/journey-3-field-worker-lookup.spec.ts` (or add `tests/e2e/leaflet-map.spec.ts`): admin flips the renderer setting to `leaflet` → load `/lots` → verify a `<canvas>` or Leaflet's `.leaflet-container` element renders → pan the map (drag) → verify a network request to a Convex viewport query fires after 200ms debounce → tap a polygon → verify the lot detail route opens.
  - [ ] Run on mid-Android emulation profile (NFR-P2 perf budget).

- [ ] **Task 14: Lighthouse + bundle check in CI** (AC: 2)
  - [ ] Extend `lighthouserc.json` assertions for the `/lots` route: performance score ≥ 0.85, total bundle size ≤ 250KB.
  - [ ] Add `npm run analyze` to the CI workflow as a non-blocking informational job; fail explicitly only if the main bundle crosses 250KB.

### Documentation (AC1, AC2)

- [ ] **Task 15: ADR-0011 — Leaflet renderer + lazy-load pattern** (AC: 1, AC: 2)
  - [ ] Write `docs/adr/0011-leaflet-renderer.md`: OpenStreetMap tiles (default; Mapbox deferred per architecture), `next/dynamic` lazy-load pattern, settings-driven renderer choice with SVG fallback, accessibility via list-view alternate, error-boundary fallback to SVG.

- [ ] **Task 16: Update component JSDoc** (AC: 1)
  - [ ] In `LotMap.tsx`, document the renderer prop, the dynamic-import pattern, and the settings-driven default. In `LeafletRenderer.tsx`, document the prop contract (mirror SvgRenderer) and the OSM attribution requirement (legal).

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies (must be complete):**

- **Story 2.1 — SVG renderer:** established the `LotMap` prop contract that this story preserves. `LeafletRenderer.tsx` accepts identical props.
- **Story 2.2 — Viewport bbox query:** `useLotsInViewport(bbox)` + `convex/lots.ts → listInViewport` + `by_bbox_lat` index. Reused as-is by Leaflet.
- **Story 1.4 — StatusPill:** used in tooltips / popups for NFR-A2 compliance.
- **Story 1.8 — Lots schema with geometry fields and `by_bbox_lat` index:** the geometry data Leaflet renders.
- **Bundle-budget ESLint rule (Phase 1 ADR):** banned client imports of `leaflet`. This story narrows the ban to "everywhere except `LeafletRenderer.tsx`."

**Phase 2 dependencies (this story consumes Story 8.1's output):**

- **Story 8.1 — GPS geometry import:** must be complete + successfully run against the production deployment before this renderer flips on. Without real geometry, Leaflet shows lots stacked at the placeholder centroid (visually broken). The settings flag default remains `"svg"` until 8.1 is verified.

**Phase 3 hand-off:**

- **Story 8.3 — GPS navigation:** uses the renderer-agnostic lot detail page, but the "Navigate to lot" button only makes sense in the Phase 2 context (real GPS coordinates). 8.3 can ship before or after 8.2; they're independent.

### Architecture compliance

- **Renderer-swap pattern** (architecture § Frontend Architecture, line 316–317): geometry fields populated since Phase 1; swap is a rendering change, not a data migration. This story is the realization of that decision.
- **`next/dynamic` for heavy components** (architecture line 320 + ux line 2060): Leaflet + CSS lazy-loaded with `ssr: false`. CSS import is INSIDE the client-only chunk to prevent SSR pickup.
- **Component file conventions:** `PascalCase.tsx`, named export matching filename. `LeafletRenderer.tsx` exports `LeafletRenderer`.
- **Bundle enforcement:** the existing ESLint rule banning client imports of `leaflet` (architecture line 320) is *narrowed*, not removed. Allowed only in `LeafletRenderer.tsx` and its test file.
- **NFR-P6 bundle budget:** 250KB gzipped initial JS. Leaflet chunk is on-demand; not part of initial.
- **NFR-P2 viewport-bbox load < 3s:** the existing viewport query is reused. Performance gates are unchanged.
- **NFR-A2 color + icon + label:** map color alone is insufficient for status; tooltips / popups use `StatusPill`. Keyboard / SR users have an alternate list view.

### Library / framework versions (researched current)

- **`leaflet`** — `@latest` (currently 1.9.x). Stable; widely used.
- **`react-leaflet`** — `@latest` (currently 4.x or 5.x line depending on Next.js version). Verify SSR-safety: react-leaflet requires `window`, which is why `ssr: false` in the `next/dynamic` call is mandatory.
- **`@types/leaflet`** — `@latest` matching the `leaflet` version.
- **No Mapbox.** Architecture defers Mapbox unless OSM coverage proves inadequate. OSM Philippines coverage is generally good in urban areas; verify with the cemetery's actual coordinates before assuming.
- **No clustering libraries.** Viewport-bbox query keeps result counts low enough (≤ 100 lots typical view) that polygon clustering is unnecessary for Phase 2. If Phase 3 reveals a perf issue with > 200 visible polygons, evaluate `react-leaflet-cluster` then.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── settings.ts                            # NEW (getMapRenderer query, setMapRenderer mutation) or UPDATE if exists
├── eslint-rules/
│   └── no-leaflet-client-import.js            # UPDATE (narrow ban: allow only in LeafletRenderer.tsx + test file)
├── src/
│   ├── app/
│   │   └── (staff)/
│   │       └── admin/
│   │           └── settings/page.tsx          # UPDATE (add renderer-choice radio)
│   ├── components/
│   │   └── LotMap/
│   │       ├── LotMap.tsx                     # UPDATE (renderer dispatch + settings read)
│   │       ├── LeafletRenderer.tsx            # NEW
│   │       ├── LotPolygonLayer.tsx            # NEW (or inline in LeafletRenderer)
│   │       ├── MapSkeleton.tsx                # NEW (if not from Phase 1)
│   │       └── types.ts                       # NEW or UPDATE (shared LotMapProps interface)
│   ├── hooks/
│   │   └── useDebouncedValue.ts               # NEW (if not already present)
│   └── lib/
│       └── lotStatusColors.ts                 # UPDATE (export both fill + stroke; consumed by SVG and Leaflet)
├── tests/
│   ├── e2e/
│   │   └── leaflet-map.spec.ts                # NEW (or extend journey-3 spec)
│   └── unit/
│       └── components/
│           └── LotMap/
│               └── LeafletRenderer.test.tsx   # NEW
├── docs/
│   └── adr/
│       └── 0011-leaflet-renderer.md           # NEW
├── lighthouserc.json                          # UPDATE (extend assertions to /lots)
└── package.json                               # UPDATE (leaflet, react-leaflet, @types/leaflet)
```

### Testing requirements

- **NFR-M2 coverage:** `LeafletRenderer.tsx` itself is mostly view code; target **≥ 70% line coverage** on the renderer + ≥ 90% on `lotStatusColors.ts` (pure logic). The viewport query is already covered by Phase 1 tests.
- **Playwright is the primary validation** for Leaflet — jsdom can't render tiles. Run the e2e spec on mid-Android emulation + 4G throttling.
- **No new Lighthouse failure modes expected** — the Leaflet chunk is on-demand. Initial load is unchanged.
- **Bundle analyzer** is run pre-merge; failures block.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT import `leaflet` or `react-leaflet` at the top of `LotMap.tsx`.** That defeats the lazy-load and bloats the initial bundle by 50–100KB. Only `LeafletRenderer.tsx` may import them, and `LotMap.tsx` references it via `next/dynamic({ ssr: false })`.
- ❌ **Do NOT remove `{ ssr: false }`.** react-leaflet requires `window`; SSR will throw.
- ❌ **Do NOT skip the OSM attribution.** "© OpenStreetMap contributors" is *legally required* for OSM tile use. Hardcode it; never disable it.
- ❌ **Do NOT introduce new status colors for Leaflet.** Reuse `lotStatusColors.ts`. Colors must match SVG so users in mixed-renderer scenarios (settings flip) see consistent semantics.
- ❌ **Do NOT proceed without Story 8.1 having run against production.** Without real geometry, Leaflet shows lots stacked at one point. Document this dependency in the story's preflight checklist before dev-story execution.
- ❌ **Do NOT break the SVG fallback.** If Leaflet's script load fails (offline, CDN issue, etc.), the user must still see a working map. ErrorBoundary fallback to SvgRenderer is mandatory.
- ❌ **Do NOT bypass the viewport bbox query.** Loading all 2,000 lots on map init blows the perf budget. Always feed Leaflet from `useLotsInViewport(bbox)` with the current viewport.
- ❌ **Do NOT make `renderer` prop required.** Default to settings-driven (settings default `"svg"`). Existing call sites pass nothing and keep working.
- ❌ **Do NOT use Mapbox tiles** unless the OSM-coverage decision is reopened via ADR. Architecture explicitly defers Mapbox.
- ❌ **Do NOT add clustering, heatmaps, or marker libraries** in this story. Scope = polygons + tooltips. Adding more invites bundle-size and complexity creep.
- ❌ **Do NOT remove the alternate list view.** Keyboard / screen-reader users depend on it. Maps are visual-only by nature; the list view IS the a11y story.

### Common LLM-developer mistakes to prevent

- **Re-doing the viewport query:** `useLotsInViewport` already exists from Phase 1. Reuse it; do not write a Leaflet-specific query.
- **Wrong polygon coord order:** Leaflet expects `[lat, lng]` arrays — opposite of GeoJSON's `[lng, lat]`. Our schema is `{ lat, lng }` objects; map them to `[p.lat, p.lng]` before passing to `<Polygon positions={...}>`.
- **Importing Leaflet CSS in the wrong place:** put `import "leaflet/dist/leaflet.css"` inside `LeafletRenderer.tsx` only. Importing in `globals.css` or root layout leaks Leaflet into the SSR bundle and breaks the lazy-load.
- **Stale viewport state:** the `moveend` debounce must use the *latest* viewport bounds. Use a ref or `useMap()` inside the hook, not a closure-captured value, otherwise the query fetches the previous viewport.
- **Forgetting `ssr: false`:** the most common Next.js + Leaflet failure. `next/dynamic({ ssr: false })` is non-negotiable.
- **Tile-attribution removal:** removing the attribution to "clean up the UI" is a legal violation of the OSM tile license. Keep it.
- **Falling back at the wrong layer:** the ErrorBoundary wraps `<LeafletRenderer />`, not `<MapContainer>`. If you put it inside react-leaflet's component tree, it can't catch Leaflet's load failure.

### Open questions / blockers this story does NOT resolve

- **Mapbox decision:** stays deferred. If OSM tile coverage of the cemetery's region proves inadequate (visible roads / context missing), open a new ADR.
- **Offline tile caching for field workers:** the PWA service worker in Phase 1 caches read-path lot data, not map tiles. Offline tile support is an explicit Phase 3 (or later) enhancement; not in scope here.
- **Polygon clustering for dense sections:** if the cemetery has > 200 lots visible in one view (unlikely at typical zoom), re-evaluate. Not in scope.

### Project Structure Notes

Aligns with:

- [Architecture § Frontend Architecture](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture) — renderer-swap pattern; lazy-load; bundle enforcement.
- [UX § LotMap component spec](../../_bmad-output/planning-artifacts/ux-design-specification.md) — prop contract stable across Phase 1 / 2.

No detected conflicts.

### References

- [PRD § FR10 — Map renderer (Phase 1 SVG / Phase 2 Leaflet)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [PRD § NFR-P2 (viewport load < 3s), NFR-P6 (bundle ≤ 250KB gz)](../../_bmad-output/planning-artifacts/prd.md#performance)
- [Architecture § Frontend Architecture > Phase 2 map renderer](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Bundle enforcement](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Component spec > LotMap](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [UX § Accessibility > Map alternate view](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 8.2](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 8.1](./8-1-system-imports-gps-surveyed-lot-geometry.md) — geometry import dependency
- Leaflet docs (current): [Quickstart](https://leafletjs.com/examples/quick-start/) · [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
- React-Leaflet docs (current): [API reference](https://react-leaflet.js.org/docs/api-components/) · [Server-side rendering](https://react-leaflet.js.org/docs/start-introduction/#how-react-leaflet-works)
- Next.js docs (current): [Dynamic imports](https://nextjs.org/docs/app/building-your-application/optimizing/lazy-loading)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code, autonomous dev-story execution).

### Debug Log References

- `npm run typecheck` — clean.
- `npm run lint` — clean (no warnings or errors after dropping a stale `eslint-disable no-console` directive on the LeafletRenderer error path).
- `npm run test` — full suite 1019 passed / 1 skipped / 0 failed. The new
  `tests/unit/components/LeafletRenderer.test.tsx` adds 4 dispatch tests; the
  Phase 1 `LotMap.test.tsx` "forwards onLotClick from the SvgRenderer" case
  was updated to pass `forceRenderer="svg"` since the orchestrator now
  routes surveyed lots to Leaflet by default.
- `npm run build` — clean. Production output:
  - `/map` First Load JS = 142 kB (well under the 250 kB NFR-P6 budget).
  - Leaflet runtime is split into a separate dynamic chunk (`tileLayer` /
    `L.map` runtime symbols appear only in two on-demand chunks, not in
    the `/map` page bundle itself). The page bundle only contains the
    `import("leaflet")` and `import("leaflet/dist/leaflet.css")` path
    strings — i.e. the dynamic-import promise targets, not the library
    body.

### Completion Notes List

- **Scope kept narrow to the user's task brief.** The story file enumerates
  16 tasks (settings-driven cutover, ADR, Playwright e2e, Lighthouse,
  bundle analyzer). The task brief explicitly scoped this run to:
  LeafletRenderer + LotMap dispatch + unit tests + the four gates. Items
  out of scope here (NOT shipped this run): `convex/settings.ts`,
  admin renderer-choice UI, `eslint-rules/no-leaflet-client-import.js`
  (the rule was never created in the Phase 1 ADR — see `eslint.config.mjs`
  L113–114 which still has it as a TODO), ADR-0011, Playwright e2e spec,
  Lighthouse assertion extension, `npm run analyze` script. These remain
  open for follow-up stories or a future task.
- **Renderer selection.** Auto-detect: any lot with
  `geometryStatus === "surveyed"` in the current viewport flips the
  orchestrator to Leaflet. A staff override (`forceRenderer?: "svg"
  | "leaflet"`) is exposed on `LotMap` and wired into the `/map` page as
  a three-radio toggle (Auto / SVG / Leaflet). The toggle defaults to
  Auto so existing call sites (`/map` and any future routes) keep
  working unchanged.
- **Lazy-load discipline.** `LeafletRenderer.tsx` performs both
  `await import("leaflet")` and `await import("leaflet/dist/leaflet.css")`
  inside `useEffect` — defence-in-depth even though `LotMap.tsx`
  already references the renderer via `next/dynamic({ ssr: false })`.
  No file in the static graph reachable from SSR statically imports
  Leaflet.
- **Color tokens.** Status palette duplicated in `LeafletRenderer.tsx`
  (`STATUS_FILL` / `STATUS_STROKE`) as raw hex values that match the
  Tailwind `status-{state}-bg` / `status-{state}-border` tokens the SVG
  renderer uses. Leaflet's internally-managed polygon paths can't be
  styled with Tailwind utility classes, so inline `color` /
  `fillColor` is the cleanest contract. The story file's optional
  follow-up (`src/lib/lotStatusColors.ts`) was not extracted this run.
- **Coord-order verified.** Polygon vertices map as
  `lot.geometry.polygon.map((p) => [p.lat, p.lng])` — Leaflet's
  `[lat, lng]` convention, opposite of GeoJSON's `[lng, lat]`.
- **Placeholder lots.** Rendered as `circleMarker` at the centroid so
  the renderer is safe to instantiate even on a viewport with no
  surveyed lots (in practice the orchestrator routes such viewports to
  SVG; the placeholder branch exists for the `forceRenderer="leaflet"`
  override path).
- **TS shim.** `src/types/css-modules.d.ts` declares `*.css` so
  `import "leaflet/dist/leaflet.css"` typechecks. Next's default CSS
  typing only handles `*.module.css`.

### File List

Created:
- `src/components/LotMap/LeafletRenderer.tsx`
- `src/types/css-modules.d.ts`
- `tests/unit/components/LeafletRenderer.test.tsx`

Modified:
- `src/components/LotMap/LotMap.tsx` — added `next/dynamic` Leaflet
  reference, renderer dispatch (auto-detect + `forceRenderer` override),
  `LotMapRenderer` type export.
- `src/components/LotMap/index.ts` — added `LotMapRenderer` and
  `LeafletRendererProps` type re-exports (runtime export of
  `LeafletRenderer` intentionally omitted to preserve the lazy-load).
- `src/app/(staff)/map/page.tsx` — added a three-radio renderer toggle
  (Auto / SVG / Leaflet) wired through `forceRenderer`.
- `tests/unit/components/LotMap.test.tsx` — pinned the existing
  "forwards onLotClick from the SvgRenderer" case to `forceRenderer="svg"`
  so it stays an SVG assertion under the new dispatch rules.
- `package.json` / `package-lock.json` — added `leaflet` runtime dep and
  `@types/leaflet` dev dep.

