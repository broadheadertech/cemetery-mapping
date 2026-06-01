"use client";

/**
 * CustomerDetail — Story 2.5 orchestrator.
 *
 * Composes the customer detail page sections per AC1:
 *   1. Header (full name + StatusPill).
 *   2. Contact block (phone, email, address as <dl>).
 *   3. Gov-ID block (RevealField — click to reveal, 30 s auto-hide).
 *   4. Ownership history (OwnershipHistoryList).
 *   5. ID-scan attachments grid (DocumentsPlaceholder — Story 2.2 owns).
 *   6. Contracts list (ContractsPlaceholder — Story 3.4 owns).
 *   7. Audit trail link (deep links to Story 6.5 audit page).
 *
 * Pure presentational at this level: the parent (`page.tsx`) owns the
 * `useQuery` for `getCustomerDetail` and resolves loading / null /
 * error states before this component renders. Same pattern as
 * LotDetail (Story 1.11) — keeps the orchestrator easy to unit-test
 * with a fixture.
 *
 * Responsive: at `< 1024px` the sections stack single-column; at
 * `≥ 1024px` they flow into a two-column grid (primary info on the
 * left, ownership / attachments / contracts on the right) per UX
 * §1901.
 */

import Link from "next/link";

import { ReactiveHighlight } from "@/components/ui/ReactiveHighlight";
import { formatDate } from "@/lib/time";

import type { CustomerDetailData } from "./types";
import { ContactBlock } from "./ContactBlock";
import { ContractsPlaceholder } from "./ContractsPlaceholder";
import { DocumentsPlaceholder } from "./DocumentsPlaceholder";
import { OccupantsSection } from "./OccupantsSection";
import { OwnershipHistoryList } from "./OwnershipHistoryList";
import { PortalInviteButton } from "./PortalInviteButton";
import { RevealField } from "./RevealField";

export interface CustomerDetailProps {
  detail: CustomerDetailData;
}

export function CustomerDetail({ detail }: CustomerDetailProps) {
  return (
    <div
      className="space-y-6"
      data-testid="customer-detail"
    >
      {/*
        AC1a — header with full name. The watch is on `updatedAt` so a
        peer edit (Story 2.1's future edit form) reactively flashes the
        header for 600ms via the standard ReactiveHighlight crossfade.
      */}
      <ReactiveHighlight watch={detail.updatedAt} className="block w-full">
        <header
          aria-labelledby="customer-name-heading"
          className="flex flex-wrap items-center justify-between gap-4"
        >
          <div className="flex items-center gap-3">
            <h1
              id="customer-name-heading"
              className="text-3xl font-bold tracking-tight text-slate-900"
              data-testid="customer-name"
            >
              {detail.fullName}
            </h1>
            <span
              role="status"
              aria-label="Customer status: active"
              className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-900"
            >
              Active
            </span>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <p className="text-xs text-slate-500">
              Customer since {formatDate(detail.createdAt, "short")}
            </p>
            <PortalInviteButton customerId={detail.customerId} />
          </div>
        </header>
      </ReactiveHighlight>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <ContactBlock
            phone={detail.phone}
            email={detail.email}
            address={detail.address}
            relationshipToOccupant={detail.relationshipToOccupant}
          />
          <section
            aria-labelledby="govid-heading"
            className="rounded-md border border-slate-200 bg-white p-6"
          >
            <h2
              id="govid-heading"
              className="mb-4 text-base font-semibold text-slate-900"
            >
              Government ID
            </h2>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              <div className="flex flex-col">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  ID Type
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {formatGovIdType(detail.govIdType)}
                </dd>
              </div>
              <div className="flex flex-col">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  ID Number
                </dt>
                <dd className="mt-1">
                  <RevealField
                    customerId={detail.customerId}
                    govIdLast4={detail.govIdLast4}
                  />
                </dd>
              </div>
            </dl>
          </section>
        </div>
        <div className="space-y-6">
          <OwnershipHistoryList customerId={detail.customerId} />
          <OccupantsSection customerId={detail.customerId} />
          <DocumentsPlaceholder customerId={detail.customerId} />
          <ContractsPlaceholder customerId={detail.customerId} />
        </div>
      </div>

      <section
        aria-labelledby="audit-link-heading"
        className="rounded-md border border-slate-200 bg-slate-50 p-4"
      >
        <h2 id="audit-link-heading" className="sr-only">
          Activity
        </h2>
        <Link
          href={`/audit?entityType=customer&entityId=${detail.customerId}`}
          data-testid="customer-audit-link"
          className="inline-flex items-center text-sm font-medium text-slate-900 underline"
        >
          View activity for this customer →
        </Link>
      </section>
    </div>
  );
}

/**
 * Maps the gov-ID type literal union into a human-readable label.
 */
function formatGovIdType(type: CustomerDetailData["govIdType"]): string {
  switch (type) {
    case "sss":
      return "SSS";
    case "tin":
      return "TIN";
    case "umid":
      return "UMID";
    case "drivers_license":
      return "Driver's License";
    case "passport":
      return "Passport";
    case "philhealth":
      return "PhilHealth";
    case "voters_id":
      return "Voter's ID";
    case "other":
      return "Other";
    default:
      return "Unknown";
  }
}
