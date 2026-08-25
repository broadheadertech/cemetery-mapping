/**
 * Guard against a bug that reached production: a page every staff role
 * opens calling a query only admins may run.
 *
 * `/dashboard` asked for `dashboard:getDashboardKpis`,
 * `dashboard:getFlaggedForFollowupSummary` and — through the
 * reconciliation banner — `reconciliation:listOpenReconciliationFailures`,
 * all of which are `requireRole(ctx, ["admin"])`. Both call sites
 * carried a comment asserting that Convex surfaces a rejected query as
 * `undefined`, so a non-admin would simply see a "degraded view".
 *
 * That is not what `useQuery` does. It THROWS during render. Office
 * staff and field workers signing in got an uncaught FORBIDDEN instead
 * of a dashboard.
 *
 * The fix is to pass `"skip"` unless the caller holds the role. This
 * test encodes the rule so the next person to add a privileged panel to
 * a shared page finds out here rather than from a user.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Convex functions whose handler gates on `admin` and nothing else. */
function adminOnlyFunctions(): Set<string> {
  const found = new Set<string>();
  const convexDir = path.join(ROOT, "convex");
  for (const file of readdirSync(convexDir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(path.join(convexDir, file), "utf8");
    const moduleName = file.slice(0, -3);
    // Queries only. A mutation fires on a click, so a role that
    // cannot run it simply gets an error from an action it should
    // not have been offered — bad, but not a page that fails to
    // render. This guard is about the render path.
    const re = /export const (\w+)\s*=\s*queryGeneric\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const body = src.slice(m.index, m.index + 1600);
      const roles = /requireRole\(\s*ctx\s*,\s*\[([^\]]*)\]/.exec(body);
      if (!roles) continue;
      const list = roles[1]!
        .split(",")
        .map((r) => r.trim().replace(/["']/g, ""))
        .filter(Boolean);
      if (list.length === 1 && list[0] === "admin") {
        found.add(`${moduleName}:${m[1]}`);
      }
    }
  }
  return found;
}

describe("admin-only Convex queries on shared pages", () => {
  const adminOnly = adminOnlyFunctions();

  it("finds the admin-only functions to check against", () => {
    // A silent zero here would make every assertion below vacuous.
    expect(adminOnly.size).toBeGreaterThan(5);
    expect(adminOnly.has("dashboard:getDashboardKpis")).toBe(true);
    expect(
      adminOnly.has("reconciliation:listOpenReconciliationFailures"),
    ).toBe(true);
  });

  it("never calls one from a non-/admin surface without a skip gate", () => {
    const offenders: string[] = [];

    for (const file of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const src = readFileSync(file, "utf8");
      if (!src.includes("useQuery(")) continue;
      // Route families the middleware gates on `admin` — a non-admin
      // never renders these, so their queries cannot reject.
      // Keep in step with `isAdminRoute` in src/middleware.ts.
      if (rel.includes("/admin/") || rel.includes("/reports/")) continue;
      // A component that only ever renders on one of those routes can
      // say so rather than gate a query it does not own.
      if (src.includes("@admin-route-only")) continue;


      for (const fn of adminOnly) {
        if (!src.includes(`"${fn}"`)) continue;
        // The reference must be reachable only behind a `"skip"`.
        if (!src.includes('"skip"')) {
          offenders.push(`${rel} calls ${fn} with no "skip" gate`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
