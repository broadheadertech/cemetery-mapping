/**
 * The app must not disclaim features it already has.
 *
 * Three panels reserved space on live screens and rendered "coming in
 * Epic 3" into it. Epic 3 shipped. The payments, contracts and
 * documents existed, the indexes existed, and the pages went on telling
 * staff a working part of the system was unbuilt — while the records
 * they disclaimed sat one screen away.
 *
 * Nothing fails when that happens. The page renders, the tests pass,
 * and the only cost is that somebody stops looking. So it is checked
 * here instead: a promise about a future release has no business on a
 * screen somebody uses today.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/**
 * Only text a user can read counts.
 *
 * A comment explaining that a slot is reserved is documentation and
 * belongs in the file — several of the notes written while removing
 * these panels say "coming in Epic 3" precisely to record what was
 * there. A sentence RENDERED to somebody at a desk is a different
 * thing: a claim about the product.
 */
function renderedText(src: string): string {
  const withoutBlockComments = src.split("/*").map((chunk, i) => {
    if (i === 0) return chunk;
    const end = chunk.indexOf("*/");
    return end === -1 ? "" : chunk.slice(end + 2);
  });
  return withoutBlockComments
    .join("")
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      // Leave URLs alone: "https://" is not a comment.
      if (at > 0 && line[at - 1] === ":") return line;
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

describe("screens people actually use", () => {
  const files = walk(SRC);

  it("finds source to check", () => {
    // Guard against the walk silently matching nothing and every
    // assertion below passing vacuously.
    expect(files.length).toBeGreaterThan(50);
  });

  it("promises nothing about a future epic, story or phase", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (/coming in (epic|story|phase)\s*\d/i.test(renderedText(readFileSync(file, "utf8")))) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not say 'coming soon' to somebody trying to work", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (/coming soon/i.test(renderedText(readFileSync(file, "utf8")))) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has retired the three placeholder panels", () => {
    // Named individually because these were mounted on live pages, not
    // parked on a branch: every lot page and every customer page.
    const names = files.map((f) => path.basename(f));
    for (const gone of [
      "PaymentHistoryPlaceholder.tsx",
      "ContractsPlaceholder.tsx",
      "DocumentsPlaceholder.tsx",
    ]) {
      expect(names).not.toContain(gone);
    }
  });
});
