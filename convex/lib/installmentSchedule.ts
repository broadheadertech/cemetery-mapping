/**
 * Shared installment-schedule derivation — Story 3.4 (FR20 / FR21).
 *
 * Single source of truth for the per-month principal + due-date math
 * that both the client `SchedulePreview` UI and the server-side
 * `recordInstallmentSale` mutation consume. Lives in `convex/lib/` so
 * the V8-runtime mutation file can import it without crossing the
 * `src/` boundary (Convex's bundler refuses to pull `src/` modules into
 * the deployment bundle).
 *
 * Mirrors the shape and behaviour of
 * `src/components/InstallmentSchedule/generateSchedule.ts`; the client
 * generator now re-exports from this module so the two paths share a
 * single implementation. Drift would be a defense-in-depth failure —
 * the server re-derives the schedule and compares against the client
 * input, and any mismatch throws `SCHEDULE_TAMPERED`.
 *
 * Pure: no `ctx`, no `Date.now()`, no Convex types. Cheap to call from
 * either runtime. Throws plain `Error` for invariant violations; the
 * server mutation translates those into `ConvexError(VALIDATION)` at
 * its boundary.
 *
 * Money math is integer centavos only (ADR-0007). Remainder cents land
 * on the FINAL installment row — the schedule reads as "₱X every
 * month, ₱X+ε in the final month" to the customer.
 *
 * Due-date semantics:
 *   - The caller supplies the FIRST due date (epoch ms in UTC; the
 *     client form composes it from a YYYY-MM-DD date input + Manila
 *     timezone, the server passes through whatever the client sent).
 *   - Subsequent due dates are the same day-of-month, advanced by one
 *     month per installment. We use a calendar-aware advance (not
 *     `+30 * DAY_MS`) so 28/29/30/31-day months land on the right day.
 *   - When the source day-of-month doesn't exist in the target month
 *     (e.g. Jan 31 → Feb), the date clamps to the last day of that
 *     month. `addMonthsClamped` is the helper; `clampedSourceDays`
 *     enumerates which originally-supplied day-of-month values were
 *     clamped so the UI can surface a "month-end clamp applied"
 *     warning (Epic-3/4 adversarial-review HIGH fix — Jan 31 + 1 month
 *     silently becoming Feb 28 was the disaster scenario).
 */

export interface ScheduleInput {
  /** Total contract price in centavos. */
  totalPriceCents: number;
  /** Down payment in centavos (may be 0). */
  downPaymentCents: number;
  /** Number of installment rows (1 ≤ N ≤ 60). */
  termMonths: number;
  /**
   * First installment due-date in epoch ms. Caller's responsibility to
   * compose this in the correct timezone (the form uses Manila / UTC+8).
   */
  firstDueDate: number;
}

export interface ScheduleRow {
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
}

export interface ScheduleResult {
  /**
   * The per-month "base" installment principal in centavos — what the
   * UI shows in the "Monthly amount" summary. Equal to
   * `floor((totalPriceCents − downPaymentCents) / termMonths)`.
   *
   * The final installment row's `principalCents` may exceed this by
   * the remainder cents (`0 ≤ extra ≤ termMonths − 1`).
   */
  monthlyAmountCents: number;
  /** N rows, one per installment, ordered by installmentNumber. */
  rows: ScheduleRow[];
  /**
   * Set of installment row indices (0-indexed) whose `dueDate` was
   * clamped from the nominal source day-of-month because the target
   * month has fewer days. Empty when no clamp was applied. The UI
   * consumes this to surface a "month-end clamp applied" warning so
   * customer paperwork stays honest (Epic-3/4 adversarial-review
   * HIGH fix).
   */
  clampedRowIndices: number[];
  /**
   * The source day-of-month derived from `firstDueDate` (UTC). Cached
   * here for the UI warning text — "Source day-of-month is the 31st;
   * Feb / Apr / … are clamped to month-end."
   */
  sourceDayOfMonth: number;
}

/**
 * Integer-only floor division that returns both quotient + remainder.
 * Inlined here for self-containment.
 */
function divFloor(numerator: number, divisor: number): {
  quotient: number;
  remainder: number;
} {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(divisor) ||
    divisor <= 0
  ) {
    throw new Error(
      `divFloor requires integer numerator + positive integer divisor (got ${numerator} / ${divisor}).`,
    );
  }
  const quotient = Math.floor(numerator / divisor);
  const remainder = numerator - quotient * divisor;
  return { quotient, remainder };
}

/**
 * Returns the number of days in the given month (1-indexed; January = 1).
 * Handles February leap years via the standard rule.
 */
