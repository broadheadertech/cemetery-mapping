"use client";

/**
 * LotFactsPanel — Story 1.11 (AC1).
 *
 * The "Lot facts" section of the detail page: type, dimensions
 * (W × D m), section/block/row, base price (`formatPeso`), and the
 * `geometryStatus` pill (placeholder vs surveyed — Story 1.9).
 *
 * Pure presentational: receives a slim `LotFactsData` projection
 * instead of the full lot doc so the panel is decoupled from any
 * future schema extension. Story 1.9's geometry centroid is surfaced
 * here as a tiny mono-spaced lat/lng pair — the actual map preview
 * lands with Story 1.12.
 */

import { NavigateToLotButton } from "@/components/NavigateToLotButton";
import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import { formatPeso } from "@/lib/money";
import type { LotStatus } from "@/types/lot-status";

export interface LotFactsData {
  code?: string;
  section: string;
  block: string;
  row: string;
  type: "single" | "family" | "mausoleum" | "niche";
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
  status: LotStatus;
  geometryStatus: "placeholder" | "surveyed";
  geometry?: {
    centroid: { lat: number; lng: number };
  };
}

export interface LotFactsPanelProps {
  facts: LotFactsData;
}

export function LotFactsPanel({ facts }: LotFactsPanelProps) {
  return (
    <section
      aria-labelledby="lot-facts-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="lot-facts-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Lot facts
      </h2>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        <Row label="Type">
          <span className="capitalize">{facts.type}</span>
        </Row>
        <Row label="Section / Block / Row">
          {facts.section} / {facts.block} / {facts.row}
        </Row>
        <Row label="Dimensions">
          {facts.dimensions.widthM} m × {facts.dimensions.depthM} m
        </Row>
        <Row label="Base price">
          <ReactiveHighlight watch={facts.basePriceCents}>
            <span className="tabular-nums">
              {formatPeso(facts.basePriceCents)}
            </span>
          </ReactiveHighlight>
        </Row>
        <Row label="Geometry">
          <GeometryStatusPill status={facts.geometryStatus} />
        </Row>
        {facts.geometry !== undefined && (
          <Row label="Centroid">
            <span className="font-mono text-xs tabular-nums text-slate-600">
              {facts.geometry.centroid.lat.toFixed(5)},{" "}
              {facts.geometry.centroid.lng.toFixed(5)}
            </span>
          </Row>
        )}
      </dl>
      {/*
        Story 8.3 — Navigate-to-lot. The button sits at the bottom of
        the geometry section so Junior's primary field action is
        visually anchored to the coordinates it acts on. Disabled
        state + tooltip live inside the button itself.
      */}
      <div
        className="mt-4 flex flex-wrap items-center justify-start gap-2"
        data-testid="lot-facts-navigate"
      >
        <NavigateToLotButton
          lotCode={facts.code ?? ""}
          geometryStatus={facts.geometryStatus}
          {...(facts.geometry !== undefined
            ? { centroid: facts.geometry.centroid }
            : {})}
        />
      </div>
    </section>
  );
}

/**
 * Geometry-status pill — local to this panel because it visually
 * differs from `<StatusPill>` (it is not a domain state machine, just
 * a static "placeholder vs surveyed" badge).
 *
 * Per UX § Status palette, placeholder is muted slate and surveyed is
 * the same emerald used elsewhere for "complete" semantics.
 */
function GeometryStatusPill({
  status,
}: {
  status: "placeholder" | "surveyed";
}) {
  const isSurveyed = status === "surveyed";
  return (
    <span
      role="status"
      data-geometry-status={status}
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
        isSurveyed
          ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
          : "bg-slate-100 text-slate-700 border border-slate-200",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          "inline-block h-1.5 w-1.5 rounded-full",
          isSurveyed ? "bg-emerald-500" : "bg-slate-400",
        ].join(" ")}
      />
      <span>{isSurveyed ? "Surveyed" : "Placeholder"}</span>
    </span>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-slate-900">{children}</dd>
    </div>
  );
}
