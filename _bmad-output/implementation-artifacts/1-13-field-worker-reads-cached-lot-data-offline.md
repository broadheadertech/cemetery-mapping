# Story 1.13: Field worker reads cached lot data offline

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Junior (Field Worker)**,
I want **lot data to remain readable on my phone even when I lose signal — with a clear "Cached 12m ago" / "Cached, may be outdated" indicator after 24 hours, and a hard block on any write attempt offline**,
so that **I can complete lot lookups behind the chapel or in low-coverage areas without waiting on a spinner, while financial integrity stays protected** (FR11, NFR-R6, UX-DR22).

This story implements the **hand-rolled service worker** that architecture § Frontend Architecture commits to (no `next-pwa` dependency). The SW caches the `/lots` list page, `/lots/<lotId>` detail pages, the Cmd-K palette static assets, and Convex query responses for these routes with a 24-hour staleness TTL. Write attempts (lot edits, condition logs from Story 1.14) are hard-blocked offline with a clear inline message — **no write queue, no eventual consistency, by deliberate UX-DR choice** (protects the financial invariants and avoids the queue-vs-server reconciliation complexity).

## Acceptance Criteria

1. **AC1 — Service worker registers in production only**: `src/lib/pwa.ts → registerServiceWorker()` is called from the staff layout (Story 1.5). It registers `src/sw.ts` (built via Next.js as `/sw.js` at deploy time — using a build-time generation script in this story) only when `process.env.NODE_ENV === "production"`. In `npm run dev`, the SW does NOT register. Verified by Playwright: dev-mode test asserts no `navigator.serviceWorker.controller`; production build test asserts the SW is active.

2. **AC2 — Cached routes + assets retrievable offline**: After a successful first visit to `/lots` and any `/lots/<id>` detail page (online), going offline (Playwright simulates via `context.setOffline(true)`) and navigating to the same URLs renders the cached HTML + cached Convex query responses. Specifically cached: `/lots`, `/lots/<lotId>` (any visited), `/dashboard` (Story 1.5), `LotSearchCommand` JS/CSS assets, `public/map/overlay-section-*.svg`, and the Convex query responses for `api.lots.listLots`, `api.lots.listInBbox`, `api.lots.getLotDetail`, `api.search.searchAll`.

3. **AC3 — Freshness indicator pill ("Cached 12m ago" / "Cached, may be outdated")**: A `<CacheFreshnessPill>` component renders at the top of every cached page when the data was served from cache instead of the network. Shows "Cached Xm ago" in amber for cached-within-24h, "Cached, may be outdated" in red for > 24h. Hidden when network-fresh. Reads the cache-write timestamp from the SW (forwarded via a `MessageChannel` from SW → client) or from `IndexedDB` (whichever is simpler — JSDoc the decision in the implementation). Per UX-DR22.

4. **AC4 — 24-hour staleness TTL**: When the SW serves a cached Convex query response, it checks the cache entry's `cachedAt` timestamp. If `now - cachedAt < 24h`, serve cache silently AND fire a stale-while-revalidate background fetch. If `≥ 24h`, serve cache (offline) or fetch fresh (online), and update the freshness pill to "may be outdated". Per NFR-R6.

5. **AC5 — Offline-write hard block**: Any `useMutation` call while `navigator.onLine === false` (or after a fetch fails with a network error) is intercepted by a `useNetworkAwareMutation` wrapper hook. The wrapper short-circuits, throws a `ConvexError({ code: "OFFLINE_WRITE_BLOCKED" })`, and the UI's error translator surfaces: "Posting requires connection. Reconnect and try again." The error never reaches the Convex server (saves a wasted request). All Phase 1 mutations (`createLot`, `updateLot`, `retireLot`, `setLotStatusReserved`, future `logLotCondition` in Story 1.14) wrap their `useMutation` call with `useNetworkAwareMutation`.

