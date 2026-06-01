/**
 * Client-side mirror of `convex/lib/states.ts` — Story 1.7.
 *
 * The `LotStatus` union must stay in sync with both the Convex schema
 * (Story 1.8 introduces the `lots` table) and `convex/lib/states.ts`.
 * Because the `convex/` and `src/` trees are separate TypeScript
 * projects (convex/ runs in the Convex isolate, src/ in Next.js), we
 * cannot share the type via direct import. A Vitest sync test in
 * `tests/unit/convex/lib/stateMachines.test.ts` asserts that
 * `LOT_STATUSES` here equals `LOT_STATUSES` in `convex/lib/states.ts`.
 *
 * Consumers: StatusPill (Story 1.4), lot mutations (Story 1.8+),
 * Phase 1 SVG map (Story 1.12).
 */

export const LOT_STATUSES = [
  "available",
  "reserved",
  "sold",
  "occupied",
  "cancelled",
  "defaulted",
  "transferred",
] as const;

export type LotStatus = (typeof LOT_STATUSES)[number];
