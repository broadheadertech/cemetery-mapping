import Link from "next/link";
import { BrandMark } from "./BrandMark";

/**
 * Apostle Paul Memorial Park — public-site footer.
 *
 * The footer uses Emerald-deep ground with Ivory type, which is the
 * single dark surface in the brochure — used here so it reads as
 * "this is the institution speaking."
 *
 * The address is the canonical Aringay / La Union one (CLAUDE.md +
 * brand-guide stale-Bulacan fix). Do not paraphrase or compress it —
 * the postal code is part of the legal entity record.
 *
 * Footer signposts a `Sign in` link to staff /login. Customer portal
 * sign-in is in the nav (Owner Portal) so customers don't have to
 * scroll to find it.
 */
export function MarketingFooter() {
  return (
    <footer className="bg-primary-hover text-primary-fg">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <BrandMark size={56} />
              <div>
                <div className="font-display text-2xl tracking-ceremonial text-primary-fg">
                  Apostle Paul
                </div>
                <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-gold">
                  Memorial Park
                </div>
              </div>
            </div>
            <p className="max-w-xs text-sm leading-relaxed text-primary-fg/70">
              A consecrated resting place stewarded with care since 1987 —
              where families gather to honor, to remember, and to find peace.
            </p>
          </div>

          <FooterColumn title="Visit">
            <address className="not-italic">
              <FooterLine>Zone 1, San Eugenio</FooterLine>
              <FooterLine>Aringay, La Union 2503</FooterLine>
              <FooterLine>Philippines</FooterLine>
            </address>
            <div className="pt-4">
              <FooterColumnTitle>Hours</FooterColumnTitle>
              <FooterLine>Daily 6:00 – 18:00</FooterLine>
              <FooterLine>All Saints&apos; Day open 24h</FooterLine>
            </div>
          </FooterColumn>

          <FooterColumn title="Inquire">
            <FooterNavLink href="/contact">Schedule a visit</FooterNavLink>
            <FooterNavLink href="/pricing">Pricing inquiry</FooterNavLink>
            <FooterNavLink href="/plan-ahead">Plan ahead</FooterNavLink>
            <FooterNavLink href="/services">Interment services</FooterNavLink>
            <FooterLine>+63 (72) 562-0187</FooterLine>
            <FooterLine>care@apostlepaul.ph</FooterLine>
          </FooterColumn>

          <FooterColumn title="Owners">
            <FooterNavLink href="/portal/login">Portal sign in</FooterNavLink>
            <FooterNavLink href="/portal/login">Pay an installment</FooterNavLink>
            <FooterNavLink href="/portal/login">View contract</FooterNavLink>
            <FooterNavLink href="/find-a-grave">Locate a lot</FooterNavLink>
            <div className="pt-4">
              <FooterColumnTitle>Records</FooterColumnTitle>
              <FooterNavLink href="/news">Recent interments</FooterNavLink>
              <FooterNavLink href="/find-a-grave">Find a grave</FooterNavLink>
            </div>
          </FooterColumn>
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-primary-fg/15 pt-6 text-xs text-primary-fg/55 sm:flex-row sm:items-center">
          <span>© 1987–{new Date().getFullYear()} Apostle Paul Memorial Park · Cases Land Inc.</span>
          <span className="flex items-center gap-3">
            <span>Stewarded with care · BIR-registered · DPA-compliant</span>
            <span aria-hidden className="text-accent-gold">·</span>
            <Link
              href="/login"
              className="text-primary-fg/70 underline-offset-2 hover:text-accent-gold-soft hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold focus-visible:ring-offset-2 focus-visible:ring-offset-primary-hover"
            >
              Staff sign in
            </Link>
          </span>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <FooterColumnTitle>{title}</FooterColumnTitle>
      <div className="mt-4 space-y-2">{children}</div>
    </div>
  );
}

function FooterColumnTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent-gold">
      {children}
    </div>
  );
}

function FooterLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm leading-relaxed text-primary-fg/80">{children}</div>
  );
}

function FooterNavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Link
        href={href}
        className="text-sm leading-relaxed text-primary-fg/80 transition-colors hover:text-accent-gold-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-gold focus-visible:ring-offset-2 focus-visible:ring-offset-primary-hover"
      >
        {children}
      </Link>
    </div>
  );
}
