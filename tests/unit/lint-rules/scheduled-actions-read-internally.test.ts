/**
 * Guard against an action that cannot authenticate calling a query that
 * demands authentication.
 *
 * Every report export failed. `exports:requestExport` scheduled
 * `generateReportExport` with `ctx.scheduler.runAfter`, and a SCHEDULED
 * action carries no user identity — `ctx.auth` is empty. The action
 * then called `reports:salesByDimension`, which is
 * `requireRole(["admin"])`, so the read threw UNAUTHENTICATED and the
 * export dropped into `failed`. The code even carried a comment
 * describing an "auth-chain" back through those queries, which is not
 * how a scheduled action authenticates.
 *
 * It fails quietly: the button works, the row appears, and the file
 * never arrives. Nothing in the type system connects a scheduled action
 * to the role gate on the far side of a `runQuery`, so this reads both.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const CONVEX = path.join(ROOT, "convex");

function convexFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "_generated") continue;
      convexFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Public queries and the roles they demand, keyed by the
 * `module:export` path a `makeFunctionReference` would name.
 *
 * Internal ones are deliberately absent — they are the safe thing for a
 * scheduled action to read, and the whole point of the fix.
 */
function roleGatedQueries(): Set<string> {
  const gated = new Set<string>();
  for (const file of convexFiles(CONVEX)) {
    const src = readFileSync(file, "utf8");
    const moduleName = path
      .relative(CONVEX, file)
      .replace(/\\/g, "/")
      .replace(/\.ts$/, "");
    const re = /export const (\w+)\s*=\s*queryGeneric\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = src.slice(m.index, m.index + 1600);
      if (/requireRole\(\s*ctx\s*,\s*\[/.test(body)) {
        gated.add(`${moduleName}:${m[1]}`);
      }
    }
  }
  return gated;
}

/** Files whose exported actions are reached via `scheduler.runAfter`. */
function scheduledActionFiles(): Set<string> {
  const scheduled = new Set<string>();
  for (const file of convexFiles(CONVEX)) {
    const src = readFileSync(file, "utf8");
    // `>("actions/generateReportExport:generateReportExport")` next to a
    // `runAfter` in the same file is how this codebase schedules.
    if (!src.includes("scheduler.runAfter")) continue;
    for (const m of src.matchAll(/>\("(actions\/[\w/]+):\w+"\)/g)) {
      scheduled.add(path.join(CONVEX, `${m[1]}.ts`));
    }
    for (const m of src.matchAll(/"(actions\/[\w/]+):\w+"/g)) {
      scheduled.add(path.join(CONVEX, `${m[1]}.ts`));
    }
  }
  return scheduled;
}

describe("scheduled actions read through internal queries", () => {
  const gated = roleGatedQueries();
  const scheduled = scheduledActionFiles();

  it("finds the role-gated queries to check against", () => {
    // A silent zero would make the assertion below vacuous.
    expect(gated.size).toBeGreaterThan(10);
    expect(gated.has("reports:salesByDimension")).toBe(true);
    expect(gated.has("auditLogQueries:listRecent")).toBe(true);
  });

  it("finds the scheduled actions", () => {
    expect(scheduled.size).toBeGreaterThan(0);
    const names = [...scheduled].map((f) => path.basename(f));
    expect(names).toContain("generateReportExport.ts");
  });

  it("never calls a role-gated query from one", () => {
    // The bug, stated as a rule. A scheduled action has no identity;
    // the authorisation belongs on the mutation that scheduled it.
    const offenders: string[] = [];

    for (const file of scheduled) {
      let src: string;
      try {
        src = readFileSync(file, "utf8");
      } catch {
        continue; // A path this heuristic built that is not a real file.
      }
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      for (const ref of gated) {
        if (src.includes(`"${ref}"`)) {
          offenders.push(`${rel} reads ${ref}, which requires a role`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the export renderer reads the internal versions", () => {
    // Positive form of the same rule, so deleting the internal queries
    // breaks a test rather than silently reverting the fix.
    const src = readFileSync(
      path.join(CONVEX, "actions", "generateReportExport.ts"),
      "utf8",
    );
    expect(src).toContain("reports:internal_salesByDimensionForExport");
    expect(src).toContain("arAging:internal_agingSummaryForExport");
    expect(src).toContain("auditLogQueries:internal_recentAuditPageForExport");
  });
});
