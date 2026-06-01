#!/usr/bin/env node
// @ts-check
/**
 * Compliance check for ADR-0007 (PII encryption at rest). Run in CI.
 *
 * Story 2.8, AC4 — defense-in-depth for NFR-S2. This script asserts:
 *
 *   1. `docs/adr/0007-pii-encryption.md` EXISTS. If a future PR deletes
 *      the ADR (accidentally or otherwise), CI fails before merge.
 *   2. The ADR contains the required headings — `## Decision`,
 *      `## Rejected alternatives`, and a `NFR-S2` reference. If a future
 *      PR strips key sections, CI fails. (Cosmetic edits that preserve
 *      these headings still pass.)
 *   3. `convex/schema.ts` has NOT introduced a `v.bytes()` field inside
 *      the `customers` or `customerDocuments` table definitions. The
 *      Phase 1 decision (per ADR-0007) is plaintext-at-the-application-
 *      layer; introducing a bytes field signals an undeclared
 *      application-level encryption layer and requires an ADR amendment.
 *      An intentional amendment can pass by including the literal
 *      string `[adr-0007-amend]` in the file's amendment-marker comment
 *      (see escape-hatch comment below).
 *
 * Escape hatch:
 *   If a future story legitimately wants to introduce a `v.bytes()`
 *   field on the `customers` / `customerDocuments` tables (e.g. a real
 *   ADR-0007 amendment that adds application-level encryption), the
 *   accompanying schema diff should include the marker comment:
 *     // [adr-0007-amend] intentional bytes field — see ADR-0007 amendment
 *   in the same file. The script greps for that marker BEFORE failing,
 *   so legitimate amendments aren't blocked.
 *
 * Exit codes:
 *   0 — all checks pass.
 *   1 — at least one check failed; the failure message is printed to
 *       stderr. CI workflow surfaces this as a job failure.
 *
 * Usage:
 *   node scripts/check-adr-0007.js
 *   npm run check:adr-0007    (alias defined in package.json)
 *
 * Intentionally zero-dependency: uses only Node built-ins so the script
 * runs without `npm ci` in environments that just want a quick check.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const ADR_PATH = path.join(projectRoot, "docs", "adr", "0007-pii-encryption.md");
const SCHEMA_PATH = path.join(projectRoot, "convex", "schema.ts");

const AMEND_MARKER = "[adr-0007-amend]";
const REQUIRED_HEADINGS = [
  "## Decision",
  "## Rejected alternatives",
];
const REQUIRED_NFR_REFERENCE = "NFR-S2";

const failures = [];

// ---------------------------------------------------------------------------
// Check 1: ADR-0007 file exists.
// ---------------------------------------------------------------------------
if (!fs.existsSync(ADR_PATH)) {
  failures.push(
    `ADR-0007 (PII encryption) was deleted. Restore docs/adr/0007-pii-encryption.md. See _bmad-output/implementation-artifacts/2-8-pii-fields-encrypted-at-rest.md for the decision rationale.`,
  );
} else {
  // -------------------------------------------------------------------------
  // Check 2: ADR contains required headings + NFR reference.
  // -------------------------------------------------------------------------
  const adrText = fs.readFileSync(ADR_PATH, "utf8");
  for (const heading of REQUIRED_HEADINGS) {
    if (!adrText.includes(heading)) {
      failures.push(
        `ADR-0007 is missing required heading "${heading}". The ADR must document the decision and the rejected alternatives.`,
      );
    }
  }
  if (!adrText.includes(REQUIRED_NFR_REFERENCE)) {
    failures.push(
      `ADR-0007 does not reference ${REQUIRED_NFR_REFERENCE}. The ADR must map the decision to the PRD non-functional requirement it satisfies.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 3: convex/schema.ts has not introduced v.bytes() in customers /
//          customerDocuments without an explicit amendment marker.
// ---------------------------------------------------------------------------
if (fs.existsSync(SCHEMA_PATH)) {
  const schemaText = fs.readFileSync(SCHEMA_PATH, "utf8");
  const hasAmendmentMarker = schemaText.includes(AMEND_MARKER);

  // Scan each PII-bearing table block for a v.bytes() introduction.
  // We bracket the relevant block from the `tableName: defineTable({` line
  // to the matching closing `})` followed by an index chain or comma. To
  // keep the regex robust without a full parser, we read forward up to
  // 200 lines from the table declaration and check that window.
  const lines = schemaText.split(/\r?\n/);
  const PII_TABLES = ["customers", "customerDocuments"];
  for (const tableName of PII_TABLES) {
    const startIdx = lines.findIndex((line) =>
      line.includes(`${tableName}: defineTable({`),
    );
    if (startIdx === -1) continue; // table not yet defined; nothing to check
    const windowEnd = Math.min(startIdx + 200, lines.length);
    const blockText = lines.slice(startIdx, windowEnd).join("\n");
    if (/\bv\.bytes\s*\(/.test(blockText) && !hasAmendmentMarker) {
      failures.push(
        `convex/schema.ts introduces v.bytes() inside the "${tableName}" table without an ADR-0007 amendment marker. Phase 1 keeps PII fields as plaintext at the application layer (encrypted at rest by Convex). To intentionally add an application-level encrypted field, include the literal comment "${AMEND_MARKER}" in convex/schema.ts and update docs/adr/0007-pii-encryption.md (or supersede it with a new ADR).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  process.exit(0);
}

for (const message of failures) {
  process.stderr.write(`[check-adr-0007] ${message}\n`);
}
process.exit(1);
