"use client";

/**
 * Drawing the cemetery, a row at a time.
 *
 * The practical way to map an irregular park with no survey. Pick the
 * run of lots — usually the next ones that have no position — click
 * where the row starts and where it ends, check the preview, save.
 * Twenty graves land at real coordinates at the real angle the row
 * runs, which is the thing no grid can express.
 *
 * Two clicks, not twenty. Placing 2,000 lots one at a time is not a
 * plan, and this is the only tool here that scales to a whole park.
 *
 * The preview is drawn at TRUE size, and if the lots do not fit the
 * line the screen says so rather than quietly rescaling them. A row
 * that always fits is a row that lies about how big a grave is.
 *
 * @gated-route-only — mounts under `/admin`; `lots:placeLotRow` re-checks
 * for admin or office staff server-side.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
/*
 * Imported from the server's own module rather than mirrored here.
 *
 * This repo's convention is for `src` to restate what `convex/lib`
 * computes, and elsewhere that is fine. Not here: the preview drawn on
 * this screen and the geometry the mutation writes must agree exactly,
 * or the map shows a row in one place and saves it in another. Two
 * copies of this arithmetic would eventually disagree, and the day they
 * did nothing would fail — the preview would simply stop being true.
 *
 * The module is pure TypeScript with no Convex imports, so it carries
 * nothing server-side into the browser bundle.
 */
import {
  fitWarning,
  layoutRow,
  type LatLng,
} from "../../../convex/lib/rowLayout";

interface Candidate {
  _id: string;
  code: string;
  block: string;
  row: string;
  status: string;
  type: string;
  widthM: number;
  depthM: number;
  placed: boolean;
  source: string | null;
}

const candidatesRef = makeFunctionReference<
  "query",
  { sectionName: string },
  Candidate[]
>("lots:listForRowDrawing");

const placeRowRef = makeFunctionReference<
  "mutation",
  { lotIds: string[]; start: LatLng; end: LatLng },
  { placed: number }
>("lots:placeLotRow");

interface SectionOutline {
  sectionId: string;
  name: string;
  displayName: string;
  boundary: LatLng[];
}

const boundariesRef = makeFunctionReference<
  "query",
  Record<string, never>,
  SectionOutline[]
>("sections:listSectionBoundaries");

export interface RowDrawerProps {
  /** The garden being drawn — matches `lots.section`. */
  sectionName: string;
  displayName: string;
  fallbackCentre: LatLng;
}

