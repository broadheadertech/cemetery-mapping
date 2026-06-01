"use client";

import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

/**
 * Customer portal landing greeting body (Story 9.1, FR5).
 *
 * Renders the reactive sub-content of the portal landing: a
 * personalised "your contracts and receipts will appear here" line
 * plus the placeholder list slot Story 9.2 fills in. The h1 itself
 * lives in the page component (required by the
 * `local-rules/single-h1-per-page` lint rule, which scans page files
 * without traversing into imports).
 *
 * This component is a client component because it reactively reads
 * `portal:getCurrentCustomer` via `useQuery` — if the customer's name
 * is edited from another tab (Story 9.4 future write path), the body
 * updates without a refresh.
 *
 * Why `makeFunctionReference` instead of importing from
 * `convex/_generated/api`: the generated module only exists after the
 * developer runs `npx convex dev` interactively. The other client
 * surfaces in this repo (e.g. `src/middleware.ts`,
 * `src/app/(staff)/layout.tsx`) follow the same pattern — keep the
 * typecheck clean ahead of codegen.
 */

export interface CustomerPortalGreetingProps {
  /** Server-resolved fallback name used while the reactive query
   *  warms up, or when the customer-record link is missing (the
   *  query returns NOT_FOUND in that case). */
  fallbackName: string;
}

interface CurrentCustomerProfile {
  customerId: string;
  fullName: string;
  email: string;
}

const getCurrentCustomer = makeFunctionReference<
  "query",
  Record<string, never>,
  CurrentCustomerProfile
>("portal:getCurrentCustomer");

export function CustomerPortalGreeting({
  fallbackName,
}: CustomerPortalGreetingProps) {
  const profile = useQuery(getCurrentCustomer, {});
  const name = profile?.fullName ?? fallbackName;

  return (
    <div>
      <p className="mt-1 text-sm text-text-muted" aria-live="polite">
        {name
          ? `The estate holds your record in care, ${name}.`
          : "The estate holds your contracts and receipts here, in quiet keeping."}
      </p>

      <div className="mt-6 rounded-md border border-dashed border-surface-border bg-surface-muted p-6 text-center text-sm text-text-muted">
        <p className="font-medium text-text-default">Your contracts</p>
        <p className="mt-1">
          The estate will surface your contracts here in a forthcoming release.
        </p>
      </div>
    </div>
  );
}
