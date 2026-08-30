/**
 * Guard against a link that goes nowhere.
 *
 * The customer detail page offered "view activity" pointing at
 * `/audit?entityType=customer&entityId=…`. There is no `/audit` route —
 * the audit log lives at `/admin/audit-log` — so the link 404ed. It had
 * the right query parameters and the wrong path, which is exactly the
 * kind of mistake that survives review and reaches a user.
 *
 * Nothing in the type system connects an `href` string to the App
 * Router's directory tree, so this walks both and compares them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const APP = path.join(ROOT, "src", "app");

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

/**
 * Every route the App Router actually serves, as a list of segment
 * arrays. Route groups — `(staff)`, `(marketing)` — are filesystem
 * organisation and contribute nothing to the URL, so they are dropped.
 * A `[param]` segment matches anything.
 */
function routeSegments(): string[][] {
  const routes: string[][] = [];
  for (const file of walk(APP)) {
    const base = path.basename(file);
    if (!/^page\.tsx?$/.test(base)) continue;
    const rel = path.relative(APP, path.dirname(file));
    const segments = rel
      .split(path.sep)
      .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s));
    routes.push(segments);
  }
  return routes;
}

function matches(route: string[], target: string[]): boolean {
  if (route.length !== target.length) return false;
  return route.every(
    (seg, i) => /^\[.*\]$/.test(seg) || seg === target[i],
  );
}

describe("internal links point at routes that exist", () => {
  const routes = routeSegments();

  it("finds the app's routes at all", () => {
    // A silent zero would make the assertion below vacuous.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.some((r) => r.join("/") === "dashboard")).toBe(true);
    expect(routes.some((r) => r.join("/") === "admin/audit-log")).toBe(true);
  });

  it("has no /audit route — the audit log lives under /admin", () => {
    // The specific mistake this file was written for.
    expect(routes.some((r) => r.join("/") === "audit")).toBe(false);
    expect(existsSync(path.join(APP, "(staff)", "audit"))).toBe(false);
  });

  it("never links somewhere that does not exist", () => {
    const dead: string[] = [];

    for (const file of walk(path.join(ROOT, "src"))) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const src = readFileSync(file, "utf8");

      // `href="/x"` and href={`/x/${id}`} — the two JSX forms this
      // codebase uses. External links, anchors, mailto and tel are not
      // routes.
      //
      // Plus `href: "/x"`, the object-literal form. That is how the
      // SIDEBAR declares every one of its destinations, so without it
      // the most-clicked links in the whole app were the ones this
      // guard did not look at.
      const hrefs = [
        ...src.matchAll(/href=\{?[`"](\/[^`"?#]*)/g),
        ...src.matchAll(/href:\s*[`"](\/[^`"?#]*)/g),
      ].map((m) => m[1] ?? "");

      for (const href of hrefs) {
        const target = href
          .split("/")
          .filter((s) => s.length > 0)
          // A `${...}` interpolation stands in for a dynamic segment.
          .map((s) => (s.includes("${") ? "[param]" : s));

        // The root route.
        if (target.length === 0) continue;

        // A path served straight out of `public/` is a file, not a
        // route — the GPS import template download is one. Checked on
        // disk rather than by extension, so a link to a file that is
        // NOT there still fails.
        if (existsSync(path.join(ROOT, "public", ...target))) continue;

        const ok = routes.some((route) =>
          matches(
            route,
            target.map((s, i) =>
              s === "[param]" && /^\[.*\]$/.test(route[i] ?? "")
                ? (route[i] as string)
                : s,
            ),
          ),
        );
        if (!ok) dead.push(`${rel} → ${href}`);
      }
    }

    expect(dead).toEqual([]);
  });
});
