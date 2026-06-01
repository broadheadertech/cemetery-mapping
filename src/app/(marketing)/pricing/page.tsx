import type { Metadata } from "next";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { CTAStrip } from "@/components/marketing/CTAStrip";
import { PricingPageClient } from "@/components/marketing/PricingPageClient";

export const metadata: Metadata = {
  title: "Lot Types & Pricing",
  description:
    "Single plots, family estates, mausoleums, and columbarium niches. Every lot includes perpetual care and is written into the contract in plain Tagalog and English.",
};

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Lot Types & Pricing"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            A place that fits your family — and your circumstances.
          </h1>
        }
        lede="Every lot includes perpetual care. Every contract is written in plain Tagalog and English. We will walk you through it line by line before you sign anything."
      />

      <PricingPageClient />

      <CTAStrip
        title="Want to see them in person?"
        sub="No catalogues, no salespeople — just a walking tour with someone who knows every grave."
        primaryLabel="Schedule a visit"
        primaryHref="/contact"
      />
    </>
  );
}
