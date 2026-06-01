"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FindGraveSearch } from "./FindGraveSearch";
import { SectionHead } from "./SectionHead";
import { ObituaryList } from "./ObituaryList";
import { OBITUARIES, ANNOUNCEMENTS } from "./data";
import { cn } from "@/lib/cn";

type Tab = "memoriam" | "news";

/**
 * News page tab switcher — In Memoriam (obituaries list + registry
 * search) and Announcements (chronological park news). The search bar
 * is contextual — only shown on the memoriam tab where it's relevant.
 */
export function NewsPageClient() {
  const [tab, setTab] = useState<Tab>("memoriam");

  return (
    <>
      <section className="border-b border-surface-border bg-surface-base">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-6 sm:px-6 lg:px-8">
          <div
            role="tablist"
            aria-label="News categories"
            className="flex flex-wrap gap-2"
          >
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`news-panel-${t.id}`}
                  id={`news-tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "rounded-full border px-5 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    active
                      ? "border-primary bg-primary text-primary-fg"
                      : "border-surface-border text-text-default hover:border-primary hover:text-primary",
                  )}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          {tab === "memoriam" ? (
            <div className="w-full max-w-md">
              <FindGraveSearch compact />
            </div>
          ) : null}
        </div>
      </section>

      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          {tab === "memoriam" ? (
            <div
              role="tabpanel"
              id="news-panel-memoriam"
              aria-labelledby="news-tab-memoriam"
              className="mx-auto max-w-3xl"
            >
              <SectionHead
                eyebrow="Recently laid to rest"
                title="Names we hold."
              />
              <div className="mt-10">
                <ObituaryList items={OBITUARIES} />
              </div>
              <div className="mt-12 text-center">
                <Link
                  href="/find-a-grave"
                  className="inline-flex items-center gap-2 rounded border border-primary px-5 py-3 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-muted"
                >
                  Search the registry
                  <ArrowRight size={16} aria-hidden />
                </Link>
              </div>
            </div>
          ) : (
            <div
              role="tabpanel"
              id="news-panel-news"
              aria-labelledby="news-tab-news"
              className="mx-auto max-w-3xl"
            >
              <SectionHead eyebrow="From the park" title="Announcements." />
              <div className="mt-10">
                {ANNOUNCEMENTS.map((a) => (
                  <article
                    key={a.title}
                    className="border-t border-surface-border py-8 first:border-t-0 first:pt-0"
                  >
                    <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
                      {a.date}
                    </div>
                    <h3 className="mt-3 font-display text-2xl font-light leading-tight text-text-default sm:text-3xl">
                      {a.title}
                    </h3>
                    <p className="mt-4 max-w-2xl text-lg leading-relaxed text-text-default">
                      {a.body}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "memoriam", label: "In memoriam" },
  { id: "news", label: "Announcements" },
];
