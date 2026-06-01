/**
 * SaleForm Zod schema — Story 3.3.
 *
 * Client-side validation that mirrors `convex/contracts.ts:
 * recordFullPaymentSale`'s server validator. Server is authoritative;
 * this schema provides immediate inline feedback before submit.
 *
 * Fields:
 *   - `lotId` — Convex `Id<"lots">` as a string. Selected by the
 *     LotPicker.
 *   - `customerId` — Convex `Id<"customers">` as a string. Selected by
 *     the CustomerPicker.
 *   - `priceInput` — peso-formatted string the operator typed
 *     (e.g. "150,000"). Converted to centavos at submit time via
 *     `pesosToCents` (src/lib/money.ts).
 *   - `method` — `"cash" | "check" | "bank_transfer"`. The narrower
 *     surface (no gcash / maya / card) matches the office-staff sale
 *     flow's scope; e-wallet methods land in Epic 9.
 *   - `reference` — required when method !== cash (cheque number, bank
 *     transfer reference). Server re-validates.
 *   - `paidAtDate` / `paidAtTime` — composed into epoch ms at submit
 *     time; defaults to today (Manila tz).
 */

import { z } from "zod";

import { pesosToCents } from "@/lib/money";

export const SALE_METHODS = ["cash", "check", "bank_transfer"] as const;
export type SaleMethod = (typeof SALE_METHODS)[number];

export const SALE_METHOD_LABEL: Record<SaleMethod, string> = {
  cash: "Cash",
  check: "Cheque",
  bank_transfer: "Bank transfer",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Story 3.5 (FR22) — discount-input bounds.
 *
 * Discount entry on the SaleForm is optional. When supplied, the field
 * holds a peso-formatted string (same shape as `priceInput`); the form
 * converts it to centavos at submit time. Empty / whitespace-only
 * means "no discount."
 *
 * Server-side rules in `convex/contracts.ts:normalizeDiscountInputs`
 * are the source of truth — this schema mirrors them for inline
 * feedback before submit:
 *   - `discountInput` parses to a non-negative integer cent amount.
 *   - When `discountInput > 0`, `discountReason` (trimmed) is
 *     ≥ 5 chars and ≤ 280 chars.
 *   - When `discountInput === 0` (or empty), `discountReason` may be
 *     blank.
 *   - When `discountInput > priceInput`, surface a validation error
 *     immediately so the user fixes it before the server rejects.
 */
const DISCOUNT_REASON_MIN = 5;
const DISCOUNT_REASON_MAX = 280;

export const saleFormSchema = z
  .object({
    lotId: z.string().trim().min(1, "Select a lot."),
    customerId: z.string().trim().min(1, "Select a customer."),
    priceInput: z
      .string()
      .trim()
      .min(1, "Enter the sale price.")
      .refine((s) => {
        const cents = pesosToCents(s);
        return Number.isFinite(cents) && cents > 0;
      }, "Sale price must be greater than zero."),
    method: z.enum(SALE_METHODS),
    reference: z.string().trim().optional(),
    paidAtDate: z.string().regex(DATE_RE, "Date is required (YYYY-MM-DD)."),
    paidAtTime: z.string().regex(TIME_RE, "Time is required (HH:MM)."),
    // Story 3.5 (FR22) — optional discount fields. Empty string = no
    // discount; non-empty value must parse to non-negative centavos.
    discountInput: z.string().trim().optional(),
    discountReason: z.string().trim().optional(),
    // Story 3.8 rebuild (FR25): perpetual care is now policy-derived.
    // The operator-facing input + reason fields were removed; the
    // SaleForm renders a read-only "Perpetual care: ₱X,XXX" line
    // hydrated server-side via `previewPerpetualCareForLot`.
  })
  .superRefine((values, ctx) => {
    if (values.method !== "cash") {
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
    const composed = composePaidAtMs(values.paidAtDate, values.paidAtTime);
    if (composed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidAtDate"],
        message: "Date / time combination is invalid.",
      });
    }
    // Story 3.5 — discount bounds.
    const discountStr = (values.discountInput ?? "").trim();
    if (discountStr.length > 0) {
      const discountCents = pesosToCents(discountStr);
      const priceCents = pesosToCents(values.priceInput);
      if (
        !Number.isFinite(discountCents) ||
        !Number.isInteger(discountCents) ||
        discountCents < 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["discountInput"],
          message: "Discount must be zero or a positive amount.",
        });
      } else if (
        Number.isFinite(priceCents) &&
        priceCents > 0 &&
        discountCents > priceCents
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["discountInput"],
          message: "Discount cannot exceed the lot's base price.",
        });
      }
      if (discountCents > 0) {
        const reason = (values.discountReason ?? "").trim();
        if (reason.length < DISCOUNT_REASON_MIN) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["discountReason"],
            message: `Reason must be at least ${DISCOUNT_REASON_MIN} characters when a discount is applied.`,
          });
        }
        if (reason.length > DISCOUNT_REASON_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["discountReason"],
            message: `Reason must be at most ${DISCOUNT_REASON_MAX} characters.`,
          });
        }
      }
    }
    // Story 3.8 rebuild (FR25): perpetual care fields removed —
    // policy-derived server-side, no longer operator-supplied.
  });

