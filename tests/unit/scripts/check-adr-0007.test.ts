/**
 * Story 2.8 — Unit tests for `scripts/check-adr-0007.js`.
 *
 * The script is the CI-time defense-in-depth for ADR-0007 (PII
 * encryption). It walks the repo, asserts ADR-0007 exists with the
 * required headings, and asserts no `v.bytes()` field has been added
 * to `customers` / `customerDocuments` in `convex/schema.ts` without
 * an explicit amendment marker. These tests guard the guard.
 *
 * Coverage target: 100% line coverage on the script — it's small (~80
 * lines) and high-stakes (compliance defense).
 *
 * Pattern: the script resolves `ADR_PATH` and `SCHEMA_PATH` relative
 * to its own location via `path.resolve(__dirname, "..")`. To test it
 * in isolation we materialize a temporary directory laid out the same
 * way as the real repo (a `scripts/`, `docs/adr/`, `convex/` tree),
 * copy the script there, then invoke it as a Node subprocess. This
 * gives us a clean fixture per case and exercises the real script
 * binary — no `import` of the module under test (which would pull
 * the real repo's files via the projectRoot resolve).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the real script in the repo. We COPY it into each fixture
// dir so the script's `path.resolve(__dirname, "..")` resolves to the
// fixture root, not the repo root.
const REAL_SCRIPT = path.resolve(__dirname, "..", "..", "..", "scripts", "check-adr-0007.js");

// Minimal valid ADR-0007 content for the happy-path fixtures. Real
// content lives in `docs/adr/0007-pii-encryption.md`; the script only
// requires the headings + NFR reference to be present.
const VALID_ADR_CONTENT = [
  "# ADR 0007: PII Encryption at Rest",
  "",
  "**Status:** Accepted",
  "",
  "## Context",
  "",
  "NFR-S2 requires PII to be encrypted at rest.",
  "",
  "## Decision",
  "",
  "Rely on Convex managed at-rest encryption.",
  "",
  "## Rejected alternatives",
  "",
  "Application-level AES-GCM was rejected.",
  "",
].join("\n");

// Minimal valid schema fixture — `customers` and `customerDocuments`
// declared with plain `v.string()` for `govIdNumber`. Mirrors the
// production schema's relevant fragment.
const VALID_SCHEMA_CONTENT = [
  "import { defineSchema, defineTable } from 'convex/server';",
  "import { v } from 'convex/values';",
  "",
  "export default defineSchema({",
  "  customers: defineTable({",
  "    fullName: v.string(),",
  "    govIdNumber: v.string(),",
  "  }),",
  "  customerDocuments: defineTable({",
  "    customerId: v.id('customers'),",
  "    storageId: v.id('_storage'),",
  "  }),",
  "});",
  "",
].join("\n");

interface Fixture {
  root: string;
  scriptPath: string;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "check-adr-0007-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "docs", "adr"), { recursive: true });
  mkdirSync(path.join(root, "convex"), { recursive: true });
  const scriptPath = path.join(root, "scripts", "check-adr-0007.js");
  copyFileSync(REAL_SCRIPT, scriptPath);
  return { root, scriptPath };
}

function writeAdr(fixture: Fixture, content: string): void {
  writeFileSync(path.join(fixture.root, "docs", "adr", "0007-pii-encryption.md"), content);
}

function writeSchema(fixture: Fixture, content: string): void {
  writeFileSync(path.join(fixture.root, "convex", "schema.ts"), content);
}

function runScript(fixture: Fixture): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [fixture.scriptPath], {
    encoding: "utf8",
    cwd: fixture.root,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("scripts/check-adr-0007.js", () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it("exits 0 when ADR-0007 exists with required headings and schema has no v.bytes()", () => {
    writeAdr(fixture, VALID_ADR_CONTENT);
    writeSchema(fixture, VALID_SCHEMA_CONTENT);
    const { status, stderr } = runScript(fixture);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("exits 0 with no schema present (script is robust to missing schema.ts)", () => {
    writeAdr(fixture, VALID_ADR_CONTENT);
    // Do NOT write schema.ts.
    const { status, stderr } = runScript(fixture);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("exits 1 with a descriptive message when ADR-0007 is deleted", () => {
    // Do NOT write the ADR file.
    writeSchema(fixture, VALID_SCHEMA_CONTENT);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    expect(stderr).toContain("ADR-0007");
    expect(stderr).toContain("deleted");
  });

  it("exits 1 when ADR-0007 is missing the `## Decision` heading", () => {
    const trimmedAdr = VALID_ADR_CONTENT.replace("## Decision", "## Conclusion");
    writeAdr(fixture, trimmedAdr);
    writeSchema(fixture, VALID_SCHEMA_CONTENT);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    expect(stderr).toContain("## Decision");
  });

  it("exits 1 when ADR-0007 is missing the `## Rejected alternatives` heading", () => {
    const trimmedAdr = VALID_ADR_CONTENT.replace("## Rejected alternatives", "## Other notes");
    writeAdr(fixture, trimmedAdr);
    writeSchema(fixture, VALID_SCHEMA_CONTENT);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    expect(stderr).toContain("## Rejected alternatives");
  });

  it("exits 1 when ADR-0007 does not reference NFR-S2", () => {
    const adrWithoutNfr = VALID_ADR_CONTENT.replace(
      "NFR-S2 requires PII to be encrypted at rest.",
      "Some text without the NFR reference.",
    );
    writeAdr(fixture, adrWithoutNfr);
    writeSchema(fixture, VALID_SCHEMA_CONTENT);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    expect(stderr).toContain("NFR-S2");
  });

  it("exits 1 when schema introduces v.bytes() in `customers` without the amendment marker", () => {
    writeAdr(fixture, VALID_ADR_CONTENT);
    const schemaWithBytes = VALID_SCHEMA_CONTENT.replace(
      "govIdNumber: v.string(),",
      "govIdNumberBytes: v.bytes(),",
    );
    writeSchema(fixture, schemaWithBytes);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    expect(stderr).toContain("v.bytes()");
    expect(stderr).toContain("customers");
  });

  it("exits 1 when schema introduces v.bytes() in `customerDocuments` without the amendment marker", () => {
    writeAdr(fixture, VALID_ADR_CONTENT);
    const schemaWithBytes = VALID_SCHEMA_CONTENT.replace(
      "storageId: v.id('_storage'),",
      "storageId: v.id('_storage'),\n    encryptedBlob: v.bytes(),",
    );
    writeSchema(fixture, schemaWithBytes);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    expect(stderr).toContain("v.bytes()");
    expect(stderr).toContain("customerDocuments");
  });

  it("exits 0 when schema introduces v.bytes() WITH the explicit amendment marker", () => {
    writeAdr(fixture, VALID_ADR_CONTENT);
    const schemaWithBytesAndMarker = [
      "// [adr-0007-amend] intentional bytes field — see ADR-0007 amendment",
      VALID_SCHEMA_CONTENT.replace(
        "govIdNumber: v.string(),",
        "govIdNumberBytes: v.bytes(),",
      ),
    ].join("\n");
    writeSchema(fixture, schemaWithBytesAndMarker);
    const { status, stderr } = runScript(fixture);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("reports multiple failures in one run when several checks fail", () => {
    // ADR missing entirely + schema has a stray v.bytes(); two failures.
    const schemaWithBytes = VALID_SCHEMA_CONTENT.replace(
      "govIdNumber: v.string(),",
      "govIdNumberBytes: v.bytes(),",
    );
    writeSchema(fixture, schemaWithBytes);
    const { status, stderr } = runScript(fixture);
    expect(status).toBe(1);
    // ADR-deleted failure
    expect(stderr).toContain("deleted");
    // bytes-without-marker failure
    expect(stderr).toContain("v.bytes()");
  });
});
