import type { Metadata } from "next";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { CTAStrip } from "@/components/marketing/CTAStrip";

export const metadata: Metadata = {
  title: "Services",
  description:
    "From the day of the loss through the years that follow, our staff coordinates every detail so your family can be present for one another.",
};

const SERVICES = [
  {
    eyebrow: "I · Interment",
    title: "Burial and graveside service",
    body: "We coordinate the funeral procession from the parlor or chapel, prepare the lot, and remain with the family throughout the graveside service. Same-day arrangements available; same-week routinely accommodated.",
    bullets: [
      "Procession routing & coordination",
      "Lot preparation & opening",
      "Graveside chairs, canopy, sound",
      "Officiant available · ecumenical or Catholic",
      "Documentation & permits handled",
    ],
    icon: <IconInterment />,
  },
  {
    eyebrow: "II · Memorial",
    title: "Markers, plaques, and inscription",
    body: "Bronze and granite memorials cast and engraved by craftsmen we have worked with for two decades. We take the inscription by hand, in your presence, so there is no question of what will be carved.",
    bullets: [
      "Bronze, granite, or hand-cut stone",
      "Inscription session in person",
      "Photographic enamel insets (optional)",
      "Bilingual inscription welcomed",
      "Restoration of older markers",
    ],
    icon: <IconMemorial />,
  },
  {
    eyebrow: "III · Perpetual care",
    title: "Stewardship in perpetuity",
    body: "Perpetual care is included in every lot we sell — not a separate line, not a renewable subscription, not contingent on annual dues. The grounds are tended weekly. Markers are cleaned twice yearly. Lawn is mowed monthly. This is the promise.",
    bullets: [
      "Weekly grounds care",
      "Marker cleaning · twice yearly",
      "Floral arrangement support",
      "All Saints’ Day candles & lighting",
      "Lifetime visitation rights",
    ],
    icon: <IconPerpetual />,
  },
  {
    eyebrow: "IV · Companion services",
    title: "When you need a hand with the rest.",
    body: "We do not handle embalming, caskets, or floral arrangement ourselves — but we work with three trusted partners in San Fernando and Bauang, and a single phone call brings them in.",
    bullets: [
      "Funeral parlor referrals",
      "Bereavement counseling network",
      "Estate & inheritance paperwork",
      "Annual remembrance services",
      "Online registry & guestbook",
    ],
    icon: <IconHeart />,
  },
] as const;

export default function ServicesPage() {
  return (
    <>
      <PageHero
        eyebrow="Services"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            What we will carry for you.
          </h1>
        }
        lede="From the day of the loss through the years that follow, our staff coordinates every detail so your family can be present for one another."
      />

      {SERVICES.map((s, i) => (
        <section
          key={s.eyebrow}
          className={i % 2 ? "bg-surface-emphasis" : "bg-surface-muted"}
        >
          <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1fr_1.4fr] lg:items-start lg:px-8">
            <div>
              <div className="h-20 w-20 text-primary">{s.icon}</div>
              <div className="mt-6 font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
                {s.eyebrow}
              </div>
              <h2 className="mt-4 font-display text-3xl font-light leading-tight text-text-default sm:text-4xl">
                {s.title}
              </h2>
              <span aria-hidden className="mt-5 block h-px w-16 bg-accent-gold" />
            </div>
            <div className="mt-10 lg:mt-0">
              <p className="text-lg leading-relaxed text-text-muted">{s.body}</p>
              <ul className="mt-8 flex flex-col">
                {s.bullets.map((b, j) => (
                  <li
                    key={b}
                    className="flex items-baseline gap-4 border-t border-surface-border py-4"
                  >
                    <span className="min-w-8 font-mono text-xs uppercase tracking-[0.14em] text-accent-gold">
                      {String(j + 1).padStart(2, "0")}
                    </span>
                    <span className="text-lg leading-relaxed text-text-default">
                      {b}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ))}

      <CTAStrip
        title="Do you need us today?"
        sub="If a loss has just occurred, call our care director directly. We will sit with you from the first call onward."
        primaryLabel="Call +63 (72) 562-0187"
        primaryHref="/contact"
        secondaryLabel="Send a message"
        secondaryHref="/contact"
      />
    </>
  );
}

function IconInterment() {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      width="100%"
      height="100%"
      aria-hidden
    >
      <rect x="14" y="16" width="20" height="22" rx="10" />
      <line x1="24" y1="22" x2="24" y2="32" />
      <line x1="20" y1="26" x2="28" y2="26" />
      <line x1="6" y1="42" x2="42" y2="42" />
    </svg>
  );
}

function IconMemorial() {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path d="M12 38 L12 22 Q12 12 24 12 Q36 12 36 22 L36 38 Z" />
      <line x1="6" y1="42" x2="42" y2="42" />
      <circle cx="24" cy="24" r="3" />
    </svg>
  );
}

function IconPerpetual() {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path d="M16 30 Q16 18 24 14 Q32 18 32 30 Z" />
      <path d="M24 30 L24 42" />
      <path d="M14 36 Q24 32 34 36" />
    </svg>
  );
}

function IconHeart() {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      width="100%"
      height="100%"
      aria-hidden
    >
      <path d="M24 38 C 12 30 8 22 12 16 C 16 10 22 12 24 18 C 26 12 32 10 36 16 C 40 22 36 30 24 38 Z" />
    </svg>
  );
}