export type SaleFormValues = z.infer<typeof saleFormSchema>;

/**
 * Installment-specific schema — Story 3.4 (FR20 / FR21).
 *
 * Extends `saleFormSchema`'s shared shape (lot, customer, method,
 * reference, date / time) with the installment terms: down payment,
 * term in months, monthly amount, and first due date. The schedule
 * itself is generated client-side from these inputs by
 * `generateInstallmentSchedule` and is NOT a form field.
 *
 * The monthly amount input is admin-controlled (the form may auto-fill
 * it from the divided remainder; admin may override for promo pricing
 * once Story 3.5 ships). The schema validates the shape; the server
 * mutation re-validates the cents-sum invariant.
 *
 * Down payment "0" is allowed (a fully-installment sale with no
 * deposit). When `0`, the form skips the method / reference fields'
 * required-ness for cheque + bank transfer — the server applies the
 * same carve-out.
 */
const NUMBER_INPUT_RE = /^[\d,]+(\.\d{0,2})?$/;

export const installmentSaleFormSchema = z
  .object({
    lotId: z.string().trim().min(1, "Select a lot."),
    customerId: z.string().trim().min(1, "Select a customer."),
    totalPriceInput: z
      .string()
      .trim()
      .min(1, "Enter the total price.")
      .refine((s) => {
        const cents = pesosToCents(s);
        return Number.isFinite(cents) && cents > 0;
      }, "Total price must be greater than zero."),
    downPaymentInput: z
      .string()
      .trim()
      .min(1, "Enter the down payment (use 0 for no deposit).")
      .refine((s) => {
        const cents = pesosToCents(s);
        return Number.isFinite(cents) && cents >= 0;
      }, "Down payment must be zero or greater."),
    termMonths: z
      .string()
      .trim()
      .regex(NUMBER_INPUT_RE, "Term must be a whole number.")
      .refine((s) => {
        const n = Number.parseInt(s.replace(/,/g, ""), 10);
        return Number.isInteger(n) && n >= 1 && n <= 60;
      }, "Term must be between 1 and 60 months."),
    monthlyAmountInput: z
      .string()
      .trim()
      .min(1, "Enter the monthly amount.")
      .refine((s) => {
        const cents = pesosToCents(s);
        return Number.isFinite(cents) && cents > 0;
      }, "Monthly amount must be greater than zero."),
    firstDueDate: z
      .string()
      .regex(DATE_RE, "First due date is required (YYYY-MM-DD)."),
    method: z.enum(SALE_METHODS),
    reference: z.string().trim().optional(),
    paidAtDate: z.string().regex(DATE_RE, "Date is required (YYYY-MM-DD)."),
    paidAtTime: z.string().regex(TIME_RE, "Time is required (HH:MM)."),
    // Story 3.5 (FR22) — optional discount fields. Same semantics as
    // the full-payment schema. The DiscountPanel is shared between
    // both tabs, so the validators agree on field names + bounds.
    discountInput: z.string().trim().optional(),
    discountReason: z.string().trim().optional(),
  })
  .superRefine((values, ctx) => {
    const totalCents = pesosToCents(values.totalPriceInput);
    const downCents = pesosToCents(values.downPaymentInput);
    if (
      Number.isFinite(totalCents) &&
      Number.isFinite(downCents) &&
      downCents >= totalCents
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["downPaymentInput"],
        message: "Down payment must be less than the total price.",
      });
    }
    if (downCents > 0 && values.method !== "cash") {
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
    const composed = composePaidAtMs(values.paidAtDate, values.paidAtTime);
    if (composed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paidAtDate"],
        message: "Date / time combination is invalid.",
      });
    }
    if (composed !== null) {
      const firstDueMs = composeFirstDueDateMs(values.firstDueDate);
      if (firstDueMs === null || firstDueMs <= composed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["firstDueDate"],
          message: "First due date must be after the sale date.",
        });
      }
    }
    // Story 3.5 — discount bounds (mirror the full-payment schema).
    const discountStr = (values.discountInput ?? "").trim();
    if (discountStr.length > 0) {
      const discountCents = pesosToCents(discountStr);
      if (
        !Number.isFinite(discountCents) ||
        !Number.isInteger(discountCents) ||
        discountCents < 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["discountInput"],
          message: "Discount must be zero or a positive amount.",
        });
      } else if (
        Number.isFinite(totalCents) &&
        totalCents > 0 &&
        discountCents > totalCents
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["discountInput"],
          message: "Discount cannot exceed the total price.",
        });
      }
      if (discountCents > 0) {
        const reason = (values.discountReason ?? "").trim();
        if (reason.length < DISCOUNT_REASON_MIN) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["discountReason"],
            message: `Reason must be at least ${DISCOUNT_REASON_MIN} characters when a discount is applied.`,
          });
        }
        if (reason.length > DISCOUNT_REASON_MAX) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["discountReason"],
            message: `Reason must be at most ${DISCOUNT_REASON_MAX} characters.`,
          });
        }
      }
    }
  });

