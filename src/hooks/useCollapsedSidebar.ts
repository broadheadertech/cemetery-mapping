"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Sidebar collapse hook with localStorage persistence.
 *
 * UX § Navigation Patterns specifies the sidebar collapses to 64px (icon
 * rail) on user toggle and stays collapsed across reloads. We persist
 * the boolean in localStorage under a single key so the preference
 * follows the user across tabs.
 *
 * Hydration safety: SSR cannot read localStorage, so the initial state
 * is `false` (expanded). The hook syncs to the stored value in a
 * useEffect on mount. The brief flash from expanded → collapsed is
 * acceptable; the alternative (a blocking script tag in <head>) would
 * couple this hook to layout.tsx and complicates SSR.
 *
 * Cross-tab sync: a `storage` listener picks up changes from other tabs
 * so toggling in tab A reflects in tab B immediately.
 */
const STORAGE_KEY = "cemetery.sidebar.collapsed";

export function useCollapsedSidebar() {
  const [collapsed, setCollapsedState] = useState<boolean>(false);

  // Hydrate from localStorage after mount (SSR-safe).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw === "true") {
        setCollapsedState(true);
      }
    } catch {
      // localStorage may be disabled (private mode); silently fall back
      // to the default expanded state.
    }
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        setCollapsedState(e.newValue === "true");
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
      } catch {
        // Ignore quota / disabled-storage errors. State still updates
        // in memory for the current session.
      }
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(!collapsed);
  }, [collapsed, setCollapsed]);

  return { collapsed, setCollapsed, toggleCollapsed };
}
