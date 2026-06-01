/**
 * Zod schema for the ExpenseForm — Story 4.6.
 *
 * Client-side validation mirrors `convex/expenses.ts → recordExpense`'s
 * server validator. Server is authoritative; this schema delivers
 * inline feedback before submit (UX § Form Patterns — inline-not-toast).
 *
 * The form uses two input shapes that flatten into the server payload:
 *   - `paidAt` is a `YYYY-MM-DD` string (HTML `<input type="date">`).
 *     The form composes Manila-tz epoch ms via `parsePaidAtToMs` before
 *     calling the mutation.
 *   - `amountPesos` is a peso value (string or number) that the form
 *     converts to centavos via `pesosToCents` from `@/lib/money`.
 */

import { z } from "zod";

/** Maximum vendor length, in characters. Mirrors `convex/expenses.ts`. */
export const VENDOR_MAX_LENGTH = 200;

/** Client cap: 10 MB. Prevents accidental raw-photo uploads. */
export const PHOTO_MAX_BYTES = 10_000_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const expenseFormSchema = z.object({
  paidAt: z.string().regex(DATE_RE, "Date is required (YYYY-MM-DD)."),
  amountPesos: z
    .union([
      z.number(),
      z.string().refine((s) => s.trim().length > 0, {
        message: "Amount is required.",
      }),
    ])
    .refine(
      (v) => {
        const n = typeof v === "number" ? v : Number.parseFloat(v);
        return Number.isFinite(n) && n > 0;
      },
      { message: "Amount must be greater than ₱0." },
    ),
  vendor: z
    .string()
    .trim()
    .min(1, "Vendor is required.")
    .max(
      VENDOR_MAX_LENGTH,
      `Vendor name is too long (max ${VENDOR_MAX_LENGTH} characters).`,
    ),
  category: z.string().trim().min(1, "Category is required."),
});

export type ExpenseFormValues = z.infer<typeof expenseFormSchema>;

/**
 * Parse a `YYYY-MM-DD` string into Manila-tz epoch ms (the moment of
 * midnight at the start of that date in Asia/Manila). Returns `null` on
 * malformed input so the form can surface an inline error rather than
 * sending a NaN to the server.
 *
 * `new Date("2026-05-20T00:00:00+08:00")` is the engine-portable safe
 * parse for an offset-suffixed ISO 8601 string (ECMA-262 mandates it).
 * We deliberately avoid `Date.parse` on a bare `YYYY-MM-DD` whose tz
 * interpretation varies across engines.
 */
export function parsePaidAtToMs(paidAt: string): number | null {
  if (!DATE_RE.test(paidAt)) return null;
  const ms = new Date(`${paidAt}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Today as a `YYYY-MM-DD` string in Manila tz. Used as the date field's
 * default value. The implementation goes through `Intl.DateTimeFormat`
 * so the tz mapping is correct regardless of the user's system clock
 * offset (a Manila operator on a laptop set to UTC would still see
 * today's Manila date).
 */
export function todayInManila(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // `en-CA` formats as `YYYY-MM-DD` natively — saves a manual sprintf.
  return fmt.format(new Date());
}
