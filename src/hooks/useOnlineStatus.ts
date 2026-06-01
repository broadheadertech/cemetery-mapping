"use client";

import { useEffect, useState } from "react";

/**
 * `useOnlineStatus` — Story 1.14.
 *
 * Returns a boolean reflecting `navigator.onLine`, kept in sync via
 * the `online` / `offline` window events.
 *
 * Initial state:
 *   - Server-render and first client render both return `true` to
 *     avoid a hydration mismatch. The post-mount effect immediately
 *     corrects the value from `navigator.onLine` (synchronous DOM
 *     read), so the "submit disabled because offline" state appears
 *     within one render cycle.
 *
 * Why both initial check AND event listeners:
 *   - `navigator.onLine` is reliable at any moment (synchronous DOM).
 *   - The `online` / `offline` events fire when the OS reports a
 *     connectivity change. Without them the value would never update
 *     if the user reconnected after the component mounted.
 *
 * Cleanup:
 *   - Both listeners are removed on unmount. Important under React
 *     StrictMode (the dev-only second mount would otherwise leak a
 *     subscription).
 */
export function useOnlineStatus(): boolean {
  // Defaulting to `true` matches the SSR assumption — most users are
  // online when they first reach the app. Offline-first users get
  // corrected within one tick of mount.
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    // Sync initial value (may differ from the SSR default).
    setOnline(navigator.onLine);

    function onOnline() {
      setOnline(true);
    }
    function onOffline() {
      setOnline(false);
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return online;
}
