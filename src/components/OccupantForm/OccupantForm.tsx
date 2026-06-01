"use client";

/**
 * OccupantForm — Story 2.6.
 *
 * Form for office staff to record an occupant (deceased person)
 * interred at a lot. Captures: name, date of interment (with explicit
 * "Date unknown" checkbox for legacy data), relationship to owner,
 * optional notes.
 *
 * Presentational + validation-only — the parent owns the Convex
 * mutation call. The parent is typically `OccupantsPanel`'s
 * "Add occupant" dialog. This shape mirrors `LogConditionForm` /
 * `LotForm` from earlier stories.
 *
 * UX guardrails (Story 2.6 § Disaster prevention):
 *   - Free-text relationship (no enum) — Filipino family terms vary.
 *   - "Date unknown" is a deliberate first-class control, not a hack
 *     around the date input. Checking it disables and clears the
 *     date picker and submits `dateOfInterment: undefined`.
 *   - All interactive controls meet `min-h-[44px]` (NFR-A4).
 *   - Submit button copy is the verb "Add occupant" — never a
 *     generic "Submit".
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";

import {
  OCCUPANT_NAME_MAX_LENGTH,
  OCCUPANT_NOTES_MAX_LENGTH,
  OCCUPANT_RELATIONSHIP_MAX_LENGTH,
  occupantFormSchema,
  type OccupantFormValues,
} from "./schema";

export interface OccupantSubmitPayload {
  name: string;
  dateOfInterment: number | undefined;
  relationshipToOwner: string;
  notes: string | undefined;
}

export interface OccupantFormProps {
  /**
   * Parent-supplied submit handler. Receives the validated payload
   * with `dateOfInterment` already resolved to unix ms (or
   * `undefined` when the "Date unknown" checkbox is checked).
   *
   * May throw — the form surfaces the translated error inline and
   * stays open.
   */
  onSubmit: (payload: OccupantSubmitPayload) => Promise<void>;
  /**
   * Cancel callback. Called when the user clicks Cancel; the
   * containing Dialog typically uses this to close itself.
   */
  onCancel?: () => void;
}

/**
 * Convert a `YYYY-MM-DD` string from the native date input to a
 * unix-ms timestamp at local-midnight. We deliberately don't apply
 * Manila tz here — the date the operator types is the date they mean
 * (cemetery records are date-only). Time zone treatment is centralised
 * in `convex/lib/time.ts` when it lands as a richer module.
 */
function dateStringToUnixMs(value: string): number {
  // `new Date("YYYY-MM-DD")` parses as UTC midnight. For Phase 1 our
  // date-only field is treated as a calendar date, so the UTC midnight
  // interpretation is acceptable — display formatters everywhere use
  // `Asia/Manila` consistently.
  return Date.parse(value);
}

