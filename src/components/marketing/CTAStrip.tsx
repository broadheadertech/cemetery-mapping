import Link from "next/link";

/**
 * Emerald-on-emerald CTA band used near the foot of most brochure
 * pages. Primary CTA is a gold-rationed inverted button; secondary
 * is an ivory ghost button. Gold here is the masthead-divider rule
 * and the primary button only — never as a surface fill.
 */
export function CTAStrip({
  eyebrow = "Next steps",
  title,
  sub,
  primaryLabel,
  primaryHref,
  secondaryLabel,
  secondaryHref,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  sub?: React.ReactNode;
  primaryLabel: string;
  primaryHref: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}) {
  return (
    <section className="bg-primary text-primary-fg">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[1.5fr_1fr] lg:px-8">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-accent-gold-soft">
            {eyebrow}
          </div>
          <h2 className="mt-4 font-display text-3xl font-light leading-tight tracking-tight sm:text-4xl">
            {title}
          </h2>
          <span aria-hidden className="mt-5 block h-px w-16 bg-accent-gold" />
          {sub ? (
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-primary-fg/85 sm:text-lg">
              {sub}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 lg:items-end">
          <Link
            href={primaryHref}
            className="inline-flex items-center justify-center rounded border border-accent-gold bg-accent-gold px-6 py-3 text-center text-sm font-medium text-text-default transition-colors hover:bg-accent-gold-soft hover:border-accent-gold-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
          >
            {primaryLabel}
          </Link>
          {secondaryLabel && secondaryHref ? (
            <Link
              href={secondaryHref}
              className="inline-flex items-center justify-center rounded border border-primary-fg px-6 py-3 text-center text-sm font-medium text-primary-fg transition-colors hover:bg-primary-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold focus-visible:ring-offset-2 focus-visible:ring-offset-primary"
            >
              {secondaryLabel}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
