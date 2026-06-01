/**
 * Zod schema for the OccupantForm — Story 2.6.
 *
 * Client-side validation that mirrors `convex/occupants.ts →
 * addOccupant`'s server validator. Server is authoritative; this
 * schema provides immediate inline feedback before submit.
 *
 * Field caps mirror the constants exported from `convex/occupants.ts`.
 * Keep them in sync by convention; both layers throw VALIDATION
 * errors when the cap is exceeded.
 *
 * `dateOfInterment` is optional end-to-end (§10 Q4 legacy data):
 * the form's "Date unknown" checkbox clears the date input and
 * submits `undefined`. Convex's `v.optional` accepts `undefined`
 * only — never `null` or `0`.
 */

import { z } from "zod";

export const OCCUPANT_NAME_MIN_LENGTH = 2;
export const OCCUPANT_NAME_MAX_LENGTH = 200;
export const OCCUPANT_RELATIONSHIP_MAX_LENGTH = 100;
export const OCCUPANT_NOTES_MAX_LENGTH = 1000;

export const occupantFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(OCCUPANT_NAME_MIN_LENGTH, "Name is required (at least 2 characters).")
      .max(
        OCCUPANT_NAME_MAX_LENGTH,
        `Name must be ${OCCUPANT_NAME_MAX_LENGTH} characters or fewer.`,
      ),
    relationshipToOwner: z
      .string()
      .trim()
      .min(1, "Relationship to owner is required.")
      .max(
        OCCUPANT_RELATIONSHIP_MAX_LENGTH,
        `Relationship must be ${OCCUPANT_RELATIONSHIP_MAX_LENGTH} characters or fewer.`,
      ),
    /**
     * ISO-style `YYYY-MM-DD` from the native date picker. Empty
     * string is treated as "no date supplied" — the parent
     * `dateUnknown` flag is the canonical signal but a date input
     * that the user cleared with no checkbox flip lands here as `""`.
     */
    dateOfInterment: z
      .string()
      .max(20, "Date of interment is malformed.")
      .optional(),
    dateUnknown: z.boolean(),
    notes: z
      .string()
      .trim()
      .max(
        OCCUPANT_NOTES_MAX_LENGTH,
        `Notes must be ${OCCUPANT_NOTES_MAX_LENGTH} characters or fewer.`,
      )
      .optional(),
  })
  .superRefine((values, ctx) => {
    if (!values.dateUnknown) {
      const v = values.dateOfInterment;
      if (v === undefined || v.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateOfInterment"],
          message: "Date of interment is required (or check Date unknown).",
        });
        return;
      }
      const parsed = Date.parse(v);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateOfInterment"],
          message: "Date of interment is not a valid date.",
        });
        return;
      }
      // Same future-tolerance check the server applies (1 day skew).
      if (parsed > Date.now() + 24 * 60 * 60 * 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateOfInterment"],
          message: "Date of interment cannot be in the future.",
        });
      }
    }
  });

export type OccupantFormValues = z.infer<typeof occupantFormSchema>;
