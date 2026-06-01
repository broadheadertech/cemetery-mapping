"use client";

/**
 * SaleForm — Story 3.3 (FR19).
 *
 * Office-staff entry point for recording a sale. This story implements
 * the Full Payment tab. Story 3.4 will extend the same shell with the
 * Installment tab.
 *
 * Composition:
 *   - Two top-level tabs: "Full Payment" (this story) and "Installment"
 *     (stubbed). The Full Payment tab orchestrates four substeps:
 *       1. LotPicker (sub-component, reusable in Story 3.4)
 *       2. CustomerPicker (sub-component, reusable in Story 3.4)
 *       3. Inline form: price (read-only for office_staff, editable
 *          for admin), method, reference (conditional), date / time.
 *       4. ReceiptPreviewModal — the deliberate pause + commit.
 *   - The form owns the `contracts.recordFullPaymentSale` mutation call
 *     directly. On success it navigates to `/contracts/[contractId]`.
 *   - Idempotency key is generated once per form mount via
 *     `useIdempotencyKey` (Story 1.14 hook). A successful commit
 *     re-mounts via the navigation; a failed commit keeps the same key
 *     so a retry deduplicates on the server.
 *
 * Auth & defense in depth:
 *   - The (staff) layout's auth gate (Story 1.1 + 1.2) protects this
 *     route at the layout boundary.
 *   - Per-role enforcement (`office_staff` / `admin`) lives inside
 *     `recordFullPaymentSale` itself. A field_worker who navigates here
 *     will see the form render but receive a FORBIDDEN translation on
 *     submit. That's the defense-in-depth pattern from Story 1.2.
 *   - Price field is `readOnly` for non-admin users; admins toggle it
 *     editable. UI-level only — the server doesn't actually enforce
 *     "must match the lot's basePrice" yet (Story 3.5 wires the
 *     discount workflow that makes price overrides a sanctioned path).
 *
 * Error handling:
 *   - `ILLEGAL_STATE_TRANSITION` → AC5: "This lot was just sold to
 *     someone else." with a Refresh button.
 *   - All other ConvexErrors → `translateError(err).detail` inline in
 *     the modal above the footer.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { centsToPesos, formatPeso, pesosToCents } from "@/lib/money";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";

import { CustomerPicker, type CustomerPickerOption } from "./CustomerPicker";
import { EstatePicker, type EstatePickerOption } from "./EstatePicker";
import { InstallmentTermsPanel } from "./InstallmentTermsPanel";
import { LotPicker, type LotPickerOption } from "./LotPicker";
import {
  ReceiptPreviewModal,
  type ReceiptPreviewData,
} from "./ReceiptPreviewModal";
import {
  SALE_METHODS,
  SALE_METHOD_LABEL,
  composePaidAtMs,
  currentLocalTime,
  saleFormSchema,
  todayLocalDate,
  type SaleFormValues,
  type SaleMethod,
} from "./saleFormSchema";

type RecordFullPaymentSaleArgs = {
  lotId: string;
  customerId: string;
  totalPriceCents: number;
  method: SaleMethod;
  reference?: string;
  paidAt: number;
  idempotencyKey: string;
  // Story 3.5 (FR22) — discount + rationale (only sent when applied).
  basePriceCents?: number;
  discountCents?: number;
  discountReason?: string;
  // Story 3.8 rebuild (FR25): perpetual-care fee is policy-derived
  // server-side. The form does NOT send the fee — `totalPriceCents`
  // here is the PRE-perpetual-care total (base − discount).
  // Story 2.9 (FR15) — estate-mode opt-in.
  familyEstateId?: string;
};

interface PreviewPerpetualCareResult {
  feeCents: number;
  billingType: "one_time" | "annual" | "none";
  isPlaceholder: boolean;
  policyType: "one_time" | "annual" | "none";
}

const previewPerpetualCareRef = makeFunctionReference<
  "query",
  { lotId: string },
  PreviewPerpetualCareResult
>("perpetualCare:previewPerpetualCareForLot");

type RecordFullPaymentSaleResult = {
  contractId: string;
  contractNumber: string;
  paymentId: string;
  receiptId: string;
  receiptNumber: string;
};

const recordFullPaymentSaleRef = makeFunctionReference<
  "mutation",
  RecordFullPaymentSaleArgs,
  RecordFullPaymentSaleResult
>("contracts:recordFullPaymentSale");

export interface SaleFormProps {
  /**
   * Caller's set of roles for the current user — drives the
   * admin-only price-edit gate. Server still enforces; UI gate is
   * defense in depth. Defaults to empty (treat as non-admin).
   */
  userRoles?: ReadonlyArray<string>;
}

