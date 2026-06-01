"use client";

/**
 * CustomerDetailSkeleton — Story 2.5 AC5.
 *
 * Loading-state shimmer that mirrors the loaded page's layout so the
 * content doesn't jump when the Convex query resolves. Per UX §
 * Skeleton Patterns: structural skeletons matching the final layout,
 * never a single spinner.
 */

export function CustomerDetailSkeleton() {
  return (
    <div
      className="space-y-6"
      data-testid="customer-detail-skeleton"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex items-center gap-3">
        <div className="h-9 w-64 animate-pulse rounded bg-slate-200" />
        <div className="h-6 w-20 animate-pulse rounded-full bg-slate-200" />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Block lines={4} />
          <Block lines={2} />
        </div>
        <div className="space-y-6">
          <Block lines={3} />
          <Block lines={2} />
          <Block lines={1} />
        </div>
      </div>
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
