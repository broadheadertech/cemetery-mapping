/**
 * Zod schema for the named-section create / edit form — Story 1.15.
 *
 * Server-side validation in `convex/sections.ts` is authoritative.
 * The client schema mirrors the limits so the admin gets immediate
 * inline feedback before submit.
 */

import { z } from "zod";

export const SECTION_NAME_MAX_LENGTH = 64;
export const SECTION_DISPLAY_NAME_MAX_LENGTH = 80;
export const SECTION_DESCRIPTION_MAX_LENGTH = 2000;

export const SECTION_KINDS = [
  "chapel",
  "family",
  "standard",
  "niche",
  "columbarium",
] as const;

export type SectionKind = (typeof SECTION_KINDS)[number];

export const sectionFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(
      SECTION_NAME_MAX_LENGTH,
      `Name is too long (max ${SECTION_NAME_MAX_LENGTH} characters).`,
    )
    .regex(
      /^[a-z0-9-]+$/,
      "Name must be lowercase letters, numbers, and hyphens only (kebab-case).",
    ),
  displayName: z
    .string()
    .trim()
    .min(1, "Display name is required.")
    .max(
      SECTION_DISPLAY_NAME_MAX_LENGTH,
      `Display name is too long (max ${SECTION_DISPLAY_NAME_MAX_LENGTH} characters).`,
    ),
  sortOrder: z
    .number({ message: "Sort order is required." })
    .int("Sort order must be an integer.")
    .min(0, "Sort order must be 0 or greater."),
  kind: z.enum(SECTION_KINDS),
  descriptionMarkdown: z
    .string()
    .trim()
    .max(
      SECTION_DESCRIPTION_MAX_LENGTH,
      `Description is too long (max ${SECTION_DESCRIPTION_MAX_LENGTH} characters).`,
    )
    .optional()
    .or(z.literal("")),
});

export type SectionFormValues = z.infer<typeof sectionFormSchema>;
