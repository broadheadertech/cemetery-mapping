"use client";

import { useState } from "react";

/**
 * `useIdempotencyKey` — Story 1.14.
 *
 * Returns a UUID that is STABLE across re-renders of the same mount,
 * but FRESH per form mount. Pass this key into the Convex mutation
 * so a retried submit (network blip, double-tap) is deduplicated
 * server-side instead of inserting a second row.
 *
 * Pattern:
 *   - `useState(() => crypto.randomUUID())` — lazy initialiser. The
 *     UUID is generated once when the component mounts and persists
 *     for the lifetime of that mount. Re-renders return the same
 *     value.
 *   - `crypto.randomUUID()` is available in every modern browser and
 *     Node 20+ (per `engines.node` in `package.json`); no polyfill.
 *
 * Browser fallback:
 *   - SSR / first-render gets the empty string. The server-side
 *     handler treats an empty key as "skip dedup" — the next
 *     post-mount render produces a real key. This avoids the
 *     hydration mismatch a `useState(crypto.randomUUID())` would
 *     trigger.
 *
 * NOTE: Story 1.14 uses one key per form-mount lifecycle. If a user
 * submits successfully and then re-opens the Sheet to log another
 * observation, that's a new mount → new key.
 */
export function useIdempotencyKey(): string {
  const [key] = useState<string>(() => {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return "";
  });
  return key;
}
