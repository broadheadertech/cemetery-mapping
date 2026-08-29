/**
 * Guard against a bug that reached production: a page every staff role
 * opens calling a query that role may not run.
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
 * Sweeping every page against the roles its queries demand found the
 * same shape on twenty-five more: pages calling
 * `["admin", "office_staff"]` queries that a signed-in FIELD WORKER
 * could open by typing the URL. So this file no longer checks only
 * admin-only functions — it checks every query whose role list omits a
 * role that can reach the page.
 *
 * Two ways to satisfy it, and the second is usually right:
 *   1. Gate the query with `"skip"` unless the caller holds the role.
 *   2. Gate the ROUTE FAMILY in `src/middleware.ts`, so the page never
 *      renders for that role at all. One edge rule beats twenty-five
 *      hand-written skip gates that must be remembered on every new page.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

/**
 * Route prefixes the middleware gates by role, so a page under one of
 * them never renders for a role its queries would reject.
 *
 * MUST be kept in step with `isAdminRoute` / `isOfficeRoute` in
 * `src/middleware.ts`. A prefix listed here that is NOT gated there
 * silently re-opens the hole this file exists to close — which is why
 * the last test in this file reads the middleware and checks.
 */
const EDGE_GATED_PREFIXES = [
  "/admin/",
  "/reports/",
  "/ar-aging/",
  "/contracts/",
  "/customers/",
  "/enquiries/",
  "/expenses/",
  "/family-estates/",
  "/flagged-followups/",
  "/follow-ups/",
  "/payments/",
  "/receipts/",
  "/sales/",
  "/phase-planning/",
  "/analytics/",
  "/certificates/",
  // Customer portal — middleware sends every non-customer to /dashboard.
  "/(customer)/",
];

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

interface GatedFn {
  /** `module:exportName` as it appears in `makeFunctionReference`. */
  ref: string;
  roles: string[];
}

/**
 * Every public Convex QUERY and the roles it admits.
 *
 * Queries only. A mutation fires on a click, so a role that cannot run
 * it simply gets an error from an action it should not have been
 * offered — bad, but not a page that fails to render. This guard is
 * about the render path.
 */
function gatedQueries(): GatedFn[] {
  const found: GatedFn[] = [];
  const convexDir = path.join(ROOT, "convex");
  for (const file of readdirSync(convexDir)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(path.join(convexDir, file), "utf8");
    const moduleName = file.slice(0, -3);
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
      if (list.length === 0) continue;
      found.push({ ref: `${moduleName}:${m[1]}`, roles: list });
    }
  }
  return found;
}

function isEdgeGated(rel: string): boolean {
  return EDGE_GATED_PREFIXES.some((p) => rel.includes(p));
}

describe("restricted Convex queries on shared pages", () => {
  const queries = gatedQueries();

  it("finds the functions to check against", () => {
    // A silent zero here would make every assertion below vacuous.
    expect(queries.length).toBeGreaterThan(20);
    const refs = new Set(queries.map((q) => q.ref));
    expect(refs.has("dashboard:getDashboardKpis")).toBe(true);
    expect(refs.has("reconciliation:listOpenReconciliationFailures")).toBe(
      true,
    );
  });

  it("never calls one from a page the excluded role can open", () => {
    // A field worker is the role that can reach the most staff pages,
    // so it is the one that finds these. A query omitting it, on a page
    // no middleware rule keeps them off, is a crash waiting for the
    // next person who signs in with a field account.
    const offenders: string[] = [];

    for (const file of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const src = readFileSync(file, "utf8");
      if (!src.includes("useQuery(")) continue;
      if (isEdgeGated(rel)) continue;
      // A component that only ever renders on a gated route can say so
      // rather than gate a query it does not own. The marker is a claim
      // about where the component mounts, so it must name the route
      // family — an unexplained one is unverifiable and would let this
      // guard be silenced by a word.
      if (
        src.includes("@admin-route-only") ||
        src.includes("@gated-route-only")
      ) {
        continue;
      }

      for (const q of queries) {
        if (!src.includes(`"${q.ref}"`)) continue;
        if (q.roles.includes("field_worker")) continue;
        // The reference must be reachable only behind a `"skip"`.
        if (!src.includes('"skip"')) {
          offenders.push(
            `${rel}\n    calls ${q.ref} [${q.roles.join("+")}] with no "skip" gate and no middleware rule`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the exclusion list is not a lie", () => {
  // Every prefix skipped above claims the middleware keeps the wrong
  // role out. If someone deletes a matcher entry, these tests stop
  // skipping honestly and start hiding the bug they were written for.
  const middleware = readFileSync(
    path.join(ROOT, "src", "middleware.ts"),
    "utf8",
  );

  /**
   * The routes inside ONE matcher declaration.
   *
   * Scoped deliberately. Grepping the whole file for `"/customers"`
   * passes while that entry sits in `isStaffRoute` — which only decides
   * where an UNAUTHENTICATED visitor is sent, and does nothing to keep
   * a signed-in field worker out. Checked that way, deleting the entry
   * from `isOfficeRoute` would leave this suite green and the hole
   * open; verified by deleting it.
   */
  function routesIn(matcherName: string): Set<string> {
    const start = middleware.indexOf(`const ${matcherName} = createRouteMatcher(`);
    if (start === -1) return new Set();
    const end = middleware.indexOf("]);", start);
    const block = middleware.slice(start, end);
    return new Set(
      [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!),
    );
  }

  it("every skipped route family is gated by a ROLE matcher", () => {
    const gating = new Set([
      ...routesIn("isAdminRoute"),
      ...routesIn("isOfficeRoute"),
      ...routesIn("isCustomerRoute"),
    ]);
    expect(gating.size).toBeGreaterThan(10);

    const missing = EDGE_GATED_PREFIXES.filter((p) => {
      // Route groups are a filesystem concept, not a URL — `(customer)`
      // has no matcher entry; `/portal` is its URL.
      if (p === "/(customer)/") return !gating.has("/portal");
      return !gating.has(p.replace(/\/$/, ""));
    });
    expect(missing).toEqual([]);
  });

  it("an exact-path gate covers the page claiming it", () => {
    // `/interments` is gated by exact path, not as a family, because
    // field workers work inside the rest of that branch. The index page
    // carries `@gated-route-only` on the strength of that one entry.
    expect(routesIn("isOfficeRoute").has("/interments")).toBe(true);
    expect(routesIn("isOfficeRoute").has("/interments/quick")).toBe(true);
    // And the field worker's own screens must NOT be swept up.
    expect(routesIn("isOfficeRoute").has("/interments/(.*)")).toBe(false);
  });

  it("middleware actually redirects field workers off office routes", () => {
    expect(middleware).toContain("isOfficeRoute");
    expect(middleware).toMatch(
      /isOfficeRoute\(request\)[\s\S]{0,200}office_staff[\s\S]{0,120}nextjsMiddlewareRedirect/,
    );
  });

  it("middleware still redirects non-admins off admin routes", () => {
    expect(middleware).toMatch(
      /isAdminRoute\(request\)\s*&&\s*!roles\.includes\("admin"\)/,
    );
  });
});
