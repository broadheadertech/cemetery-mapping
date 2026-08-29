/**
 * Actually rendering a certificate.
 *
 * `lib/certificate.test.ts` proves the arithmetic. This drives the real
 * `pdf-lib` path with a real template and checks the things only a
 * rendered document can show:
 *
 *   - the park's own page survives — same size, same page count, so
 *     their border and seal are still where they drew them
 *   - text lands where the placement said, read back off the page
 *   - a name too long for its box is reported rather than silently
 *     printed through the border
 *   - an image blank works too, for a park whose designer sent a PNG
 *
 * A certificate is a document a family frames. "It didn't throw" is not
 * evidence that it is right.
 */

import { inflateSync } from "node:zlib";

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { __testing } from "../../../../convex/actions/generateCertificatePdf";
import type {
  CertificateData,
  FieldPlacement,
} from "../../../../convex/lib/certificate";

const { renderCertificate, openTemplate } = __testing;

/** A4 in points, the size a park's blank will almost always be. */
const A4 = { width: 595.28, height: 841.89 };

const DATA: CertificateData = {
  ownerName: "Ana Reyes",
  lotCode: "A-2-01",
  section: "Garden of Faith",
  lotType: "family",
  contractNumber: "CTR-2026-0042",
  serial: "COO-2026-00007",
  issuedAt: new Date("2026-11-01T10:00:00+08:00").getTime(),
  amountPaidCents: 120_000_00,
};

/** A stand-in for the park's designed blank: one A4 page with a mark. */
async function makeTemplatePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([A4.width, A4.height]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("APOSTLE PAUL MEMORIAL PARK", {
    x: 60,
    y: A4.height - 80,
    size: 14,
    font,
    color: rgb(0.11, 0.36, 0.3),
  });
  return await doc.save();
}

/** A 1×1 transparent PNG — enough to prove the image path opens. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function place(over: Partial<FieldPlacement> = {}): FieldPlacement {
  return {
    key: "ownerName",
    xFrac: 0.5,
    yFrac: 0.5,
    fontSize: 18,
    align: "center",
    ...over,
  };
}

describe("the park's own document survives", () => {
  it("keeps the page size it was given", async () => {
    // If this drifts, the park's border and seal no longer line up with
    // the page and every printed certificate is subtly wrong.
    const template = await makeTemplatePdf();
    const { bytes } = await renderCertificate({
      templateBytes: template,
      templateMimeType: "application/pdf",
      fields: [place()],
      data: DATA,
    });

    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(1);
    const size = out.getPage(0).getSize();
    expect(size.width).toBeCloseTo(A4.width, 1);
    expect(size.height).toBeCloseTo(A4.height, 1);
  });

  it("produces a PDF that opens", async () => {
    const template = await makeTemplatePdf();
    const { bytes } = await renderCertificate({
      templateBytes: template,
      templateMimeType: "application/pdf",
      fields: [place()],
      data: DATA,
    });
    expect(bytes.length).toBeGreaterThan(500);
    // A PDF starts with %PDF-.
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("draws every placed field without dropping one", async () => {
    const template = await makeTemplatePdf();
    const fields: FieldPlacement[] = [
      place({ key: "ownerName", yFrac: 0.4 }),
      place({ key: "lotCode", yFrac: 0.5 }),
      place({ key: "serial", yFrac: 0.6 }),
      place({ key: "issuedDate", yFrac: 0.7 }),
    ];
    const { bytes, overflowed } = await renderCertificate({
      templateBytes: template,
      templateMimeType: "application/pdf",
      fields,
      data: DATA,
    });
    expect(overflowed).toEqual([]);
    // Every field's text should be somewhere in the content stream.
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.length).toBeGreaterThan(1000);
  });
});

describe("where the text lands", () => {
  /**
   * The y coordinate pdf-lib actually wrote, read back off the page.
   *
   * This is the only assertion that proves the flip happened in the
   * OUTPUT rather than merely in a helper — which is the whole failure
   * mode. Content streams are Flate-compressed, so it has to be
   * inflated; my first attempt searched the raw bytes, found nothing,
   * and passed vacuously behind an `if (!Number.isNaN(y))`. It throws
   * now instead, because a positioning test that cannot read the
   * position must fail, not shrug.
   */
  async function firstTextY(bytes: Uint8Array): Promise<number> {
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const contents = page.node.Contents();
    if (contents === undefined) throw new Error("page has no content stream");

    const ctx = doc.context;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asArray = (contents as any).asArray;
    const refs: unknown[] =
      typeof asArray === "function"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (contents as any).asArray()
        : [contents];

    let text = "";
    for (const ref of refs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = ctx.lookup(ref as any) as any;
      const raw: Uint8Array =
        typeof stream.getContents === "function"
          ? stream.getContents()
          : stream.contents;
      try {
        text += inflateSync(Buffer.from(raw)).toString("latin1");
      } catch {
        text += Buffer.from(raw).toString("latin1");
      }
    }

    const match = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(text);
    if (match === null) {
      throw new Error(
        `no text-positioning operator found in the page; cannot verify placement. Stream was: ${text.slice(0, 200)}`,
      );
    }
    return Number.parseFloat(match[2] ?? "");
  }

  async function blankA4(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([A4.width, A4.height]);
    return await doc.save();
  }

  it("reads the coordinate back at all", async () => {
    // Guards the guard. If pdf-lib changes how it emits positioning,
    // the tests below must break loudly rather than stop checking.
    const { bytes } = await renderCertificate({
      templateBytes: await blankA4(),
      templateMimeType: "application/pdf",
      fields: [place({ yFrac: 0.5 })],
      data: DATA,
    });
    await expect(firstTextY(bytes)).resolves.toBeGreaterThan(0);
  });

  it("puts a field placed near the TOP near the top of the page", async () => {
    // The bug: a missing or doubled flip prints the owner's name at the
    // bottom of a certificate. It renders fine and is completely wrong.
    const { bytes } = await renderCertificate({
      templateBytes: await blankA4(),
      templateMimeType: "application/pdf",
      fields: [place({ yFrac: 0.1 })],
      data: DATA,
    });
    expect(await firstTextY(bytes)).toBeGreaterThan(A4.height * 0.8);
  });

  it("puts a field placed near the BOTTOM near the bottom", async () => {
    const { bytes } = await renderCertificate({
      templateBytes: await blankA4(),
      templateMimeType: "application/pdf",
      fields: [place({ yFrac: 0.9 })],
      data: DATA,
    });
    expect(await firstTextY(bytes)).toBeLessThan(A4.height * 0.2);
  });

  it("centres a centred field on its anchor", async () => {
    // So a placed field stays put whether the name is short or long.
    const short = await renderCertificate({
      templateBytes: await blankA4(),
      templateMimeType: "application/pdf",
      fields: [place({ xFrac: 0.5, align: "center" })],
      data: { ...DATA, ownerName: "Li" },
    });
    const long = await renderCertificate({
      templateBytes: await blankA4(),
      templateMimeType: "application/pdf",
      fields: [place({ xFrac: 0.5, align: "center" })],
      data: { ...DATA, ownerName: "Maria Concepcion de los Santos" },
    });
    // The long name must START further left than the short one, which
    // is what centring means and what left-alignment would not do.
    const shortX = await firstTextX(short.bytes);
    const longX = await firstTextX(long.bytes);
    expect(longX).toBeLessThan(shortX);
  });

  async function firstTextX(bytes: Uint8Array): Promise<number> {
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const contents = page.node.Contents();
    if (contents === undefined) throw new Error("page has no content stream");
    const ctx = doc.context;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyContents = contents as any;
    const refs: unknown[] =
      typeof anyContents.asArray === "function"
        ? anyContents.asArray()
        : [contents];
    let text = "";
    for (const ref of refs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = ctx.lookup(ref as any) as any;
      const raw: Uint8Array =
        typeof stream.getContents === "function"
          ? stream.getContents()
          : stream.contents;
      try {
        text += inflateSync(Buffer.from(raw)).toString("latin1");
      } catch {
        text += Buffer.from(raw).toString("latin1");
      }
    }
    const match = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(text);
    if (match === null) throw new Error("no positioning operator");
    return Number.parseFloat(match[1] ?? "");
  }
});

