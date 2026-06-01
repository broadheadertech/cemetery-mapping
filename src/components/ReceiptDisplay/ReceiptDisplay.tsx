"use client";

/**
 * ReceiptDisplay — BIR-compliant official-receipt rendering (Story 3.11).
 *
 * Pure presentational component. Parent (the receipt detail page)
 * provides the resolved `ReceiptDetailViewModel`; this component owns
 * NO data fetching. Same pattern as `LotDetail.tsx`.
 *
 * Layout commitments (from the story's BIR-format spec):
 *
 *   - Header: registered name (bold, large), TIN, address, ATP
 *     reference. Right-aligned: "OFFICIAL RECEIPT" tag, serial number
 *     (the legal identity — prominent, monospace tabular figures so
 *     `OR-0000123` and `OR-0001234` line up across receipts).
 *
 *   - Issued row: date in Manila tz, received-by name.
 *
 *   - Customer block: "Received from" + full name + address. PII-safe:
 *     never the gov ID number, never the customer phone, just the
 *     transactional identity.
 *
 *   - Line items table: one row per `paymentAllocations` entry. Each
 *     row carries a friendly label (Contract payment, Installment
 *     payment, etc.) + the amount in tabular numerals.
 *
 *   - Total row: amount in numerals + amount in words. The word form
 *     is a BIR convention that deters the "missing comma" forgery
 *     vector (₱1,500 vs ₱15,00 — without the word form the dispute
 *     is one-against-one).
 *
 *   - VAT block (conditional on `template.isVatRegistered`): VATable
 *     sales / VAT 12% / VAT-exempt / total amount due. Phase 1 ships
 *     with the placeholder config (`isVatRegistered: false`); the
 *     block is documented + tested but renders empty until the
 *     accountant flips the flag.
 *
 *   - Payment method + reference: "Cash" / "Bank transfer · Ref:
 *     20260520-A1B2" etc.
 *
 *   - Signature block: signatory name + title above a printed line.
 *
 *   - Voided banner (when `isVoided`): a destructive-toned banner
 *     atop the receipt with the void reason. The serial is NEVER
 *     released (FR29); the banner is the visual mark for staff.
 *
 *   - Footer: "This is an official receipt." + BIR ATP reference +
 *     format-version tag + the "format pending BIR confirmation"
 *     placeholder banner when applicable (AC5 surrogate — the full
 *     PolicyPendingBanner refactor + dashboard mount land in a
 *     future schema-extending story).
 *
 * Styling: Story 1.4 design tokens only. The component is built so
 * the same DOM can drive the future PDF print path (Story 3.13) via a
 * print stylesheet — semantic class names + tabular-nums + no
 * background images.
 */

import { useMemo } from "react";

import {
  type BirReceiptConfig,
  formatAddressLines,
  formatAllocationLabel,
  formatIssuedDate,
  formatIssuedDateTime,
  formatPaymentMethod,
  formatPesoAmount,
  formatPesoInWords,
  formatTin,
  splitForVat,
} from "../../../convex/lib/birFormat";

/**
 * View-model shape consumed by the component. Mirrors `ReceiptDetail`
 * from `convex/receipts.ts` but doesn't import from there — keeps the
 * component dependency-light + lets tests construct fixtures by hand
 * without a Convex codegen step.
 */
export interface ReceiptDetailViewModel {
  receiptId: string;
  receiptSeries: string;
  receiptNumber: string;
  receiptSerial: number;
  issuedAt: number;
  amountCents: number;
  isVoided: boolean;
  voidedAt: number | null;
  voidReason: string | null;
  voidedByName: string | null;

  customer: {
    customerId: string | null;
    fullName: string | null;
    addressLine1: string | null;
    addressBarangay: string | null;
    addressCityMunicipality: string | null;
    addressProvince: string | null;
    addressPostalCode: string | null;
  };

  payment: {
    paymentId: string;
    paymentMethod:
      | "cash"
      | "check"
      | "bank_transfer"
      | "gcash"
      | "maya"
      | "card";
    reference: string | null;
    receivedAt: number;
    receivedByName: string | null;
  };

  contract: {
    contractId: string | null;
    contractNumber: string | null;
    lotCode: string | null;
  };

  allocations: Array<{
    targetType: "contract" | "installment" | "perpetualCare" | "credit";
    targetId: string;
    amountCents: number;
    sequence: number;
    note: string | null;
  }>;

  template: BirReceiptConfig;
  templateIsPlaceholder: boolean;
}

export interface ReceiptDisplayProps {
  receipt: ReceiptDetailViewModel;
}

