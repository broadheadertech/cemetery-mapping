"use client";

/**
 * PaymentHistoryPlaceholder — Story 1.11 (AC1f).
 *
 * Reserves the layout slot for the Epic 3 payment history list. Phase
 * 1 just renders subtle "Payments coming in Epic 3" placeholder text.
 *
 * Kept as its own component (instead of inlining the paragraph) so
 * Epic 3's Payment List can drop in by swapping the export with no
 * call-site changes.
 */

export function PaymentHistoryPlaceholder() {
  return (
    <section
      aria-labelledby="payments-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="payments-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Payment history
      </h2>
      <p
        className="text-sm text-slate-500"
        data-testid="payments-placeholder"
      >
        Payments coming in Epic 3.
      </p>
    </section>
  );
}
