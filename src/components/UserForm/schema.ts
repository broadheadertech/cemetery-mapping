/**
 * Zod schema for the user create form — Story 1.3.
 *
 * Server-side validation (`convex/users.ts → validateCreateUserPayload`)
 * is authoritative; this schema gives the admin immediate inline
 * feedback before submit.
 */

import { z } from "zod";

/**
 * Staff roles the admin UI can assign. `customer` is excluded —
 * Phase 3's customer portal flow creates customer accounts via a
 * separate path; the staff admin UI never grants `customer`.
 */
export const STAFF_ROLE_OPTIONS = [
  "admin",
  "office_staff",
  "field_worker",
] as const;
export type StaffRole = (typeof STAFF_ROLE_OPTIONS)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: "Admin / Owner",
  office_staff: "Office Staff",
  field_worker: "Field Worker",
};

export const userFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(128, "Name is too long (max 128 characters)."),
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Enter a valid email address.")
    .max(254, "Email is too long."),
  roles: z
    .array(z.enum(STAFF_ROLE_OPTIONS))
    .min(1, "Select at least one role."),
});

export type UserFormValues = z.infer<typeof userFormSchema>;
