import type { Metadata } from "next";
import { BrandMark } from "@/components/marketing/BrandMark";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { SectionHead } from "@/components/marketing/SectionHead";
import { CTAStrip } from "@/components/marketing/CTAStrip";

export const metadata: Metadata = {
  title: "Our Story",
  description:
    "Apostle Paul Memorial Park was consecrated in 1987 on land Don Eulalio Mendoza set aside as a place where the families of his parish could rest near home.",
};

const PROMISES = [
  {
    n: "I",
    title: "Presence over process.",
    body: "We meet every family in person. No call center, no script — a member of the Mendoza family is on the grounds every day.",
  },
  {
    n: "II",
    title: "Transparent pricing.",
    body: "Every inclusion is written into the contract. We do not invoice for what was already promised, ever.",
  },
  {
    n: "III",
    title: "Perpetual stewardship.",
    body: "The park itself is a non-transferable trust. Lots cannot be redeveloped, resold to outsiders, or repurposed. Period.",
  },
] as const;

const DIRECTORS = [
  {
    name: "Teresita Mendoza-Aquino",
    role: "Director · 2003–present",
    bio: "Daughter of the founder. Speaks Tagalog, English, and a passable Hokkien. Will likely bring you coffee.",
  },
  {
    name: "Fr. Joaquin Aquino",
    role: "Deacon · Care liaison",
    bio: "Ordained 2012. Officiates non-denominational services and is on call for every interment.",
  },
  {
    name: "Andres Aquino",
    role: "Grounds · Landscape architect",
    bio: "Studied at UP Los Baños. Designed the columbarium and the new Garden of Hope.",
  },
] as const;

export default function AboutPage() {
  return (
    <>
      <PageHero
        eyebrow="Our Story"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            Three generations. Forty acres. One vow.
          </h1>
        }
        lede="Apostle Paul Memorial Park was consecrated in 1987 on land Don Eulalio Mendoza set aside as a place where the families of his parish could rest near home. We have been here ever since."
      />

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1fr_1.4fr] lg:px-8">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              A short history
            </div>
            <h2 className="mt-4 font-display text-3xl font-light leading-tight text-text-default sm:text-4xl">
              From parish land
              <br />
              to memorial park.
            </h2>
            <span aria-hidden className="mt-5 block h-px w-16 bg-accent-gold" />
          </div>
          <div className="mt-10 flex flex-col gap-6 text-lg leading-relaxed text-text-default lg:mt-0">
            <p>
              The first thirty interments at Apostle Paul were the
              parishioners of San Pablo de Tarso — neighbors, godparents,
              schoolteachers. Don Eulalio paid the priest, dug the wells, and
              planted the laurel trees that now arch over the central walk.
            </p>
            <p>
              When he died in 2003, his daughter Teresita took over the daily
              care of the park. Her sons — a landscape architect and a parish
              deacon — joined her in 2014, and today the three of them sit
              with every family who comes through the gate.
            </p>
            <p>
              We are still a family business, and we still believe that what
              we do is, above all else, a ministry of presence. We will be
              here when the call comes, whatever the hour.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-surface-emphasis">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            eyebrow="Our promise"
            title="What we hold ourselves to."
            center
          />
          <div className="mt-14 grid grid-cols-1 gap-10 md:grid-cols-3">
            {PROMISES.map((v) => (
              <div key={v.n} className="border-t border-accent-gold pt-7">
                <div className="font-display text-5xl italic leading-none text-accent-gold">
                  {v.n}
                </div>
                <h3 className="mt-5 font-display text-2xl font-light leading-tight text-text-default">
                  {v.title}
                </h3>
                <p className="mt-3 text-base leading-relaxed text-text-muted">
                  {v.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            eyebrow="Care directors"
            title="The people you will meet."
          />
          <div className="mt-14 grid grid-cols-1 gap-8 md:grid-cols-3">
            {DIRECTORS.map((p) => (
              <article
                key={p.name}
                className="flex flex-col rounded border border-surface-border bg-surface-base p-7"
              >
                <div className="flex h-44 items-center justify-center border border-dashed border-surface-border bg-surface-muted">
                  <BrandMark size={88} />
                </div>
                <h3 className="mt-6 font-display text-2xl font-light leading-tight text-text-default">
                  {p.name}
                </h3>
                <div className="mt-2 font-mono text-xs uppercase tracking-[0.14em] text-text-muted">
                  {p.role}
                </div>
                <p className="mt-4 text-base leading-relaxed text-text-default">
                  {p.bio}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <CTAStrip
        title="Come and see for yourself."
        sub="The best way to know us is to walk the grounds. Tell us when works — we’ll keep an hour free."
        primaryLabel="Schedule a visit"
        primaryHref="/contact"
      />
    </>
  );
}
