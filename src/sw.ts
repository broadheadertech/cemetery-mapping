/// <reference lib="webworker" />

/**
 * Hand-rolled service worker for cemetery-mapping (Story 1.13).
 *
 * Architecture commits to a vanilla SW, NO `next-pwa`. ADR-0011 documents
 * the decision. This source file is bundled to `public/sw.js` via
 * `scripts/build-sw.mjs` (esbuild) so it's served at root scope and can
 * control everything under `/`.
 *
 * Responsibilities (per Story 1.13 ACs):
 *   - AC2: cache `/lots`, `/lots/<id>`, `/dashboard` navigations + Convex
 *     query responses with a 24h staleness TTL.
 *   - AC4: serve cache silently while fresh, "may be outdated" when stale,
 *     fire stale-while-revalidate background updates.
 *   - AC6: cache versioning tied to a build-id token replaced at bundle
 *     time (`__BUILD_ID__`). On version change → old caches evicted.
 *
 * Boundaries (per ownership rules):
 *   - SW MUST NOT cache the `/login`, `/api/auth/**`, or any `(public)` /
 *     `(customer)` route group response. Only staff routes are cached.
 *   - SW MUST NOT cache mutation POST requests (Convex mutations). The
 *     `useNetworkAwareMutation` wrapper hard-blocks offline writes; the
 *     SW does not queue them.
 *   - SW MUST NOT serve stale auth state. Auth-related URLs bypass.
 *
 * The file uses no external imports — every API is a `self` (the
 * ServiceWorkerGlobalScope) global. Comments mark the four event handlers
 * so the structure stays scannable when reading the bundled output.
 */

// `BUILD_ID_PLACEHOLDER` is replaced by esbuild's `--define` flag at
// bundle time. The runtime fallback covers the dev/test-bundle path.
declare const __BUILD_ID__: string;
const BUILD_ID =
  typeof __BUILD_ID__ === "string" && __BUILD_ID__.length > 0
    ? __BUILD_ID__
    : "dev";

const CACHE_VERSION = `v1-${BUILD_ID}`;
const CACHE_NAME_STATIC = `cm-static-${CACHE_VERSION}`;
const CACHE_NAME_DATA = `cm-data-${CACHE_VERSION}`;

/**
 * 24 hours in milliseconds. Per NFR-R6: cached data older than this
 * surfaces a "may be outdated" pill on the client; the SW still serves
 * it offline but flags it stale via the `served-from-cache` message.
 */
const STALENESS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Same-origin paths whose navigation responses we pre-cache + keep cached.
 * The `/lots/<id>` paths cache on first visit (lazy), not on install.
 */
const PRECACHE_NAVIGATION_PATHS = ["/lots", "/dashboard"];

/**
 * Paths the SW MUST NOT touch — auth state must always hit the network.
 * The (public) and (customer) route groups are out of scope for offline
 * caching per the story.
 */
const NEVER_CACHE_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/convex-auth",
  "/_convex/auth",
];

/**
 * Convex function paths that report auth state. Responses from these
 * MUST NOT be cached: a deactivated user's role payload could otherwise
 * be served from cache for up to 24h, defeating Story 1.3 deactivation
 * semantics. The middleware (`src/middleware.ts`) consumes
 * `lib/auth:getCurrentUserOrNull` on every navigation, so a stale
 * response here means a stale role check.
 *
 * The check happens inside `handleConvexQuery` after parsing the POST
 * body's `path` field (Convex query POSTs carry `{ path, args, ... }`).
 * Extend this set when any new auth-touching query function is added.
 */
const AUTH_FUNCTION_PATHS: ReadonlySet<string> = new Set([
  "lib/auth:getCurrentUserOrNull",
  "users:getCurrentUserRoles",
]);

declare const self: ServiceWorkerGlobalScope;

// ------------------------------------------------------------
// install — pre-cache the static staff navigations.
// ------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME_STATIC);
      try {
        await cache.addAll(PRECACHE_NAVIGATION_PATHS);
      } catch {
        // Pre-cache is best-effort. If the network is offline at install
        // time the page is being installed locally — skip silently.
      }
      // Do NOT call `self.skipWaiting()` — per the disaster-prevention
      // notes we don't want a new SW to steal control of pages running
      // the older app version mid-session. The page reload that
      // accompanies a new deploy lets the new SW take over cleanly.
    })(),
  );
});

