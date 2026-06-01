#!/usr/bin/env node
// @ts-check
/**
 * Backup-verification reminder check — Story 5.6 (FR61, NFR-R2).
 *
 * This script does NOT programmatically verify Convex's managed backups.
 * Convex does not expose backup metadata via its SDK or via a documented
 * HTTP/REST API at the time ADR-0017 was written. Building a screen-
 * scraper or hitting an undocumented endpoint was explicitly ruled out
 * by Story 5.6's disaster-prevention notes.
 *
 * What this script DOES verify (the parts that are knowable from
 * filesystem state):
 *
 *   1. `docs/adr/0017-database-backups.md` exists and contains the
 *      required structural headings (Decision, Verification ledger,
 *      NFR-R2 reference). If the ADR is deleted or stripped, CI fails.
 *
 *   2. `docs/runbook.md` exists and contains the "Database backups"
 *      section (heading + the "Restore from backup" subsection + the
 *      "Quarterly restore drill cadence" subsection). If the runbook
 *      regresses, CI fails.
 *
 *   3. The ADR's Verification ledger has at least one row, and the most
 *      recent row is no older than the age threshold. The threshold is
 *      100 days (a quarter + ~10 days of grace) — same value as
 *      `AGE_THRESHOLD_MS` in convex/healthCheck.ts.
 *
 *      The ledger row is parsed loosely — we look for a `YYYY-MM-DD`
 *      date in the leftmost cell of any row inside the
 *      `## Verification ledger` section's markdown table. The placeholder
 *      "TBD" text counts as "never verified" and fails the check.
 *
 * Exit codes:
 *   0 — all checks pass (the quarterly verification is current).
 *   1 — at least one check failed; the failure messages are printed to
 *       stderr. CI workflow surfaces this as a job failure / opens an
 *       issue so the on-call dev re-runs the quarterly verification.
 *
 * Usage:
 *   node scripts/check-backups.mjs
 *   npm run check:backups       (alias defined in package.json)
 *
 * Intentionally zero-dependency — uses only Node built-ins, same style
 * as scripts/check-adr-0007.js. Runs without npm ci.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const ADR_PATH = path.join(
  projectRoot,
  "docs",
  "adr",
  "0017-database-backups.md",
);
const RUNBOOK_PATH = path.join(projectRoot, "docs", "runbook.md");

/**
 * Same threshold as `AGE_THRESHOLD_MS` in convex/healthCheck.ts: a
 * quarter + grace. Drop this to 25h when Convex ships a programmatic
 * backup-status API and this script gains the ability to actually
 * check snapshot age (per ADR-0017 § Future revisit triggers).
 */
const AGE_THRESHOLD_DAYS = 100;

/**
 * Maximum age of a `[deferred]` placeholder row before it stops counting
 * as a valid verification. 180 days = twice the normal quarterly
 * cadence — generous enough to cover Phase 1 build-out delay, strict
 * enough that "deferred forever" is not a stable posture. See ADR-0017
 * § Verification ledger → "Deferred-row rule".
 */
const DEFERRED_MAX_AGE_DAYS = 180;
const DAY_MS = 86_400_000;

const REQUIRED_ADR_HEADINGS = [
  "## Decision",
  "## Verification ledger",
  "## Consequences",
];
const REQUIRED_ADR_REFERENCES = ["NFR-R2", "FR61"];

const REQUIRED_RUNBOOK_HEADINGS = [
  "## Database backups",
  "### Restore from backup",
  "### Quarterly restore drill cadence",
];

const failures = [];

