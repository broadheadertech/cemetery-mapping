"use client";

/**
 * FollowUpActionForm — Story 4.2.
 *
 * Form for office staff (or admin) to attach a logged follow-up action
 * to an overdue installment. RHF + Zod; presentational + validation-only
 * — the parent owns the Convex mutation call.
 *
 * Fields (Story 4.2 AC2):
 *   - Action (select: phone call / SMS / letter / in person / other).
 *     Default is "phone_call" — the dominant channel for first-touch
 *     missed-payment recovery in the Filipino cemetery context.
 *   - Due date (`<input type="date">`) — default today in Manila tz,
 *     `min` attribute set to today so the operator cannot pick a past
 *     date. Server is the authority.
 *   - Notes (`<textarea>`, optional, max 500 chars).
 *
 * Submit button copy is "Log follow-up" — deliberately not "Save" or
 * "Submit", which lose the operational intent.
 *
 * UX guardrails (Story 4.2 § Disaster prevention):
 *   - No optimistic update; Convex's reactive subscription is fast
 *     enough that Maria sees the new row land within ~50ms.
 *   - On server error, render the translated sentence inline with
 *     `role="alert"` — never a toast (UX § Form Patterns).
 *   - Submit button stays disabled while pending so a double-click
 *     does not double-insert.
 */

import { useId, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  FOLLOW_UP_ACTIONS,
  FOLLOW_UP_ACTION_LABELS,
  FOLLOW_UP_NOTES_MAX_LENGTH,
  followUpActionFormSchema,
  parseDueAtToMs,
  todayInManila,
  type FollowUpActionChannel,
  type FollowUpActionFormValues,
} from "./schema";

export interface FollowUpSubmitPayload {
  /** Epoch ms (UTC) — midnight Manila tz of the picked date. */
  dueAt: number;
  /** One of the controlled channels. */
  action: FollowUpActionChannel;
  /** Operator-supplied annotation; absent when blank. */
  notes?: string;
}

export interface FollowUpActionFormProps {
  /** Parent submit handler — receives the resolved payload. */
  onSubmit: (payload: FollowUpSubmitPayload) => Promise<void>;
  /** Optional cancel affordance (closes the parent surface). */
  onCancel?: () => void;
}

export function FollowUpActionForm({
  onSubmit,
  onCancel,
}: FollowUpActionFormProps) {
  const errorId = useId();
  const notesId = useId();
  const today = useMemo(() => todayInManila(), []);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    watch,
  } = useForm<FollowUpActionFormValues>({
    resolver: zodResolver(followUpActionFormSchema),
    defaultValues: {
      action: "phone_call",
      dueAt: today,
      notes: "",
    },
  });

  const notesValue = watch("notes") ?? "";

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    const dueAtMs = parseDueAtToMs(values.dueAt);
    if (dueAtMs === null) {
      setSubmitError("Due date is required (YYYY-MM-DD).");
      return;
    }
    const trimmedNotes =
      values.notes !== undefined ? values.notes.trim() : "";
    const payload: FollowUpSubmitPayload = {
      dueAt: dueAtMs,
      action: values.action,
    };
    if (trimmedNotes.length > 0) {
      payload.notes = trimmedNotes;
    }
    try {
      await onSubmit(payload);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not log follow-up.";
      setSubmitError(message);
    }
  });

  return (
    <form
      onSubmit={submit}
      data-testid="follow-up-action-form"
      className="space-y-4"
      noValidate
    >
      <div>
        <label
          htmlFor="follow-up-action"
          className="block text-sm font-medium text-slate-700"
        >
          Action
        </label>
        <select
          id="follow-up-action"
          {...register("action")}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          data-testid="follow-up-action-select"
        >
          {FOLLOW_UP_ACTIONS.map((channel) => (
            <option key={channel} value={channel}>
              {FOLLOW_UP_ACTION_LABELS[channel]}
            </option>
          ))}
        </select>
        {errors.action !== undefined && (
          <p className="mt-1 text-xs text-red-700">
            {errors.action.message}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="follow-up-due-at"
          className="block text-sm font-medium text-slate-700"
        >
          Due date
        </label>
        <input
          id="follow-up-due-at"
          type="date"
          min={today}
          {...register("dueAt")}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          data-testid="follow-up-due-at-input"
        />
        {errors.dueAt !== undefined && (
          <p className="mt-1 text-xs text-red-700">{errors.dueAt.message}</p>
        )}
      </div>

      <div>
        <label
          htmlFor={notesId}
          className="block text-sm font-medium text-slate-700"
        >
          Notes <span className="text-xs text-slate-400">(optional)</span>
        </label>
        <textarea
          id={notesId}
          rows={3}
          maxLength={FOLLOW_UP_NOTES_MAX_LENGTH}
          {...register("notes")}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          data-testid="follow-up-notes-input"
          placeholder="e.g. Called, will pay Friday"
        />
        <div className="mt-1 flex items-center justify-between">
          {errors.notes !== undefined ? (
            <p className="text-xs text-red-700">{errors.notes.message}</p>
          ) : (
            <span />
          )}
          <span className="text-xs text-slate-400 tabular-nums">
            {notesValue.length}/{FOLLOW_UP_NOTES_MAX_LENGTH}
          </span>
        </div>
      </div>

      {submitError !== null && (
        <div
          id={errorId}
          role="alert"
          data-testid="follow-up-form-error"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            data-testid="follow-up-form-cancel"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="follow-up-form-submit"
        >
          {isSubmitting ? "Logging…" : "Log follow-up"}
        </button>
      </div>
    </form>
  );
}
