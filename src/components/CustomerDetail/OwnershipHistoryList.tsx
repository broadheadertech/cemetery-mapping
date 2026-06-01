"use client";

/**
 * OwnershipHistoryList — Story 2.5 AC3.
 *
 * Renders the customer's lot-ownership history. Each row shows the lot
 * code (linked to the lot detail page), a transfer-type badge, and the
 * effective date range. Sorted most-recent first by the server query
 * (`api.ownerships.listByCustomer`).
 *
 * Loading state: 3 skeleton rows matching the final layout.
 * Empty state: "No lot ownership recorded for this customer." per UX §
 * Empty State Patterns.
 *
 * Retired-lot handling: when the underlying lot has been retired or
 * deleted, the query returns `lotCode: "[retired]"` — see the
 * soft-foreign-key note in `convex/ownerships.ts`. We still render the
 * row (the customer's history matters) but without a clickable link.
 */

import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatDate } from "@/lib/time";

import type { OwnershipHistoryRowData } from "./types";

const listByCustomerRef = makeFunctionReference<
  "query",
  { customerId: string },
  OwnershipHistoryRowData[]
>("ownerships:listByCustomer");

export interface OwnershipHistoryListProps {
  customerId: string;
}

/**
 * Visual badge styles per transfer type. Static map so the Tailwind
 * JIT compiler can see each utility chunk at build time (a ternary
 * chain would defeat tree-shaking).
 */
const TRANSFER_TYPE_BADGE: Record<
  OwnershipHistoryRowData["transferType"],
  { label: string; className: string }
> = {
  sale: {
    label: "Sale",
    className: "bg-slate-100 text-slate-800 border-slate-300",
  },
  inheritance: {
    label: "Inheritance",
    className: "bg-blue-50 text-blue-900 border-blue-200",
  },
  gift: {
    label: "Gift",
    className: "bg-emerald-50 text-emerald-900 border-emerald-200",
  },
  court_order: {
    label: "Court order",
    className: "bg-amber-50 text-amber-900 border-amber-200",
  },
  initial: {
    label: "Initial",
    className: "bg-slate-50 text-slate-700 border-slate-200",
  },
};

export function OwnershipHistoryList({
  customerId,
}: OwnershipHistoryListProps) {
  const ownerships = useQuery(listByCustomerRef, { customerId });

  return (
    <section
      aria-labelledby="ownership-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="ownership-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Ownership history
      </h2>
      {ownerships === undefined ? (
        <SkeletonRows />
      ) : ownerships.length === 0 ? (
        <p
          className="text-sm text-slate-600"
          data-testid="ownership-history-empty"
        >
          No lot ownership recorded for this customer.
        </p>
      ) : (
        <ul
          className="divide-y divide-slate-100"
          data-testid="ownership-history-list"
        >
          {ownerships.map((row) => (
            <li
              key={row.ownershipId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3"
              data-testid="ownership-history-row"
            >
              <div className="flex items-center gap-3">
                {row.lotCode === "[retired]" ? (
                  <span className="text-sm font-medium text-slate-500">
                    [retired]
                  </span>
                ) : (
                  <Link
                    href={`/lots/${row.lotId}`}
                    className="text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                  >
                    Lot {row.lotCode}
                  </Link>
                )}
                <Badge transferType={row.transferType} />
              </div>
              <div className="text-xs text-slate-600">
                {formatDate(row.effectiveFrom, "short")} —{" "}
                {row.effectiveTo === undefined
                  ? "Present"
                  : formatDate(row.effectiveTo, "short")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Badge({
  transferType,
}: {
  transferType: OwnershipHistoryRowData["transferType"];
}) {
  const badge = TRANSFER_TYPE_BADGE[transferType];
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul
      className="space-y-2"
      aria-busy="true"
      aria-live="polite"
      data-testid="ownership-history-skeleton"
    >
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center justify-between gap-3 py-2">
          <div className="h-4 w-32 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-24 animate-pulse rounded bg-slate-200" />
        </li>
      ))}
    </ul>
  );
}
