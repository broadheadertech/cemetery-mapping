/**
 * Legacy lot CSV → import rows (client side).
 *
 * Turns the cemetery's spreadsheet into the row shape
 * `convex/lotImport.ts` accepts. This layer exists so the operator
 * sees a bad column header or a mistyped price BEFORE a round trip,
 * and so the preview table has something to render. It is a
 * convenience, not a gate: `convex/lib/lotImportValidation.ts`
 * re-validates every field server-side, because the browser is not a
 * trust boundary.
 *
 * The column vocabulary is forgiving on purpose. Fifteen years of
 * hand-kept records means the header row says `lot code`, `Lot_Code`,
 * or `code` depending on who made the file, and rejecting the file
 * over that just gets the operator to rename columns by hand — a step
 * that introduces its own errors. Aliases are matched after
 * lowercasing and collapsing separators.
 */

import { parseCsv, indexHeader, type CsvRow } from "@/lib/csv";
import { pesosToCents } from "@/lib/money";

/** Mirrors `LotImportRow` in `convex/lib/lotImportValidation.ts`. */
export interface ParsedLotImportRow {
  rowNumber: number;
  code: string;
  section: string;
  block: string;
  row: string;
  type: string;
  widthM: number;
  depthM: number;
  basePriceCents: number;
  status?: string;
}

export interface LotParseRowError {
  lineNumber: number;
  code: string;
  details: string;
}

export interface LotParseResult {
  rows: ParsedLotImportRow[];
  /** Rows the browser could not even shape. Never sent to the server. */
  errors: LotParseRowError[];
  /** Header names present in the file but not recognised. */
  ignoredColumns: string[];
}

/** Thrown for whole-file problems — a missing column, an empty file. */
export class LotCsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LotCsvParseError";
  }
}

/**
 * Accepted header spellings per logical column, most canonical first.
 * Compared after `normalizeHeaderName`, so `Lot Code`, `lot_code`, and
 * `LOT-CODE` all collapse to `lot code`.
 */
const COLUMN_ALIASES = {
  code: ["code", "lot code", "lotcode", "lot no", "lot number"],
  section: ["section", "section name"],
  block: ["block", "block no", "blk"],
  row: ["row", "row no"],
  type: ["type", "lot type", "category"],
  widthM: ["widthm", "width m", "width", "width meters", "width in m"],
  depthM: ["depthm", "depth m", "depth", "depth meters", "depth in m"],
  price: [
    "baseprice",
    "base price",
    "baseprice php",
    "base price php",
    "basepricephp",
    "price",
    "amount",
  ],
  status: ["status", "lot status", "state"],
} as const;

type ColumnKey = keyof typeof COLUMN_ALIASES;

/**
 * How each column is named back to the operator. The alias lists are
 * matching vocabulary, not display copy — telling someone their file
 * is missing "widthm" sends them looking for a column spelled exactly
 * that way.
 */
const COLUMN_DISPLAY_NAMES: Record<ColumnKey, string> = {
  code: "code",
  section: "section",
  block: "block",
  row: "row",
  type: "type",
  widthM: "width (m)",
  depthM: "depth (m)",
  price: "base price",
  status: "status",
};

/** Columns a file must carry. `status` is optional (defaults available). */
const REQUIRED_COLUMNS: ColumnKey[] = [
  "code",
  "section",
  "block",
  "row",
  "type",
  "widthM",
  "depthM",
  "price",
];

/**
 * Collapse a header cell to its comparable form. Every non-alphanumeric
 * run becomes a single space, so `Width (m)`, `width_m`, and `WIDTH-M`
 * all reduce to `width m`. Punctuation-only differences are exactly
 * what varies between the people who have maintained this file.
 */
function normalizeHeaderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Resolve each logical column to its index in the header row.
 * Throws `LotCsvParseError` naming every column that is missing —
 * one error listing all of them beats making the operator re-upload
 * once per missing column.
 */
