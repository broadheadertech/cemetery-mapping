"use node";

/**
 * Report export rendering action — Story 6.4 (FR46).
 *
 * Node-runtime Convex action. Reads the `exports` row scheduled by
 * `convex/exports.ts → requestExport`, fetches the matching report
 * data via the appropriate public report query, renders the bytes
 * (CSV for `format: "xlsx"`, PDF for `format: "pdf"`), stores the
 * blob in Convex File Storage, and patches the row to
 * `status: "ready"` via the internal `_markReady` mutation.
 *
 * Why an action (`"use node"`):
 *   - PDFKit is Node-only (the V8 runtime can't load its bundled
 *     fonts + Buffer / stream module dependencies). Same constraint
 *     Story 3.13 / 6.1 / 6.2 documented for the receipt / contract /
 *     demand-letter PDF actions.
 *   - The render path is also long-tail latency-wise. Moving it out
 *     of the request thread keeps the public `requestExport`
 *     mutation snappy and the UI can subscribe reactively to the
 *     row's status.
 *
 * Phase 2 scope deviation from the original story spec (documented
 * in the Dev Agent Record):
 *   - `format: "xlsx"` is rendered as **CSV** bytes (zero new npm
 *     deps — no `exceljs`). The repo's own CLAUDE.md / brief say not
 *     to install deps that aren't explicitly required, and shipping
 *     CSV satisfies the AC1 contract: the file opens natively in
 *     Excel / Sheets / Numbers and contains the header block +
 *     column headers + data rows. A future story can layer real
 *     XLSX via `exceljs` without changing the public mutation
 *     surface (`format: "xlsx"` continues to point at a downloadable
 *     spreadsheet, just with richer formatting once the lib lands).
 *   - No streaming threshold. Phase 1 cemetery has ≤ 1,000 sales /
 *     year + ≤ 2,000 lots; in-memory render fits comfortably in the
 *     action's 60-second budget.
 *
 * Auth contract:
 *   - The action does not call `requireRole` itself — actions cannot
 *     read auth from `ctx.db` (no `db` on `ActionCtx`). The gating
 *     happens at the public `requestExport` mutation that schedules
 *     this action (the mutation calls `requireRole(["admin"])` first)
 *     AND at each report query the action calls back into (every
 *     `reports.*` / `arAging.*` / `auditLogQueries.*` admin surface
 *     calls `requireRole(["admin"])` as its first awaited statement).
 *   - This double-gate means even a hand-crafted scheduler invocation
 *     can't bypass authorization — the report query rejects an
 *     unauthenticated caller, the action surfaces the error to
 *     `_markFailed`, and the export row is left in the failed state
 *     with a translated error message.
 */

import type { GenericActionCtx } from "convex/server";
import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import PDFDocument from "pdfkit";

import schema from "../schema";
import type { DataModelFromSchemaDefinition } from "convex/server";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type ExportId = DataModel["exports"]["document"]["_id"];

// ---------------------------------------------------------------------------
// Internal function references. `convex/_generated/api.ts` doesn't
// exist pre-codegen in this repo (see the pattern used by other
// Node actions + crons.ts); we resolve via `makeFunctionReference`
// instead.
// ---------------------------------------------------------------------------

interface ExportRowSnapshot {
  _id: string;
  reportType: "sales_by_dimension" | "ar_aging" | "audit_log";
  format: "xlsx" | "pdf";
  args: unknown;
  requestedBy: string;
  requestedAt: number;
}

const internal_getExportRowRef = makeFunctionReference<
  "query",
  { exportId: string },
  ExportRowSnapshot | null
>("exports:internal_getExportRow");

const internal_markReadyRef = makeFunctionReference<
  "mutation",
  { exportId: string; blobId: string },
  null
>("exports:internal_markReady");

const internal_markFailedRef = makeFunctionReference<
  "mutation",
  { exportId: string; error: string },
  null
>("exports:internal_markFailed");

const salesByDimensionRef = makeFunctionReference<
  "query",
  { from: number; to: number },
  unknown
>("reports:salesByDimension");

const getAgingSummaryRef = makeFunctionReference<
  "query",
  Record<string, never>,
  unknown
>("arAging:getAgingSummary");

const auditLogListRecentRef = makeFunctionReference<
  "query",
  {
    paginationOpts: { numItems: number; cursor: string | null };
    from?: number;
    to?: number;
  },
  unknown
