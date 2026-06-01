import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";

import { CustomerReceiptsList } from "@/components/CustomerPortal";

/**
 * Customer portal receipts list page — Story 9.3 (FR56, AC1).
 *
 * Mobile-first card list of the calling customer's BIR-compliant
 * receipts, scoped server-side by `portal:listCustomerReceipts`.
 * Renders at `/portal/receipts` (under the `(customer)` route group
 * from Story 9.1).
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
 *      lives inside `<CustomerReceiptsList>` (a client component).
 *
 * No SEO concerns — the customer portal is private. Server-rendering
 * the page shell keeps the time-to-first-byte fast while the inner
 * `useQuery` handles the reactive receipts list.
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

export default async function CustomerReceiptsPage() {
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
      aria-labelledby="customer-receipts-heading"
      className="space-y-4"
    >
      <div>
        <Link
          href="/portal"
          className="text-sm font-medium text-text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 rounded"
        >
          ← Return to your record
        </Link>
        <h1
          id="customer-receipts-heading"
          className="mt-2 text-2xl font-semibold tracking-tight text-text-default"
        >
          Receipts held in your name
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          The Estate Office issues a BIR-compliant Official Receipt
          for each contribution recorded. Select an entry to retrieve
          its PDF.
        </p>
      </div>
      <CustomerReceiptsList />
    </section>
  );
}
