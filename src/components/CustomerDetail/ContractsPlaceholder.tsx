"use client";

/**
 * ContractsPlaceholder — Story 2.5 AC1f.
 *
 * Placeholder for the customer's contracts list. Story 3.4 owns the
 * `contracts` table + `listByCustomer` query; until it ships, the
 * detail page renders this empty-state card so the layout doesn't
 * shift when the real surface lands.
 *
 * The card carries the section landmark + heading so screen-reader
 * navigation hits the section even while the data is unavailable.
 */

export interface ContractsPlaceholderProps {
  customerId: string;
}

export function ContractsPlaceholder({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  customerId,
}: ContractsPlaceholderProps) {
  return (
    <section
      aria-labelledby="contracts-heading"
      className="rounded-md border border-slate-200 bg-white p-6"
    >
      <h2
        id="contracts-heading"
        className="mb-4 text-base font-semibold text-slate-900"
      >
        Contracts
      </h2>
      <p
        className="text-sm text-slate-600"
        data-testid="contracts-placeholder"
      >
        No contracts on file for this customer. The contracts list ships
        in Story 3.4.
      </p>
    </section>
  );
}