>("auditLogQueries:listRecent");

// ---------------------------------------------------------------------------
// Report row shape — the renderer-agnostic intermediate form. Every
// adapter projects its report into `{ title, headerBlock, columns,
// rows }`; the CSV + PDF renderers consume only this shape.
// ---------------------------------------------------------------------------

interface ReportTabular {
  title: string;
  headerBlock: Array<[string, string]>; // [label, value]
  columns: string[]; // column headers
  rows: Array<Array<string | number>>; // one inner array per row
}

// ---------------------------------------------------------------------------
// Public action: the only entry point. Scheduled by
// `convex/exports.ts → requestExport`.
// ---------------------------------------------------------------------------

export const generateReportExport = actionGeneric({
  args: { exportId: v.id("exports") },
  handler: async (
    ctx: ActionCtx,
    args: { exportId: ExportId },
  ): Promise<null> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Scheduled-only: `exports:requestExport` role-gates the caller before scheduling this action; actions cannot read user auth from ctx.db.
    const idStr = args.exportId as unknown as string;
    let row: ExportRowSnapshot | null = null;
    try {
      row = (await ctx.runQuery(internal_getExportRowRef, {
        exportId: idStr,
      })) as ExportRowSnapshot | null;
      if (row === null) {
        console.warn("[exports] action: missing row", idStr);
        return null;
      }

      const data = await fetchReport(ctx, row);
      const buffer =
        row.format === "pdf"
          ? await renderPdfTable(data)
          : renderCsv(data);

      const mime =
        row.format === "pdf" ? "application/pdf" : "text/csv";
      const blob = new Blob([new Uint8Array(buffer)], { type: mime });
      const storageId = await ctx.storage.store(blob);

      await ctx.runMutation(internal_markReadyRef, {
        exportId: idStr,
        blobId: storageId as unknown as string,
      });
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[exports] action failed", idStr, message);
      try {
        await ctx.runMutation(internal_markFailedRef, {
          exportId: idStr,
          error: message.slice(0, 500),
        });
      } catch (innerErr) {
        console.error(
          "[exports] action: failed to mark failed",
          idStr,
          (innerErr as Error).message,
        );
      }
      return null;
    }
  },
});

// ---------------------------------------------------------------------------
// Per-report adapter — turns report-query output into the renderer-
// agnostic `ReportTabular` shape.
// ---------------------------------------------------------------------------

async function fetchReport(
  ctx: ActionCtx,
  row: ExportRowSnapshot,
): Promise<ReportTabular> {
  switch (row.reportType) {
    case "sales_by_dimension":
      return await fetchSalesByDimension(ctx, row);
    case "ar_aging":
      return await fetchArAging(ctx);
    case "audit_log":
      return await fetchAuditLog(ctx, row);
    default: {
      const never: never = row.reportType;
      throw new Error(`Unknown report type: ${never as string}`);
    }
  }
}

interface SalesByDimensionAgentRow {
  agentId: string;
  agentName: string;
  count: number;
  totalAmountCents: number;
}
interface SalesByDimensionSectionRow {
  section: string;
  count: number;
  totalAmountCents: number;
  agents?: SalesByDimensionAgentRow[];
}
interface SalesByDimensionLotTypeRow {
  lotType: string;
  count: number;
  totalAmountCents: number;
  sections: SalesByDimensionSectionRow[];
}
interface SalesByDimensionReport {
  from: number;
  to: number;
  generatedAt: number;
  salesAgentTrackingEnabled: boolean;
  totalCount: number;
  totalAmountCents: number;
  lotTypes: SalesByDimensionLotTypeRow[];
}

