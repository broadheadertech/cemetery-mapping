"use client";

/**
 * IntermentForm — Story 7.1.
 *
 * Presentational form for office staff to schedule an interment.
 * Captures: occupant selection (from the lot's existing occupants),
 * date, time (15-minute increments), optional notes.
 *
 * Presentational + validation-only — the parent owns the Convex
 * mutation call AND the occupant-list query. This shape mirrors
 * `OccupantForm` (Story 2.6) / `LogConditionForm` (Story 1.14).
 *
 * UX guardrails (Story 7.1 § Disaster prevention):
 *   - Occupant list is SCOPED to the lot (parent passes the list).
 *     Never load all 2,000+ lots' occupants in the picker — that's
 *     an N×M perf hazard.
 *   - `min` attribute on the date input mirrors the server's 1-day
 *     past tolerance so the client rejects what the server would.
 *   - 15-minute time increments via `step={900}` on the time input.
 *   - Manila tz is hardcoded for now (PH has no DST per
 *     `convex/lib/time.ts` policy). The form composes
 *     `${date}T${time}+08:00` and submits epoch ms — never a string.
 *   - All interactive controls meet `min-h-[44px]` (NFR-A4).
 *   - Submit copy is the verb "Schedule interment", not "Submit".
 *   - "Add new occupant" inline affordance: a parent-provided
 *     callback opens a nested dialog using `OccupantForm`. On
 *     successful create the parent calls `onOccupantCreated(id)`
 *     and the form auto-selects the new occupant.
 */

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";

import {
  INTERMENT_NOTES_MAX_LENGTH,
  composeScheduledAtMs,
  intermentFormSchema,
  type IntermentFormValues,
} from "./schema";

export interface IntermentOccupantOption {
  /** Convex `Id<"occupants">` as a string. */
  occupantId: string;
  name: string;
  relationshipToOwner: string;
  isRemoved: boolean;
}

export interface IntermentSubmitPayload {
  occupantId: string;
  /** Epoch ms (UTC) of the planned moment, Manila-tz-composed. */
  scheduledAt: number;
  notes: string | undefined;
}

/**
 * Story 7.2 — conflict preview row passed by the parent.
 *
 * Parent issues `findConflicts({ lotId, scheduledAt })` via
 * `useQuery` whenever the form's composed `scheduledAt` changes and
 * forwards the result here. The form renders an inline warning
 * banner and disables submission while conflicts are present, so
 * the operator sees the collision BEFORE submitting (the server
 * guard inside `scheduleInterment` is the source of truth — this is
 * a UX nicety, not a substitute).
 */
export interface IntermentConflictPreview {
  intermentId: string;
  scheduledAt: number;
  occupantName: string;
  notes?: string;
  /**
   * Story 7.2 (HIGH-fix) — `"same-lot"` means this lot already has a
   * booking in the window; `"cross-lot"` means the single interment
   * crew is busy at a different lot in the window. The banner copy
   * branches on this so operators understand which kind of collision
   * they're seeing.
   */
  scope?: "same-lot" | "cross-lot";
  /** Cross-lot rows carry the other lot's code for the banner copy. */
  lotCode?: string;
}

export interface IntermentFormProps {
  /** Occupants known to belong to the target lot. Removed rows are
   *  filtered out of the select but kept on the option list so the
   *  parent can pass `listLotOccupants({ includeRemoved: true })`
   *  unchanged. */
  occupants: ReadonlyArray<IntermentOccupantOption>;
  /**
   * Parent submit handler — receives the resolved payload with
   * `scheduledAt` as epoch ms. May throw; the form translates and
   * surfaces inline.
   */
  onSubmit: (payload: IntermentSubmitPayload) => Promise<void>;
  /**
   * Optional cancel callback. Parents using a Sheet / Dialog wire
   * this to the close button.
   */
  onCancel?: () => void;
  /**
   * Optional "Add new occupant" affordance. When supplied, renders a
   * sticky button below the occupant select. Parent handles the
   * nested dialog flow.
   */
  onRequestAddOccupant?: () => void;
  /**
   * When the parent has just created a new occupant, it passes the
   * new id here so the form can auto-select it. Triggers a one-shot
   * setValue on change.
   */
  pendingOccupantSelection?: string | null;
  /**
   * Story 7.2 — list of existing scheduled interments that conflict
   * with the currently-composed `scheduledAt`. Parent computes via
   * `useQuery(api.interments.findConflicts, …)`. When `undefined`,
   * the form treats it as "not yet checked"; when an empty array,
   * "no conflicts"; when populated, the warning banner renders and
   * the submit button is disabled.
   */
  conflicts?: ReadonlyArray<IntermentConflictPreview>;
  /**
   * Story 7.2 — notifies the parent of the latest composed
   * `scheduledAt` epoch ms (or `null` while either date/time is
   * blank). Fires on every change to either input AND on blur. The
   * parent uses this to drive the `findConflicts` query argument.
   */
  onScheduledAtChange?: (scheduledAtMs: number | null) => void;
  /**
   * Story 7.2 — when `true`, the conflict warning is informational
   * only and the submit button stays enabled (reserved for admin
   * override flows). Defaults to `false` — conflicts block submit.
   */
  allowConflictOverride?: boolean;
}

