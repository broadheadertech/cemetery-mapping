# ADR 0009: PWA service worker, offline cache strategy, and hard-blocked offline writes

- **Status:** Accepted
- **Date:** 2026-05-18
- **Story:** 1.13

## Context

Field workers (Junior persona) walk the Memorial Park's 2,000+ lot grid with phones whose signal drops behind the chapel and along the perimeter wall. The PRD's **FR11** commits to readable lot data without a live connection, **NFR-R6** caps acceptable staleness at 24 hours, and **UX-DR22** mandates a freshness indicator pill so the user is never confused about whether they're looking at live or cached data.

At the same time, the architecture's atomic-mutation lock (single Convex mutation = one financial unit of work) and the BIR-receipt invariants make offline *writes* a non-starter:

- A queued offline write that reconciles against the server later could break receipt-serial allocation (Story 3.1) or contract state transitions (Stories 1.7 / 3.6).
- Eventual-consistency UX confuses users about whether a payment "landed."
- Phase 1 has no write conflict-resolution UI to lean on.

We need an offline strategy that protects the financial invariants while still letting the field worker do their lookup-driven job.

## Decision

### 1. Hand-rolled service worker, no `next-pwa`

The service worker source lives at `src/sw.ts` and is bundled to `public/sw.js` by `scripts/build-sw.mjs` (esbuild, ~50 LOC of build script). We deliberately do **not** depend on `next-pwa`:

- The architecture's "PWA / service worker" section vetoes it.
- Our SW is ~250 LOC of vanilla `addEventListener` / `caches.open` — no plugin chain needed.
- We control cache-version semantics precisely; off-the-shelf plugins force a versioning policy.

### 2. Three-cache split keyed by build ID

```
cm-static-v1-<BUILD_ID>   navigation HTML + assets (cache-first / stale-while-revalidate)
cm-data-v1-<BUILD_ID>     Convex query POST responses (24h stale-while-revalidate)
```

`BUILD_ID` is `NEXT_PUBLIC_BUILD_ID` → `VERCEL_GIT_COMMIT_SHA` → `GITHUB_SHA` → `local-dev`. New deploy → new version → old caches evicted on the next `activate`. The eviction loop preserves any cache name that doesn't match the `cm-static-` / `cm-data-` prefixes (so unrelated browser caches survive).

### 3. 24-hour staleness TTL

Cache entries carry an `x-cm-cached-at` response header with the write timestamp (storing it as a header keeps the body intact and survives `caches.match`). On read:

- `age < 24h` → serve cache silently, fire a background re-fetch (stale-while-revalidate).
- `age ≥ 24h` → serve cache, **post a `served-from-cache` message with `stale: true`** so the freshness pill flips to red.

`STALENESS_THRESHOLD_MS = 24 * 60 * 60 * 1000` is duplicated in `src/lib/offline-cache.ts` (client) and `src/sw.ts` (worker) because the worker is a separate compilation unit. The unit test in `tests/unit/sw/sw.test.ts` pins the two values together.

### 4. Production-only registration

`registerServiceWorker()` is a no-op when `process.env.NODE_ENV !== "production"`. Dev SW intercepts HMR and breaks the Convex dev replay loop. The Playwright dev-mode assertion (skipped in this run pending seed fixtures) confirms `navigator.serviceWorker.controller === null` against `npm run dev`.

### 5. Never-cache prefixes

`/login`, `/api/auth`, `/api/convex-auth`, `/_convex/auth` bypass the SW unconditionally. Auth state must always be live; serving a cached login response is a user-confusion vector with security implications.

### 6. Offline-write hard block

`useNetworkAwareMutation` wraps `useMutation` from `convex/react`. While `navigator.onLine === false` it throws `ConvexError({ code: "OFFLINE_WRITE_BLOCKED" })` BEFORE dispatching the request. `translateError` maps the code to "Posting requires connection. Reconnect and try again." No queue, no background sync, no eventual consistency.

The hook is API-compatible with `useMutation` — adopting it is a single-line edit. The story applies it to the `retireLot` mutation on the `/lots` list page. Adoption in `lots/new` and `lots/[lotId]/edit` is deferred because those page files are owned by Story 1.8 this sprint; their wrap lands in a follow-up Story 1.13.1 ticket.

