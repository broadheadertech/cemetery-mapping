"use client";

/**
 * ExpenseCategoryForm — Story 4.7.
 *
 * React Hook Form + Zod. Used by the `/admin/expense-categories` page
 * for both creating a new category and editing an existing one.
 * Submits to the parent's `onSubmit` callback; the parent owns the
 * Convex mutation call (same pattern as Story 1.3's UserForm).
 *
 * Fields:
 *   - Name (text, required, 1–50 chars, case-insensitive unique)
 *   - Description (text, optional, ≤ 200 chars)
 *
 * Edit mode shows the financial-history-immutability warning:
 * "Renaming this category will not change how it appears on past
 * expenses." (Story 4.7 § Dev Notes — historical rename immutability.)
 *
 * Duplicate-name detection is delegated to the server — a
 * `DUPLICATE_CATEGORY_NAME` error returned from `onSubmit` surfaces
 * via `translateError` as an inline alert. The parent may also pass
 * a synchronous `duplicateName` hint (computed from the live category
 * list) so the user gets feedback before submit.
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import {
  CATEGORY_DESCRIPTION_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  expenseCategoryFormSchema,
  type ExpenseCategoryFormValues,
} from "./schema";

export interface ExpenseCategoryFormSubmitPayload {
  name: string;
  description?: string;
}

export interface ExpenseCategoryFormProps {
  /**
   * Submit handler. Receives a normalised payload (trimmed name,
   * trimmed description with empty strings removed). May throw a
   * `ConvexError` — the form translates it via `translateError` and
   * surfaces an inline alert.
   */
  onSubmit: (payload: ExpenseCategoryFormSubmitPayload) => Promise<void>;
  /** Called when the user clicks the secondary "Cancel" button. */
  onCancel?: () => void;
  /**
   * Mode discriminator. `"create"` shows the create CTA copy;
   * `"edit"` shows the rename-immutability warning + the edit CTA
   * copy.
   */
  mode: "create" | "edit";
  /**
   * Pre-populated defaults for edit mode. Ignored when mode === "create".
   */
  defaultValues?: ExpenseCategoryFormValues;
  /**
   * Optional duplicate-name hint, derived from the parent's live
   * category list. When non-null, the form refuses to submit and
   * shows an inline conflict message. The server-side check is
   * authoritative; this is a UX nicety.
   */
  duplicateName?: string | null;
}

const EMPTY_DEFAULTS: ExpenseCategoryFormValues = {
  name: "",
  description: "",
};

export function ExpenseCategoryForm({
  onSubmit,
  onCancel,
  mode,
  defaultValues,
  duplicateName,
}: ExpenseCategoryFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ExpenseCategoryFormValues>({
    resolver: zodResolver(expenseCategoryFormSchema),
    defaultValues: defaultValues ?? EMPTY_DEFAULTS,
  });

  const currentName = watch("name") ?? "";
  const duplicateActive =
    duplicateName !== null &&
    duplicateName !== undefined &&
    currentName.trim().toLowerCase() === duplicateName.toLowerCase();

  const handleValidSubmit = async (
    values: ExpenseCategoryFormValues,
  ): Promise<void> => {
    setSubmitError(null);
    if (duplicateActive) {
      setSubmitError("A category with this name already exists.");
      return;
    }
    try {
      const payload: ExpenseCategoryFormSubmitPayload = {
        name: values.name.trim(),
      };
      const description = values.description?.trim();
      if (description !== undefined && description.length > 0) {
        payload.description = description;
      }
      await onSubmit(payload);
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  };

  const submitLabel = mode === "create" ? "Create category" : "Save changes";
  const submittingLabel = mode === "create" ? "Creating…" : "Saving…";

  return (
    <form
      onSubmit={handleSubmit(handleValidSubmit)}
      className="space-y-6"
      noValidate
      aria-label={
        mode === "create"
          ? "New expense category form"
          : "Edit expense category form"
      }
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="expense-category-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      {mode === "edit" && (
        <div
          role="note"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Renaming this category will not change how it appears on past
          expenses. Historical records keep the original category name.
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="category-name"
          className="block text-sm font-medium text-slate-700"
        >
          Name
        </label>
        <input
          id="category-name"
          type="text"
          autoComplete="off"
          maxLength={CATEGORY_NAME_MAX_LENGTH}
          aria-invalid={errors.name !== undefined || duplicateActive}
          aria-describedby={
            errors.name !== undefined
              ? "category-name-error"
              : duplicateActive
                ? "category-name-duplicate"
                : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            (errors.name !== undefined || duplicateActive) && "border-red-400",
          )}
          {...register("name")}
        />
        {errors.name !== undefined && (
          <p id="category-name-error" className="text-xs text-red-600">
            {errors.name.message}
          </p>
        )}
        {duplicateActive && errors.name === undefined && (
          <p id="category-name-duplicate" className="text-xs text-red-600">
            A category with this name already exists.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="category-description"
          className="block text-sm font-medium text-slate-700"
        >
          Description{" "}
          <span className="text-xs font-normal text-slate-500">
            (optional)
          </span>
        </label>
        <textarea
          id="category-description"
          rows={3}
          maxLength={CATEGORY_DESCRIPTION_MAX_LENGTH}
          aria-invalid={errors.description !== undefined}
          aria-describedby={
            errors.description !== undefined
              ? "category-description-error"
              : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.description !== undefined && "border-red-400",
          )}
          {...register("description")}
        />
        {errors.description !== undefined && (
          <p id="category-description-error" className="text-xs text-red-600">
            {errors.description.message}
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
          disabled={isSubmitting || duplicateActive}
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </form>
  );
}
