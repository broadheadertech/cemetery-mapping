"use client";

/**
 * ExpenseForm — Story 4.6.
 *
 * Form for office staff to record an operating expense. RHF + Zod;
 * presentational + validation-only — the parent owns the Convex
 * mutation/action calls.
 *
 * Fields (Story 4.6 AC1):
 *   - Date (`<input type="date">`) — default today in Manila tz.
 *     `min` attr is set per-role (admin 30 days back, office_staff 7
 *     days back); server is the authority.
 *   - Amount (peso prefix, tabular numerics, required, > 0).
 *   - Vendor (free text, required, max 200 chars).
 *   - Category (select from server-supplied `categories` prop).
 *   - Photo (optional; native camera on mobile via `capture="environment"`).
 *
 * Banner: when `isPlaceholderCategories` is true, render the banner
 * "Expense categories pending client confirmation (§10 Q8). Defaults
 * shown below." — this clears automatically once Story 4.7 flips the
 * `IS_PLACEHOLDER` sentinel server-side.
 *
 * Submit button copy is "Record expense" — deliberately not "Generate
 * receipt", which is payment terminology (expenses don't produce a
 * customer receipt). Idempotency key is stable across re-renders.
 *
 * UX guardrails (Story 4.6 § Disaster prevention):
 *   - No vendor auto-fill (premature; misclick-prone).
 *   - No auto-categorisation via vendor name (premature).
 *   - Photo optional.
 *   - No offline queuing — writes hard-block; reads use PWA cache.
 *   - Confirmation is the redirect + reactive flash on the list page;
 *     no success toast.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { pesosToCents } from "@/lib/money";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";

import {
  expenseFormSchema,
  parsePaidAtToMs,
  todayInManila,
  PHOTO_MAX_BYTES,
  type ExpenseFormValues,
} from "./schema";

export interface ExpenseSubmitPayload {
  /** Epoch ms (UTC) of the business-relevant moment of payment. */
  paidAt: number;
  /** Integer centavos (≥ 1). */
  amountCents: number;
  vendor: string;
  category: string;
  /** Resolved `Id<"_storage">` from the two-step upload (if any). */
  photoStorageId?: string;
  /** Stable across the form mount; the server dedups by this. */
  idempotencyKey: string;
}

export interface ExpenseFormProps {
  /**
   * Active category vocabulary for the dropdown. Parent fetches via
   * `api.expenses.getActiveCategoriesForForm` and forwards the list.
   * Phase 1 list comes from the hardcoded constant; Story 4.7 swaps
   * to the table-backed implementation with no UI change.
   */
  categories: ReadonlyArray<string>;
  /** True while Story 4.7 has not landed (renders the gated banner). */
  isPlaceholderCategories: boolean;
  /** Caller's role(s) — drives the `min` date attribute. */
  callerRoles: ReadonlyArray<string>;
  /** Whether the network is online. Submit is disabled when false. */
  isOnline: boolean;
  /**
   * Returns a short-lived Convex File Storage upload URL. Called only
   * when the user attached a photo. On upload failure the form
   * surfaces an inline error and does NOT call `onSubmit`.
   */
  generateUploadUrl: () => Promise<string>;
  /**
   * Parent submit handler — receives the resolved payload with
   * centavos + epoch ms. May throw; translated inline.
   */
  onSubmit: (payload: ExpenseSubmitPayload) => Promise<void>;
  /** Optional cancel affordance (navigates back to /expenses). */
  onCancel?: () => void;
}

function backdateDaysForRoles(roles: ReadonlyArray<string>): number {
  return roles.includes("admin") ? 30 : 7;
}

