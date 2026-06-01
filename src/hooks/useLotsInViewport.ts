"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import type { Bbox, LotGeometry } from "@/lib/geometry";
import type { LotStatus } from "@/types/lot-status";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

/**
 * `useLotsInViewport` — Story 1.12.
 *
 * Debounced wrapper around `api.lots.listInBbox` (Story 1.9). The
 * server-side query is bbox-scoped and capped at 200 / 500 lots; this
 * hook adds the client-side debounce so panning/zooming the map
 * doesn't fire a query on every animation frame.
 *
 * Debounce policy:
 *   - 250ms tail-debounce on the bbox arg. Empirically chosen: under
 *     250ms a fast-panning user generates 3–4 queries/sec (≤ the 4/sec
 *     architectural budget); above 400ms the map feels laggy.
 *   - Filters (`status`) are NOT debounced. Filter clicks are discrete
 *     UI events, not continuous gestures; immediate re-query keeps the
 *     UX snappy.
 *
 * Skip semantics:
 *   - When `bbox` is `null` (e.g. SSR / pre-mount), the hook returns
 *     `{ lots: undefined, isLoading: true }` and does not call Convex
 *     at all. Convex's `useQuery` accepts `"skip"` to suppress the
 *     subscription — that's the canonical pattern from Story 1.10.
 *
 * Return shape:
 *   - `lots: undefined` — first render or query in-flight.
 *   - `lots: LotForMap[]` — query resolved, may be empty.
 *   - `isLoading` is a derived boolean: `lots === undefined`.
 */
export interface LotForMap {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  status: LotStatus;
  geometry: LotGeometry;
  geometryStatus: "placeholder" | "surveyed";
}

export interface UseLotsInViewportArgs {
  bbox: Bbox | null;
  statusFilters?: ReadonlyArray<LotStatus>;
  /** Debounce window in milliseconds. Default 250ms. */
  debounceMs?: number;
  /** Server-side cap. Defaults to 200 per Story 1.9. Ceiling is 500. */
  limit?: number;
}

export interface UseLotsInViewportResult {
  lots: LotForMap[] | undefined;
  isLoading: boolean;
}

const listInBboxRef = makeFunctionReference<
  "query",
  {
    bboxMinLat: number;
    bboxMaxLat: number;
    bboxMinLng: number;
    bboxMaxLng: number;
    statusFilter?: LotStatus;
    limit?: number;
  },
  LotForMap[]
>("lots:listInBbox");

export function useLotsInViewport(
  args: UseLotsInViewportArgs,
): UseLotsInViewportResult {
  const { bbox, statusFilters, debounceMs = 250, limit = 200 } = args;

  // Stable string key for the bbox so reference-only changes (same
  // numbers, new object identity from a parent re-render) don't restart
  // the debounce timer. `useDebouncedValue` debounces by value
  // equality, and object references differ even when contents match.
  const bboxKey = useMemo(
    () =>
      bbox === null
        ? null
        : `${bbox.bboxMinLat},${bbox.bboxMaxLat},${bbox.bboxMinLng},${bbox.bboxMaxLng}`,
    [bbox],
  );
  const debouncedKey = useDebouncedValue(bboxKey, debounceMs);

  // Recover the bbox from the debounced key. Holding the latest bbox
  // here lets us avoid double-debouncing the underlying object reference.
  const debouncedBbox = useMemo<Bbox | null>(() => {
    if (debouncedKey === null) return null;
    const parts = debouncedKey.split(",").map(Number);
    return {
      bboxMinLat: parts[0]!,
      bboxMaxLat: parts[1]!,
      bboxMinLng: parts[2]!,
      bboxMaxLng: parts[3]!,
    };
  }, [debouncedKey]);

  // The server query takes a single `statusFilter` arg. When multiple
  // statuses are selected we fetch all (no filter) and let the renderer
  // do client-side filtering — the bbox cap (≤ 200) keeps this cheap.
  const singleStatusFilter =
    statusFilters !== undefined && statusFilters.length === 1
      ? statusFilters[0]
      : undefined;

  const queryArgs =
    debouncedBbox === null
      ? ("skip" as const)
      : {
          bboxMinLat: debouncedBbox.bboxMinLat,
          bboxMaxLat: debouncedBbox.bboxMaxLat,
          bboxMinLng: debouncedBbox.bboxMinLng,
          bboxMaxLng: debouncedBbox.bboxMaxLng,
          ...(singleStatusFilter !== undefined
            ? { statusFilter: singleStatusFilter }
            : {}),
          limit,
        };

  const raw = useQuery(listInBboxRef, queryArgs);

  // Client-side multi-status filter (only when the server-side single
  // filter wasn't enough).
  const filtered =
    raw === undefined
      ? undefined
      : statusFilters !== undefined &&
          statusFilters.length > 1 &&
          statusFilters.length < 7 /* total lot statuses */
        ? raw.filter((lot) => statusFilters.includes(lot.status))
        : raw;

  return {
    lots: filtered,
    isLoading: filtered === undefined,
  };
}
