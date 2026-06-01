"use client";

import { useEffect } from "react";

/**
 * Global Cmd-K / Ctrl-K listener.
 *
 * Wires a `keydown` listener on `window` that:
 *   1. Detects `(metaKey || ctrlKey) && key === "k"`.
 *   2. Skips the trigger if the user is mid-typing in any input,
 *      textarea, or contentEditable element. Without this guard,
 *      typing "k" while focused in a search field would steal the
 *      keystroke and open the global palette — a classic anti-pattern
 *      flagged in the story's "Disaster prevention" notes.
 *   3. The palette's own input is exempt via the
 *      `[data-cmdk-input-wrapper]` ancestor selector that cmdk applies
 *      to its input shell — re-opening from inside the palette is a
 *      no-op, but pressing Cmd-K to close from inside is OK because
 *      Radix Dialog's ESC handler / overlay-click handles closing.
 *
 * The hook is intentionally factored out of `(staff)/layout.tsx` so it
 * stays testable (a one-line useEffect can be unit-tested by mounting a
 * component that exercises it).
 *
 * Critical: `e.preventDefault()` is called unconditionally when the
 * chord matches — otherwise Chrome opens the URL bar on Mac.
 */
export function useCmdK(onOpen: () => void) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    function onKeyDown(e: KeyboardEvent) {
      const isChord = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (!isChord) return;

      // Guard: do not steal keystrokes from focused editable elements
      // (unless the focused element is the palette's own input).
      const active = document.activeElement as HTMLElement | null;
      if (active) {
        const isEditable =
          active.matches("input, textarea") ||
          active.getAttribute("contenteditable") === "true" ||
          active.getAttribute("contenteditable") === "";
        const isPaletteInput = !!active.closest("[data-cmdk-input-wrapper]");
        if (isEditable && !isPaletteInput) {
          return;
        }
      }

      e.preventDefault();
      onOpen();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpen]);
}
