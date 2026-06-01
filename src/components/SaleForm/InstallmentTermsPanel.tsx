"use client";

/**
 * InstallmentTermsPanel — Story 3.4 (FR20 / FR21).
 *
 * Replaces Story 3.3's stub "Installment flow ships in the next
 * iteration" placeholder. The panel renders the full installment-sale
 * surface:
 *
 *   - LotPicker + CustomerPicker (shared with Story 3.3's Full Payment
 *     tab; same prop contract).
 *   - Contract terms: total price (auto-filled from the selected lot's
 *     basePriceCents; admin-editable per Story 3.5), down payment,
 *     term in months, monthly amount (auto-computed but editable for
 *     admin override), first due date.
 *   - Method / reference / sale date / time — shared with full-payment
 *     flow shape.
 *   - Live `InstallmentSchedule` preview below the terms inputs.
 *
 * The submit handler opens the ReceiptPreviewModal showing ONLY the
 * down payment (the receipt represents money received today; the full
 * schedule appears on the contract detail page once 3.6 lands).
 *
 * Auth + idempotency match Story 3.3's full-payment flow — the same
 * `useIdempotencyKey` hook backs the per-mount key.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { centsToPesos, formatPeso, pesosToCents } from "@/lib/money";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";

import {
  InstallmentSchedule,
  generateInstallmentSchedule,
} from "@/components/InstallmentSchedule";

import { CustomerPicker, type CustomerPickerOption } from "./CustomerPicker";
import { LotPicker, type LotPickerOption } from "./LotPicker";
import {
  ReceiptPreviewModal,
  type ReceiptPreviewData,
} from "./ReceiptPreviewModal";
import {
  SALE_METHODS,
  SALE_METHOD_LABEL,
  composeFirstDueDateMs,
  composePaidAtMs,
  currentLocalTime,
  installmentSaleFormSchema,
  todayLocalDate,
  type InstallmentSaleFormValues,
  type SaleMethod,
} from "./saleFormSchema";

type RecordInstallmentSaleArgs = {
  lotId: string;
  customerId: string;
  totalPriceCents: number;
  downPaymentCents: number;
  termMonths: number;
  monthlyAmountCents: number;
  firstDueDate: number;
  installments: Array<{
    installmentNumber: number;
    dueDate: number;
    principalCents: number;
  }>;
  method: SaleMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
  // Story 3.5 (FR22) — discount payload (only sent when applied).
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
};

type RecordInstallmentSaleResult = {
  contractId: string;
  contractNumber: string;
  installmentCount: number;
  paymentId: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
};

const recordInstallmentSaleRef = makeFunctionReference<
  "mutation",
  RecordInstallmentSaleArgs,
  RecordInstallmentSaleResult
>("contracts:recordInstallmentSale");

export interface InstallmentTermsPanelProps {
  /**
   * Caller's set of roles for the current user — drives the
   * admin-only price-edit gate. Server still enforces; UI gate is
   * defense in depth. Defaults to empty (treat as non-admin).
   */
  userRoles?: ReadonlyArray<string>;
}

