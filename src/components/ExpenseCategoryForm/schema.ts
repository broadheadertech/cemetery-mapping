/**
 * Zod schema for the expense category create / edit form — Story 4.7.
 *
 * Server-side validation in `convex/expenseCategories.ts` is
 * authoritative. The client schema mirrors the limits so the admin
 * gets immediate inline feedback before submit.
 */

import { z } from "zod";

export const CATEGORY_NAME_MAX_LENGTH = 50;
export const CATEGORY_DESCRIPTION_MAX_LENGTH = 200;

export const expenseCategoryFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(
      CATEGORY_NAME_MAX_LENGTH,
      `Name is too long (max ${CATEGORY_NAME_MAX_LENGTH} characters).`,
    ),
  description: z
    .string()
    .trim()
    .max(
      CATEGORY_DESCRIPTION_MAX_LENGTH,
      `Description is too long (max ${CATEGORY_DESCRIPTION_MAX_LENGTH} characters).`,
    )
    .optional()
    .or(z.literal("")),
});

export type ExpenseCategoryFormValues = z.infer<
  typeof expenseCategoryFormSchema
>;