### 7. UX surface

Two components consume the cache state:

- **`<CacheFreshnessPill>`** — a sticky banner at the top of cached pages, showing "Cached Xm ago" (amber) or "Cached, may be outdated" (red).
- **`<NetworkIndicator>`** — a small pill that portals into `MobileTopBar`'s `data-network-state` placeholder, showing "Offline" / cached state. Uses `createPortal` so MobileTopBar's component source doesn't need to change.

Both are rendered by `<ServiceWorkerBootstrap>` on `/lots`. The bootstrap moves into `(staff)/layout.tsx` in a follow-up once Story 1.5's owner re-opens that file.

## Consequences

- **Positive:** Field workers can read lot data without signal, with an explicit freshness banner that escalates after 24h.
- **Positive:** Financial integrity invariants survive — there is no write queue to reconcile.
- **Positive:** Hand-rolled SW keeps the dependency surface tight; no `next-pwa` upgrade treadmill.
- **Positive:** Cache versioning ties to the build ID so a Convex schema migration evicts old caches automatically.
- **Negative:** Two duplicate copies of `STALENESS_THRESHOLD_MS` (client + worker). Unit tests pin them; documented above.
- **Negative:** The SW listens to HTTP Convex POSTs; the Convex client's WebSocket path bypasses the cache. For the field-worker scenario this is acceptable because the initial render comes from the HTTP-cached navigation response.
- **Negative:** Manifest link in `<head>` is deferred — `src/app/layout.tsx` is owned by Story 1.5 this sprint. `public/manifest.webmanifest` ships now; the `<link rel="manifest">` lands in a follow-up.
- **Negative:** `navigator.onLine` is heuristic; a hard-broken DNS can return `true`. The Convex SDK's network failure path is the defense-in-depth (a request that slips through fails fast and `translateError` covers the message).

## Implementation status

| Component | File | Status |
|-----------|------|--------|
| SW source | `src/sw.ts` | Implemented |
| SW build script | `scripts/build-sw.mjs` | Implemented (runs from `npm run build`) |
| Registration | `src/lib/pwa.ts` | Implemented (production-only gate) |
| Network state | `src/lib/network-state.ts`, `src/hooks/useNetworkState.ts` | Implemented |
| Cache classifier | `src/lib/offline-cache.ts`, `src/hooks/useOfflineCache.ts` | Implemented |
| Offline-write guard | `src/hooks/useNetworkAwareMutation.ts` | Implemented |
| Freshness pill | `src/components/CacheFreshnessPill/` | Implemented |
| Mobile indicator | `src/components/NetworkIndicator/` | Implemented (portals into MobileTopBar) |
| Manifest | `public/manifest.webmanifest` | Implemented (link tag deferred) |
| Icons | `public/icons/{icon-192,icon-512}.svg` | Placeholders |
| Unit tests | `tests/unit/sw/`, `tests/unit/lib/`, `tests/unit/hooks/`, `tests/unit/components/CacheFreshnessPill/` | Implemented |
| E2E spec | `tests/e2e/offline-mode.spec.ts` | Written, `test.describe.skip` until seed + auth fixtures land |
| ESLint rule "no raw useMutation" | — | Deferred to Story 5.x per story note |

## References

- [PRD § FR11](../../_bmad-output/planning-artifacts/prd.md) — offline read requirement
- [PRD § NFR-R6](../../_bmad-output/planning-artifacts/prd.md) — 24h staleness ceiling
- [Architecture § Frontend Architecture > PWA / service worker](../../_bmad-output/planning-artifacts/architecture.md) — hand-rolled SW lock
- [UX § UX-DR22](../../_bmad-output/planning-artifacts/ux-design-specification.md) — freshness pill
- [Story 1.5](../../_bmad-output/implementation-artifacts/1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md) — MobileTopBar's `data-network-state` slot
- [Story 1.8](../../_bmad-output/implementation-artifacts/1-8-office-staff-creates-and-edits-lot-records.md) — lot CRUD mutations to be wrapped
- [Story 1.13](../../_bmad-output/implementation-artifacts/1-13-field-worker-reads-cached-lot-data-offline.md) — this story
- MDN: [Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API), [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache)
