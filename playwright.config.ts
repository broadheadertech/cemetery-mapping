import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config.
 *
 * Phase 1 Story 1.1: one smoke spec targeting the login page on
 * desktop Chromium. Cross-browser + mobile profile tests expand
 * with the journey-aligned specs in later stories (Journey 1 sale,
 * Journey 2 payment, Journey 3 field-worker lookup, Journey 4
 * dashboard).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    // Mobile emulation profile — used by NFR-P2 tests + field-worker
    // journey specs starting Story 1.13. Defined here so Story 1.1's
    // CI can already reference the profile name without errors.
    {
      name: "mid-android",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
