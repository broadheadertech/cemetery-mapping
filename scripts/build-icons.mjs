/**
 * Regenerate the PWA launcher icons from the canonical brand mark.
 *
 * `public/brand/mark.png` is the one source of the logo — every screen
 * that shows it points at that file, so a change there carries through
 * the sidebar, both logins, the portal and the marketing site with
 * nothing else to edit.
 *
 * The launcher icons cannot follow automatically. A manifest icon must
 * be a standalone file at a fixed size with its own background, because
 * a launcher composites it onto whatever the wallpaper is — and this
 * mark is a dark green wreath, which on a dark wallpaper disappears.
 * So they are copies, and a hand-kept copy of a logo drifts; the one
 * that drifts is always the one nobody looks at.
 *
 * This makes the copy mechanical. Run it after changing the mark:
 *
 *     node scripts/build-icons.mjs
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARK = path.join(ROOT, "public", "brand", "mark.png");
const OUT_DIR = path.join(ROOT, "public", "icons");

/** Sizes the manifest asks for. */
const SIZES = [192, 512];

/**
 * How much of the tile the mark occupies.
 *
 * A launcher may mask the icon to a circle or a squircle. At 74% the
 * wreath's outer edge stays clear of every common mask.
 */
const MARK_FRACTION = 0.74;

/** Brand ivory — the ground the mark is drawn for. */
const IVORY = { r: 0xf6, g: 0xf2, b: 0xea, alpha: 1 };

async function main() {
  if (!existsSync(MARK)) {
    throw new Error(
      `No mark at ${path.relative(ROOT, MARK)}. Run scripts/build-brand-mark.mjs first.`,
    );
  }

  for (const px of SIZES) {
    const inner = Math.round(px * MARK_FRACTION);
    const mark = await sharp(MARK)
      .resize(inner, inner, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();

    const file = path.join(OUT_DIR, `icon-${px}.png`);
    await sharp({
      create: {
        width: px,
        height: px,
        channels: 4,
        background: IVORY,
      },
    })
      .composite([{ input: mark, gravity: "center" }])
      /*
       * Flattened onto the ivory, so the file has no alpha channel at
       * all rather than a fully-opaque one.
       *
       * Not pedantry: an icon that merely happens to be opaque is one
       * edit away from being see-through, and a see-through launcher
       * icon puts a dark green wreath on whatever wallpaper the phone
       * has. Removing the channel makes that impossible instead of
       * unlikely.
       */
      .flatten({ background: IVORY })
      .png({ palette: true, quality: 90 })
      .toFile(file);

    console.log(`[build-icons] wrote ${path.relative(ROOT, file)}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
