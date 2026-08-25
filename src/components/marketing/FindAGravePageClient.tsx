"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  CemeteryMapSVG,
  type CemeterySectionPick,
} from "./CemeteryMapSVG";
import { MapLegend } from "./MapLegend";
import { gridOf, SECTIONS } from "./cemetery-model";
import { cn } from "@/lib/cn";

/**
 * The 3D view is the SAME component the staff survey at `/phase-3d`
 * uses, in its public variant — same scene, same controls, same detail
 * rail. An earlier attempt drew a separate, simpler scene here, and the
 * two surfaces looked nothing alike; sharing the component is the only
 * thing that actually keeps them the same.
 *
 * Three.js is far too heavy for a marketing page's first load, so it is
 * fetched only when a visitor asks for 3D. `ssr: false` because WebGL
 * is browser-only.
 */
const Phase3DMap = dynamic(
  () => import("@/components/Phase3DMap").then((m) => m.Phase3DMap),
  {
  ssr: false,
  loading: () => (
    <div
      role="status"
      className="flex h-[60vh] min-h-[460px] items-center justify-center rounded-lg bg-surface-emphasis text-sm text-text-muted"
    >
      Preparing the 3D view&hellip;
    </div>
  ),
  },
);

/**
 * The park's six gardens, described for the 3D scene. Grid shape comes
 * from the same plan the flat map draws, so both views show the same
 * gardens at the same relative sizes.
 */
/** Small words stay lowercase — "Garden of Faith", not "Garden Of Faith". */
const MINOR_WORDS = new Set(["of", "the", "and"]);

function titleCase(label: string): string {
  return label
    .toLowerCase()
    .split(" ")
    .map((word, i) =>
      i > 0 && MINOR_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

const PARK_SECTIONS = SECTIONS.map((section, i) => {
  const { columns, rows } = gridOf(section);
  return {
    id: section.id,
    code: section.label.replace(/^(GARDEN OF |COLUMBARIUM |MAUSOLEUM )/, ""),
    // The plan stores labels in caps, which suits the flat map's
    // small type. The 3D scene sets them in the display serif, where
    // caps read as shouting — so title-case them for that view.
    name: titleCase(section.label),
    cols: columns,
    rows,
    // Gentle turf variation so neighbouring gardens read apart.
    tint: [0x8fab7f, 0x86a276, 0x93ad84, 0x8aa87c, 0x8fae82, 0x849f77][i % 6]!,
    mausoleum: section.label.includes("MAUSOLEUM"),
  };
});

type ViewMode = "plan" | "three";

type Filter = "all" | "available" | "reserved" | "occupied";

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "available", label: "Available" },
  { id: "reserved", label: "Reserved" },
  { id: "occupied", label: "Occupied" },
];

const DEFAULT_PICK: CemeterySectionPick = {
  section: "GARDEN OF FAITH",
  id: "B-104",
  status: "available",
};

/**
 * Find-a-Grave interactive surface — filter chips above a clickable
 * cemetery map, with a side panel that swaps based on the picked lot's
 * status. When a visitor clicks an Available cell they see pricing
 * and a Reserve CTA; Occupied shows the resident; Reserved redirects
 * to the owner portal for verification.
 *
 * The map illustration here is a stylized wayfinding sketch (the same
 * one used on Home). When the Phase 2 Leaflet migration ships, this
 * panel will swap to a live tile-based map but the data shape and
 * interactions will remain identical.
 */
