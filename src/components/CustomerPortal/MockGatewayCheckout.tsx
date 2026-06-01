"use client";

/**
 * MockGatewayCheckout — Story 9.5 / 9.6 dev / sandbox stand-in.
 *
 * Renders a "Confirm" / "Decline" UI so the e2e + manual happy path
 * exercises the webhook flow end-to-end without real GCash / Maya /
 * card credentials.
 *
 * Confirm:
 *   Navigates the browser back to the return URL. The customer sees
 *   "pending — waiting for confirmation" until a sandbox webhook
 *   replay (via `npx convex run` or the runbook command) lands.
 *
 * Cancel (P1-3 adversarial review fix):
 *   Calls the `cancelSandboxPaymentIntent` mutation which marks the
 *   intent `expired` server-side. The return page then renders the
 *   "this payment expired" affordance — making the failure-side UI
 *   exercisable without forging an HMAC. Without this mutation the
 *   Cancel button was indistinguishable from Confirm (both navigated
 *   to the return URL with no state change).
 *
 * Production swap: this component (and the surrounding page) are not
 * rendered — the real gateway's hosted page takes over.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { cn } from "@/lib/cn";

const cancelSandboxPaymentIntentRef = makeFunctionReference<
  "mutation",
  { paymentIntentId: string },
  void
>("portal:cancelSandboxPaymentIntent");

function formatPeso(cents: number): string {
  const pesos = cents / 100;
  return `₱${pesos.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface MockGatewayCheckoutProps {
  provider: "gcash" | "maya" | "card";
  paymentIntentId: string;
  amountCents: number;
  returnUrl: string;
}

const PROVIDER_LABEL: Record<MockGatewayCheckoutProps["provider"], string> = {
  gcash: "GCash",
  maya: "Maya",
  card: "card",
};

export function MockGatewayCheckout({
  provider,
  paymentIntentId,
  amountCents,
  returnUrl,
}: MockGatewayCheckoutProps) {
  const router = useRouter();
  const cancelSandboxIntent = useMutation(cancelSandboxPaymentIntentRef);
  const [cancelling, setCancelling] = useState(false);
  const label = PROVIDER_LABEL[provider];

  async function onCancel() {
    setCancelling(true);
    try {
      // P1-3: actually flip the intent to a terminal state so the
      // return page's failure / expired UI is exercisable. The
      // mutation refuses to run in production (the real gateway emits
      // its own cancellation webhook there).
      await cancelSandboxIntent({ paymentIntentId });
    } catch {
      // We deliberately swallow the throw — the worst case is the
      // return page sees a still-pending intent, which the existing
      // 90-second stuck affordance covers. Surfacing a separate
      // error UI for a sandbox-only path adds maintenance burden for
      // no real benefit.
    }
    // Navigate regardless so the customer's flow continues.
    router.push(returnUrl);
  }

  return (
    <div
      role="region"
      aria-label="Sandbox checkout"
      className="rounded-md border border-surface-border bg-surface-base p-4 shadow-sm sm:p-6"
    >
      <p className="text-sm text-text-muted">
        Paying via <strong>{label}</strong>
      </p>
      <p className="mt-2 text-2xl font-semibold text-text-default">
        {formatPeso(amountCents)}
      </p>
      <p className="mt-1 text-xs text-text-muted">
        Reference: <span className="font-mono">{paymentIntentId}</span>
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={returnUrl}
          className={cn(
            "inline-flex min-h-[44px] items-center justify-center rounded-md",
            "bg-accent-primary px-4 py-2 text-sm font-medium text-text-on-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
          )}
        >
          Confirm payment (sandbox)
        </Link>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className={cn(
            "inline-flex min-h-[44px] items-center justify-center rounded-md",
            "border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>
      <p className="mt-4 text-xs text-text-muted">
        Note: this sandbox page does not fire a real webhook. Confirm
        leaves the intent pending — replay it via the runbook&rsquo;s
        webhook-replay command. Cancel flips the intent to{" "}
        <span className="font-mono">expired</span> so the return
        page&rsquo;s failure UI is exercisable.
      </p>
    </div>
  );
}