const YESTERDAY_ISO = (): string => {
  const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Use local date for `min` attr — the browser's date picker shows
  // dates in the user's locale, so the comparison is in local tz.
  // Cemetery operators are physically in PH; matching local tz here
  // mirrors what the operator sees.
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export function IntermentForm({
  occupants,
  onSubmit,
  onCancel,
  onRequestAddOccupant,
  pendingOccupantSelection,
  conflicts,
  onScheduledAtChange,
  allowConflictOverride = false,
}: IntermentFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Snapshot the `min` date once per mount — re-rendering every tick is
  // wasteful and date inputs don't need second-level freshness.
  const [minDate] = useState<string>(() => YESTERDAY_ISO());

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting, isValid },
  } = useForm<IntermentFormValues>({
    resolver: zodResolver(intermentFormSchema),
    mode: "onChange",
    defaultValues: {
      occupantId: "",
      date: "",
      time: "",
      notes: "",
    },
  });

  // Auto-select a newly-created occupant the parent just inserted.
  useEffect(() => {
    if (
      pendingOccupantSelection !== null &&
      pendingOccupantSelection !== undefined &&
      pendingOccupantSelection !== ""
    ) {
      setValue("occupantId", pendingOccupantSelection, {
        shouldValidate: true,
      });
    }
  }, [pendingOccupantSelection, setValue]);

  async function handleValid(values: IntermentFormValues) {
    setSubmitError(null);
    const scheduledAt = composeScheduledAtMs(values.date, values.time);
    if (scheduledAt === null) {
      setSubmitError("Date / time combination is invalid.");
      return;
    }
    const notes =
      values.notes !== undefined && values.notes.trim().length > 0
        ? values.notes.trim()
        : undefined;
    try {
      await onSubmit({
        occupantId: values.occupantId,
        scheduledAt,
        notes,
      });
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  }

  const hasConflicts = conflicts !== undefined && conflicts.length > 0;
  const submitDisabled =
    isSubmitting || !isValid || (hasConflicts && !allowConflictOverride);
  const selectableOccupants = occupants.filter((o) => !o.isRemoved);
  const noOccupants = selectableOccupants.length === 0;
  const currentOccupantId = watch("occupantId");
  const currentDate = watch("date");
  const currentTime = watch("time");

  // Story 7.2 — notify parent whenever the composed scheduledAt changes
  // so it can drive the findConflicts query. Returns `null` until both
  // date + time are filled.
  useEffect(() => {
    if (onScheduledAtChange === undefined) return;
    if (
      currentDate === undefined ||
      currentDate === "" ||
      currentTime === undefined ||
      currentTime === ""
    ) {
      onScheduledAtChange(null);
      return;
    }
    const ms = composeScheduledAtMs(currentDate, currentTime);
    onScheduledAtChange(ms);
  }, [currentDate, currentTime, onScheduledAtChange]);

  return (
    <form
      onSubmit={handleSubmit(handleValid)}
      className="space-y-5"
      noValidate
      aria-label="Schedule interment form"
      data-testid="interment-form"
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="interment-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="interment-occupant"
          className="block text-sm font-medium text-slate-700"
        >
          Occupant
        </label>
        <select
          id="interment-occupant"
          autoFocus
          aria-required="true"
          aria-invalid={errors.occupantId !== undefined}
          aria-describedby={
            errors.occupantId !== undefined
              ? "interment-occupant-error"
              : "interment-occupant-hint"
          }
          disabled={noOccupants}
          className={cn(
            "block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            "disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400",
            errors.occupantId !== undefined && "border-red-400",
          )}
          {...register("occupantId")}
          value={currentOccupantId}
        >
          <option value="">
            {noOccupants
              ? "No occupants on this lot — add one to schedule"
              : "Select an occupant…"}
          </option>
          {selectableOccupants.map((o) => (
            <option key={o.occupantId} value={o.occupantId}>
              {o.name}
              {o.relationshipToOwner.trim().length > 0
                ? ` — ${o.relationshipToOwner}`
                : ""}
            </option>
          ))}
        </select>
        {errors.occupantId !== undefined ? (
          <p id="interment-occupant-error" className="text-xs text-red-600">
            {errors.occupantId.message}
          </p>
        ) : (
          <p id="interment-occupant-hint" className="text-xs text-slate-500">
            Occupants are scoped to this lot. Use “Add new occupant” to record
            a new one inline.
          </p>
        )}
        {onRequestAddOccupant !== undefined && (
          <button
            type="button"
            onClick={onRequestAddOccupant}
            data-testid="interment-add-occupant"
            className={cn(
              "mt-1 inline-flex min-h-[44px] items-center rounded-md border border-dashed",
              "border-slate-300 px-3 py-2 text-sm font-medium text-slate-700",
              "hover:bg-slate-50",
            )}
          >
            + Add new occupant
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="interment-date"
            className="block text-sm font-medium text-slate-700"
          >
            Date
          </label>
          <input
            id="interment-date"
            type="date"
            min={minDate}
            aria-required="true"
            aria-invalid={errors.date !== undefined}
            aria-describedby={
              errors.date !== undefined ? "interment-date-error" : undefined
            }
            className={cn(
              "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.date !== undefined && "border-red-400",
            )}
            {...register("date")}
          />
          {errors.date !== undefined && (
            <p id="interment-date-error" className="text-xs text-red-600">
              {errors.date.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label
            htmlFor="interment-time"
            className="block text-sm font-medium text-slate-700"
          >
            Time
          </label>
          <input
            id="interment-time"
            type="time"
            step={900}
            aria-required="true"
            aria-invalid={errors.time !== undefined}
            aria-describedby={
              errors.time !== undefined ? "interment-time-error" : undefined
            }
            className={cn(
              "block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.time !== undefined && "border-red-400",
            )}
            {...register("time")}
          />
          {errors.time !== undefined && (
            <p id="interment-time-error" className="text-xs text-red-600">
              {errors.time.message}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="interment-notes"
          className="block text-sm font-medium text-slate-700"
        >
          Notes (optional)
        </label>
        <textarea
          id="interment-notes"
          rows={3}
          maxLength={INTERMENT_NOTES_MAX_LENGTH}
          aria-invalid={errors.notes !== undefined}
          aria-describedby={
            errors.notes !== undefined ? "interment-notes-error" : undefined
          }
          placeholder="e.g. family will arrive 30 minutes prior"
          className={cn(
            "block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.notes !== undefined && "border-red-400",
          )}
          {...register("notes")}
        />
        {errors.notes !== undefined && (
          <p id="interment-notes-error" className="text-xs text-red-600">
            {errors.notes.message}
          </p>
        )}
      </div>

      {hasConflicts && (
        <div
          role="alert"
          data-testid="interment-form-conflicts"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p className="font-medium">
            {conflicts!.length === 1
              ? "Conflicting interment found"
              : `${conflicts!.length} conflicting interments found`}
          </p>
          <p className="mt-1 text-xs text-amber-800">
            {conflicts!.some((c) => c.scope === "cross-lot") &&
            conflicts!.some((c) => c.scope !== "cross-lot")
              ? "Another booking at this lot AND the interment crew is busy at another lot in this window."
              : conflicts!.every((c) => c.scope === "cross-lot")
                ? "The interment crew is already booked at another lot in this window."
                : "Another scheduled interment at this lot falls within the conflict window."}
            {" Adjust the date/time or cancel the existing booking before scheduling."}
          </p>
          <ul className="mt-2 list-inside list-disc text-xs">
            {conflicts!.map((c) => {
              const when = new Date(c.scheduledAt).toLocaleString("en-PH", {
                timeZone: "Asia/Manila",
                dateStyle: "medium",
                timeStyle: "short",
              });
              const suffix =
                c.scope === "cross-lot"
                  ? ` (lot ${c.lotCode ?? "—"})`
                  : "";
              return (
                <li key={c.intermentId} data-testid="interment-form-conflict-item">
                  <span className="font-medium">{c.occupantName}</span>
                  {" — "}
                  {when}
                  {suffix}
                </li>
              );
            })}
          </ul>
          {allowConflictOverride && (
            <p className="mt-2 text-xs italic text-amber-700">
              Override is enabled: submit will proceed despite the
              conflict. Confirm with operations before continuing.
            </p>
          )}
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
          data-testid="interment-form-submit"
          className={cn(
            "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
            "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isSubmitting ? "Scheduling…" : "Schedule interment"}
        </button>
      </div>
    </form>
  );
}
