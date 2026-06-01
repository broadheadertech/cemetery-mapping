"use client";

/**
 * ContactBlock — Story 2.5 AC1b.
 *
 * Renders the customer's contact information (phone, email, address,
 * relationship-to-occupant). Phone is rendered as a `tel:` link; email
 * as a `mailto:` link, so Office Staff can dial / mail with a single
 * tap from the detail page (Maria's primary workflow).
 *
 * Empty-field handling: missing optional fields render `—` rather than
 * empty space so the layout stays stable across customers with
 * different amounts of captured information (legacy data per §10 Q4).
 */

import type { CustomerDetailAddress } from "./types";

export interface ContactBlockProps {
  phone?: string;
  email?: string;
  address: CustomerDetailAddress;
  relationshipToOccupant?: string;
}

export function ContactBlock({
  phone,
  email,
  address,
  relationshipToOccupant,
}: ContactBlockProps) {
  return (
    <section
      aria-labelledby="contact-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="contact-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Contact
      </h2>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
        <div className="flex flex-col">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Phone
          </dt>
          <dd className="mt-1 text-sm text-slate-900">
            {phone === undefined ? (
              <span className="text-slate-400">—</span>
            ) : (
              <a
                href={`tel:${phone}`}
                className="text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                data-testid="customer-contact-phone"
              >
                {phone}
              </a>
            )}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Email
          </dt>
          <dd className="mt-1 text-sm text-slate-900">
            {email === undefined ? (
              <span className="text-slate-400">—</span>
            ) : (
              <a
                href={`mailto:${email}`}
                className="text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                data-testid="customer-contact-email"
              >
                {email}
              </a>
            )}
          </dd>
        </div>
        <div className="flex flex-col sm:col-span-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Address
          </dt>
          <dd
            className="mt-1 text-sm text-slate-900"
            data-testid="customer-contact-address"
          >
            <div>{address.line1}</div>
            {(address.barangay !== undefined ||
              address.cityMunicipality !== undefined) && (
              <div className="text-slate-700">
                {[address.barangay, address.cityMunicipality]
                  .filter((s): s is string => s !== undefined && s.length > 0)
                  .join(", ")}
              </div>
            )}
            {(address.province !== undefined ||
              address.postalCode !== undefined) && (
              <div className="text-slate-700">
                {[address.province, address.postalCode]
                  .filter((s): s is string => s !== undefined && s.length > 0)
                  .join(" ")}
              </div>
            )}
          </dd>
        </div>
        {relationshipToOccupant !== undefined && (
          <div className="flex flex-col sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Relationship to occupant
            </dt>
            <dd className="mt-1 text-sm text-slate-900">
              {relationshipToOccupant}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
