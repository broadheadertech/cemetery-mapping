/**
 * Barrel — Story 1.12, extended in Story 8.2.
 *
 * Re-exports the orchestrator + the two renderers. The Leaflet
 * renderer's TYPES are safe to export from here (a type re-export is
 * erased at compile time and never reaches the client bundle); the
 * runtime module is still pulled exclusively through the orchestrator
 * via `next/dynamic({ ssr: false })`. Do NOT add `export {
 * LeafletRenderer } from "./LeafletRenderer"` — that would force the
 * static module graph to include Leaflet on every consumer of this
 * barrel and defeat the lazy-load.
 */
export { LotMap } from "./LotMap";
export type { LotMapProps, LotMapRenderer } from "./LotMap";
export { SvgRenderer } from "./SvgRenderer";
export type { SvgRendererProps } from "./SvgRenderer";
export type { LeafletRendererProps } from "./LeafletRenderer";
