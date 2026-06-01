/**
 * Zod schema for the IntermentForm — Story 7.1.
 *
 * Client-side validation that mirrors `convex/interments.ts →
 * scheduleInterment`'s server validator. Server is authoritative; this
 * schema provides immediate inline feedback before submit.
 *
 * `scheduledAt` is composed by the form from two inputs:
 *   - `date` — `YYYY-MM-DD` (HTML `<input type="date">` payload).
 *   - `time` — `HH:MM` (HTML `<input type="time">` payload).
 * Both are required. The form composes `${date}T${time}+08:00` and
 * passes the epoch ms to the parent submit handler (Manila tz is
 * hardcoded for now; PH has no DST per `convex/lib/time.ts` policy).
 */

import { z } from "zod";

export const INTERMENT_NOTES_MAX_LENGTH = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export const intermentFormSchema = z
  .object({
    occupantId: z.string().trim().min(1, "Select an occupant."),
    date: z
      .string()
      .regex(DATE_RE, "Date is required (YYYY-MM-DD)."),
    time: z
      .string()
      .regex(TIME_RE, "Time is required (HH:MM)."),
    notes: z
      .string()
      .trim()
      .max(
        INTERMENT_NOTES_MAX_LENGTH,
        `Notes must be ${INTERMENT_NOTES_MAX_LENGTH} characters or fewer.`,
      )
      .optional(),
  })
  .superRefine((values, ctx) => {
    // Mirror the server-side 1-day-past tolerance so the UI rejects
    // the same dates the server would reject. The matching `min`
    // attribute on the date input is set by the form.
    const composed = composeScheduledAtMs(values.date, values.time);
    if (composed === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["date"],
        message: "Date / time combination is invalid.",
      });
      return;
    }
    const minAllowed = Date.now() - 24 * 60 * 60 * 1000;
    if (composed < minAllowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["date"],
        message: "Cannot schedule more than 1 day in the past.",
      });
    }
  });

export type IntermentFormValues = z.infer<typeof intermentFormSchema>;

/**
 * Compose a `YYYY-MM-DD` + `HH:MM` pair into epoch ms in the Manila
 * timezone (UTC+8, no DST). Returns `null` when the pair doesn't
 * parse cleanly.
 *
 * `new Date("2026-06-15T10:00+08:00")` is the canonical safe parse
 * for an offset-suffixed ISO 8601 string — ECMA-262 mandates support
 * for this form across all engines. We deliberately avoid `Date.parse`
 * on bare `YYYY-MM-DDTHH:MM` (whose tz interpretation differs across
 * engines).
 */
export function composeScheduledAtMs(
  date: string,
  time: string,
): number | null {
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return null;
  }
  const ms = new Date(`${date}T${time}:00+08:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}
