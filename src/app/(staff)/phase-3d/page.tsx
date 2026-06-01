"use client";

/**
 * /phase-3d — 3D survey of Phase 1 (the Northwest Parcel).
 *
 * The "3D survey review" step (Step 05) of the phase-mapping playbook on
 * `/phase-planning`, and the rotatable Phase-2 map renderer ADR-0008
 * slates. Reachable from the staff Map screen ("3D Phase View") and from
 * Phase Planning ("Open 3D survey").
 *
 * The Three.js scene is loaded with `ssr: false` — WebGL has no
 * server-render path. The page itself stays inside the staff AppShell so
 * the sidebar / auth chrome is consistent with the rest of the app.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { ChevronLeft, ClipboardCheck } from "lucide-react";

const Phase3DMap = dynamic(
  () => import("@/components/Phase3DMap").then((m) => m.Phase3DMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[60vh] min-h-[460px] flex-col items-center justify-center gap-3 rounded-lg border border-surface-border bg-surface-emphasis lg:h-[70vh]">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-surface-border border-t-primary" />
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted">
          Building 3D survey…
        </span>
      </div>
    ),
  },
);

export default function Phase3DPage() {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            3D Survey · 3 sections
          </p>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-text-default">
            Phase 1 — Northwest Parcel
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            A rotatable survey of the parcel&apos;s three gardens — Grace,
            Faith &amp; Hope. Drag to orbit, scroll to zoom, click any lot to
            inspect.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/map"
            className="inline-flex min-h-[38px] items-center gap-2 rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-semibold text-text-default transition-colors hover:border-accent-gold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back to Map
          </Link>
          <Link
            href="/phase-planning"
            className="inline-flex min-h-[38px] items-center gap-2 rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-semibold text-text-default transition-colors hover:border-accent-gold hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" /> Phase plan
          </Link>
        </div>
      </header>

      <Phase3DMap />
    </div>
  );
}
