import type { Metadata } from "next";
import { FindGraveSearch } from "@/components/marketing/FindGraveSearch";
import { FindAGravePageClient } from "@/components/marketing/FindAGravePageClient";

export const metadata: Metadata = {
  title: "Find a Grave",
  description:
    "Six gardens, 2,134 lots. Tap any plot for live availability, or search the registry by occupant name.",
};

export default function FindAGravePage() {
  return (
    <>
      <section className="border-b border-surface-border bg-surface-muted">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
              Interactive Map
            </div>
            <h1 className="mt-4 font-display text-4xl font-light leading-tight tracking-tight text-text-default sm:text-5xl lg:text-6xl">
              Locate a lot.
            </h1>
            <span aria-hidden className="mt-6 block h-px w-16 bg-accent-gold" />
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-text-muted">
              Six gardens, 2,134 lots. Tap any plot for live availability, or
              search by occupant name below.
            </p>
          </div>
          <div className="w-full max-w-md">
            <FindGraveSearch />
          </div>
        </div>
      </section>

      <FindAGravePageClient />
    </>
  );
}