function daysInMonth(year: number, monthOneIndexed: number): number {
  return new Date(year, monthOneIndexed, 0).getDate();
}

/**
 * Advance `from` by `monthsForward` months while preserving the
 * day-of-month, clamping to the target month's last day when the
 * source day doesn't exist there.
 *
 *   addMonthsClamped("2026-01-31", 1) → "2026-02-28"
 *   addMonthsClamped("2026-03-15", 2) → "2026-05-15"
 *
 * The result keeps the same hours / minutes / seconds / ms as `from`.
 * UTC fields throughout to dodge the host timezone.
 */
export function addMonthsClamped(from: number, monthsForward: number): number {
  const d = new Date(from);
  const targetYear = d.getUTCFullYear();
  const targetMonth0 = d.getUTCMonth() + monthsForward;
  const newYear = targetYear + Math.floor(targetMonth0 / 12);
  const newMonth0 = ((targetMonth0 % 12) + 12) % 12;
  const dom = d.getUTCDate();
  const lastDayOfTarget = daysInMonth(newYear, newMonth0 + 1);
  const clampedDom = Math.min(dom, lastDayOfTarget);
  return Date.UTC(
    newYear,
    newMonth0,
    clampedDom,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/**
 * Variant of `addMonthsClamped` that also reports whether the clamp
 * fired (the target month was shorter than the source day-of-month).
 * Internal helper for `generateInstallmentSchedule` so the result can
 * carry the clamped-row indices.
 */
function addMonthsClampedWithFlag(
  from: number,
  monthsForward: number,
): { dueDate: number; clamped: boolean } {
  const d = new Date(from);
  const targetYear = d.getUTCFullYear();
  const targetMonth0 = d.getUTCMonth() + monthsForward;
  const newYear = targetYear + Math.floor(targetMonth0 / 12);
  const newMonth0 = ((targetMonth0 % 12) + 12) % 12;
  const dom = d.getUTCDate();
  const lastDayOfTarget = daysInMonth(newYear, newMonth0 + 1);
  const clamped = dom > lastDayOfTarget;
  const clampedDom = Math.min(dom, lastDayOfTarget);
  return {
    dueDate: Date.UTC(
      newYear,
      newMonth0,
      clampedDom,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
    clamped,
  };
}

/**
 * Generates the installment schedule for an installment sale.
 *
 * Throws plain `Error` on bad input — server callers wrap into
 * `ConvexError(VALIDATION)`; client callers display the message via
 * the empty/error state.
 */
export function generateInstallmentSchedule(
  input: ScheduleInput,
): ScheduleResult {
  if (
    !Number.isInteger(input.totalPriceCents) ||
    input.totalPriceCents <= 0
  ) {
    throw new Error(
      `totalPriceCents must be a positive integer (got ${input.totalPriceCents}).`,
    );
  }
  if (
    !Number.isInteger(input.downPaymentCents) ||
    input.downPaymentCents < 0
  ) {
    throw new Error(
      `downPaymentCents must be a non-negative integer (got ${input.downPaymentCents}).`,
    );
  }
  if (input.downPaymentCents >= input.totalPriceCents) {
    throw new Error(
      "downPaymentCents must be strictly less than totalPriceCents.",
    );
  }
  if (
    !Number.isInteger(input.termMonths) ||
    input.termMonths < 1 ||
    input.termMonths > 60
  ) {
    throw new Error(
      `termMonths must be an integer in [1, 60] (got ${input.termMonths}).`,
    );
  }
  if (!Number.isFinite(input.firstDueDate)) {
    throw new Error("firstDueDate must be a finite epoch-ms number.");
  }

  const principalToSpread = input.totalPriceCents - input.downPaymentCents;
  const { quotient, remainder } = divFloor(principalToSpread, input.termMonths);
  const rows: ScheduleRow[] = [];
  const clampedRowIndices: number[] = [];
  const sourceDayOfMonth = new Date(input.firstDueDate).getUTCDate();
  for (let i = 0; i < input.termMonths; i++) {
    const isFinal = i === input.termMonths - 1;
    const principal = isFinal ? quotient + remainder : quotient;
    let dueDate: number;
    if (i === 0) {
      dueDate = input.firstDueDate;
    } else {
      const { dueDate: advanced, clamped } = addMonthsClampedWithFlag(
        input.firstDueDate,
        i,
      );
      dueDate = advanced;
      if (clamped) {
        clampedRowIndices.push(i);
      }
    }
    rows.push({
      installmentNumber: i + 1,
      dueDate,
      principalCents: principal,
    });
  }
  return {
    monthlyAmountCents: quotient,
    rows,
    clampedRowIndices,
    sourceDayOfMonth,
  };
}
