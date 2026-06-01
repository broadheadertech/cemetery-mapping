"use client";

/**
 * Story 5.4 — `FlagContractDialog` (FR44, Journey 4 climax).
 *
 * Admin-driven popover-style dialog that captures a short comment and
 * routes attention to the staff dashboard via the
 * `contracts.flagContract` mutation. This is the single mutation Mr.
 * Reyes performs from his phone in a typical week — calm, single-tap,
 * single-comment, reactive cross-role sync.
 *
 * Scope (matches the user prompt's narrower implementation vs the
 * original story's full lifecycle table):
 *   - Flag-only surface — no assignee picker (always all-staff in
 *     Phase 1; per-staff assignment is a future story).
 *   - Single comment field with a 280-char limit + visible counter.
 *   - "Flag" + "Cancel" buttons, both with the 44px tap-target floor.
 *
 * Mutation contract: this component is shape-aware of
 * `convex/contracts.ts > flagContract({ contractId, reason })`. The
 * parent owns the actual `useMutation` wiring so the component stays
 * testable without a Convex provider in the test harness.
 */

import { useEffect, useId, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Mirrors `FLAG_REASON_MAX_LENGTH` on the server (convex/contracts.ts).
// Duplicated as a constant rather than imported because client-side and
// Convex-side modules don't share a module graph at compile time. The
// server is the truth — this cap is the UX layer's belt-and-suspenders.
export const FLAG_REASON_MAX_LENGTH = 280;

export interface FlagContractDialogProps {
  /** Controlled open state. Parent toggles via the "Flag for follow-up" button. */
  open: boolean;
  /** Fired when the dialog is dismissed (Esc, backdrop, Cancel button). */
  onClose: () => void;
  /**
   * Fires when the user submits a non-empty reason. The parent calls
   * `contracts.flagContract` with `{ contractId, reason }`; this
   * component stays free of Convex coupling so component tests don't
   * need a provider.
   */
  onConfirm: (reason: string) => Promise<void>;
  /**
   * Display-only context — the contract identifier surfaces in the
   * dialog header so the operator double-checks the right contract is
   * being flagged before submitting.
   */
  contractNumber: string;
  /**
   * Pre-fill the textarea when re-flagging (admin updating an existing
   * reason). The parent passes the current `flagReason` when the
   * contract is already flagged so the operator edits in place rather
   * than retyping. Absent (or empty) for an initial flag.
   */
  initialReason?: string;
}

export function FlagContractDialog({
  open,
  onClose,
  onConfirm,
  contractNumber,
  initialReason,
}: FlagContractDialogProps) {
  const reasonInputId = useId();
  const counterId = useId();
  const [reason, setReason] = useState(initialReason ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Reset (or re-seed) the textarea each time the dialog opens. Without
  // this, a previously-cancelled draft would leak across opens and a
  // re-opened dialog for a different contract could show stale text.
  useEffect(() => {
    if (open) {
      setReason(initialReason ?? "");
      setErrorMessage(null);
      setSubmitting(false);
    }
  }, [open, initialReason]);

  const trimmedReason = reason.trim();
  const reasonEmpty = trimmedReason.length === 0;
  const reasonTooLong = reason.length > FLAG_REASON_MAX_LENGTH;
  const canConfirm = !reasonEmpty && !reasonTooLong && !submitting;

  async function handleConfirm(): Promise<void> {
    if (!canConfirm) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirm(trimmedReason);
      // Parent owns post-success behavior (close dialog + reactive UI
      // re-render via the contract query subscription). We deliberately
      // do NOT call onClose here — letting the parent drive the close
      // keeps the dialog visible long enough for the operator to see
      // the brief inline confirmation before unmounting.
    } catch (err: unknown) {
      setSubmitting(false);
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to flag contract. Please try again.",
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
      <DialogContent data-testid="flag-contract-dialog">
        <DialogHeader>
          <DialogTitle>Flag for follow-up</DialogTitle>
          <DialogDescription>
            Routes {contractNumber} to the office-staff dashboard with a
            short comment. Staff will see it on their dashboard within a
            second.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label
            htmlFor={reasonInputId}
            className="text-sm font-medium text-text-default"
          >
            Why are you flagging this contract?
          </label>
          <textarea
            id={reasonInputId}
            data-testid="flag-contract-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={3}
            maxLength={FLAG_REASON_MAX_LENGTH}
            aria-describedby={counterId}
            placeholder="e.g. Customer called about installment 5 — confirm date"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div
            id={counterId}
            data-testid="flag-contract-reason-counter"
            aria-live="polite"
            className="flex items-center justify-end text-xs text-slate-500"
          >
            <span>
              {reason.length} / {FLAG_REASON_MAX_LENGTH}
            </span>
          </div>
        </div>

        {errorMessage !== null && (
          <p
            data-testid="flag-contract-error"
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
          >
            {errorMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            data-testid="flag-contract-cancel"
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
            data-testid="flag-contract-confirm"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={!canConfirm}
            className="min-h-[44px] rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Flagging…" : "Flag for follow-up"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
