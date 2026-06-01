import type { Metadata } from "next";
import { PageHero, PAGE_HERO_TITLE_CLASS } from "@/components/marketing/PageHero";
import { NewsPageClient } from "@/components/marketing/NewsPageClient";

export const metadata: Metadata = {
  title: "News & Announcements",
  description:
    "Recent interments, announcements, and the small news of life at the park.",
};

export default function NewsPage() {
  return (
    <>
      <PageHero
        eyebrow="News & Announcements"
        title={
          <h1 className={PAGE_HERO_TITLE_CLASS}>
            In memoriam, and otherwise.
          </h1>
        }
        lede="Recent interments, announcements, and the small news of life at the park."
      />
      <NewsPageClient />
    </>
  );
}
