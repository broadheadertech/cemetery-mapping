import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * Apostle Paul Memorial Park — public marketing surface.
 *
 * The (marketing) route group is the only branch of the app the public
 * sees without signing in. Every other route group ((staff), (customer),
 * (public)/login) sits behind the auth gate; this one is brochureware.
 *
 * Notes for future work:
 *   - The root layout sets `robots: { index: false, follow: false }`
 *     for the entire authenticated app. We override here so the
 *     marketing pages are indexable.
 *   - The Nav `Owner Portal` CTA routes to the existing customer
 *     portal sign-in (/portal/login); the smaller `Sign in` link in
 *     the footer routes to the staff /login. We never expose a
 *     direct path to the staff dashboard from the brochure.
 *   - The page background uses the same Ivory token as the rest of
 *     the brand — globals.css `--page-bg`. No surface overrides here.
 */
export const metadata: Metadata = {
  title: {
    default: "Apostle Paul Memorial Park",
    template: "%s · Apostle Paul Memorial Park",
  },
  description:
    "A consecrated resting place in Aringay, La Union — stewarded with care since 1987. Interment services, family estates, perpetual care, and pre-need planning.",
  robots: {
    index: true,
    follow: true,
  },
};

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-muted text-text-default">
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
