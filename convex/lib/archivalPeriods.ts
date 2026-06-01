/**
 * Manila-tz period bounds helpers for monthly archival exports
 * (Story 5.7, FR62 / NFR-R3 / NFR-C2).
 *
 * Pure functions — no Convex / Node / DB dependencies. Sit in
 * `convex/lib/` because they are server-internal helpers consumed by
 * the archival action and by unit tests; they are NOT a public Convex
 * surface and so are exempt from the `require-role-first-line` rule
 * (covered by the `convex/lib/**` ignore in `eslint.config.mjs`).
 *
 * Manila is UTC+8 year-round with no DST — the offset is stable.
 *
 * Why a dedicated module vs. inlining in the action:
 *   - The boundary logic is the most failure-prone part of the
 *     archival pipeline (a one-off period boundary error means a
 *     receipt drops into the wrong month — a compliance gap).
 *     Isolating the math here lets the test suite hammer it without
 *     standing up the action plumbing.
 *   - The existing `convex/birExport.ts` carries similar
 *     `getManilaMonthBounds` / `getPriorMonthInManila` helpers for
 *     the CSV exporter. We reproduce the API here keyed by the
 *     `"YYYY-MM"` period string the archival action consumes, so the
 *     two surfaces stay narrow and independent.
 *
 * Common LLM-developer mistakes this module guards against:
 *   - Computing the period via `new Date().getMonth()` — that reads
 *     the runtime host's local month, NOT Manila's. Always anchor to
 *     Manila explicitly.
 *   - Using inclusive end bounds — the action queries
 *     `paidAt >= startMs && paidAt < endMs` so the end is exclusive,
 *     matching the standard half-open-interval convention.
 */

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Format a (year, monthOfYear) pair as a `"YYYY-MM"` period string.
 * Internal — exported for tests.
 *
 *   formatPeriod(2026, 5) → "2026-05"
 *   formatPeriod(2026, 12) → "2026-12"
 */
export function formatPeriod(year: number, month: number): string {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  const yyyy = year.toString().padStart(4, "0");
  const mm = month.toString().padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * Parse a `"YYYY-MM"` period string into (year, month). Throws on
 * malformed input.
 *
 *   parsePeriod("2026-05") → { year: 2026, month: 5 }
 */
export function parsePeriod(period: string): { year: number; month: number } {
  if (typeof period !== "string") {
    throw new Error(`Invalid period: ${String(period)}`);
  }
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (match === null) {
    throw new Error(
      `Invalid period format: "${period}" — expected "YYYY-MM"`,
    );
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid period month: "${period}"`);
  }
  return { year, month };
}

/**
 * Given a `"YYYY-MM"` period string, return the unix-ms `[startMs, endMs)`
 * half-open range covering that calendar month in Asia/Manila time.
 *
 * Manila is UTC+8 with no DST, so the start of the month in Manila
 * equals `Date.UTC(year, month-1, 1, 0, 0) - 8h`.
 *
 *   getPeriodBounds("2026-05")
 *   → startMs: 2026-04-30 16:00 UTC == 2026-05-01 00:00 Manila
 *     endMs:   2026-05-31 16:00 UTC == 2026-06-01 00:00 Manila
 */
export function getPeriodBounds(period: string): {
  period: string;
  startMs: number;
  endMs: number;
} {
  const { year, month } = parsePeriod(period);
  const startMs =
    Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - MANILA_OFFSET_MS;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endMs =
    Date.UTC(nextYear, nextMonth - 1, 1, 0, 0, 0, 0) - MANILA_OFFSET_MS;
  return { period, startMs, endMs };
}

/**
 * Compute the prior calendar month relative to a "now" instant, with
 * the boundary resolved in Manila tz. Used by the cron path to derive
 * "last month's archive" without trusting the cron's UTC firing
 * wall-clock.
 *
 *   getPriorPeriod(Date.parse("2026-06-15T08:00:00+08:00"))
 *   → { period: "2026-05", startMs, endMs }
 *
 *   getPriorPeriod(Date.parse("2026-01-05T08:00:00+08:00"))
 *   → { period: "2025-12", startMs, endMs }
 *
 * Manila boundary discipline: shift `now` by the Manila offset, read
 * the Manila wall-clock components from the resulting UTC fields,
 * then roll back by one calendar month.
 */
export function getPriorPeriod(nowMs: number): {
  period: string;
  startMs: number;
  endMs: number;
} {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid nowMs: ${nowMs}`);
  }
  const manilaWall = new Date(nowMs + MANILA_OFFSET_MS);
  const manilaYear = manilaWall.getUTCFullYear();
  const manilaMonth = manilaWall.getUTCMonth() + 1; // 1..12
  // Roll back by one calendar month.
  let priorYear = manilaYear;
  let priorMonth = manilaMonth - 1;
  if (priorMonth === 0) {
    priorYear = manilaYear - 1;
    priorMonth = 12;
  }
  const period = formatPeriod(priorYear, priorMonth);
  return getPeriodBounds(period);
}
