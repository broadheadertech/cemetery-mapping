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
import Link from "next/link";
import { Boxes, Search } from "lucide-react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { StatusPill } from "@/components/ui/StatusPill";
import { LOT_STATUSES, type LotStatus } from "@/types/lot-status";
import { LotMap, type LotMapRenderer } from "@/components/LotMap";
import { LotActionMenu } from "@/components/LotActionMenu";

const CHIP_LABELS: Record<LotStatus, string> = {
  available: "Available",
  reserved: "Reserved",
  sold: "Sold",
  occupied: "Occupied",
  cancelled: "Cancelled",
  defaulted: "Defaulted",
  transferred: "Transferred",
};

interface GraveHit {
  occupantName: string;
  dateOfInterment?: number;
  lotId: string;
  lotCode: string;
  section: string;
  status: LotStatus;
  centroid: { lat: number; lng: number };
}

const findGraveRef = makeFunctionReference<
  "query",
  { query: string },
  GraveHit[]
>("search:findGrave");

export default function CemeteryMapPage() {
  // Clicking a lot opens an action menu (view / sell / schedule / pay)
  // rather than navigating straight to the record — the map becomes the
  // place you act, not just look.
  const [actionLotId, setActionLotId] = useState<string | null>(null);

  // Find-a-grave: the point the map should fly to. A NEW object per pick
  // so the renderer's focus effect re-fires even for the same lot.
  const [focusPoint, setFocusPoint] = useState<{ lat: number; lng: number } | null>(
    null,
  );

  const handlePickGrave = useCallback((hit: GraveHit) => {
    setFocusPoint({ lat: hit.centroid.lat, lng: hit.centroid.lng });
    setActionLotId(hit.lotId);
  }, []);

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

  const handleLotClick = useCallback((lotId: string) => {
    setActionLotId(lotId);
  }, []);

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
          <h1 className="font-display text-4xl font-semibold tracking-tight">Cemetery Map</h1>
          <p className="mt-1 text-sm text-text-muted">
            Search a name to find a grave, or click any lot for actions.
            Filter chips narrow the visible status set.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GraveSearchBox onPick={handlePickGrave} />
          <Link
            href="/phase-3d"
            className="inline-flex min-h-[38px] items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-fg transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            <Boxes className="h-4 w-4" aria-hidden="true" /> 3D Phase View
          </Link>
        </div>
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
        focusPoint={focusPoint}
      />

      <LotActionMenu
        lotId={actionLotId}
        onClose={() => setActionLotId(null)}
      />
    </div>
  );
}

/**
 * Find-a-grave search box. Type a name → matching interred occupants →
 * pick one to fly the map to that lot and open its action menu. Reuses
 * the `search:findGrave` query (full-scan substring match, Phase-1 scale).
 */
function GraveSearchBox({ onPick }: { onPick: (hit: GraveHit) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const trimmed = q.trim();
  const results = useQuery(
    findGraveRef,
    trimmed.length >= 2 ? { query: trimmed } : "skip",
  );

  return (
    <div className="relative w-full sm:w-72">
      <div className="flex items-center gap-2 rounded-md border border-surface-border bg-surface-base px-3 py-2 focus-within:border-accent-gold">
        <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        <input
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Delay close so a result's click (mousedown) lands first.
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder="Find a grave by name…"
          aria-label="Find a grave by the deceased's name"
          data-testid="find-grave-input"
          className="w-full bg-transparent text-sm text-text-default outline-none placeholder:text-text-muted"
        />
      </div>

      {open && trimmed.length >= 2 && (
        <div className="absolute z-[1100] mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-surface-border bg-surface-base shadow-lg">
          {results === undefined ? (
            <div className="px-3 py-2 text-xs text-text-muted">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-muted">
              No graves match “{trimmed}”.
            </div>
          ) : (
            <ul>
              {results.map((hit) => (
                <li key={`${hit.lotId}:${hit.occupantName}`}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(hit);
                      setQ(hit.occupantName);
                      setOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-emphasis"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-default">
                        {hit.occupantName}
                      </span>
                      <span className="block font-mono text-[11px] text-text-muted">
                        Lot {hit.lotCode} · {hit.section}
                      </span>
                    </span>
                    <StatusPill status={hit.status} size="sm" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
