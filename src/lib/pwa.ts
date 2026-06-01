/**
 * Service worker registration helpers (Story 1.13).
 *
 * `registerServiceWorker()` is the single entry point called from the
 * `(staff)` layout's client wrapper on mount. It is intentionally a
 * pure side-effect function with no React deps so it can be unit-tested
 * independently of the rendering tree.
 *
 * Disaster prevention contract:
 *   - MUST be a no-op in development. Dev SW intercepts HMR and breaks
 *     the Convex dev replay loop. The check is `NODE_ENV !== "production"`,
 *     not a runtime feature flag.
 *   - MUST be a no-op during SSR / RSC (`typeof window === "undefined"`).
 *   - MUST be a no-op when the browser does not support service workers
 *     (older Safari, locked-down corporate browsers).
 *   - Registration runs after `load` so it never fights with the first
 *     paint / hydration.
 *
 * `unregisterServiceWorker()` exists for test cleanup and for the rare
 * support case where a stuck client needs the SW evicted manually.
 */

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "production") return;
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;

  // Defer to `load` so the SW doesn't compete with the first paint.
  const register = (): void => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => {
        // We swallow the error so a SW registration failure never breaks
        // the app. The "Cached / Live" pill will simply stay on "Live"
        // and offline reads are unavailable until next visit.
        console.warn("[pwa] service worker registration failed", err);
      });
  };

  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}

export async function unregisterServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));
}