function isoDateNDaysAhead(days: number): string {
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function InstallmentTermsPanel({
  userRoles = [],
}: InstallmentTermsPanelProps) {
  const router = useRouter();
  const idempotencyKey = useIdempotencyKey();
  const recordInstallmentSale = useMutation(recordInstallmentSaleRef);

  const [selectedLot, setSelectedLot] = useState<LotPickerOption | null>(null);
  const [selectedCustomer, setSelectedCustomer] =
    useState<CustomerPickerOption | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const isAdmin = userRoles.includes("admin");
  const priceEditable = isAdmin;

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isValid },
  } = useForm<InstallmentSaleFormValues>({
    resolver: zodResolver(installmentSaleFormSchema),
    mode: "onChange",
    defaultValues: {
      lotId: "",
      customerId: "",
      totalPriceInput: "",
      downPaymentInput: "0",
      termMonths: "12",
      monthlyAmountInput: "",
      firstDueDate: isoDateNDaysAhead(30),
      method: "cash",
      reference: "",
      paidAtDate: todayLocalDate(),
      paidAtTime: currentLocalTime(),
      // Story 3.5 (FR22) — empty discount = no discount applied.
      discountInput: "",
      discountReason: "",
    },
  });

  const watchedTotal = watch("totalPriceInput");
  const watchedDown = watch("downPaymentInput");
  const watchedTermMonths = watch("termMonths");
  const watchedMonthly = watch("monthlyAmountInput");
  const watchedFirstDue = watch("firstDueDate");
  const watchedMethod = watch("method");
  const watchedReference = watch("reference");
  const watchedPaidAtDate = watch("paidAtDate");
  const watchedPaidAtTime = watch("paidAtTime");
  // Story 3.5 (FR22) — discount inputs.
  const watchedDiscountInput = watch("discountInput") ?? "";
  const watchedDiscountReason = watch("discountReason") ?? "";

  // Derived cent values + first-due ms — null when unparseable.
  //
  // Story 3.5 (FR22): `watchedTotal` continues to bind to the LISTED
  // price (the lot's `basePriceCents`). The discounted total (what the
  // customer actually pays + what gets divided across the schedule)
  // is `baseCents − discountCents`. The schedule preview consumes the
  // discounted total so per-installment amounts reflect the promo.
  const baseCents = useMemo(
    () => pesosToCents(watchedTotal),
    [watchedTotal],
  );
  const discountCents = useMemo(() => {
    const trimmed = (watchedDiscountInput ?? "").trim();
    if (trimmed === "") return 0;
    const v = pesosToCents(trimmed);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [watchedDiscountInput]);
  const totalCents = useMemo(() => {
    if (!Number.isFinite(baseCents)) return baseCents;
    return Math.max(baseCents - discountCents, 0);
  }, [baseCents, discountCents]);
  const trimmedDiscountReason = (watchedDiscountReason ?? "").trim();
  const discountApplied =
    discountCents > 0 &&
    Number.isFinite(baseCents) &&
    baseCents > 0 &&
    discountCents <= baseCents;
  const downCents = useMemo(
    () => pesosToCents(watchedDown === "" ? "0" : watchedDown),
    [watchedDown],
  );
  const termMonthsNum = useMemo(() => {
    const n = Number.parseInt((watchedTermMonths ?? "").replace(/,/g, ""), 10);
    return Number.isInteger(n) ? n : 0;
  }, [watchedTermMonths]);
  const firstDueMs = useMemo(
    () => composeFirstDueDateMs(watchedFirstDue ?? ""),
    [watchedFirstDue],
  );
  const monthlyCents = useMemo(
    () => pesosToCents(watchedMonthly === "" ? "0" : watchedMonthly),
    [watchedMonthly],
  );

  // Auto-fill the monthly amount when the total / down / term change
  // and the user hasn't explicitly overridden it. We compare the
  // current monthly value against the next computed value; an
  // unparseable field counts as "follow the auto-fill" so the first
  // render lands on the right value without the user typing into it.
  useEffect(() => {
    if (
      !Number.isFinite(totalCents) ||
      !Number.isFinite(downCents) ||
      totalCents <= 0 ||
      downCents < 0 ||
      downCents >= totalCents ||
      termMonthsNum <= 0 ||
      termMonthsNum > 60
    ) {
      return;
    }
    const principal = totalCents - downCents;
    const quotient = Math.floor(principal / termMonthsNum);
    const autoFill = centsToPesos(quotient).toFixed(2);
    if (
      watchedMonthly === "" ||
      !Number.isFinite(monthlyCents) ||
      Math.abs(monthlyCents - quotient) > 0
    ) {
      setValue("monthlyAmountInput", autoFill, {
        shouldValidate: true,
        shouldDirty: false,
      });
    }
    // We intentionally exclude `monthlyCents` / `watchedMonthly` from
    // deps to avoid an infinite update loop — the effect mutates the
    // field; the next render would re-trigger. Listening to the inputs
    // that drive auto-fill is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCents, downCents, termMonthsNum, setValue]);

  function handleLotSelected(lot: LotPickerOption | null): void {
    setSelectedLot(lot);
    setConflictError(null);
    if (lot !== null) {
      setValue("lotId", lot.lotId, { shouldValidate: true });
      setValue(
        "totalPriceInput",
        centsToPesos(lot.basePriceCents).toFixed(2),
        { shouldValidate: true },
      );
    } else {
      setValue("lotId", "", { shouldValidate: true });
      setValue("totalPriceInput", "", { shouldValidate: true });
    }
  }

  function handleCustomerSelected(
    customer: CustomerPickerOption | null,
  ): void {
    setSelectedCustomer(customer);
    if (customer !== null) {
      setValue("customerId", customer.customerId, { shouldValidate: true });
    } else {
      setValue("customerId", "", { shouldValidate: true });
    }
  }

  // The receipt-preview modal shows only the down payment. When
  // downCents is 0, we still open the modal to confirm the contract;
  // the body renders "No down payment — receipt will be issued on the
  // first installment payment."
  const previewData = useMemo<ReceiptPreviewData | null>(() => {
    if (selectedLot === null || selectedCustomer === null) return null;
    const paidAtMs = composePaidAtMs(watchedPaidAtDate, watchedPaidAtTime);
    if (paidAtMs === null) return null;
    if (!Number.isFinite(downCents) || downCents < 0) return null;
    const trimmedRef = (watchedReference ?? "").trim();
    const reference =
      watchedMethod === "cash"
        ? undefined
        : trimmedRef.length > 0
          ? trimmedRef
          : undefined;
    return {
      lotCode: selectedLot.code,
      customerFullName: selectedCustomer.fullName,
      totalPriceCents: downCents,
      method: watchedMethod,
      reference,
      paidAtMs,
    };
  }, [
    selectedLot,
    selectedCustomer,
    downCents,
    watchedMethod,
    watchedReference,
    watchedPaidAtDate,
    watchedPaidAtTime,
  ]);

  function handleValidSubmit(_values: InstallmentSaleFormValues): void {
    setCommitError(null);
    setConflictError(null);
    setPreviewOpen(true);
  }

  async function handleCommit(): Promise<void> {
    if (
      previewData === null ||
      selectedLot === null ||
      selectedCustomer === null
    ) {
      return;
    }
    if (
      !Number.isFinite(totalCents) ||
      !Number.isFinite(downCents) ||
      termMonthsNum <= 0 ||
      firstDueMs === null ||
      !Number.isFinite(monthlyCents)
    ) {
      setCommitError("Form contains invalid values. Re-check the inputs.");
      return;
    }
    setIsCommitting(true);
    setCommitError(null);
    try {
      const schedule = generateInstallmentSchedule({
        totalPriceCents: totalCents,
        downPaymentCents: downCents,
        termMonths: termMonthsNum,
        firstDueDate: firstDueMs,
      });
      const installments = schedule.rows.map((row) => ({
        installmentNumber: row.installmentNumber,
        dueDate: row.dueDate,
        principalCents: row.principalCents,
      }));
      const args: RecordInstallmentSaleArgs = {
        lotId: selectedLot.lotId,
        customerId: selectedCustomer.customerId,
        totalPriceCents: totalCents,
        downPaymentCents: downCents,
        termMonths: termMonthsNum,
        monthlyAmountCents: schedule.monthlyAmountCents,
        firstDueDate: firstDueMs,
        installments,
        method: previewData.method,
        paidAt: previewData.paidAtMs,
        idempotencyKey,
      };
      if (previewData.reference !== undefined) {
        args.reference = previewData.reference;
      }
      // Story 3.5 (FR22) — attach discount payload. Server re-validates.
      if (discountApplied) {
        args.basePriceCents = baseCents;
        args.discountCents = discountCents;
        args.discountReason = trimmedDiscountReason;
      }
      const result = await recordInstallmentSale(args);
      setPreviewOpen(false);
      if (typeof window !== "undefined") {
        try {
          window.print();
        } catch {
          // jsdom etc — the navigation below is the important post-commit action.
        }
      }
      router.push(`/contracts/${result.contractId}`);
    } catch (err) {
      const translated = translateError(err);
      const code = extractCode(err);
      if (code === "ILLEGAL_STATE_TRANSITION") {
        setPreviewOpen(false);
        setConflictError(
          "This lot was just sold to someone else. Refresh to view current status.",
        );
      } else {
        setCommitError(translated.detail);
      }
    } finally {
      setIsCommitting(false);
    }
  }

  function refreshLotPicker(): void {
    setConflictError(null);
    setSelectedLot(null);
    setValue("lotId", "", { shouldValidate: true });
    setValue("totalPriceInput", "", { shouldValidate: true });
  }

  return (
    <>
      <form
        onSubmit={handleSubmit(handleValidSubmit)}
        className="space-y-6"
        noValidate
        aria-label="Record an installment sale"
        data-testid="installment-sale-form"
      >
        {conflictError !== null && (
          <div
            role="alert"
            data-testid="installment-sale-conflict"
            className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-medium">{conflictError}</p>
            <button
              type="button"
              onClick={refreshLotPicker}
              data-testid="installment-sale-refresh"
              className="mt-2 inline-flex min-h-[44px] items-center rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
            >
              Refresh
            </button>
          </div>
        )}

        <LotPicker
          value={selectedLot?.lotId ?? ""}
          onSelect={handleLotSelected}
        />
        <input type="hidden" {...register("lotId")} />
        {errors.lotId !== undefined && (
          <p className="text-xs text-red-600" role="alert">
            {errors.lotId.message}
          </p>
        )}

        <CustomerPicker
          value={selectedCustomer}
          onSelect={handleCustomerSelected}
        />
        <input type="hidden" {...register("customerId")} />
        {errors.customerId !== undefined && (
          <p className="text-xs text-red-600" role="alert">
            {errors.customerId.message}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label
              htmlFor="installment-total-price"
              className="block text-sm font-medium text-slate-700"
            >
              Total price (PHP)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                ₱
              </span>
              <input
                id="installment-total-price"
                type="text"
                inputMode="decimal"
                readOnly={!priceEditable}
                aria-readonly={!priceEditable}
                aria-required="true"
                aria-invalid={errors.totalPriceInput !== undefined}
                data-testid="installment-total-price"
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  !priceEditable && "bg-slate-50 text-slate-700",
                  errors.totalPriceInput !== undefined && "border-red-400",
                )}
                {...register("totalPriceInput")}
              />
            </div>
            {!priceEditable && (
              <p className="text-xs text-slate-500">
                Total comes from the lot&apos;s listed price. Admins may
                override; discount workflow lands in Story 3.5.
              </p>
            )}
            {selectedLot !== null && priceEditable && (
              <p className="text-xs text-slate-500">
                Listed price: {formatPeso(selectedLot.basePriceCents)}.
              </p>
            )}
            {errors.totalPriceInput !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.totalPriceInput.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label
              htmlFor="installment-down-payment"
              className="block text-sm font-medium text-slate-700"
            >
              Down payment (PHP)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                ₱
              </span>
              <input
                id="installment-down-payment"
                type="text"
                inputMode="decimal"
                aria-required="true"
                aria-invalid={errors.downPaymentInput !== undefined}
                data-testid="installment-down-payment"
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  errors.downPaymentInput !== undefined && "border-red-400",
                )}
                {...register("downPaymentInput")}
              />
            </div>
            {errors.downPaymentInput !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.downPaymentInput.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label
              htmlFor="installment-term-months"
              className="block text-sm font-medium text-slate-700"
            >
              Term (months)
            </label>
            <input
              id="installment-term-months"
              type="number"
              min={1}
              max={60}
              step={1}
              aria-required="true"
              aria-invalid={errors.termMonths !== undefined}
              data-testid="installment-term-months"
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                errors.termMonths !== undefined && "border-red-400",
              )}
              {...register("termMonths")}
            />
            {errors.termMonths !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.termMonths.message}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label
              htmlFor="installment-monthly-amount"
              className="block text-sm font-medium text-slate-700"
            >
              Monthly amount (PHP)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                ₱
              </span>
              <input
                id="installment-monthly-amount"
                type="text"
                inputMode="decimal"
                readOnly={!priceEditable}
                aria-readonly={!priceEditable}
                aria-required="true"
                aria-invalid={errors.monthlyAmountInput !== undefined}
                data-testid="installment-monthly-amount"
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  !priceEditable && "bg-slate-50 text-slate-700",
                  errors.monthlyAmountInput !== undefined && "border-red-400",
                )}
                {...register("monthlyAmountInput")}
              />
            </div>
            <p className="text-xs text-slate-500">
              Auto-computed from (total − down payment) / term. Remainder
              centavos land on the final installment.
            </p>
            {errors.monthlyAmountInput !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.monthlyAmountInput.message}
              </p>
            )}
          </div>

          <div className="space-y-1 sm:col-span-2">
            <label
              htmlFor="installment-first-due-date"
              className="block text-sm font-medium text-slate-700"
            >
              First due date
            </label>
            <input
              id="installment-first-due-date"
              type="date"
              aria-required="true"
              aria-invalid={errors.firstDueDate !== undefined}
              data-testid="installment-first-due-date"
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                errors.firstDueDate !== undefined && "border-red-400",
              )}
              {...register("firstDueDate")}
            />
            {errors.firstDueDate !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.firstDueDate.message}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label
              htmlFor="installment-method"
              className="block text-sm font-medium text-slate-700"
            >
              Payment method
            </label>
            <select
              id="installment-method"
              data-testid="installment-method"
              aria-required="true"
              {...register("method")}
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              )}
            >
              {SALE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {SALE_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="installment-reference"
              className={cn(
                "block text-sm font-medium",
                watchedMethod === "cash" || downCents === 0
                  ? "text-slate-400"
                  : "text-slate-700",
              )}
            >
              Reference{" "}
              {watchedMethod !== "cash" && downCents > 0 && (
                <span className="text-red-600">*</span>
              )}
            </label>
            <input
              id="installment-reference"
              type="text"
              disabled={watchedMethod === "cash" || downCents === 0}
              placeholder={
                watchedMethod === "cash"
                  ? "Not required for cash"
                  : downCents === 0
                    ? "Not required when no down payment"
                    : "Cheque / bank transfer number"
              }
              aria-invalid={errors.reference !== undefined}
              data-testid="installment-reference"
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
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label
              htmlFor="installment-paid-at-date"
              className="block text-sm font-medium text-slate-700"
            >
              Sale date
            </label>
            <input
              id="installment-paid-at-date"
              type="date"
              aria-required="true"
              aria-invalid={errors.paidAtDate !== undefined}
              data-testid="installment-paid-at-date"
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
          <div className="space-y-1">
            <label
              htmlFor="installment-paid-at-time"
              className="block text-sm font-medium text-slate-700"
            >
              Sale time
            </label>
            <input
              id="installment-paid-at-time"
              type="time"
              aria-required="true"
              aria-invalid={errors.paidAtTime !== undefined}
              data-testid="installment-paid-at-time"
              {...register("paidAtTime")}
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                errors.paidAtTime !== undefined && "border-red-400",
              )}
            />
            {errors.paidAtTime !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.paidAtTime.message}
              </p>
            )}
          </div>
        </div>

        {/*
         * Story 3.5 (FR22) — discount panel. Inline (UX § 1294
         * "Inline > modal"). The discounted total flows through to
         * `InstallmentSchedule` below: per-installment amounts are
         * computed on `(baseCents − discountCents − downCents) /
         * termMonths`. The server re-validates every invariant in
         * `convex/contracts.ts:normalizeDiscountInputs`.
         */}
        <div
          className="space-y-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
          data-testid="installment-discount-panel"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">
              Discount (optional)
            </h3>
            <span className="text-xs text-slate-500">
              Family loyalty, manager override, promo, etc.
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor="installment-discount-amount"
                className="block text-xs font-medium text-slate-700"
              >
                Discount amount (PHP)
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                  ₱
                </span>
                <input
                  id="installment-discount-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-invalid={errors.discountInput !== undefined}
                  data-testid="installment-discount-amount"
                  {...register("discountInput")}
                  className={cn(
                    "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums bg-white",
                    "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                    errors.discountInput !== undefined && "border-red-400",
                  )}
                />
              </div>
              {errors.discountInput !== undefined && (
                <p className="text-xs text-red-600" role="alert">
                  {errors.discountInput.message}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label
                htmlFor="installment-discount-reason"
                className={cn(
                  "block text-xs font-medium",
                  discountCents > 0 ? "text-slate-700" : "text-slate-500",
                )}
              >
                Reason{" "}
                {discountCents > 0 && (
                  <span className="text-red-600">*</span>
                )}
              </label>
              <input
                id="installment-discount-reason"
                type="text"
                maxLength={280}
                placeholder="Why is this discount applied?"
                aria-invalid={errors.discountReason !== undefined}
                data-testid="installment-discount-reason"
                {...register("discountReason")}
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm bg-white",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  errors.discountReason !== undefined && "border-red-400",
                )}
              />
              {errors.discountReason !== undefined && (
                <p className="text-xs text-red-600" role="alert">
                  {errors.discountReason.message}
                </p>
              )}
            </div>
          </div>
          {discountApplied && (
            <dl
              className="mt-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums"
              data-testid="installment-price-summary"
            >
              <div className="flex justify-between">
                <dt className="text-slate-600">Base price</dt>
                <dd
                  className="text-slate-900"
                  data-testid="installment-summary-base"
                >
                  {formatPeso(baseCents)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Discount</dt>
                <dd
                  className="text-rose-600"
                  data-testid="installment-summary-discount"
                >
                  −{formatPeso(discountCents)}
                </dd>
              </div>
              <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold">
                <dt className="text-slate-700">Total</dt>
                <dd
                  className="text-slate-900"
                  data-testid="installment-summary-total"
                >
                  {formatPeso(totalCents)}
                </dd>
              </div>
              {trimmedDiscountReason.length > 0 && (
                <p
                  className="mt-1 text-xs text-slate-500"
                  data-testid="installment-summary-reason"
                >
                  Reason: {trimmedDiscountReason}
                </p>
              )}
            </dl>
          )}
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-800">
            Schedule preview
          </h3>
          <InstallmentSchedule
            totalPriceCents={
              Number.isFinite(totalCents) ? totalCents : 0
            }
            downPaymentCents={
              Number.isFinite(downCents) ? downCents : 0
            }
            termMonths={termMonthsNum}
            firstDueDate={firstDueMs}
          />
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="submit"
            disabled={!isValid || previewData === null}
            data-testid="installment-sale-submit"
            className={cn(
              "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
              "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            Review receipt
          </button>
        </div>
      </form>

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
    </>
  );
}

function extractCode(err: unknown): string | null {
  if (err === null || err === undefined) return null;
  if (typeof err === "object") {
    const maybe = err as { data?: unknown };
    if (
      typeof maybe.data === "object" &&
      maybe.data !== null &&
      "code" in maybe.data
    ) {
      const code = (maybe.data as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}
