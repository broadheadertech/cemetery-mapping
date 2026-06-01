/**
 * Zod schema for the LogConditionForm — Story 1.14.
 *
 * Client-side validation that mirrors `convex/conditionLogs.ts →
 * logLotCondition`'s server validator. Server is authoritative; this
 * schema gives the user immediate inline feedback before submit.
 *
 * Photo file is OPTIONAL by FR13 ("photo if available"). When present
 * it must be ≤ 10 MB — large enough for a phone-camera JPEG, small
 * enough that the upload completes in a couple of seconds on a 4G
 * connection.
 */

import { z } from "zod";

/** Server cap: 2000 chars. Mirrored here for inline error copy. */
export const NOTE_MAX_LENGTH = 2000;

/** Client cap: 10 MB. Prevents accidental 100-MB raw photo uploads. */
export const PHOTO_MAX_BYTES = 10_000_000;

export const logConditionFormSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1, "Note is required.")
    .max(NOTE_MAX_LENGTH, `Note is too long (max ${NOTE_MAX_LENGTH} characters).`),
});

export type LogConditionFormValues = z.infer<typeof logConditionFormSchema>;
