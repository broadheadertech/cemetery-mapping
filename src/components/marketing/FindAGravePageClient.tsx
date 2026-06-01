"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import {
  CemeteryMapSVG,
  type CemeterySectionPick,
} from "./CemeteryMapSVG";
import { MapLegend } from "./MapLegend";
import { cn } from "@/lib/cn";

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

  return (
    <section className="bg-surface-emphasis">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[1.6fr_1fr] lg:px-8">
        <div className="rounded border border-surface-border bg-surface-base p-5">
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
          <div className="mt-5">
            <CemeteryMapSVG interactive onSelect={setSelected} />
          </div>
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