// ------------------------------------------------------------
// activate — evict caches from older versions; claim no clients.
// ------------------------------------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              (name.startsWith("cm-static-") &&
                name !== CACHE_NAME_STATIC) ||
              (name.startsWith("cm-data-") && name !== CACHE_NAME_DATA),
          )
          .map((name) => caches.delete(name)),
      );
    })(),
  );
});

// ------------------------------------------------------------
// fetch — route requests through cache strategies.
// ------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Hard skip: only handle same-origin. Cross-origin requests (Convex's
  // `*.convex.cloud` host, third-party fonts/scripts) pass through.
  if (url.origin !== self.location.origin) return;

  // Hard skip: auth / login URLs MUST always hit the network.
  if (NEVER_CACHE_PREFIXES.some((p) => url.pathname.startsWith(p))) return;

  // Hard skip: mutations / non-GET / non-POST requests pass through.
  // Convex queries arrive as POST; everything that isn't a GET or a
  // Convex-query POST should not be cached.
  if (request.method !== "GET" && request.method !== "POST") return;

  if (request.method === "POST") {
    // Convex query POST endpoint(s). The SDK's exact URL pattern varies
    // by version (e.g. `/api/query`, `/_convex/api/query`). We match by
    // pathname suffix so the cache works regardless of mount prefix and
    // we don't intercept genuine application POSTs.
    if (isConvexQueryPath(url.pathname)) {
      event.respondWith(handleConvexQuery(request));
    }
    return;
  }

  // GET navigations under cached prefixes → stale-while-revalidate.
  if (isCacheableNavigation(request, url)) {
    event.respondWith(handleNavigation(request));
    return;
  }

  // GET static assets → cache-first.
  if (isCacheableAsset(url)) {
    event.respondWith(handleAsset(request));
    return;
  }

  // Everything else: pass through (default network behaviour).
});

// ------------------------------------------------------------
// Cache strategies
// ------------------------------------------------------------

async function handleNavigation(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME_STATIC);
  const cached = await cache.match(request);
  const cachedAt = cached ? readCachedAtHeader(cached) : null;

  const fetchAndStore = (async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const stamped = await stampResponse(response.clone(), Date.now());
        await safeCachePut(cache, request, stamped);
      }
      return response;
    } catch (err) {
      // Network failed — fall back to cache if we have one.
      if (cached) return cached;
      throw err;
    }
  })();

  if (cached) {
    // Notify clients that we just served from cache so the
    // `<CacheFreshnessPill>` can render with the right age.
    void notifyClients({
      type: "served-from-cache",
      url: request.url,
      cachedAt: cachedAt ?? Date.now(),
      stale:
        cachedAt !== null ? Date.now() - cachedAt >= STALENESS_TTL_MS : false,
    });
    // Background-refresh; ignore failures.
    void fetchAndStore.catch(() => undefined);
    return cached;
  }

  return fetchAndStore;
}

async function handleAsset(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME_STATIC);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await safeCachePut(cache, request, response.clone());
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function handleConvexQuery(request: Request): Promise<Response> {
  // Convex queries POST a JSON body with `path`, `args`, etc. We key by
  // URL + body hash so two queries to the same endpoint with different
  // args are independent cache entries.
  const cache = await caches.open(CACHE_NAME_DATA);

  // Read the body ONCE into a string buffer. We need it three times:
  //   1. To inspect `body.path` for the auth-skip rule (below).
  //   2. To hash into the per-request cache key.
  //   3. To re-construct a fresh `Request` for the downstream `fetch`
  //      (the original `request` body has already been consumed).
  //
  // Per-request overhead is small: Convex query bodies are typically
  // <1 KB JSON, so the parse + string copy is sub-millisecond.
  let bodyText = "";
  try {
    bodyText = await request.clone().text();
  } catch {
    bodyText = "";
  }

  // Auth-skip: if this POST is targeting an auth-reporting function,
  // bypass the cache entirely (both read and write). The middleware
  // depends on a fresh role payload to enforce Story 1.3 deactivation
  // semantics — a 24h stale cache hit could let a deactivated user
  // keep navigating until the entry ages out.
  if (isAuthFunctionPath(bodyText)) {
    return fetch(rebuildRequest(request, bodyText));
  }

  const cacheKey = await buildConvexCacheKey(request.url, bodyText);

  const cached = await cache.match(cacheKey);
  const cachedAt = cached ? readCachedAtHeader(cached) : null;

  const fetchAndStore = (async () => {
    try {
      const response = await fetch(rebuildRequest(request, bodyText));
      if (response.ok) {
        const stamped = await stampResponse(response.clone(), Date.now());
        await safeCachePut(cache, cacheKey, stamped);
      }
      return response;
    } catch (err) {
      if (cached) return cached;
      throw err;
    }
  })();

  if (cached) {
    const isStale =
      cachedAt !== null ? Date.now() - cachedAt >= STALENESS_TTL_MS : false;
    void notifyClients({
      type: "served-from-cache",
      url: request.url,
      cachedAt: cachedAt ?? Date.now(),
      stale: isStale,
    });
    void fetchAndStore.catch(() => undefined);
    return cached;
  }

  return fetchAndStore;
}

