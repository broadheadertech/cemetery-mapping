"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/sw-register";
import { CacheFreshnessPill } from "@/components/CacheFreshnessPill";
import { NetworkIndicator } from "./NetworkIndicator";

/**
 * Mounts on first render of any cached staff page and:
 *   1. Registers the service worker (production builds only — see
 *      `pwa.ts`).
 *   2. Renders the `<CacheFreshnessPill>` system banner at the top
 *      of the cached page.
 *   3. Renders the `<NetworkIndicator>` which portals into the
 *      MobileTopBar's `[data-network-state]` slot.
 *
 * Architectural note: Story 1.13 originally placed registration in the
 * `(staff)/layout.tsx`. Per the dev-story ownership rules in this run,
 * the staff layout is off-limits to this story (Story 1.5 owns it). The
 * bootstrap lives instead at the `/lots` page — the canonical landing
 * page for field workers — and the SW's `clients.matchAll()` notify
 * loop reaches the pill regardless of which staff page is foreground
 * after registration.
 *
 * Follow-up: once Story 1.5's owner reopens the staff layout for an
 * edit, the bootstrap moves up there so `/dashboard` and other staff
 * routes get SW coverage from their first visit. See ADR-0011.
 */
export function ServiceWorkerBootstrap(): React.ReactElement {
  useEffect(() => {
    registerServiceWorker();
  }, []);

  return (
    <>
      <CacheFreshnessPill />
      <NetworkIndicator />
    </>
  );
}
