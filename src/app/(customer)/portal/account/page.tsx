import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";

import {
  CustomerAccountForm,
  ReminderPreferenceToggle,
} from "@/components/CustomerPortal";

/**
 * Customer portal account-update page — Story 9.4 (FR58, AC1).
 *
 * First customer-write surface in the portal. Renders at
 * `/portal/account` under the `(customer)` route group. Lets a
 * signed-in customer update their own phone / email / address. Name +
 * government-ID stay read-only on the page chrome (FR58 explicit
 * constraint — identity changes require staff verification).
 *
 * Server responsibilities:
 *
 *   1. Defense-in-depth auth check — re-runs `convexAuthNextjsToken()`
 *      and `lib/auth:getCurrentUserOrNull` so a future layout refactor
 *      cannot accidentally serve this page to an unauthenticated
 *      caller. The middleware + the `(customer)` layout are the
 *      primary gates; this is the third backstop.
 *
 *   2. Server-prefetches the customer's current account profile via
 *      `portal:getCurrentCustomerAccount` so the form's pre-fill
 *      arrives in the first paint. The reactive `useQuery` inside
 *      `<CustomerAccountForm>` takes over after hydration so the form
 *      re-syncs if a staff member updates the record from the office
 *      while the customer is still on the page.
 *
 *   3. Owns the page's single `<h1>` per the
 *      `local-rules/single-h1-per-page` lint rule. The form, button,
 *      and reactive feedback live inside `<CustomerAccountForm>` (a
 *      client component).
 *
 * Failure handling: if the server-side prefetch throws (NOT_FOUND for
 * a customer-role caller with no linked record), we surface a generic
 * "Account unavailable" panel rather than letting the page crash. The
 * form's client-side fetch will retry on hydration; if it also fails
 * the user sees a stable empty state with a contact-the-office prompt.
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

interface AccountProfile {
  customerId: string;
  fullName: string;
  email: string;
  phone: string | null;
  address: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
  govIdType: string;
  govIdLast4: string;
  reminderOptOut: boolean;
}

const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

const getCurrentCustomerAccount = makeFunctionReference<
  "query",
  Record<string, never>,
  AccountProfile
>("portal:getCurrentCustomerAccount");

/**
 * Human-readable label for the gov-ID type union. The union values are
 * lowercased single-token strings (SSS, TIN, UMID, ...); the portal
 * shows them in their canonical form so the customer recognises their
 * own ID type from the form.
 */
const GOV_ID_TYPE_LABELS: Record<string, string> = {
  sss: "SSS",
  tin: "TIN",
  umid: "UMID",
  drivers_license: "Driver's License",
  passport: "Passport",
  philhealth: "PhilHealth",
  voters_id: "Voter's ID",
  other: "Government ID",
};

export default async function CustomerAccountPage() {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/portal/login");
  }
  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/portal/login");
  }

  // Server-prefetch the account profile. Wrapped in try/catch so a
  // NOT_FOUND (customer-role caller with no linked record) does not
  // crash the page — we surface a stable fallback instead.
  let profile: AccountProfile | null = null;
  try {
    profile = await fetchQuery(getCurrentCustomerAccount, {}, { token });
  } catch {
    profile = null;
  }

  const govIdTypeLabel =
    profile !== null && GOV_ID_TYPE_LABELS[profile.govIdType] !== undefined
      ? GOV_ID_TYPE_LABELS[profile.govIdType]
      : "Government ID";

  return (
    <section
      aria-labelledby="customer-account-heading"
      className="space-y-4"
    >
      <div>
        <h1
          id="customer-account-heading"
          className="text-2xl font-semibold tracking-tight text-text-default"
        >
          Your record with the estate
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Here you may amend the phone, email, and mailing address by
          which the estate reaches you. Changes of name or government
          identification are made through the Estate Office, in person
          and with due verification.
        </p>
      </div>

      {profile === null ? (
        <div
          role="status"
          className="rounded-md border border-dashed border-surface-border bg-surface-muted p-6 text-center"
        >
          <p className="text-sm font-medium text-text-default">
            Your record is momentarily out of reach
          </p>
          <p className="mt-1 text-sm text-text-muted">
            The estate could not surface your details just now. Should
            this persist, please write to the Estate Office.
          </p>
        </div>
      ) : (
        <>
          <CustomerAccountForm
            initialFullName={profile.fullName}
            initialPhone={profile.phone ?? undefined}
            initialEmail={profile.email}
            initialAddress={profile.address}
            govIdLast4={profile.govIdLast4}
            govIdTypeLabel={govIdTypeLabel}
          />
          <ReminderPreferenceToggle initialOptOut={profile.reminderOptOut} />
        </>
      )}
    </section>
  );
}
