"use client";

/**
 * PaymentForm — Story 3.9 (FR26, Journey 2).
 *
 * Office-staff entry point for recording a mid-stream installment
 * payment. The flow is the cemetery's most-frequent daily action
 * (~50 / day at peak per the brief); friction here drains directly
 * into "the staff goes back to paper." Journey 2 calls for under 90
 * seconds from "Record Payment" to receipt printed.
 *
 * Composition:
 *   - Amount input (autofocused, peso-prefixed, tabular numerics).
 *   - Method select (Cash / Cheque / Bank transfer; Cash default).
 *   - Date input (defaults to today; admin role can backdate but the
 *     UI surface is the same — server enforces clock-skew tolerance).
 *   - Reference input (always visible; emphasised as required for
 *     non-cash via aria-required + the label decoration).
 *   - Live `AllocationPreview` that updates on every amount change
 *     (no debounce — pure integer math).
 *   - Submit ("Review receipt") opens `ReceiptPreviewModal`. The
 *     modal IS the confirmation; the operator clicks "Generate &
 *     Print" inside the modal to commit.
 *
 * Mutation routing:
 *   - `recordPaymentWithAutoAllocation` is the single Convex call
 *     site. It routes through `postFinancialEvent` server-side — this
 *     component does no raw financial-table writes.
 *   - Idempotency key is generated once per form mount via
 *     `useIdempotencyKey`. A retried submit (network blip) reuses the
 *     same key so the cornerstone dedupes.
 *
 * Auth & defense in depth:
 *   - The (staff) layout's auth gate (Story 1.1 + 1.2) protects the
 *     route. Per-role enforcement (`office_staff` / `admin`) lives
 *     inside the mutation; the UI gate is informational only.
 *
 * Error handling (AC6):
 *   - `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` → inline error,
 *     form state preserved.
 *   - `INVARIANT_VIOLATION` with `overpay: true` → inline overpay
 *     message; the AllocationPreview also shows the warning before
 *     submit, so this branch is the race-condition catch.
 *   - All other ConvexErrors → `translateError(err).detail` inline.
 *
 * Print + navigation (AC4):
 *   - On success the modal closes, `window.print()` opens the browser
 *     print dialog (Story 3.11 / 3.13 will swap to an iframe-targeted
 *     PDF print), and `router.replace` navigates back to the contract
 *     detail page. The reactive `useQuery(listContractPayments)` on
 *     that page surfaces the new payment row with a 600ms amber flash
 *     when Story 3.6's contract detail timeline ships.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { formatPeso, pesosToCents } from "@/lib/money";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";

import { AllocationPreview } from "./AllocationPreview";
import {
  ReceiptPreviewModal,
  type ReceiptPreviewData,
} from "./ReceiptPreviewModal";
import {
  composePaidAtDateMs,
  paymentFormSchema,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  todayLocalDate,
  type PaymentFormMethod,
  type PaymentFormValues,
} from "./paymentFormSchema";
import {
  previewAllocation,
  validateCustomAllocation,
  type CustomAllocationRow,
} from "./allocation";

interface ContractDetail {
  contractId: string;
  contractNumber: string;
  lotId: string;
  lotCode: string;
  customerId: string;
  customerFullName: string;
  kind: "full_payment" | "installment";
  totalPriceCents: number;
  state:
    | "active"
    | "paid_in_full"
    | "cancelled"
    | "voided"
    | "in_default";
  createdAt: number;
}

interface InstallmentRow {
  installmentId: string;
  contractId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: "pending" | "paid" | "overdue" | "waived";
  paidAt?: number;
}

type RecordPaymentArgs = {
  contractId: string;
  amountCents: number;
  paymentMethod: PaymentFormMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
};

type RecordPaymentResult = {
  paymentId: string;
  receiptId: string;
  receiptNumber: string;
  contractClosed: boolean;
  allocations: Array<{
    installmentId: string;
    installmentNumber: number;
    amountAppliedCents: number;
    installmentMarkedPaid: boolean;
  }>;
};

// Story 3.10 — custom allocation mutation args bundle. The
// `allocations` array is the caller's per-installment plan; rows with
// `amountCents === 0` are dropped server-side, but we send them anyway
// so the cornerstone sees the staff's full intent (and the audit-log
// view of the override surfaces every visible installment).
type RecordPaymentWithCustomAllocationArgs = RecordPaymentArgs & {
  allocations: Array<{ installmentId: string; amountCents: number }>;
};

const getContractRef = makeFunctionReference<
  "query",
  { contractId: string },
  ContractDetail
>("contracts:getContract");

const listInstallmentsRef = makeFunctionReference<
  "query",
  { contractId: string },
  InstallmentRow[]
>("installments:listContractInstallments");

const recordPaymentRef = makeFunctionReference<
  "mutation",
  RecordPaymentArgs,
  RecordPaymentResult
>("payments:recordPaymentWithAutoAllocation");

// Story 3.10 — distinct mutation reference for the custom-allocation
// path. Keeping it separate from the auto mutation makes the two call
// sites mechanically distinguishable on the network panel + in the
// audit log; the form picks one based on the "Custom allocation"
// toggle.
const recordPaymentCustomRef = makeFunctionReference<
  "mutation",
  RecordPaymentWithCustomAllocationArgs,
  RecordPaymentResult
>("payments:recordPaymentWithCustomAllocation");

export interface PaymentFormProps {
  /** Convex `Id<"contracts">` as a string — the parent of this payment. */
  contractId: string;
}