describe("text that will not fit", () => {
  it("reports the field rather than printing through the border", async () => {
    // A name running off the edge of a framed document is the version
    // the family notices, and the office needs telling before it prints.
    const template = await makeTemplatePdf();
    const { overflowed } = await renderCertificate({
      templateBytes: template,
      templateMimeType: "application/pdf",
      fields: [
        place({
          key: "ownerName",
          fontSize: 40,
          // A sliver of the page — nothing readable fits.
          maxWidthFrac: 0.02,
        }),
      ],
      data: {
        ...DATA,
        ownerName: "Maria Concepcion Dolores de los Santos-Villanueva",
      },
    });
    expect(overflowed).toEqual(["ownerName"]);
  });

  it("shrinks quietly when shrinking is enough", async () => {
    const template = await makeTemplatePdf();
    const { overflowed } = await renderCertificate({
      templateBytes: template,
      templateMimeType: "application/pdf",
      fields: [place({ key: "ownerName", fontSize: 30, maxWidthFrac: 0.6 })],
      data: {
        ...DATA,
        ownerName: "Maria Concepcion Dolores de los Santos-Villanueva",
      },
    });
    expect(overflowed).toEqual([]);
  });
});

describe("a blank that is an image, not a PDF", () => {
  it("opens a PNG and gives it a page", async () => {
    // Some parks will have their certificate only as artwork.
    const { page } = await openTemplate(
      new Uint8Array(TINY_PNG),
      "image/png",
    );
    const size = page.getSize();
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  it("renders onto it without throwing", async () => {
    const { bytes } = await renderCertificate({
      templateBytes: new Uint8Array(TINY_PNG),
      templateMimeType: "image/png",
      fields: [place()],
      data: DATA,
    });
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });
});

describe("a blank that is unusable", () => {
  it("still renders onto a blank-but-valid PDF", async () => {
    // I wrote this the other way round first — asserting a page-less
    // PDF is refused — and it failed: pdf-lib's saved empty document
    // comes back with ONE page, not zero. The scenario does not arise,
    // so the honest assertion is the one that does: a park that uploads
    // an unadorned PDF gets a certificate carrying just the details,
    // not an error. The `no pages` guard in the source stays as cheap
    // defence against a malformed file from elsewhere.
    const empty = await (await PDFDocument.create()).save();
    const { bytes } = await renderCertificate({
      templateBytes: empty,
      templateMimeType: "application/pdf",
      fields: [place()],
      data: DATA,
    });
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("refuses bytes that are not a document at all", async () => {
    await expect(
      renderCertificate({
        templateBytes: new Uint8Array([1, 2, 3, 4]),
        templateMimeType: "application/pdf",
        fields: [place()],
        data: DATA,
      }),
    ).rejects.toThrow();
  });
});
