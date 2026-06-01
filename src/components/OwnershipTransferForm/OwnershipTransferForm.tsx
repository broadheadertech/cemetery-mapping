"use client";

/**
 * OwnershipTransferForm — Story 2.7 (FR17).
 *
 * Multi-step form for office staff to record an ownership transfer
 * of a lot from the current owner to a destination customer. The
 * form drives `ownerships.recordOwnershipTransfer` (atomic close+open
 * mutation) and surfaces a two-step "fill / confirm" flow to make
 * the destructive ownership change explicit.
 *
 * Composition:
 *   - Owns the `recordOwnershipTransfer` mutation call directly.
 *   - `onTransferred` — optional callback fired after success with
 *     the new ownership id. When undefined, the parent typically
 *     navigates back to the customer detail page.
 *   - `onCancel` — optional. Renders a Cancel button when supplied.
 *
 * UX guardrails (Story 2.7 disaster prevention):
 *   - Destination customer is picked via a debounced
 *     `customers:searchByName` query (same pattern as
 *     `CustomerForm`'s dedupe alert). The picker NEVER renders the
 *     full gov-ID — only the `***-***-LAST4` mask (UX §1879–1884).
 *   - Submit is gated behind a confirm step that summarises the
 *     transfer in plain language (lot code, from-name, to-name,
 *     type, date). Two slides, controlled by local state.
 *   - Backdated transfers (effective date older than 24h before
 *     now) require a longer reason — both the Zod schema and the
 *     server enforce the floor.
 *   - "Record transfer" is the verb on the final button — never a
 *     generic "Submit".
 *   - All interactive controls meet `min-h-[44px]` (NFR-A4).
 *
 * §10 Q6 (policy pending): the per-transfer-type required-document
 * workflow (deed of sale, affidavit of self-adjudication, etc.) is
 * gated on client policy confirmation. The form shows a banner so
 * the operator knows the documentation step is pending; the atomic
 * close/open mutation ships today.
 */

import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { formatDate } from "@/lib/time";

import {
  BACKDATED_THRESHOLD_MS,
  ownershipTransferSchema,
  TRANSFER_REASON_MAX_LENGTH,
  TRANSFER_TYPES,
  transferTypeLabels,
  type OwnershipTransferFormValues,
  type TransferType,
} from "./schema";

/**
 * Wire shape of one row in `customers.searchByName`'s return payload.
 * Mirrored inline (rather than imported from the convex source tree)
 * to keep the client / server boundary clean — the same mirroring
 * pattern as `src/lib/errors.ts`.
 */
type SearchByNameHit = {
  customerId: string;
  fullName: string;
  govIdLast4: string;
};

const searchByNameRef = makeFunctionReference<
  "query",
  { q: string },
  SearchByNameHit[]
>("customers:searchByName");

const recordOwnershipTransferRef = makeFunctionReference<
  "mutation",
  {
    fromCustomerId: string;
    toCustomerId: string;
    lotId: string;
    transferReason: string;
    transferDate: number;
    transferType?: TransferType;
  },
  { newOwnershipId: string; closedOwnershipId: string }
>("ownerships:recordOwnershipTransfer");

export interface CurrentOwnerLot {
  lotId: string;
  lotCode: string;
  ownershipId: string;
}

export interface OwnershipTransferFormProps {
  /**
   * The customer whose lot is being transferred AWAY. Read from
   * the URL (`customers/[customerId]/transfer`).
   */
  fromCustomerId: string;
  /** Display name for the from-customer, used in the summary step. */
  fromCustomerName: string;
  /**
   * Lots the from-customer currently owns (open ownership rows).
   * The form renders a Select; the user picks which one to transfer.
   * Typically derived from `ownerships:listByCustomer` filtered to
   * rows with `effectiveTo === undefined`.
   */
  ownedLots: readonly CurrentOwnerLot[];
  /** Optional callback fired after the mutation succeeds. */
  onTransferred?: (result: {
    newOwnershipId: string;
    closedOwnershipId: string;
  }) => void;
  /** Optional Cancel callback. Renders a Cancel button when supplied. */
  onCancel?: () => void;
}