export function RowDrawer({
  sectionName,
  displayName,
  fallbackCentre,
}: RowDrawerProps): ReactElement {
  const candidates = useQuery(candidatesRef, { sectionName });
  const outlines = useQuery(boundariesRef, {});
  const placeRow = useMutation(placeRowRef);

  const [line, setLine] = useState<{
    start: LatLng | null;
    end: LatLng | null;
  }>({ start: null, end: null });
  const { start, end } = line;
  const [count, setCount] = useState("10");
  const [saving, setSaving] = useState(false);
  const [placedNote, setPlacedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const drawLayerRef = useRef<unknown>(null);
  const [ready, setReady] = useState(false);

  /**
   * The next lots with no position, in code order.
   *
   * Unplaced first because that is the work: a row of lots that already
   * have positions is a row somebody has done. Re-placing them is
   * possible — pick them explicitly — but it is not the default.
   */
  const unplaced = useMemo(
    () => (candidates ?? []).filter((c) => !c.placed),
    [candidates],
  );

  const n = Math.max(0, Math.min(Number.parseInt(count, 10) || 0, unplaced.length));
  const selected = unplaced.slice(0, n);

  const layout = useMemo(
    () =>
      start === null || end === null || selected.length === 0
        ? null
        : layoutRow(
            start,
            end,
            selected.map((s) => ({ widthM: s.widthM, depthM: s.depthM })),
          ),
    [start, end, selected],
  );
  const warning = layout === null ? null : fitWarning(layout);

  const outline = (outlines ?? []).find((o) => o.name === sectionName);

  // --- the map ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (container === null) return;

    (async () => {
      const L = await import("leaflet");
      await import("leaflet/dist/leaflet.css");
      if (cancelled || containerRef.current === null) return;

      const map = L.map(container, {
        center: [fallbackCentre.lat, fallbackCentre.lng],
        zoom: 18,
        keyboard: true,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 20,
      }).addTo(map);
      map.invalidateSize({ animate: false });

      drawLayerRef.current = L.layerGroup().addTo(map);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.on("click", (e: any) => {
        const p = { lat: e.latlng.lat as number, lng: e.latlng.lng as number };
        setPlacedNote(null);
        // First click starts the line, second ends it, third begins a
        // new one. No mode to remember and no way to get stuck.
        setLine((prev) =>
          prev.start === null
            ? { start: p, end: null }
            : prev.end === null
              ? { start: prev.start, end: p }
              : { start: p, end: null },
        );
      });

      mapRef.current = map;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      const map = mapRef.current as { remove?: () => void } | null;
      if (map !== null && typeof map.remove === "function") map.remove();
      mapRef.current = null;
      drawLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- draw the garden, the line and the preview -----------------------
  useEffect(() => {
    if (!ready) return;
    const layer = drawLayerRef.current as {
      clearLayers: () => void;
      addLayer: (l: unknown) => void;
    } | null;
    if (layer === null) return;

    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled) return;
      layer.clearLayers();

      if (outline !== undefined) {
        layer.addLayer(
          L.polygon(
            outline.boundary.map((p) => [p.lat, p.lng] as [number, number]),
            {
              color: "#1D5C4D",
              weight: 2,
              fillColor: "#1D5C4D",
              fillOpacity: 0.06,
              interactive: false,
            },
          ),
        );
      }

      if (start !== null) {
        layer.addLayer(
          L.circleMarker([start.lat, start.lng], {
            radius: 6,
            color: "#ffffff",
            weight: 2,
            fillColor: "#1D5C4D",
            fillOpacity: 1,
          }).bindTooltip("Row starts here", { direction: "top" }),
        );
      }
      if (start !== null && end !== null) {
        layer.addLayer(
          L.polyline(
            [
              [start.lat, start.lng],
              [end.lat, end.lng],
            ],
            { color: "#C9A96B", weight: 2, dashArray: "6 4" },
          ),
        );
      }

      // The lots at true size, so the fit is visible and not just
      // asserted in a sentence underneath.
      if (layout !== null) {
        layout.placements.forEach((p, i) => {
          layer.addLayer(
            L.polygon(
              p.polygon.map((c) => [c.lat, c.lng] as [number, number]),
              {
                color: "#1D5C4D",
                weight: 1,
                fillColor: "#8FBF9F",
                fillOpacity: 0.55,
                interactive: false,
              },
            ).bindTooltip(selected[i]?.code ?? "", { direction: "top" }),
          );
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, outline, start, end, layout, selected]);

  async function handleSave(): Promise<void> {
    if (start === null || end === null || selected.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await placeRow({
        lotIds: selected.map((s) => s._id),
        start,
        end,
      });
      setPlacedNote(
        `Placed ${res.placed} lot${res.placed === 1 ? "" : "s"}: ${selected[0]!.code} to ${selected[selected.length - 1]!.code}.`,
      );
      setLine({ start: null, end: null });
    } catch (e: unknown) {
      setError(translateError(e).detail);
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    start !== null && end !== null && selected.length > 0 && !saving;

  return (
    <div className="space-y-4" data-testid="row-drawer">
      <div
        role="status"
        className="rounded-md border border-surface-border bg-surface-muted px-4 py-3 text-sm text-text-default"
      >
        Click where the row <strong>starts</strong>, then where it{" "}
        <strong>ends</strong>. The next {n === 0 ? "" : n} unplaced lot
        {n === 1 ? "" : "s"} in {displayName} are laid along it in code
        order, at their own recorded sizes.
        <span className="mt-1 block text-xs text-text-muted">
          A third click starts a new line. Nothing is saved until you press
          Place.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text-default">
            Lots in this row
          </span>
          <input
            value={count}
            onChange={(e) => setCount(e.target.value)}
            inputMode="numeric"
            data-testid="row-count"
            className="w-24 rounded-md border border-surface-border px-2 py-1.5 text-sm"
          />
        </label>
        <p data-testid="row-available" className="text-xs text-text-muted">
          {candidates === undefined
            ? "Loading lots…"
            : unplaced.length === 0
              ? "Every lot in this garden already has a position."
              : `${unplaced.length} lot${unplaced.length === 1 ? "" : "s"} in ${displayName} still have no position.`}
        </p>
      </div>

      {selected.length > 0 && (
        <p data-testid="row-selection" className="text-xs text-text-muted">
          Next up: <span className="font-mono">{selected[0]!.code}</span> to{" "}
          <span className="font-mono">
            {selected[selected.length - 1]!.code}
          </span>
          .
        </p>
      )}

      <div
        ref={containerRef}
        role="application"
        aria-label={`Click to draw a row of lots in ${displayName}.`}
        data-testid="row-map"
        className="isolate w-full overflow-hidden rounded-md border border-surface-border bg-surface-muted"
        style={{ height: "60vh", minHeight: 360 }}
      />

      {/*
        The fit, in metres. Shown rather than corrected: a big mismatch
        almost always means the wrong number of lots, and silently
        rescaling them to fit would hide that AND misstate the size of
        every grave in the row.
      */}
      {warning !== null && (
        <p
          role="status"
          data-testid="row-fit-warning"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {warning}
        </p>
      )}

      {layout !== null && warning === null && (
        <p data-testid="row-fit-ok" className="text-xs text-text-muted">
          {selected.length} lots, {Math.round(layout.rowLengthM)}m of ground —
          matches the line you drew.
        </p>
      )}

      {error !== null && (
        <p
          role="alert"
          data-testid="row-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}

      {placedNote !== null && (
        <p
          role="status"
          data-testid="row-placed"
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          {placedNote} Draw the next row.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canSave}
          data-testid="row-place"
          onClick={() => void handleSave()}
          className="min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-semibold text-white disabled:bg-slate-300"
        >
          {saving ? "Placing…" : `Place ${selected.length} lots`}
        </button>
        <button
          type="button"
          disabled={start === null || saving}
          data-testid="row-clear"
          onClick={() => {
            setLine({ start: null, end: null });
            setPlacedNote(null);
          }}
          className="min-h-[38px] rounded-md border border-surface-border px-3 py-1.5 text-sm font-medium text-text-default disabled:text-text-muted"
        >
          Clear the line
        </button>
      </div>
    </div>
  );
}