export function PaymentForm({ contractId }: PaymentFormProps) {
  const router = useRouter();
  const idempotencyKey = useIdempotencyKey();
  const recordPayment = useMutation(recordPaymentRef);
  const recordPaymentCustom = useMutation(recordPaymentCustomRef);

  const contract = useQuery(getContractRef, { contractId });
  const installments = useQuery(listInstallmentsRef, { contractId });

  const [previewOpen, setPreviewOpen] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Story 3.10 — "Custom allocation" mode + per-row amounts state.
  //
  // `customMode` is the toggle: when ON, the form replaces the
  // read-only AllocationPreview with editable per-row amount inputs and
  // gates submit on `sum(customAllocations) === amountCents`. The
  // per-row amounts are stored as strings (so the staff can type freely
  // and we coerce to cents only at validation / submit time).
  //
  // The toggle is hidden until both the contract + installments query
  // resolve AND there is at least one unpaid installment to override
  // against (an all-paid contract should have already closed).
  const [customMode, setCustomMode] = useState(false);
  // Map of installmentId -> raw input string. Empty / missing key is
  // treated as `0`. Stored as strings to preserve the staff's typing
  // (so "" doesn't snap to "0").
  const [customAmounts, setCustomAmounts] = useState<
    Record<string, string>
  >({});

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isValid },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    mode: "onChange",
    defaultValues: {
      amountInput: "",
      paymentMethod: "cash",
      reference: "",
      paidAtDate: todayLocalDate(),
    },
  });

  const watchedAmount = watch("amountInput");
  const watchedMethod = watch("paymentMethod");
  const watchedReference = watch("reference");
  const watchedDate = watch("paidAtDate");

  // Live amount in centavos — used by the allocation preview AND by
  // the receipt-preview modal's "Total received" line. Pure integer
  // math via the shared `pesosToCents` helper.
  const amountCents = useMemo(() => {
    if (!watchedAmount || watchedAmount.trim().length === 0) return 0;
    const cents = pesosToCents(watchedAmount);
    return Number.isFinite(cents) && cents > 0 ? cents : 0;
  }, [watchedAmount]);

  const allocationInstallments = useMemo(() => {
    if (installments === undefined) return [];
    return installments.map((row) => ({
      installmentId: row.installmentId,
      installmentNumber: row.installmentNumber,
      dueDate: row.dueDate,
      principalCents: row.principalCents,
      paidCents: row.paidCents,
      status: row.status,
    }));
  }, [installments]);

  const allocationPreview = useMemo(
    () => previewAllocation(allocationInstallments, amountCents),
    [allocationInstallments, amountCents],
  );

  // Story 3.10 — list of installments the staff can override against
  // (i.e. pending or overdue, with a positive outstanding balance).
  // Used to render the editable rows; the toggle is hidden when this
  // is empty.
  const overridableInstallments = useMemo(
    () =>
      allocationInstallments.filter(
        (row) =>
          row.status !== "paid" &&
          row.status !== "waived" &&
          row.principalCents - row.paidCents > 0,
      ),
    [allocationInstallments],
  );

  // Story 3.10 — coerce the raw input strings into integer-centavo
  // rows. Empty / non-numeric inputs become 0. We always emit one row
  // per overridable installment so the validator gets the full picture
  // (a row with 0 cents is fine pre-submit; it gets dropped server-
  // side).
  const customAllocationRows = useMemo<CustomAllocationRow[]>(() => {
    return overridableInstallments.map((row) => {
      const raw = customAmounts[row.installmentId] ?? "";
      let cents = 0;
      if (raw.trim().length > 0) {
        const parsed = pesosToCents(raw);
        if (Number.isFinite(parsed) && parsed >= 0) {
          cents = parsed;
        } else {
          // A non-coercible input becomes a sentinel that fails
          // validation (forces the staff to fix it).
          cents = Number.NaN;
        }
      }
      return { installmentId: row.installmentId, amountCents: cents };
    });
  }, [overridableInstallments, customAmounts]);

  const customValidation = useMemo(
    () =>
      validateCustomAllocation(
        allocationInstallments,
        customAllocationRows,
        amountCents,
      ),
    [allocationInstallments, customAllocationRows, amountCents],
  );

  // Story 3.10 — non-zero rows ready for the mutation. Used both for
  // the receipt preview's "applied to:" lines AND for the mutation
  // call. The server re-validates and drops zero rows itself; we
  // pre-drop here so the network payload is the staff's actual intent.
  const submittableCustomRows = useMemo(
    () =>
      customAllocationRows.filter(
        (row) =>
          Number.isFinite(row.amountCents) && row.amountCents > 0,
      ),
    [customAllocationRows],
  );

  // Receipt-preview data — null until contract + installments load
  // and the form is valid + the amount applies cleanly. Story 3.10
  // extends this for the custom-allocation path: when `customMode` is
  // ON, the preview's "applied to:" lines come from the staff's
  // per-row amounts (post-validation) instead of the FIFO default.
  const previewData = useMemo<ReceiptPreviewData | null>(() => {
    if (contract === undefined || contract === null) return null;
    if (installments === undefined) return null;
    if (amountCents <= 0) return null;
    const paidAtMs = composePaidAtDateMs(watchedDate);
    if (paidAtMs === null) return null;
    const trimmedRef = (watchedReference ?? "").trim();
    const reference =
      watchedMethod === "cash"
        ? undefined
        : trimmedRef.length > 0
          ? trimmedRef
          : undefined;

    if (customMode) {
      // Custom-allocation preview path. Gate on the validator — if any
      // row is invalid or the sum doesn't match, no preview.
      if (!customValidation.ok) return null;
      if (submittableCustomRows.length === 0) return null;
      // Build the "applied to:" lines from the submittable rows.
      const linesByInstallmentNumber = new Map<
        number,
        { amountAppliedCents: number; willMarkPaid: boolean }
      >();
      for (const row of submittableCustomRows) {
        const installment = allocationInstallments.find(
          (i) => i.installmentId === row.installmentId,
        );
        if (installment === undefined) continue;
        const newPaidCents = installment.paidCents + row.amountCents;
        linesByInstallmentNumber.set(installment.installmentNumber, {
          amountAppliedCents: row.amountCents,
          willMarkPaid: newPaidCents === installment.principalCents,
        });
      }
      const allocationLines = Array.from(
        linesByInstallmentNumber.entries(),
      )
        .sort(([a], [b]) => a - b)
        .map(([installmentNumber, payload]) => ({
          installmentNumber,
          amountAppliedCents: payload.amountAppliedCents,
          willMarkPaid: payload.willMarkPaid,
        }));
      return {
        contractNumber: contract.contractNumber,
        customerFullName: contract.customerFullName,
        lotCode: contract.lotCode,
        amountCents,
        method: watchedMethod,
        reference,
        paidAtMs,
        allocationLines,
      };
    }

    // Auto-allocation preview path (unchanged from Story 3.9).
    if (allocationPreview.wouldOverpay) return null;
    if (allocationPreview.totalAppliedCents !== amountCents) return null;
    return {
      contractNumber: contract.contractNumber,
      customerFullName: contract.customerFullName,
      lotCode: contract.lotCode,
      amountCents,
      method: watchedMethod,
      reference,
      paidAtMs,
      allocationLines: allocationPreview.entries
        .filter((entry) => entry.amountAppliedCents > 0)
        .map((entry) => ({
          installmentNumber: entry.installmentNumber,
          amountAppliedCents: entry.amountAppliedCents,
          willMarkPaid: entry.willMarkPaid,
        })),
    };
  }, [
    contract,
    installments,
    amountCents,
    allocationPreview,
    customMode,
    customValidation.ok,
    submittableCustomRows,
    allocationInstallments,
    watchedDate,
    watchedMethod,
    watchedReference,
  ]);

  // Defensive: if the contract is not an active installment contract,
  // the user shouldn't have landed here. Surface an inline notice
  // rather than letting them submit and hit a server-side
  // INVARIANT_VIOLATION.
  const contractBlock = useMemo<string | null>(() => {
    if (contract === undefined || contract === null) return null;
    if (contract.kind !== "installment") {
      return "Mid-stream payments only apply to installment contracts.";
    }
    if (contract.state !== "active") {
      return `Contract is not active (current state: ${contract.state}).`;
    }
    return null;
  }, [contract]);

  // Title side-effect — keeps the tab label informative for an
  // operator with multiple windows open.
  useEffect(() => {
    if (contract !== undefined && contract !== null) {
      document.title = `Record payment · ${contract.contractNumber}`;
    } else {
      document.title = "Record payment";
    }
  }, [contract]);

  function handleValidSubmit(_values: PaymentFormValues): void {
    if (previewData === null) return;
    setCommitError(null);
    setPreviewOpen(true);
  }

  async function handleCommit(): Promise<void> {
    if (previewData === null) return;
    setIsCommitting(true);
    setCommitError(null);
    try {
      const baseArgs: RecordPaymentArgs = {
        contractId,
        amountCents: previewData.amountCents,
        paymentMethod: previewData.method,
        paidAt: previewData.paidAtMs,
        idempotencyKey,
      };
      if (previewData.reference !== undefined) {
        baseArgs.reference = previewData.reference;
      }
      if (customMode) {
        // Story 3.10 — dispatch to the custom-allocation mutation
        // with the staff's per-row distribution. Only non-zero rows
        // are sent; the server re-validates sum + per-row ceiling.
        await recordPaymentCustom({
          ...baseArgs,
          allocations: submittableCustomRows.map((row) => ({
            installmentId: row.installmentId,
            amountCents: row.amountCents,
          })),
        });
      } else {
        await recordPayment(baseArgs);
      }
      setPreviewOpen(false);
      // Open the browser's print dialog as a smoke test of the flow.
      // Story 3.11 / 3.13 will replace with an iframe-targeted PDF
      // print once the PDF action lands.
      if (typeof window !== "undefined") {
        try {
          window.print();
        } catch {
          // Some test environments (jsdom) throw; the navigation
          // below is the important post-commit action.
        }
      }
      router.replace(`/contracts/${contractId}`);
    } catch (err) {
      const translated = translateError(err);
      const overpayDetail = extractOverpayDetail(err);
      if (overpayDetail !== null) {
        setCommitError(
          `Amount exceeds the contract's outstanding balance by ${formatPeso(overpayDetail)}. Reduce the amount and try again.`,
        );
      } else {
        setCommitError(translated.detail);
      }
    } finally {
      setIsCommitting(false);
    }
  }

  if (contract === undefined || installments === undefined) {
    return (
      <div
        data-testid="payment-form-loading"
        className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
      >
        Loading contract…
      </div>
    );
  }

  if (contract === null) {
    return (
      <div
        role="alert"
        data-testid="payment-form-missing"
        className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
      >
        Contract not found. It may have been cancelled.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div
        className="rounded-md border border-slate-200 bg-white p-4 text-sm"
        data-testid="payment-form-contract-summary"
      >
        <p className="text-xs uppercase tracking-wide text-slate-500">
          Contract
        </p>
        <p className="mt-1 text-base font-semibold text-slate-900">
          {contract.contractNumber}
        </p>
        <p className="text-xs text-slate-500">
          Lot {contract.lotCode} · {contract.customerFullName}
        </p>
      </div>

      {contractBlock !== null && (
        <div
          role="alert"
          data-testid="payment-form-blocked"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {contractBlock}
        </div>
      )}

      {contractBlock === null && (
        <form
          onSubmit={handleSubmit(handleValidSubmit)}
          className="space-y-6"
          noValidate
          aria-label="Record a payment"
          data-testid="payment-form"
        >
          <div className="space-y-1">
            <label
              htmlFor="payment-amount"
              className="block text-sm font-medium text-slate-700"
            >
              Amount (PHP)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                ₱
              </span>
              <input
                id="payment-amount"
                type="text"
                inputMode="decimal"
                autoFocus
                aria-required="true"
                aria-invalid={errors.amountInput !== undefined}
                data-testid="payment-amount-input"
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  errors.amountInput !== undefined && "border-red-400",
                )}
                {...register("amountInput")}
              />
            </div>
            {errors.amountInput !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.amountInput.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor="payment-method"
                className="block text-sm font-medium text-slate-700"
              >
                Payment method
              </label>
              <select
                id="payment-method"
                data-testid="payment-method"
                aria-required="true"
                {...register("paymentMethod")}
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                )}
              >
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="payment-date"
                className="block text-sm font-medium text-slate-700"
              >
                Date
              </label>
              <input
                id="payment-date"
                type="date"
                aria-required="true"
                aria-invalid={errors.paidAtDate !== undefined}
                data-testid="payment-date"
                {...register("paidAtDate")}
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  errors.paidAtDate !== undefined && "border-red-400",
                )}
              />
              {errors.paidAtDate !== undefined && (
                <p className="text-xs text-red-600" role="alert">
                  {errors.paidAtDate.message}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="payment-reference"
              className={cn(
                "block text-sm font-medium",
                watchedMethod === "cash"
                  ? "text-slate-400"
                  : "text-slate-700",
              )}
            >
              Reference{" "}
              {watchedMethod !== "cash" && (
                <span className="text-red-600">*</span>
              )}
            </label>
            <input
              id="payment-reference"
              type="text"
              disabled={watchedMethod === "cash"}
              placeholder={
                watchedMethod === "cash"
                  ? "Not required for cash"
                  : "Cheque / bank transfer number"
              }
              aria-invalid={errors.reference !== undefined}
              data-testid="payment-reference"
              {...register("reference")}
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400",
                errors.reference !== undefined && "border-red-400",
              )}
            />
            {errors.reference !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.reference.message}
              </p>
            )}
          </div>

          {!customMode && (
            <AllocationPreview
              installments={allocationInstallments}
              amountCents={amountCents}
            />
          )}

          {customMode && (
            <section
              aria-label="Custom allocation"
              data-testid="custom-allocation-editor"
              className="rounded-md border border-slate-200 bg-white p-4"
            >
              <h2 className="text-sm font-semibold text-slate-800">
                Custom allocation
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Manually distribute the payment across unpaid
                installments. The total must match the payment amount.
              </p>
              {overridableInstallments.length === 0 ? (
                <p
                  className="mt-3 text-xs text-slate-500"
                  data-testid="custom-allocation-empty"
                >
                  No unpaid installments to allocate against.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {overridableInstallments.map((row) => {
                    const outstanding =
                      row.principalCents - row.paidCents;
                    const rowErrorCode =
                      customValidation.rowErrors[row.installmentId];
                    return (
                      <li
                        key={row.installmentId}
                        className="py-2"
                        data-testid={`custom-allocation-row-${row.installmentNumber}`}
                      >
                        <div className="flex items-center justify-between gap-3 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              Installment #{row.installmentNumber}
                            </span>
                            <span className="text-slate-500 tabular-nums">
                              Outstanding {formatPeso(outstanding)}
                            </span>
                          </div>
                          <div className="relative">
                            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">
                              ₱
                            </span>
                            <input
                              type="text"
                              inputMode="decimal"
                              aria-label={`Allocate to installment ${row.installmentNumber}`}
                              data-testid={`custom-allocation-input-${row.installmentNumber}`}
                              className={cn(
                                "block w-32 rounded-md border border-slate-300 pl-5 pr-2 py-1 text-xs tabular-nums",
                                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                                rowErrorCode !== undefined && "border-red-400",
                              )}
                              value={
                                customAmounts[row.installmentId] ?? ""
                              }
                              onChange={(e) =>
                                setCustomAmounts((prev) => ({
                                  ...prev,
                                  [row.installmentId]: e.target.value,
                                }))
                              }
                            />
                          </div>
                        </div>
                        {rowErrorCode === "exceeds_outstanding" && (
                          <p
                            className="mt-1 text-right text-[10px] text-red-600"
                            role="alert"
                            data-testid={`custom-allocation-row-error-${row.installmentNumber}`}
                          >
                            Exceeds outstanding balance.
                          </p>
                        )}
                        {rowErrorCode === "not_integer" && (
                          <p
                            className="mt-1 text-right text-[10px] text-red-600"
                            role="alert"
                            data-testid={`custom-allocation-row-error-${row.installmentNumber}`}
                          >
                            Enter a valid amount.
                          </p>
                        )}
                        {rowErrorCode === "negative" && (
                          <p
                            className="mt-1 text-right text-[10px] text-red-600"
                            role="alert"
                            data-testid={`custom-allocation-row-error-${row.installmentNumber}`}
                          >
                            Amount cannot be negative.
                          </p>
                        )}
                        {rowErrorCode === "not_payable" && (
                          <p
                            className="mt-1 text-right text-[10px] text-red-600"
                            role="alert"
                            data-testid={`custom-allocation-row-error-${row.installmentNumber}`}
                          >
                            Installment is not payable.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-xs">
                <dt className="text-slate-500">Allocated</dt>
                <dd
                  className={cn(
                    "text-right tabular-nums font-medium",
                    customValidation.remainderCents === 0 &&
                      amountCents > 0
                      ? "text-emerald-700"
                      : "text-red-600",
                  )}
                  data-testid="custom-allocation-total"
                >
                  {formatPeso(customValidation.totalAllocatedCents)}
                </dd>
                <dt className="text-slate-500">Of payment amount</dt>
                <dd
                  className="text-right tabular-nums font-medium"
                  data-testid="custom-allocation-target"
                >
                  {formatPeso(amountCents)}
                </dd>
              </dl>
              {customValidation.remainderCents !== 0 &&
                amountCents > 0 && (
                  <p
                    role="alert"
                    data-testid="custom-allocation-sum-mismatch"
                    className="mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-900"
                  >
                    {customValidation.remainderCents > 0
                      ? `Allocate the remaining ${formatPeso(customValidation.remainderCents)} or reduce the payment amount.`
                      : `Reduce allocations by ${formatPeso(-customValidation.remainderCents)} — total exceeds the payment amount.`}
                  </p>
                )}
            </section>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            {overridableInstallments.length > 0 && (
              <button
                type="button"
                data-testid="payment-form-toggle-custom"
                onClick={() => {
                  setCustomMode((prev) => {
                    const next = !prev;
                    if (next) {
                      // Seed the per-row inputs from the FIFO default
                      // so the staff redistributes from there. Skip
                      // rows that wouldn't be touched by the default
                      // (their input stays empty).
                      const seed: Record<string, string> = {};
                      for (const entry of allocationPreview.entries) {
                        if (entry.amountAppliedCents > 0) {
                          // Convert centavos back to peso input string
                          // (e.g. 4_000_00 -> "4000.00").
                          seed[entry.installmentId] = (
                            entry.amountAppliedCents / 100
                          ).toFixed(2);
                        }
                      }
                      setCustomAmounts(seed);
                    }
                    return next;
                  });
                }}
                className={cn(
                  "min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700",
                  "hover:bg-slate-50",
                  customMode && "border-slate-900 bg-slate-100",
                )}
                aria-pressed={customMode}
              >
                {customMode
                  ? "Use default allocation"
                  : "Custom allocation"}
              </button>
            )}
            <button
              type="submit"
              disabled={!isValid || previewData === null}
              data-testid="payment-form-submit"
              className={cn(
                "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
                "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              Review receipt
            </button>
          </div>
        </form>
      )}

      <ReceiptPreviewModal
        open={previewOpen}
        onClose={() => {
          if (!isCommitting) {
            setPreviewOpen(false);
            setCommitError(null);
          }
        }}
        onCommit={handleCommit}
        isSubmitting={isCommitting}
        errorMessage={commitError}
        data={previewData}
      />
    </div>
  );
}

/**
 * Pulls the `overpay: true` detail out of a `ConvexError`'s `data`
 * bag, returning the `excessCents` field. Returns null when the error
 * is not the overpay variant. This is the AC6 explicit recovery path
 * for the overpay race condition (the AllocationPreview catches the
 * common case pre-submit).
 */
function extractOverpayDetail(err: unknown): number | null {
  if (err === null || typeof err !== "object") return null;
  const maybe = err as { data?: unknown };
  if (typeof maybe.data !== "object" || maybe.data === null) return null;
  const data = maybe.data as {
    code?: unknown;
    details?: unknown;
  };
  if (data.code !== "INVARIANT_VIOLATION") return null;
  if (typeof data.details !== "object" || data.details === null) return null;
  const details = data.details as Record<string, unknown>;
  if (details.overpay !== true) return null;
  if (typeof details.excessCents !== "number") return null;
  return details.excessCents;
}
