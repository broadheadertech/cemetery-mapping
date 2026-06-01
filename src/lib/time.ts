/**
 * Client-side time helpers (Story 2.1; introduced for the consent
 * checkbox label's "Captured: [today's date]" display).
 *
 * Architecture §492–493 commits to ALL date formatting going through
 * an explicit `"en-PH"` locale with `"Asia/Manila"` timezone — the
 * Philippines does not observe daylight-saving, so `Asia/Manila` is
 * a stable UTC+8 offset, but using the IANA name (rather than a
 * hard-coded `+08:00`) keeps us correct if any downstream library
 * ever needs the country code for date arithmetic.
 *
 * Server-side time constants (HOUR_MS / DAY_MS) live in
 * `convex/lib/time.ts`. This module is the client mirror.
 *
 * Why we don't pull in `date-fns` or `dayjs`:
 *   The Intl API is universally available in our supported browsers
 *   (the architecture targets evergreen mobile + desktop), it's
 *   tree-shaking-friendly (built into the runtime), and our
 *   formatting needs are narrow. Adding a library would weigh more
 *   in bundle size than the API surface saves in code.
 */

/**
 * Format options Story 2.1 needs:
 *   - "short"    → "May 19, 2026"     — the consent checkbox label.
 *
 * Future stories will extend this list (e.g. `"long"` →
 * `"Monday, May 19, 2026"`, `"datetime"` → `"May 19, 2026, 8:30 AM"`).
 * Add new variants here rather than inlining new `Intl.DateTimeFormat`
 * calls at each call site.
 */
export type DateFormat = "short";

const FORMATTERS: Record<DateFormat, Intl.DateTimeFormat> = {
  short: new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "numeric",
  }),
};

/**
 * Formats an epoch-ms timestamp as a Manila-timezone-anchored
 * human-readable string. Never throws — invalid timestamps return
 * the literal string `"—"` so a buggy upstream value doesn't crash
 * a render path.
 */
export function formatDate(ms: number, format: DateFormat): string {
  if (!Number.isFinite(ms)) return "—";
  return FORMATTERS[format].format(new Date(ms));
}

/**
 * Period kind for the dashboard drill-down filter (MTD / YTD).
 *
 * Kept aligned with `convex/dashboard.ts` `DashboardPeriod`. We do not
 * import the Convex type into client pages because Convex's generated
 * `_generated` surface is not part of the front-end build graph.
 */
export type DashboardPeriod = "mtd" | "ytd";

export interface PeriodBoundsMs {
  /** UTC epoch ms — inclusive start of the period (Manila-tz anchored). */
  startMs: number;
  /** UTC epoch ms — inclusive end (defaults to `now`). */
  endMs: number;
  /** Operator-facing label ("Month to date" / "Year to date"). */
  label: string;
}

/**
 * Computes the `[startMs, endMs]` interval for an MTD / YTD period
 * anchored at `now`, with the start boundary computed in **Manila
 * timezone**. The Philippines does not observe daylight-saving so a
 * fixed `+08:00` offset is safe (mirrors
 * `convex/dashboard.ts:periodBounds`).
 *
 * Disaster prevention: the original implementations on `/sales`,
 * `/expenses`, and `/payments` used `new Date(now.getFullYear(),
 * now.getMonth(), 1)` which anchors the boundary to the **system local
 * timezone**. On any operator workstation running outside `+08:00`
 * (laptop traveling abroad, an audit station in another tz, a CI
 * snapshot) that produces a period bound off by 1 day from the
 * dashboard — sales recorded "today" in Manila vanish from "this
 * month" on the operator's screen. Routing every front-end period
 * computation through this helper keeps the client mirror in lockstep
 * with the dashboard's server-side aggregation.
 */
export function periodBoundsManila(
  period: DashboardPeriod,
  now: number = Date.now(),
): PeriodBoundsMs {
  const parts = manilaDateParts(now);
  if (period === "mtd") {
    const startIso = `${parts.year}-${parts.month}-01T00:00:00+08:00`;
    return {
      startMs: new Date(startIso).getTime(),
      endMs: now,
      label: "Month to date",
    };
  }
  const startIso = `${parts.year}-01-01T00:00:00+08:00`;
  return {
    startMs: new Date(startIso).getTime(),
    endMs: now,
    label: "Year to date",
  };
}

interface ManilaDateParts {
  year: string;
  month: string;
  day: string;
}

const MANILA_DATE_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function manilaDateParts(ms: number): ManilaDateParts {
  const parts = MANILA_DATE_PARTS_FORMATTER.formatToParts(new Date(ms));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return { year, month, day };
}

/**
 * Formats a Manila-tz `[startMs, endMs]` interval as the human-readable
 * range label that the period banner on `/sales`, `/expenses`, and
 * `/payments` uses (e.g. `"May 1, 2026 – May 24, 2026"`).
 */
export function formatPeriodRangeLabel(bounds: PeriodBoundsMs): string {
  return `${FORMATTERS.short.format(new Date(bounds.startMs))} – ${FORMATTERS.short.format(new Date(bounds.endMs))}`;
}
