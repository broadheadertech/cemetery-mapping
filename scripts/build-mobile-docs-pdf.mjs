/**
 * Regenerate `_bmad-output/planning-artifacts/mobile-app-documentation.pdf`
 * from its two markdown sources.
 *
 *   node scripts/build-mobile-docs-pdf.mjs
 *
 * The PDF is committed so it can be handed to people who will not clone
 * the repo. This script is committed alongside it so the PDF never
 * becomes a binary nobody can rebuild — edit the markdown, run this,
 * commit both.
 *
 * ## Dependencies, deliberately not added to package.json
 *
 * Needs `marked` (markdown → HTML) and a Playwright browser. Neither is
 * a dependency of the application, and adding a markdown parser to the
 * app's dependency tree to typeset a planning document would be the
 * wrong trade. Install on demand:
 *
 *     npm i --no-save marked
 *     npx playwright install chromium
 *
 * If the pinned Playwright browser cannot be downloaded, point the
 * script at any Chromium or Chrome you already have:
 *
 *     CHROME_PATH="/path/to/chrome" node scripts/build-mobile-docs-pdf.mjs
 *
 * Typography and palette follow the park's brand tokens (tailwind.config.ts
 * and the brand guide), so the printed document matches the product.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(ROOT, "_bmad-output", "planning-artifacts");
const OUT = path.join(SRC_DIR, "mobile-app-documentation.pdf");

async function loadDeps() {
  let marked;
  try {
    ({ marked } = await import("marked"));
  } catch {
    console.error(
      "Missing `marked`. Install it without touching package.json:\n" +
        "  npm i --no-save marked",
    );
    process.exit(1);
  }
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    console.error(
      "Missing `playwright-core` — run `npm ci` first.",
    );
    process.exit(1);
  }
  return { marked, chromium };
}

const { marked, chromium } = await loadDeps();

marked.setOptions({ gfm: true, breaks: false });

/** YAML front matter is metadata for the BMAD tooling, not content. */
const stripFrontMatter = (md) =>
  md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");

