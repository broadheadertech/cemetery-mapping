"use client";

/**
 * Story 4.5 — `ReclaimLotDialog`.
 *
 * Confirmation dialog for the admin "reclaim defaulted lot" workflow
 * (FR38). The contract detail page mounts this dialog and toggles its
 * `open` prop; the dialog renders a destructive warning block that
 * enumerates the consequences (contract voided, lot returns to
 * available, ownership closed), a reason textarea (min 10 chars,
 * max 500), and a destructive "Reclaim lot" confirm button.
 *
 * UX intent:
 *   - Reclaim is the most consequential admin action on a contract
 *     after a void: it returns the lot to inventory, voids the
 *     contract, and closes the ownership record in one atomic
 *     mutation. The warning block makes those consequences explicit so
 *     the operator confirms the intent before the click.
 *   - Enter MUST NOT confirm — destructive actions require an explicit
 *     click per the UX confidence-loop guideline. Same defense
 *     `VoidContractDialog` / `MarkInDefaultDialog` use.
 *   - The shipped Phase 1 flow takes ONLY a reason (no prior-payments
 *     policy selector). The richer multi-policy shape (forfeit /
 *     refund / credit + a forfeitedPayments summary row) from the
 *     original story spec is a follow-up that owns `convex/schema.ts`.
 *     This dialog matches the `reclaimLot({ contractId, reason })`
 *     mutation surface.
 *
 * Mutation contract: this component is shape-aware of
 * `convex/contracts.ts > reclaimLot({ contractId, reason })` — the
 * parent owns the actual `useMutation` wiring so the dialog stays
 * testable without a Convex provider in the test harness.
 */

import { useEffect, useId, useState, type ReactElement } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const MIN_RECLAIM_REASON_LENGTH = 10;
export const MAX_RECLAIM_REASON_LENGTH = 500;

export interface ReclaimLotDialogProps {
  /** Controlled open state. Parent toggles via the "Reclaim lot" button. */
  open: boolean;
  /** Fired when the dialog is dismissed (Esc, backdrop, Cancel button). */
  onClose: () => void;
  /**
   * Fires when the user submits a valid reason. The parent is
   * responsible for calling the `reclaimLot` mutation; this component
   * returns control to the parent so the parent can drive the loading
   * / error / post-success navigation flow.
   */
  onConfirm: (reason: string) => Promise<void>;
  /**
   * Display-only context — surfaces in the warning block so the
   * operator double-checks the right contract is being reclaimed.
   */
  contractNumber: string;
  lotCode: string;
  customerName: string;
}

export function ReclaimLotDialog({
  open,
  onClose,
  onConfirm,
  contractNumber,
  lotCode,
  customerName,
}: ReclaimLotDialogProps): ReactElement {
  const reasonInputId = useId();
  const counterId = useId();
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset the form whenever the dialog opens — operators should not
  // see a stale reason from a previously-cancelled attempt.
  useEffect(() => {
    if (open) {
      setReason("");
      setErrorMessage(null);
      setSubmitting(false);
    }
  }, [open]);

  const trimmedReason = reason.trim();
  const reasonTooShort = trimmedReason.length < MIN_RECLAIM_REASON_LENGTH;
  const reasonTooLong = reason.length > MAX_RECLAIM_REASON_LENGTH;
  const canConfirm = !reasonTooShort && !reasonTooLong && !submitting;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirm(trimmedReason);
      // Parent owns close + post-success navigation. We do not call
      // onClose here so the dialog stays mounted long enough for the
      // parent's router.push to settle.
    } catch (err: unknown) {
      setSubmitting(false);
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to reclaim lot. Please try again.",
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
        data-testid="reclaim-lot-dialog"
        onKeyDown={(event) => {
          // Enter MUST NOT confirm a destructive contract-state
          // change. Mirrors `VoidContractDialog` /
          // `MarkInDefaultDialog`'s defense — a quick keyboard reflex
          // must not flip a defaulted contract into voided.
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Reclaim defaulted lot</DialogTitle>
          <DialogDescription>
            Return lot {lotCode} to the available inventory and void
            contract {contractNumber}. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="reclaim-lot-warning"
          className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          <p className="font-medium">Reclaiming this lot will:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Void the contract — its state moves from{" "}
              <span className="font-semibold">In default</span> to{" "}
              <span className="font-semibold">Voided</span>.
            </li>
            <li>
              Return lot <span className="font-semibold">{lotCode}</span>{" "}
              to the available inventory so it can be sold again.
            </li>
            <li>
              Close the customer&apos;s ownership record for{" "}
              <span className="font-semibold">{customerName}</span> as
              of today.
            </li>
            <li>
              Already-issued receipts remain valid official documents.
              Payments and installment rows are{" "}
              <span className="font-semibold">not</span> modified —
              prior-payments handling (forfeit / refund / credit) is a
              separate operational decision.
            </li>
            <li>
              Audit log captures this action with your name, timestamp,
              and the reason you provide below.
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <label
            htmlFor={reasonInputId}
            className="text-sm font-medium text-text-default"
          >
            Reason for reclaim (required, min {MIN_RECLAIM_REASON_LENGTH}{" "}
            characters)
          </label>
          <textarea
            id={reasonInputId}
            data-testid="reclaim-lot-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={3}
            maxLength={MAX_RECLAIM_REASON_LENGTH}
            aria-describedby={counterId}
            placeholder="e.g. Customer unresponsive for 6 months; lot returned to inventory after admin decision."
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            id={counterId}
            data-testid="reclaim-lot-reason-counter"
            aria-live="polite"
            className="flex items-center justify-between text-xs text-slate-500"
          >
            <span>
              {reasonTooShort
                ? `At least ${MIN_RECLAIM_REASON_LENGTH - trimmedReason.length} more character${
                    MIN_RECLAIM_REASON_LENGTH - trimmedReason.length === 1
                      ? ""
                      : "s"
                  } required.`
                : "Reason looks good."}
            </span>
            <span>
              {reason.length} / {MAX_RECLAIM_REASON_LENGTH}
            </span>
          </div>
        </div>

        {errorMessage !== null && (
          <p
            data-testid="reclaim-lot-error"
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            data-testid="reclaim-lot-cancel"
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="reclaim-lot-confirm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canConfirm}
            className="min-h-[44px] rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Reclaiming…" : "Reclaim lot"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
