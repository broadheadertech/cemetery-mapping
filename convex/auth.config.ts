/**
 * Convex Auth provider config.
 *
 * Phase 1 Story 1.1: password provider with email verification DISABLED
 * for fastest path to a working login. Email verification + password
 * reset can be enabled in a follow-up story once an email provider is
 * wired up (Story 3.13 lands Resend for receipt email; could reuse).
 *
 * Per-role session timeouts (NFR-S5: 1h Admin / 8h Staff / 30d Customer)
 * are NOT enforced in the Convex Auth static config — they're enforced
 * inside `requireRole` (Story 1.2) by comparing session age against the
 * user's role-derived timeout. This file just sets the default.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL ?? "http://localhost:3210",
      applicationID: "convex",
    },
  ],
};
