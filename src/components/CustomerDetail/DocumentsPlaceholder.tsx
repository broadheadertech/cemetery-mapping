"use client";

/**
 * DocumentsPlaceholder — Story 2.5 AC4.
 *
 * Placeholder for the ID-scan attachments grid. The attachments
 * surface (upload + list with blurred thumbnails + click-to-view via
 * `readPiiUrl`) is owned by Story 2.2 (`CustomerDocumentList` +
 * `CustomerDocumentUpload`), which is shipped in parallel with Story
 * 2.5. To respect the strict file-ownership boundary from the dev
 * agent task brief (Story 2.5 may NOT touch `convex/customerDocuments.ts`
 * or `src/components/CustomerDocumentList/**`), this story renders a
 * stable empty-state card that the later integration story can swap
 * for the Story 2.2 grid.
 *
 * The card carries the section landmark + heading so the rest of the
 * detail-page layout doesn't shift when Story 2.2's grid replaces
 * this placeholder.
 */

import Link from "next/link";

export interface DocumentsPlaceholderProps {
  customerId: string;
}

export function DocumentsPlaceholder({
  customerId,
}: DocumentsPlaceholderProps) {
  return (
    <section
      aria-labelledby="documents-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="documents-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Documents
      </h2>
      <p
        className="text-sm text-slate-600"
        data-testid="documents-placeholder"
      >
        ID scans and supporting documents render here. The full upload +
        blurred-thumbnail grid ships in Story 2.2.
      </p>
      <p className="mt-2 text-xs text-slate-500">
        <Link
          href={`/customers/${customerId}`}
          className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
        >
          Refresh this page after Story 2.2 lands.
        </Link>
      </p>
    </section>
  );
}
