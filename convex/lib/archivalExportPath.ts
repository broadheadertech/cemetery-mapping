/**
 * Internal function path for the monthly archival export action.
 *
 * This lives in its own V8-safe module (NO `node:` imports) on purpose.
 * The Admin-facing trigger mutation in `convex/archivalExports.ts` needs
 * to reference the action by path, but importing ANYTHING — even this
 * plain string constant — directly from the action file
 * (`convex/actions/archivalExport.ts`, a `"use node"` module) makes
 * esbuild pull that file's `node:zlib` / `node:crypto` imports into the
 * V8 bundle, which breaks `convex dev` bundling. Routing the constant
 * through this neutral module severs that V8 → Node import edge.
 *
 * `convex/_generated/api` is deliberately not committed in this repo, so
 * the cron registration and the trigger mutation resolve the action via
 * this path string rather than a generated `internal.*` reference.
 */
export const MONTHLY_ARCHIVAL_EXPORT_INTERNAL_PATH =
  "actions/archivalExport:monthlyArchivalExport";
