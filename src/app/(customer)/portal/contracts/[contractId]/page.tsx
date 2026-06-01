import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import Link from "next/link";

import { CustomerContractDetail } from "@/components/CustomerPortal";

/**
 * Customer contract detail page — Story 9.2 (FR55, AC2 / AC3 / AC4).
 *
 * Renders the full read-only contract surface (header, schedule,
 * payment history) for a single contract id from the URL. Ownership
 * scoping happens server-side inside
 * `portal:getCustomerContractDetail` — when the contract is missing
 * OR not owned by the calling customer, the query returns `null` and
 * `<CustomerContractDetail>` renders a 404 panel (NOT a 403; existence
 * enumeration defense per Story 9.1 ADR).
 *
 * No `notFound()` call here — the 404 surface lives in the client
 * component because the ownership check happens after the page mounts
 * and subscribes to the reactive query. Server-rendering a 404 would
 * require an extra round-trip and break the reactive update path.
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
  params: Promise<{ contractId: string }>;
}

export default async function CustomerContractDetailPage({
  params,
}: PageProps) {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  const { contractId } = await params;

  return (
    <section
      aria-labelledby="contract-detail-heading"
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
          id="contract-detail-heading"
          className="mt-2 text-2xl font-semibold tracking-tight text-text-default"
        >
          Contract particulars
        </h1>
      </div>
      <CustomerContractDetail contractId={contractId} />
    </section>
  );
}
