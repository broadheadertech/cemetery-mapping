"use client";

/**
 * /map — Cemetery Map (Story 1.12).
 *
 * Phase 1 SVG map renderer with multi-select status filter chips.
 * Lives at `/map` (a dedicated route) rather than as a toggle inside
 * `/lots` — the toggle integration is owned by a downstream story; this
 * route keeps Phase 1's map shippable in isolation.
 *
 * Why client component:
 *   - The map composes `useQuery` (reactive viewport-bbox query) +
 *     `useState` (filter chip state). Server-rendering would force a
 *     full route reload on every filter change.
 *   - `useRouter().push()` for the click-to-detail navigation is a
 *     client-only API.
 *
 * Architectural commitments honoured here:
 *   - One `<h1>` per page ("Cemetery Map") — single-h1-per-page lint
 *     rule (Story 1.5 Task 10).
 *   - No leaflet import. The `LotMap` orchestrator dispatches only to
 *     `SvgRenderer` in Phase 1.
 *   - Click on a lot routes to `/lots/[lotId]` (Story 1.11's detail
 *     page).
 *   - Status filter chips use the StatusPill palette (Story 1.4 tokens).
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Boxes } from "lucide-react";
import { StatusPill } from "@/components/ui/StatusPill";
import { LOT_STATUSES, type LotStatus } from "@/types/lot-status";
import { LotMap, type LotMapRenderer } from "@/components/LotMap";

const CHIP_LABELS: Record<LotStatus, string> = {
  available: "Available",
  reserved: "Reserved",
  sold: "Sold",
  occupied: "Occupied",
  cancelled: "Cancelled",
  defaulted: "Defaulted",
  transferred: "Transferred",
};

export default function CemeteryMapPage() {
  const router = useRouter();

  // Filter chips are multi-select. Empty set === show all statuses.
  const [activeStatuses, setActiveStatuses] = useState<ReadonlySet<LotStatus>>(
    () => new Set<LotStatus>(),
  );

  // Story 8.2: optional staff renderer override. Default `undefined`
  // lets `LotMap` auto-detect (Leaflet when any lot is surveyed).
  const [forceRenderer, setForceRenderer] = useState<LotMapRenderer | undefined>(
    undefined,
  );

  const toggleStatus = useCallback((status: LotStatus) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setActiveStatuses(new Set());
  }, []);

  const handleLotClick = useCallback(
    (lotId: string) => {
      router.push(`/lots/${lotId}`);
    },
    [router],
  );

  // Pass `undefined` (rather than an empty array) when no filters are
  // selected so the hook's "show all" branch fires.
  const statusFilters =
    activeStatuses.size === 0
      ? undefined
      : (Array.from(activeStatuses) as ReadonlyArray<LotStatus>);

  const hasFilters = activeStatuses.size > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Cemetery Map</h1>
          <p className="mt-1 text-sm text-text-muted">
            Click any lot to view details. Filter chips narrow the visible
            status set.
          </p>
        </div>
        <Link
          href="/phase-3d"
          className="inline-flex min-h-[38px] items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
        >
          <Boxes className="h-4 w-4" aria-hidden="true" /> 3D Phase View
        </Link>
      </header>

      <div
        role="group"
        aria-label="Filter by status"
        data-testid="status-filter-chips"
        className="flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          onClick={clearFilters}
          aria-pressed={!hasFilters}
          data-testid="filter-chip-all"
          className={chipClass(!hasFilters)}
        >
          All
        </button>
        {LOT_STATUSES.map((status) => {
          const active = activeStatuses.has(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => toggleStatus(status)}
              aria-pressed={active}
              aria-label={`${active ? "Remove" : "Add"} filter: ${CHIP_LABELS[status]}`}
              data-testid={`filter-chip-${status}`}
              className={chipClass(active)}
            >
              <StatusPill status={status} size="sm" showIcon={true} />
            </button>
          );
        })}
      </div>

      <div
        role="radiogroup"
        aria-label="Map renderer"
        data-testid="renderer-toggle"
        className="flex flex-wrap items-center gap-2 text-xs"
      >
        <span className="text-text-muted">Renderer:</span>
        <button
          type="button"
          role="radio"
          aria-checked={forceRenderer === undefined}
          data-testid="renderer-auto"
          onClick={() => setForceRenderer(undefined)}
          className={chipClass(forceRenderer === undefined)}
        >
          Auto
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={forceRenderer === "svg"}
          data-testid="renderer-svg"
          onClick={() => setForceRenderer("svg")}
          className={chipClass(forceRenderer === "svg")}
        >
          SVG (Phase 1)
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={forceRenderer === "leaflet"}
          data-testid="renderer-leaflet"
          onClick={() => setForceRenderer("leaflet")}
          className={chipClass(forceRenderer === "leaflet")}
        >
          Leaflet (Phase 2)
        </button>
      </div>

      <LotMap
        statusFilters={statusFilters}
        onLotClick={handleLotClick}
        height={600}
        forceRenderer={forceRenderer}
      />
    </div>
  );
}

function chipClass(active: boolean): string {
  return [
    "inline-flex min-h-[36px] items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
    active
      ? "border-primary bg-primary text-primary-fg"
      : "border-surface-border bg-surface-base text-text-default hover:bg-surface-emphasis",
  ].join(" ");
}
