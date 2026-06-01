/**
 * Client-side Zod schema for the plaque form (Story 6.8).
 *
 * Mirrors the server-side validators in
 * `convex/plaqueDrafts.ts:requestPlaqueDraft`. Server is the source
 * of truth — these client checks gate the submit button + render
 * inline errors before the network round-trip.
 */

import { z } from "zod";

/** Brand-system maximum epitaph length (chars). Mirrors
 *  `convex/plaqueDrafts.ts:PLAQUE_EPITAPH_MAX_LENGTH`. */
export const PLAQUE_EPITAPH_MAX_LENGTH = 240;

/** Earliest acceptable year for born / died. Mirrors
 *  `convex/plaqueDrafts.ts:PLAQUE_MIN_YEAR`. */
export const PLAQUE_MIN_YEAR = 1800;

/** Build the live-current max year from the supplied "now" timestamp
 *  (test-friendly — vitest can pass a frozen Date). */
export function maxAcceptableYear(nowMs: number = Date.now()): number {
  return new Date(nowMs).getUTCFullYear() + 1;
}

/**
 * Build the form's Zod schema. Factory-shaped so the test suite can
 * freeze the max-year boundary at a known reference moment.
 */
export function plaqueFormSchema(nowMs: number = Date.now()) {
  const yearMax = maxAcceptableYear(nowMs);
  return z
    .object({
      deceasedName: z
        .string()
        .trim()
        .min(1, "Deceased name is required.")
        .max(200, "Deceased name must be 200 characters or fewer."),
      bornYear: z
        .number()
        .int("Born year must be a whole number.")
        .min(PLAQUE_MIN_YEAR, `Born year must be ${PLAQUE_MIN_YEAR} or later.`)
        .max(yearMax, `Born year must be ${yearMax} or earlier.`),
      diedYear: z
        .number()
        .int("Died year must be a whole number.")
        .min(PLAQUE_MIN_YEAR, `Died year must be ${PLAQUE_MIN_YEAR} or later.`)
        .max(yearMax, `Died year must be ${yearMax} or earlier.`),
      dateFormat: z.enum(["arabic", "roman"]),
      epitaph: z
        .string()
        .max(
          PLAQUE_EPITAPH_MAX_LENGTH,
          `Epitaph must be ${PLAQUE_EPITAPH_MAX_LENGTH} characters or fewer.`,
        )
        .optional(),
    })
    .refine((data) => data.bornYear < data.diedYear, {
      message: "Born year must be earlier than died year.",
      path: ["diedYear"],
    });
}

export type PlaqueFormValues = z.infer<ReturnType<typeof plaqueFormSchema>>;
