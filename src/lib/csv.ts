/**
 * Minimal RFC 4180 CSV reader.
 *
 * Written rather than pulled from npm for the same reason
 * `convex/exports.ts` writes CSV by hand: the surface we need is small
 * and well-specified, and `papaparse` is ~45KB for a parser we can
 * express in eighty lines. The GPS importer set the precedent — "only
 * add papaparse if necessary" (`convex/gpsImport.ts` header).
 *
 * What it handles, because real cemetery spreadsheets contain all of
 * it after fifteen years of hand editing:
 *
 *   - Quoted fields containing commas: `"Section A, North"`
 *   - Escaped quotes inside quoted fields: `"He said ""yes"""`
 *   - Quoted fields containing newlines (a wrapped address cell)
 *   - CRLF, LF, and bare-CR line endings, mixed within one file
 *   - A UTF-8 BOM, which Excel writes by default on Windows and which
 *     otherwise corrupts the first header name into `﻿code`
 *   - Trailing blank lines
 *
 * What it deliberately does NOT do: type inference, header mapping, or
 * delimiter sniffing. Those are the caller's business — see
 * `src/lib/lotImportParse.ts` for the lot-specific layer.
 */

export interface CsvRow {
  /**
   * 1-based line number in the source text, counting the header. A
   * quoted field containing newlines advances this by the number of
   * physical lines it spans, so the number always points at where the
   * record STARTS in the operator's spreadsheet.
   */
  lineNumber: number;
  cells: string[];
}

export interface CsvParseResult {
  /** Header cells, trimmed and lowercased for stable lookup. */
  header: string[];
  /** Data rows (header excluded). Fully blank lines are dropped. */
  rows: CsvRow[];
}

/** Split CSV text into records of raw cells. Handles quotes + newlines. */
function tokenize(text: string): CsvRow[] {
  const records: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const endField = (): void => {
    cells.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    // Drop records that are entirely empty — a trailing newline at the
    // end of the file would otherwise produce a phantom blank row.
    const isBlank = cells.every((c) => c.trim().length === 0);
    if (!isBlank) {
      records.push({ lineNumber: recordStartLine, cells });
    }
    cells = [];
    recordStartLine = line;
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped pair
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === ",") {
      endField();
      sawAnyChar = true;
      continue;
    }
    if (ch === "\r") {
      // Normalise CRLF and bare CR alike; the LF (if any) is consumed.
      if (text[i + 1] === "\n") i += 1;
      line += 1;
      endRecord();
      recordStartLine = line;
      continue;
    }
    if (ch === "\n") {
      line += 1;
      endRecord();
      recordStartLine = line;
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }

  // Flush whatever the last line left in the buffer.
  if (sawAnyChar || field.length > 0 || cells.length > 0) {
    endRecord();
  }
  return records;
}

/**
 * Parse CSV text into a header plus data rows.
 *
 * Returns an empty header and no rows for empty input — callers treat
 * that as "nothing to import" rather than an error, since it is what a
 * freshly-created file looks like.
 */
export function parseCsv(text: string): CsvParseResult {
  // Excel on Windows prefixes a BOM; left in place it becomes part of
  // the first header name and every column lookup misses.
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = tokenize(withoutBom);
  if (records.length === 0) {
    return { header: [], rows: [] };
  }
  const headerRecord = records[0];
  if (headerRecord === undefined) {
    return { header: [], rows: [] };
  }
  return {
    header: headerRecord.cells.map((c) => c.trim().toLowerCase()),
    rows: records.slice(1),
  };
}

/**
 * Build a `columnName → index` lookup from a parsed header.
 *
 * Later duplicates of a name lose to the first, which matches how a
 * human reads a spreadsheet with an accidentally repeated column.
 */
export function indexHeader(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (name.length > 0 && !index.has(name)) index.set(name, i);
  });
  return index;
}
