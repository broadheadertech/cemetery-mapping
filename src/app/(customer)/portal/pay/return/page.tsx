import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";

import { CustomerPayReturn } from "@/components/CustomerPortal/CustomerPayReturn";

/**
 * Customer payment return page — Story 9.5 / 9.6 (FR33, AC4).
 *
 * Renders at `/portal/pay/return?intent=<id>` and serves two purposes:
 *
 *   1. **Initial redirect to the gateway**: when the customer
 *      navigates here straight from `/portal/pay`, the
 *      `paymentIntents` row is `pending` with no `redirectUrl` yet —
 *      the action is still calling the gateway. The page subscribes
 *      to the row reactively and, once `redirectUrl` lands, kicks
 *      the browser to the gateway's hosted checkout.
 *
 *   2. **Post-payment status display**: the gateway redirects the
 *      customer back to `/portal/pay/return?intent=<id>` after
 *      checkout. By then the webhook has typically landed (the ACK
 *      budget is 5 seconds; the gateway redirect itself is the user
 *      walking back from the GCash / Maya / card hosted page). The
 *      page shows "Payment confirmed" / "Pending" / "Failed" /
 *      "Expired" based on the row's `status`.
 *
 * No `setInterval` polling — Convex pushes row updates over the
 * reactive subscription. Story 9.5 spec § "No silent loops".
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
  searchParams: Promise<{ intent?: string }>;
}

export default async function CustomerPayReturnPage({ searchParams }: PageProps) {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  const params = await searchParams;
  const intent = params.intent;

  return (
    <section
      aria-labelledby="customer-pay-return-heading"
      className="space-y-4"
    >
      <div>
        <Link
          href="/portal/contracts"
          className="text-sm font-medium text-text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 rounded"
        >
          ← Return to your contracts
        </Link>
        <h1
          id="customer-pay-return-heading"
          className="mt-2 text-2xl font-semibold tracking-tight text-text-default"
        >
          The standing of your contribution
        </h1>
      </div>

      {typeof intent !== "string" || intent.length === 0 ? (
        <div
          role="alert"
          className="rounded-md border border-surface-border bg-surface-base p-6 text-center shadow-sm"
        >
          <p className="text-base font-semibold text-text-default">
            No contribution at hand to report
          </p>
          <p className="mt-2 text-sm text-text-muted">
            The estate has nothing pending in this passage. Please
            return to your contracts.
          </p>
        </div>
      ) : (
        <CustomerPayReturn paymentIntentId={intent} />
      )}
    </section>
  );
}
