/**
 * navigateToLot — Story 8.3 unit tests.
 *
 * Coverage target: ≥ 90% on the pure helper (NFR-M2). Every UA branch,
 * every output URL shape, every encoding edge case.
 */

import { describe, expect, it } from "vitest";

import {
  detectPlatform,
  navigateToLot,
} from "@/lib/navigateToLot";

// Real-device UA strings captured for regression purposes — keeping
// the actual UA shape gives us confidence the regex catches them.
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const IOS_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const IOS_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DESKTOP_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";

describe("detectPlatform", () => {
  it("classifies Android Chrome", () => {
    expect(detectPlatform(ANDROID_CHROME_UA)).toBe("android");
  });

  it("classifies iOS Safari", () => {
    expect(detectPlatform(IOS_SAFARI_UA)).toBe("ios");
  });

  it("classifies iPad Safari as iOS", () => {
    expect(detectPlatform(IPAD_SAFARI_UA)).toBe("ios");
  });

  it("classifies iOS Chrome as iOS", () => {
    expect(detectPlatform(IOS_CHROME_UA)).toBe("ios");
  });

  it("classifies Desktop Chrome as other", () => {
    expect(detectPlatform(DESKTOP_CHROME_UA)).toBe("other");
  });

  it("classifies Desktop Safari as other", () => {
    expect(detectPlatform(DESKTOP_SAFARI_UA)).toBe("other");
  });

  it("classifies an empty UA as other", () => {
    expect(detectPlatform("")).toBe("other");
  });

  it("classifies an unknown UA as other", () => {
    expect(detectPlatform("FreshlyMintedBrowser/1.0")).toBe("other");
  });
});

describe("navigateToLot — URL construction", () => {
  const centroid = { lat: 14.59951234, lng: 120.98421234 };
  const lotCode = "D-5-12";

  it("returns a geo: URI for Android with 6-decimal coords and label", () => {
    const { url, platform } = navigateToLot({
      ...centroid,
      lotCode,
      userAgent: ANDROID_CHROME_UA,
    });

    expect(platform).toBe("android");
    expect(url).toBe(
      "geo:14.599512,120.984212?q=14.599512,120.984212(Lot%20D-5-12)",
    );
  });

  it("returns a maps:// URI for iOS with 6-decimal coords", () => {
    const { url, platform } = navigateToLot({
      ...centroid,
      lotCode,
      userAgent: IOS_SAFARI_UA,
    });

    expect(platform).toBe("ios");
    expect(url).toBe("maps://?daddr=14.599512,120.984212");
  });

  it("returns the Google Maps https fallback for desktop", () => {
    const { url, platform } = navigateToLot({
      ...centroid,
      lotCode,
      userAgent: DESKTOP_CHROME_UA,
    });

    expect(platform).toBe("other");
    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=14.599512,120.984212",
    );
  });

  it("uses 6 decimal precision (truncates extra precision)", () => {
    const { url } = navigateToLot({
      lat: 14.5995123456789,
      lng: 120.984212345678,
      lotCode: "X",
      userAgent: ANDROID_CHROME_UA,
    });
    // 14.599512 / 120.984212 — both rounded to 6 decimals.
    expect(url).toContain("14.599512,120.984212");
    expect(url).not.toContain("14.5995123456");
  });

  it("encodes special characters in the lot code (Android label)", () => {
    const { url } = navigateToLot({
      lat: 14.6,
      lng: 120.9,
      lotCode: "Niche A/12 #3",
      userAgent: ANDROID_CHROME_UA,
    });
    // `/`, ` `, `#` all encoded; the rest of the Android URI stays intact.
    expect(url).toContain("(Lot%20Niche%20A%2F12%20%233)");
  });

  it("does NOT encode lat/lng as URL components (they are decimal strings)", () => {
    // Decimal-string lat/lng do not contain reserved chars; we
    // deliberately do not call encodeURIComponent on them. This test
    // pins the contract so a future refactor doesn't accidentally
    // double-encode.
    const { url } = navigateToLot({
      lat: -14.5,
      lng: -120.9,
      lotCode: "L",
      userAgent: DESKTOP_CHROME_UA,
    });
    expect(url).toContain("destination=-14.500000,-120.900000");
  });

  it("falls back to navigator.userAgent when no UA is passed (smoke)", () => {
    // jsdom sets a navigator.userAgent string. We don't assert which
    // branch fired; we only confirm the helper does not throw and
    // returns a non-empty URL.
    const { url, platform } = navigateToLot({
      lat: 14.6,
      lng: 120.9,
      lotCode: "L",
    });
    expect(url.length).toBeGreaterThan(0);
    expect(["android", "ios", "other"]).toContain(platform);
  });

  it("handles non-finite coords without throwing (NaN goes through .toFixed)", () => {
    // The button gates on geometryStatus + centroid presence, so this
    // path is unreachable in normal use. The helper must stay total
    // so a future refactor that loosens the gate doesn't crash.
    const { url } = navigateToLot({
      lat: Number.NaN,
      lng: Number.NaN,
      lotCode: "L",
      userAgent: DESKTOP_CHROME_UA,
    });
    expect(url).toContain("NaN,NaN");
  });
});
