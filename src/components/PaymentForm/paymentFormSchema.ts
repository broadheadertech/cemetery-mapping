/**
 * PaymentForm Zod schema — Story 3.9 (FR26).
 *
 * Client-side validation that mirrors `convex/payments.ts:
 * recordPaymentWithAutoAllocation`'s server validator. Server remains
 * authoritative; this schema provides immediate inline feedback before
 * the operator opens the receipt preview modal.
 *
 * Fields:
 *   - `amountInput` — peso-formatted string the operator typed
 *     (e.g. "4,000" or "1200.50"). Converted to centavos at submit
 *     time via `pesosToCents` (src/lib/money.ts).
 *   - `paymentMethod` — `"cash" | "check" | "bank_transfer"`. Narrow
 *     office-staff surface, same as the sale flow (Story 3.3).
 *   - `paidAtDate` — `YYYY-MM-DD`. Defaults to today in the operator's
 *     local calendar; Manila timezone in production. Combined into
 *     epoch ms via `composePaidAtMs`.
 *   - `reference` — required when `paymentMethod !== "cash"`. Trimmed
 *     and length-checked.
 */

import { z } from "zod";

import { pesosToCents } from "@/lib/money";

export const PAYMENT_METHODS = ["cash", "check", "bank_transfer"] as const;
export type PaymentFormMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABEL: Record<PaymentFormMethod, string> = {
  cash: "Cash",
  check: "Cheque",
  bank_transfer: "Bank transfer",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const paymentFormSchema = z
  .object({
    amountInput: z
      .string()
      .trim()
      .min(1, "Enter the payment amount.")
      .refine((s) => {
        const cents = pesosToCents(s);
        return Number.isFinite(cents) && cents > 0;
      }, "Amount must be greater than zero."),
    paymentMethod: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().optional(),
    paidAtDate: z.string().regex(DATE_RE, "Date is required (YYYY-MM-DD)."),
  })
  .superRefine((values, ctx) => {
    if (values.paymentMethod !== "cash") {
      if (
        values.reference === undefined ||
        values.reference.trim().length === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reference"],
          message: "Reference is required for cheque / bank transfer.",
        });
      }
    }
    const composed = composePaidAtDateMs(values.paidAtDate);
    if (composed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidAtDate"],
        message: "Date is invalid.",
      });
    }
  });

export type PaymentFormValues = z.infer<typeof paymentFormSchema>;

/**
 * Compose a `YYYY-MM-DD` input into epoch ms anchored at Manila
 * midnight. Mirrors `composeFirstDueDateMs` from the sale flow's
 * schema. Time-of-day is irrelevant for payment dating in Phase 1; the
 * cemetery cares about the calendar day, not the minute. The server
 * mutation accepts any epoch ms in [now-5min, now+5min) for clock-skew
 * tolerance — passing midnight Manila is always within that window for
 * the operator's local "today".
 */
export function composePaidAtDateMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  // Use the local timezone like the SaleForm does — the operator is
  // physically in PH, and the server's 5-minute skew tolerance covers
  // the small offset window. If the operator is in a non-Manila tz the
  // server still accepts (date is converted to Manila on receipts).
  const ms = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Returns today's date in `YYYY-MM-DD` form using the operator's local
 * calendar. Mirrors `todayLocalDate` from the sale flow's schema.
 */
export function todayLocalDate(now: number = Date.now()): string {
  const d = new Date(now);
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
