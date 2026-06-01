import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "@/components/marketing/BrandMark";
import { DecorativeArc } from "@/components/marketing/DecorativeArc";
import { SectionHead } from "@/components/marketing/SectionHead";
import { CTAStrip } from "@/components/marketing/CTAStrip";
import { CemeteryMapSVG } from "@/components/marketing/CemeteryMapSVG";
import { FindGraveSearch } from "@/components/marketing/FindGraveSearch";
import { MapLegend } from "@/components/marketing/MapLegend";
import { LotTypeGrid } from "@/components/marketing/LotTypeGrid";
import { ObituaryList } from "@/components/marketing/ObituaryList";
import { LOT_TYPES, OBITUARIES } from "@/components/marketing/data";

/**
 * Home — the primary brochure surface. Hero, find-a-grave, services
 * preview, map preview, lot-types preview, recent interments, CTA.
 *
 * Server component: every piece pulls from static data; the only
 * client islands are the find-a-grave search (input state) and the
 * cemetery map (mouse handlers).
 */
export default function MarketingHomePage() {
  return (
    <>
      <section className="relative overflow-hidden border-b border-surface-border bg-surface-muted">
        <DecorativeArc className="pointer-events-none absolute -right-40 top-1/2 hidden h-[800px] w-[800px] -translate-y-1/2 opacity-25 lg:block" />
        <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1.4fr_1fr] lg:items-center lg:gap-16 lg:px-8 lg:py-28">
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              A consecrated resting place · Since 1987
            </div>
            <h1 className="mt-6 font-display text-5xl font-light leading-[1.05] tracking-tight text-text-default sm:text-6xl lg:text-7xl">
              A peaceful place
              <br />
              for those we love.
            </h1>
            <span aria-hidden className="mt-7 block h-px w-16 bg-accent-gold" />
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-text-muted">
              Forty acres of laurel-shaded gardens in Aringay, La Union,
              stewarded by three generations of one family — where every name
              is remembered and every visit is welcomed.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                href="/contact"
                className="inline-flex items-center gap-2 rounded border border-primary bg-primary px-5 py-3 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-muted"
              >
                Schedule a visit
                <ArrowRight size={16} aria-hidden />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex items-center gap-2 rounded border border-primary px-5 py-3 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-muted"
              >
                View lot options
              </Link>
            </div>
          </div>
          <div className="mt-16 hidden items-center justify-center lg:mt-0 lg:flex">
            <BrandMark size={360} decorative={false} label="Apostle Paul Memorial Park dove and laurel mark" />
          </div>
        </div>
      </section>

      <section className="border-b border-surface-border bg-surface-base">
        <div className="mx-auto max-w-7xl gap-10 px-4 py-12 sm:px-6 lg:grid lg:grid-cols-[1fr_2fr] lg:items-center lg:px-8">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              Find a grave
            </div>
            <h2 className="mt-3 font-display text-2xl font-light leading-tight text-text-default sm:text-3xl">
              Look up someone resting here.
            </h2>
          </div>
          <div className="mt-6 lg:mt-0">
            <FindGraveSearch />
          </div>
        </div>
      </section>

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            eyebrow="What we provide"
            title="Care, in every season."
            lede="From the first inquiry through the years that follow, our staff stands alongside your family — quietly, attentively, and without surprise."
          />
          <div className="mt-12 grid grid-cols-1 gap-px overflow-hidden rounded border border-surface-border bg-surface-border sm:grid-cols-3">
            {SERVICE_CARDS.map((s) => (
              <div
                key={s.eyebrow}
                className="flex flex-col bg-surface-base p-7"
              >
                <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent-gold">
                  {s.eyebrow}
                </div>
                <h3 className="mt-4 font-display text-2xl font-light leading-tight text-text-default">
                  {s.title}
                </h3>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-text-muted">
                  {s.body}
                </p>
                <Link
                  href="/services"
                  className="mt-6 inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Learn more
                  <ArrowRight size={14} aria-hidden />
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-surface-border bg-surface-emphasis">
        <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1fr_1.6fr] lg:items-center lg:px-8">
          <div>
            <SectionHead
              eyebrow="Find your way"
              title="Six gardens. Two thousand stories."
              lede="Our grounds are divided into six gardens, each with its own character. Tap any plot to see availability, lot type, and pricing in real time."
            />
            <div className="mt-8">
              <Link
                href="/find-a-grave"
                className="inline-flex items-center gap-2 rounded border border-primary bg-primary px-5 py-3 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-emphasis"
              >
                Open the full map
                <ArrowRight size={16} aria-hidden />
              </Link>
            </div>
          </div>
          <div className="mt-10 rounded border border-surface-border bg-surface-base p-4 lg:mt-0">
            <CemeteryMapSVG />
            <div className="mt-4 border-t border-surface-border pt-4">
              <MapLegend />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            center
            eyebrow="Lot Types"
            title="A place that fits your family."
            lede="Single plots, family estates, mausoleums, and columbarium niches. Every option includes perpetual care and the right of visitation."
          />
          <div className="mt-12">
            <LotTypeGrid lots={LOT_TYPES} />
          </div>
          <div className="mt-12 text-center">
            <Link
              href="/pricing"
              className="inline-flex items-center gap-2 rounded border border-primary px-5 py-3 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-muted"
            >
              See all pricing &amp; inclusions
              <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
        </div>
      </section>

      <section className="border-t border-surface-border bg-surface-emphasis">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHead eyebrow="In Memoriam" title="Recently laid to rest." />
            <Link
              href="/news"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              View all
              <ArrowRight size={14} aria-hidden />
            </Link>
          </div>
          <div className="mt-10">
            <ObituaryList items={OBITUARIES.slice(0, 4)} />
          </div>
        </div>
      </section>

      <CTAStrip
        title="When you’re ready, we’ll be here."
        sub="Walk the grounds with our care director. No pressure, no obligation — just an unhurried hour together."
        primaryLabel="Schedule a visit"
        primaryHref="/contact"
        secondaryLabel="Plan ahead"
        secondaryHref="/plan-ahead"
      />
    </>
  );
}

const SERVICE_CARDS = [
  {
    eyebrow: "01 · Interment",
    title: "Burial & ceremony",
    body: "Coordination of the funeral procession, graveside service, and interment — including same-day arrangements when needed.",
  },
  {
    eyebrow: "02 · Memorial",
    title: "Markers & plaques",
    body: "Bronze and granite memorials cast and engraved by craftsmen we have worked with for two decades.",
  },
  {
    eyebrow: "03 · Perpetual care",
    title: "Stewardship in perpetuity",
    body: "Lawn, landscaping, and the lot itself maintained for as long as the park stands — included in every contract.",
  },
] as const;
