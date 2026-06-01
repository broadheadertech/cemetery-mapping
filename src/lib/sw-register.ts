/**
 * Re-export shim so callers can import a stable name (`sw-register`)
 * without coupling to the underlying `pwa.ts` module split. Story 1.13's
 * ownership rules permit this file; consumers should prefer it over
 * `@/lib/pwa` to keep the import surface clean.
 */
export { registerServiceWorker, unregisterServiceWorker } from "./pwa";
