/**
 * Legend that explains the three lot-status colors on the cemetery
 * map. Reused on Home (preview) and Find-a-Grave (interactive).
 *
 * Color is the only signal here (not text labels alone) but each
 * swatch is paired with explicit copy — the rendering is
 * colour-blind safe by virtue of also relying on outline-vs-fill.
 */
export function MapLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
      <li className="inline-flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-3 w-3 border border-primary"
          style={{ backgroundColor: "transparent" }}
        />
        Available
      </li>
      <li className="inline-flex items-center gap-2">
        <span aria-hidden className="inline-block h-3 w-3 bg-accent-gold" />
        Reserved
      </li>
      <li className="inline-flex items-center gap-2">
        <span aria-hidden className="inline-block h-3 w-3 bg-primary" />
        Occupied
      </li>
    </ul>
  );
}
