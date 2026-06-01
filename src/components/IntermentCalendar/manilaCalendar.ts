/**
 * Story 7.3 — Manila-tz calendar arithmetic helpers.
 *
 * The Phase 1 client codebase deliberately avoids `date-fns` /
 * `dayjs` (architecture § `src/lib/time.ts`): the Intl API + a few
 * hand-rolled offset-aware helpers are enough for our narrow needs.
 * Cemetery operations run in PH (UTC+8, no DST), so we can compose /
 * decompose Manila wall-clock dates by adding the fixed `+08:00`
 * offset to UTC epoch ms.
 *
 * Everything here is pure + side-effect-free so the calendar grid is
 * deterministic across re-renders and the unit tests are
 * timezone-independent.
 */

/** UTC+8 in milliseconds — the Manila offset (no DST in PH). */
export const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** `{ year, month, day }` with month 1..12, day 1..31. */
export interface ManilaYmd {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

/**
 * Returns the Manila-wall-clock {year, month, day} for a given UTC
 * epoch ms. Internally we shift the timestamp by `+08:00` and read
 * the UTC components — equivalent to "what date is it in Manila
 * right now" without going through a stateful `Date` locale.
 */
export function manilaYmd(epochMs: number): ManilaYmd {
  const shifted = new Date(epochMs + MANILA_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Returns the UTC epoch ms corresponding to 00:00:00.000 Manila-time
 * on a given `{year, month, day}` triple. We construct the UTC moment
 * for that wall clock (which is 16:00 UTC on the previous day in
 * Manila terms — but `Date.UTC` only needs the wall components in
 * UTC-frame, so we subtract the offset).
 */
export function manilaDayStartMs({ year, month, day }: ManilaYmd): number {
  // UTC midnight for the same calendar date is `Date.UTC(year, month-1, day)`,
  // but we want Manila-midnight — which is 8 hours BEFORE UTC midnight.
  return Date.UTC(year, month - 1, day) - MANILA_OFFSET_MS;
}

/**
 * `[startMs, endMsExclusive)` bounds for one Manila day. The end
 * bound is exclusive so consumers can do `>= start && < end` for an
 * inclusive day comparison. Convex queries that want an inclusive
 * `lte` bound should subtract 1 from `endMsExclusive`.
 */
export function manilaDayBoundsMs(ymd: ManilaYmd): {
  startMs: number;
  endMsExclusive: number;
} {
  const startMs = manilaDayStartMs(ymd);
  const endMsExclusive = manilaDayStartMs(addDays(ymd, 1));
  return { startMs, endMsExclusive };
}

/**
 * Month-view bounds anchored at the first-of-month in Manila time.
 * The range covers the full calendar grid the month view renders —
 * which includes leading days from the prior month and trailing days
 * from the next month so the grid is rectangular (rows of 7).
 *
 * Week starts on Sunday (PH convention; the calendar header reads
 * Sun Mon Tue Wed Thu Fri Sat).
 *
 * Returns `{ fromMs, toMsInclusive, gridStartYmd, weeks: 6|5 }`
 * where `fromMs` is the start of the first visible day and
 * `toMsInclusive` is the end of the last visible day (one ms before
 * the next-day boundary so a `.lte()` Convex bound picks up rows on
 * the final day).
 */
export function manilaMonthBoundsMs(year: number, month: number): {
  fromMs: number;
  toMsInclusive: number;
  gridStartYmd: ManilaYmd;
  weeks: number;
} {
  const firstOfMonth: ManilaYmd = { year, month, day: 1 };
  // What weekday is the 1st? 0 = Sunday … 6 = Saturday (Date.getUTCDay
  // applied to the offset-shifted instant gives the Manila-frame day).
  const firstShifted = new Date(manilaDayStartMs(firstOfMonth) + MANILA_OFFSET_MS);
  const firstWeekday = firstShifted.getUTCDay(); // 0..6
  const gridStartYmd = addDays(firstOfMonth, -firstWeekday);

  // Days in `month` (Manila frame == calendar frame since the year /
  // month are calendar values; DST is not a factor in PH).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const totalCells = firstWeekday + daysInMonth;
  const weeks = Math.ceil(totalCells / 7);
  const totalDays = weeks * 7;

  const gridEndExclusive = addDays(gridStartYmd, totalDays);
  return {
    fromMs: manilaDayStartMs(gridStartYmd),
    toMsInclusive: manilaDayStartMs(gridEndExclusive) - 1,
    gridStartYmd,
    weeks,
  };
}

/** Adds `n` days (may be negative) to a Manila YMD, normalising via
 *  Date arithmetic so month / year roll over correctly. */
export function addDays(ymd: ManilaYmd, n: number): ManilaYmd {
  const base = Date.UTC(ymd.year, ymd.month - 1, ymd.day + n);
  const d = new Date(base);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Stable `YYYY-MM-DD` string for grid keys + URL params. */
export function ymdKey(ymd: ManilaYmd): string {
  const y = ymd.year.toString().padStart(4, "0");
  const m = ymd.month.toString().padStart(2, "0");
  const d = ymd.day.toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Same-day comparator across two YMDs. */
export function sameYmd(a: ManilaYmd, b: ManilaYmd): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
