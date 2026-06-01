import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";

import { CustomerPayForm } from "@/components/CustomerPortal/CustomerPayForm";

/**
 * Customer portal payment page — Story 9.5 / 9.6 (FR33).
 *
 * Renders at `/portal/pay?contractId=<id>` under the `(customer)`
 * route group. Lets a signed-in customer initiate a gateway payment
 * (GCash, Maya, or card) against one of their own contracts.
 *
 * Server responsibilities:
 *
 *   1. Defense-in-depth auth check — re-runs `convexAuthNextjsToken()`
 *      and `lib/auth:getCurrentUserOrNull` so a future layout refactor
 *      cannot accidentally serve this page to an unauthenticated
 *      caller. The middleware + the `(customer)` layout are the
 *      primary gates; this is the third backstop.
 *
 *   2. Server-prefetches the contract via
 *      `portal:getCustomerContractDetail` so the contract context
 *      (balance, next-due amount, lot reference) is in the first
 *      paint. The reactive `useQuery` inside `<CustomerPayForm>`
 *      takes over after hydration.
 *
 *   3. Owns the page's single `<h1>` per the
 *      `local-rules/single-h1-per-page` lint rule. Form + amount
 *      input + method selector live inside `<CustomerPayForm>`.
 *
 * 404 handling: contract id missing from the query string or owned
 * by a different customer surfaces a generic "Contract not found"
 * panel — the page does not call Next's `notFound()` so the URL stays
 * stable for retry.
 */

interface PageProps {
  searchParams: Promise<{ contractId?: string }>;
}

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

interface ContractContext {
  contract: {
    contractId: string;
    contractNumber: string;
    kind: "full_payment" | "installment";
    state:
      | "active"
      | "paid_in_full"
      | "cancelled"
      | "voided"
      | "in_default";
    totalPriceCents: number;
    outstandingBalanceCents: number;
    createdAt: number;
    termMonths?: number;
    monthlyAmountCents?: number;
    downPaymentCents?: number;
    firstDueDate?: number;
  };
  lot: {
    code: string;
    section: string;
    block: string;
    row: string;
  } | null;
  schedule: Array<{
    installmentNumber: number;
    dueDate: number;
    principalCents: number;
    paidCents: number;
    status: "pending" | "paid" | "overdue" | "waived";
  }>;
}

const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

const getCustomerContractDetail = makeFunctionReference<
  "query",
  { contractId: string },
  ContractContext | null
>("portal:getCustomerContractDetail");

export default async function CustomerPayPage({ searchParams }: PageProps) {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  const params = await searchParams;
  const contractId = params.contractId;

  let context: ContractContext | null = null;
  if (typeof contractId === "string" && contractId.length > 0) {
    try {
      context = await fetchQuery(
        getCustomerContractDetail,
        { contractId },
        { token },
      );
    } catch {
      context = null;
    }
  }

  // Compute the next-due-installment amount (or remaining balance) for
  // the form's default value. Installment contracts default to the
  // amount of the next un-paid installment; full-payment contracts
  // default to the outstanding balance.
  let defaultAmountCents = 0;
  if (context !== null) {
    if (context.contract.kind === "installment") {
      const next = context.schedule.find((s) => s.status !== "paid");
      if (next !== undefined) {
        defaultAmountCents = Math.max(0, next.principalCents - next.paidCents);
      } else {
        defaultAmountCents = context.contract.outstandingBalanceCents;
      }
    } else {
      defaultAmountCents = context.contract.outstandingBalanceCents;
    }
  }
  // Clamp the default to the remaining balance (defensive belt-and-
  // braces in case schedule shape returns a stale figure).
  if (
    context !== null &&
    defaultAmountCents > context.contract.outstandingBalanceCents
  ) {
    defaultAmountCents = context.contract.outstandingBalanceCents;
  }

  return (
    <section
      aria-labelledby="customer-pay-heading"
      className="space-y-4"
    >
      <div>
        <Link
          href={
            contractId !== undefined
              ? `/portal/contracts/${contractId}`
              : "/portal/contracts"
          }
          className="text-sm font-medium text-text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 rounded"
        >
          ← Return to your contract
        </Link>
        <h1
          id="customer-pay-heading"
          className="mt-2 text-2xl font-semibold tracking-tight text-text-default"
        >
          Settle through the Estate Office
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          You may render your contribution by GCash, Maya, or card. The
          estate will hand you to the provider&rsquo;s secure passage,
          and return you here once the matter is recorded.
        </p>
      </div>

      {context === null || contractId === undefined ? (
        <div
          role="alert"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        >
          <p className="text-base font-semibold text-text-default">
            Contract not found
          </p>
          <p className="mt-2 text-sm text-text-muted">
            The estate does not hold that contract under your name.
            Please return to your contracts and try again.
          </p>
          <Link
            href="/portal/contracts"
            className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            See your contracts
          </Link>
        </div>
      ) : context.contract.state !== "active" ? (
        <div
          role="alert"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        >
          <p className="text-base font-semibold text-text-default">
            This contract is not at present accepting online contributions
          </p>
          <p className="mt-2 text-sm text-text-muted">
            For any matter outstanding on this contract, please write to
            the Estate Office.
          </p>
        </div>
      ) : context.contract.outstandingBalanceCents <= 0 ? (
        <div
          role="status"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        >
          <p className="text-base font-semibold text-text-default">
            Your contract rests in full settlement
          </p>
          <p className="mt-2 text-sm text-text-muted">
            Nothing remains owing on this contract. With gratitude, the
            Estate Office.
          </p>
        </div>
      ) : (
        <CustomerPayForm
          contractId={contractId}
          contractNumber={context.contract.contractNumber}
          outstandingBalanceCents={context.contract.outstandingBalanceCents}
          defaultAmountCents={defaultAmountCents}
        />
      )}
    </section>
  );
}
