/**
 * Ambient module declarations for side-effect CSS imports.
 *
 * Story 8.2 — `LeafletRenderer.tsx` dynamically imports
 * `"leaflet/dist/leaflet.css"` inside a `useEffect` to ship Leaflet's
 * styles only when the Phase 2 renderer is actually mounted. TypeScript
 * resolves the import path against `node_modules/leaflet`, finds a
 * `.css` file, and (without this shim) errors with TS2307 because
 * Next's default CSS typing only covers `*.module.css` keyed imports.
 *
 * Plain CSS side-effect imports return `void` and have no exports —
 * declaring the module as `unknown` is sufficient for the compiler.
 */
declare module "*.css";
