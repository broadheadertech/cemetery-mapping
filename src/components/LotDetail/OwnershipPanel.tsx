"use client";

import Link from "next/link";

/**
 * OwnershipPanel — Story 1.11 (AC1c).
 *
 * Renders the lot's currently-active ownership block. Phase 1 has no
 * `ownerships` table yet (Story 2.3 introduces it), so the panel
 * always renders the "Available" empty state with a disabled
 * "New Sale" CTA (Epic 3 enables the action).
 *
 * Story 2.3 will plumb a `currentOwnership` payload through and this
 * component will branch: when present, render owner name + relationship
 * + ownership start date; when absent, keep the current empty state.
 */

export interface OwnershipPanelProps {
  /** The lot this panel belongs to, so a sale can start from here. */
  lotId: string;
  /**
   * Phase 1 always `null`. Story 2.3 will populate with the active
   * ownership row. The optional prop lets the panel forward-evolve
   * without a breaking signature change.
   */
  ownership?: {
    ownerName: string;
    relationship?: string;
  } | null;
}

export function OwnershipPanel({
  lotId,
  ownership = null,
}: OwnershipPanelProps) {
  return (
    <section
      aria-labelledby="ownership-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="ownership-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Ownership
      </h2>
      {ownership === null ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p
            className="text-sm text-slate-600"
            data-testid="ownership-empty"
          >
            Available. No active owner is recorded for this lot.
          </p>
          {/*
            Disabled, with a title saying sales "ship in Epic 3". They
            shipped: /sales/new records one, and it even accepts the lot
            as a parameter. The one screen where somebody notices a lot
            is unsold was the screen refusing to let them sell it.
          */}
          <Link
            href={`/sales/new?lotId=${encodeURIComponent(lotId)}`}
            data-testid="ownership-new-sale"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            New sale
          </Link>
        </div>
      ) : (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <div className="flex flex-col">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Owner
            </dt>
            <dd className="mt-1 text-sm text-slate-900">
              {ownership.ownerName}
            </dd>
          </div>
          {ownership.relationship !== undefined && (
            <div className="flex flex-col">
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Relationship
              </dt>
              <dd className="mt-1 text-sm text-slate-900">
                {ownership.relationship}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
