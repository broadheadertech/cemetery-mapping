# PWA icons

Placeholder SVGs ship with Story 1.13. Replace with branded PNG/SVG once
the client supplies final marks:

- `icon-192.svg` — 192×192 launcher icon (Android home screen).
- `icon-512.svg` — 512×512 launcher icon (splash screens, large UI).

`public/manifest.webmanifest` references these. When real assets land,
update the manifest's `icons[].src` paths if the file extensions change.
