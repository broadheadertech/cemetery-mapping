"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";

/**
 * Find-a-grave lookup — name + optional year, redirects to the public
 * Find-a-Grave page with the search prefilled in the URL. The real
 * lookup happens server-side on that page (currently mocked; will
 * resolve against the Convex `occupants` / `interments` indexes once
 * the public-search query lands).
 */
export function FindGraveSearch({
  compact = false,
}: {
  compact?: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [year, setYear] = useState("");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams();
    if (name.trim()) params.set("name", name.trim());
    if (year.trim()) params.set("year", year.trim());
    const qs = params.toString();
    router.push(qs ? `/find-a-grave?${qs}` : "/find-a-grave");
  }

  return (
    <form
      onSubmit={onSubmit}
      className={
        compact
          ? "flex flex-col gap-3 sm:flex-row sm:items-end"
          : "grid grid-cols-1 gap-4 rounded border border-surface-border bg-surface-base p-5 sm:grid-cols-[2fr_1fr_auto] sm:items-end"
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          Full name
        </span>
        <input
          type="text"
          name="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Maria S. Reyes"
          autoComplete="off"
          className="rounded border border-surface-border bg-surface-base px-3 py-2.5 font-sans text-base text-text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          Year of passing (optional)
        </span>
        <input
          type="text"
          name="year"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          value={year}
          onChange={(e) => setYear(e.target.value)}
          placeholder="e.g. 2018"
          autoComplete="off"
          className="rounded border border-surface-border bg-surface-base px-3 py-2.5 font-sans text-base text-text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
        />
      </label>
      <button
        type="submit"
        className="inline-flex items-center justify-center gap-2 rounded border border-primary bg-primary px-5 py-2.5 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
      >
        <Search size={16} aria-hidden />
        Find
      </button>
    </form>
  );
}