// ---------------------------------------------------------------------------
// Check 1: ADR-0017 exists + has required structure.
// ---------------------------------------------------------------------------
let adrText = "";
if (!fs.existsSync(ADR_PATH)) {
  failures.push(
    `ADR-0017 (database backups) was deleted. Restore docs/adr/0017-database-backups.md. ` +
      `See _bmad-output/implementation-artifacts/5-6-daily-database-backups-verified.md for the decision rationale.`,
  );
} else {
  adrText = fs.readFileSync(ADR_PATH, "utf8");
  for (const heading of REQUIRED_ADR_HEADINGS) {
    if (!adrText.includes(heading)) {
      failures.push(
        `ADR-0017 is missing required heading "${heading}". The ADR must document the decision, verification ledger, and consequences.`,
      );
    }
  }
  for (const ref of REQUIRED_ADR_REFERENCES) {
    if (!adrText.includes(ref)) {
      failures.push(
        `ADR-0017 does not reference ${ref}. The ADR must map the decision to the PRD requirement it satisfies.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 2: docs/runbook.md exists + has the required backup sections.
// ---------------------------------------------------------------------------
if (!fs.existsSync(RUNBOOK_PATH)) {
  failures.push(
    `docs/runbook.md was deleted. The runbook is the on-call reference for restore procedures.`,
  );
} else {
  const runbookText = fs.readFileSync(RUNBOOK_PATH, "utf8");
  for (const heading of REQUIRED_RUNBOOK_HEADINGS) {
    if (!runbookText.includes(heading)) {
      failures.push(
        `docs/runbook.md is missing required heading "${heading}". The runbook must document the backup verification procedure, restore procedure, and quarterly drill cadence.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3: ADR-0017's Verification ledger has a recent-enough row.
// ---------------------------------------------------------------------------
// The check is run only if the ADR exists (we don't pile up failures
// when the parent file is missing — Check 1 already covers that).
if (adrText.length > 0) {
  const latest = mostRecentVerificationDate(adrText);
  if (latest === null) {
    failures.push(
      `ADR-0017 § Verification ledger has no dated rows. ` +
        `Perform the quarterly dashboard verification per docs/runbook.md → "Backup configuration verification (quarterly)" ` +
        `and append a YYYY-MM-DD row to the ledger.`,
    );
  } else {
    const now = Date.now();
    const ageDays = Math.floor((now - latest.date.getTime()) / DAY_MS);
    if (latest.kind === "deferred") {
      if (ageDays > DEFERRED_MAX_AGE_DAYS) {
        failures.push(
          `ADR-0017 § Verification ledger's deferred-placeholder row is ${ageDays} days old (max: ${DEFERRED_MAX_AGE_DAYS} days). ` +
            `Phase 1 build-out grace has elapsed; perform a real dashboard verification per docs/runbook.md → "Backup configuration verification (quarterly)" ` +
            `and append a non-deferred row.`,
        );
      } else {
        process.stdout.write(
          `[check-backups] OK — most recent row is a [deferred] placeholder, ${ageDays} days old (max: ${DEFERRED_MAX_AGE_DAYS}). ` +
            `First real verification still outstanding; track via runbook.\n`,
        );
      }
    } else if (ageDays > AGE_THRESHOLD_DAYS) {
      failures.push(
        `ADR-0017 § Verification ledger's most recent row is ${ageDays} days old (threshold: ${AGE_THRESHOLD_DAYS} days). ` +
          `The quarterly dashboard verification is overdue. Perform it per docs/runbook.md → "Backup configuration verification (quarterly)" ` +
          `and append a fresh row.`,
      );
    } else {
      process.stdout.write(
        `[check-backups] OK — last quarterly verification ${ageDays} days ago (threshold: ${AGE_THRESHOLD_DAYS}).\n`,
      );
    }
  }
}

/**
 * Extracts the most recent verification entry from the ADR's
 * `## Verification ledger` section.
 *
 * Parsing strategy (intentionally tolerant — markdown tables are
 * stylistic and we don't want a cell-alignment change to fail CI):
 *   1. Scan from the `## Verification ledger` heading to the next
 *      `##` heading.
 *   2. For each line that looks like a table row (contains `|`),
 *      find the first `YYYY-MM-DD` date.
 *   3. Inspect the same line for the `[deferred]` marker — if present,
 *      tag the entry as `deferred`; otherwise `confirmed`.
 *   4. Return the most-recent entry by date, or null if none found.
 *
 * The `[deferred]` marker is the seed placeholder Story 5.6 documents.
 * Other placeholders (TBD, ???) are intentionally NOT recognized — a
 * row that doesn't explicitly opt into the deferred grace falls through
 * to the standard cadence check.
 *
 * @param {string} adr
 * @returns {{ date: Date, kind: "confirmed" | "deferred" } | null}
 */
function mostRecentVerificationDate(adr) {
  const ledgerStart = adr.indexOf("## Verification ledger");
  if (ledgerStart === -1) return null;
  const afterLedger = adr.indexOf("\n## ", ledgerStart + 1);
  const block = adr.slice(
    ledgerStart,
    afterLedger === -1 ? adr.length : afterLedger,
  );
  const lines = block.split(/\r?\n/);
  /** @type {{ date: Date, kind: "confirmed" | "deferred" } | null} */
  let latest = null;
  for (const line of lines) {
    // Skip the table header / separator rows by requiring a vertical bar.
    if (!line.includes("|")) continue;
    const matches = line.match(/\b(\d{4})-(\d{2})-(\d{2})\b/g);
    if (matches === null) continue;
    const isDeferred = line.includes("[deferred]");
    for (const ymd of matches) {
      const [y, m, d] = ymd.split("-").map((s) => Number.parseInt(s, 10));
      const candidate = new Date(Date.UTC(y, m - 1, d));
      if (
        candidate.getUTCFullYear() === y &&
        candidate.getUTCMonth() === m - 1 &&
        candidate.getUTCDate() === d
      ) {
        if (latest === null || candidate.getTime() > latest.date.getTime()) {
          latest = {
            date: candidate,
            kind: isDeferred ? "deferred" : "confirmed",
          };
        }
      }
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Result.
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  process.exit(0);
}

for (const message of failures) {
  process.stderr.write(`[check-backups] ${message}\n`);
}
process.exit(1);
