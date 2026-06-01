"use client";

/**
 * Story 3.12 — `VoidReceiptDialog`.
 *
 * Confirmation dialog for the admin receipt-void workflow. The receipt
 * detail page mounts this dialog and toggles its `open` prop; the
 * dialog renders a static warning block, a read-only summary of the
 * receipt being voided (so the operator double-checks the right
 * receipt), a reason textarea (min 10 chars, max 1000), and a
 * destructive "Void receipt" confirm button.
 *
 * Why a dedicated dialog for receipts (instead of reusing
 * `VoidContractDialog`):
 *   - The mutation contracts differ — `voidContract` takes
 *     `{ contractId, reason }`, `voidReceipt` takes
 *     `{ receiptId, reason }` and also reports back the original
 *     receipt number for the success toast.
 *   - The warning copy differs — voiding a receipt invalidates a
 *     BIR-visible legal artifact; voiding a contract reverts a lot.
 *     Different consequences => different warning blocks.
 *   - The read-only summary surfaces receipt-specific identity
 *     (serial / amount / customer last name + first name) which the
 *     contract dialog has no concept of.
 *
 * UX intent (UX § 1050 confidence-loop):
 *   - The action is destructive and BIR-irreversible from the
 *     operator's perspective; the dialog deliberately requires a
 *     typed reason and a mouse-click confirmation. There is no
 *     Enter-to-confirm shortcut — Enter keystrokes inside the dialog
 *     are swallowed so a keyboard reflex cannot void a receipt.
 *   - The warning block surfaces what the void DOES (receipt is
 *     marked VOIDED in audit + on its PDF watermark) and what it
 *     does NOT (the serial stays consumed; the payment row is
 *     flagged but not deleted; refunds are an out-of-band recovery
 *     flow).
 *
 * Mutation contract: this component is shape-aware of
 * `convex/receipts.ts > voidReceipt({ receiptId, reason })` — the
 * parent owns the actual `useMutation` wiring so this component stays
 * testable without a Convex provider in the test harness. The PII
 * surface area in the summary is intentionally narrow: receipt number
 * + amount + customer last / first name. No gov ID, no DOB, no
 * address.
 */

import { useEffect, useId, useState, type ReactElement } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const MIN_REASON = 10;
const MAX_REASON = 1000;

export interface VoidReceiptDialogProps {
  /** Controlled open state. Parent toggles via the "Void receipt" button. */
  open: boolean;
  /** Fired when the dialog is dismissed (Esc, backdrop, Cancel button). */
  onClose: () => void;
  /**
   * Fires when the user submits a valid reason. The parent is
   * responsible for calling the `voidReceipt` mutation; this component
   * returns control to the parent so the parent can drive the loading
   * / error / toast / navigation flow.
   */
  onConfirm: (reason: string) => Promise<void>;
  /**
   * Display-only context — the receipt identifier, amount, and
   * customer name surface in the warning block so the operator
   * double-checks the right receipt is being voided. PII-narrow on
   * purpose: full name only, no gov ID / address.
   */
  receiptNumber: string;
  /**
   * Formatted peso amount string (e.g. "₱2,500.00"). The parent
   * formats — this component is pure presentation.
   */
  amountFormatted: string;
  /**
   * Customer's full name as it appears on the receipt. Pass `null`
   * when the receipt has no linked customer (rare — defensive).
   */
  customerName: string | null;
  /**
   * Issued-at timestamp formatted for the local timezone (e.g.
   * "May 18, 2026, 9:14 AM"). The parent formats — this component is
   * pure presentation.
   */
  issuedAtFormatted: string;
}

export function VoidReceiptDialog({
  open,
  onClose,
  onConfirm,
  receiptNumber,
  amountFormatted,
  customerName,
  issuedAtFormatted,
}: VoidReceiptDialogProps): ReactElement {
  const reasonInputId = useId();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset the form whenever the dialog opens — operators should not see
  // a stale reason from a previously-cancelled attempt.
  useEffect(() => {
    if (open) {
      setReason("");
      setErrorMessage(null);
      setSubmitting(false);
    }
  }, [open]);

  const trimmedReason = reason.trim();
  const reasonTooShort = trimmedReason.length < MIN_REASON;
  const reasonTooLong = reason.length > MAX_REASON;
  const canConfirm = !reasonTooShort && !reasonTooLong && !submitting;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirm(trimmedReason);
      // Parent owns the close + navigation; we do not call onClose
      // here so the dialog stays mounted long enough for the parent's
      // post-success toast / refresh to run.
    } catch (err: unknown) {
      setSubmitting(false);
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to void receipt. Please try again.",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) {
          onClose();
        }
      }}
    >
      <DialogContent
        data-testid="void-receipt-dialog"
        onKeyDown={(event) => {
          // UX § 1050 confidence-loop — Enter MUST NOT confirm a
          // destructive action. We swallow the key globally for the
          // dialog so a quick keyboard reflex cannot void a receipt.
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Void receipt</DialogTitle>
          <DialogDescription>
            Voiding receipt {receiptNumber} cannot be undone. Review the
            consequences below before confirming.
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="void-receipt-summary"
          className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800"
        >
          <p className="font-medium">Receipt being voided:</p>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
            <dt className="text-slate-600">Number</dt>
            <dd className="font-semibold tabular-nums">{receiptNumber}</dd>
            <dt className="text-slate-600">Issued to</dt>
            <dd className="font-semibold">
              {customerName ?? "(no linked customer)"}
            </dd>
            <dt className="text-slate-600">Amount</dt>
            <dd className="font-semibold tabular-nums">{amountFormatted}</dd>
            <dt className="text-slate-600">Issued at</dt>
            <dd>{issuedAtFormatted}</dd>
          </dl>
        </div>

        <div
          data-testid="void-receipt-warning"
          className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Voiding this receipt:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Marks the receipt as <span className="font-semibold">VOIDED</span>
              {" "}in the audit trail and on its PDF.
            </li>
            <li>
              Consumes the original serial — it is{" "}
              <span className="font-semibold">never re-issued</span> to a
              future receipt.
            </li>
            <li>
              Flags the linked payment as voided, but does{" "}
              <span className="font-semibold">not</span> delete it.
            </li>
            <li>
              Refunds or balance corrections are handled in a separate
              workflow.
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <label
            htmlFor={reasonInputId}
            className="text-sm font-medium text-text-default"
          >
            Reason for voiding (required, min {MIN_REASON} characters)
          </label>
          <textarea
            id={reasonInputId}
            data-testid="void-receipt-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={4}
            maxLength={MAX_REASON}
            placeholder="Why is this receipt being voided?"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            data-testid="void-receipt-reason-counter"
            className="flex items-center justify-between text-xs text-slate-500"
          >
            <span>
              {reasonTooShort
                ? `At least ${MIN_REASON - trimmedReason.length} more character${
                    MIN_REASON - trimmedReason.length === 1 ? "" : "s"
                  } required.`
                : "Reason looks good."}
            </span>
            <span>
              {reason.length} / {MAX_REASON}
            </span>
          </div>
        </div>

        {errorMessage !== null && (
          <p
            data-testid="void-receipt-error"
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            data-testid="void-receipt-cancel"
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="void-receipt-confirm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canConfirm}
            className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Voiding…" : "Void receipt"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
