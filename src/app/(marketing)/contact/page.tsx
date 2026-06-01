import type { Metadata } from "next";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { SectionHead } from "@/components/marketing/SectionHead";
import { ScheduleVisitForm } from "@/components/marketing/ScheduleVisitForm";

export const metadata: Metadata = {
  title: "Visit Us",
  description:
    "Whether the need is immediate or years away, the way we meet families is the same: an hour of your time, a slow walk, honest answers.",
};

const CONTACT_METHODS = [
  {
    eyebrow: "By phone — immediate",
    big: "+63 (72) 562-0187",
    sub: "Answered by Teresita or one of her sons, 6am to 10pm daily.",
    bigClass: "text-3xl sm:text-4xl text-primary",
  },
  {
    eyebrow: "By email — within one day",
    big: "care@apostlepaul.ph",
    sub: "For inquiries, paperwork, or pricing questions.",
    bigClass: "text-2xl sm:text-3xl",
  },
  {
    eyebrow: "In person — always welcome",
    big: (
      <>
        Zone 1, San Eugenio
        <br />
        Aringay, La Union 2503
      </>
    ),
    sub: "Daily 6am – 6pm. Open 24h on All Saints’ Day.",
    bigClass: "text-xl sm:text-2xl",
  },
] as const;

export default function ContactPage() {
  return (
    <>
      <PageHero
        eyebrow="Visit Us"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            The first visit is always unhurried.
          </h1>
        }
        lede="Whether the need is immediate or years away, the way we meet families is the same: an hour of your time, a slow walk, honest answers."
      />

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1fr_1.4fr] lg:px-8">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              How to reach us
            </div>
            <h2 className="mt-4 font-display text-3xl font-light leading-tight text-text-default sm:text-4xl">
              Three ways.
            </h2>
            <span aria-hidden className="mt-5 block h-px w-16 bg-accent-gold" />
            <div className="mt-8 flex flex-col gap-8">
              {CONTACT_METHODS.map((m, i) => (
                <div
                  key={i}
                  className="border-t border-surface-border pt-6"
                >
                  <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-gold">
                    {m.eyebrow}
                  </div>
                  <div
                    className={`mt-3 font-display font-light leading-tight ${m.bigClass}`}
                  >
                    {m.big}
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-text-muted">
                    {m.sub}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-12 lg:mt-0">
            <ScheduleVisitForm />
          </div>
        </div>
      </section>

      <section className="bg-surface-emphasis">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <SectionHead
            center
            eyebrow="Where we are"
            title="On the National Highway, between San Fernando and Bauang."
          />
          <div className="mt-12 overflow-hidden rounded border border-surface-border bg-surface-base">
            <LocationMap />
          </div>
        </div>
      </section>
    </>
  );
}

/**
 * Schematic "you are here" map. Not a live tile map — a stylized
 * wayfinding diagram showing the highway, the park's position
 * between San Fernando and Bauang (both La Union, on the same
 * coastal stretch), and the entrance marker.
 */
function LocationMap() {
  return (
    <svg
      viewBox="0 0 1200 480"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Location map showing Apostle Paul Memorial Park between San Fernando and Bauang on the La Union coastal highway"
      className="block h-auto w-full"
    >
      <rect width="1200" height="480" fill="#EDE7DA" />
      <path
        d="M 0 280 Q 300 250 600 280 T 1200 280"
        stroke="#B8B6AF"
        strokeWidth="14"
        fill="none"
      />
      <path
        d="M 0 280 Q 300 250 600 280 T 1200 280"
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeDasharray="10 12"
        fill="none"
      />
      <path d="M 600 280 L 620 80" stroke="#B8B6AF" strokeWidth="6" fill="none" />
      <rect
        x="540"
        y="60"
        width="180"
        height="40"
        fill="none"
        stroke="#1D5C4D"
        strokeWidth="1.5"
        strokeDasharray="4 4"
      />
      <text
        x="630"
        y="50"
        textAnchor="middle"
        fontSize="11"
        fontFamily="var(--font-jetbrains-mono)"
        letterSpacing="0.16em"
        fill="#1D5C4D"
      >
        APOSTLE PAUL MEMORIAL PARK
      </text>
      <circle cx="630" cy="80" r="8" fill="#C9A96B" />
      <circle cx="180" cy="280" r="4" fill="#8E8C85" />
      <text
        x="180"
        y="310"
        textAnchor="middle"
        fontSize="10"
        fontFamily="var(--font-jetbrains-mono)"
        letterSpacing="0.16em"
        fill="#8E8C85"
      >
        SAN FERNANDO
      </text>
      <circle cx="1020" cy="280" r="4" fill="#8E8C85" />
      <text
        x="1020"
        y="310"
        textAnchor="middle"
        fontSize="10"
        fontFamily="var(--font-jetbrains-mono)"
        letterSpacing="0.16em"
        fill="#8E8C85"
      >
        BAUANG
      </text>
      <text
        x="600"
        y="350"
        textAnchor="middle"
        fontSize="10"
        fontFamily="var(--font-jetbrains-mono)"
        letterSpacing="0.16em"
        fill="#8E8C85"
      >
        NATIONAL HIGHWAY
      </text>
    </svg>
  );
}
