import type { Metadata } from "next";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { SectionHead } from "@/components/marketing/SectionHead";
import { CTAStrip } from "@/components/marketing/CTAStrip";
import { FaqAccordion } from "@/components/marketing/FaqAccordion";
import { RESOURCE_ARTICLES, FAQS } from "@/components/marketing/data";

export const metadata: Metadata = {
  title: "Grief & Resources",
  description:
    "Articles, checklists, and answers to the questions families have asked us most often. Free to read, free to print, free to share.",
};

const CHECKLIST = [
  "Call the parlor or hospital to confirm the death certificate process",
  "Notify the immediate family — make a single phone tree",
  "Call us. We will help with everything below.",
  "Choose a date and time for the interment service",
  "Confirm the procession route and meet-up point",
  "Send your inscription text (Tagalog and/or English)",
  "Arrange the wake — flowers, food, seating, candles",
  "Send the obituary to the parish bulletin and to us",
  "Photograph the floral arrangements before they wilt",
  "Take a quiet hour, alone, when it is over",
] as const;

export default function ResourcesPage() {
  return (
    <>
      <PageHero
        eyebrow="Grief & Resources"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            What might help, in the meantime.
          </h1>
        }
        lede="Articles, checklists, and answers to the questions families have asked us most often. Free to read, free to print, free to share."
      />

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead eyebrow="From our library" title="Articles & guides" />
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {RESOURCE_ARTICLES.map((a, i) => (
              <article
                key={a.title}
                className="flex flex-col rounded border border-surface-border bg-surface-base p-7"
              >
                <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent-gold">
                  {a.eyebrow}
                </div>
                <h3 className="mt-4 font-display text-2xl font-light leading-tight text-text-default">
                  {a.title}
                </h3>
                <div className="mt-auto pt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
                  {a.meta} · {String(i + 1).padStart(2, "0")}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-emphasis">
        <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1fr_1.4fr] lg:px-8">
          <SectionHead
            eyebrow="A planning checklist"
            title="What to do in the first week."
            lede="A practical, no-nonsense list. Print it. Cross things off. Set it down and come back."
          />
          <div className="mt-10 rounded border-t-[3px] border-accent-gold bg-surface-base p-7 lg:mt-0">
            <ul>
              {CHECKLIST.map((step, i) => (
                <li
                  key={step}
                  className={
                    i === 0
                      ? "flex items-baseline gap-4 py-3"
                      : "flex items-baseline gap-4 border-t border-surface-border py-3"
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={step}
                    className="mt-1 h-4 w-4 accent-primary"
                  />
                  <span className="text-base leading-relaxed text-text-default">
                    {step}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            center
            eyebrow="Frequently asked"
            title="Questions we hear most often."
          />
          <div className="mt-12">
            <FaqAccordion items={FAQS} />
          </div>
        </div>
      </section>

      <CTAStrip
        title="If a question is missing, ask us."
        sub="Send a note. We answer everything personally — usually the same day."
        primaryLabel="Get in touch"
        primaryHref="/contact"
      />
    </>
  );
}
