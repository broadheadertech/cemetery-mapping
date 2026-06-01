# ADR 0069: Ceremonies Table — Option B (Parallel Table)

- **Status:** Accepted
- **Date:** 2026-05-24
- **Story:** 7.5

## Context

Story 7.5 introduces a non-interment ceremony surface (consecrations, with
forward-compat for memorial anniversaries). The brand-spec letterhead example
in Chapter VI of `apostle-paul-brand-guidelines.html` describes a consecration
distinct from a burial: the chapel and pathway are reserved exclusively for
the family, a memorial consultant receives them at the gate, and there is no
"body in the ground" gesture.

The story spec proposes two implementation options for the persistence shape:

- **Option A — Rename `interments` → `ceremonies` + add a `kind` discriminator.**
  Pros: single source of truth for double-booking, calendar joins are
  uniform, indices are shared. Cons: ~37 cross-file references to the
  `interments` table across `convex/`, `src/components/`, `src/app/`, and
  `tests/` need to be updated in a single atomic PR. A backfill internal
  mutation must run after schema deploy to set `kind: "interment"` on every
  legacy row. Coordinating with parallel agents (6.8 plaque PDF, 2.9 family
  estate, 1.15 named sections) raises the merge-conflict risk.

- **Option B — Parallel `ceremonies` table next to `interments`.**
  Pros: zero migration risk; existing tests stay green; no concurrent-edit
  conflicts with parallel agents. Cons: the double-booking guard must query
  BOTH tables; calendar query joins two tables; long-term the
  `interments` / `ceremonies` split is conceptual debt that a future story
  may want to consolidate.

## Decision

**Option B (parallel table) is the chosen approach for Story 7.5.**

The rename in Option A is mechanically straightforward but the breadth of
the change (37+ files, including page routes, components, tests, and the
`.next/` artifact cache) collides with the parallel-agent workflow this
sprint is running under. The Story 7.5 dev brief explicitly authorises
the fallback ("If you hit a snag with the rename ... fall back to Option
B (parallel ceremonies table) and document the reason in the ADR.").

The load-bearing concern — double-booking prevention — is preserved by
the new `convex/lib/scheduling.ts:assertNoBookingConflict` helper which
reads from BOTH `ceremonies` AND the legacy `interments` table when
computing overlap candidates. The cross-kind, cross-table lot conflict
guarantee is therefore identical to what Option A would have provided.

## Consequences

### Positive

- No data migration, no risk of corrupting Story 7.1's existing interment
  rows.
- Story 7.4's field-worker mobile flow (which writes to `interments` via
  `convex/interments.ts:completeInterment`) keeps working unchanged.
- Parallel agents can land their PRs without coordinating around a
  table rename.

### Negative

- The booking-conflict guard runs TWO indexed scans (one per table).
  At Phase 1 scale this is comfortably within Convex's per-query budget
  (the conflict window is ±4 hours = a few dozen candidate rows).
- The combined calendar (`/ceremonies/calendar`) fetches from two
  queries and merges in memory. Acceptable at Phase 1 cemetery volume.
- The `kind` field on `ceremonies` ships with the `"interment"` literal
  reserved but with zero rows — a future Option-A consolidation can
  back-migrate legacy interments into the new table without changing
  the `kind` union.

### Reversibility

A future story can elect Option A as a consolidation move:

1. Backfill: write the existing `interments` rows into `ceremonies`
   with `kind: "interment"`, `chapelReserved: false`,
   `pathwayReserved: false`, `durationMinutes: 60` (matching
   `INTERMENT_LEGACY_DURATION_MINUTES` in `convex/lib/scheduling.ts`).
2. Switch the legacy `convex/interments.ts` query callsites to read
   from `ceremonies` instead.
3. Delete `convex/interments.ts` and the `interments` table.
4. Remove the legacy branch in `assertNoBookingConflict`.

The `convex/internal/backfillCeremoniesKind.ts` harness ships now so
the consolidation PR drops in the real scan logic without a new file
landing.

### Schema columns

The `ceremonies` table carries the full union of fields the spec
requires:

```ts
ceremonies: defineTable({
  kind: v.union(
    v.literal("consecration"),
    v.literal("interment"),
    v.literal("memorial_anniversary"),
  ),
  contractId: v.id("contracts"),
  familyEstateId: v.optional(v.string()),  // v.string() until 2.9 lands
  lotId: v.id("lots"),
  deceasedOccupantId: v.optional(v.id("occupants")),
  scheduledAt: v.number(),
  durationMinutes: v.number(),
  chapelReserved: v.boolean(),
  pathwayReserved: v.boolean(),
  consultantUserId: v.optional(v.id("users")),
  notes: v.optional(v.string()),
  status: v.union(
    v.literal("scheduled"),
    v.literal("completed"),
    v.literal("cancelled"),
  ),
  scheduledBy: v.id("users"),
  scheduledAt_createdAt: v.number(),
  completedAt: v.optional(v.number()),
  completedBy: v.optional(v.id("users")),
  cancellationReason: v.optional(v.string()),
})
  .index("by_kind_scheduledAt", ["kind", "scheduledAt"])
  .index("by_contract", ["contractId"])
  .index("by_status_scheduledAt", ["status", "scheduledAt"])
  .index("by_scheduledAt", ["scheduledAt"])
  .index("by_lot_scheduledAt", ["lotId", "scheduledAt"]),
```

### Family-estate forward compat (Story 2.9)

`familyEstateId` is `v.optional(v.string())` rather than
`v.optional(v.id("familyEstates"))` because Story 2.9 has not yet
introduced the `familyEstates` table. When 2.9 lands, a follow-up PR
tightens the validator to `v.id("familyEstates")` and the field stays
optional.

## References

- [Story 7.5 — Schedule a consecration ceremony](../../_bmad-output/implementation-artifacts/7-5-schedule-consecration-ceremony.md)
- [Story 7.1 — Office staff schedules an interment](../../_bmad-output/implementation-artifacts/7-1-office-staff-schedules-an-interment.md)
- [Story 7.2 — System prevents double-booking](../../_bmad-output/implementation-artifacts/7-2-system-prevents-double-booking.md)
- [ADR 0006 — State-machine transition guards](./0006-state-machine-transitions.md)
- [Chapter VI letterhead example, apostle-paul-brand-guidelines.html](../../apostle-paul-brand-guidelines.html)
