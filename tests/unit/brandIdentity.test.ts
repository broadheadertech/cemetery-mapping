/**
 * The app's own name and face.
 *
 * The web manifest is the one piece of branding nobody looks at, because
 * it only shows up once somebody installs the app to a home screen — and
 * by then it is on their phone saying the wrong thing. It named a
 * different park in a different palette, and pointed at two placeholder
 * tiles reading "BH" on slate, months after a real mark existed.
 *
 * Nothing about that fails a build or a test run. It just quietly ships.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
  name: string;
  short_name: string;
  description: string;
  theme_color: string;
  background_color: string;
  icons: Array<{ src: string; sizes: string }>;
};

/** The palette from the brand guide. */
const EMERALD = "#1D5C4D";
const IVORY = "#F6F2EA";

describe("what an installed app calls itself", () => {
  it("names the park, not the software house that built it", () => {
    expect(manifest.name).toMatch(/Apostle Paul/i);
    expect(manifest.short_name).toMatch(/Apostle Paul/i);
  });

  it("does not still say Broadheader anywhere", () => {
    // Broadheader builds it; the park is the client, and the icon on a
    // home screen belongs to the park.
    const blob = JSON.stringify(manifest);
    expect(blob).not.toMatch(/broadheader/i);
  });

  it("says where the park actually is", () => {
    // The brand document's "Bulacan" is stale; the park is in Aringay,
    // La Union.
    expect(manifest.description).toMatch(/Aringay/i);
    expect(manifest.description).not.toMatch(/Bulacan/i);
  });

  it("uses the brand palette, not the scaffold's slate", () => {
    expect(manifest.theme_color).toBe(EMERALD);
    expect(manifest.background_color).toBe(IVORY);
  });
});


/** Raw bytes of a repo file. */
function bytes(rel: string): Buffer {
  return readFileSync(path.join(ROOT, rel));
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isPng(buf: Buffer): boolean {
  return buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Width and height out of the IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Whether a PNG can be see-through.
 *
 * Colour type 6 (and 4) carry a per-pixel alpha channel; a palette
 * image (type 3) carries transparency in a `tRNS` chunk instead. The
 * quantised mark is the latter, so checking the colour type alone would
 * call it opaque.
 */
function hasTransparency(buf: Buffer): boolean {
  const colourType = buf.readUInt8(25);
  if (colourType === 4 || colourType === 6) return true;
  return buf.includes(Buffer.from("tRNS", "ascii"));
}

/** Every source file, for the "nothing points at the old asset" sweep. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe("the brand mark itself", () => {
  const MARK = "public/brand/mark.png";

  it("is a PNG with real transparency", () => {
    // The artwork was supplied as a JPEG, which has no alpha channel at
    // all. Used as-is it paints a white card: a visible box on the
    // ivory nav, and glaring on the #144437 sidebar.
    const buf = bytes(MARK);
    expect(isPng(buf)).toBe(true);
    expect(hasTransparency(buf)).toBe(true);
  });

  it("is square, so one number sizes it everywhere", () => {
    // It is drawn at 32px in the sidebar and 360px on the marketing
    // hero from the same file.
    const { width, height } = pngSize(bytes(MARK));
    expect(width).toBe(height);
  });

  it("is big enough for the largest place it is drawn", () => {
    // The 512px launcher icon is the biggest consumer.
    expect(pngSize(bytes(MARK)).width).toBeGreaterThanOrEqual(512);
  });

  it("is not so heavy that every page pays for it", () => {
    // The sidebar draws this on every screen in the app. Unquantised it
    // was very nearly a megabyte.
    expect(bytes(MARK).length).toBeLessThan(400 * 1024);
  });

  it("leaves no screen pointing at the retired SVG", () => {
    // Six screens referenced `/brand/mark.svg`. A missed one is a
    // broken image on a login page, which is not somewhere to find out.
    const offenders = walk(path.join(ROOT, "src")).filter((f) =>
      readFileSync(f, "utf8").includes("/brand/mark.svg"),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the launcher icons", () => {
  const icons = ["public/icons/icon-192.png", "public/icons/icon-512.png"];

  it("are real images at the sizes the manifest promises", () => {
    // A manifest pointing at a file that is not there is an icon that
    // silently falls back to a screenshot of the page.
    for (const entry of manifest.icons) {
      const rel = "public" + entry.src;
      const buf = bytes(rel);
      expect(isPng(buf)).toBe(true);
      const px = Number(entry.sizes.split("x")[0]);
      expect(pngSize(buf)).toEqual({ width: px, height: px });
    }
  });

  it("sit on the brand ground rather than transparency", () => {
    // A launcher composites onto the wallpaper, and this mark is a dark
    // green wreath — on a dark wallpaper it would disappear.
    for (const file of icons) {
      expect(hasTransparency(bytes(file))).toBe(false);
    }
  });

  it("are declared as PNG, not left claiming to be SVG", () => {
    for (const entry of manifest.icons) {
      expect(entry.src).toMatch(/\.png$/);
    }
  });

  it("no longer ship the BH placeholder", () => {
    for (const file of ["public/icons/icon-192.svg", "public/icons/icon-512.svg"]) {
      expect(existsSync(path.join(ROOT, file))).toBe(false);
    }
  });
});
