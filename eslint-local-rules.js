"use strict";

/**
 * Entrypoint for `eslint-plugin-local-rules`. The plugin auto-discovers
 * this file at the project root and registers every key under the
 * `local-rules/*` namespace.
 *
 * Add new rules to the object below as the stories that need them land.
 * Each rule file lives in `eslint-rules/` and exports a standard ESLint
 * Rule.RuleModule.
 */
module.exports = {
  "require-role-first-line": require("./eslint-rules/require-role-first-line.js"),
  "no-raw-status-patch": require("./eslint-rules/no-raw-status-patch.js"),
  "single-h1-per-page": require("./eslint-rules/single-h1-per-page.js"),
  "no-audit-log-direct-write": require("./eslint-rules/no-audit-log-direct-write.js"),
  "no-audit-log-mutation": require("./eslint-rules/no-audit-log-mutation.js"),
  "no-direct-receipt-counter-access": require("./eslint-rules/no-direct-receipt-counter-access.js"),
  "no-direct-financial-write": require("./eslint-rules/no-direct-financial-write.js"),
  "no-direct-pii-read": require("./eslint-rules/no-direct-pii-read.js"),
};
