"use client";

/**
 * /customers/[customerId] — customer detail page (Story 2.5).
 *
 * Supersedes Story 2.1's redirect-target placeholder. Composes the
 * Story 2.5 `<CustomerDetail>` orchestrator with the page-level
 * concerns:
 *
 *   - `useQuery(customers:getCustomerDetail)` for the customer payload
 *     + live reactive updates (e.g. Story 2.1's future edit form
 *     mutating the row, Story 2.7's transfer flow updating the
 *     ownership list).
 *   - Loading / not-found / error states (UX § Skeleton Patterns +
 *     Empty State Patterns).
 *   - `document.title` set in a `useEffect` so the browser tab reflects
 *     the customer name.
 *
 * Role gating: the `(staff)/layout.tsx` route guard (Story 1.5) lets
 * any signed-in staff role through; the actual customer-detail
 * permission check is in `getCustomerDetail` on the server side, which
 * throws FORBIDDEN for field workers and customer-role callers. The
 * page surfaces that as a translated error via the catch-all error
 * boundary (or, in the immediate term, the Convex client's default
 * error toast).
 *
 * PII contract: the page receives `govIdLast4` only — never the full
 * gov-ID number. The full number is fetched by the `<RevealField>`
 * component's `revealGovId` mutation on user click, with each click
 * logged via Story 2.3's `logPiiAccess` helper. This pattern is the
 * disaster-prevention #1 contract in the Story 2.5 spec.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  CustomerDetail,
  CustomerDetailSkeleton,
  type CustomerDetailData,
} from "@/components/CustomerDetail";

// Story 2.9 (FR15) — Family estates surface on the customer detail page.
interface FamilyEstateRow {
  estateId: string;
  name: string;
  primaryOwnerCustomerId: string;
  primaryOwnerFullName: string;
  secondaryOwners: Array<{ customerId: string; fullName: string }>;
  lots: Array<{ lotId: string; code: string }>;
  notes?: string;
  createdAt: number;
  retiredAt?: number;
  retirementReason?: string;
  isActive: boolean;
}

const listEstatesForCustomerRef = makeFunctionReference<
  "query",
  { customerId: string },
  FamilyEstateRow[]
>("familyEstates:listEstatesForCustomer");

const getCustomerDetailRef = makeFunctionReference<
  "query",
  { customerId: string },
  CustomerDetailData | null
>("customers:getCustomerDetail");

/**
 * Paired audit mutation — Story 2.5 NFR-S8 fix (Epic 2 adversarial
 * review). `getCustomerDetail` is a reactive query and queries cannot
 * write the `auditLog` row PII reads require. We fire this mutation
 * once on mount (per resolved customer) so the access trail captures
 * "Office Staff opened customer X's detail page" without breaking the
 * reactive subscription pattern.
 */
const recordCustomerDetailViewRef = makeFunctionReference<
  "mutation",
  { customerId: string },
  { recorded: true }
>("customers:recordCustomerDetailView");

export default function CustomerDetailPage() {
  const params = useParams<{ customerId: string }>();
  const customerId = params.customerId;

  const detail = useQuery(getCustomerDetailRef, { customerId });
  const recordView = useMutation(recordCustomerDetailViewRef);
  // Guard so React Strict Mode's double-invoke of effects doesn't double-
  // log on first mount. Each NEW customer id still gets its own audit
  // row (the ref resets on customerId change via the dependency array).
  const recordedRef = useRef<string | null>(null);

  // Set the browser tab title once the customer resolves. Strict-Mode
  // double-effect is harmless because we just write to document.title.
  useEffect(() => {
    if (detail !== undefined && detail !== null) {
      document.title = `${detail.fullName} · Broadheader`;
    } else if (detail === null) {
      document.title = "Customer not found · Broadheader";
    }
  }, [detail]);

  // Fire the paired audit mutation on first successful resolve of a
  // customer record. NFR-S8: every detail-page open is a logged PII
  // access event. We swallow errors — failing to log is strictly less
  // bad than blocking the page render (the layout-level role gate has
  // already established the caller is admin / office_staff).
  useEffect(() => {
    if (detail === undefined || detail === null) return;
    if (recordedRef.current === detail.customerId) return;
    recordedRef.current = detail.customerId;
    void recordView({ customerId: detail.customerId }).catch(() => {
      // Intentionally swallowed — see note above.
    });
  }, [detail, recordView]);

  // Loading state — Convex returns `undefined` while the subscription
  // resolves OR the user lacks role and the server threw before the
  // first value arrived. We render the skeleton for the loading case;
  // the role-error case eventually surfaces as a `null` detail (the
  // query rejected) or an error toast via the Convex client default.
  if (detail === undefined) {
    return <CustomerDetailSkeleton />;
  }

  // Not-found state — Convex returns `null` here only if the server
  // query path returns null explicitly. Our `getCustomerDetail` THROWS
  // `NOT_FOUND` instead, which surfaces as a thrown error in the
  // useQuery. The error boundary handles that; this branch handles the
  // belt-and-suspenders case where the server returns null directly.
  if (detail === null) {
    return (
      <div className="space-y-4" data-testid="customer-detail-not-found">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-slate-900">
          Customer not found
        </h1>
        <div
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          We couldn&apos;t find that customer. The record may have been
          deleted or the link is incorrect.
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center text-sm font-medium text-slate-900 underline"
        >
          ← Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <>
      <CustomerDetail detail={detail} />
      <FamilyEstatesSection customerId={detail.customerId} />
    </>
  );
}

/**
 * Story 2.9 (FR15) — Family estates section appended below the
 * customer detail. Reactive `listEstatesForCustomer` shows every active
 * estate the customer is primary or secondary owner of. Each row links
 * to the estate detail page; the surface stays invisible when the
 * customer has no estate involvement.
 */
function FamilyEstatesSection({
  customerId,
}: {
  customerId: string;
}): React.ReactElement | null {
  const estates = useQuery(listEstatesForCustomerRef, { customerId });

  if (estates === undefined) {
    return (
      <section
        className="mt-6 rounded-md border border-slate-200 bg-white px-4 py-3"
        data-testid="customer-family-estates-loading"
      >
        <h2 className="text-sm font-semibold text-slate-800">
          Family estates
        </h2>
        <p className="text-xs text-slate-500">Loading…</p>
      </section>
    );
  }
  if (estates.length === 0) {
    return null;
  }
  return (
    <section
      className="mt-6 space-y-3 rounded-md border border-slate-200 bg-white px-4 py-3"
      data-testid="customer-family-estates"
    >
      <h2 className="text-sm font-semibold text-slate-800">Family estates</h2>
      <ul className="divide-y divide-slate-100">
        {estates.map((estate) => {
          const isPrimary =
            estate.primaryOwnerCustomerId === customerId;
          return (
            <li
              key={estate.estateId}
              className="flex items-center justify-between py-2"
              data-testid={`customer-family-estate-${estate.estateId}`}
            >
              <div>
                <Link
                  href={`/family-estates/${estate.estateId}`}
                  className="text-sm font-medium text-slate-900 underline"
                >
                  {estate.name}
                </Link>
                <p className="text-xs text-slate-500">
                  {estate.lots.length} lots ·{" "}
                  {isPrimary ? "Primary owner" : "Secondary owner"}
                </p>
              </div>
              <span className="text-xs text-slate-500">
                {estate.lots.map((l) => l.code).join(", ")}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

