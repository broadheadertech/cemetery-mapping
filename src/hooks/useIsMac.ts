"use client";

import { useEffect, useState } from "react";

/**
 * Detects whether the user is on macOS so the Cmd-K hint can render
 * "⌘ K" vs "Ctrl K". Returns `false` during SSR + first render to avoid
 * hydration mismatches; the real platform check runs in a useEffect.
 */
export function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    // navigator.platform is deprecated but still ubiquitous; the
    // userAgentData fallback covers modern Chromium.
    const platform =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((navigator as any).userAgentData?.platform as string | undefined) ??
      navigator.platform ??
      "";
    setIsMac(/Mac|iPhone|iPod|iPad/i.test(platform));
  }, []);

  return isMac;
}
