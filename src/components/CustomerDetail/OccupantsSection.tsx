"use client";

/**
 * Story 6.8 — occupants card on the customer detail page (AC4).
 *
 * Surfaces the deceased occupants across the customer's currently-owned
 * lots. Each occupant with a populated `diedYear` gets a small "Plaque"
 * action link that navigates to the latest interment's plaque page
 * (`/interments/[intermentId]/plaque`). Occupants without an interment
 * row render the Plaque link in a disabled state with a tooltip
 * pointing to Story 7.1's scheduling page.
 *
 * Note on the Story 2.6 contract: Story 2.6 introduced the `occupants`
 * table with a `dateOfInterment` field but did NOT ship a customer-
 * facing occupants card in the current `CustomerDetail` orchestrator —
 * the existing surface jumps straight from ownership history to
 * documents / contracts. Story 6.8 introduces the card lazily here so
 * the Plaque action has a natural home; future Story 2.6 follow-ups
 * may relocate the card or enrich it with relationship metadata.
 */

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

export interface CustomerOccupantRowShape {
  occupantId: string;
  lotId: string;
  lotCode: string;
  name: string;
  diedYear: number | undefined;
  bornYear: number | undefined;
  latestIntermentId: string | null;
  latestIntermentStatus: "scheduled" | "completed" | "cancelled" | null;
}

const listOccupantsForCustomerRef = makeFunctionReference<
  "query",
  { customerId: string },
  CustomerOccupantRowShape[]
>("interments:listOccupantsForCustomer");

export interface OccupantsSectionProps {
  customerId: string;
}

export function OccupantsSection({ customerId }: OccupantsSectionProps) {
  const occupants = useQuery(listOccupantsForCustomerRef, { customerId });

  return (
    <section
      aria-labelledby="occupants-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
      data-testid="customer-occupants-section"
    >
      <h2
        id="occupants-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Occupants
      </h2>
      {occupants === undefined ? (
        <ul
          className="space-y-2"
          aria-busy="true"
          aria-live="polite"
          data-testid="customer-occupants-skeleton"
        >
          {[0, 1].map((i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
              <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
            </li>
          ))}
        </ul>
      ) : occupants.length === 0 ? (
        <p
          className="text-sm text-slate-600"
          data-testid="customer-occupants-empty"
        >
          No occupants recorded for this customer&apos;s lots.
        </p>
      ) : (
        <ul
          className="divide-y divide-slate-100"
          data-testid="customer-occupants-list"
        >
          {occupants.map((occupant) => (
            <li
              key={occupant.occupantId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
              data-testid={`customer-occupant-row-${occupant.occupantId}`}
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium text-slate-900">
                  {occupant.name}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  Lot {occupant.lotCode}
                  {occupant.diedYear !== undefined && (
                    <> · died {occupant.diedYear}</>
                  )}
                </span>
              </div>
              <PlaqueLink occupant={occupant} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PlaqueLink({ occupant }: { occupant: CustomerOccupantRowShape }) {
  // Cannot generate a plaque without a death year or an interment to
  // anchor the plaque page to. The interment id is the route param;
  // the year is the prefill default.
  if (occupant.diedYear === undefined) {
    return (
      <span
        className="inline-flex items-center text-xs text-slate-400"
        title="Plaque requires a recorded death year."
        data-testid={`customer-occupant-plaque-disabled-${occupant.occupantId}`}
      >
        Plaque unavailable
      </span>
    );
  }
  if (occupant.latestIntermentId === null) {
    return (
      <span
        className="inline-flex items-center text-xs text-slate-400"
        title="Schedule an interment first."
        data-testid={`customer-occupant-plaque-disabled-${occupant.occupantId}`}
      >
        Plaque unavailable
      </span>
    );
  }
  return (
    <Link
      href={`/interments/${occupant.latestIntermentId}/plaque`}
      className="inline-flex min-h-[44px] items-center rounded-md border border-emerald-800 px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-50"
      data-testid={`customer-occupant-plaque-link-${occupant.occupantId}`}
    >
      Plaque
    </Link>
  );
}
