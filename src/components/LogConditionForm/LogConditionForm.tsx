"use client";

/**
 * LogConditionForm — Story 1.14.
 *
 * Mobile-first form for field workers logging an observation about a
 * lot. Renders a textarea (required, ≤ 2000 chars) + optional photo
 * capture (native camera on mobile via `capture="environment"`) +
 * read-only auto-timestamp + submit button.
 *
 * The form is presentational + validation-only:
 *   - The parent owns the Convex mutation calls. We surface two
 *     callbacks: `generateUploadUrl` (for the two-step photo upload)
 *     and `onSubmit` (the validated payload).
 *   - This keeps the form testable without a Convex client mock.
 *
 * Network-state gate (AC4 — no offline writes):
 *   - The `isOnline` prop disables submit and shows an inline
 *     "Posting requires connection" message when false. We DO NOT
 *     queue offline writes anywhere (architecture invariant from
 *     Story 1.13 — the PWA caches reads only).
 *   - Composing the form offline is allowed (the user may want to
 *     type the note while waiting for signal). Only the submit is
 *     blocked.
 *
 * Idempotency:
 *   - `useIdempotencyKey()` returns a UUID stable across re-renders
 *     of this mount. We pass it into every submit so a retried submit
 *     (network blip, double-tap) is deduplicated server-side.
 *
 * UX guardrails honoured here (Story 1.14 § Disaster prevention):
 *   - No template auto-fill ("Lot in good condition"). Empty start.
 *   - No confirmation modal on submit. Reactive flash + new entry IS
 *     the confirmation.
 *   - No success toast.
 *   - Photo optional (Junior may have a dying battery).
 *   - `URL.revokeObjectURL` called on remove + unmount to free the
 *     blob memory.
 */

import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { X } from "lucide-react";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { useIdempotencyKey } from "@/hooks/useIdempotencyKey";

import {
  logConditionFormSchema,
  PHOTO_MAX_BYTES,
  type LogConditionFormValues,
} from "./schema";

export interface LogConditionSubmitPayload {
  note: string;
  /**
   * Resolved `Id<"_storage">` from the two-step upload. The parent
   * runs the upload via `generateUploadUrl`; the form passes the
   * resulting id (or `undefined`) into this payload.
   */
  photoStorageId?: string;
  /** Stable across the form mount; the server dedups by this. */
  idempotencyKey: string;
}

export interface LogConditionFormProps {
  /**
   * Whether the network is currently considered online. The form
   * disables submit and shows an inline note when false.
   */
  isOnline: boolean;
  /**
   * Returns a short-lived Convex File Storage upload URL. Called only
   * when the user has selected a photo; if the photo upload fails,
   * the form surfaces an inline error and does NOT call `onSubmit`.
   */
  generateUploadUrl: () => Promise<string>;
  /**
   * Parent-supplied submit handler. Receives the validated payload
   * including the resolved `photoStorageId` (if a photo was uploaded)
   * and the idempotency key. May throw — the form translates the
   * error and surfaces it inline.
   */
  onSubmit: (payload: LogConditionSubmitPayload) => Promise<void>;
  /**
   * Called when the user explicitly cancels (e.g. Sheet close button
   * pressed). Optional; the Sheet's own close affordance can also
   * call this directly.
   */
  onCancel?: () => void;
}

const FORMATTER = new Intl.DateTimeFormat("en-PH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Manila",
});

function formatManilaTimestamp(epochMs: number): string {
  return `${FORMATTER.format(new Date(epochMs))} (Manila)`;
}

export function LogConditionForm({
  isOnline,
  generateUploadUrl,
  onSubmit,
  onCancel,
}: LogConditionFormProps) {
  const idempotencyKey = useIdempotencyKey();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoPreviewUrl = useRef<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  // The "now" timestamp displayed under the form. It refreshes on
  // mount; we don't tick it every second because (a) the field
  // worker should see the moment they opened the form, and (b)
  // animation-free static text is calmer on the eye.
  const [openedAt] = useState<number>(() => Date.now());

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LogConditionFormValues>({
    resolver: zodResolver(logConditionFormSchema),
    defaultValues: { note: "" },
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
    if (file.size > PHOTO_MAX_BYTES) {
      setPhotoError("Photo must be 10 MB or smaller.");
      // Reset the input so the user can pick a different file.
      e.target.value = "";
      return;
    }
    // Clear any previous preview before allocating a new one.
    if (photoPreviewUrl.current !== null) {
      URL.revokeObjectURL(photoPreviewUrl.current);
    }
    const url = URL.createObjectURL(file);
    photoPreviewUrl.current = url;
    setPhotoFile(file);
    setPhotoPreview(url);
    setPhotoError(null);
  }

  async function handleValid(values: LogConditionFormValues) {
    setSubmitError(null);
    if (!isOnline) {
      setSubmitError("Posting requires connection. Reconnect and try again.");
      return;
    }
    try {
      let photoStorageId: string | undefined = undefined;
      if (photoFile !== null) {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": photoFile.type || "application/octet-stream" },
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
        note: values.note.trim(),
        photoStorageId,
        idempotencyKey,
      });
      // Don't clear the form here — parent typically closes the Sheet
      // on success; on remount we get a fresh form.
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
      aria-label="Log lot condition form"
      data-testid="log-condition-form"
    >
      {!isOnline && (
        <div
          role="status"
          data-testid="log-condition-offline-banner"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          Posting requires connection. Reconnect and try again.
        </div>
      )}

      {submitError !== null && (
        <div
          role="alert"
          data-testid="log-condition-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="condition-note"
          className="block text-sm font-medium text-slate-700"
        >
          What did you observe?
        </label>
        <textarea
          id="condition-note"
          rows={3}
          aria-required="true"
          aria-invalid={errors.note !== undefined}
          aria-describedby={
            errors.note !== undefined ? "condition-note-error" : "condition-note-hint"
          }
          placeholder="e.g. Fresh flowers placed, fallen branch removed, needs cleaning"
          className={cn(
            "block w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.note !== undefined && "border-red-400",
          )}
          {...register("note")}
        />
        {errors.note !== undefined ? (
          <p id="condition-note-error" className="text-xs text-red-600">
            {errors.note.message}
          </p>
        ) : (
          <p id="condition-note-hint" className="text-xs text-slate-500">
            Do not include customer names or ID numbers — those are tracked on
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
            htmlFor="condition-photo"
            className={cn(
              "inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center",
              "rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700",
              "hover:bg-slate-50 focus-within:ring-2 focus-within:ring-slate-500 focus-within:ring-offset-2",
            )}
          >
            Take or choose photo
            <input
              id="condition-photo"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPhotoChange}
              className="sr-only"
              data-testid="condition-photo-input"
            />
          </label>
        ) : (
          <div className="flex items-start gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoPreview}
              alt="Photo preview"
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
          <p className="text-xs text-red-600" data-testid="condition-photo-error">
            {photoError}
          </p>
        )}
      </div>

      <p className="text-xs text-slate-500 tabular-nums">
        Logged at {formatManilaTimestamp(openedAt)}
      </p>

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
          data-testid="log-condition-submit"
          className={cn(
            "min-h-[44px] rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white",
            "hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {isSubmitting ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  );
}
