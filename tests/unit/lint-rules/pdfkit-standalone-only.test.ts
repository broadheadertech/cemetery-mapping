/**
 * Every PDF generator must go through `convex/lib/pdfDocument.ts`.
 *
 * Importing `"pdfkit"` directly works perfectly on a developer's
 * machine and fails on every deployment. PDFKit reads its standard-font
 * metrics off disk:
 *
 *     fs.readFileSync(`${__dirname}/data/Helvetica.afm`)
 *
 * A local `node_modules` has that file. A Convex bundle does not, so the
 * deployed action dies with
 *
 *     ENOENT: no such file or directory, open '/var/task/data/Helvetica.afm'
 *
 * which is what took out receipts, contracts, demand letters, plaques
 * and report exports in production. Nothing in lint, typecheck, unit
 * tests or the local app could see it — the code is correct, the
 * environment is not.
 *
 * So the rule is enforced here instead: the constructor comes from the
 * shared module, which uses PDFKit's standalone build with the metrics
 * inlined.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SHARED = "convex/lib/pdfDocument.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("pdfkit imports", () => {
  const files = walk(path.join(ROOT, "convex"));

  it("has the shared module that owns the import", () => {
    const shared = readFileSync(path.join(ROOT, SHARED), "utf8");
    expect(shared).toContain("pdfkit/js/pdfkit.standalone.js");
  });

  it("nothing else imports pdfkit for a value", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      if (rel === SHARED) continue;
      // The standalone build's type declaration necessarily names the
      // package, and it emits nothing.
      if (rel.endsWith(".d.ts")) continue;

      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/from\s+["']pdfkit["']/.test(line)) continue;
        // `import type` is erased at compile time and cannot drag the
        // filesystem-reading build into the bundle.
        if (/^\s*import\s+type\s/.test(line)) continue;
        offenders.push(`${rel}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      `Import the constructor from ${SHARED} instead — a direct "pdfkit" ` +
        "import renders fine locally and throws ENOENT on Helvetica.afm " +
        "once deployed:\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("every generator actually uses the shared module", () => {
    const generators = files.filter((f) =>
      /generate.*Pdf\.ts$|generateReportExport\.ts$/.test(f),
    );
    // A silent zero would make this vacuous.
    expect(generators.length).toBeGreaterThanOrEqual(4);

    for (const file of generators) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      expect(src, `${rel} should import from lib/pdfDocument`).toMatch(
        /from\s+["']\.\.\/lib\/pdfDocument["']/,
      );
    }
  });
});
