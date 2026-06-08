"use client";

/**
 * /customers/[customerId]/upload — Story 2.2 demo surface.
 *
 * Temporary standalone page that exercises `<CustomerDocumentUpload>`
 * and `<CustomerDocumentList>` until Story 2.5 (customer detail
 * page) integrates them inline on the main detail page.
 *
 * TODO(Story 2.5): remove this page; the upload + list belong on
 *   the customer detail page (`/customers/[customerId]/page.tsx`).
 *
 * Auth: the (staff) layout's server-side `requireAuth` gate (Story
 * 1.1 / 1.2) protects this route. Per-role enforcement
 * (`office_staff` / `admin`) lives inside the Convex handlers —
 * `field_worker` callers will see the form render but receive a
 * `FORBIDDEN` translation on submit. ADR-0002 defense in depth.
 */

import Link from "next/link";
import { useParams } from "next/navigation";

import { CustomerDocumentUpload } from "@/components/CustomerDocumentUpload";
import { CustomerDocumentList } from "@/components/CustomerDocumentList";

export default function CustomerDocumentUploadPage() {
  const params = useParams<{ customerId: string }>();
  const customerId = params.customerId;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Customer Documents
        </h1>
        <p className="text-sm text-slate-600">
          Attach identification scans, affidavits, and other supporting
          documents to this customer record. Government ID scans require
          captured Data Privacy Act consent (Story 2.1).
        </p>
        <p className="text-xs text-slate-500">
          Customer:{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            {customerId}
          </code>
        </p>
      </header>

      <section
        aria-labelledby="upload-heading"
        className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2
          id="upload-heading"
          className="mb-4 text-lg font-semibold text-slate-800"
        >
          Upload a new document
        </h2>
        <CustomerDocumentUpload customerId={customerId} />
      </section>

      <section
        aria-labelledby="list-heading"
        className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2
          id="list-heading"
          className="mb-4 text-lg font-semibold text-slate-800"
        >
          Existing documents
        </h2>
        <CustomerDocumentList customerId={customerId} />
      </section>

      <div className="flex justify-between text-sm">
        <Link
          href={`/customers/${customerId}`}
          className="font-medium text-slate-900 underline"
        >
          ← Back to customer record
        </Link>
        <Link href="/dashboard" className="text-slate-600 underline">
          Dashboard
        </Link>
      </div>
    </div>
  );
}
