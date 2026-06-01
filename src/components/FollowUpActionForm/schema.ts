/**
 * Zod schema for the FollowUpActionForm — Story 4.2.
 *
 * Client-side validation mirrors `convex/followUpActions.ts →
 * createFollowUp`'s server validator. Server is authoritative; this
 * schema delivers inline feedback before submit (UX § Form Patterns —
 * inline-not-toast).
 *
 * The form composes a Manila-tz epoch ms for `dueAt` via
 * `parseDueAtToMs` from a `YYYY-MM-DD` string the native date input
 * supplies.
 */

import { z } from "zod";

/** Maximum notes length, in characters. Mirrors `convex/followUpActions.ts`. */
export const FOLLOW_UP_NOTES_MAX_LENGTH = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const FOLLOW_UP_ACTIONS = [
  "phone_call",
  "sms",
  "letter",
  "in_person",
  "other",
] as const;

export type FollowUpActionChannel = (typeof FOLLOW_UP_ACTIONS)[number];

export const FOLLOW_UP_ACTION_LABELS: Record<FollowUpActionChannel, string> = {
  phone_call: "Phone call",
  sms: "SMS",
  letter: "Letter",
  in_person: "In person",
  other: "Other",
};

export const followUpActionFormSchema = z.object({
  action: z.enum(FOLLOW_UP_ACTIONS),
  dueAt: z.string().regex(DATE_RE, "Due date is required (YYYY-MM-DD)."),
  notes: z
    .string()
    .max(
      FOLLOW_UP_NOTES_MAX_LENGTH,
      `Notes must be ${FOLLOW_UP_NOTES_MAX_LENGTH} characters or fewer.`,
    )
    .optional(),
});

export type FollowUpActionFormValues = z.infer<typeof followUpActionFormSchema>;

/**
 * Parse a `YYYY-MM-DD` string into Manila-tz epoch ms (midnight at the
 * start of the date in Asia/Manila). Returns `null` on malformed input.
 */
export function parseDueAtToMs(dueAt: string): number | null {
  if (!DATE_RE.test(dueAt)) return null;
  const ms = new Date(`${dueAt}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Today as a `YYYY-MM-DD` string in Manila tz. Used as the date field's
 * default value and `min` attribute so the operator cannot pick a past
 * date by accident.
 */
export function todayInManila(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}
