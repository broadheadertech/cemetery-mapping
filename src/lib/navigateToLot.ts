/**
 * navigateToLot — Story 8.3.
 *
 * Pure helper that constructs a platform-appropriate map-app deep link
 * for a lot's GPS centroid. The web app deliberately does NOT ship its
 * own turn-by-turn navigation (FR12); instead we hand off the
 * destination coordinates to whatever native map / nav app the user
 * has installed.
 *
 * Platform handoff rules:
 *   - Android  → `geo:<lat>,<lng>?q=<lat>,<lng>(Lot <code>)`. The label
 *     parenthetical surfaces in the user's chosen app (Google Maps,
 *     Waze, Maps.me, OsmAnd, …) so Junior can confirm he's heading to
 *     the right lot. Per RFC 5870.
 *   - iOS      → `maps://?daddr=<lat>,<lng>`. Apple's Maps URL scheme;
 *     `daddr` triggers Maps' driving-directions screen.
 *   - Other    → `https://www.google.com/maps/dir/?api=1&destination=
 *     <lat>,<lng>`. Cross-platform fallback that respects the user's
 *     default map app via Google Maps' own handoff. Used on desktop
 *     (Junior's office laptop is rare but supported) and as a
 *     belt-and-braces fallback for any UA the detector can't classify.
 *
 * The helper is a *pure function* taking an explicit `userAgent`
 * string. We do NOT read `navigator.userAgent` inside the helper so:
 *   - SSR is safe (no `navigator` reference at module top level).
 *   - Unit tests can simulate iOS / Android / desktop UAs with a one-
 *     line arg, no jsdom user-agent override needed.
 *
 * Latitude / longitude are formatted to 6 decimal places. Six decimals
 * is roughly 10 cm of precision — vastly more than enough to find a
 * cemetery lot. Higher precision wastes bytes and reads as fake
 * specificity to the user. We use `Number.prototype.toFixed(6)` rather
 * than the raw JS `number` (which prints up to 17 significant digits).
 *
 * `lotCode` is `encodeURIComponent`-escaped before interpolation —
 * defense-in-depth for codes that may, in future, contain spaces or
 * symbols (current codes like `D-5-12` survive untouched).
 */

export interface NavigateToLotInput {
  /** Lot's GPS centroid (WGS-84 decimal degrees). */
  lat: number;
  lng: number;
  /** Human-readable lot code shown inside the map app label (e.g. "D-5-12"). */
  lotCode: string;
  /**
   * Optional user-agent string. Defaults to `navigator.userAgent` in
   * the browser; tests should pass an explicit UA so the helper stays
   * fully deterministic.
   */
  userAgent?: string;
}

export type Platform = "android" | "ios" | "other";

/**
 * Classify a UA string into one of three buckets.
 *
 * Heuristics:
 *   - Android: literal "Android" anywhere in the UA.
 *   - iOS: any of iPhone / iPad / iPod (covers Safari, Chrome-on-iOS,
 *     Firefox-on-iOS — all of which forward to the system handler).
 *     iPadOS 13+ in desktop-mode reports a Mac UA — that path falls
 *     through to "other", which still ships the cross-platform Google
 *     Maps URL, so the handoff still works.
 *   - other: everything else (desktop Chrome / Firefox / Safari /
 *     unknown).
 *
 * Exported for use in tests + the NavigateToLotButton's analytics
 * payload (so logs can record which branch fired).
 */
export function detectPlatform(userAgent: string): Platform {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  return "other";
}

/**
 * Trim a coordinate to 6 decimal places. `toFixed` returns a string,
 * which is exactly what we want for URI interpolation.
 */
function formatCoord(n: number): string {
  return n.toFixed(6);
}

export interface NavigateToLotResult {
  /** Final URL to hand off to the device. */
  url: string;
  /** Detected platform — exposed for telemetry / debugging. */
  platform: Platform;
}

/**
 * Build the deep-link URL for the given lot centroid + code.
 *
 * Always returns a usable URL — never throws. If `lat` / `lng` are
 * non-finite the helper still returns a (degenerate) URL with the
 * non-finite coordinate formatted as "NaN"; callers should validate
 * the centroid before calling. The NavigateToLotButton gates on
 * geometryStatus + centroid presence so this path is unreachable in
 * normal use, but the helper stays total.
 */
export function navigateToLot(input: NavigateToLotInput): NavigateToLotResult {
  const ua =
    input.userAgent ??
    (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const platform = detectPlatform(ua);

  const lat = formatCoord(input.lat);
  const lng = formatCoord(input.lng);
  const code = encodeURIComponent(input.lotCode);

  if (platform === "android") {
    return {
      url: `geo:${lat},${lng}?q=${lat},${lng}(Lot%20${code})`,
      platform,
    };
  }

  if (platform === "ios") {
    return {
      url: `maps://?daddr=${lat},${lng}`,
      platform,
    };
  }

  return {
    url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
    platform,
  };
}
