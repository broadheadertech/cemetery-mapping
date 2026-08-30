"use client";

/**
 * /admin/map-setup — the whole 3D map, set up on one screen.
 *
 * The six steps used to be six destinations, and the person doing them
 * had to remember which gardens they had already got through. This is
 * that walkthrough, with the progress read from the data rather than
 * ticked off by hand.
 *
 * Admin-only: middleware gates the `/admin` family at the edge and
 * `lots:mapSetupProgress` re-checks the role server-side.
 */

import Link from "next/link";
import { Boxes } from "lucide-react";

import { MapSetupGuide } from "@/components/MapSetupGuide";

export default function MapSetupPage() {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            Setup
          </p>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-text-default">
            Set up the 3D map
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            Six steps, in order, on this page. Each one shows where it
            actually stands — nothing here is ticked off by hand, so it
            cannot tell you the map is ready when it is not.
          </p>
        </div>
        <Link
          href="/phase-3d"
          className="inline-flex min-h-[38px] items-center gap-2 rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-semibold text-text-default transition-colors hover:border-accent-gold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          <Boxes className="h-4 w-4" aria-hidden="true" /> Open the map
        </Link>
      </header>

      <MapSetupGuide />
    </div>
  );
}
