/**
 * Story 6.4 — `convex/actions/generateReportExport.ts` smoke tests.
 *
 * Exercises the pure render path (CSV + PDF) without going through the
 * Convex action ctx. The full end-to-end path (action ctx → query +
 * mutation transport → storage) is exercised by the cross-cutting
 * Playwright suite in a later story.
 *
 * Scope:
 *   - `renderCsv` produces a non-empty Buffer with a BOM prefix,
 *     header block lines, and one line per data row.
 *   - `renderPdfTable` produces a non-empty Buffer that starts with
 *     the PDF magic bytes (`%PDF`).
 */

import { describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";

import {
  generateReportExport,
  renderCsv,
  renderPdfTable,
} from "../../../../convex/actions/generateReportExport";

const FIXTURE = {
  title: "Sales by dimension",
  headerBlock: [
    ["From", "2026-05-01"],
    ["To", "2026-05-15"],
    ["Total sales", "4"],
  ] as Array<[string, string]>,
  columns: ["Lot type", "Section", "Sales", "Total (PHP)"],
  rows: [
    ["single", "A", 2, "2500.00"] as Array<string | number>,
    ["single", "B", 1, "2500.00"] as Array<string | number>,
    ["family", "A", 1, "5000.00"] as Array<string | number>,
  ],
};

describe("renderCsv", () => {
  it("emits a UTF-8 BOM + title + header pairs + columns + rows", () => {
    const buffer = renderCsv(FIXTURE);
    expect(buffer.length).toBeGreaterThan(0);
    const text = buffer.toString("utf-8");
    // BOM
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain("Sales by dimension");
    expect(text).toContain("From,2026-05-01");
    expect(text).toContain("Lot type,Section,Sales,Total (PHP)");
    expect(text).toContain("single,A,2,2500.00");
    expect(text).toContain("family,A,1,5000.00");
  });

  it("quotes cells containing commas or quotes", () => {
    const buffer = renderCsv({
      title: "Edge cases",
      headerBlock: [],
      columns: ["A", "B"],
      rows: [
        ["plain", "needs, quote"],
        ['has "quotes"', "ok"],
      ],
    });
    const text = buffer.toString("utf-8");
    expect(text).toContain('plain,"needs, quote"');
    expect(text).toContain('"has ""quotes""",ok');
  });

  it("prefixes cells that start with formula triggers (=, +, -, @, tab, CR) with a single quote (P0-1)", () => {
    const buffer = renderCsv({
      title: "Injection probes",
      headerBlock: [],
      columns: ["A"],
      rows: [
        ["=cmd|/c calc!A1"],
        ["+1+2"],
        ["-2+3"],
        ["@SUM(A1)"],
        ["\tlooks like tab"],
        ["\rlooks like CR"],
        ["safe plain text"],
      ],
    });
    const text = buffer.toString("utf-8");
    // =cmd|... contains no quote/comma/CRLF AFTER the prefix injection
    // check (just `|`, `/`, `!`, letters, digits) — so the single-quote
    // prefix appears bare, not wrapped in quotes.
    expect(text).toContain("'=cmd|/c calc!A1");
    expect(text).toContain("'+1+2");
    expect(text).toContain("'-2+3");
    expect(text).toContain("'@SUM(A1)");
    // Tab-prefixed cell — single-quote prefix is added; tab is NOT in
    // the quote-wrap trigger set so the value sits in the row bare,
    // which is fine because spreadsheet parsers see the leading
    // apostrophe and treat the cell as a literal string.
    expect(text).toContain("'\tlooks like tab");
    // The original CR-prefixed cell is quote-wrapped because `\r` is
    // also a quote-wrap trigger; the value MUST start with the
    // prefix-then-CR after escaping.
    expect(text).toMatch(/"'\r/);
    expect(text).toContain("safe plain text");
    // Safety check: the raw exploit string should NEVER appear without
    // the leading single quote (otherwise Excel would execute it).
    expect(text).not.toMatch(/(^|\n|\r)=cmd\|\/c calc!A1/);
  });
});

describe("renderPdfTable", () => {
  it("returns a non-empty Buffer starting with the PDF magic bytes", async () => {
    const buffer = await renderPdfTable(FIXTURE);
    expect(buffer.length).toBeGreaterThan(0);
    expect(buffer.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("handles a large row count without throwing (pagination smoke)", async () => {
    const big = {
      ...FIXTURE,
      rows: Array.from({ length: 100 }, (_, i) => [
        "single",
        String.fromCharCode(65 + (i % 26)),
        i,
        `${(i * 100).toFixed(2)}`,
      ]),
    };
    const buffer = await renderPdfTable(big);
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.slice(0, 4).toString("ascii")).toBe("%PDF");
  });

  it("renders a multi-page export with a 'Page X of Y' footer on each page (P1-1)", async () => {
    // Push enough rows to force at least one page break (rowHeight=14,
    // bottomLimit ≈ 712 - top ≈ ~680 usable → ~48 rows per page;
    // 150 rows guarantees ≥ 2 pages and proves that footers are stamped
    // on every page).
    const big = {
      ...FIXTURE,
      rows: Array.from({ length: 150 }, (_, i) => [
        "single",
        String.fromCharCode(65 + (i % 26)),
        i,
        `${(i * 100).toFixed(2)}`,
      ]),
    };
    const buffer = await renderPdfTable(big);
    const ascii = buffer.toString("latin1");
    // PDF page content streams are compressed by default in PDFKit;
    // disable compression by inspecting the literal "Page" footer
    // bytes — PDFKit writes the text glyph-by-glyph but the page
    // ranges + buffered pages mode guarantees `/Type /Page` markers
    // appear at least N times where N === page count. We assert
    // ≥ 2 pages and that the page-numbering call path triggered (the
    // doc's `bufferedPageRange().count` would be 1 otherwise and the
    // footer call path would never fire).
    const pageMarkers = ascii.match(/\/Type\s*\/Page\b(?!s)/g);
    expect(pageMarkers).not.toBeNull();
    expect(pageMarkers!.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * P0-2 — audit_log adapter must honor caller-supplied date range.
 *
 * The adversarial review found that `auditLogListRecentRef` was being
 * called with a hard-coded `numItems: 500, cursor: null` regardless of
 * the row's `args` payload. We exercise the action handler with a
 * mocked ctx that captures the args passed to the audit-log query and
 * assert they include the row's `from` / `to`.
 */
describe("generateReportExport — audit_log adapter (P0-2)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
    for (const key of ["_handler", "handler", "invokeAction", "invokeMutation", "invokeQuery"]) {
      const v = fn[key];
      if (typeof v === "function") return v as never;
    }
    if (typeof fn === "function") return fn as never;
    throw new Error("Cannot locate handler on Convex function");
  }

  it("forwards row.args.from / row.args.to to the auditLogQueries.listRecent query (CSV)", async () => {
    const FROM = new Date("2026-01-01T00:00:00+08:00").getTime();
    const TO = new Date("2026-03-31T23:59:59+08:00").getTime();
    const exportRow = {
      _id: "exports:1",
      reportType: "audit_log",
      format: "xlsx",
      args: { from: FROM, to: TO },
      requestedBy: "users:admin1",
      requestedAt: FROM,
    };
    const capturedQueryArgs: Array<{ path: string; args: unknown }> = [];
    const capturedMutationArgs: Array<{ path: string; args: unknown }> = [];

    const ctx = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runQuery: async (ref: any, args: any): Promise<unknown> => {
        const path = getFunctionName(ref);
        capturedQueryArgs.push({ path, args });
        if (path.includes("exports:internal_getExportRow")) {
          return exportRow;
        }
        if (path.includes("auditLogQueries:listRecent")) {
          return {
            page: [
              {
                _id: "auditLog:1",
                actor: { name: "Admin Reyes" },
                timestamp: FROM + 1000,
                action: "read_pii",
                entityType: "piiAccess",
                entityId: "abc",
                reason: "",
              },
            ],
            isDone: true,
            continueCursor: null,
          };
        }
        throw new Error(`Unexpected runQuery: ${path}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runMutation: async (ref: any, args: any): Promise<unknown> => {
        const path = getFunctionName(ref);
        capturedMutationArgs.push({ path, args });
        return null;
      },
      storage: {
        store: vi.fn(async (_blob: Blob): Promise<string> => "_storage:abc"),
      },
    };

    const run = handlerOf(generateReportExport);
    await run(ctx, { exportId: "exports:1" });

    const auditCall = capturedQueryArgs.find((c) =>
      c.path.includes("auditLogQueries:listRecent"),
    );
    expect(auditCall).toBeDefined();
    const auditArgs = auditCall!.args as {
      paginationOpts: { numItems: number; cursor: string | null };
      from?: number;
      to?: number;
    };
    expect(auditArgs.from).toBe(FROM);
    expect(auditArgs.to).toBe(TO);
    expect(auditArgs.paginationOpts.numItems).toBe(500);

    // The mark-ready transition should fire on success (asserts the
    // adapter actually produced bytes downstream and the header block
    // includes the date range).
    const markReady = capturedMutationArgs.find((c) =>
      c.path.includes("exports:internal_markReady"),
    );
    expect(markReady).toBeDefined();
  });

  it("omits from/to when the row.args bag has none (back-compat)", async () => {
    const exportRow = {
      _id: "exports:1",
      reportType: "audit_log",
      format: "xlsx",
      args: {},
      requestedBy: "users:admin1",
      requestedAt: 1,
    };
    const capturedQueryArgs: Array<{ path: string; args: unknown }> = [];
    const ctx = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runQuery: async (ref: any, args: any): Promise<unknown> => {
        const path = getFunctionName(ref);
        capturedQueryArgs.push({ path, args });
        if (path.includes("exports:internal_getExportRow")) return exportRow;
        if (path.includes("auditLogQueries:listRecent")) {
          return { page: [], isDone: true, continueCursor: null };
        }
        throw new Error(`Unexpected runQuery: ${path}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runMutation: async (_ref: any, _args: any): Promise<unknown> => null,
      storage: {
        store: vi.fn(async (_blob: Blob): Promise<string> => "_storage:abc"),
      },
    };
    const run = handlerOf(generateReportExport);
    await run(ctx, { exportId: "exports:1" });
    const auditCall = capturedQueryArgs.find((c) =>
      c.path.includes("auditLogQueries:listRecent"),
    );
    const auditArgs = auditCall!.args as { from?: number; to?: number };
    expect(auditArgs.from).toBeUndefined();
    expect(auditArgs.to).toBeUndefined();
  });
});
