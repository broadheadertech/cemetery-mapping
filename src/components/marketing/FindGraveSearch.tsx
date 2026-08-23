"use client";

/**
 * "Help me find someone" — the public grave-lookup entry point.
 *
 * ## Why this is not a search box
 *
 * It used to be one: a name field, a year field, and a Find button
 * that pushed `?name=…&year=…` to `/find-a-grave`. That page never
 * read the query string, so the search silently did nothing and the
 * visitor was handed an unfiltered map. Someone trying to locate a
 * relative's grave before driving out to Aringay would have concluded
 * the record was not there.
 *
 * Building the real thing is blocked on a decision the cemetery has to
 * make, not on engineering: whether the names of everyone interred
 * here should be publicly searchable by anyone, with no login. That is
 * a Data Privacy Act question about the deceased and their families,
 * and Story 2.3 already treats occupant reads as logged PII access
 * inside the staff app. Shipping a public index of the dead because it
 * was technically easy would be the wrong way to answer it.
 *
 * So until that decision lands, this offers the path that actually
 * works today: the office looks it up for you. The map beside it still
 * browses live availability, which is the other half of what the page
 * was for.
 *
 * ## To turn this back into a search box
 *
 * 1. Get the cemetery's answer on public occupant search.
 * 2. Add a public Convex query returning ONLY deceased name, section
 *    and lot code, and year — never owner, contact, or contract data.
 * 3. Have `/find-a-grave` read `useSearchParams` and filter on it.
 * 4. Restore the two inputs here.
 *
 * The git history of this file has the original markup.
 */

import Link from "next/link";
import { Phone, Mail } from "lucide-react";

import {
  CEMETERY_EMAIL,
  CEMETERY_EMAIL_HREF,
  CEMETERY_OFFICE_HOURS,
  CEMETERY_PHONE_DISPLAY,
  CEMETERY_PHONE_HREF,
} from "./contact-details";

export function FindGraveSearch({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <div
      data-testid="find-grave-help"
      className={
        compact
          ? "flex flex-col gap-3"
          : "rounded border border-surface-border bg-surface-base p-5"
      }
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
        Looking for someone
      </div>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">
        Our office keeps the interment register. Tell us the name and roughly
        when they were laid to rest, and we will locate the plot for you before
        you make the trip.
      </p>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-5">
        <a
          href={CEMETERY_PHONE_HREF}
          className="inline-flex items-center gap-2 font-display text-lg font-light text-text-default underline decoration-accent-gold underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Phone size={16} aria-hidden />
          {CEMETERY_PHONE_DISPLAY}
        </a>
        <a
          href={CEMETERY_EMAIL_HREF}
          className="inline-flex items-center gap-2 text-sm text-text-muted underline decoration-surface-border underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Mail size={15} aria-hidden />
          {CEMETERY_EMAIL}
        </a>
      </div>

      <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
        {CEMETERY_OFFICE_HOURS}
      </p>

      {!compact && (
        <p className="mt-4 border-t border-surface-border pt-4 text-sm leading-relaxed text-text-muted">
          You can also{" "}
          <Link
            href="/find-a-grave"
            className="underline decoration-accent-gold underline-offset-4 hover:text-primary"
          >
            browse the grounds map
          </Link>{" "}
          to see the gardens and which lots are available.
        </p>
      )}
    </div>
  );
}
