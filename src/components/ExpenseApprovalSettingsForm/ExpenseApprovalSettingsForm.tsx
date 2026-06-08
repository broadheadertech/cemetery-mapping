"use client";

/**
 * ExpenseApprovalSettingsForm — Story 6.6.
 *
 * React Hook Form + Zod. Used by `/admin/expense-approval-settings`
 * for both the default-sentinel row and per-category rows. Submits to
 * the parent's `onSubmit` callback; the parent owns the Convex
 * mutation call (same pattern as ExpenseCategoryForm).
 *
 * Fields:
 *   - Category (text, required, locked in default-row + edit modes).
 *   - Threshold (pesos, integer, 0+). Hidden when `requiresApproval`
 *     is false — the toggle becomes the master switch.
 *   - Requires approval (boolean toggle).
 *
 * The form converts the peso input to centavos in the submit
 * payload so the parent + Convex mutation see the canonical
 * INTEGER-centavos shape (ADR-0007).
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import {
  expenseApprovalSettingsFormSchema,
  type ExpenseApprovalSettingsFormValues,
} from "./schema";

export interface ExpenseApprovalSettingsFormSubmitPayload {
  category: string;
  thresholdCents: number;
  requiresApproval: boolean;
}

export interface ExpenseApprovalSettingsFormProps {
  /**
   * Submit handler. Receives the centavos payload (the form converts
   * the peso input on the way out). May throw a `ConvexError` — the
   * form translates it via `translateError` and surfaces inline.
   */
  onSubmit: (
    payload: ExpenseApprovalSettingsFormSubmitPayload,
  ) => Promise<void>;
  /** Called when the user clicks the secondary "Cancel" button. */
  onCancel?: () => void;
  /**
   * Mode discriminator:
   *   - `"create"` — new per-category row. Category name is editable.
   *   - `"edit"` — existing per-category row. Category name is locked
   *     (renaming a category-keyed threshold is not supported; delete
   *     + recreate instead).
   *   - `"default"` — the `__default__` sentinel row. Category is
   *     locked + hidden; the form shows the catch-all label instead.
   */
  mode: "create" | "edit" | "default";
  /** Pre-populated defaults. Required for `edit` and `default`. */
  defaultValues?: ExpenseApprovalSettingsFormValues;
  /**
   * Optional category-name suggestions for the create form's
   * combobox. The parent supplies the active expense categories
   * here so the admin doesn't have to type by hand.
   */
  categorySuggestions?: readonly string[];
}

const EMPTY_DEFAULTS: ExpenseApprovalSettingsFormValues = {
  category: "",
  thresholdPesos: 0,
  requiresApproval: false,
};

export function ExpenseApprovalSettingsForm({
  onSubmit,
  onCancel,
  mode,
  defaultValues,
  categorySuggestions,
}: ExpenseApprovalSettingsFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ExpenseApprovalSettingsFormValues>({
    resolver: zodResolver(expenseApprovalSettingsFormSchema),
    defaultValues: defaultValues ?? EMPTY_DEFAULTS,
  });

  const requiresApproval = watch("requiresApproval");

  const handleValidSubmit = async (
    values: ExpenseApprovalSettingsFormValues,
  ): Promise<void> => {
    setSubmitError(null);
    try {
      const payload: ExpenseApprovalSettingsFormSubmitPayload = {
        category: values.category.trim(),
        // Pesos → centavos. Math.round guards against any FP drift
        // even though the schema enforces integer input.
        thresholdCents: Math.round(values.thresholdPesos * 100),
        requiresApproval: values.requiresApproval,
      };
      await onSubmit(payload);
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  };

  const submitLabel =
    mode === "create" ? "Add setting" : "Save changes";
  const submittingLabel = mode === "create" ? "Adding…" : "Saving…";

  return (
    <form
      onSubmit={handleSubmit(handleValidSubmit)}
      className="space-y-6"
      noValidate
      aria-label={
        mode === "default"
          ? "Edit default expense approval setting form"
          : mode === "create"
            ? "New expense approval setting form"
            : "Edit expense approval setting form"
      }
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="expense-approval-settings-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      {mode === "default" ? (
        <div
          role="note"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          This is the <strong>default</strong> setting applied to any
          expense category that does not have a per-category override.
        </div>
      ) : null}

      <div className="space-y-1">
        <label
          htmlFor="approval-setting-category"
          className="block text-sm font-medium text-slate-700"
        >
          Category
        </label>
        {mode === "default" ? (
          <input
            id="approval-setting-category"
            type="text"
            readOnly
            value="(default — applies to all uncategorised expenses)"
            aria-readonly="true"
            className="block w-full cursor-not-allowed rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600"
          />
        ) : (
          <input
            id="approval-setting-category"
            type="text"
            autoComplete="off"
            list={
              categorySuggestions !== undefined &&
              categorySuggestions.length > 0
                ? "approval-setting-category-options"
                : undefined
            }
            readOnly={mode === "edit"}
            aria-readonly={mode === "edit" ? "true" : undefined}
            aria-invalid={errors.category !== undefined}
            aria-describedby={
              errors.category !== undefined
                ? "approval-setting-category-error"
                : undefined
            }
            className={cn(
              "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              mode === "edit" && "cursor-not-allowed bg-slate-100 text-slate-600",
              errors.category !== undefined && "border-red-400",
            )}
            {...register("category")}
          />
        )}
        {categorySuggestions !== undefined &&
          categorySuggestions.length > 0 &&
          mode === "create" && (
            <datalist id="approval-setting-category-options">
              {categorySuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          )}
        {errors.category !== undefined && (
          <p
            id="approval-setting-category-error"
            className="text-xs text-red-600"
          >
            {errors.category.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
            {...register("requiresApproval")}
          />
          Require approval for this category
        </label>
        <p className="text-xs text-slate-500">
          When OFF, expenses in this category are auto-approved
          regardless of amount.
        </p>
      </div>

      <div className={cn("space-y-1", !requiresApproval && "opacity-50")}>
        <label
          htmlFor="approval-setting-threshold"
          className="block text-sm font-medium text-slate-700"
        >
          Threshold (₱)
        </label>
        <input
          id="approval-setting-threshold"
          type="number"
          min={0}
          step={1}
          disabled={!requiresApproval}
          aria-invalid={errors.thresholdPesos !== undefined}
          aria-describedby={
            errors.thresholdPesos !== undefined
              ? "approval-setting-threshold-error"
              : "approval-setting-threshold-help"
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            !requiresApproval && "cursor-not-allowed bg-slate-100",
            errors.thresholdPesos !== undefined && "border-red-400",
          )}
          {...register("thresholdPesos", { valueAsNumber: true })}
        />
        {errors.thresholdPesos !== undefined ? (
          <p
            id="approval-setting-threshold-error"
            className="text-xs text-red-600"
          >
            {errors.thresholdPesos.message}
          </p>
        ) : (
          <p
            id="approval-setting-threshold-help"
            className="text-xs text-slate-500"
          >
            Expenses at or above this peso amount will require admin
            approval. Set to 0 to require approval for every expense
            in this category.
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
