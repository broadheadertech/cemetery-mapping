import { ErrorCode, throwError } from "./errors";

/**
 * Date and duration helpers.
 *
 * Two kinds of time exist in this system and they must not be confused:
 *
 *   - **Instants** — unix milliseconds. `occurredAt`, `recordedAt`,
 *     `sealedAt`. Absolute, timezone-free, what `Date.now()` returns.
 *   - **Business dates** — `YYYY-MM-DD` in the TENANT's timezone.
 *     `occurredOn`, `dueOn`, `ledgerOn`. These decide which day a
 *     movement belongs to, and therefore which daily-ledger row it
 *     lands in (taxonomy §10).
 *
 * The schema stores both, deliberately. A ledger day is not derivable
 * from an instant without knowing the tenant's timezone, and we refuse
 * to make day-boundary behaviour depend on where the server happens to
 * be running.
 *
 * ---------------------------------------------------------------
 * WHY FIXED OFFSETS AND NOT `Intl` / IANA
 * ---------------------------------------------------------------
 * Asia/Manila is UTC+8 and has observed no DST since 1978. Every zone
 * this system supports is listed below with a fixed offset, and an
 * unrecognised zone throws rather than guessing.
 *
 * This is deliberate, and it is a real constraint worth stating: **if
 * this system is ever deployed for a tenant in a DST-observing zone,
 * this file must be replaced**, not extended with another entry. Two
 * days a year would otherwise silently land in the wrong ledger row —
 * and because prior days are sealed (§10), that is not a bug you can
 * fix by re-running anything.
 *
 * The alternative (`Intl.DateTimeFormat` with a timeZone) would handle
 * DST, but adds a dependency on the JS runtime's timezone database
 * being present and correct. For a Philippines-only system the fixed
 * offset is simpler, deterministic, and fails loudly at exactly the
 * point where the assumption stops holding.
 */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Supported tenant timezones → offset from UTC in minutes.
 *
 * ONLY non-DST zones may be added here. See the file header.
 */
const FIXED_OFFSET_MINUTES: Record<string, number> = {
  "Asia/Manila": 8 * 60,
  UTC: 0,
};

export function offsetMinutesFor(timezone: string): number {
  const offset = FIXED_OFFSET_MINUTES[timezone];
  if (offset === undefined) {
    throwError(
      ErrorCode.INVARIANT_VIOLATION,
      `Unsupported tenant timezone '${timezone}'. Only fixed-offset zones are supported — see convex/lib/time.ts.`,
      { timezone },
    );
  }
  return offset;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The business date (`YYYY-MM-DD`) an instant falls on, in the tenant's
 * timezone. This is the function that decides which daily-ledger row a
 * movement belongs to.
 */
export function toBusinessDate(atMs: number, timezone: string): string {
  const shifted = new Date(atMs + offsetMinutesFor(timezone) * MINUTE_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
}

/**
 * The instant at which a business date begins, in the tenant's
 * timezone. Inverse of `toBusinessDate` at midnight.
 */
export function startOfBusinessDate(date: string, timezone: string): number {
  assertBusinessDate(date);
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - offsetMinutesFor(timezone) * MINUTE_MS;
}

/** `YYYY-MM` — the period key the schedule generator uses (taxonomy §8). */
export function toMonthKey(date: string): string {
  assertBusinessDate(date);
  return date.slice(0, 7);
}

/** Shifts a business date by whole days. Negative `days` goes backwards. */
export function addDays(date: string, days: number): string {
  assertBusinessDate(date);
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate(),
  )}`;
}

/**
 * Whole days between two business dates, `to - from`. Used for the
 * days-outstanding figure on an open advance (taxonomy §6.4), which is
 * computed at read time rather than stored so it cannot go stale.
 */
export function daysBetween(from: string, to: string): number {
  assertBusinessDate(from);
  assertBusinessDate(to);
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

const BUSINESS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Guards the `YYYY-MM-DD` shape. Every business-date field in the
 * schema is a plain string, so this is the only thing standing between
 * a typo and a movement landing in a ledger row that does not exist.
 */
export function assertBusinessDate(value: string): void {
  if (!BUSINESS_DATE_RE.test(value)) {
    throwError(
      ErrorCode.VALIDATION,
      `Expected a YYYY-MM-DD business date, received '${value}'.`,
      { value },
    );
  }
}
