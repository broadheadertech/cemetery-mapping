import type { Metadata } from "next";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { SectionHead } from "@/components/marketing/SectionHead";
import { CTAStrip } from "@/components/marketing/CTAStrip";

export const metadata: Metadata = {
  title: "Plan Ahead",
  description:
    "Pre-need arrangements lift the heaviest burden from your family’s shoulders, and lock today’s price against the years.",
};

const REASONS = [
  {
    n: "01",
    title: "It’s the kindest thing.",
    body: "When the time comes, your family will not need to choose a lot, pick a marker, or argue about cost. You will have done that — quietly, on your own time, and your way.",
  },
  {
    n: "02",
    title: "Today’s price, locked.",
    body: "Lots have appreciated 4–7% annually since 1987. A pre-need contract locks the rate of the day you sign — for whenever the day comes.",
  },
  {
    n: "03",
    title: "On your own schedule.",
    body: "Installment plans up to 60 months. No medical exam. Fully transferable to direct heirs if circumstances change.",
  },
] as const;

const STEPS = [
  {
    n: 1,
    title: "The visit",
    body: "Walk the grounds with a care director. See the gardens. Ask anything.",
  },
  {
    n: 2,
    title: "The shortlist",
    body: "We send you a written shortlist of available lots that match what you said. No follow-up calls.",
  },
  {
    n: 3,
    title: "The reading",
    body: "Sit down and read the contract together. Bring family, bring an attorney — both, if you like.",
  },
  {
    n: 4,
    title: "The keeping",
    body: "You hold the contract. We hold the lot. The first payment is whatever you set.",
  },
] as const;

const EXAMPLE_ROWS = [
  { label: "Lot price", value: "₱340,000" },
  { label: "Down payment (20%)", value: "₱68,000" },
  { label: "Monthly · 48 months", value: "₱5,667" },
  { label: "Interest", value: "0%" },
  { label: "Perpetual care", value: "Included" },
] as const;

export default function PlanAheadPage() {
  return (
    <>
      <PageHero
        eyebrow="Plan Ahead"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            A gift to the ones who’ll have to decide.
          </h1>
        }
        lede="Pre-need arrangements lift the heaviest burden — the decisions — from your family’s shoulders, and lock today’s price against the years."
      />

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
            {REASONS.map((r) => (
              <div key={r.n}>
                <div className="font-display text-5xl italic leading-none text-accent-gold">
                  {r.n}
                </div>
                <span
                  aria-hidden
                  className="mt-5 block h-px w-16 bg-accent-gold"
                />
                <h3 className="mt-6 font-display text-2xl font-light leading-tight text-text-default">
                  {r.title}
                </h3>
                <p className="mt-4 text-base leading-relaxed text-text-default">
                  {r.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-emphasis">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            center
            eyebrow="How it works"
            title="Four conversations. That’s it."
            lede="Pre-need is not a sales process. It’s a series of conversations across a few weeks. Most families decide within three visits."
          />
          <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="rounded border-t-[3px] border-accent-gold bg-surface-base p-7"
              >
                <div className="font-display text-4xl leading-none text-primary">
                  0{s.n}
                </div>
                <h3 className="mt-5 font-display text-xl font-light leading-tight text-text-default">
                  {s.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-text-muted">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-2 lg:items-center lg:px-8">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              Pre-need payment example
            </div>
            <h2 className="mt-4 font-display text-3xl font-light leading-tight text-text-default sm:text-4xl">
              A family lot, paid over four years.
            </h2>
            <span aria-hidden className="mt-5 block h-px w-16 bg-accent-gold" />
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-text-default">
              A family estate in Garden of Faith — six interments, perpetual
              care included, current price ₱340,000. With a 20% down payment
              and 48 monthly installments at zero interest:
            </p>
          </div>
          <div className="mt-10 rounded border-t-[3px] border-accent-gold bg-surface-base p-7 lg:mt-0">
            <dl>
              {EXAMPLE_ROWS.map((r) => (
                <div
                  key={r.label}
                  className="flex items-baseline justify-between border-t border-surface-border py-3 first:border-t-0"
                >
                  <dt className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">
                    {r.label}
                  </dt>
                  <dd className="text-base text-text-default">{r.value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-7 bg-surface-emphasis p-5 text-center">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                Effective weekly cost
              </div>
              <div className="mt-2 font-display text-4xl text-primary">
                ₱1,308
              </div>
            </div>
          </div>
        </div>
      </section>

      <CTAStrip
        title="Start the first conversation."
        sub="No paperwork on the first visit — just a walk through the gardens. Bring a list of questions; bring family if you want."
        primaryLabel="Schedule a visit"
        primaryHref="/contact"
        secondaryLabel="See lot pricing"
        secondaryHref="/pricing"
      />
    </>
  );
}