function resolveColumns(header: string[]): {
  columns: Map<ColumnKey, number>;
  ignoredColumns: string[];
} {
  const normalized = header.map(normalizeHeaderName);
  const index = indexHeader(normalized);
  const columns = new Map<ColumnKey, number>();
  const claimed = new Set<number>();

  (Object.keys(COLUMN_ALIASES) as ColumnKey[]).forEach((key) => {
    for (const alias of COLUMN_ALIASES[key]) {
      const at = index.get(alias);
      if (at !== undefined && !claimed.has(at)) {
        columns.set(key, at);
        claimed.add(at);
        return;
      }
    }
  });

  const missing = REQUIRED_COLUMNS.filter((k) => !columns.has(k));
  if (missing.length > 0) {
    const names = missing.map((k) => COLUMN_DISPLAY_NAMES[k]).join(", ");
    const expected = REQUIRED_COLUMNS.map(
      (k) => COLUMN_DISPLAY_NAMES[k],
    ).join(", ");
    throw new LotCsvParseError(
      `The file is missing required column${missing.length > 1 ? "s" : ""}: ${names}. Expected a header row with: ${expected} (status optional).`,
    );
  }

  const ignoredColumns = header.filter(
    (name, i) => !claimed.has(i) && name.trim().length > 0,
  );
  return { columns, ignoredColumns };
}

function cellAt(row: CsvRow, at: number | undefined): string {
  if (at === undefined) return "";
  const value = row.cells[at];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse a metre measurement. Tolerates a trailing unit (`2.5m`,
 * `2.5 m`) because that is how measurements get typed into a
 * spreadsheet cell that is not formatted as a number.
 */
function parseMeters(raw: string): number {
  if (raw.length === 0) return Number.NaN;
  const cleaned = raw.replace(/\s*m(eters?)?\.?$/i, "").replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Parse the cemetery's lot CSV.
 *
 * Prices are read as PESOS and converted to centavos here — the
 * spreadsheet says `45000` meaning ₱45,000, and every downstream
 * money value in this system is an integer centavo count.
 */
export function parseLotCsv(text: string): LotParseResult {
  const { header, rows } = parseCsv(text);
  if (header.length === 0) {
    throw new LotCsvParseError("The file is empty.");
  }
  const { columns, ignoredColumns } = resolveColumns(header);
  if (rows.length === 0) {
    throw new LotCsvParseError(
      "The file has a header row but no data rows.",
    );
  }

  const parsed: ParsedLotImportRow[] = [];
  const errors: LotParseRowError[] = [];

  for (const csvRow of rows) {
    const code = cellAt(csvRow, columns.get("code"));
    const fail = (details: string): void => {
      errors.push({ lineNumber: csvRow.lineNumber, code, details });
    };

    const widthM = parseMeters(cellAt(csvRow, columns.get("widthM")));
    if (Number.isNaN(widthM)) {
      fail(
        `Could not read a width from "${cellAt(csvRow, columns.get("widthM"))}".`,
      );
      continue;
    }
    const depthM = parseMeters(cellAt(csvRow, columns.get("depthM")));
    if (Number.isNaN(depthM)) {
      fail(
        `Could not read a depth from "${cellAt(csvRow, columns.get("depthM"))}".`,
      );
      continue;
    }

    const rawPrice = cellAt(csvRow, columns.get("price"));
    const basePriceCents = pesosToCents(rawPrice);
    if (Number.isNaN(basePriceCents)) {
      fail(`Could not read a peso amount from "${rawPrice}".`);
      continue;
    }

    const parsedRow: ParsedLotImportRow = {
      rowNumber: csvRow.lineNumber,
      code,
      section: cellAt(csvRow, columns.get("section")),
      block: cellAt(csvRow, columns.get("block")),
      row: cellAt(csvRow, columns.get("row")),
      type: cellAt(csvRow, columns.get("type")),
      widthM,
      depthM,
      basePriceCents,
    };
    const status = cellAt(csvRow, columns.get("status"));
    if (status.length > 0) parsedRow.status = status;
    parsed.push(parsedRow);
  }

  return { rows: parsed, errors, ignoredColumns };
}

/**
 * Split a parsed batch into server-sized chunks. The mutation caps a
 * call at 500 rows; a 2,000-lot file is therefore four calls, which
 * the UI runs back to back so the operator uploads once.
 */
export function chunkRows<T>(rows: T[], size: number): T[][] {
  if (size <= 0) return [rows];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/** The template offered as a download on the import page. */
export const LOT_CSV_TEMPLATE = `code,section,block,row,type,widthM,depthM,basePricePhp,status
A-01-01,Section A,1,1,single,2.5,1.2,45000,available
A-01-02,Section A,1,2,family,3,2.4,95000,occupied
B-04-11,Section B,4,11,niche,0.6,0.6,18000,
`;
