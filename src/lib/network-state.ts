/**
 * Low-level network-state utilities (Story 1.13).
 *
 * Two flavors of "are we online":
 *
 *   1. `navigator.onLine` — the browser's belief about connectivity.
 *      Cheap, synchronous, but not 100% reliable: returns `true` when
 *      DNS is broken or the local-network adapter is up but has no
 *      gateway. Used as a fast pre-check inside `useNetworkAwareMutation`.
 *
 *   2. Subscribing to `online` / `offline` events on `window`. We use the
 *      `subscribeToNetworkState` helper to register callbacks that fire
 *      on transitions. The `useNetworkState` hook in `src/hooks/` wraps
 *      this for components.
 *
 * Both sources are best-effort. The defense-in-depth is the SW + the
 * server-side `requireRole` check on mutations: if a fetch slips through
 * with no connection, it fails fast and `translateError` surfaces a
 * clear message.
 */

export type NetworkState = "online" | "offline";

export function readNetworkState(): NetworkState {
  if (typeof navigator === "undefined") return "online";
  return navigator.onLine === false ? "offline" : "online";
}

/**
 * Subscribe to browser online/offline transitions. Returns a cleanup
 * fn that detaches both listeners. Safe to call during SSR (returns a
 * no-op cleanup).
 */
export function subscribeToNetworkState(
  callback: (state: NetworkState) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {
      /* noop in SSR */
    };
  }

  const onOnline = (): void => callback("online");
  const offFn = (): void => callback("offline");

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", offFn);

  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", offFn);
  };
}
