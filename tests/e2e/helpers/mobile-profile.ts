import { devices } from "@playwright/test";

/**
 * Pixel 5 emulation, minus the one property that cannot be changed
 * inside a `test.describe`.
 *
 * ## Why this exists
 *
 * Six specs used `test.use({ ...devices["Pixel 5"] })` inside a
 * describe block to run one mobile assertion alongside their desktop
 * ones. Playwright rejects that outright:
 *
 *   > Cannot use({ defaultBrowserType }) in a describe group, because
 *   > it forces a new worker.
 *
 * It is a COLLECTION error, not a test failure — Playwright refuses to
 * load the file, and because it happens during collection the whole
 * run aborts before a single test executes. The suite reported no
 * passes and no failures, which reads at a glance like "nothing to
 * do" rather than "nothing ran". The Playwright CI job has been in
 * that state.
 *
 * The offending property is `defaultBrowserType` — it decides which
 * browser binary the worker launches, so it cannot vary within a file
 * that is already running. Everything else a device profile carries
 * (viewport, user agent, touch, scale factor) is per-context and is
 * perfectly legal inside a describe.
 *
 * So: spread the device, drop `defaultBrowserType`, keep the mobile
 * emulation. The specs keep their shape and the run collects.
 *
 * Note this profile still runs in whatever browser the project
 * specifies — Chromium for both configured projects, which is what
 * `devices["Pixel 5"]` would have selected anyway. Nothing about the
 * coverage changes.
 */
/**
 * Strip `defaultBrowserType` from any device profile so it can be used
 * inside a describe block.
 */
function describeSafe(
  device: (typeof devices)[string],
): Omit<(typeof devices)[string], "defaultBrowserType"> {
  const { defaultBrowserType: _ignored, ...rest } = device;
  return rest;
}

/** Pixel 5 — the field-worker / customer-portal mobile profile. */
export const MOBILE_PROFILE = describeSafe(devices["Pixel 5"]);

/** iPhone 13 Mini — the small-viewport profile the dashboard spec uses. */
export const SMALL_MOBILE_PROFILE = describeSafe(
  devices["iPhone 13 Mini"],
);
