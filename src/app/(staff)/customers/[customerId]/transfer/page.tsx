"use client";

/**
 * /customers/[customerId]/transfer — Story 2.7 (FR17).
 *
 * Office staff records an ownership transfer FROM the customer named
 * in the URL TO a destination customer they pick on the form. The
 * page composes:
 *
 *   1. `customers:getCustomerDetail` — to render the from-customer's
 *      name in the heading + summary slide.
 *   2. `ownerships:listByCustomer` — to enumerate the lots this
 *      customer currently owns (i.e. ownership rows with
 *      `effectiveTo === undefined`). The form's lot picker is sourced
 *      from this list.
 *   3. `<OwnershipTransferForm />` — the multi-step form that owns
 *      the `recordOwnershipTransfer` mutation call.
 *
 * Role gating: the `(staff)/layout.tsx` server guard lets any signed-
 * in staff role through; the mutation itself gates on `office_staff`
 * / `admin`. A field worker who navigates here will see the form
 * render but receive a FORBIDDEN translation when they submit.
 *
 * After a successful transfer the page navigates back to the
 * customer detail page — the ownership-history list there will
 * reactively reflect the close+open atomically via Convex's live
 * subscription.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import {
  OwnershipTransferForm,
  type CurrentOwnerLot,
} from "@/components/OwnershipTransferForm";
import type { CustomerDetailData } from "@/components/CustomerDetail";

/** Wire shape of `ownerships:listByCustomer` rows. Mirror of `OwnershipHistoryRow`. */
type OwnershipHistoryRow = {
  ownershipId: string;
  lotId: string;
  lotCode: string;
  effectiveFrom: number;
  effectiveTo?: number;
  transferType: "sale" | "inheritance" | "gift" | "court_order" | "initial";
};

const getCustomerDetailRef = makeFunctionReference<
  "query",
  { customerId: string },
  CustomerDetailData | null
>("customers:getCustomerDetail");

const listByCustomerRef = makeFunctionReference<
  "query",
  { customerId: string },
  OwnershipHistoryRow[]
>("ownerships:listByCustomer");

export default function TransferOwnershipPage() {
  const params = useParams<{ customerId: string }>();
  const router = useRouter();
  const customerId = params.customerId;

  const detail = useQuery(getCustomerDetailRef, { customerId });
  const ownerships = useQuery(listByCustomerRef, { customerId });

  useEffect(() => {
    if (detail !== undefined && detail !== null) {
      document.title = `Transfer ownership · ${detail.fullName} · Broadheader`;
    } else {
      document.title = "Transfer ownership · Broadheader";
    }
  }, [detail]);

  if (detail === undefined || ownerships === undefined) {
    return (
      <div
        className="mx-auto max-w-3xl space-y-4"
        aria-busy="true"
        aria-live="polite"
        data-testid="transfer-page-skeleton"
      >
        <div className="h-9 w-64 animate-pulse rounded bg-slate-200" />
        <div className="h-4 w-96 animate-pulse rounded bg-slate-200" />
        <div className="h-64 w-full animate-pulse rounded bg-slate-100" />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
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

  // Only the open ownership rows (no `effectiveTo`) are eligible for
  // transfer. A closed row is historical and cannot be re-closed.
  const ownedLots: CurrentOwnerLot[] = ownerships
    .filter((row) => row.effectiveTo === undefined)
    .map((row) => ({
      lotId: row.lotId,
      lotCode: row.lotCode,
      ownershipId: row.ownershipId,
    }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Transfer ownership
        </h1>
        <p className="text-sm text-slate-600">
          Recording a transfer FROM{" "}
          <span className="font-medium text-slate-900">{detail.fullName}</span>.
          The previous ownership row will close on the effective date and a
          new ownership row will open for the destination customer.
        </p>
      </header>
      <OwnershipTransferForm
        fromCustomerId={customerId}
        fromCustomerName={detail.fullName}
        ownedLots={ownedLots}
        onCancel={() => router.push(`/customers/${customerId}`)}
        onTransferred={() => router.push(`/customers/${customerId}`)}
      />
    </div>
  );
}
