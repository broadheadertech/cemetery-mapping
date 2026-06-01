"use client";

/**
 * LotDetailSkeleton — Story 1.11 (AC5).
 *
 * Loading-state shimmer that mirrors the loaded page's layout so the
 * content doesn't jump when the Convex query resolves. Per UX §
 * Loading State Patterns: never a spinner, never a blank screen — the
 * skeleton sketches the same boxes that will fill with data.
 *
 * Plain `bg-slate-200` blocks with `animate-pulse`; no decorative
 * `role` overrides — keeps axe-core scans clean on the loading state
 * (NFR-A2). The wrapper carries `aria-busy="true"` + `aria-live` so
 * screen readers announce the load.
 */

export function LotDetailSkeleton() {
  return (
    <div
      className="space-y-6"
      data-testid="lot-detail-skeleton"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <div className="h-9 w-48 animate-pulse rounded bg-slate-200" />
        <div className="h-6 w-24 animate-pulse rounded-full bg-slate-200" />
      </div>
      <Block lines={3} />
      <Block lines={2} />
      <Block lines={2} />
      <Block lines={2} />
      <Block lines={1} />
      <Block lines={3} />
    </div>
  );
}

function Block({ lines }: { lines: number }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-6">
      <div className="mb-4 h-4 w-32 animate-pulse rounded bg-slate-200" />
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="h-4 w-full animate-pulse rounded bg-slate-200"
          />
        ))}
      </div>
    </div>
  );
}
