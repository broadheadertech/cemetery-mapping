# PWA icons

Generated from `public/brand/mark.png` — the canonical dove-within-laurel
mark — on the brand ivory ground (`#F6F2EA`), with the mark at 74% of the
tile so a launcher's rounded mask cannot clip the wreath.

- `icon-192.png` — 192×192 launcher icon (Android home screen).
- `icon-512.png` — 512×512 launcher icon (splash screens, large UI).

They are flattened onto the ivory rather than left with a transparent
channel: a launcher composites its icon onto the wallpaper, and this mark
is a dark green wreath that would vanish on a dark one.

They were placeholder "BH" tiles on slate until the mark existed, and the
manifest still named a different park in a different palette.

## Changing the logo

`public/brand/mark.png` is the one source. The sidebar, both login
screens, the customer portal and the marketing site all point at it, so a
change there carries everywhere with nothing else to edit.

The mark itself is built from the supplied artwork, which arrived as a
JPEG on a white card. JPEG has no alpha channel, so the card is keyed out
by flood-filling inward from the border — a plain threshold would make
the leaves' gloss highlights transparent and punch holes through the
wreath. Replace `public/brand/mark.jpg`, then:

```
node scripts/build-brand-mark.mjs   # mark.jpg -> transparent mark.png
node scripts/build-icons.mjs        # mark.png -> the two launcher icons
```

The icons do NOT follow a change automatically — they are copies — so
run the second script or the launcher goes on showing the old logo.

Two other places carry their own version of the mark and are deliberately
separate:

- `convex/lib/brandAssets.ts` — PDFs. Convex actions cannot read from
  `public/`, and PDFKit here has no SVG rasteriser, so receipts and
  contracts draw a hand-built vector approximation. See the notes in
  that file before changing it.
- `src/app/**/icon.*` — none today. A favicon added later should be
  generated from the same mark rather than drawn again.

`public/brand/wordmark.svg` is separate: the lettering, not the emblem.