6. **AC6 — Cache version tied to Convex deploy ID**: Cache key includes a version derived from `process.env.NEXT_PUBLIC_CONVEX_DEPLOYMENT_ID` (or `NEXT_PUBLIC_BUILD_ID` if Convex doesn't expose deploy ID at build time). On Convex schema change → new deploy → new cache version → old cache evicted. Prevents stale-schema cache hits after a breaking schema migration. Documented in `docs/adr/0011-pwa-service-worker.md`.

## Tasks / Subtasks

### Service worker implementation (AC1, AC2, AC4, AC6)

- [x] **Task 1: Create `src/sw.ts` — hand-rolled service worker** (AC: 1, AC: 2, AC: 4, AC: 6)
  - [ ] Architecture commits to ~100 lines, no `next-pwa` dependency. Implement:
    - `const CACHE_VERSION = "v1-" + (process.env.NEXT_PUBLIC_BUILD_ID ?? "dev")` — set at build time.
    - `const CACHE_NAME_STATIC = "cm-static-" + CACHE_VERSION`
    - `const CACHE_NAME_DATA = "cm-data-" + CACHE_VERSION` — for Convex query responses with TTL.
    - `install` event: pre-cache `["/lots", "/dashboard"]` and `/map/overlay-section-*.svg` (loaded from `/map/manifest.json` — Story 1.12).
    - `activate` event: delete caches whose version != CACHE_VERSION; claim clients.
    - `fetch` event:
      - For navigations (`event.request.mode === "navigate"`) matching `/lots`, `/lots/*`, `/dashboard`: stale-while-revalidate from `CACHE_NAME_STATIC`.
      - For Convex query POSTs to `/_convex/api/query` (or whatever the Convex SDK's actual endpoint is — verify at implementation time): match on request body's function path; cache successful responses with `{ data: response, cachedAt: Date.now() }` payload in `CACHE_NAME_DATA`; on read, check `now - cachedAt < 24h` policy.
      - For static assets matching `/map/`, `/_next/static/`, `/icons/`: cache-first.
      - For all other requests: network-first with cache fallback for navigation requests only.
  - [ ] Build step: Next.js doesn't bundle `src/sw.ts` by default. Add a build script `scripts/build-sw.ts` that uses `esbuild` to bundle `src/sw.ts` → `public/sw.js` (so it's served at root scope, required for SW registration). Run in `package.json`'s `build` script: `"build": "next build && tsx scripts/build-sw.ts"`.
  - [ ] **Decision (document in ADR)**: bundle SW with esbuild (one-line invocation, < 30 LOC build script), not via webpack plugin chains. Architecture's "no `next-pwa`" lock supports.

- [x] **Task 2: Create `src/lib/pwa.ts → registerServiceWorker()`** (AC: 1) — registration mounted on `/lots` page via `<ServiceWorkerBootstrap>` instead of `(staff)/layout.tsx` (forbidden file this sprint).
  - [ ] Exports:
    ```ts
    export function registerServiceWorker() {
      if (typeof window === "undefined") return;
      if (process.env.NODE_ENV !== "production") return;
      if (!("serviceWorker" in navigator)) return;
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(err => console.warn("SW reg failed", err));
      });
    }
    ```
  - [ ] Also exports `unregisterServiceWorker()` for cleanup during testing.
  - [ ] In `src/app/(staff)/layout.tsx` (Story 1.5), call `registerServiceWorker()` once on mount (`useEffect(() => registerServiceWorker(), [])`).

- [x] **Task 3: Cache versioning + Convex deploy ID** (AC: 6)
  - [ ] In `next.config.ts`, expose `NEXT_PUBLIC_BUILD_ID` (Vercel sets this automatically; for local dev, fall back to a hash of `package.json`'s version). Inject into SW build via esbuild's `--define` flag.
  - [ ] Document the versioning policy in `docs/adr/0011-pwa-service-worker.md`: "Cache version is build-id-derived. Convex schema migrations bump build ID via the deploy step. Old caches evicted on `activate`."

### Freshness pill (AC3, AC4)

- [x] **Task 4: Create `<CacheFreshnessPill>` component** (AC: 3, AC: 4)
  - [ ] `src/components/CacheFreshnessPill/CacheFreshnessPill.tsx`:
    - Props: none — reads cache state from the `useCacheStatus()` hook (Task 5).
    - Renders: nothing when status is `"online"`; `<div className="bg-status-cached-bg text-status-cached-text">Cached {minutes}m ago</div>` for `"cached-fresh"`; `<div className="bg-red-50 text-red-700">Cached, may be outdated</div>` for `"cached-stale"`.
    - Tailwind tokens for `--status-cached-bg` / `--status-cached-text` added to `tailwind.config.ts` per Story 1.4's pattern (amber-100 / amber-800 in light; outdoor-mode adjusted).

- [x] **Task 5: Create `useCacheStatus()` hook** (AC: 3, AC: 4) — shipped as `useOfflineCache()` in `src/hooks/useOfflineCache.ts` per the ownership rules; surface and semantics are identical. Pill is rendered from `<ServiceWorkerBootstrap>` on `/lots` (not in the staff layout, which is owned by another story this sprint).
  - [ ] `src/hooks/useCacheStatus.ts`:
    - Returns `{ status: "online" | "cached-fresh" | "cached-stale", cachedAt?: number, ageMs?: number }`.
    - Listens to `online` / `offline` window events.
    - Listens to a `message` event from the service worker — the SW posts `{ type: "served-from-cache", cachedAt }` when it returns a cached response for a navigation.
    - Maintains state via `useState`; refreshes the displayed age every 60s via `setInterval`.
  - [ ] In `src/app/(staff)/layout.tsx`, render `<CacheFreshnessPill>` at the very top of the staff layout's main content area (sticky-positioned per UX § System Banner Pattern).

### Offline-write hard block (AC5)

- [x] **Task 6: Create `useNetworkAwareMutation` wrapper hook** (AC: 5) — `convex/lib/errors.ts` update (defense-in-depth code) skipped because the convex tree is on the forbidden list this sprint. Client-side `OFFLINE_WRITE_BLOCKED` constant + translation are in place.
  - [ ] `src/hooks/useNetworkAwareMutation.ts`:
    ```ts
    export function useNetworkAwareMutation<Args, Result>(
      mutation: FunctionReference<"mutation", "public", Args, Result>,
    ): (args: Args) => Promise<Result> {
      const mut = useMutation(mutation);
      return async (args: Args) => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          throw new ConvexError({ code: "OFFLINE_WRITE_BLOCKED", message: "Posting requires connection. Reconnect and try again." });
        }
        return mut(args);
      };
    }
    ```
  - [ ] Add `OFFLINE_WRITE_BLOCKED: "OFFLINE_WRITE_BLOCKED"` to `convex/lib/errors.ts` constants (so server can throw it too if a request slips through — defense in depth).
  - [ ] Add translation to `src/lib/errors.ts` (Story 1.5)'s `translateError`: `OFFLINE_WRITE_BLOCKED → "Posting requires connection. Reconnect and try again."`.

- [x] **Task 7: Wrap all Phase 1 mutations with `useNetworkAwareMutation`** (AC: 5) — partial. `retireLot` on `/lots` is wrapped. `createLot` (`/lots/new`) and `updateLot` (`/lots/[lotId]/edit`) wraps deferred: those page files are on this run's forbidden list. `translateError` already maps the code, so the wrap is a one-line change at each call site when the owner re-opens those files.
  - [ ] Find all `useMutation(api.X.Y)` call sites in Story 1.8's lot pages (`/lots/new`, `/lots/[lotId]/edit`, `/lots` list with retire button). Replace `useMutation` → `useNetworkAwareMutation`.
  - [ ] **Note for Story 1.14**: when the condition-log mutation lands, it must also use `useNetworkAwareMutation`. Add a `TODO: wrap with useNetworkAwareMutation` comment in `LotDetail.tsx` next to the disabled "Log condition" button slot (Story 1.11).
  - [ ] Defense-in-depth: ESLint rule (deferred — file as TODO for Story 5.x) that fails the build if a `useMutation` is called without `useNetworkAwareMutation` wrapping.

### Service worker tests (AC1, AC2, AC4, AC5)

- [x] **Task 8: SW unit tests** (AC: 1, AC: 4) — `tests/unit/sw/sw.test.ts` exercises install/activate/fetch handler registration, cache-version eviction, never-cache prefix list, navigation interception, and the 24h TTL constant alignment between SW and client.
  - [ ] Create `tests/unit/sw.test.ts`. Use `@vitest/web-worker` or a custom fetch-event mock harness. Cover:
    - 24h TTL: a cache entry with `cachedAt: Date.now() - 23h` → served as fresh; `cachedAt: Date.now() - 25h` → served as stale.
    - `activate` event evicts old cache versions.
    - `install` event pre-caches the listed URLs.
    - Convex query interception: a POST matching the Convex endpoint stores the response with a `cachedAt` field.

- [x] **Task 9: `useNetworkAwareMutation` test** (AC: 5)
  - [ ] `tests/unit/hooks/useNetworkAwareMutation.test.ts`. Mock `navigator.onLine`. Confirm offline → throws OFFLINE_WRITE_BLOCKED without calling the underlying mutation. Online → passes through.

- [x] **Task 10: Playwright e2e** (AC: 1, AC: 2, AC: 3, AC: 5) — spec written at `tests/e2e/offline-mode.spec.ts` but marked `test.describe.skip` pending seeded-Convex + logged-in-staff fixtures (lands with Story 1.10 / 3.x integration runbook). Manual repro steps inline.
  - [ ] Create `tests/e2e/offline-read.spec.ts`. Build production assets first (`npm run build`). Use Playwright's `context.setOffline(true)` after a first online visit. Steps:
    - Office Staff logs in, visits `/lots`, sees lots (online).
    - Visits `/lots/<id>` for one lot.
    - Set offline. Reload `/lots` → page renders from cache, `<CacheFreshnessPill>` shows "Cached Xm ago".
    - Navigate to the same `/lots/<id>` → renders from cache.
    - Try to click "Edit" → page opens but the underlying mutation hard-blocks with OFFLINE_WRITE_BLOCKED message.
    - Back online: pill disappears, mutations succeed.
  - [ ] **Dev mode test** (separate spec or assertion): run against `npm run dev`; assert no `navigator.serviceWorker.controller`.

### Documentation (AC1, AC6)

- [x] **Task 11: ADR** (AC: 1, AC: 6) — filed as `docs/adr/0009-offline-cache-strategy.md` (next free ADR integer; the story's suggested "0011" predated the gap-numbering reality).
  - [ ] Write `docs/adr/0011-pwa-service-worker.md`. Cover: hand-rolled vs next-pwa (architecture lock); cache versioning policy; 24h TTL rationale (NFR-R6); offline-write hard-block rationale (financial integrity over offline ergonomics); SW build pipeline (esbuild script); production-only registration.

- [x] **Task 12: Manifest + icons** (AC: 1) — manifest shipped, placeholder SVG icons shipped. `<link rel="manifest">` in `src/app/layout.tsx` deferred (root layout is on the forbidden list this sprint).
  - [ ] `public/manifest.webmanifest` per architecture § Project Structure (PWA manifest slot). Minimal: `{ name, short_name, start_url: "/dashboard", display: "standalone", background_color, theme_color, icons: [...] }`.
  - [ ] Generate icon set (192px, 512px) — placeholder cemetery-mapping logo; client supplies real icons later. Document in `public/icons/README.md`.
  - [ ] Link manifest from `src/app/layout.tsx` via `<link rel="manifest" href="/manifest.webmanifest" />`.

## Dev Notes

### Previous story intelligence

**Story 1.1 produced:** `next.config.ts`, `package.json`, `.github/workflows/ci.yml` — this story extends the build script + adds `tsx` / `esbuild` dev deps for the SW build pipeline.

**Story 1.2 produced:** `ErrorCode` constants — this story adds `OFFLINE_WRITE_BLOCKED`.

**Story 1.4 produced:** Tailwind tokens + outdoor mode — this story adds `--status-cached-bg` / `--status-cached-text` tokens.

**Story 1.5 produced:** `(staff)/layout.tsx`, `translateError` — this story adds `registerServiceWorker()` to the layout's mount effect; extends `translateError` with OFFLINE_WRITE_BLOCKED.

**Story 1.8 produced:** mutations in lot pages — this story wraps them with `useNetworkAwareMutation`.

**Story 1.9 produced:** `listInBbox` — this query's responses are cached by the SW.

**Story 1.10 produced:** Cmd-K palette assets — cached by the SW.

**Story 1.11 produced:** `/lots/[lotId]/page.tsx` + `getLotDetail` — page HTML + query response cached.

**Story 1.12 produced:** `/lots` map page, `public/map/overlay-*.svg` overlays, manifest at `public/map/manifest.json` — overlays cached as static assets; manifest tells the SW which overlays to pre-cache on install.

**Story 1.14 (next):** lot condition log mutation will use `useNetworkAwareMutation` — `TODO` comments dropped now.

### Architecture compliance

- **Hand-rolled SW, not `next-pwa`** per architecture § Frontend Architecture > PWA / service worker. ADR-0011 documents.
- **`src/sw.ts`** slotted in architecture § Project Structure.
- **`src/lib/pwa.ts`** slotted in architecture § Project Structure.
- **Production-only registration** per architecture decision (also a UX-DR — dev SW interferes with HMR).
- **24h staleness TTL** per NFR-R6.
- **No offline writes** per architecture § Atomic mutation pattern — financial integrity invariants don't survive offline write queues. Hard block is by design, not a limitation.
- **Cache versioning tied to deploy ID** — architecture § PWA service worker section's "cache versioning tied to Convex deploy ID."
- **No `next-pwa` import** — Story 5.x's deferred lint rule will catch regressions. For now, no `package.json` entry.

### Library / framework versions (current)

- **`esbuild`** — install as devDependency: `npm install --save-dev esbuild tsx`. Used by `scripts/build-sw.ts` to bundle `src/sw.ts` → `public/sw.js`.
- **`tsx`** — TypeScript script runner (already installed as a transitive dep of Next.js; verify; if missing, add).
- **No service-worker libraries** — vanilla `addEventListener("fetch", ...)`, `caches.open`, `caches.match`.
- **`@vitest/web-worker`** (optional for SW testing) — install if Task 8's test approach uses it; otherwise mock fetch events manually.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── lib/
│       └── errors.ts                                  # UPDATE (add OFFLINE_WRITE_BLOCKED)
├── src/
│   ├── sw.ts                                          # NEW (hand-rolled service worker source)
│   ├── lib/
│   │   ├── pwa.ts                                     # NEW (registerServiceWorker, unregisterServiceWorker)
│   │   └── errors.ts                                  # UPDATE (translate OFFLINE_WRITE_BLOCKED)
│   ├── hooks/
│   │   ├── useNetworkAwareMutation.ts                 # NEW
│   │   └── useCacheStatus.ts                          # NEW
│   ├── components/
│   │   └── CacheFreshnessPill/
│   │       ├── CacheFreshnessPill.tsx                 # NEW
│   │       ├── CacheFreshnessPill.test.tsx            # NEW
│   │       └── index.ts                               # NEW
│   ├── app/(staff)/
│   │   └── layout.tsx                                 # UPDATE (registerServiceWorker on mount; render CacheFreshnessPill)
│   └── app/
│       └── layout.tsx                                 # UPDATE (link <link rel="manifest"> + theme color meta)
├── scripts/
│   └── build-sw.ts                                    # NEW (esbuild script to bundle src/sw.ts → public/sw.js)
├── public/
│   ├── manifest.webmanifest                           # NEW
│   ├── icons/
│   │   ├── icon-192.png                               # NEW (placeholder)
│   │   ├── icon-512.png                               # NEW (placeholder)
│   │   └── README.md                                  # NEW (client supplies real icons)
│   └── sw.js                                          # GENERATED (built by build-sw.ts; gitignored)
├── tests/
│   ├── unit/
│   │   ├── sw.test.ts                                 # NEW
│   │   └── hooks/
│   │       ├── useNetworkAwareMutation.test.ts        # NEW
│   │       └── useCacheStatus.test.ts                 # NEW
│   └── e2e/
│       └── offline-read.spec.ts                       # NEW (requires production build)
├── package.json                                       # UPDATE (add esbuild devDep; extend "build" script)
├── next.config.ts                                     # UPDATE (expose NEXT_PUBLIC_BUILD_ID to SW build)
├── .gitignore                                         # UPDATE (add public/sw.js)
└── docs/adr/
    └── 0011-pwa-service-worker.md                     # NEW
```

### Testing requirements

- **NFR-M2 (≥ 90% on financial-touching) APPLIES indirectly** — `useNetworkAwareMutation` gates every financial mutation. Target ≥ 95% on the hook + ≥ 90% on `src/sw.ts` core paths (install / activate / fetch handler branches).
- **Playwright requires a production build** to register the SW. Add a `playwright.config.ts` `webServer` variant that runs `npm run build && npm run start` for the offline spec. Mark the spec with `test.describe.configure({ mode: 'serial' })`.
- **Lighthouse PWA score**: Lighthouse mobile audit asserts "Installable" + "PWA optimized" passes (Story 1.1's `lighthouserc.json` already runs Lighthouse; extend the config to assert PWA category ≥ 0.9).

### Source references

- **PRD:** [FR11 (offline read)](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping); [NFR-R6 (24h staleness)](../../_bmad-output/planning-artifacts/prd.md#reliability--availability)
- **Architecture:** [§ Frontend Architecture > PWA / service worker](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture); [§ Project Structure > src/sw.ts + src/lib/pwa.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- **UX:** [§ Defining Decisions > UX-DR22 (cached freshness indicator)](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Field-worker mobile experience](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ System Banner Pattern](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 1.13](../../_bmad-output/planning-artifacts/epics.md#story-113-field-worker-reads-cached-lot-data-offline)
- **Previous stories:** [1.5 layout + translateError](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md), [1.8 lot mutations](./1-8-office-staff-creates-and-edits-lot-records.md), [1.9 listInBbox](./1-9-schema-ready-lot-geometry-from-day-one.md), [1.11 detail page + getLotDetail](./1-11-office-staff-views-any-lots-detail.md), [1.12 map overlays + manifest](./1-12-phase-1-svg-map-renders-lots-with-status-filters.md)
- MDN: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT install `next-pwa`.** Architecture explicitly rejects it. Hand-roll the SW per ADR-0011.
- ❌ **Do NOT register the SW in development.** Dev SW intercepts HMR + breaks Convex dev replay. Production-only.
- ❌ **Do NOT queue offline writes.** Hard block via `useNetworkAwareMutation`. UX-DR + architecture lock. Queue → reconciliation logic → divergent client state → financial bug surface area.
- ❌ **Do NOT cache mutation responses.** Only queries (GETs and Convex query POSTs). Mutations must always hit the network.
- ❌ **Do NOT cache the login page or auth state.** Auth must be live. Add `/login`, `/api/auth/*` to the SW's no-cache list.
- ❌ **Do NOT serve stale data for > 24h without the "may be outdated" pill.** NFR-R6 is explicit. The pill must escalate at the 24h mark.
- ❌ **Do NOT forget cache versioning.** Without `CACHE_VERSION` tied to build ID, schema migrations leave clients on broken caches. The `activate` event evicts old versions.
- ❌ **Do NOT cache cross-origin requests** (Convex's `*.convex.cloud` is cross-origin from `*.vercel.app`). Be careful with the fetch handler's URL filter — only cache same-origin OR explicit Convex-allowlist URLs.
- ❌ **Do NOT use `clients.claim()` without versioning** — the SW must not steal control of pages running an older app version mid-session. The `activate` flow + page reload handles this.
- ❌ **Do NOT cache the dashboard's KPI data** beyond 24h — financial summaries served from a 2-day-old cache misleads. KPI dashboard's queries are fast-network-only; SW skips them.
- ❌ **Do NOT skip the production-build test path.** Playwright must run against `npm run build && npm run start`, not `npm run dev`. The SW is invisible in dev.
- ❌ **Do NOT commit `public/sw.js`** — it's a build artifact. Add to `.gitignore`. The source is `src/sw.ts`.

### Common LLM-developer mistakes to prevent

- **Service worker scope:** registering `/sw.js` controls everything from root scope `/`. If you serve it from `/_next/static/sw.js`, scope is limited. The build script must copy to `/public/sw.js` so it's at root.
- **`event.respondWith` async timing:** must be called synchronously within the fetch handler, even if the response itself is async. Pattern: `event.respondWith((async () => { ... })())`.
- **Caching POST requests:** by default `caches.match` doesn't match POST. The Convex query interceptor must keyByURL+request-body-hash. Use `request.clone().text()` to get the body for hashing.
- **stale-while-revalidate vs cache-first:** for navigations, prefer stale-while-revalidate (fast load + refresh in background). For data, 24h-bounded stale-while-revalidate is correct.
- **`navigator.onLine` is not 100% reliable.** It returns `true` even when DNS is broken. The SW catches fetch failures too (try/catch on `fetch(...)`) and falls back to cache. `useNetworkAwareMutation` uses `navigator.onLine` as a fast pre-check; the server-side `requireRole` failure is the defense-in-depth.
- **`useEffect(() => registerServiceWorker())` without empty deps:** infinite re-register loop. Always `useEffect(..., [])`.
- **Convex query path detection:** Convex's React SDK calls a specific endpoint (likely `/_convex/query` or via WebSocket). Verify in dev tools at implementation time. If WebSocket, intercept differently — likely cache only HTTP requests.
- **`new Response(body)` with cloned body:** `response.clone()` is needed before reading the body in the SW, because once read, the body is consumed.
- **Cache name collisions across multiple deploys:** including the build ID prevents two simultaneous deploys (preview + production) from sharing a cache and serving the wrong assets.
- **`<link rel="manifest">` not in `<head>`:** must be in the root layout's `<head>`. Next.js App Router uses `metadata` export OR direct `<head>` in `layout.tsx`. Verify.

### Open questions / blockers this story does NOT resolve

- **Photo uploads while offline:** Story 1.14's condition log has a photo field. Hard block applies — user can't submit a condition log without signal. Documented in this story's ADR + Story 1.14's mutation will wrap.
- **Background sync:** not in Phase 1 scope. No write queue, no background sync.
- **Push notifications:** not in Phase 1 scope. PWA manifest doesn't request notification permission.
- **Real icons + branding:** client supplies; placeholders ship.

### Project Structure Notes

Aligns with [architecture.md § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `src/sw.ts`, `src/lib/pwa.ts`, `public/manifest.webmanifest` all slotted.

No detected conflicts.

### References

- [PRD § FR11, § NFR-R6](../../_bmad-output/planning-artifacts/prd.md#2-lot-inventory--mapping)
- [Architecture § Frontend Architecture > PWA](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Project Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [UX § UX-DR22](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 1.13](../../_bmad-output/planning-artifacts/epics.md#story-113-field-worker-reads-cached-lot-data-offline)
- [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.11](./1-11-office-staff-views-any-lots-detail.md), [Story 1.12](./1-12-phase-1-svg-map-renders-lots-with-status-filters.md)
- MDN: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- Typecheck: `npm run typecheck` → clean (after switching `useNetworkAwareMutation` to the `OptionalRestArgs<Mutation>` shape so the inner `useMutation` call typechecks against Convex's `ReactMutation` signature).
- Lint: `npm run lint` → clean (removed an unused `// eslint-disable-next-line no-console` directive in `src/lib/pwa.ts`).
- Tests: `npm test -- --run` → 468 passed, 1 skipped (pre-existing `convex/lots.perf.test.ts` skip), 0 failed. New suites: `tests/unit/sw/sw.test.ts`, `tests/unit/lib/offline-cache.test.ts`, `tests/unit/lib/network-state.test.ts`, `tests/unit/lib/pwa.test.ts`, `tests/unit/hooks/useNetworkState.test.tsx`, `tests/unit/hooks/useNetworkAwareMutation.test.tsx`, `tests/unit/components/CacheFreshnessPill/CacheFreshnessPill.test.tsx`.
- Build: `npm run build` → next build OK + `build:sw` produced `public/sw.js` (2.9 KB minified, BUILD_ID stamped from env).
- Vitest gotcha: `process.env.NODE_ENV` cannot be reassigned under Vitest 2.x; tests use `vi.stubEnv("NODE_ENV", "production")` instead.

### Completion Notes List

- **AC1 (production-only registration)** — `src/lib/pwa.ts → registerServiceWorker()` is the single entry. Gated on `NODE_ENV === "production"` and `"serviceWorker" in navigator`. Unit-tested across all three branches in `tests/unit/lib/pwa.test.ts`.
- **AC2 / AC4 (cache + 24h TTL)** — `src/sw.ts` runs three handlers (install / activate / fetch). Navigation responses use stale-while-revalidate keyed on `CACHE_NAME_STATIC`; Convex query POSTs cache by `url + sha256(body)` into `CACHE_NAME_DATA` and stamp the response with an `x-cm-cached-at` header. Reads classify against `STALENESS_TTL_MS = 24h` and post a `served-from-cache` message to clients with `stale: boolean`.
- **AC3 (freshness pill)** — `<CacheFreshnessPill>` renders a sticky amber bar for "Cached Xm ago" or red bar for "Cached, may be outdated". Hidden when the SW has not reported any cached read. Source: `src/hooks/useOfflineCache.ts → src/lib/offline-cache.ts`.
- **AC5 (offline-write hard block)** — `useNetworkAwareMutation` wraps `useMutation` and throws `ConvexError({ code: "OFFLINE_WRITE_BLOCKED" })` while `navigator.onLine === false`. The `retireLot` mutation on `/lots` is wrapped. **Deferred:** the `createLot` mutation in `/lots/new/page.tsx` and the `updateLot` mutation in `/lots/[lotId]/edit/page.tsx` — those files are owned by Story 1.8 this sprint per the ownership rules in this run; the wrap lands in a 1.13 follow-up ticket. `translateError` already maps `OFFLINE_WRITE_BLOCKED` so adopting the wrap is a one-line change at each call site.
- **AC6 (build-id cache versioning)** — `next.config.ts` resolves `NEXT_PUBLIC_BUILD_ID` from env (Vercel / GitHub Actions) and the SW build script (`scripts/build-sw.mjs`) injects it via esbuild's `--define`. `activate` evicts any `cm-static-*` / `cm-data-*` cache whose version isn't current. Unit-tested in `tests/unit/sw/sw.test.ts`.
- **Layout-level integration (deferred)** — Task 5 + the story file structure place `<CacheFreshnessPill>` and `registerServiceWorker()` in `src/app/(staff)/layout.tsx`. That file is on this run's forbidden list (Story 1.5 owner). Instead, `<ServiceWorkerBootstrap>` (in `src/components/NetworkIndicator/`) is rendered from `src/app/(staff)/lots/page.tsx` so the SW registers on the field worker's primary landing page. Once Story 1.5's owner re-opens the layout, the bootstrap moves up one level (documented in ADR-0009 + the bootstrap component's JSDoc).
- **MobileTopBar integration** — `MobileTopBar`'s `[data-network-state]` placeholder is targeted via `createPortal` from `<NetworkIndicator>` so no MobileTopBar source edit is needed (component is on the forbidden list).
- **Manifest link in `<head>`** — `public/manifest.webmanifest` ships with placeholder SVG icons. The `<link rel="manifest">` in `src/app/layout.tsx` is deferred (root layout is on the forbidden list). The manifest is still discoverable via direct URL and the SW serves it as a static asset.
- **E2E spec** — `tests/e2e/offline-mode.spec.ts` is written but `test.describe.skip`'d. It requires a seeded Convex deployment + logged-in staff session, which lands with the Story 1.10/3.x integration fixtures. The skip keeps the file present for future un-skip; manual repro steps are documented inline.
- **No `next-pwa` dependency added.** SW is bundled by esbuild (already a transitive dep, now pinned as a direct devDep at `^0.27.0`).
- **`public/sw.js` is a build artifact** and is gitignored. Source lives at `src/sw.ts`.
- **ADR-0009** (not 0011 as the story suggested — 0007/0008 are unallocated, but 0009 is the next free integer given existing ADRs 0001/0002/0004/0006) documents the full strategy.

### File List

**Created:**

- `src/sw.ts` — hand-rolled service worker source.
- `scripts/build-sw.mjs` — esbuild bundler script for the SW.
- `src/lib/pwa.ts` — `registerServiceWorker()` / `unregisterServiceWorker()`.
- `src/lib/sw-register.ts` — re-export shim.
- `src/lib/network-state.ts` — `readNetworkState`, `subscribeToNetworkState`.
- `src/lib/offline-cache.ts` — `classifyCacheAge`, `formatCacheAge`, `isServedFromCacheMessage`, `STALENESS_THRESHOLD_MS`.
- `src/hooks/useNetworkState.ts` — React hook for online/offline state.
- `src/hooks/useOfflineCache.ts` — React hook surfacing the SW's cache state.
- `src/hooks/useNetworkAwareMutation.ts` — `useMutation` wrapper enforcing the offline-write hard block.
- `src/components/CacheFreshnessPill/CacheFreshnessPill.tsx` + `index.ts` — the sticky freshness banner.
- `src/components/NetworkIndicator/NetworkIndicator.tsx` — pill that portals into MobileTopBar's slot.
- `src/components/NetworkIndicator/ServiceWorkerBootstrap.tsx` + `index.ts` — registers SW + renders pill/indicator on mount.
- `public/manifest.webmanifest` — PWA manifest.
- `public/icons/icon-192.svg`, `public/icons/icon-512.svg`, `public/icons/README.md` — placeholder icon set.
- `docs/adr/0009-offline-cache-strategy.md` — ADR documenting the strategy.
- `tests/unit/sw/sw.test.ts` — SW lifecycle + fetch-handler unit tests.
- `tests/unit/lib/offline-cache.test.ts` — cache-age classifier tests.
- `tests/unit/lib/network-state.test.ts` — `readNetworkState` / `subscribeToNetworkState` tests.
- `tests/unit/lib/pwa.test.ts` — `registerServiceWorker` production-only gate tests.
- `tests/unit/hooks/useNetworkState.test.tsx` — React hook test.
- `tests/unit/hooks/useNetworkAwareMutation.test.tsx` — offline-write block test.
- `tests/unit/components/CacheFreshnessPill/CacheFreshnessPill.test.tsx` — pill render tests.
- `tests/e2e/offline-mode.spec.ts` — e2e spec (`test.describe.skip` pending seed fixtures).

**Modified:**

- `src/app/(staff)/lots/page.tsx` — wraps `retireLot` with `useNetworkAwareMutation`, renders `<ServiceWorkerBootstrap>`, and surfaces an offline banner. Imports `useNetworkState`.
- `src/lib/errors.ts` — adds `OFFLINE_WRITE_BLOCKED` to `CLIENT_ERROR_CODES` and its `MESSAGES` entry.
- `package.json` — adds `esbuild` devDep + `build:sw` script + chains `build:sw` onto `build`.
- `next.config.ts` — exposes `NEXT_PUBLIC_BUILD_ID` to the client; adds cache-control headers for `/sw.js` (no-cache) and `/manifest.webmanifest`.
- `.gitignore` — ignores `public/sw.js` and its sourcemap.

### Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-18 | Story 1.13 implemented: hand-rolled service worker, offline cache with 24h TTL, freshness pill, offline-write hard block. ADR-0009 written. 32 new unit tests; build + lint + typecheck clean. E2E spec written and skipped pending seed fixtures. Layout-level integration (CacheFreshnessPill in `(staff)/layout.tsx`) and root-layout manifest link deferred — owner of `src/app/(staff)/layout.tsx` + `src/app/layout.tsx` to fold the bootstrap one level up. | claude-opus-4-7 via Claude Code BMAD bmad-dev-story |
