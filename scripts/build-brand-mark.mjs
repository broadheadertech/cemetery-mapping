/**
 * Turn the supplied logo artwork into a usable brand mark.
 *
 * The artwork arrives as `public/brand/mark.jpg` — a render on a white
 * card. JPEG has no alpha channel at all, so used as-is it paints a
 * white rectangle: visible as a box on the ivory nav, and glaring on
 * the emerald sidebar. It has to be keyed out.
 *
 * The keying is a FLOOD FILL from the border, not a threshold over the
 * whole image, and that distinction is the entire point. The leaves in
 * this render carry near-white gloss highlights; a threshold would make
 * every one of them transparent and punch holes through the wreath.
 * Flooding inward from the edge only removes white that is CONNECTED to
 * the outside, so an interior highlight is untouched.
 *
 * The drop shadow goes with it. On a white card a shadow reads as
 * depth; on ivory or emerald it reads as dirt.
 *
 * Run after replacing the artwork:
 *
 *     node scripts/build-brand-mark.mjs
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "public", "brand", "mark.jpg");
const OUT = path.join(ROOT, "public", "brand", "mark.png");

/**
 * Anything at least this light MAY be background, if it is also
 * connected to the border.
 *
 * Set above the darkest part of the drop shadow and well below the
 * lightest green in the artwork, so the flood carries through the
 * shadow but stops at the leaves.
 */
const BACKGROUND_MIN = 170;

/** Fully transparent at or above this — the card itself. */
const FULLY_CLEAR = 245;

/** The finished mark, square, with room to breathe. */
const OUTPUT_PX = 1024;

function minChannel(data, i) {
  return Math.min(data[i], data[i + 1], data[i + 2]);
}

async function main() {
  if (!existsSync(SOURCE)) {
    throw new Error(`No artwork at ${path.relative(ROOT, SOURCE)}`);
  }

  const { data, info } = await sharp(SOURCE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const at = (x, y) => (y * width + x) * channels;

  // --- flood the background inward from every border pixel ------------
  const isBackground = new Uint8Array(width * height);
  const queue = [];

  const consider = (x, y) => {
    const idx = y * width + x;
    if (isBackground[idx]) return;
    if (minChannel(data, at(x, y)) < BACKGROUND_MIN) return;
    isBackground[idx] = 1;
    queue.push(idx);
  };

  for (let x = 0; x < width; x++) {
    consider(x, 0);
    consider(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    consider(0, y);
    consider(width - 1, y);
  }

  while (queue.length > 0) {
    const idx = queue.pop();
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) consider(x - 1, y);
    if (x < width - 1) consider(x + 1, y);
    if (y > 0) consider(x, y - 1);
    if (y < height - 1) consider(x, y + 1);
  }

  // --- alpha, with a soft edge ----------------------------------------
  let kept = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const i = at(x, y);

      if (isBackground[idx]) {
        data[i + 3] = 0;
        continue;
      }

      // A pixel the flood could not claim, but which touches one it
      // did, sits on the boundary and is part white. Grading it by how
      // light it is keeps the outline smooth instead of stair-stepped.
      const touchesBackground =
        (x > 0 && isBackground[idx - 1]) ||
        (x < width - 1 && isBackground[idx + 1]) ||
        (y > 0 && isBackground[idx - width]) ||
        (y < height - 1 && isBackground[idx + width]);

      if (touchesBackground) {
        const m = minChannel(data, i);
        const t = (FULLY_CLEAR - m) / (FULLY_CLEAR - BACKGROUND_MIN);
        data[i + 3] = Math.max(0, Math.min(255, Math.round(t * 255)));
      } else {
        data[i + 3] = 255;
      }
      kept++;
    }
  }

  const coverage = (kept / (width * height)) * 100;
  if (coverage < 5 || coverage > 80) {
    // A logo should be a minority of its card. Far outside that and the
    // flood has either eaten the artwork or failed to start.
    throw new Error(
      `Keying looks wrong: ${coverage.toFixed(1)}% of the image survived. ` +
        `Check BACKGROUND_MIN against the artwork's background.`,
    );
  }

  await sharp(data, { raw: { width, height, channels } })
    /*
     * Palette-quantised, which takes this from ~970KB to ~250KB.
     *
     * The mark is a handful of greens and greys with a hard alpha edge,
     * so 256 colours is more than it uses and the banding a photograph
     * would show does not appear. It is worth doing: the sidebar draws
     * this at 32px on every page of the app.
     */
    .png({ palette: true, quality: 90 })
    // Trim the now-transparent margin, then re-pad square so the mark
    // is centred and every consumer can size it by one number.
    .trim()
    .resize(OUTPUT_PX, OUTPUT_PX, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toFile(OUT);

  console.log(
    `[build-brand-mark] wrote ${path.relative(ROOT, OUT)} — ` +
      `${coverage.toFixed(1)}% of the artwork kept`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
