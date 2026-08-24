import { describe, it, expect } from "vitest";

import { parseCsv, indexHeader } from "@/lib/csv";

/**
 * These cases are drawn from what actually turns up in a spreadsheet
 * maintained by hand over many years — quoted commas, a wrapped cell,
 * an Excel BOM, mixed line endings — not from the happy path.
 */
describe("parseCsv", () => {
  it("parses a simple file and lowercases the header", () => {
    const result = parseCsv("Code,Section\nA-01,North\nA-02,South\n");
    expect(result.header).toEqual(["code", "section"]);
    expect(result.rows.map((r) => r.cells)).toEqual([
      ["A-01", "North"],
      ["A-02", "South"],
    ]);
  });

  it("numbers rows by their line in the source file, header included", () => {
    const result = parseCsv("code\nA-01\nA-02\n");
    expect(result.rows.map((r) => r.lineNumber)).toEqual([2, 3]);
  });

  it("keeps commas inside quoted fields", () => {
    const result = parseCsv('code,section\nA-01,"Section A, North"\n');
    expect(result.rows[0]!.cells).toEqual(["A-01", "Section A, North"]);
  });

  it("unescapes doubled quotes inside a quoted field", () => {
    const result = parseCsv('code,note\nA-01,"He said ""yes"""\n');
    expect(result.rows[0]!.cells[1]).toBe('He said "yes"');
  });

  it("keeps newlines inside a quoted field and still advances the line count", () => {
    const result = parseCsv('code,note\nA-01,"line one\nline two"\nA-02,plain\n');
    expect(result.rows[0]!.cells[1]).toBe("line one\nline two");
    // The wrapped cell spans lines 2-3, so the next record starts at 4.
    expect(result.rows[1]!.lineNumber).toBe(4);
  });

  it("strips the UTF-8 BOM Excel writes on Windows", () => {
    const result = parseCsv("﻿code,section\nA-01,North\n");
    // Without the strip this would be "﻿code" and every lookup misses.
    expect(result.header[0]).toBe("code");
  });

  it("handles CRLF and bare CR line endings, mixed", () => {
    const result = parseCsv("code\r\nA-01\rA-02\r\nA-03\n");
    expect(result.rows.map((r) => r.cells[0])).toEqual([
      "A-01",
      "A-02",
      "A-03",
    ]);
  });

  it("drops trailing blank lines rather than emitting phantom rows", () => {
    const result = parseCsv("code,section\nA-01,North\n\n\n");
    expect(result.rows).toHaveLength(1);
  });

  it("drops a line of nothing but separators", () => {
    const result = parseCsv("code,section\nA-01,North\n,,\n");
    expect(result.rows).toHaveLength(1);
  });

  it("parses a final row with no trailing newline", () => {
    const result = parseCsv("code,section\nA-01,North");
    expect(result.rows[0]!.cells).toEqual(["A-01", "North"]);
  });

  it("returns an empty result for empty input", () => {
    expect(parseCsv("")).toEqual({ header: [], rows: [] });
  });

  it("preserves empty cells so column positions stay aligned", () => {
    const result = parseCsv("a,b,c\n1,,3\n");
    expect(result.rows[0]!.cells).toEqual(["1", "", "3"]);
  });
});

describe("indexHeader", () => {
  it("maps names to their column index", () => {
    const index = indexHeader(["code", "section", "block"]);
    expect(index.get("section")).toBe(1);
  });

  it("lets the first of a duplicated column name win", () => {
    const index = indexHeader(["code", "code"]);
    expect(index.get("code")).toBe(0);
  });

  it("skips blank header cells", () => {
    const index = indexHeader(["code", "", "block"]);
    expect(index.has("")).toBe(false);
    expect(index.get("block")).toBe(2);
  });
});
