/**
 * Zod schema for the CompletionForm — Story 7.4.
 *
 * Client-side validation that mirrors `convex/interments.ts →
 * completeInterment`'s server validator. Server is authoritative; this
 * schema provides immediate inline feedback before submit.
 */

import { z } from "zod";

/** Notes cap — mirrors `convex/interments.ts:COMPLETION_NOTES_MAX_LENGTH`. */
export const COMPLETION_NOTES_MAX_LENGTH = 500;

/**
 * Photo size cap (10 MB, matches `LogConditionForm`). Convex File
 * Storage's hard ceiling is well above this; the client cap keeps
 * mobile uploads from saturating cellular networks and matches the
 * Story 1.14 precedent so operators see consistent constraints.
 */
export const COMPLETION_PHOTO_MAX_BYTES = 10_000_000;

export const completionFormSchema = z.object({
  notes: z
    .string()
    .trim()
    .max(
      COMPLETION_NOTES_MAX_LENGTH,
      `Notes must be ${COMPLETION_NOTES_MAX_LENGTH} characters or fewer.`,
    )
    .optional(),
});

export type CompletionFormValues = z.infer<typeof completionFormSchema>;
