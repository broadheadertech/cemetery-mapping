import { BrandMark } from "./BrandMark";

/**
 * Inner-page hero band — eyebrow + page-supplied h1 + gold hairline +
 * optional lede, with the brand mark floated to the right on large
 * widths.
 *
 * The page itself is required to pass its own `<h1>` token as
 * `title` — that satisfies the `local-rules/single-h1-per-page` lint
 * rule (which scans page files for the literal `<h1>` element) AND
 * keeps the page-canonical heading visible in the page source.
 *
 * Use `PAGE_HERO_TITLE_CLASS` to keep the title typography consistent
 * across brochure pages.
 */
export const PAGE_HERO_TITLE_CLASS =
  "font-display text-4xl font-light leading-tight tracking-tight text-text-default sm:text-5xl lg:text-6xl";

export function PageHero({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
}) {
  return (
    <section className="border-b border-surface-border bg-surface-muted">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div className="max-w-3xl">
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
            {eyebrow}
          </div>
          <div className="mt-4">{title}</div>
          <span aria-hidden className="mt-6 block h-px w-16 bg-accent-gold" />
          {lede ? (
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-text-muted">
              {lede}
            </p>
          ) : null}
        </div>
        <div className="hidden lg:block">
          <BrandMark size={120} />
        </div>
      </div>
    </section>
  );
}