function shiftDateStringByDays(yyyyMmDd: string, deltaDays: number): string {
  // Parse + shift by-component to dodge tz drift. The input is a
  // calendar date (no time), shifted in calendar units.
  const m = yyyyMmDd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m === null) return yyyyMmDd;
  const d = new Date(
    Number.parseInt(m[1]!, 10),
    Number.parseInt(m[2]!, 10) - 1,
    Number.parseInt(m[3]!, 10),
  );
  d.setDate(d.getDate() + deltaDays);
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function ExpenseForm({
  categories,
  isPlaceholderCategories,
  callerRoles,
  isOnline,
  generateUploadUrl,
  onSubmit,
  onCancel,
}: ExpenseFormProps) {
  const idempotencyKey = useIdempotencyKey();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoPreviewUrl = useRef<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  // Snapshot `today` and `min` once per mount. The form is short-lived
  // (a few minutes max); we don't tick.
  const [today] = useState<string>(() => todayInManila());
  const backdateDays = useMemo(
    () => backdateDaysForRoles(callerRoles),
    [callerRoles],
  );
  const minDate = useMemo(
    () => shiftDateStringByDays(today, -backdateDays),
    [today, backdateDays],
  );

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseFormSchema),
    defaultValues: {
      paidAt: today,
      amountPesos: "",
      vendor: "",
      category: "",
    },
  });

  useEffect(() => {
    return () => {
      if (photoPreviewUrl.current !== null) {
        URL.revokeObjectURL(photoPreviewUrl.current);
        photoPreviewUrl.current = null;
      }
    };
  }, []);

  function clearPhoto() {
    if (photoPreviewUrl.current !== null) {
      URL.revokeObjectURL(photoPreviewUrl.current);
      photoPreviewUrl.current = null;
    }
    setPhotoFile(null);
    setPhotoPreview(null);
    setPhotoError(null);
  }

  function onPhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (file === null) {
      clearPhoto();
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setPhotoError("Photo must be 10 MB or smaller.");
      e.target.value = "";
      return;
    }
    if (photoPreviewUrl.current !== null) {
      URL.revokeObjectURL(photoPreviewUrl.current);
    }
    const url = URL.createObjectURL(file);
    photoPreviewUrl.current = url;
    setPhotoFile(file);
    setPhotoPreview(url);
    setPhotoError(null);
  }

  async function handleValid(values: ExpenseFormValues) {
    setSubmitError(null);
    if (!isOnline) {
      setSubmitError("Posting requires connection. Reconnect and try again.");
      return;
    }
    const paidAtMs = parsePaidAtToMs(values.paidAt);
    if (paidAtMs === null) {
      setSubmitError("Date is invalid.");
      return;
    }
    const amountCents = pesosToCents(values.amountPesos);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      setSubmitError("Amount must be greater than ₱0.");
      return;
    }
    try {
      let photoStorageId: string | undefined = undefined;
      if (photoFile !== null) {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": photoFile.type || "application/octet-stream",
          },
          body: photoFile,
        });
        if (!res.ok) {
          throw new Error("Photo upload failed.");
        }
        const json = (await res.json()) as { storageId?: string };
        if (typeof json.storageId !== "string") {
          throw new Error("Photo upload returned no storageId.");
        }
        photoStorageId = json.storageId;
      }
      await onSubmit({
        paidAt: paidAtMs,
        amountCents,
        vendor: values.vendor.trim(),
        category: values.category.trim(),
        photoStorageId,
        idempotencyKey,
      });
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  }

  const submitDisabled = isSubmitting || !isOnline;

  return (
    <form
      onSubmit={handleSubmit(handleValid)}
      className="space-y-5"
      noValidate
      aria-label="Record expense form"
      data-testid="expense-form"
    >
      {isPlaceholderCategories && (
        <div
          role="status"
          data-testid="expense-categories-banner"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Expense categories pending client confirmation (§10 Q8). Defaults
          shown below.
        </div>
      )}

      {!isOnline && (
        <div
          role="status"
          data-testid="expense-offline-banner"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Posting requires connection. Reconnect and try again.
        </div>
      )}

      {submitError !== null && (
        <div
          role="alert"
          data-testid="expense-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="expense-date"
            className="block text-sm font-medium text-slate-700"
          >
            Date
          </label>
          <input
            id="expense-date"
            type="date"
            min={minDate}
            max={today}
            aria-required="true"
            aria-invalid={errors.paidAt !== undefined}
            aria-describedby={
              errors.paidAt !== undefined ? "expense-date-error" : undefined
            }
            className={cn(
              "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.paidAt !== undefined && "border-red-400",
            )}
            {...register("paidAt")}
          />
          {errors.paidAt !== undefined && (
            <p id="expense-date-error" className="text-xs text-red-600">
              {errors.paidAt.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label
            htmlFor="expense-amount"
            className="block text-sm font-medium text-slate-700"
          >
            Amount
          </label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-slate-500"
            >
              ₱
            </span>
            <input
              id="expense-amount"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              aria-required="true"
              aria-invalid={errors.amountPesos !== undefined}
              aria-describedby={
                errors.amountPesos !== undefined
                  ? "expense-amount-error"
                  : undefined
              }
              className={cn(
                "block min-h-[44px] w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums",
                "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
                errors.amountPesos !== undefined && "border-red-400",
              )}
              {...register("amountPesos")}
            />
          </div>
          {errors.amountPesos !== undefined && (
            <p id="expense-amount-error" className="text-xs text-red-600">
              {errors.amountPesos.message}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="expense-vendor"
          className="block text-sm font-medium text-slate-700"
        >
          Vendor
        </label>
        <input
          id="expense-vendor"
          type="text"
          placeholder="e.g. ABC Hardware Supply"
          aria-required="true"
          aria-invalid={errors.vendor !== undefined}
          aria-describedby={
            errors.vendor !== undefined ? "expense-vendor-error" : undefined
          }
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.vendor !== undefined && "border-red-400",
          )}
          {...register("vendor")}
        />
        {errors.vendor !== undefined && (
          <p id="expense-vendor-error" className="text-xs text-red-600">
            {errors.vendor.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="expense-category"
          className="block text-sm font-medium text-slate-700"
        >
          Category
        </label>
        <select
          id="expense-category"
          aria-required="true"
          aria-invalid={errors.category !== undefined}
          aria-describedby={
            errors.category !== undefined ? "expense-category-error" : undefined
          }
          defaultValue=""
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.category !== undefined && "border-red-400",
          )}
          {...register("category")}
        >
          <option value="">Select a category…</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {errors.category !== undefined && (
          <p id="expense-category-error" className="text-xs text-red-600">
            {errors.category.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium text-slate-700">
          Receipt photo (optional)
        </span>
        {photoPreview === null ? (
          <label
            htmlFor="expense-photo"
            className={cn(
              "inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center",
              "rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700",
              "hover:bg-slate-50 focus-within:ring-2 focus-within:ring-slate-500 focus-within:ring-offset-2",
            )}
          >
            Take or choose photo
            <input
              id="expense-photo"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPhotoChange}
              className="sr-only"
              data-testid="expense-photo-input"
            />
          </label>
        ) : (
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoPreview}
              alt="Receipt preview"
              className="h-20 w-20 rounded-md border border-slate-200 object-cover"
            />
            <button
              type="button"
              onClick={clearPhoto}
              aria-label="Remove photo"
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
        {photoError !== null && (
          <p className="text-xs text-red-600" data-testid="expense-photo-error">
            {photoError}
          </p>
        )}
      </div>

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
          data-testid="expense-form-submit"
          className={cn(
            "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
            "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isSubmitting ? "Recording…" : "Record expense"}
        </button>
      </div>
    </form>
  );
}