async function fetchSalesByDimension(
  ctx: ActionCtx,
  row: ExportRowSnapshot,
): Promise<ReportTabular> {
  const args = row.args as { from?: number; to?: number };
  if (
    args === null ||
    typeof args !== "object" ||
    typeof args.from !== "number" ||
    typeof args.to !== "number"
  ) {
    throw new Error("sales_by_dimension: from/to args missing");
  }
  const result = (await ctx.runQuery(salesByDimensionRef, {
    from: args.from,
    to: args.to,
  })) as SalesByDimensionReport;

  const headerBlock: Array<[string, string]> = [
    ["From", formatDateManila(result.from)],
    ["To", formatDateManila(result.to)],
    ["Generated", formatDateTimeManila(result.generatedAt)],
    ["Total sales", String(result.totalCount)],
    ["Total amount (PHP)", formatPesoPlain(result.totalAmountCents)],
  ];

  const showAgents = result.salesAgentTrackingEnabled;
  const columns = showAgents
    ? ["Lot type", "Section", "Agent", "Sales", "Total (PHP)"]
    : ["Lot type", "Section", "Sales", "Total (PHP)"];

  const rows: Array<Array<string | number>> = [];
  for (const lt of result.lotTypes) {
    for (const section of lt.sections) {
      if (showAgents) {
        if (section.agents !== undefined && section.agents.length > 0) {
          for (const agent of section.agents) {
            rows.push([
              lt.lotType,
              section.section,
              agent.agentName,
              agent.count,
              formatPesoPlain(agent.totalAmountCents),
            ]);
          }
        } else {
          // Section with no agent attribution — emit a placeholder
          // so the row totals still surface.
          rows.push([
            lt.lotType,
            section.section,
            "(unassigned)",
            section.count,
            formatPesoPlain(section.totalAmountCents),
          ]);
        }
      } else {
        rows.push([
          lt.lotType,
          section.section,
          section.count,
          formatPesoPlain(section.totalAmountCents),
        ]);
      }
    }
  }

  return {
    title: "Sales by dimension",
    headerBlock,
    columns,
    rows,
  };
}

interface ArAgingBucketRow {
  key: string;
  count: number;
  totalCents: number;
  withLoggedActionCount: number;
}
interface ArAgingSummary {
  buckets: ArAgingBucketRow[];
  currentCents: number;
  currentCount: number;
  totalOverdueCents: number;
}

async function fetchArAging(ctx: ActionCtx): Promise<ReportTabular> {
  const result = (await ctx.runQuery(getAgingSummaryRef, {})) as ArAgingSummary;
  const headerBlock: Array<[string, string]> = [
    ["Generated", formatDateTimeManila(Date.now())],
    ["Total overdue (PHP)", formatPesoPlain(result.totalOverdueCents)],
    ["Current count", String(result.currentCount)],
    ["Current total (PHP)", formatPesoPlain(result.currentCents)],
  ];
  const columns = ["Bucket", "Count", "Total (PHP)", "With logged action"];
  const rows: Array<Array<string | number>> = result.buckets.map((b) => [
    b.key,
    b.count,
    formatPesoPlain(b.totalCents),
    b.withLoggedActionCount,
  ]);
  return {
    title: "AR aging summary",
    headerBlock,
    columns,
    rows,
  };
}

interface AuditLogRow {
  _id: string;
  // `auditLogQueries.listRecent` returns `actor` as the raw user-id and
  // the resolved display name in a SEPARATE `actorName` field. The export
  // previously typed `actor` as `{ name }` and read `r.actor?.name`,
  // which is always undefined on a string id → every row exported
  // "(unknown)" (Epic 6 H1). Type + read the correct field.
  actor: string | null;
  actorName?: string | null;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | null;
}
interface AuditLogPage {
  page: AuditLogRow[];
  isDone: boolean;
  continueCursor: string | null;
}

async function fetchAuditLog(
  ctx: ActionCtx,
  row: ExportRowSnapshot,
): Promise<ReportTabular> {
  // Pull up to 500 rows in the caller-supplied date range. The export
  // is a snapshot view — deeper history (or post-export rows) needs the
  // live audit log page. When `from` / `to` are omitted the scan falls
  // through to the global most-recent-500 path, matching the original
  // "all activity" behaviour.
  const args =
    row.args === null || typeof row.args !== "object"
      ? {}
      : (row.args as { from?: unknown; to?: unknown });
  const from =
    typeof args.from === "number" && Number.isFinite(args.from)
      ? args.from
      : undefined;
  const to =
    typeof args.to === "number" && Number.isFinite(args.to)
      ? args.to
      : undefined;
  const queryArgs: {
    paginationOpts: { numItems: number; cursor: string | null };
    from?: number;
    to?: number;
  } = {
    paginationOpts: { numItems: 500, cursor: null },
  };
  if (from !== undefined) queryArgs.from = from;
  if (to !== undefined) queryArgs.to = to;
  const result = (await ctx.runQuery(
    auditLogListRecentRef,
    queryArgs,
  )) as AuditLogPage;
  const headerBlock: Array<[string, string]> = [
    ["Generated", formatDateTimeManila(Date.now())],
    ["From", from !== undefined ? formatDateManila(from) : "all"],
    ["To", to !== undefined ? formatDateManila(to) : "all"],
    ["Row count", String(result.page.length)],
  ];
  const columns = [
    "Timestamp",
    "Actor",
    "Action",
    "Entity type",
    "Entity id",
    "Reason",
  ];
  const rows: Array<Array<string | number>> = result.page.map((r) => [
    formatDateTimeManila(r.timestamp),
    r.actorName ?? "(unknown)",
    r.action,
    r.entityType,
    r.entityId,
    r.reason ?? "",
  ]);
  return {
    title: "Audit log",
    headerBlock,
    columns,
    rows,
  };
}

