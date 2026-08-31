# PWA icons

Generated from `public/brand/mark.svg` — the canonical dove-within-laurel
mark — on the brand ivory ground (`#F6F2EA`), with the mark at 74% of the
tile so a launcher's rounded mask cannot clip the laurel.

- `icon-192.svg` — 192×192 launcher icon (Android home screen).
- `icon-512.svg` — 512×512 launcher icon (splash screens, large UI).

They were placeholder "BH" tiles on slate until the mark existed, and the
manifest still named a different park in a different palette.

## Changing the logo

`public/brand/mark.svg` is the one source. `BrandMark` reads it directly,
so the marketing site, the nav and the footer all follow a change to that
file with nothing else to edit.

These two icons do NOT follow automatically — they embed a copy of the
mark's paths. After changing `mark.svg`, regenerate them so the launcher
icon does not go on showing last year's logo:

```
node scripts/build-icons.mjs
```

Two other places carry their own version of the mark and are deliberately
separate:

- `convex/lib/brandAssets.ts` — PDFs. Convex actions cannot read from
  `public/`, and PDFKit here has no SVG rasteriser, so receipts and
  contracts draw a hand-built vector approximation. See the notes in
  that file before changing it.
- `src/app/**/icon.*` — none today. A favicon added later should be
  generated from the same mark rather than drawn again.
