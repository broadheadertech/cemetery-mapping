import { describe, it, expect } from "vitest";

import {
  chunkRows,
  LotCsvParseError,
  LOT_CSV_TEMPLATE,
  parseLotCsv,
} from "@/lib/lotImportParse";

const HEADER = "code,section,block,row,type,widthM,depthM,basePricePhp";

describe("parseLotCsv — column resolution", () => {
  it("parses the template the import page hands out", () => {
    const result = parseLotCsv(LOT_CSV_TEMPLATE);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.code).toBe("A-01-01");
    expect(result.rows[0]!.status).toBe("available");
    // Third template row leaves status blank — it must stay absent so
    // the server applies its own default rather than seeing "".
    expect(result.rows[2]!.status).toBeUndefined();
  });

  it("accepts alternative header spellings", () => {
    const csv = [
      "Lot_Code,Section Name,Blk,Row No,Lot Type,Width (m),Depth (m),Base Price",
      "A-01,North,1,1,single,2.5,1.2,45000",
    ].join("\n");
    const result = parseLotCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      code: "A-01",
      section: "North",
      block: "1",
      row: "1",
      type: "single",
    });
  });

  it("names every missing required column in one error", () => {
    const csv = "code,section\nA-01,North\n";
    expect(() => parseLotCsv(csv)).toThrow(LotCsvParseError);
    try {
      parseLotCsv(csv);
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("block");
      expect(message).toContain("row");
      expect(message).toContain("type");
      expect(message).toContain("base price");
    }
  });

  it("reports unrecognised columns instead of failing on them", () => {
    const csv = [
      `${HEADER},owner name,remarks`,
      "A-01,North,1,1,single,2.5,1.2,45000,Juan,paid 1998",
    ].join("\n");
    const result = parseLotCsv(csv);
    expect(result.ignoredColumns).toEqual(["owner name", "remarks"]);
    expect(result.rows).toHaveLength(1);
  });

  it("rejects an empty file and a header-only file distinctly", () => {
    expect(() => parseLotCsv("")).toThrow(/empty/i);
    expect(() => parseLotCsv(`${HEADER}\n`)).toThrow(/no data rows/i);
  });
});

describe("parseLotCsv — cell parsing", () => {
  it("converts the peso price column to integer centavos", () => {
    const result = parseLotCsv(
      `${HEADER}\nA-01,North,1,1,single,2.5,1.2,45000\n`,
    );
    expect(result.rows[0]!.basePriceCents).toBe(4_500_000);
  });

  it("tolerates peso signs, thousands separators, and decimals", () => {
    const result = parseLotCsv(
      `${HEADER}\nA-01,North,1,1,single,2.5,1.2,"₱1,250.50"\n`,
    );
    expect(result.rows[0]!.basePriceCents).toBe(125_050);
  });

  it("does not drift on prices that are awkward in binary floating point", () => {
    const result = parseLotCsv(
      `${HEADER}\nA-01,North,1,1,single,2.5,1.2,45000.10\n`,
    );
    expect(result.rows[0]!.basePriceCents).toBe(4_500_010);
    expect(Number.isInteger(result.rows[0]!.basePriceCents)).toBe(true);
  });

  it("tolerates a trailing unit on measurements", () => {
    const result = parseLotCsv(
      `${HEADER}\nA-01,North,1,1,single,2.5m,1.2 meters,45000\n`,
    );
    expect(result.rows[0]!.widthM).toBe(2.5);
    expect(result.rows[0]!.depthM).toBe(1.2);
  });

  it("reports an unreadable price against its source line and keeps going", () => {
    const csv = [
      HEADER,
      "A-01,North,1,1,single,2.5,1.2,45000",
      "A-02,North,1,2,single,2.5,1.2,TBD",
      "A-03,North,1,3,single,2.5,1.2,50000",
    ].join("\n");
    const result = parseLotCsv(csv);
    expect(result.rows.map((r) => r.code)).toEqual(["A-01", "A-03"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.lineNumber).toBe(3);
    expect(result.errors[0]!.code).toBe("A-02");
  });

  it("reports an unreadable measurement rather than importing NaN", () => {
    const result = parseLotCsv(
      `${HEADER}\nA-01,North,1,1,single,unknown,1.2,45000\n`,
    );
    expect(result.rows).toHaveLength(0);
    expect(result.errors[0]!.details).toMatch(/width/i);
  });

  it("carries the source line number through for every row", () => {
    const csv = [
      HEADER,
      "A-01,North,1,1,single,2.5,1.2,45000",
      "A-02,North,1,2,single,2.5,1.2,45000",
    ].join("\n");
    const result = parseLotCsv(csv);
    expect(result.rows.map((r) => r.rowNumber)).toEqual([2, 3]);
  });

  it("keeps a section name containing a comma intact", () => {
    const result = parseLotCsv(
      `${HEADER}\nA-01,"Section A, North",1,1,single,2.5,1.2,45000\n`,
    );
    expect(result.rows[0]!.section).toBe("Section A, North");
  });

  it("leaves type and status verbatim for the server to validate", () => {
    // The client does not gatekeep the vocabulary — the server owns it,
    // so a bad value must survive the trip and come back as a server
    // error naming the row, not vanish silently in the browser.
    const result = parseLotCsv(
      `${HEADER},status\nA-01,North,1,1,single,2.5,1.2,45000,sold\n`,
    );
    expect(result.rows[0]!.status).toBe("sold");
  });
});

describe("chunkRows", () => {
  it("splits a batch into server-sized calls", () => {
    const rows = Array.from({ length: 1200 }, (_, i) => i);
    const chunks = chunkRows(rows, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);
  });

  it("returns one chunk when the batch fits", () => {
    expect(chunkRows([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it("returns no chunks for an empty batch", () => {
    expect(chunkRows([], 500)).toEqual([]);
  });
});
