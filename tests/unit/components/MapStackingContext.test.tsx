/**
 * The map must not paint over the app.
 *
 * Clicking a lot on /map opens its action menu, and the menu was drawn
 * BEHIND the map: visible in the strip above the map's top edge, gone
 * everywhere else, with its buttons unreachable.
 *
 * Leaflet's own stylesheet puts `.leaflet-pane` at z-index 400 and its
 * controls at 1000. Radix portals a dialog to <body> at z-50. With no
 * stacking context around the map, 400 and 1000 compete against 50 in
 * the ROOT context and the map wins every time — against dialogs,
 * popovers, tooltips and dropdowns alike.
 *
 * `isolation: isolate` contains Leaflet's ordering to its own element.
 * jsdom does no layout, so this cannot assert paint order; it asserts
 * the containment is declared, which is the thing that gets deleted by
 * accident during a className tidy-up.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** The className string on the element bearing this test id. */
function classNameFor(src: string, testId: string): string {
  const at = src.indexOf(`data-testid="${testId}"`);
  expect(at, `no element with testid ${testId}`).toBeGreaterThan(-1);
  const after = src.slice(at);
  const m = /className=\{?"([^"]*)"/.exec(after);
  expect(m, `no className after testid ${testId}`).not.toBeNull();
  return m![1]!;
}

describe("Leaflet's stacking context", () => {
  it("is contained on the cemetery map renderer", () => {
    const src = source("src/components/LotMap/LeafletRenderer.tsx");
    expect(classNameFor(src, "leaflet-renderer")).toContain("isolate");
  });

  it("is contained on the location picker's map too", () => {
    // Same Leaflet, same z-indexes, different screen.
    const src = source("src/components/LotLocationPicker/LotLocationPicker.tsx");
    expect(classNameFor(src, "lot-location-picker")).toContain("isolate");
  });

  it("is contained on the wrapper holding the map's own overlays", () => {
    // The mirror-image bug: the "Updating…" and "No lots in this view"
    // overlays sit at z-1000 to clear Leaflet's controls. Without a
    // stacking context on their wrapper, that number escapes into the
    // root context and beats every dialog in the app.
    const src = source("src/components/LotMap/LotMap.tsx");
    expect(src).toMatch(/className="relative isolate"/);
  });

  it("keeps the app's dialogs below any number Leaflet uses", () => {
    // The other half of the contract. If a later change raised the
    // dialog above 400 by hand, the isolation would stop being load
    // bearing and would get deleted as dead weight — so this records
    // that the dialog deliberately stays at the app's own tier.
    const src = source("src/components/ui/dialog.tsx");
    expect(src).toContain("z-50");
  });
});
