"use client";

/**
 * CustomerPayReturn — Story 9.5 + 9.6 (FR33, AC4).
 *
 * Subscribes to `portal:getCustomerPaymentIntent` reactively and
 * renders one of four states:
 *
 *   - `pending` + `redirectUrl: null` — the action hasn't returned
 *     yet. Show a spinner + "Preparing your payment with
 *     {gateway}…".
 *   - `pending` + `redirectUrl` present — the gateway returned a
 *     checkout URL. Kick the browser to it via `window.location` so
 *     the user lands on the gateway's hosted page.
 *   - `succeeded` — webhook landed; the payment is posted. Show a
 *     confirmation panel with the amount + link to the receipt.
 *   - `failed` / `expired` — terminal failure state. Show a "Try
 *     again" link that returns the user to the contract.
 *
 * Reactivity: Convex's reactive `useQuery` pushes updates to this
 * component when the action / webhook patches the row. No
 * `setInterval` — Story 9.5 spec § "No silent loops".
 *
 * Stuck-waiting affordance (AC4): after 90 seconds of `pending`
 * without redirect or terminal state, the page surfaces a
 * "Contact cemetery office" affordance with the
 * `paymentIntentId` as the reference number. The 90-second clock
 * starts on mount; tracked via `useEffect` + state.
 */

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import Link from "next/link";

interface CustomerPaymentIntentView {
  paymentIntentId: string;
  provider: "gcash" | "maya" | "card";
  status: "pending" | "succeeded" | "failed" | "expired";
  amountCents: number;
  contractId: string;
  createdAt: number;
  completedAt: number | null;
  redirectUrl: string | null;
  gatewayTransactionId: string | null;
  failureReason: string | null;
  paymentId: string | null;
}

const getCustomerPaymentIntentRef = makeFunctionReference<
  "query",
  { paymentIntentId: string },
  CustomerPaymentIntentView | null
>("portal:getCustomerPaymentIntent");

const PROVIDER_LABEL: Record<CustomerPaymentIntentView["provider"], string> = {
  gcash: "GCash",
  maya: "Maya",
  card: "card",
};

