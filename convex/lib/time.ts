/**
 * Time constants used by auth session-timeout checks (Story 1.2) and
 * later by financial / interment helpers.
 *
 * Manila-timezone date helpers (Asia/Manila, UTC+8, never DST) land in
 * a later story when financial code starts handling cutoff dates. For
 * now this file is intentionally minimal — only durations in
 * milliseconds, because that's what `Date.now()` deals in and what
 * Convex Auth's session records store.
 */
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