type ActiveTab = "full" | "installment";

export function SaleForm({ userRoles = [] }: SaleFormProps) {
  const router = useRouter();
  const idempotencyKey = useIdempotencyKey();
  const recordFullPaymentSale = useMutation(recordFullPaymentSaleRef);

  const [tab, setTab] = useState<ActiveTab>("full");
  // Story 2.9 — selection mode. "single" preserves the historical
  // single-lot flow (LotPicker visible). "estate" swaps the LotPicker
  // for the EstatePicker; the SaleForm then sends `familyEstateId`
  // alongside the anchor lot id to `recordFullPaymentSale`.
  const [saleMode, setSaleMode] = useState<"single" | "estate">("single");
  const [selectedLot, setSelectedLot] = useState<LotPickerOption | null>(null);
  const [selectedEstate, setSelectedEstate] =
    useState<EstatePickerOption | null>(null);
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
  } = useForm<SaleFormValues>({
    resolver: zodResolver(saleFormSchema),
    mode: "onChange",
    defaultValues: {
      lotId: "",
      customerId: "",
      priceInput: "",
      method: "cash",
      reference: "",
      paidAtDate: todayLocalDate(),
      paidAtTime: currentLocalTime(),
      // Story 3.5 (FR22) — empty discount = no discount applied.
      discountInput: "",
      discountReason: "",
    },
  });

  const watchedMethod = watch("method");
  const watchedPriceInput = watch("priceInput");
  const watchedDate = watch("paidAtDate");
  const watchedTime = watch("paidAtTime");
  const watchedReference = watch("reference");
  // Story 3.5 — discount controls.
  const watchedDiscountInput = watch("discountInput") ?? "";
  const watchedDiscountReason = watch("discountReason") ?? "";

  // Story 3.5 (FR22) — derive cent values for the discount UI. The
  // `priceInput` field continues to represent the BASE price (the lot's
  // listed price, admin-editable). `discountInput` is the deduction.
  // `totalPriceCents` (what the customer actually pays + what the
  // mutation receives) is `basePriceCents − discountCents`.
  const baseCents = useMemo(() => {
    const v = pesosToCents(watchedPriceInput);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [watchedPriceInput]);
  const discountCents = useMemo(() => {
    const trimmed = (watchedDiscountInput ?? "").trim();
    if (trimmed === "") return 0;
    const v = pesosToCents(trimmed);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }, [watchedDiscountInput]);
  const trimmedDiscountReason = (watchedDiscountReason ?? "").trim();
  const discountApplied =
    discountCents > 0 && baseCents > 0 && discountCents <= baseCents;
  const totalAfterDiscount = Math.max(baseCents - discountCents, 0);

  // Story 3.8 (FR25) — perpetual care is POLICY-DRIVEN, not operator-supplied.
  // The CRIT-C foreground-fix pass (2026-05-22) removed the per-sale
  // operator inputs and now derives the fee server-side from
  // `cemeterySettings.perpetualCarePolicy`. The UI shows a read-only
  // preview derived from `previewPerpetualCareForLot({ lotId })`.
  const perpetualCarePreview = useQuery(
    previewPerpetualCareRef,
    selectedLot ? { lotId: selectedLot.lotId } : "skip",
  );
  const perpetualCareCents = perpetualCarePreview?.feeCents ?? 0;
  const perpetualCareApplied =
    perpetualCareCents > 0 &&
    perpetualCarePreview !== undefined &&
    perpetualCarePreview.isPlaceholder === false;
  const totalWithAddons = totalAfterDiscount + perpetualCareCents;

  // Derived preview data — null until lot + customer + price are set.
  //
  // Story 3.5 (FR22): the preview's `totalPriceCents` is the
  // post-discount amount the customer actually pays. The DiscountPanel
  // is the editable source of truth for the discount; this memo
  // re-derives the total via `baseCents − discountCents` so the
  // schedule / summary update reactively.
  const previewData = useMemo<ReceiptPreviewData | null>(() => {
    if (selectedLot === null || selectedCustomer === null) return null;
    if (baseCents <= 0) return null;
    if (discountCents > baseCents) return null;
    const paidAtMs = composePaidAtMs(watchedDate, watchedTime);
    if (paidAtMs === null) return null;
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
      totalPriceCents: totalWithAddons,
      method: watchedMethod,
      reference,
      paidAtMs,
    };
  }, [
    selectedLot,
    selectedCustomer,
    baseCents,
    discountCents,
    totalWithAddons,
    watchedDate,
    watchedTime,
    watchedMethod,
    watchedReference,
  ]);

  function handleLotSelected(lot: LotPickerOption | null): void {
    setSelectedLot(lot);
    setConflictError(null);
    if (lot !== null) {
      setValue("lotId", lot.lotId, { shouldValidate: true });
      // Auto-fill the price from the lot's listed basePriceCents.
      setValue(
        "priceInput",
        centsToPesos(lot.basePriceCents).toFixed(2),
        { shouldValidate: true },
      );
    } else {
      setValue("lotId", "", { shouldValidate: true });
      setValue("priceInput", "", { shouldValidate: true });
    }
  }

  function handleEstateSelected(estate: EstatePickerOption | null): void {
    setSelectedEstate(estate);
    setConflictError(null);
    if (estate !== null) {
      // The anchor lot is the contract row's `lotId`. The mutation
      // additionally locks every other member lot atomically.
      // We deliberately do NOT auto-fill the price (estate-level
      // pricing per Q2 "family ₱120k" is an admin-discretion call).
      setValue("lotId", estate.anchorLotId, { shouldValidate: true });
      // Clear the lot-picker state so the "single" UI doesn't leak
      // a stale selection if the operator toggles back.
      setSelectedLot(null);
      // When estate mode is active and a customer is already selected,
      // require that the selected customer matches the estate's primary
      // owner — pre-flight UX surface for the server-side check.
      if (
        selectedCustomer !== null &&
        selectedCustomer.customerId !== estate.primaryOwnerCustomerId
      ) {
        setConflictError(
          "Selected customer is not the estate's primary owner. Choose the primary owner or change estate.",
        );
      }
    } else {
      setValue("lotId", "", { shouldValidate: true });
    }
  }

  function handleModeChange(next: "single" | "estate"): void {
    setSaleMode(next);
    setConflictError(null);
    // Clear opposite-mode state so a switch is clean.
    setSelectedLot(null);
    setSelectedEstate(null);
    setValue("lotId", "", { shouldValidate: true });
    setValue("priceInput", "", { shouldValidate: true });
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

  function handleValidSubmit(_values: SaleFormValues): void {
    // Opening the preview modal is the form's submit action — the
    // mutation fires from the modal's "Generate & Print" button. The
    // preview modal IS the confirmation step per UX § 587.
    setCommitError(null);
    setConflictError(null);
    setPreviewOpen(true);
  }

  async function handleCommit(): Promise<void> {
    if (previewData === null || selectedLot === null || selectedCustomer === null) {
      return;
    }
    setIsCommitting(true);
    setCommitError(null);
    try {
      const args: RecordFullPaymentSaleArgs = {
        lotId: selectedLot.lotId,
        customerId: selectedCustomer.customerId,
        totalPriceCents: previewData.totalPriceCents,
        method: previewData.method,
        paidAt: previewData.paidAtMs,
        idempotencyKey,
      };
      if (previewData.reference !== undefined) {
        args.reference = previewData.reference;
      }
      // Story 3.5 (FR22) — attach discount payload when applied. The
      // server re-validates every invariant in
      // `normalizeDiscountInputs`; the client-side derivation here is
      // for UI responsiveness, not authority.
      if (discountApplied) {
        args.basePriceCents = baseCents;
        args.discountCents = discountCents;
        args.discountReason = trimmedDiscountReason;
      }
      // Story 2.9 (FR15) — attach the estate FK in estate mode. The
      // server re-validates membership + sibling-lot availability.
      if (saleMode === "estate" && selectedEstate !== null) {
        args.familyEstateId = selectedEstate.estateId;
      }
      // Story 3.8 (FR25) — perpetual care is policy-driven; the server
      // derives the fee from `cemeterySettings.perpetualCarePolicy` at
      // sale-time using the lot's `lotType`. The client no longer
      // attaches `perpetualCareCents` / `perpetualCareReason` to the
      // mutation — the SaleForm only displays the previewed value for
      // operator confirmation. See CRIT-C foreground-fix pass.
      const result = await recordFullPaymentSale(args);
      setPreviewOpen(false);
      // Open the print dialog as a smoke test of the flow. Story 3.11 /
      // 3.13 will replace this with the rendered receipt PDF.
      if (typeof window !== "undefined") {
        try {
          window.print();
        } catch {
          // Some test environments (jsdom) throw; the navigation below
          // is the important post-commit action.
        }
      }
      router.push(`/contracts/${result.contractId}`);
    } catch (err) {
      const translated = translateError(err);
      // Distinguish the concurrent-sale conflict from generic errors so
      // the parent can surface the AC5 affordance (Refresh button).
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
    setValue("priceInput", "", { shouldValidate: true });
  }

  return (
    <div className="space-y-6">
      <div
        className="flex border-b border-slate-200"
        role="tablist"
        aria-label="Sale type"
      >
        {(["full", "installment"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            data-testid={`sale-tab-${t}`}
            className={cn(
              "min-h-[44px] border-b-2 px-4 py-2 text-sm font-medium",
              tab === t
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700",
            )}
          >
            {t === "full" ? "Full Payment" : "Installment"}
          </button>
        ))}
      </div>

      {tab === "installment" && (
        <InstallmentTermsPanel userRoles={userRoles} />
      )}

      {tab === "full" && (
        <form
          onSubmit={handleSubmit(handleValidSubmit)}
          className="space-y-6"
          noValidate
          aria-label="Record a full-payment sale"
          data-testid="sale-form"
        >
          {conflictError !== null && (
            <div
              role="alert"
              data-testid="sale-form-conflict"
              className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <p className="font-medium">{conflictError}</p>
              <button
                type="button"
                onClick={refreshLotPicker}
                data-testid="sale-form-refresh"
                className="mt-2 inline-flex min-h-[44px] items-center rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
              >
                Refresh
              </button>
            </div>
          )}

          {/*
           * Story 2.9 (FR15) — sale mode toggle. "Single lot" preserves
           * the historical sale flow; "Family estate" swaps the
           * LotPicker for the EstatePicker and submits `familyEstateId`
           * alongside the anchor lot id.
           */}
          <div
            className="flex items-center gap-2"
            role="radiogroup"
            aria-label="Sale mode"
            data-testid="sale-mode-toggle"
          >
            {(["single", "estate"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={saleMode === m}
                onClick={() => handleModeChange(m)}
                data-testid={`sale-mode-${m}`}
                className={cn(
                  "min-h-[44px] rounded-md border px-3 py-2 text-sm font-medium",
                  saleMode === m
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                {m === "single" ? "Single lot" : "Family estate"}
              </button>
            ))}
          </div>

          {saleMode === "single" ? (
            <LotPicker
              value={selectedLot?.lotId ?? ""}
              onSelect={handleLotSelected}
            />
          ) : (
            <EstatePicker
              value={selectedEstate?.estateId ?? ""}
              onSelect={handleEstateSelected}
            />
          )}
          <input type="hidden" {...register("lotId")} />
          {errors.lotId !== undefined && (
            <p className="text-xs text-red-600" role="alert">
              {errors.lotId.message}
            </p>
          )}
          {saleMode === "estate" && selectedEstate !== null && (
            <p
              className="text-xs text-slate-500"
              data-testid="sale-estate-summary"
            >
              Estate: <strong>{selectedEstate.name}</strong> ·{" "}
              {selectedEstate.memberLotCodes.length} member lots ({selectedEstate.memberLotCodes.join(", ")})
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

          <div className="space-y-1">
            <label
              htmlFor="sale-price"
              className="block text-sm font-medium text-slate-700"
            >
              Price (PHP)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                ₱
              </span>
              <input
                id="sale-price"
                type="text"
                inputMode="decimal"
                readOnly={!priceEditable}
                aria-readonly={!priceEditable}
                aria-required="true"
                aria-invalid={errors.priceInput !== undefined}
                data-testid="sale-price-input"
                className={cn(
                  "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums",
                  "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                  !priceEditable && "bg-slate-50 text-slate-700",
                  errors.priceInput !== undefined && "border-red-400",
                )}
                {...register("priceInput")}
              />
            </div>
            {!priceEditable && (
              <p className="text-xs text-slate-500">
                Price comes from the lot&apos;s listed price. Apply a
                discount below if special pricing applies.
              </p>
            )}
            {selectedLot !== null && priceEditable && (
              <p className="text-xs text-slate-500">
                Listed price: {formatPeso(selectedLot.basePriceCents)}.
              </p>
            )}
            {errors.priceInput !== undefined && (
              <p className="text-xs text-red-600" role="alert">
                {errors.priceInput.message}
              </p>
            )}
          </div>

          {/*
           * Story 3.5 (FR22) — discount entry. Inline panel (UX § 1294
           * "Inline > modal"). When `discountInput` parses to > 0, the
           * `discountReason` becomes required and the price summary
           * block appears below showing base / discount / total. The
           * server (`convex/contracts.ts:normalizeDiscountInputs`)
           * re-validates every invariant; the client-side rules here
           * are for inline feedback.
           */}
          <div
            className="space-y-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
            data-testid="sale-discount-panel"
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
                  htmlFor="sale-discount-amount"
                  className="block text-xs font-medium text-slate-700"
                >
                  Discount amount (PHP)
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                    ₱
                  </span>
                  <input
                    id="sale-discount-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-invalid={errors.discountInput !== undefined}
                    data-testid="sale-discount-amount"
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
                  htmlFor="sale-discount-reason"
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
                  id="sale-discount-reason"
                  type="text"
                  maxLength={280}
                  placeholder="Why is this discount applied?"
                  aria-invalid={errors.discountReason !== undefined}
                  data-testid="sale-discount-reason"
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
            {(discountApplied || perpetualCareApplied) && (
              <dl
                className="mt-1 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums"
                data-testid="sale-price-summary"
              >
                <div className="flex justify-between">
                  <dt className="text-slate-600">Base price</dt>
                  <dd
                    className="text-slate-900"
                    data-testid="sale-summary-base"
                  >
                    {formatPeso(baseCents)}
                  </dd>
                </div>
                {discountApplied && (
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Discount</dt>
                    <dd
                      className="text-rose-600"
                      data-testid="sale-summary-discount"
                    >
                      −{formatPeso(discountCents)}
                    </dd>
                  </div>
                )}
                {perpetualCareApplied && (
                  <div className="flex justify-between">
                    <dt className="text-slate-600">Perpetual care</dt>
                    <dd
                      className="text-slate-900"
                      data-testid="sale-summary-perpetual-care"
                    >
                      +{formatPeso(perpetualCareCents)}
                    </dd>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold">
                  <dt className="text-slate-700">Total</dt>
                  <dd
                    className="text-slate-900"
                    data-testid="sale-summary-total"
                  >
                    {formatPeso(totalWithAddons)}
                  </dd>
                </div>
                {trimmedDiscountReason.length > 0 && (
                  <p
                    className="mt-1 text-xs text-slate-500"
                    data-testid="sale-summary-reason"
                  >
                    Reason: {trimmedDiscountReason}
                  </p>
                )}
              </dl>
            )}
          </div>

          {/*
           * Story 3.8 (FR25) — perpetual care addon. POLICY-DRIVEN,
           * not operator-supplied (per CRIT-C foreground-fix pass).
           * The fee is derived server-side from
           * `cemeterySettings.perpetualCarePolicy` based on the lot's
           * lotType; this read-only panel displays the previewed value
           * for operator confirmation. If the policy hasn't been
           * configured (placeholder), the panel surfaces a warning so
           * the operator knows to escalate to admin before completing
           * the sale.
           */}
          {selectedLot !== null && (
            <div
              className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3"
              data-testid="sale-perpetual-care-panel"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">
                  Perpetual care fee
                </h3>
                <span className="text-xs text-slate-500">
                  Per Apostle Paul policy.
                </span>
              </div>
              {perpetualCarePreview === undefined ? (
                <p className="text-xs text-slate-500">Loading policy…</p>
              ) : perpetualCarePreview.isPlaceholder ? (
                <p
                  className="text-xs text-amber-700"
                  role="alert"
                  data-testid="sale-perpetual-care-placeholder"
                >
                  Perpetual care policy is in placeholder mode. Ask the
                  admin to configure the policy before completing this
                  sale.
                </p>
              ) : perpetualCarePreview.feeCents === 0 ? (
                <p
                  className="text-xs text-slate-500"
                  data-testid="sale-perpetual-care-none"
                >
                  This lot type carries no perpetual care fee per current
                  policy.
                </p>
              ) : (
                <p
                  className="text-sm font-medium text-slate-800 tabular-nums"
                  data-testid="sale-perpetual-care-amount"
                >
                  {formatPeso(perpetualCarePreview.feeCents)}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label
                htmlFor="sale-method"
                className="block text-sm font-medium text-slate-700"
              >
                Payment method
              </label>
              <select
                id="sale-method"
                data-testid="sale-method"
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
                htmlFor="sale-reference"
                className={cn(
                  "block text-sm font-medium",
                  watchedMethod === "cash" ? "text-slate-400" : "text-slate-700",
                )}
              >
                Reference{" "}
                {watchedMethod !== "cash" && (
                  <span className="text-red-600">*</span>
                )}
              </label>
              <input
                id="sale-reference"
                type="text"
                disabled={watchedMethod === "cash"}
                placeholder={
                  watchedMethod === "cash"
                    ? "Not required for cash"
                    : "Cheque / bank transfer number"
                }
                aria-invalid={errors.reference !== undefined}
                data-testid="sale-reference"
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
                htmlFor="sale-date"
                className="block text-sm font-medium text-slate-700"
              >
                Date
              </label>
              <input
                id="sale-date"
                type="date"
                aria-required="true"
                aria-invalid={errors.paidAtDate !== undefined}
                data-testid="sale-date"
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
                htmlFor="sale-time"
                className="block text-sm font-medium text-slate-700"
              >
                Time
              </label>
              <input
                id="sale-time"
                type="time"
                aria-required="true"
                aria-invalid={errors.paidAtTime !== undefined}
                data-testid="sale-time"
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

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="submit"
              disabled={!isValid || previewData === null}
              data-testid="sale-form-submit"
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
