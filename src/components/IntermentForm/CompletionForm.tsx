"use client";

/**
 * CompletionForm — Story 7.4.
 *
 * Mobile-first form for the field worker to mark a scheduled interment
 * as complete. Renders:
 *   - Read-only "Completed at" timestamp (auto-now at sheet open;
 *     server clamps to actual submit time)
 *   - Optional notes textarea (≤ 500 chars, mirrors server cap)
 *   - Optional photo capture (native camera on mobile via
 *     `capture="environment"`)
 *   - Submit / cancel buttons sized for gloved hands (≥ 44×44px)
 *
 * Presentational + validation-only — the parent owns the Convex
 * `completeInterment` + `generateUploadUrl` mutations. The form
 * surfaces two callbacks: `generateUploadUrl` (for the two-step photo
 * upload) and `onSubmit` (the validated payload).
 *
 * Inherits Story 1.14's mobile UX patterns: large fonts, generous
 * spacing, gloves-on usability, optional photo with camera capture.
 * Story 7.4 § Dev Notes calls out "Follow Story 1.14's UX choices
 * verbatim" — this file is a deliberate sibling of
 * `LogConditionForm.tsx`.
 *
 * UX guardrails honoured here (Story 7.4 § Disaster prevention):
 *   - Photo is optional (operator may not have consent / battery).
 *   - No success toast on submit — parent closes the sheet, reactive
 *     calendar update IS the affordance (UX § Calm Reactivity).
 *   - `URL.revokeObjectURL` called on remove + unmount.
 *   - 500-char notes cap matches server validator.
 */

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";

import {
  completionFormSchema,
  COMPLETION_NOTES_MAX_LENGTH,
  COMPLETION_PHOTO_MAX_BYTES,
  type CompletionFormValues,
} from "./completionSchema";

export interface CompletionSubmitPayload {
  /** Trimmed completion notes; `undefined` when blank. */
  notes: string | undefined;
  /**
   * Resolved `Id<"_storage">` from the two-step upload. The parent
   * runs the upload via `generateUploadUrl`; the form passes the
   * resulting id (or `undefined`) into this payload.
   */
  photoStorageId: string | undefined;
}

export interface CompletionFormProps {
  /** Occupant name for the read-only context header. */
  occupantName: string;
  /** Lot code (e.g. "D-5-12") for the read-only context header. */
  lotCode: string;
  /**
   * Scheduled time (epoch ms) — displayed read-only so the operator
   * sees the planned moment alongside the actual completion time.
   */
  scheduledAt: number;
  /**
   * Returns a short-lived Convex File Storage upload URL. Called only
   * when the user has selected a photo; if the photo upload fails,
   * the form surfaces an inline error and does NOT call `onSubmit`.
   */
  generateUploadUrl: () => Promise<string>;
  /**
   * Parent-supplied submit handler. Receives the validated payload
   * including the resolved `photoStorageId` (if a photo was uploaded).
   * May throw — the form translates the error and surfaces inline.
   */
  onSubmit: (payload: CompletionSubmitPayload) => Promise<void>;
  /** Optional cancel callback (Sheet close button). */
  onCancel?: () => void;
}

const FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

function formatManila(epochMs: number): string {
  return `${FORMATTER.format(new Date(epochMs))} (Manila)`;
}

export function CompletionForm({
  occupantName,
  lotCode,
  scheduledAt,
  generateUploadUrl,
  onSubmit,
  onCancel,
}: CompletionFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoPreviewUrl = useRef<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  // "Completed at" timestamp — captured at sheet open and refreshed
  // every 30 seconds while the form is open. The actual `completedAt`
  // stored on the row is `Date.now()` at submit time on the server;
  // the displayed value is illustrative.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CompletionFormValues>({
    resolver: zodResolver(completionFormSchema),
    defaultValues: { notes: "" },
  });

  // Revoke any preview blob URL on unmount to free memory.
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
    if (file.size > COMPLETION_PHOTO_MAX_BYTES) {
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

  async function handleValid(values: CompletionFormValues) {
    setSubmitError(null);
    try {
      let photoStorageId: string | undefined = undefined;
      if (photoFile !== null) {
        try {
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
        } catch {
          // Surface inline; let the operator decide whether to retry
          // or submit without the photo. Per § Disaster prevention:
          // "upload failure → inline error renders; submit still
          // works without photo."
          setPhotoError(
            "Photo upload failed — try again, or submit without a photo.",
          );
          return;
        }
      }
      const trimmed =
        values.notes !== undefined && values.notes.trim().length > 0
          ? values.notes.trim()
          : undefined;
      await onSubmit({
        notes: trimmed,
        photoStorageId,
      });
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(handleValid)}
      className="space-y-5"
      noValidate
      aria-label="Mark interment complete form"
      data-testid="completion-form"
    >
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
        <p className="font-medium text-slate-900">{occupantName}</p>
        <p className="text-slate-600">Lot {lotCode}</p>
        <p
          className="mt-1 text-xs text-slate-500 tabular-nums"
          data-testid="completion-scheduled-at"
        >
          Scheduled for {formatManila(scheduledAt)}
        </p>
      </div>

      {submitError !== null && (
        <div
          role="alert"
          data-testid="completion-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="completion-notes"
          className="block text-sm font-medium text-slate-700"
        >
          Notes (optional)
        </label>
        <textarea
          id="completion-notes"
          rows={3}
          maxLength={COMPLETION_NOTES_MAX_LENGTH}
          aria-invalid={errors.notes !== undefined}
          aria-describedby={
            errors.notes !== undefined
              ? "completion-notes-error"
              : "completion-notes-hint"
          }
          placeholder="e.g. Family arrived on time; brief ceremony completed."
          className={cn(
            "block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-base",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.notes !== undefined && "border-red-400",
          )}
          {...register("notes")}
        />
        {errors.notes !== undefined ? (
          <p id="completion-notes-error" className="text-xs text-red-600">
            {errors.notes.message}
          </p>
        ) : (
          <p id="completion-notes-hint" className="text-xs text-slate-500">
            Do not include sensitive personal details — those belong on
            the customer record.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium text-slate-700">
          Photo (optional)
        </span>
        {photoPreview === null ? (
          <label
            htmlFor="completion-photo"
            className={cn(
              "inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center",
              "rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700",
              "hover:bg-slate-50 focus-within:ring-2 focus-within:ring-slate-500 focus-within:ring-offset-2",
            )}
          >
            Take or choose photo
            <input
              id="completion-photo"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPhotoChange}
              className="sr-only"
              data-testid="completion-photo-input"
            />
          </label>
        ) : (
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoPreview}
              alt="Completion photo preview"
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
          <p
            className="text-xs text-red-600"
            role="alert"
            data-testid="completion-photo-error"
          >
            {photoError}
          </p>
        )}
      </div>

      <p
        className="text-xs text-slate-500 tabular-nums"
        data-testid="completion-now"
      >
        Completing at {formatManila(nowMs)}
      </p>

      <div className="flex items-center justify-end gap-3 pt-2">
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            data-testid="completion-cancel"
            className="min-h-[44px] rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          aria-disabled={isSubmitting}
          data-testid="completion-submit"
          className={cn(
            "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-base font-medium text-white",
            "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isSubmitting ? "Marking complete…" : "Mark complete"}
        </button>
      </div>
    </form>
  );
}
