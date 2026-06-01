import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";

import { CustomerContractsList } from "@/components/CustomerPortal";

/**
 * Customer portal contracts list page — Story 9.2 (FR55, AC1).
 *
 * Mobile-first card list of the calling customer's contracts, scoped
 * server-side by `portal:listCustomerContracts`. Renders at
 * `/portal/contracts` (under the `(customer)` route group from Story
 * 9.1).
 *
 * Server responsibilities:
 *
 *   1. Defense-in-depth auth check — re-runs `convexAuthNextjsToken()`
 *      so a future layout refactor cannot accidentally reach this page
 *      unauthenticated. The middleware + the `(customer)` layout are
 *      the primary gates; this is the third backstop.
 *
 *   2. Owns the page's single `<h1>` per the
 *      `local-rules/single-h1-per-page` lint rule. The reactive list
 *      lives inside `<CustomerContractsList>` (a client component).
 *
 * No SEO concerns — the customer portal is private. Server-rendering
 * the page shell keeps the time-to-first-byte fast while the inner
 * `useQuery` handles the reactive contract list.
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

export default async function CustomerContractsPage() {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  return (
    <section
      aria-labelledby="customer-contracts-heading"
      className="space-y-4"
    >
      <div>
        <h1
          id="customer-contracts-heading"
          className="text-2xl font-semibold tracking-tight text-text-default"
        >
          Your contracts in keeping
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Balances are reflected here as the Estate Office records your
          contributions.
        </p>
      </div>
      <CustomerContractsList />
    </section>
  );
}