// ---------------------------------------------------------------------------
// CSV renderer. Pure; exported for unit tests.
// ---------------------------------------------------------------------------

export function renderCsv(data: ReportTabular): Buffer {
  const lines: string[] = [];
  lines.push(csvRow([data.title]));
  for (const [label, value] of data.headerBlock) {
    lines.push(csvRow([label, value]));
  }
  lines.push("");
  lines.push(csvRow(data.columns));
  for (const row of data.rows) {
    lines.push(csvRow(row.map((c) => String(c))));
  }
  // BOM so Excel on Windows opens it as UTF-8 by default.
  const body = `﻿${lines.join("\r\n")}\r\n`;
  return Buffer.from(body, "utf-8");
}

function csvRow(cells: string[]): string {
  return cells.map(csvEscape).join(",");
}

/**
 * CSV cell escape with formula-injection prophylactic.
 *
 * Threat: spreadsheet apps (Excel, Sheets, Numbers, LibreOffice Calc)
 * interpret a cell whose first character is one of `=` `+` `-` `@` `\t`
 * `\r` as a formula expression. A cell value sourced from
 * user-controlled content (customer name, expense description, audit
 * reason) like `=cmd|/c calc!A1` will execute on open. The OWASP CSV
 * Injection guidance prescribes prefixing such cells with a single
 * quote (`'`) so the spreadsheet treats the cell as a literal string.
 *
 * After prefixing, we then apply the quote-wrap rule for cells
 * containing `,` `"` `\r` `\n` — wrapping doesn't defeat the leading
 * single quote since the apostrophe lives INSIDE the quoted field, and
 * is what Excel actually displays.
 */
