/**
 * Zod schema for the expense approval threshold form — Story 6.6.
 *
 * Server-side validation in
 * `convex/expenseApprovalSettings.ts::setExpenseApprovalSetting` is
 * authoritative. The client schema mirrors the limits so the admin
 * gets immediate inline feedback before submit.
 *
 * The form accepts the threshold as a peso amount (display-friendly)
 * but the parent component multiplies by 100 to send centavos to the
 * server. The schema validates the display form (non-negative,
 * integer pesos for Phase 1 — centavo-granular thresholds are not
 * useful operationally).
 */

import { z } from "zod";

export const THRESHOLD_PESOS_MAX = 100_000_000; // ₱100M ceiling, well above any operational threshold.

export const expenseApprovalSettingsFormSchema = z.object({
  category: z
    .string()
    .trim()
    .min(1, "Category is required."),
  thresholdPesos: z
    .number({ message: "Threshold must be a number." })
    .int("Threshold must be a whole peso amount.")
    .min(0, "Threshold must be zero or positive.")
    .max(THRESHOLD_PESOS_MAX, "Threshold is too large."),
  requiresApproval: z.boolean(),
});

export type ExpenseApprovalSettingsFormValues = z.infer<
  typeof expenseApprovalSettingsFormSchema
>;