export function ReceiptDisplay({ receipt }: ReceiptDisplayProps) {
  const addressLines = useMemo(
    () => formatAddressLines(receipt.template.address),
    [receipt.template.address],
  );
  const formattedTin = useMemo(
    () => formatTin(receipt.template.tin),
    [receipt.template.tin],
  );
  const amountWords = useMemo(
    () => formatPesoInWords(receipt.amountCents),
    [receipt.amountCents],
  );

  // VAT split is conditional on the issuer being VAT-registered. We
  // compute it eagerly when applicable so the VAT block can render the
  // same numbers each time; the helper is pure and integer-only.
  const vatBreakdown = useMemo(() => {
    if (!receipt.template.isVatRegistered) return null;
    return splitForVat(receipt.amountCents);
  }, [receipt.amountCents, receipt.template.isVatRegistered]);

  const customerAddressLines = useMemo(() => {
    const parts: string[] = [];
    if (receipt.customer.addressLine1) parts.push(receipt.customer.addressLine1);
    const localityBits = [
      receipt.customer.addressBarangay,
      receipt.customer.addressCityMunicipality,
      receipt.customer.addressProvince,
      receipt.customer.addressPostalCode,
    ].filter((s): s is string => s !== null && s.length > 0);
    if (localityBits.length > 0) parts.push(localityBits.join(", "));
    return parts;
  }, [receipt.customer]);

  return (
    <article
      data-testid="receipt-display"
      data-receipt-id={receipt.receiptId}
      data-receipt-number={receipt.receiptNumber}
      data-voided={receipt.isVoided ? "true" : "false"}
      className="mx-auto max-w-3xl rounded-md border border-surface-border bg-surface-base p-6 text-text-default shadow-sm print:border-0 print:shadow-none"
    >
      {receipt.templateIsPlaceholder && (
        <div
          role="status"
          data-testid="receipt-placeholder-banner"
          className="mb-4 rounded-md border border-status-overdue-border bg-status-overdue-bg p-3 text-xs font-medium text-status-overdue-text"
        >
          Receipt format pending BIR confirmation (Brief §10 Q3). The
          current template uses a generic BIR official-receipt layout
          and must be replaced before go-live. Contact the compliance
          officer to lock the format.
        </div>
      )}

      {receipt.isVoided && (
        <div
          role="alert"
          data-testid="receipt-voided-banner"
          className="mb-4 rounded-md border border-destructive bg-status-overdue-bg p-3"
        >
          <p className="text-sm font-semibold text-destructive">
            VOIDED RECEIPT
          </p>
          <p className="mt-1 text-xs text-text-default">
            Voided on{" "}
            {receipt.voidedAt !== null
              ? formatIssuedDateTime(receipt.voidedAt)
              : "—"}
            {receipt.voidedByName !== null && ` by ${receipt.voidedByName}`}
            . Reason: {receipt.voidReason ?? "—"}. This receipt is shown
            for audit purposes; the serial is not re-issued (FR29).
          </p>
        </div>
      )}

      {/* Header: cemetery identity + OR title + serial. */}
      <header className="flex flex-col gap-4 border-b border-surface-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1
            data-testid="receipt-registered-name"
            className="text-lg font-bold leading-tight text-text-default"
          >
            {receipt.template.registeredName}
          </h1>
          <p className="mt-1 text-xs text-text-muted">
            TIN:{" "}
            <span
              data-testid="receipt-tin"
              className="font-medium tabular-nums text-text-default"
            >
              {formattedTin}
            </span>
          </p>
          <address className="mt-1 not-italic text-xs text-text-muted">
            {addressLines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
          </address>
          <p className="mt-1 text-[10px] text-text-subtle">
            BIR ATP:{" "}
            <span data-testid="receipt-atp" className="tabular-nums">
              {receipt.template.atpNumber}
            </span>
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-xs font-bold uppercase tracking-wider text-text-muted">
            Official Receipt
          </p>
          <p
            data-testid="receipt-number"
            className="mt-1 font-mono text-2xl font-bold tabular-nums text-text-default"
          >
            {receipt.receiptNumber}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Issued{" "}
            <span data-testid="receipt-issued-date">
              {formatIssuedDate(receipt.issuedAt)}
            </span>
          </p>
        </div>
      </header>

      {/* Customer block. */}
      <section className="border-b border-surface-border py-4">
        <p className="text-xs font-medium uppercase tracking-wider text-text-muted">
          Received from
        </p>
        <p
          data-testid="receipt-customer-name"
          className="mt-1 text-base font-semibold text-text-default"
        >
          {receipt.customer.fullName ?? "[Customer record unavailable]"}
        </p>
        {customerAddressLines.length > 0 && (
          <address className="mt-1 not-italic text-xs text-text-muted">
            {customerAddressLines.map((line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            ))}
          </address>
        )}
        {receipt.contract.contractNumber !== null && (
          <p className="mt-2 text-xs text-text-muted">
            Contract:{" "}
            <span
              data-testid="receipt-contract-number"
              className="font-medium text-text-default"
            >
              {receipt.contract.contractNumber}
            </span>
            {receipt.contract.lotCode !== null && (
              <>
                {" · Lot: "}
                <span
                  data-testid="receipt-lot-code"
                  className="font-medium text-text-default"
                >
                  {receipt.contract.lotCode}
                </span>
              </>
            )}
          </p>
        )}
      </section>

      {/* Line items table. */}
      <section className="py-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
          Particulars
        </p>
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border text-left text-xs font-medium uppercase tracking-wider text-text-muted">
            <tr>
              <th className="pb-2">Description</th>
              <th className="pb-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {receipt.allocations.length === 0 && (
              <tr data-testid="receipt-no-allocations">
                <td colSpan={2} className="py-2 text-xs text-text-muted">
                  No allocation breakdown recorded.
                </td>
              </tr>
            )}
            {receipt.allocations.map((alloc) => (
              <tr
                key={`${alloc.targetType}-${alloc.targetId}-${alloc.sequence}`}
                data-testid={`receipt-allocation-${alloc.sequence}`}
              >
                <td className="py-2 text-sm text-text-default">
                  {formatAllocationLabel(alloc.targetType, alloc.note ?? undefined)}
                </td>
                <td className="py-2 text-right text-sm tabular-nums text-text-default">
                  {formatPesoAmount(alloc.amountCents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-surface-border">
            <tr>
              <th
                scope="row"
                className="pt-2 text-left text-sm font-bold uppercase text-text-default"
              >
                Total
              </th>
              <td
                data-testid="receipt-total-amount"
                className="pt-2 text-right text-base font-bold tabular-nums text-text-default"
              >
                {formatPesoAmount(receipt.amountCents)}
              </td>
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-xs italic text-text-muted">
          (Amount in words:{" "}
          <span
            data-testid="receipt-amount-in-words"
            className="text-text-default"
          >
            {amountWords}
          </span>
          )
        </p>
      </section>

      {/* VAT block (conditional). */}
      {vatBreakdown !== null && (
        <section
          data-testid="receipt-vat-block"
          className="border-t border-surface-border py-4"
        >
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
            VAT Breakdown
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-muted">VATable Sales</dt>
            <dd
              data-testid="receipt-vat-net"
              className="text-right tabular-nums text-text-default"
            >
              {formatPesoAmount(vatBreakdown.netCents)}
            </dd>
            <dt className="text-text-muted">VAT (12%)</dt>
            <dd
              data-testid="receipt-vat-amount"
              className="text-right tabular-nums text-text-default"
            >
              {formatPesoAmount(vatBreakdown.vatCents)}
            </dd>
            <dt className="text-text-muted">VAT-Exempt Sales</dt>
            <dd className="text-right tabular-nums text-text-default">
              {formatPesoAmount(0)}
            </dd>
            <dt className="font-bold text-text-default">Total Amount Due</dt>
            <dd className="text-right font-bold tabular-nums text-text-default">
              {formatPesoAmount(receipt.amountCents)}
            </dd>
          </dl>
        </section>
      )}

      {/* Payment method + reference. */}
      <section className="border-t border-surface-border py-4 text-sm">
        <p>
          <span className="text-text-muted">Payment method: </span>
          <span
            data-testid="receipt-payment-method"
            className="font-medium text-text-default"
          >
            {formatPaymentMethod(receipt.payment.paymentMethod)}
          </span>
          {receipt.payment.reference !== null &&
            receipt.payment.reference.length > 0 && (
              <>
                <span className="text-text-muted"> · Ref: </span>
                <span
                  data-testid="receipt-payment-reference"
                  className="font-medium tabular-nums text-text-default"
                >
                  {receipt.payment.reference}
                </span>
              </>
            )}
        </p>
        {receipt.payment.receivedByName !== null && (
          <p className="mt-1 text-xs text-text-muted">
            Received by{" "}
            <span className="text-text-default">
              {receipt.payment.receivedByName}
            </span>{" "}
            on {formatIssuedDateTime(receipt.payment.receivedAt)}
          </p>
        )}
      </section>

      {/* Signature block. */}
      <section className="border-t border-surface-border py-4">
        <div className="ml-auto w-full max-w-xs text-center">
          <div className="border-b border-text-default pb-6" aria-hidden="true" />
          <p
            data-testid="receipt-signatory-name"
            className="mt-1 text-sm font-medium text-text-default"
          >
            {receipt.template.signatoryName}
          </p>
          <p className="text-xs text-text-muted">
            {receipt.template.signatoryTitle}
          </p>
        </div>
      </section>

      {/* Footer. */}
      <footer className="border-t border-surface-border pt-3 text-center text-[10px] italic text-text-subtle">
        <p data-testid="receipt-footer-disclaimer">
          This is an official receipt.
        </p>
        <p>
          BIR ATP: {receipt.template.atpNumber} · Template format:{" "}
          <span data-testid="receipt-format-version">
            {receipt.template.formatVersion}
          </span>
        </p>
      </footer>
    </article>
  );
}