function csvEscape(value: string): string {
  // Formula-injection prophylactic. Includes literal tab (0x09) and CR
  // (0x0D) because Excel will surface those as the start of a formula
  // too. The single-quote prefix is the OWASP-recommended mitigation.
  let v = value;
  if (v.length > 0 && /^[=+\-@\t\r]/.test(v)) {
    v = `'${v}`;
  }
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// ---------------------------------------------------------------------------
// PDF renderer. Pure-ish (depends on PDFKit); exported for unit tests.
// ---------------------------------------------------------------------------

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;

export async function renderPdfTable(data: ReportTabular): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margin: PAGE_MARGIN,
        // Buffer pages so we can post-process and stamp
        // "Page X of Y" + the per-page context strip after the table
        // body has been laid out. This is PDFKit's documented pattern
        // for footers that depend on the total page count.
        bufferPages: true,
        info: {
          Title: data.title,
          Subject: "Broadheader Cemetery report export",
          Creator: "Broadheader Cemetery Management System",
        },
      });

      const chunks: Uint8Array[] = [];
      doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );

      // Build a one-line context strip from the header block. We pluck
      // From / To / Generated when present — they're the load-bearing
      // fields admins skim when paging through a printed report. Other
      // header fields stay on page 1 only.
      const contextStrip = buildContextStrip(data.headerBlock);

      // Title — page 1 only.
      doc.font("Helvetica-Bold").fontSize(18);
      doc.text(data.title, PAGE_MARGIN, PAGE_MARGIN);

      // Header block — label/value pairs in a small grid. Page 1 only.
      doc.font("Helvetica").fontSize(10).fillColor("#333333");
      doc.moveDown(0.5);
      for (const [label, value] of data.headerBlock) {
        doc.font("Helvetica-Bold");
        doc.text(`${label}:`, { continued: true });
        doc.font("Helvetica");
        doc.text(` ${value}`);
      }
      doc.moveDown(0.5);
      doc.fillColor("#000000");

      // Column widths — equal slice of the printable area.
      const printableWidth = PAGE_WIDTH - 2 * PAGE_MARGIN;
      const colCount = data.columns.length;
      const colWidth = printableWidth / colCount;

      const drawColumnHeaderRow = (yStart: number): number => {
        let y = yStart;
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#000000");
        for (let i = 0; i < colCount; i += 1) {
          doc.text(data.columns[i] ?? "", PAGE_MARGIN + i * colWidth, y, {
            width: colWidth - 4,
            ellipsis: true,
          });
        }
        y += 14;
        doc
          .moveTo(PAGE_MARGIN, y)
          .lineTo(PAGE_WIDTH - PAGE_MARGIN, y)
          .strokeColor("#cccccc")
          .stroke();
        y += 4;
        return y;
      };

      const drawContextStrip = (yStart: number): number => {
        if (contextStrip === "") return yStart;
        doc.font("Helvetica").fontSize(8).fillColor("#666666");
        doc.text(contextStrip, PAGE_MARGIN, yStart, {
          width: printableWidth,
          align: "left",
        });
        doc.fillColor("#000000");
        return yStart + 12;
      };

      const rowHeight = 14;
      const bottomLimit = PAGE_HEIGHT - PAGE_MARGIN - 30;

      let y = drawColumnHeaderRow(doc.y);
      doc.font("Helvetica").fontSize(9);

      for (const row of data.rows) {
        if (y + rowHeight > bottomLimit) {
          // Page break — emit a fresh page that opens with a compact
          // context strip then a repeated column-header row, so the
          // reader doesn't have to flip back to page 1 to remember
          // which range or field each column maps to.
          doc.addPage();
          let cy = PAGE_MARGIN;
          cy = drawContextStrip(cy);
          y = drawColumnHeaderRow(cy);
          doc.font("Helvetica").fontSize(9);
        }
        for (let i = 0; i < colCount; i += 1) {
          const cell = row[i] ?? "";
          doc.text(String(cell), PAGE_MARGIN + i * colWidth, y, {
            width: colWidth - 4,
            ellipsis: true,
          });
        }
        y += rowHeight;
      }

      // Page-numbered footer pass. `bufferedPageRange()` reports the
      // contiguous span of buffered pages; we iterate that span and
      // stamp the centered "Page X of Y · Generated by …" footer on
      // each so the admin can correlate a printed page back to a
      // total span.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        drawFooter(doc, i + 1, range.count);
      }

      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

type PdfDoc = InstanceType<typeof PDFDocument>;

/**
 * Compact one-line context strip used as the page header for pages 2+.
 * Picks out the load-bearing fields (From, To, Generated, As of, Total
 * sales) from the per-report header block so the reader doesn't have
 * to flip back to page 1 to remember the scan range.
 */
function buildContextStrip(headerBlock: Array<[string, string]>): string {
  const want = new Set([
    "From",
    "To",
    "Generated",
    "As of",
  ]);
  const parts: string[] = [];
  for (const [label, value] of headerBlock) {
    if (want.has(label)) parts.push(`${label}: ${value}`);
  }
  return parts.join("  ·  ");
}

function drawFooter(doc: PdfDoc, pageNum: number, totalPages: number): void {
  // Stamp the page-number footer in the bottom margin. The total page
  // count is filled in by the bufferedPageRange post-processing loop
  // in `renderPdfTable`, so this works for both single-page and
  // multi-page exports without book-keeping per-row.
  const y = PAGE_HEIGHT - PAGE_MARGIN + 5;
  doc.font("Helvetica").fontSize(8).fillColor("#999999");
  doc.text(
    `Page ${pageNum} of ${totalPages}  ·  Generated by Broadheader Cemetery Management System`,
    PAGE_MARGIN,
    y,
    { width: PAGE_WIDTH - 2 * PAGE_MARGIN, align: "center" },
  );
  doc.fillColor("#000000");
}

// ---------------------------------------------------------------------------
// Manila tz date formatters. Mirror `src/lib/time.ts` for symmetry — the
// action is Node-runtime so we use the platform `Intl` directly.
// ---------------------------------------------------------------------------

const DATE_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "numeric",
});
const DATETIME_FMT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDateManila(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return DATE_FMT.format(new Date(ms));
}

function formatDateTimeManila(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return DATETIME_FMT.format(new Date(ms));
}

function formatPesoPlain(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  // Plain decimal — no peso sign so CSV cells stay numeric-friendly.
  const pesos = cents / 100;
  return pesos.toFixed(2);
}
