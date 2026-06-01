"use client";

/**
 * CustomerPayForm — Story 9.5 + 9.6 (FR33).
 *
 * Method selector + amount input that calls
 * `portal:createGatewayPaymentIntent` and navigates the customer to
 * the gateway's hosted checkout. The customer can choose GCash, Maya,
 * or card. The mutation server-side:
 *
 *   - validates ownership of the contract,
 *   - validates the amount (positive integer ≤ outstanding balance),
 *   - inserts a `paymentIntents` row in `pending` state,
 *   - schedules the `gatewayCreateIntent` action to call the
 *     gateway's hosted-checkout API.
 *
 * The mutation returns `{ paymentIntentId }`. The form navigates the
 * browser to `/portal/pay/return?intent=<id>`, which subscribes to
 * the `paymentIntents` row reactively. When the action patches
 * `redirectUrl` onto the row, the return page redirects the browser
 * to the gateway's hosted checkout. When the webhook lands later,
 * the same return page (re-mounted from the gateway's return URL)
 * shows the success / failure state.
 *
 * The redirect-to-return pattern keeps the form's job narrow:
 * initiate + navigate. The return page handles the actual gateway
 * redirect (after polling for the gateway's URL) and the post-
 * payment state. This decouples the gateway-creation latency from
 * the form's submit confirmation — the customer sees "Initiating…
 * → redirecting to gateway" inside the same UI surface.
 *
 * Accessibility:
 *   - Method selector renders as a radio group with visible labels.
 *   - Amount input has explicit min / max bounds + label.
 *   - Submit button is min-h-[48px] (NFR-A4).
 *   - Inline error via `role="alert"` on submit failure.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";

type Gateway = "gcash" | "maya" | "card";

type CreateGatewayPaymentIntentResult = {
  paymentIntentId: string;
};

const createGatewayPaymentIntentRef = makeFunctionReference<
  "mutation",
  { contractId: string; amountCents: number; gateway: Gateway },
  CreateGatewayPaymentIntentResult
>("portal:createGatewayPaymentIntent");

const GATEWAY_LABEL: Record<Gateway, string> = {
  gcash: "GCash",
  maya: "Maya",
  card: "Credit / Debit card",
};

const GATEWAY_HINT: Record<Gateway, string> = {
  gcash: "Render your contribution through GCash",
  maya: "Render your contribution through Maya",
  card: "Render your contribution by Visa or Mastercard",
};

export interface CustomerPayFormProps {
  contractId: string;
  contractNumber: string;
  outstandingBalanceCents: number;
  defaultAmountCents: number;
}

function formatPeso(cents: number): string {
  const pesos = cents / 100;
  return `₱${pesos.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function CustomerPayForm({
  contractId,
  contractNumber,
  outstandingBalanceCents,
  defaultAmountCents,
}: CustomerPayFormProps) {
  const router = useRouter();
  const createIntent = useMutation(createGatewayPaymentIntentRef);

  const [gateway, setGateway] = useState<Gateway>("gcash");
  // Form holds the amount in PESOS (decimal string) so the customer
  // can type "1234.50". We convert to integer centavos on submit.
  const initialPesos = (defaultAmountCents / 100).toFixed(2);
  const [amountText, setAmountText] = useState(initialPesos);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseAmountCents(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return null;
    if (value <= 0) return null;
    // Convert to centavos with rounding. We round HALF AWAY FROM ZERO
    // so 12.345 → 1235 cents (consistent with how the Phase 1 staff
    // form treats peso input).
    const cents = Math.round(value * 100);
    return cents;
  }

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setError(null);
    const cents = parseAmountCents(amountText);
    if (cents === null) {
      setError("Please enter a peso amount greater than zero.");
      return;
    }
    if (cents > outstandingBalanceCents) {
      setError(
        `The amount may not exceed what remains in keeping, ${formatPeso(outstandingBalanceCents)}.`,
      );
      return;
    }
    setSubmitting(true);
    try {
      const result = await createIntent({
        contractId,
        amountCents: cents,
        gateway,
      });
      // Navigate to the return page; it subscribes to the
      // `paymentIntents` row reactively and forwards to the gateway
      // once `redirectUrl` lands.
      router.push(`/portal/pay/return?intent=${result.paymentIntentId}`);
    } catch (err) {
      const translated = translateError(err);
      setError(`${translated.headline}. ${translated.detail}`);
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-md border border-surface-border bg-surface-base p-4 shadow-sm sm:p-6"
      aria-labelledby="pay-form-heading"
    >
      <div>
        <h2
          id="pay-form-heading"
          className="text-base font-semibold text-text-default"
        >
          {contractNumber}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          Awaiting settlement: {formatPeso(outstandingBalanceCents)}
        </p>
      </div>

      {/* Method selector */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-default">
          By what means you wish to contribute
        </legend>
        {(["gcash", "maya", "card"] as const).map((id) => (
          <label
            key={id}
            className={cn(
              "flex min-h-[48px] cursor-pointer items-center gap-3 rounded-md border px-3 py-2",
              gateway === id
                ? "border-accent-primary bg-accent-primary-soft"
                : "border-surface-border bg-surface-base",
            )}
          >
            <input
              type="radio"
              name="gateway"
              value={id}
              checked={gateway === id}
              onChange={() => setGateway(id)}
              className="h-4 w-4"
            />
            <span className="flex-1">
              <span className="block text-sm font-medium text-text-default">
                {GATEWAY_LABEL[id]}
              </span>
              <span className="block text-xs text-text-muted">
                {GATEWAY_HINT[id]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Amount */}
      <div>
        <label
          htmlFor="amountPeso"
          className="text-sm font-medium text-text-default"
        >
          Contribution (PHP)
        </label>
        <input
          id="amountPeso"
          name="amountPeso"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={amountText}
          onChange={(ev) => setAmountText(ev.target.value)}
          className="mt-1 block min-h-[48px] w-full rounded-md border border-surface-border bg-surface-base px-3 py-2 text-base text-text-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
          aria-describedby={error !== null ? "pay-form-error" : undefined}
        />
        <p className="mt-1 text-xs text-text-muted">
          The estate offers the next installment by default. The amount
          may not exceed what remains in keeping, {formatPeso(outstandingBalanceCents)}.
        </p>
      </div>

      {error !== null ? (
        <p
          id="pay-form-error"
          role="alert"
          className="rounded-md border border-status-danger-border bg-status-danger-soft px-3 py-2 text-sm text-status-danger-default"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex min-h-[48px] w-full items-center justify-center rounded-md bg-accent-primary px-4 py-2 text-sm font-medium text-text-on-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
      >
        {submitting ? "Preparing your contribution…" : `Render through ${GATEWAY_LABEL[gateway]}`}
      </button>
    </form>
  );
}
