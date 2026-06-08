"use client";

/**
 * SectionForm — Story 1.15.
 *
 * React Hook Form + Zod. Used by the `/admin/sections` page for both
 * creating a new named section and editing an existing one. Submits
 * to the parent's `onSubmit` callback; the parent owns the Convex
 * mutation call (mirrors the Story 4.7 ExpenseCategoryForm pattern).
 *
 * Fields:
 *   - Name (kebab-case identifier, required)
 *   - Display name (wayfinding label, required, 1–80 chars)
 *   - Sort order (integer ≥ 0)
 *   - Kind (radio group across the 5 brand-guide categories)
 *   - Description (optional markdown, ≤ 2000 chars)
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import {
  SECTION_DESCRIPTION_MAX_LENGTH,
  SECTION_DISPLAY_NAME_MAX_LENGTH,
  SECTION_KINDS,
  SECTION_NAME_MAX_LENGTH,
  sectionFormSchema,
  type SectionFormValues,
  type SectionKind,
} from "./schema";

export interface SectionFormSubmitPayload {
  name: string;
  displayName: string;
  sortOrder: number;
  kind: SectionKind;
  descriptionMarkdown?: string;
}

export interface SectionFormProps {
  mode: "create" | "edit";
  defaultValues?: SectionFormValues;
  onSubmit: (payload: SectionFormSubmitPayload) => Promise<void>;
  onCancel?: () => void;
}

const EMPTY_DEFAULTS: SectionFormValues = {
  name: "",
  displayName: "",
  sortOrder: 10,
  kind: "standard",
  descriptionMarkdown: "",
};

export function SectionForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
}: SectionFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SectionFormValues>({
    resolver: zodResolver(sectionFormSchema),
    defaultValues: defaultValues ?? EMPTY_DEFAULTS,
  });

  const handleValidSubmit = async (
    values: SectionFormValues,
  ): Promise<void> => {
    setSubmitError(null);
    try {
      const payload: SectionFormSubmitPayload = {
        name: values.name.trim(),
        displayName: values.displayName.trim(),
        sortOrder: values.sortOrder,
        kind: values.kind,
      };
      const description = values.descriptionMarkdown?.trim();
      if (description !== undefined && description.length > 0) {
        payload.descriptionMarkdown = description;
      }
      await onSubmit(payload);
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  };

  const submitLabel = mode === "create" ? "Create section" : "Save changes";
  const submittingLabel = mode === "create" ? "Creating…" : "Saving…";

  return (
    <form
      onSubmit={handleSubmit(handleValidSubmit)}
      className="space-y-6"
      noValidate
      aria-label={
        mode === "create" ? "New section form" : "Edit section form"
      }
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="section-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="section-name"
          className="block text-sm font-medium text-slate-700"
        >
          Name{" "}
          <span className="text-xs font-normal text-slate-500">
            (lowercase, kebab-case — e.g. <code>section-a-north</code>)
          </span>
        </label>
        <input
          id="section-name"
          type="text"
          autoComplete="off"
          maxLength={SECTION_NAME_MAX_LENGTH}
          aria-invalid={errors.name !== undefined}
          aria-describedby={
            errors.name !== undefined ? "section-name-error" : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.name !== undefined && "border-red-400",
          )}
          {...register("name")}
        />
        {errors.name !== undefined && (
          <p id="section-name-error" className="text-xs text-red-600">
            {errors.name.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="section-displayName"
          className="block text-sm font-medium text-slate-700"
        >
          Display name{" "}
          <span className="text-xs font-normal text-slate-500">
            (what families see on signage — e.g. &quot;Section A · North&quot;)
          </span>
        </label>
        <input
          id="section-displayName"
          type="text"
          autoComplete="off"
          maxLength={SECTION_DISPLAY_NAME_MAX_LENGTH}
          aria-invalid={errors.displayName !== undefined}
          aria-describedby={
            errors.displayName !== undefined
              ? "section-displayName-error"
              : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.displayName !== undefined && "border-red-400",
          )}
          {...register("displayName")}
        />
        {errors.displayName !== undefined && (
          <p id="section-displayName-error" className="text-xs text-red-600">
            {errors.displayName.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="section-sortOrder"
            className="block text-sm font-medium text-slate-700"
          >
            Sort order
          </label>
          <input
            id="section-sortOrder"
            type="number"
            step="1"
            min="0"
            aria-invalid={errors.sortOrder !== undefined}
            aria-describedby={
              errors.sortOrder !== undefined
                ? "section-sortOrder-error"
                : undefined
            }
            className={cn(
              "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.sortOrder !== undefined && "border-red-400",
            )}
            {...register("sortOrder", { valueAsNumber: true })}
          />
          {errors.sortOrder !== undefined && (
            <p id="section-sortOrder-error" className="text-xs text-red-600">
              {errors.sortOrder.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label
            htmlFor="section-kind"
            className="block text-sm font-medium text-slate-700"
          >
            Kind
          </label>
          <select
            id="section-kind"
            aria-invalid={errors.kind !== undefined}
            aria-describedby={
              errors.kind !== undefined ? "section-kind-error" : undefined
            }
            className={cn(
              "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.kind !== undefined && "border-red-400",
            )}
            {...register("kind")}
          >
            {SECTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.charAt(0).toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
          {errors.kind !== undefined && (
            <p id="section-kind-error" className="text-xs text-red-600">
              {errors.kind.message}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="section-description"
          className="block text-sm font-medium text-slate-700"
        >
          Description{" "}
          <span className="text-xs font-normal text-slate-500">
            (optional — 1–3 paragraphs for the brochure / portal)
          </span>
        </label>
        <textarea
          id="section-description"
          rows={4}
          maxLength={SECTION_DESCRIPTION_MAX_LENGTH}
          aria-invalid={errors.descriptionMarkdown !== undefined}
          aria-describedby={
            errors.descriptionMarkdown !== undefined
              ? "section-description-error"
              : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.descriptionMarkdown !== undefined && "border-red-400",
          )}
          {...register("descriptionMarkdown")}
        />
        {errors.descriptionMarkdown !== undefined && (
          <p id="section-description-error" className="text-xs text-red-600">
            {errors.descriptionMarkdown.message}
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
