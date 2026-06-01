import { notFound, redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";

import { MockGatewayCheckout } from "@/components/CustomerPortal/MockGatewayCheckout";

/**
 * Phase 1 mock-gateway checkout page — Story 9.5 / 9.6.
 *
 * Stands in for the GCash / Maya / card hosted-checkout page while
 * sandbox / production credentials are pending. Renders a tiny
 * "Confirm" / "Decline" UI so the e2e + manual happy path works
 * end-to-end against the sandbox webhook signature scheme.
 *
 * The page accepts `?provider=<gcash|maya|card>&intent=<id>&amount=<cents>`
 * query params and exposes a "Confirm" button that POSTs a synthetic
 * webhook to `/api/<provider>-webhook` using the same HMAC-SHA256
 * signature scheme the production webhook validates. Local dev
 * needs the `<GATEWAY>_WEBHOOK_SECRET` env var set; without it the
 * POST returns 401 and the test reports the failure cleanly.
 *
 * IMPORTANT: this page only runs in non-production environments.
 * Production swap replaces the page entry point with a redirect to
 * the real gateway hosted-checkout URL; the runbook documents the
 * swap procedure.
 *
 * Hard guard (P0-1 from adversarial review): in production we 404
 * unconditionally so a misconfigured deployment cannot expose the
 * sandbox confirm/cancel surface to real customers. The earlier
 * "only documented as non-production" posture had zero runtime
 * enforcement; this `notFound()` call closes that gap.
 */

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

interface PageProps {
  searchParams: Promise<{
    provider?: string;
    intent?: string;
    amount?: string;
    return?: string;
  }>;
}

export default async function CustomerMockGatewayPage({ searchParams }: PageProps) {
  // Hard production guard — see file header. The mock-gateway surface
  // is dev / sandbox only; in production we return 404 so the route is
  // indistinguishable from a non-existent path. Adapters also refuse
  // to mint a sandbox redirect URL in production (see
  // `convex/lib/paymentGateways/*Adapter.ts`), so this is belt-and-
  // braces.
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  const params = await searchParams;
  const provider = params.provider;
  const intent = params.intent;
  const amountStr = params.amount ?? "0";
  const returnUrl = params.return ?? "/portal/contracts";

  if (
    provider !== "gcash" &&
    provider !== "maya" &&
    provider !== "card"
  ) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-default">
          Mock gateway
        </h1>
        <div
          role="alert"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        >
          <p className="text-sm text-text-muted">Invalid gateway parameter.</p>
          <Link
            href="/portal/contracts"
            className="mt-3 inline-block text-sm font-medium text-text-link"
          >
            Return to your contracts
          </Link>
        </div>
      </section>
    );
  }
  if (typeof intent !== "string" || intent.length === 0) {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-text-default">
          Mock gateway
        </h1>
        <div
          role="alert"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        >
          <p className="text-sm text-text-muted">Missing payment reference.</p>
          <Link
            href="/portal/contracts"
            className="mt-3 inline-block text-sm font-medium text-text-link"
          >
            Return to your contracts
          </Link>
        </div>
      </section>
    );
  }

  const amountCents = Number(amountStr) || 0;

  return (
    <section className="space-y-4" aria-labelledby="mock-gateway-heading">
      <h1
        id="mock-gateway-heading"
        className="text-2xl font-semibold tracking-tight text-text-default"
      >
        {provider === "gcash" ? "GCash" : provider === "maya" ? "Maya" : "Card"} sandbox
      </h1>
      <p className="text-sm text-text-muted">
        This is a development placeholder for the gateway&rsquo;s
        hosted checkout page. In production the customer is sent to
        the real gateway.
      </p>
      <MockGatewayCheckout
        provider={provider}
        paymentIntentId={intent}
        amountCents={amountCents}
        returnUrl={returnUrl}
      />
    </section>
  );
}