export type InstallmentSaleFormValues = z.infer<
  typeof installmentSaleFormSchema
>;

/**
 * Compose a `YYYY-MM-DD` date input into epoch ms at Manila-midnight.
 * Used by the installment first-due-date field, where time-of-day is
 * irrelevant (the cemetery cares about the calendar day, not the
 * minute).
 */
export function composeFirstDueDateMs(date: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const ms = new Date(`${date}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Compose a `YYYY-MM-DD` + `HH:MM` pair into epoch ms in the Manila
 * timezone (UTC+8, no DST). Returns `null` when the pair doesn't
 * parse cleanly.
 *
 * Mirrors `composeScheduledAtMs` from the IntermentForm (Story 7.1) —
 * Manila is hardcoded for now per `convex/lib/time.ts` policy.
 */
export function composePaidAtMs(date: string, time: string): number | null {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return null;
  }
  const ms = new Date(`${date}T${time}:00+08:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Returns today's date in `YYYY-MM-DD` form using the operator's local
 * calendar. Cemetery operators are physically in PH; local tz == Manila
 * here so we keep the simple Date getters.
 */
export function todayLocalDate(now: number = Date.now()): string {
  const d = new Date(now);
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Returns the current time in `HH:MM` form.
 */
export function currentLocalTime(now: number = Date.now()): string {
  const d = new Date(now);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}
