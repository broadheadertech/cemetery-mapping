"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Theme controller for indoor / outdoor mode.
 *
 * Story 1.4 established the visual mechanism: `:root[data-theme="outdoor"]`
 * (CSS custom properties in `src/app/globals.css`). This hook is the
 * client-side controller that flips the attribute on `<html>` and
 * persists the choice in localStorage.
 *
 * Three theme values are valid:
 *   - "indoor"  — explicit indoor (the default UX baseline)
 *   - "outdoor" — high-contrast field worker mode
 *   - "system"  — defer to the OS `prefers-contrast: more` query (the
 *     CSS in globals.css already honours this when no explicit
 *     attribute is set)
 *
 * On first mount the hook hydrates from localStorage; if nothing is
 * stored it leaves the attribute unset and the CSS picks up the system
 * preference. The hook is safe to call from any client component;
 * multiple instances stay in sync because they all read from the same
 * attribute and storage key.
 *
 * Future Story 1.4 polish may add a FOUC-prevention <script> in
 * `src/app/layout.tsx`'s <head> that applies the attribute synchronously
 * before hydration; this hook is the reactive companion to that script.
 */

export type Theme = "indoor" | "outdoor" | "system";

const STORAGE_KEY = "cemetery.theme";

function readStored(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "indoor" || raw === "outdoor" || raw === "system") {
      return raw;
    }
  } catch {
    // localStorage unavailable — fall back to system.
  }
  return "system";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (theme === "system") {
    html.removeAttribute("data-theme");
  } else {
    html.setAttribute("data-theme", theme);
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("system");

  // Hydrate from storage on mount.
  useEffect(() => {
    const stored = readStored();
    setThemeState(stored);
    applyTheme(stored);
  }, []);

  // Cross-tab sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) {
        const next = readStored();
        setThemeState(next);
        applyTheme(next);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage quota / disabled — runtime state still updates.
      }
    }
  }, []);

  const toggleOutdoor = useCallback(() => {
    // Two-state toggle (indoor ↔ outdoor); skips "system" because the
    // user is taking explicit control by clicking the toggle.
    setTheme(theme === "outdoor" ? "indoor" : "outdoor");
  }, [theme, setTheme]);

  return {
    theme,
    setTheme,
    toggleOutdoor,
    isOutdoor: theme === "outdoor",
  };
}