/**
 * Parses a Convex query POST body and returns true when the request
 * targets a function listed in `AUTH_FUNCTION_PATHS`. Defensive against
 * non-JSON or unexpected shapes — any parse failure returns false so
 * non-auth traffic isn't accidentally diverted around the cache.
 */
function isAuthFunctionPath(bodyText: string): boolean {
  if (bodyText.length === 0) return false;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "path" in parsed &&
      typeof (parsed as { path: unknown }).path === "string"
    ) {
      return AUTH_FUNCTION_PATHS.has((parsed as { path: string }).path);
    }
  } catch {
    // Body wasn't JSON — fall through and treat as not-auth.
  }
  return false;
}

/**
 * Reconstructs a `Request` with the previously-buffered body. We can't
 * pass the original `request` to `fetch` after reading its body, and
 * `request.clone()` only helps for the FIRST consumer.
 */
function rebuildRequest(request: Request, bodyText: string): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bodyText.length > 0 ? bodyText : undefined,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    integrity: request.integrity,
  });
}

/**
 * `cache.put` can throw `QuotaExceededError` when the browser's storage
 * budget is full. Swallow + warn — the next `fetchAndStore` round will
 * retry, and the response is already returned to the caller.
 */
async function safeCachePut(
  cache: Cache,
  key: string | Request,
  response: Response,
): Promise<void> {
  try {
    await cache.put(key, response);
  } catch (err) {
    console.warn("[sw] cache.put failed (quota?)", err);
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function isConvexQueryPath(pathname: string): boolean {
  // Convex's React SDK uses a WebSocket in production, but for HTTP
  // fallback / SSR the endpoint is one of these path suffixes. We don't
  // claim to catch the WebSocket — that's a separate transport. The
  // story acknowledges this and the field-worker scenario depends on
  // HTTP-cached responses for the initial render.
  return (
    pathname.endsWith("/api/query") ||
    pathname.endsWith("/_convex/api/query") ||
    pathname.includes("/api/run/")
  );
}

function isCacheableNavigation(request: Request, url: URL): boolean {
  if (request.mode !== "navigate") return false;
  if (request.method !== "GET") return false;
  return (
    url.pathname === "/lots" ||
    url.pathname.startsWith("/lots/") ||
    url.pathname === "/dashboard"
  );
}

function isCacheableAsset(url: URL): boolean {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/map/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest"
  );
}

/**
 * Wraps a Response with an `X-CM-Cached-At` header carrying the cache
 * write timestamp. Using a header keeps the body intact (so the client
 * receives the original JSON / HTML) and survives `caches.match`.
 */
async function stampResponse(response: Response, cachedAt: number): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("x-cm-cached-at", String(cachedAt));
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function readCachedAtHeader(response: Response): number | null {
  const raw = response.headers.get("x-cm-cached-at");
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function buildConvexCacheKey(url: string, body: string): Promise<string> {
  const hash = await sha256(`${url}::${body}`);
  return `${url}#${hash}`;
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface CacheNotification {
  type: "served-from-cache";
  url: string;
  cachedAt: number;
  stale: boolean;
}

async function notifyClients(message: CacheNotification): Promise<void> {
  const clientsList = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clientsList) {
    try {
      client.postMessage(message);
    } catch {
      // Channel may have closed; ignore.
    }
  }
}

// Exports kept off the global — service workers don't `import` /
// `export`. The bundler treats this as an IIFE module via the
// `format: "iife"` option in `scripts/build-sw.mjs`.

// Make TypeScript happy about the lack of imports — re-export an empty
// type so the file is treated as a module by `tsc`. Without this the
// project's `noImplicitAny` setting can complain about the `self` redec.
export {};