export function OccupantForm({ onSubmit, onCancel }: OccupantFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting, isValid },
  } = useForm<OccupantFormValues>({
    resolver: zodResolver(occupantFormSchema),
    mode: "onChange",
    defaultValues: {
      name: "",
      relationshipToOwner: "",
      dateOfInterment: "",
      dateUnknown: false,
      notes: "",
    },
  });

  const dateUnknown = watch("dateUnknown");

  function handleDateUnknownChange(e: React.ChangeEvent<HTMLInputElement>) {
    const checked = e.target.checked;
    setValue("dateUnknown", checked, { shouldValidate: true });
    if (checked) {
      setValue("dateOfInterment", "", { shouldValidate: true });
    }
  }

  async function handleValid(values: OccupantFormValues) {
    setSubmitError(null);
    try {
      const dateOfInterment =
        values.dateUnknown ||
        values.dateOfInterment === undefined ||
        values.dateOfInterment.trim() === ""
          ? undefined
          : dateStringToUnixMs(values.dateOfInterment);
      const notes =
        values.notes !== undefined && values.notes.trim().length > 0
          ? values.notes.trim()
          : undefined;
      await onSubmit({
        name: values.name.trim(),
        dateOfInterment,
        relationshipToOwner: values.relationshipToOwner.trim(),
        notes,
      });
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  }

  const submitDisabled = isSubmitting || !isValid;

  return (
    <form
      onSubmit={handleSubmit(handleValid)}
      className="space-y-5"
      noValidate
      aria-label="Add occupant form"
      data-testid="occupant-form"
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="occupant-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="occupant-name"
          className="block text-sm font-medium text-slate-700"
        >
          Name
        </label>
        <input
          id="occupant-name"
          type="text"
          autoFocus
          aria-required="true"
          aria-invalid={errors.name !== undefined}
          aria-describedby={
            errors.name !== undefined ? "occupant-name-error" : undefined
          }
          maxLength={OCCUPANT_NAME_MAX_LENGTH}
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.name !== undefined && "border-red-400",
          )}
          {...register("name")}
        />
        {errors.name !== undefined && (
          <p id="occupant-name-error" className="text-xs text-red-600">
            {errors.name.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            data-testid="occupant-date-unknown"
            checked={dateUnknown}
            onChange={handleDateUnknownChange}
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          <span>Date unknown</span>
        </label>
        <label
          htmlFor="occupant-date"
          className="block text-sm font-medium text-slate-700"
        >
          Date of interment
        </label>
        <input
          id="occupant-date"
          type="date"
          disabled={dateUnknown}
          aria-required={!dateUnknown}
          aria-invalid={errors.dateOfInterment !== undefined}
          aria-describedby={
            errors.dateOfInterment !== undefined
              ? "occupant-date-error"
              : undefined
          }
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400",
            errors.dateOfInterment !== undefined && "border-red-400",
          )}
          {...register("dateOfInterment")}
        />
        {errors.dateOfInterment !== undefined && (
          <p id="occupant-date-error" className="text-xs text-red-600">
            {errors.dateOfInterment.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="occupant-relationship"
          className="block text-sm font-medium text-slate-700"
        >
          Relationship to owner
        </label>
        <input
          id="occupant-relationship"
          type="text"
          aria-required="true"
          aria-invalid={errors.relationshipToOwner !== undefined}
          aria-describedby={
            errors.relationshipToOwner !== undefined
              ? "occupant-relationship-error"
              : "occupant-relationship-hint"
          }
          maxLength={OCCUPANT_RELATIONSHIP_MAX_LENGTH}
          placeholder="e.g. spouse, child, parent"
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.relationshipToOwner !== undefined && "border-red-400",
          )}
          {...register("relationshipToOwner")}
        />
        {errors.relationshipToOwner !== undefined ? (
          <p id="occupant-relationship-error" className="text-xs text-red-600">
            {errors.relationshipToOwner.message}
          </p>
        ) : (
          <p
            id="occupant-relationship-hint"
            className="text-xs text-slate-500"
          >
            Free text — any Filipino family term is fine (kuya, ate, anak,
            ninang).
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="occupant-notes"
          className="block text-sm font-medium text-slate-700"
        >
          Notes (optional)
        </label>
        <textarea
          id="occupant-notes"
          rows={2}
          maxLength={OCCUPANT_NOTES_MAX_LENGTH}
          aria-invalid={errors.notes !== undefined}
          aria-describedby={
            errors.notes !== undefined ? "occupant-notes-error" : undefined
          }
          placeholder="e.g. transferred from old book entry 1987"
          className={cn(
            "block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.notes !== undefined && "border-red-400",
          )}
          {...register("notes")}
        />
        {errors.notes !== undefined && (
          <p id="occupant-notes-error" className="text-xs text-red-600">
            {errors.notes.message}
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
          data-testid="occupant-form-submit"
          className={cn(
            "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
            "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isSubmitting ? "Adding…" : "Add occupant"}
        </button>
      </div>
    </form>
  );
}