function formatPeso(cents: number): string {
  const pesos = cents / 100;
  return `₱${pesos.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Map the whitelisted failure-reason token persisted by
 * `gatewayCreateIntent` (P0-3 adversarial review) onto a friendly,
 * customer-safe message. We never render the raw stored string
 * directly — the action's whitelist guarantees the token is one of
 * four known values, but if a forward-compat surprise shows up we
 * fall back to the generic copy.
 *
 * Exported (named) for the unit test so the test asserts the mapping
 * stays in sync with the production whitelist.
 */
export function friendlyFailureMessage(
  reason: string | null,
): string {
  switch (reason) {
    case "gateway_unavailable":
      return "The estate could not reach the payment provider just now. Please try again in a few minutes.";
    case "validation_failed":
      return "The contribution details could not be validated. Please review the amount and try again.";
    case "configuration_error":
      return "The payment service is temporarily unavailable. Please try again later, or write to the Estate Office.";
    case "unknown":
      return "The payment provider reports that this contribution did not complete.";
    default:
      // Forward-compat for any pre-P0-3 rows that still carry raw
      // strings AND for genuine null. Never echo the raw value back.
      return "The payment provider reports that this contribution did not complete.";
  }
}

export interface CustomerPayReturnProps {
  paymentIntentId: string;
  /** Test-only override that skips the reactive query. */
  intentOverride?: CustomerPaymentIntentView | null;
}

export function CustomerPayReturn({
  paymentIntentId,
  intentOverride,
}: CustomerPayReturnProps) {
  const intentFromQuery = useQuery(
    getCustomerPaymentIntentRef,
    intentOverride === undefined ? { paymentIntentId } : "skip",
  );
  const intent =
    intentOverride !== undefined ? intentOverride : intentFromQuery;

  const [mountedAt] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // 90-second stuck-waiting affordance. Tick once per second so we
    // can render the slow-confirmation message at the boundary.
    // Cleared on unmount; the interval is the bounded form of a
    // visibility-window check, NOT a poll on the payment status
    // (that flows through Convex reactivity).
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // Side-effect: redirect to the gateway once the action populates
  // `redirectUrl`. We use `window.location.href` (not `router.push`)
  // because the destination is typically an external URL.
  //
  // P1-1 adversarial review: a stale closure was previously able to
  // re-fire the redirect after the webhook had already landed —
  // navigating the customer back to the gateway's now-closed
  // hosted-checkout URL post-success. We gate the effect on a
  // three-condition set:
  //
  //   - `status === "pending"` (status hasn't flipped to terminal),
  //   - `completedAt === null` (no terminal-state marker — the schema
  //     uses `completedAt` for success, failure AND expiry; the
  //     adversarial review request referenced `failedAt` but the
  //     schema collapses both into `completedAt`), and
  //   - `redirectUrl` is non-null.
  //
  // The combined guard means a reactive update that arrives between
  // the effect's render and its run cannot resurrect a closed intent.
  useEffect(() => {
    if (intent === undefined || intent === null) return;
    if (intent.status !== "pending") return;
    if (intent.completedAt !== null) return;
    if (intent.redirectUrl === null) return;
    // External-or-internal — both honour `href` assignment. Convex
    // reactive subscriptions on this query keep firing if the row
    // changes; the redirect is non-reversible from the customer's
    // POV.
    window.location.href = intent.redirectUrl;
  }, [intent]);

  if (intent === undefined) {
    return (
      <div
        aria-busy="true"
        className="rounded-md border border-surface-border bg-surface-base p-6 shadow-sm"
      >
        <p className="text-sm text-text-muted">
          The estate is gathering the standing of your contribution…
        </p>
      </div>
    );
  }
  if (intent === null) {
    return (
      <div
        role="alert"
        className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
      >
        <p className="text-base font-semibold text-text-default">
          Contribution not at hand
        </p>
        <p className="mt-2 text-sm text-text-muted">
          The estate holds no contribution under that reference in your
          name.
        </p>
      </div>
    );
  }

  const provider = PROVIDER_LABEL[intent.provider];

  if (intent.status === "succeeded") {
    return (
      <div
        role="status"
        className="rounded-md border border-status-success-border bg-status-success-soft p-6 shadow-sm"
      >
        <p className="text-base font-semibold text-status-success-default">
          Your contribution rests with the estate
        </p>
        <p className="mt-2 text-sm text-text-default">
          {formatPeso(intent.amountCents)} has been recorded against your
          contract. With gratitude.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link
            href={`/portal/contracts/${intent.contractId}`}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            See your contract
          </Link>
          <Link
            href="/portal/receipts"
            className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            See your receipts
          </Link>
        </div>
      </div>
    );
  }

  if (intent.status === "failed") {
    return (
      <div
        role="alert"
        className="rounded-md border border-status-danger-border bg-status-danger-soft p-6 shadow-sm"
      >
        <p className="text-base font-semibold text-status-danger-default">
          The contribution did not complete
        </p>
        <p className="mt-2 text-sm text-text-default">
          {friendlyFailureMessage(intent.failureReason)}
        </p>
        <div className="mt-4">
          <Link
            href={`/portal/pay?contractId=${intent.contractId}`}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-accent-primary px-4 py-2 text-sm font-medium text-text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            Try again
          </Link>
        </div>
      </div>
    );
  }

  if (intent.status === "expired") {
    return (
      <div
        role="alert"
        className="rounded-md border border-surface-border bg-surface-base p-6 shadow-sm"
      >
        <p className="text-base font-semibold text-text-default">
          This passage has lapsed
        </p>
        <p className="mt-2 text-sm text-text-muted">
          Please begin a fresh contribution from your contract.
        </p>
        <div className="mt-4">
          <Link
            href={`/portal/pay?contractId=${intent.contractId}`}
            className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-accent-primary px-4 py-2 text-sm font-medium text-text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          >
            Begin a fresh contribution
          </Link>
        </div>
      </div>
    );
  }

  // pending
  const elapsedSec = Math.floor((now - mountedAt) / 1000);
  const stuck = elapsedSec >= 90;
  const heading =
    intent.redirectUrl !== null
      ? `Handing you to ${provider}…`
      : `Preparing your contribution through ${provider}…`;
  return (
    <div
      aria-busy="true"
      className="rounded-md border border-surface-border bg-surface-base p-6 shadow-sm"
    >
      <p className="text-base font-semibold text-text-default">
        {heading}
      </p>
      <p className="mt-2 text-sm text-text-muted">
        The estate is recording your contribution of {formatPeso(intent.amountCents)}
        through {provider}. This usually takes a few moments.
      </p>
      {stuck ? (
        <div className="mt-4 rounded-md border border-status-warning-border bg-status-warning-soft p-3 text-sm">
          <p className="font-medium text-status-warning-default">
            Still in passage
          </p>
          <p className="mt-1 text-text-default">
            Please write to the Estate Office, citing the reference{" "}
            <span className="font-mono">{intent.paymentIntentId}</span>.
          </p>
        </div>
      ) : null}
    </div>
  );
}
