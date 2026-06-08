"use client";

/**
 * ReceiptPreviewModal — Story 3.9 (FR26, AC2).
 *
 * The deliberate "pause" between the operator's "Review receipt" click
 * and the irreversible commit. The modal IS the confirmation step (UX
 * § 587 / § 727); there is NO additional "Are you sure?" dialog.
 *
 * Phase-1 rendering: HTML mock of the BIR-style receipt. Story 3.11 /
 * 3.13 swaps this for an actual PDF iframe via the
 * `generateReceiptPdf` action once that lands. Mirrors the SaleForm's
 * ReceiptPreviewModal (Story 3.3) shape so the two flows present a
 * consistent UI.
 *
 * Keyboard:
 *   - ESC closes (Radix default; blocked when committing so the
 *     in-flight mutation finishes).
 *   - "Generate & Print" auto-focuses on open so a confident operator
 *     can hit Enter to commit.
 */

import { useEffect, useRef } from "react";

import { cn } from "@/lib/cn";
import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

import { PAYMENT_METHOD_LABEL, type PaymentFormMethod } from "./paymentFormSchema";

export interface ReceiptPreviewAllocationLine {
  installmentNumber: number;
  amountAppliedCents: number;
  willMarkPaid: boolean;
}

export interface ReceiptPreviewData {
  contractNumber: string;
  customerFullName: string;
  lotCode: string;
  amountCents: number;
  method: PaymentFormMethod;
  reference: string | undefined;
  paidAtMs: number;
  allocationLines: ReceiptPreviewAllocationLine[];
}

export interface ReceiptPreviewModalProps {
  open: boolean;
  onClose: () => void;
  onCommit: () => void | Promise<void>;
  isSubmitting: boolean;
  errorMessage: string | null;
  data: ReceiptPreviewData | null;
}

export function ReceiptPreviewModal({
  open,
  onClose,
  onCommit,
  isSubmitting,
  errorMessage,
  data,
}: ReceiptPreviewModalProps) {
  const commitButtonRef = useRef<HTMLButtonElement | null>(null);

  // Autofocus the commit button on open so Enter completes the
  // payment.
  useEffect(() => {
    if (open && commitButtonRef.current !== null) {
      const t = window.setTimeout(() => {
        commitButtonRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isSubmitting) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-2xl"
        onEscapeKeyDown={(e) => {
          if (isSubmitting) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Review receipt before issuing</DialogTitle>
          <DialogDescription>
            Confirm the receipt details below. Generating issues a serial
            that cannot be edited; voids must be recorded separately.
          </DialogDescription>
        </DialogHeader>

        {errorMessage !== null && (
          <div
            role="alert"
            data-testid="receipt-preview-error"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {errorMessage}
          </div>
        )}

        {data !== null && (
          <div
            data-testid="receipt-preview-body"
            className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-900"
          >
            <div className="border-b border-slate-200 pb-2 text-center">
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Receipt preview — actual PDF lands in Story 3.11
              </p>
              <p className="mt-1 text-base font-semibold">
                Cemetery Management — Official Receipt
              </p>
              <p className="text-xs text-slate-500">
                Serial: (next available)
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 py-3 text-xs">
              <dt className="text-slate-500">Date</dt>
              <dd className="text-right tabular-nums">
                {formatDate(data.paidAtMs, "short")}
              </dd>
              <dt className="text-slate-500">Contract</dt>
              <dd className="text-right">{data.contractNumber}</dd>
              <dt className="text-slate-500">Lot</dt>
              <dd className="text-right">{data.lotCode}</dd>
              <dt className="text-slate-500">Customer</dt>
              <dd className="text-right">{data.customerFullName}</dd>
              <dt className="text-slate-500">Payment method</dt>
              <dd className="text-right">
                {PAYMENT_METHOD_LABEL[data.method]}
              </dd>
              {data.reference !== undefined && (
                <>
                  <dt className="text-slate-500">Reference</dt>
                  <dd className="text-right">{data.reference}</dd>
                </>
              )}
            </dl>
            {data.allocationLines.length > 0 && (
              <div className="border-t border-slate-200 pt-2">
                <p className="text-xs font-medium text-slate-700">
                  Applied to
                </p>
                <ul
                  className="mt-1 space-y-1 text-xs"
                  data-testid="receipt-preview-allocations"
                >
                  {data.allocationLines.map((line) => (
                    <li
                      key={line.installmentNumber}
                      className="flex justify-between"
                    >
                      <span>
                        Installment #{line.installmentNumber}
                        {line.willMarkPaid && " (closes)"}
                      </span>
                      <span className="tabular-nums">
                        {formatPeso(line.amountAppliedCents)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex items-center justify-between border-t border-slate-200 pt-3 text-base">
              <span className="font-semibold">Total received</span>
              <span
                className="font-semibold tabular-nums"
                data-testid="receipt-preview-total"
              >
                {formatPeso(data.amountCents)}
              </span>
            </div>
            <p className="mt-3 text-[10px] text-slate-400">
              BIR-compliant fields (TIN, address, serial range) will be
              filled in by Story 3.11&apos;s generator.
            </p>
          </div>
        )}

        <p className="text-xs text-slate-500">
          Once generated, this receipt cannot be edited. Voids must be
          recorded separately.
        </p>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            data-testid="receipt-preview-cancel"
            className={cn(
              "min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700",
              "hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Cancel
          </button>
          <button
            ref={commitButtonRef}
            type="button"
            onClick={() => {
              void onCommit();
            }}
            disabled={isSubmitting || data === null}
            data-testid="receipt-preview-commit"
            aria-busy={isSubmitting}
            className={cn(
              "min-h-[44px] rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white",
              "hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {isSubmitting ? "Generating…" : "Generate & Print"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