export function FindAGravePageClient() {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<CemeterySectionPick>(DEFAULT_PICK);
  // The flat plan is the default: it is the accessible view, and it
  // costs nothing to load. 3D is an enhancement a visitor opts into.
  const [view, setView] = useState<ViewMode>("plan");

  return (
    <section className="bg-surface-emphasis">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          {view === "plan" ? (
          <div
            role="group"
            aria-label="Filter lots by status"
            className="flex flex-wrap gap-2"
          >
            {FILTERS.map((t) => {
              const active = filter === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFilter(t.id)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-full border px-4 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    active
                      ? "border-primary bg-primary text-primary-fg"
                      : "border-surface-border text-text-default hover:border-primary hover:text-primary",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          ) : (
            <p className="text-sm text-text-muted">
              Drag to turn the park. Click any plot to see it.
            </p>
          )}

          <div
            role="group"
            aria-label="Map view"
            className="flex overflow-hidden rounded-full border border-surface-border"
          >
            {(
              [
                { id: "plan", label: "Plan" },
                { id: "three", label: "3D" },
              ] as const
            ).map((v) => {
              const active = view === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  aria-pressed={active}
                  className={cn(
                    "px-4 py-1.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    active
                      ? "bg-primary text-primary-fg"
                      : "text-text-default hover:text-primary",
                  )}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        </div>

        {view === "three" ? (
          // The 3D view brings its own filters, legend and lot rail,
          // so it takes the full width and the page steps back.
          <Phase3DMap
            variant="public"
            sections={PARK_SECTIONS}
            parcelLabel="Apostle Paul Memorial Park"
          />
        ) : (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="rounded border border-surface-border bg-surface-base p-5">
          <CemeteryMapSVG
            interactive
            onSelect={setSelected}
            selectedId={selected.id}
          />
          <div className="mt-5 border-t border-surface-border pt-4">
            <MapLegend />
          </div>
        </div>

        <aside
          aria-label="Lot detail"
          className="self-start rounded border border-surface-border bg-surface-base p-7"
        >
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
            {selected.section}
          </div>
          <h2 className="mt-3 font-display text-3xl font-light leading-tight text-text-default">
            Lot {selected.id}
          </h2>
          <span aria-hidden className="mt-5 block h-px w-16 bg-accent-gold" />

          <div className="mt-5">
            <StatusTag status={selected.status} />
          </div>

          <div className="mt-8">
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              Specifications
            </div>
            <dl className="mt-3">
              <SpecRow label="Lot type" value="Family estate" />
              <SpecRow label="Dimensions" value="4.0 m × 2.4 m" />
              <SpecRow label="Capacity" value="6 interments" />
              <SpecRow
                label="Garden"
                value={selected.section.replace("GARDEN OF ", "")}
              />
              <SpecRow label="GPS" value="16.3997° N, 120.3500° E" />
            </dl>
          </div>

          {selected.status === "available" ? (
            <>
              <div className="mt-8">
                <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
                  Pricing
                </div>
                <div className="mt-3 border-y border-surface-border py-4">
                  <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                    From
                  </div>
                  <div className="mt-1 font-display text-4xl text-primary">
                    ₱340,000
                  </div>
                  <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
                    Or ₱7,200 / month · 48 months
                  </div>
                </div>
              </div>
              <div className="mt-7 flex flex-col gap-3">
                <Link
                  href="/contact"
                  className="inline-flex items-center justify-center gap-2 rounded border border-primary bg-primary px-5 py-3 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
                >
                  Reserve this lot
                  <ArrowRight size={16} aria-hidden />
                </Link>
                <Link
                  href="/contact"
                  className="inline-flex items-center justify-center gap-2 rounded border border-primary px-5 py-3 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
                >
                  Schedule a viewing
                </Link>
              </div>
            </>
          ) : null}

          {selected.status === "occupied" ? (
            <div className="mt-8">
              <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
                Resting here
              </div>
              <div className="mt-3 border-t border-surface-border pt-4">
                <div className="font-display text-2xl font-light italic text-text-default">
                  Maria S. Reyes
                </div>
                <div className="mt-1 font-mono text-xs uppercase tracking-[0.14em] text-text-muted">
                  1947 — 2018
                </div>
              </div>
              <Link
                href="/news"
                className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Leave a remembrance
                <ArrowRight size={14} aria-hidden />
              </Link>
            </div>
          ) : null}

          {selected.status === "reserved" ? (
            <div className="mt-8 border-t border-surface-border pt-5">
              <p className="text-base leading-relaxed text-text-muted">
                This lot is reserved. If you are the owner and need to confirm
                details, please{" "}
                <Link
                  href="/portal/login"
                  className="text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  sign in to the owner portal
                </Link>
                .
              </p>
            </div>
          ) : null}
        </aside>
        </div>
        )}
      </div>
    </section>
  );
}

function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-t border-surface-border py-3">
      <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
        {label}
      </dt>
      <dd className="text-sm text-text-default">{value}</dd>
    </div>
  );
}

function StatusTag({
  status,
}: {
  status: CemeterySectionPick["status"];
}) {
  const styles =
    status === "available"
      ? "border-primary text-primary"
      : status === "reserved"
        ? "border-accent-gold text-accent-gold"
        : "border-text-subtle text-text-muted";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em]",
        styles,
      )}
    >
      {status}
    </span>
  );
}
