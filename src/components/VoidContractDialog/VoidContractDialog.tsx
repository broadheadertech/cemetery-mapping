"use client";

/**
 * Story 3.7 — `VoidContractDialog`.
 *
 * Confirmation dialog for the admin pre-interment void workflow. The
 * contract detail page mounts this dialog and toggles its `open` prop;
 * the dialog renders a static warning block, a reason textarea (min 10
 * chars), and a destructive "Void contract" confirm button.
 *
 * UX intent (UX § 1050 confidence-loop):
 *   - The action is destructive and irreversible from the operator's
 *     perspective; the dialog deliberately requires a typed reason and
 *     a mouse-click confirmation. There is no Enter-to-confirm shortcut.
 *   - The warning block surfaces what the void DOES (lot reverts,
 *     contract closes) and what it does NOT (already-issued receipts
 *     remain valid; refunds are out-of-band).
 *
 * Mutation contract: this component is shape-aware of
 * `convex/contracts.ts > voidContract({ contractId, reason })` —
 * the parent owns the actual `useMutation` wiring so this component
 * stays testable without a Convex provider in the test harness.
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
const MAX_REASON = 500;

export interface VoidContractDialogProps {
  /** Controlled open state. Parent toggles via the "Void contract" button. */
  open: boolean;
  /** Fired when the dialog is dismissed (Esc, backdrop, Cancel button). */
  onClose: () => void;
  /**
   * Fires when the user submits a valid reason. The parent is
   * responsible for calling the `voidContract` mutation; this
   * component returns control to the parent so the parent can drive
   * the loading / error / navigation flow.
   */
  onConfirm: (reason: string) => Promise<void>;
  /**
   * Display-only context — the contract identifier and lot code surface
   * in the warning block so the operator double-checks the right
   * contract is being voided.
   */
  contractNumber: string;
  lotCode: string;
  customerName: string;
}

export function VoidContractDialog({
  open,
  onClose,
  onConfirm,
  contractNumber,
  lotCode,
  customerName,
}: VoidContractDialogProps): ReactElement {
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
      // Parent owns the close + navigation; we do not call onClose here
      // so the dialog stays mounted long enough for the parent's
      // post-success navigation to run.
    } catch (err: unknown) {
      setSubmitting(false);
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to void contract. Please try again.",
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
        data-testid="void-contract-dialog"
        onKeyDown={(event) => {
          // UX § 1050 confidence-loop — Enter MUST NOT confirm a
          // destructive action. We swallow the key globally for the
          // dialog so a quick keyboard reflex cannot void a contract.
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Void contract</DialogTitle>
          <DialogDescription>
            Voiding {contractNumber} is irreversible. Review the
            consequences below before confirming.
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="void-contract-warning"
          className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Voiding this contract:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Lot <span className="font-semibold">{lotCode}</span> returns
              to <span className="font-semibold">Available</span>.
            </li>
            <li>
              Ownership for{" "}
              <span className="font-semibold">{customerName}</span> ends
              today.
            </li>
            <li>No further payments can be recorded against this contract.</li>
            <li>
              Already-issued receipts remain valid official documents.
            </li>
            <li>Refunds must be processed separately.</li>
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
            data-testid="void-contract-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={4}
            maxLength={MAX_REASON}
            placeholder="Explain why this contract is being voided…"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            data-testid="void-contract-reason-counter"
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
            data-testid="void-contract-error"
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            data-testid="void-contract-cancel"
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
            data-testid="void-contract-confirm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canConfirm}
            className="rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Voiding…" : "Void contract"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
