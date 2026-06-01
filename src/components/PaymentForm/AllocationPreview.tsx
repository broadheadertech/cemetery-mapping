"use client";

/**
 * AllocationPreview — Story 3.9 (FR26).
 *
 * Live, reactive table that shows where the candidate payment amount
 * would land if applied via the system's default oldest-unpaid-first
 * rule. Drives the magic moment of Journey 2: the operator types
 * "4000", the table updates instantly, the operator sees installment
 * #3 will close, the operator hits "Review receipt."
 *
 * The component is pure presentation — it calls `previewAllocation`
 * from `./allocation.ts` on every render with the current installments
 * + amount and renders the result. No debounce: the math is integer
 * arithmetic on at most 60 rows; instant feedback is the point.
 */

import { formatPeso } from "@/lib/money";
import { formatDate } from "@/lib/time";

import {
  previewAllocation,
  type AllocationInstallmentInput,
  type AllocationPreviewResult,
} from "./allocation";

export interface AllocationPreviewProps {
  installments: ReadonlyArray<AllocationInstallmentInput>;
  amountCents: number;
}

const STATUS_LABEL: Record<
  AllocationInstallmentInput["status"],
  string
> = {
  pending: "Due",
  paid: "Paid",
  overdue: "Overdue",
  waived: "Waived",
};

const STATUS_CLASS: Record<
  AllocationInstallmentInput["status"],
  string
> = {
  pending: "bg-slate-100 text-slate-700 border-slate-200",
  paid: "bg-emerald-50 text-emerald-800 border-emerald-200",
  overdue: "bg-amber-50 text-amber-900 border-amber-200",
  waived: "bg-slate-50 text-slate-500 border-slate-200",
};

export function AllocationPreview({
  installments,
  amountCents,
}: AllocationPreviewProps) {
  const preview: AllocationPreviewResult = previewAllocation(
    installments,
    amountCents,
  );

  return (
    <section
      aria-label="Allocation preview"
      data-testid="allocation-preview"
      className="rounded-md border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-800">
        Allocation preview
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Applied oldest unpaid first. Manual override ships in Story 3.10.
      </p>

      {preview.entries.length === 0 ? (
        <p
          className="mt-3 text-xs text-slate-500"
          data-testid="allocation-preview-empty"
        >
          This contract has no installments to allocate against.
        </p>
      ) : (
        <ul
          className="mt-3 divide-y divide-slate-100"
          data-testid="allocation-preview-list"
        >
          {preview.entries.map((entry) => {
            const isTouched = entry.amountAppliedCents > 0;
            return (
              <li
                key={entry.installmentId}
                data-testid={`allocation-preview-row-${entry.installmentNumber}`}
                className={
                  isTouched
                    ? "py-2"
                    : "py-2 text-slate-400"
                }
              >
                <div className="flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_CLASS[entry.status]}`}
                    >
                      {STATUS_LABEL[entry.status]}
                    </span>
                    <span className="font-medium">
                      Installment #{entry.installmentNumber}
                    </span>
                    <span className="text-slate-500">
                      due {formatDate(entry.dueDate, "short")}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 tabular-nums">
                    <span
                      className="text-slate-500"
                      data-testid={`allocation-preview-balance-${entry.installmentNumber}`}
                    >
                      Balance {formatPeso(entry.balanceBeforeCents)}
                    </span>
                    {isTouched && (
                      <span
                        className="font-medium text-emerald-700"
                        data-testid={`allocation-preview-applied-${entry.installmentNumber}`}
                      >
                        → Apply {formatPeso(entry.amountAppliedCents)}
                        {entry.willMarkPaid && " · marks paid"}
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-xs">
        <dt className="text-slate-500">Total applied</dt>
        <dd
          className="text-right tabular-nums font-medium"
          data-testid="allocation-preview-total"
        >
          {formatPeso(preview.totalAppliedCents)}
        </dd>
        {preview.wouldOverpay && (
          <>
            <dt className="text-amber-700">Overpayment</dt>
            <dd
              className="text-right tabular-nums font-medium text-amber-700"
              data-testid="allocation-preview-overpay"
            >
              {formatPeso(preview.remainingCents)}
            </dd>
          </>
        )}
      </dl>

      {preview.wouldOverpay && (
        <p
          role="alert"
          data-testid="allocation-preview-overpay-warning"
          className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          The amount exceeds the outstanding balance. Reduce the amount
          before continuing.
        </p>
      )}
    </section>
  );
}
