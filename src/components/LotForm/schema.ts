/**
 * Zod schema for the lot create / edit form — Story 1.8.
 *
 * The form takes peso strings from the user and converts to centavos
 * at submit time. The Zod schema therefore validates the *display*
 * shape: peso strings, width/depth as positive numbers, code in
 * upper-case alphanumeric + hyphens.
 *
 * Server-side validation (`convex/lots.ts → validateLotPayload`) is
 * authoritative; this schema gives the user immediate inline feedback
 * before submit.
 */

import { z } from "zod";

import { pesosToCents } from "@/lib/money";

const LOT_TYPES = ["single", "family", "mausoleum", "niche"] as const;
export type LotType = (typeof LOT_TYPES)[number];

/**
 * Minimum sanity floor for `basePrice`: ₱100 (10,000 centavos). The
 * server's floor is just "> 0" so admin tooling can seed cheap test
 * data; the UI surface enforces the more realistic minimum.
 */
const MIN_PRICE_CENTS = 100_00;

export const lotFormSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Code is required.")
    .max(32, "Code is too long (max 32 characters).")
    .regex(
      /^[A-Z0-9-]+$/,
      "Code must be uppercase letters, numbers, and hyphens only.",
    ),
  // Story 1.15 — Section is now selected from the named-sections
  // registry. `sectionId` is the FK the server stores; `section`
  // remains as the legacy free-text label (populated from the
  // selected section's `displayName` so the existing
  // `by_section_block` index continues to function until the
  // legacy column is dropped).
  sectionId: z.string().trim().min(1, "Section is required."),
  // Legacy free-text label — kept as an OPTIONAL field on the form
  // because the dropdown now drives the canonical FK. The form's
  // submit handler resolves the selected section's `displayName` and
  // forwards it as the `section` string so Story 1.8's by_section_block
  // index keeps working until the legacy column is dropped.
  section: z.string().trim().optional(),
  block: z.string().trim().min(1, "Block is required."),
  row: z.string().trim().min(1, "Row is required."),
  type: z.enum(LOT_TYPES),
  widthM: z
    .number({ message: "Width is required." })
    .positive("Width must be positive."),
  depthM: z
    .number({ message: "Depth is required." })
    .positive("Depth must be positive."),
  basePrice: z
    .string()
    .trim()
    .min(1, "Base price is required.")
    .refine((s) => {
      const cents = pesosToCents(s);
      return Number.isFinite(cents) && cents >= MIN_PRICE_CENTS;
    }, "Base price must be at least ₱100.00."),
});

export type LotFormValues = z.infer<typeof lotFormSchema>;

/**
 * Re-export for callers wiring a `<RadioGroup>` of lot types.
 */
export { LOT_TYPES };