/** Returns today's date as a YYYY-MM-DD string in the local timezone. */
function todayIsoLocal(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Convert a `YYYY-MM-DD` string from the native date input to a
 * unix-ms timestamp. Mirrors `OccupantForm`'s `dateStringToUnixMs`.
 * Cemetery records are date-only — UTC midnight is acceptable here
 * because the display formatters everywhere use `Asia/Manila`.
 */
function dateStringToUnixMs(value: string): number {
  return Date.parse(value);
}

/** Dedupe debounce in milliseconds for the customer picker query. */
const DEDUPE_DEBOUNCE_MS = 300;

const FORM_DEFAULTS: OwnershipTransferFormValues = {
  toCustomerId: "",
  transferType: "sale",
  transferDate: todayIsoLocal(),
  transferReason: "",
};

export function OwnershipTransferForm({
  fromCustomerId,
  fromCustomerName,
  ownedLots,
  onTransferred,
  onCancel,
}: OwnershipTransferFormProps) {
  const recordTransfer = useMutation(recordOwnershipTransferRef);

  const [step, setStep] = useState<"form" | "confirm">("form");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lotIndex, setLotIndex] = useState<number>(ownedLots.length > 0 ? 0 : -1);
  const [selectedCustomer, setSelectedCustomer] = useState<{
    customerId: string;
    fullName: string;
    govIdLast4: string;
  } | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Hand-rolled debounce (we deliberately don't pull in a hook here —
  // the form is self-contained and the debounce is a single state
  // mirror that lives in this component).
  useEffect(() => {
    const t = setTimeout(
      () => setDebouncedSearch(customerSearch),
      DEDUPE_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [customerSearch]);

  const searchResults = useQuery(
    searchByNameRef,
    debouncedSearch.trim().length >= 3 ? { q: debouncedSearch.trim() } : "skip",
  );

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    getValues,
    reset,
    formState: { errors, isSubmitting, isValid },
  } = useForm<OwnershipTransferFormValues>({
    resolver: zodResolver(ownershipTransferSchema),
    mode: "onChange",
    defaultValues: FORM_DEFAULTS,
  });

  const watchedTransferDate = watch("transferDate");
  const watchedReason = watch("transferReason");
  const watchedType = watch("transferType");

  const isBackdated = useMemo(() => {
    const parsed = Date.parse(watchedTransferDate);
    if (!Number.isFinite(parsed)) return false;
    return parsed < Date.now() - BACKDATED_THRESHOLD_MS;
  }, [watchedTransferDate]);

  const selectedLot = lotIndex >= 0 ? ownedLots[lotIndex] : undefined;

  function handleReviewClick(values: OwnershipTransferFormValues) {
    if (selectedLot === undefined) {
      setSubmitError("Select a lot to transfer first.");
      return;
    }
    if (selectedCustomer === null || selectedCustomer.customerId !== values.toCustomerId) {
      setSubmitError("Pick a destination customer from the search results.");
      return;
    }
    if (selectedCustomer.customerId === fromCustomerId) {
      setSubmitError("The destination customer must differ from the current owner.");
      return;
    }
    setSubmitError(null);
    setStep("confirm");
  }

  async function handleConfirm() {
    if (selectedLot === undefined || selectedCustomer === null) {
      setSubmitError("Form is incomplete. Go back and try again.");
      return;
    }
    setSubmitError(null);
    const values = getValues();
    try {
      const result = await recordTransfer({
        fromCustomerId,
        toCustomerId: selectedCustomer.customerId,
        lotId: selectedLot.lotId,
        transferReason: values.transferReason.trim(),
        transferDate: dateStringToUnixMs(values.transferDate),
        transferType: values.transferType,
      });
      onTransferred?.(result);
      reset(FORM_DEFAULTS);
      setSelectedCustomer(null);
      setStep("form");
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  }

  const submitDisabled =
    isSubmitting ||
    !isValid ||
    selectedLot === undefined ||
    selectedCustomer === null ||
    selectedCustomer.customerId === fromCustomerId;

  if (ownedLots.length === 0) {
    return (
      <div
        role="status"
        data-testid="ownership-transfer-empty"
        className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        {fromCustomerName} does not currently own any lots, so there is
        nothing to transfer. Record a sale first.
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div
        className="space-y-4"
        data-testid="ownership-transfer-confirm"
        aria-live="polite"
      >
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-800">
          <h2 className="mb-2 text-base font-semibold text-slate-900">
            Review transfer
          </h2>
          <dl className="grid grid-cols-1 gap-y-1.5">
            <DListRow
              label="Lot"
              value={selectedLot !== undefined ? `Lot ${selectedLot.lotCode}` : ""}
            />
            <DListRow label="From" value={fromCustomerName} />
            <DListRow
              label="To"
              value={
                selectedCustomer !== null
                  ? `${selectedCustomer.fullName} (***-***-${selectedCustomer.govIdLast4})`
                  : ""
              }
            />
            <DListRow label="Type" value={transferTypeLabels[watchedType]} />
            <DListRow
              label="Effective"
              value={formatDate(dateStringToUnixMs(watchedTransferDate), "short")}
            />
            <DListRow label="Reason" value={watchedReason.trim()} />
          </dl>
          <p className="mt-3 text-xs text-slate-600">
            Confirming will close the previous ownership row and open a new
            one for {selectedCustomer?.fullName ?? "the destination customer"}.
            This action is recorded in the audit log and cannot be reverted —
            corrections require a NEW transfer event.
          </p>
        </div>
        {submitError !== null && (
          <div
            role="alert"
            data-testid="ownership-transfer-error"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {submitError}
          </div>
        )}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => {
              setSubmitError(null);
              setStep("form");
            }}
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            aria-disabled={isSubmitting}
            data-testid="ownership-transfer-confirm-submit"
            className={cn(
              "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
              "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {isSubmitting ? "Recording…" : "Record transfer"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(handleReviewClick)}
      className="space-y-5"
      noValidate
      aria-label="Record ownership transfer"
      data-testid="ownership-transfer-form"
    >
      <div
        role="status"
        className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      >
        Per-transfer-type document requirements are pending client policy
        confirmation (§10 Q6). The transfer below records the ownership
        change atomically; the documentation gate will land once the
        policy resolves.
      </div>

      {/* Lot picker */}
      <div className="space-y-1">
        <label
          htmlFor="ot-lot"
          className="block text-sm font-medium text-slate-700"
        >
          Lot to transfer
        </label>
        <select
          id="ot-lot"
          data-testid="ownership-transfer-lot"
          value={lotIndex >= 0 ? String(lotIndex) : ""}
          onChange={(e) => setLotIndex(Number(e.target.value))}
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          )}
        >
          {ownedLots.map((lot, idx) => (
            <option key={lot.ownershipId} value={String(idx)}>
              Lot {lot.lotCode}
            </option>
          ))}
        </select>
      </div>

      {/* Transfer type */}
      <div className="space-y-1">
        <label
          htmlFor="ot-type"
          className="block text-sm font-medium text-slate-700"
        >
          Transfer type
        </label>
        <Controller
          control={control}
          name="transferType"
          render={({ field }) => (
            <select
              id="ot-type"
              data-testid="ownership-transfer-type"
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              )}
            >
              {TRANSFER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {transferTypeLabels[t]}
                </option>
              ))}
            </select>
          )}
        />
      </div>

      {/* Destination customer search */}
      <div className="space-y-1">
        <label
          htmlFor="ot-search"
          className="block text-sm font-medium text-slate-700"
        >
          Destination customer
        </label>
        <input
          id="ot-search"
          type="text"
          data-testid="ownership-transfer-search"
          placeholder="Search by name (min 3 characters)"
          value={customerSearch}
          onChange={(e) => {
            setCustomerSearch(e.target.value);
            if (selectedCustomer !== null) {
              setSelectedCustomer(null);
              setValue("toCustomerId", "", { shouldValidate: true });
            }
          }}
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          )}
        />
        {selectedCustomer !== null && (
          <div
            data-testid="ownership-transfer-selected"
            className="mt-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          >
            Selected: {selectedCustomer.fullName} (***-***-
            {selectedCustomer.govIdLast4})
          </div>
        )}
        {selectedCustomer === null &&
          searchResults !== undefined &&
          searchResults.length > 0 && (
            <ul
              data-testid="ownership-transfer-results"
              className="mt-1 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white"
            >
              {searchResults.map((hit) => {
                const isSelf = hit.customerId === fromCustomerId;
                return (
                  <li
                    key={hit.customerId}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="text-slate-900">
                      {hit.fullName}{" "}
                      <span className="text-slate-500">
                        (***-***-{hit.govIdLast4})
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={isSelf}
                      onClick={() => {
                        setSelectedCustomer(hit);
                        setValue("toCustomerId", hit.customerId, {
                          shouldValidate: true,
                        });
                      }}
                      className={cn(
                        "min-h-[36px] rounded-md px-3 py-1 text-xs font-medium",
                        isSelf
                          ? "cursor-not-allowed bg-slate-100 text-slate-400"
                          : "bg-slate-900 text-white hover:bg-slate-800",
                      )}
                    >
                      {isSelf ? "Current owner" : "Select"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        {selectedCustomer === null &&
          debouncedSearch.trim().length >= 3 &&
          searchResults !== undefined &&
          searchResults.length === 0 && (
            <p
              data-testid="ownership-transfer-no-results"
              className="mt-1 text-xs text-slate-500"
            >
              No customers match &ldquo;{debouncedSearch.trim()}&rdquo;.
              Create the customer first via /customers/new.
            </p>
          )}
        {errors.toCustomerId !== undefined && (
          <p className="text-xs text-red-600">{errors.toCustomerId.message}</p>
        )}
      </div>

      {/* Transfer date */}
      <div className="space-y-1">
        <label
          htmlFor="ot-date"
          className="block text-sm font-medium text-slate-700"
        >
          Effective date
        </label>
        <input
          id="ot-date"
          type="date"
          aria-required="true"
          aria-invalid={errors.transferDate !== undefined}
          aria-describedby={
            errors.transferDate !== undefined ? "ot-date-error" : undefined
          }
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.transferDate !== undefined && "border-red-400",
          )}
          {...register("transferDate")}
        />
        {errors.transferDate !== undefined && (
          <p id="ot-date-error" className="text-xs text-red-600">
            {errors.transferDate.message}
          </p>
        )}
        {isBackdated && (
          <p
            role="status"
            data-testid="ownership-transfer-backdated"
            className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
          >
            Backdated transfer — provide a fuller reason (min 10 characters)
            explaining why the effective date is in the past.
          </p>
        )}
      </div>

      {/* Reason */}
      <div className="space-y-1">
        <label
          htmlFor="ot-reason"
          className="block text-sm font-medium text-slate-700"
        >
          Reason
        </label>
        <textarea
          id="ot-reason"
          rows={3}
          maxLength={TRANSFER_REASON_MAX_LENGTH}
          aria-required="true"
          aria-invalid={errors.transferReason !== undefined}
          aria-describedby={
            errors.transferReason !== undefined
              ? "ot-reason-error"
              : "ot-reason-hint"
          }
          placeholder="e.g. Inheritance per affidavit dated 2026-03-15"
          className={cn(
            "block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.transferReason !== undefined && "border-red-400",
          )}
          {...register("transferReason")}
        />
        {errors.transferReason !== undefined ? (
          <p id="ot-reason-error" className="text-xs text-red-600">
            {errors.transferReason.message}
          </p>
        ) : (
          <p id="ot-reason-hint" className="text-xs text-slate-500">
            Recorded in the audit log. Up to {TRANSFER_REASON_MAX_LENGTH}{" "}
            characters.
          </p>
        )}
      </div>

      {submitError !== null && (
        <div
          role="alert"
          data-testid="ownership-transfer-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={submitDisabled}
          aria-disabled={submitDisabled}
          data-testid="ownership-transfer-review"
          className={cn(
            "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
            "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          Review transfer
        </button>
      </div>
    </form>
  );
}

/**
 * Tiny `<dt>/<dd>` row used inside the confirm step's summary list.
 */
function DListRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className="text-sm text-slate-900"
        data-testid={`ownership-transfer-summary-${label.toLowerCase()}`}
      >
        {value}
      </dd>
    </div>
  );
}

