"use client";

/**
 * Story 4.4 — `MarkInDefaultDialog`.
 *
 * Confirmation dialog for the admin "mark contract in default"
 * workflow (FR37). The contract detail page mounts this dialog and
 * toggles its `open` prop; the dialog renders a warning block that
 * makes the critical "default ≠ reclaim" invariant explicit, a
 * reason textarea (min 10 chars, max 500), and a destructive
 * "Mark in default" confirm button.
 *
 * UX intent:
 *   - The action is a heavyweight contract-state change but
 *     intentionally NOT terminal — the contract can later be
 *     reinstated or reclaimed via separate flows. The warning block
 *     surfaces what defaulting DOES (collections workflow + dashboard
 *     re-categorisation) and what it does NOT (lot stays sold,
 *     ownership intact, receipts untouched). This calms operators
 *     who would otherwise conflate "default" with "void/cancel."
 *   - Enter MUST NOT confirm — destructive actions require an
 *     explicit click per the UX confidence-loop guideline. Same
 *     defense `VoidContractDialog` uses.
 *
 * Mutation contract: this component is shape-aware of
 * `convex/contracts.ts > markContractInDefault({ contractId, reason })`
 * — the parent owns the actual `useMutation` wiring so the dialog
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

export const MIN_DEFAULT_REASON_LENGTH = 10;
export const MAX_DEFAULT_REASON_LENGTH = 500;

export interface MarkInDefaultDialogProps {
  /** Controlled open state. Parent toggles via the "Mark in default" button. */
  open: boolean;
  /** Fired when the dialog is dismissed (Esc, backdrop, Cancel button). */
  onClose: () => void;
  /**
   * Fires when the user submits a valid reason. The parent is
   * responsible for calling the `markContractInDefault` mutation;
   * this component returns control to the parent so the parent can
   * drive the loading / error / reactive-UI flow.
   */
  onConfirm: (reason: string) => Promise<void>;
  /**
   * Display-only context — surfaces in the warning block so the
   * operator double-checks the right contract is being defaulted.
   */
  contractNumber: string;
  lotCode: string;
  customerName: string;
}

export function MarkInDefaultDialog({
  open,
  onClose,
  onConfirm,
  contractNumber,
  lotCode,
  customerName,
}: MarkInDefaultDialogProps): ReactElement {
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
  const reasonTooShort = trimmedReason.length < MIN_DEFAULT_REASON_LENGTH;
  const reasonTooLong = reason.length > MAX_DEFAULT_REASON_LENGTH;
  const canConfirm = !reasonTooShort && !reasonTooLong && !submitting;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirm(trimmedReason);
      // Parent owns close + reactive-UI re-render. We do not call
      // onClose here so the dialog stays mounted long enough for the
      // parent's post-success state to settle.
    } catch (err: unknown) {
      setSubmitting(false);
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to mark contract in default. Please try again.",
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
        data-testid="mark-in-default-dialog"
        onKeyDown={(event) => {
          // Enter MUST NOT confirm a destructive contract-state
          // change. Mirrors `VoidContractDialog`'s defense — a quick
          // keyboard reflex must not flip a contract into default.
          if (event.key === "Enter") {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Mark contract as in-default</DialogTitle>
          <DialogDescription>
            Flag {contractNumber} for collections. The lot remains
            assigned to the customer until you separately reclaim it.
          </DialogDescription>
        </DialogHeader>

        <div
          data-testid="mark-in-default-warning"
          className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Marking this contract in-default:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              Routes the contract into the collections workflow and
              re-categorises it under the &quot;In Default&quot; AR aging
              bucket.
            </li>
            <li>
              Lot <span className="font-semibold">{lotCode}</span>{" "}
              <span className="font-semibold">stays sold</span> to{" "}
              <span className="font-semibold">{customerName}</span> —
              defaulting is NOT reclaiming. Use the separate
              &quot;Reclaim lot&quot; action when that step is
              warranted.
            </li>
            <li>
              Already-issued receipts remain valid official documents.
              Payments and installment rows are untouched.
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
            Reason for default (required, min {MIN_DEFAULT_REASON_LENGTH}{" "}
            characters)
          </label>
          <textarea
            id={reasonInputId}
            data-testid="mark-in-default-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={3}
            maxLength={MAX_DEFAULT_REASON_LENGTH}
            aria-describedby={counterId}
            placeholder="e.g. Customer has not responded after 3 follow-up attempts; arrears > 90 days."
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-[#1D5C4D] focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            id={counterId}
            data-testid="mark-in-default-reason-counter"
            aria-live="polite"
            className="flex items-center justify-between text-xs text-slate-500"
          >
            <span>
              {reasonTooShort
                ? `At least ${MIN_DEFAULT_REASON_LENGTH - trimmedReason.length} more character${
                    MIN_DEFAULT_REASON_LENGTH - trimmedReason.length === 1
                      ? ""
                      : "s"
                  } required.`
                : "Reason looks good."}
            </span>
            <span>
              {reason.length} / {MAX_DEFAULT_REASON_LENGTH}
            </span>
          </div>
        </div>

        {errorMessage !== null && (
          <p
            data-testid="mark-in-default-error"
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            data-testid="mark-in-default-cancel"
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
            data-testid="mark-in-default-confirm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canConfirm}
            className="min-h-[44px] rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Marking…" : "Mark in default"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
