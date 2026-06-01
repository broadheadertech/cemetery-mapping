/**
 * Zod schema for the customer create form — Story 2.1.
 *
 * Server-side validation in `convex/customers.ts → create` is
 * authoritative; this schema gives the user immediate inline
 * feedback before submit. Architecture § 545–547 (defense in depth).
 *
 * The schema is co-located with the component
 * (`src/components/CustomerForm/`) rather than in `src/lib/schemas/`
 * — composite-component pattern from architecture §475.
 */

import { z } from "zod";

/**
 * Government ID types. Mirrors the union in `convex/schema.ts` and
 * `convex/customers.ts:GovIdType`. The order here drives the
 * Select's display order in `CustomerForm`.
 *
 * Labels:
 *   - "sss"             — Social Security System
 *   - "tin"             — Tax Identification Number (BIR)
 *   - "umid"            — Unified Multi-Purpose ID
 *   - "drivers_license" — Driver's License
 *   - "passport"        — Philippine Passport
 *   - "philhealth"      — PhilHealth Member ID
 *   - "voters_id"       — Voter's ID
 *   - "other"           — Anything else (free-text in the description)
 */
export const GOV_ID_TYPE_OPTIONS = [
  "sss",
  "tin",
  "umid",
  "drivers_license",
  "passport",
  "philhealth",
  "voters_id",
  "other",
] as const;
export type GovIdType = (typeof GOV_ID_TYPE_OPTIONS)[number];

export const GOV_ID_TYPE_LABELS: Record<GovIdType, string> = {
  sss: "SSS",
  tin: "TIN (BIR)",
  umid: "UMID",
  drivers_license: "Driver's License",
  passport: "Passport",
  philhealth: "PhilHealth",
  voters_id: "Voter's ID",
  other: "Other",
};

/**
 * Loose PH phone regex. Accepts:
 *   - `09XX-XXX-XXXX` / `09XXXXXXXXX` (mobile, local form)
 *   - `+639XXXXXXXXX` (mobile, international form)
 *   - `(02) 8XXX-XXXX` (Metro Manila landline)
 *   - blank / undefined (the field is optional)
 *
 * The regex is intentionally permissive — Filipinos write numbers in
 * many shapes, and the server stores the value verbatim for human
 * recognition. Stricter parsing (via libphonenumber-js) lands in
 * Story 9.4 when SMS reminders ship.
 */
const PH_PHONE_REGEX = /^[+()0-9\s-]{7,20}$/;

export const customerFormSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Full name is required (min 2 characters).")
    .max(200, "Full name is too long (max 200 characters)."),
  phone: z
    .string()
    .trim()
    .max(40, "Phone number is too long.")
    .refine(
      (val) => val.length === 0 || PH_PHONE_REGEX.test(val),
      "Enter a valid phone number (e.g. 09XX-XXX-XXXX).",
    )
    .optional()
    .or(z.literal("")),
  email: z
    .string()
    .trim()
    .max(254, "Email is too long.")
    .refine(
      (val) =>
        val.length === 0 ||
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val),
      "Enter a valid email address.",
    )
    .optional()
    .or(z.literal("")),
  addressLine1: z
    .string()
    .trim()
    .min(1, "Address line 1 is required.")
    .max(200, "Address line 1 is too long."),
  barangay: z.string().trim().max(120).optional().or(z.literal("")),
  cityMunicipality: z.string().trim().max(120).optional().or(z.literal("")),
  province: z.string().trim().max(120).optional().or(z.literal("")),
  postalCode: z.string().trim().max(20).optional().or(z.literal("")),
  govIdType: z.enum(GOV_ID_TYPE_OPTIONS),
  govIdNumber: z
    .string()
    .trim()
    .min(4, "Government ID number is required (min 4 characters).")
    .max(64, "Government ID number is too long."),
  relationshipToOccupant: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal("")),
  hasConsent: z.boolean(),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

/**
 * Empty defaults for the create flow. `govIdType` defaults to
 * `"sss"` per AC3 (SSS is the most common Philippine government
 * ID). `hasConsent` defaults to `false` per NFR-C5 — the user must
 * consciously check the box for each customer; defaulting to `true`
 * would defeat the design.
 */
export const CUSTOMER_FORM_EMPTY_DEFAULTS: CustomerFormValues = {
  fullName: "",
  phone: "",
  email: "",
  addressLine1: "",
  barangay: "",
  cityMunicipality: "",
  province: "",
  postalCode: "",
  govIdType: "sss",
  govIdNumber: "",
  relationshipToOccupant: "",
  hasConsent: false,
};
