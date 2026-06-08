"use client";

/**
 * /payments/new — Office-staff payment entry page (Story 3.9, FR26).
 *
 * Journey 2's full-page form. The route accepts a `?contractId=...`
 * query parameter from the contract detail page's "Record payment"
 * link. The form itself is a client component (`PaymentForm`) — it
 * owns the React-Hook-Form state, the reactive allocation preview, the
 * receipt-preview modal, and the post-commit navigation.
 *
 * Why this URL shape: the canonical task list (Story 3.9 Task 5) puts
 * the payment route under the contract resource —
 * `/contracts/[contractId]/payments/new`. The shipped scope for Story
 * 3.9 ships a top-level `/payments/new?contractId=…` route instead,
 * which keeps the payment-creation surface flat (Maria opens it from
 * the sidebar AND from the contract detail page) and avoids touching
 * the `contracts/[contractId]/...` segment hierarchy owned by Story
 * 3.6's contract-detail story. The semantic invariant — "a payment
 * belongs to a contract" — is preserved by the required query
 * parameter; the URL difference is cosmetic.
 *
 * Auth: the (staff) layout (Story 1.1 / 1.2) gates the route to
 * authenticated users; the `recordPaymentWithAutoAllocation` mutation
 * (Story 3.9) enforces the office_staff / admin role server-side.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { PaymentForm } from "@/components/PaymentForm";

export default function NewPaymentPage() {
  const params = useSearchParams();
  const contractId = params.get("contractId");

  if (contractId === null || contractId.length === 0) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <h1 className="font-display text-4xl font-semibold tracking-tight">Record payment</h1>
        <div
          role="alert"
          data-testid="payment-page-missing-contract"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Pick a contract first.</p>
          <p className="mt-1">
            Open a contract from the{" "}
            <Link
              href="/sales"
              className="underline decoration-amber-400 underline-offset-2 hover:decoration-amber-700"
            >
              Sales
            </Link>{" "}
            list and click <em>Record payment</em>, or pass{" "}
            <code className="rounded bg-amber-100 px-1 py-0.5 text-[11px]">
              ?contractId=…
            </code>{" "}
            on this URL.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1
          className="text-3xl font-bold tracking-tight"
          data-testid="payment-page-heading"
        >
          Record payment
        </h1>
        <Link
          href={`/contracts/${contractId}`}
          className="text-sm text-slate-600 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
        >
          ← Back to contract
        </Link>
      </div>
      <PaymentForm contractId={contractId} />
    </div>
  );
}