/** The cover and part dividers already name each document. */
const stripLeadingH1 = (md) => md.replace(/^\s*#\s+.+\r?\n/, "");

const titleOf = (md, fallback) =>
  (md.match(/^#\s+(.+)$/m) || [, fallback])[1];

const specRaw = await readFile(path.join(SRC_DIR, "mobile-app-spec.md"), "utf8");
const epicsRaw = await readFile(
  path.join(SRC_DIR, "mobile-app-epics.md"),
  "utf8",
);

const specTitle = titleOf(specRaw, "Mobile App Specification");
const epicsTitle = titleOf(epicsRaw, "Epic Breakdown");
const specHtml = marked.parse(stripLeadingH1(stripFrontMatter(specRaw)));
const epicsHtml = marked.parse(stripLeadingH1(stripFrontMatter(epicsRaw)));

const CSS = `
  :root {
    --ground: #FFFFFF; --sunk: #F7F4ED;
    --rule: #DCD5C3; --rule-soft: #EAE4D6;
    --ink: #23221F; --ink-soft: #46443E; --stone: #77746C;
    --emerald: #1D5C4D; --gold: #B8975A;
  }
  @page { size: A4; margin: 17mm 15mm 18mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font-family: "Manrope", ui-sans-serif, system-ui, sans-serif;
    font-weight: 350; font-size: 10.1pt; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .cover { height: 244mm; display: flex; flex-direction: column; justify-content: space-between; break-after: page; }
  .cover .top { display: flex; flex-direction: column; gap: 1.1rem; }
  .cover .eyebrow, .divider .eyebrow {
    font-family: "JetBrains Mono", monospace; font-size: 7.5pt;
    letter-spacing: .24em; text-transform: uppercase; color: var(--stone);
  }
  .cover h1 {
    font-family: "Cormorant Garamond", Georgia, serif; font-weight: 300;
    font-size: 38pt; line-height: 1.05; letter-spacing: -.01em; margin: 0;
    text-wrap: balance;
  }
  .cover .hair, .divider .hair { height: 1px; background: var(--gold); }
  .cover .hair { width: 46mm; }
  .cover .blurb { font-size: 11pt; color: var(--ink-soft); max-width: 118mm; }
  .cover .contents { display: flex; flex-direction: column; gap: .5rem; }
  .cover .contents .row {
    display: grid; grid-template-columns: 8mm 1fr; gap: 6mm;
    padding: .5rem 0; border-top: 1px solid var(--rule-soft); font-size: 10pt;
  }
  .cover .contents .row .n { font-family: "JetBrains Mono", monospace; font-size: 8pt; color: var(--gold); }
  .cover .contents .row strong { font-weight: 600; display: block; }
  .cover .contents .row span { color: var(--stone); font-size: 9pt; }
  .cover .foot {
    font-family: "JetBrains Mono", monospace; font-size: 7.5pt;
    color: var(--stone); display: flex; flex-direction: column; gap: .3rem;
  }

  .divider { break-before: page; padding-top: 46mm; display: flex; flex-direction: column; gap: .9rem; break-after: page; }
  .divider .eyebrow { color: var(--gold); }
  .divider h2 { font-family: "Cormorant Garamond", Georgia, serif; font-weight: 300; font-size: 30pt; line-height: 1.08; margin: 0; }
  .divider .hair { width: 30mm; }
  .divider p { margin: 0; color: var(--ink-soft); max-width: 110mm; font-size: 10.5pt; }

  .doc h1, .doc h2, .doc h3, .doc h4 {
    font-family: "Cormorant Garamond", Georgia, serif; font-weight: 400;
    margin: 0; text-wrap: balance; break-after: avoid;
  }
  .doc h2 {
    font-size: 19pt; line-height: 1.14; margin-top: 11mm; margin-bottom: 3mm;
    padding-bottom: 2mm; border-bottom: 1px solid var(--rule); break-before: page;
  }
  .doc > h2:first-child { break-before: avoid; margin-top: 0; }
  .doc h3 { font-size: 13.5pt; line-height: 1.2; margin-top: 7mm; margin-bottom: 2mm; color: var(--emerald); }
  .doc h4 {
    font-family: "Manrope", sans-serif; font-weight: 600; font-size: 10pt;
    margin-top: 5mm; margin-bottom: 1.5mm; letter-spacing: -.005em;
  }
  .doc p { margin: 0 0 2.6mm; }
  .doc ul, .doc ol { margin: 0 0 3mm; padding-left: 5.5mm; }
  .doc li { margin-bottom: 1.1mm; }
  .doc li > ul, .doc li > ol { margin-top: 1.1mm; margin-bottom: 0; }
  .doc strong { font-weight: 600; }
  .doc a { color: var(--emerald); text-decoration: none; }
  .doc hr { border: 0; border-top: 1px solid var(--rule-soft); margin: 6mm 0; }
  .doc blockquote { margin: 0 0 3mm; padding: 1.5mm 0 1.5mm 4mm; border-left: 2px solid var(--gold); color: var(--ink-soft); }
  .doc blockquote p:last-child { margin-bottom: 0; }
  .doc code {
    font-family: "JetBrains Mono", ui-monospace, monospace; font-size: .84em;
    background: var(--sunk); border: 1px solid var(--rule-soft);
    border-radius: 2px; padding: .05em .3em;
  }
  .doc pre {
    background: var(--sunk); border: 1px solid var(--rule-soft); border-radius: 3px;
    padding: 3mm 3.5mm; margin: 0 0 3.5mm; overflow-x: auto; break-inside: avoid;
  }
  .doc pre code {
    background: none; border: 0; padding: 0; font-size: 8.1pt;
    line-height: 1.45; white-space: pre-wrap; word-break: break-word;
  }
  .doc table { width: 100%; border-collapse: collapse; margin: 0 0 4mm; font-size: 9pt; }
  .doc thead { display: table-header-group; }
  .doc th, .doc td { text-align: left; vertical-align: top; padding: 1.8mm 2.4mm; border-bottom: 1px solid var(--rule-soft); }
  .doc th {
    font-family: "JetBrains Mono", monospace; font-weight: 400; font-size: 7.4pt;
    letter-spacing: .1em; text-transform: uppercase; color: var(--stone);
    background: var(--sunk); border-bottom: 1px solid var(--rule);
  }
  .doc tr { break-inside: avoid; }
  .doc td code { white-space: nowrap; }
`;

const html = `<!doctype html>
<html lang="en-PH">
<head>
<meta charset="utf-8">
<title>Mobile Companion App</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500&family=JetBrains+Mono:wght@300;400&family=Manrope:wght@300;400;500;600&display=swap">
<style>${CSS}</style>
</head>
<body>
<section class="cover">
  <div class="top">
    <div class="eyebrow">Apostle Paul Memorial Park &middot; Aringay, La Union</div>
    <h1>Mobile companion app</h1>
    <div class="hair"></div>
    <p class="blurb">The specification and the work breakdown for the customer-facing mobile app — online reservation, online booking, and the 3D park views — planned as an eight-week build on top of the existing Convex backend.</p>
  </div>
  <div class="contents">
    <div class="row"><span class="n">I</span><span><strong>${specTitle}</strong><span>What is being built, the architecture, the backend work it needs, the timeline, and the open questions.</span></span></div>
    <div class="row"><span class="n">II</span><span><strong>${epicsTitle}</strong><span>The same scope as epics and stories, with acceptance criteria.</span></span></div>
  </div>
  <div class="foot">
    <span>Planning artifact &middot; not yet built</span>
    <span>_bmad-output/planning-artifacts/</span>
  </div>
</section>

<section class="divider">
  <div class="eyebrow">Part one</div>
  <h2>${specTitle}</h2>
  <div class="hair"></div>
  <p>What the app is, how it fits the backend that already exists, and what has to be built to support it.</p>
</section>
<div class="doc">${specHtml}</div>

<section class="divider">
  <div class="eyebrow">Part two</div>
  <h2>${epicsTitle}</h2>
  <div class="hair"></div>
  <p>The same scope, broken into epics and stories with acceptance criteria.</p>
</section>
<div class="doc">${epicsHtml}</div>
</body>
</html>`;

const launchOptions = {};
if (typeof process.env.CHROME_PATH === "string" && process.env.CHROME_PATH.length > 0) {
  launchOptions.executablePath = process.env.CHROME_PATH;
}

let browser;
try {
  browser = await chromium.launch(launchOptions);
} catch (err) {
  console.error(
    `Could not launch Chromium: ${err instanceof Error ? err.message : String(err)}\n` +
      "Run `npx playwright install chromium`, or set CHROME_PATH to a Chrome you already have.",
  );
  process.exit(1);
}

const page = await browser.newPage();
const failedFonts = [];
page.on("requestfailed", (r) => {
  if (r.url().includes("fonts.")) failedFonts.push(r.url());
});

await page.setContent(html, { waitUntil: "networkidle" });
// Pagination is measured against the final faces, so wait for them.
await page.evaluate(() => document.fonts.ready);

const pdf = await page.pdf({
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate:
    '<div style="width:100%;font-family:Georgia,serif;font-size:7pt;color:#8E8C85;' +
    'padding:0 15mm;display:flex;justify-content:space-between;">' +
    "<span>Apostle Paul Memorial Park &middot; Mobile Companion App</span>" +
    '<span class="pageNumber"></span></div>',
  margin: { top: "17mm", right: "15mm", bottom: "18mm", left: "15mm" },
});

await writeFile(OUT, pdf);
await browser.close();

console.log(`wrote ${path.relative(ROOT, OUT)} (${(pdf.length / 1024).toFixed(0)} KB)`);
if (failedFonts.length > 0) {
  console.warn(
    `${failedFonts.length} webfont request(s) failed — the PDF fell back to Georgia / system faces.`,
  );
}
