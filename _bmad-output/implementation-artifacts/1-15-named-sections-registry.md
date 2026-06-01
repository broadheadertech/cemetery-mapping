# Story 1.15: Named-Sections Registry

Status: review

<!-- Brand-tier extension: this story exists because Apostle Paul Memorial Park's wayfinding signage (Chapter VII of the brand guide) presents named sections — "CHAPEL OF GRACE", "SECTION A · NORTH", "FAMILY ESTATES · EAST", "COLUMBARIUM" — as a first-class part of the visitor experience. Today `lots.section` is a free-text string (Story 1.8). This story promotes sections to a structured registry so the system reflects what families actually read at the gate, on the wayfinding stones, and in the consecration letter (Chapter VI). -->

## Story

As an **Admin**,
I want **to maintain a registry of named cemetery sections (e.g. "Chapel of Grace", "Section A · North", "Columbarium", "Family Estates · East") with a stable identifier, sort order, kind, and descriptive copy**,
so that **lot identifiers tie to wayfinding-grade names and the system reflects how the cemetery actually orients families on site** (extends FR3 Lot Inventory).

This story replaces `lots.section: v.string()` (free text from [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md)) with a foreign-key reference to a new `sections` table. The change is additive — existing `lots.section` strings are backfilled into the new table during deploy; lot CRUD continues to work after the migration with the section field rendered as a dropdown instead of a free-text input.

## Acceptance Criteria

1. **AC1 — `sections` table is defined with name, displayName, sortOrder, kind, descriptionMarkdown, and a geometry bounds box**: `convex/schema.ts` defines a `sections` table with: `name: v.string()` (canonical identifier, e.g. "section-a-north", lowercase kebab-case, unique), `displayName: v.string()` (wayfinding label, e.g. "Section A · North"), `sortOrder: v.number()` (ascending; admin-controlled), `kind: v.union(v.literal("chapel"), v.literal("family"), v.literal("standard"), v.literal("niche"), v.literal("columbarium"))`, `descriptionMarkdown: v.optional(v.string())` (1–3 paragraph long-form description for future surfaces like the brochure / portal), `geometryBoundsBox: v.optional(v.object({ minLat: v.number(), maxLat: v.number(), minLng: v.number(), maxLng: v.number() }))` (used by the viewport map renderer to highlight a section), `isRetired: v.boolean()`, `createdAt: v.number()`, `createdBy: v.id("users")`. Indexes: `by_name` (unique), `by_kind`, `by_sortOrder`. The geometry-bounds-box is optional in Phase 1 — Story 8.1 (GPS import) is where it gets populated for real; here it can be left null and the admin form simply persists what's entered.

2. **AC2 — Admin CRUD UI at `/admin/sections` lists, creates, edits, and retires sections**: A new authenticated route `/admin/sections` (Admin-only via the existing route-group middleware from [Story 1.5](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md)) lists all sections in `sortOrder` ascending with: `displayName`, `name` (mono font), `kind` `StatusPill`, lot count (joined from `lots`), and actions (Edit / Retire / Restore). Create + edit open the standard `<Sheet>` form pattern (per UX § Form Patterns) with fields matching AC1, `react-hook-form` + `zod` validation. Retired sections are hidden from the lot create / edit dropdown but remain readable everywhere they're referenced. Every mutation calls `requireRole(ctx, ["admin"])` and emits `emitAudit` (Story 1.6).

3. **AC3 — `lots.sectionId` replaces `lots.section`; lot create / edit dropdown is populated from the registry**: `convex/schema.ts` is updated so `lots.sectionId: v.id("sections")` replaces `lots.section: v.string()`. The `LotForm` from [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md) swaps the free-text input for a `<Select>` populated by `useQuery(api.sections.list, { includeRetired: false })`, sorted by `sortOrder`. The lot detail page renders `section.displayName` wherever `lots.section` was previously rendered. The `listLots` query's `sectionFilter` arg now accepts `sectionId: v.id("sections")` instead of a string; the `by_section_block` index is renamed to `by_sectionId_block` and the index spec updated accordingly. Story 1.8's existing tests are updated to use seeded section IDs.

4. **AC4 — Deploy-time migration backfills existing `lots.section` strings into the new `sections` table, deduplicated**: A one-shot internal mutation `convex/migrations/0015_backfillSections.ts` runs once at deploy: groups distinct `lots.section` strings, creates one `sections` row per distinct value with `kind: "standard"`, `name` derived from the string (lowercase kebab-case), `displayName` = the original string, `sortOrder` = arrival order × 10 (room for inserts), and patches every affected `lots` row to set `sectionId`. The mutation is idempotent (a re-run detects existing rows and no-ops) and emits a `migration_backfill_sections` audit entry with the lot-row count it touched. After backfill, the `lots.section` string column is dropped from the schema (a follow-up deploy after backfill verification — flagged inline in the migration's completion log).

## Tasks / Subtasks

### Schema + registry (AC1, AC3)

- [ ] **Task 1: Add the `sections` table to `convex/schema.ts`** (AC: 1)
  - [ ] **UPDATE** `convex/schema.ts`: add the table definition with the fields listed in AC1. Use `v.string()` for `name` + `displayName`, `v.number()` for `sortOrder`, the 5-literal `v.union` for `kind`.
  - [ ] Add the three indexes (`by_name`, `by_kind`, `by_sortOrder`). The `by_name` index enforces uniqueness via the migration's pre-insert lookup; Convex does not enforce uniqueness at the index level, so the registry-create mutation asserts no row with the same `name` exists first.
  - [ ] Document the table choice + rationale in `docs/adr/0015-named-sections-registry.md` (NEW ADR) — covers the move from free-text to registry, the kind enum's 5 values (mapped to brand-guide wayfinding categories), the `geometryBoundsBox` reservation for Story 8.1, and the migration plan.

- [ ] **Task 2: Implement `convex/sections.ts` mutations + queries** (AC: 1, AC: 2)
  - [ ] **NEW** `convex/sections.ts`. Exports:
    - `createSection({ name, displayName, sortOrder, kind, descriptionMarkdown?, geometryBoundsBox? })` — `requireRole(ctx, ["admin"])`; asserts `name` is not already taken; inserts the row with `createdAt`, `createdBy`, `isRetired: false`; emits audit.
    - `updateSection({ sectionId, patch })` — `requireRole(ctx, ["admin"])`; `assertExists`; if `patch.name` changes, asserts no collision; patches; emits audit with before / after.
    - `retireSection({ sectionId })` — `requireRole(ctx, ["admin"])`; sets `isRetired: true`; emits audit. **Does NOT cascade** — retired sections continue to be referenced by existing lots (Story 1.8's lot CRUD already supports `isRetired` lots semantically; the section follows the same pattern).
    - `restoreSection({ sectionId })` — `requireRole(ctx, ["admin"])`; clears `isRetired`; emits audit.
    - `list({ includeRetired? })` — read-side helper for the admin page + the LotForm dropdown. `requireRole(ctx, ["admin", "office_staff", "field_worker"])` — all roles need to read section labels (e.g. Field Worker reads section names in cached offline data from [Story 1.13](./1-13-field-worker-reads-cached-lot-data-offline.md)).
    - `getSection({ sectionId })` — single-row read for the detail surface (admin + office_staff).
  - [ ] All mutations emit audit via Story 1.6's `emitAudit` helper.

### Admin CRUD UI (AC2)

- [ ] **Task 3: Build the `/admin/sections` index page** (AC: 2)
  - [ ] **NEW** `src/app/(staff)/admin/sections/page.tsx`. `"use client"`. Admin-only — server-side guard via the existing admin middleware, plus a client-side `useCurrentUser` role check that falls back to a 403 message (mirroring [Story 4.7](./4-7-admin-manages-expense-categories.md)'s admin-pages pattern).
  - [ ] Renders a table with columns: `displayName`, `name` (mono), `kind` `StatusPill`, `Lot count` (computed via a small companion query that groups `lots` by `sectionId`), `Actions` (Edit, Retire / Restore). Sort by `sortOrder` ascending.
  - [ ] Primary action: "+ New section" button opens the `SectionForm` sheet.

- [ ] **Task 4: Build the `SectionForm` component** (AC: 2)
  - [ ] **NEW** `src/components/SectionForm/{SectionForm.tsx, schema.ts, index.ts}`. `"use client"`.
  - [ ] Props: `{ mode: "create" | "edit", initial?: SectionDoc, open: boolean, onOpenChange: (open: boolean) => void }`.
  - [ ] Zod schema enforces: `name` matches `/^[a-z0-9-]+$/` (kebab-case), max 64 chars; `displayName` 1–80 chars; `sortOrder` integer ≥ 0; `kind` is one of the 5 literals; `descriptionMarkdown` optional, max 2,000 chars.
  - [ ] On submit, calls `createSection` or `updateSection`; toast on success; sheet closes; the parent page's `useQuery` re-renders.

### Lot form rewire (AC3)

- [ ] **Task 5: Replace the free-text section input in `LotForm`** (AC: 3)
  - [ ] **UPDATE** `src/components/LotForm/LotForm.tsx`: swap the existing `<Input name="section">` for a `<Select>` populated by `useQuery(api.sections.list, { includeRetired: false })`. Default option: `"Select a section"`. The dropdown shows `displayName`; the value bound to the form state is `sectionId`.
  - [ ] **UPDATE** `src/components/LotForm/schema.ts`: replace `section: z.string().min(1)` with `sectionId: z.string().min(1)`.
  - [ ] **UPDATE** `convex/lots.ts → createLot` + `updateLot`: change the validator from `section: v.string()` to `sectionId: v.id("sections")`. Add an `assertExists` for the section.

- [ ] **Task 6: Update `listLots` to filter by `sectionId`** (AC: 3)
  - [ ] **UPDATE** `convex/lots.ts → listLots`: change the `sectionFilter` arg from `v.optional(v.string())` to `v.optional(v.id("sections"))`. Update the index reference from `by_section_block` to `by_sectionId_block`.
  - [ ] **UPDATE** `convex/schema.ts`: rename the index spec accordingly. Convex deploy regenerates the index.
  - [ ] **UPDATE** every call site that read `lot.section` to read `lot.sectionId` and join via `getSection({ sectionId })` for display. The lot detail page ([Story 1.11](./1-11-office-staff-views-any-lots-detail.md)) renders `section.displayName`; the lot list shows the same.

### Migration (AC4)

- [ ] **Task 7: Write the backfill migration** (AC: 4)
  - [ ] **NEW** `convex/migrations/0015_backfillSections.ts`. Export an `internalMutation` named `runBackfill`.
  - [ ] Logic: query all `lots` rows (paginated if necessary); group by the existing `lots.section` string field (which still exists at migration time — this story keeps the legacy field for one deploy cycle before the follow-up drop); for each distinct string, look up `sections.by_name` with the kebab-cased candidate name; if not present, insert a new section with `kind: "standard"`, `displayName: originalString`, `sortOrder: index * 10`, `isRetired: false`. Patch every affected `lots` row to set `sectionId`. Emit a single `migration_backfill_sections` audit entry with `{ rowsTouched, sectionsCreated }` in the payload.
  - [ ] Idempotency: re-running the migration detects rows already carrying `sectionId` and skips them; sections inserted by the previous run are matched by `name` and not duplicated.
  - [ ] Document the post-deploy follow-up (drop `lots.section` after one successful prod run) in the migration's leading docblock — including a callout that the drop is a SEPARATE deploy, never combined with the backfill.

- [ ] **Task 8: Document the migration in the runbook** (AC: 4)
  - [ ] **UPDATE** `docs/runbook.md`: add a "Named-sections backfill" section. Operator steps: (1) deploy this story; (2) run `npx convex run migrations:0015_backfillSections:runBackfill`; (3) verify row counts via `npx convex run sections:list`; (4) only after confirmation, schedule the follow-up deploy that drops `lots.section`.

### Testing (AC1, AC2, AC3, AC4)

- [ ] **Task 9: Unit tests for `convex/sections.ts`** (AC: 1, AC: 2)
  - [ ] **NEW** `tests/unit/convex/sections.test.ts`. Use `convex-test`. Cover:
    - happy path: create / update / retire / restore as Admin; row inserted with correct fields + audit emitted.
    - non-admin (office_staff, field_worker) → `FORBIDDEN`.
    - name collision on create → `INVARIANT_VIOLATION`.
    - retire-then-list with `includeRetired: false` → row hidden.
    - update with patch.name = existing-name → `INVARIANT_VIOLATION`.
  - [ ] Aim for ≥95% line coverage on `convex/sections.ts`.

- [ ] **Task 10: Update Story 1.8 lot tests + add `LotForm` section dropdown test** (AC: 3)
  - [ ] **UPDATE** `tests/unit/convex/lots.test.ts`: every test that previously inserted a `section: "A"` string now seeds a section row first and passes `sectionId`.
  - [ ] **NEW** `tests/unit/components/LotForm-section-dropdown.test.tsx`: renders the form with a `useQuery` stub returning three sections; asserts the dropdown shows all three; submit composes `sectionId` in the form value; retired sections do not appear.

- [ ] **Task 11: Migration test** (AC: 4)
  - [ ] **NEW** `tests/unit/convex/migrations/0015_backfillSections.test.ts`. Seed 5 lots with 3 distinct legacy `section` strings; run the migration; assert 3 sections exist with correct `displayName`s; assert each lot has the matching `sectionId`; re-run the migration; assert no duplicates and no row changes.

### Docs (AC1, AC2, AC4)

- [ ] **Task 12: ADR + runbook + CLAUDE.md note** (AC: 1, AC: 2)
  - [ ] **NEW** `docs/adr/0015-named-sections-registry.md` — covers the move from free-text to registry, the 5-value kind enum (mapped to Apostle Paul brand-guide wayfinding categories: `chapel` / `family` / `standard` / `niche` / `columbarium`), the `geometryBoundsBox` reservation for Story 8.1, and the migration's two-deploy pattern.
  - [ ] **UPDATE** `docs/runbook.md` per Task 8.

## Dev Notes

### Previous story intelligence

- **Story 1.1 (auth)** + **Story 1.2 (`requireRole`)** — every mutation in this story uses them.
- **Story 1.4 (StatusPill)** — kind pill colors map onto the existing StatusPill palette (chapel = ivory / family = emerald / standard = stone / niche = forest / columbarium = gold-accent). If the palette doesn't expose all five, leave a follow-up to extend `StatusPill` semantics — do NOT inline new colors.
- **Story 1.5 (route groups)** — `/admin/*` already exists; this story adds `/admin/sections` inside that route group.
- **Story 1.6 (`emitAudit`)** — every mutation emits an audit entry.
- **Story 1.8 (lot CRUD)** — the load-bearing dependency. This story replaces 1.8's free-text `section` field. **Do not start this story unless 1.8 is in review or done.**
- **Story 1.9 (lot geometry)** — `sections.geometryBoundsBox` is the section-level analog. Story 8.1 (GPS import) is where bounds boxes get hydrated for real; this story only persists what the admin enters.
- **Story 1.11 (lot detail)** + **Story 1.13 (offline cache)** — both call sites for `lot.section` are updated to read `lot.sectionId` and join via `sections.list`.
- **Story 7.3 (interment calendar)** — already uses `lots.section` for the calendar's section-filter dropdown ([line 19 of 7-3](./7-3-office-staff-views-the-interment-calendar.md)). Update the dropdown query to use the new registry; the filter then passes `sectionId` instead of a string.

### Architecture compliance

- **Single Convex domain file per FR group**: `convex/sections.ts` is the home for all section CRUD + reads. Matches the architecture's `convex/*.ts` per-aggregate convention.
- **`emitAudit` on every mutation** — non-negotiable per [Architecture § Implementation Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules).
- **Indexes designed first** — `by_name` (unique-by-convention), `by_kind` (admin filter), `by_sortOrder` (registry list ordering). No full-table scans.
- **Server-side `requireRole` on every endpoint** — `list` + `getSection` are readable by all staff roles; write paths are Admin-only.
- **Additive schema change for `lots`** — `sectionId` is added; the legacy `section` string column stays for one deploy cycle (per the migration's two-deploy pattern in AC4). The string column is dropped in a follow-up deploy AFTER prod backfill is verified. This avoids the "schema mismatch breaks prod reads" failure mode.

### Library / framework versions

- No new dependencies. `react-hook-form`, `zod`, the shadcn `<Select>` + `<Sheet>` + `<Table>` primitives are all in the project from earlier Epic 1 stories.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                       # UPDATE (add sections table + indexes; change lots.section → lots.sectionId; rename by_section_block index)
│   ├── sections.ts                                     # NEW
│   ├── lots.ts                                         # UPDATE (validator change; sectionId join; rename listLots arg)
│   └── migrations/
│       └── 0015_backfillSections.ts                    # NEW
├── src/
│   ├── app/(staff)/admin/sections/page.tsx             # NEW
│   ├── components/
│   │   ├── SectionForm/
│   │   │   ├── SectionForm.tsx                         # NEW
│   │   │   ├── schema.ts                               # NEW
│   │   │   └── index.ts                                # NEW
│   │   └── LotForm/
│   │       ├── LotForm.tsx                             # UPDATE (section input → sectionId select)
│   │       └── schema.ts                               # UPDATE
│   └── app/(staff)/lots/                               # UPDATE (call sites render section.displayName)
├── tests/
│   └── unit/
│       ├── convex/
│       │   ├── sections.test.ts                        # NEW
│       │   ├── lots.test.ts                            # UPDATE (seed sections; pass sectionId)
│       │   └── migrations/
│       │       └── 0015_backfillSections.test.ts       # NEW
│       └── components/
│           └── LotForm-section-dropdown.test.tsx       # NEW
└── docs/
    ├── adr/
    │   └── 0015-named-sections-registry.md             # NEW
    └── runbook.md                                      # UPDATE (Named-sections backfill section)
```

### Testing requirements

- Unit coverage: ≥95% on `convex/sections.ts` and the migration. Story 1.8's existing lot tests must continue to pass after the validator + dropdown change.
- Component test: the `LotForm` dropdown happy path + retired-section invisibility.
- Migration test: 5 lots / 3 distinct sections / idempotent re-run.
- E2E: out of scope for this story. A future story may add a Playwright spec that drives the `/admin/sections` page through create → edit → retire.

### Source references

- **PRD:** [FR3 Lot Inventory](../../_bmad-output/planning-artifacts/prd.md#functional-requirements) — sections are part of the canonical lot record.
- **Architecture:** [§ Project Structure > convex/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure); [§ Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture). TODO for the Architect: there is no current architecture anchor specifically for "registry tables vs free-text columns" — leave a follow-up note to add a registry pattern guideline.
- **Brand guide (in-repo):** `apostle-paul-brand-guidelines.html` § Chapter VII (Signage & Environment) — the wayfinding examples ("CHAPEL OF GRACE", "SECTION A · NORTH") are the source of truth for `kind` values + `displayName` formatting conventions.
- **Client decisions:** [Q2 Lot Types and Pricing](../../_bmad-output/planning-artifacts/client-decisions-defaults.md#q2--lot-types-and-pricing-structure) — `kind` here is orthogonal to `lots.type`; the section kind describes the section as a whole, the lot type describes a single lot inside it. A `family` section can contain only `family`-type lots; a `standard` section can contain `single` + `family` lots; the schema does NOT enforce that (admin discipline).
- **Cross-stories:** [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.11](./1-11-office-staff-views-any-lots-detail.md), [Story 1.13](./1-13-field-worker-reads-cached-lot-data-offline.md), [Story 2.9](./2-9-family-estate-multi-lot-grouping.md), [Story 7.3](./7-3-office-staff-views-the-interment-calendar.md).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT drop `lots.section` in the same deploy as the backfill.** Two deploys, not one. Backfill verifies in prod first; the column drop is a separate follow-up. Combining them risks an irrecoverable migration if the backfill silently mis-maps any rows.
- ❌ **Do NOT cascade-delete lots when a section is retired.** Sections retire; the lots stay; the section name still renders. Retirement is a soft state. The admin form's "Retire" button explicitly warns: "Retired sections stay visible everywhere they're referenced."
- ❌ **Do NOT add the `geometryBoundsBox` to the lot create flow.** Bounds-box population is Story 8.1's responsibility once GPS-surveyed lot geometry arrives. The admin form simply persists what's entered; null is the expected Phase 1 state for most sections.
- ❌ **Do NOT introduce a separate `archived` flag.** `isRetired` follows the same pattern as `lots.isRetired` (Story 1.8). One archival semantic across the codebase.
- ❌ **Do NOT enforce that a `family` section contains only `family`-type lots in the schema.** That's admin discipline. Forcing it makes the migration impossible (legacy `lots` won't conform) and removes a valid cemetery layout pattern (mixed-type sections are common in PH).
- ❌ **Do NOT skip the `requireRole(["admin"])` check on `createSection` / `updateSection` / `retireSection` / `restoreSection`**. Free-text-to-registry promotion is a significant lot-data change; only Admins get the keys.
- ❌ **Do NOT inline a `<Combobox>` if the shadcn `<Combobox>` primitive is still absent.** Match Story 7.1's deviation note — fall back to a native `<Select>` for accessibility + 44px min-height parity; do NOT block on the missing primitive.
- ❌ **Do NOT name sections with the `displayName` form.** The canonical `name` is kebab-case (`section-a-north`); the `displayName` is human-readable (`"Section A · North"`). Migration derives `name` from the legacy string via lowercasing + non-alphanumeric → hyphen.

### Common LLM-developer mistakes to prevent

- **Forgetting to update Story 1.8's tests.** The schema change ripples through every test that previously passed `section: "A"`. Run `npm test` after the schema change and fix every red test before moving on.
- **Forgetting to update Story 1.13's offline cache shape.** Field Worker cached lot data includes `lot.section` today; that becomes `lot.sectionId` plus a joined `section.displayName` snapshot. The Phase 1 cache needs the snapshot, not just the FK, because the offline device can't run the join.
- **Letting the dropdown load retired sections in the LotForm.** `useQuery(api.sections.list, { includeRetired: false })`. A retired section showing in the dropdown lets an Office Staff member assign a new lot to it — the system then has a lot in a section that's been retired from wayfinding signage. That's a brand-system regression.
- **Mis-handling the kebab-case derivation for legacy strings like "Section A · North".** The migration should produce `"section-a-north"` (lowercase, `·` → "-", spaces → "-", collapse repeats). Verify with a unit test on the helper function.
- **Forgetting the `sortOrder` × 10 spacing in the migration.** Inserting future sections between existing ones at decimal increments only works if the initial spacing leaves room. `index * 10` (i.e. `10, 20, 30, ...`) is the convention.

### Open questions / blockers this story does NOT resolve

- **Section-level geometry bounds box population** — Story 8.1 (GPS-surveyed geometry import) hydrates real bounds boxes. This story persists what the admin types; that's allowed to be null. Flag for Story 8.1 to pull `sections.geometryBoundsBox` into its import scope.
- **Brand-guide `kind` palette mapping in `StatusPill`** — If the existing `StatusPill` doesn't carry the five kind colors (chapel / family / standard / niche / columbarium), a small follow-up extends it. **Do NOT block this story** waiting for the palette extension; ship with whatever the current palette supports + a TODO comment in the admin page.
- **Family estate vs section relationship** — [Story 2.9](./2-9-family-estate-multi-lot-grouping.md) introduces a `familyEstates` table whose lots all live in a single section. The relationship is `familyEstate.sectionId: v.id("sections")` (optional FK; not enforced here). Coordinate at impl time so 2.9 reads from this registry, not from a free-text echo.

### Project structure notes

Aligns with:

- [Architecture § Project Structure > convex/ + components/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture) — the registry table follows the project's "additive schema; soft-delete via `isRetired`" pattern.

No detected conflicts.

### References

- [PRD § FR3](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Project Structure > convex/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Data Architecture](../../_bmad-output/planning-artifacts/architecture.md#data-architecture)
- [Epics § Story 1.8](../../_bmad-output/planning-artifacts/epics.md#story-18-office-staff-creates-and-edits-lot-records) — the parent story this extends.
- [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [Story 1.11](./1-11-office-staff-views-any-lots-detail.md), [Story 1.13](./1-13-field-worker-reads-cached-lot-data-offline.md), [Story 2.9](./2-9-family-estate-multi-lot-grouping.md), [Story 7.3](./7-3-office-staff-views-the-interment-calendar.md).
- Brand guide (in-repo): `apostle-paul-brand-guidelines.html` § Chapter VII (Signage & Environment), § Chapter IX (Voice & Tone — `kind` `displayName` copy follows the "Reverent / Restrained" voice pillars).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code SDK — 2026-05-24.

### Debug Log References

- Vitest run (focused): `npx vitest run tests/unit/convex/sections.test.ts tests/unit/convex/backfillLotSections.test.ts src/components/LotForm/` → 101 tests pass (35 sections + 11 backfill + 5 dropdown + 5 pre-existing LotForm + 45 pre-existing lots).
- Vitest run (full suite): 2607 tests pass / 32 skipped; only the pre-existing `tests/unit/sw/sw.test.ts` DNS-rejection unhandled-rejection, unrelated to this story.
- `npx tsc --noEmit`: zero errors in `convex/sections.ts`, `convex/internal/backfillLotSections.ts`, `convex/lots.ts`, `convex/schema.ts`, `src/components/SectionForm/**`, `src/components/LotForm/**`, `src/app/(staff)/admin/sections/**`, `src/app/(staff)/lots/**`. Pre-existing errors in `convex/arAging.ts`, `convex/ceremonies.ts`, `convex/interments.ts`, `src/components/PlaqueForm/schema.ts` are owned by parallel stories.
- `npm run lint`: zero errors in this story's files; pre-existing errors in `convex/actions/generateContractPdf.ts`, `convex/actions/generateDemandLetterPdf.ts`, `convex/actions/sendEmailReminders.ts`, `convex/ceremonies.ts`, `src/app/(staff)/interments/[intermentId]/plaque/page.tsx` are owned by parallel stories.
- `npm run build`: Next.js compiles successfully (22.7s) and the new `/admin/sections` route registers; the post-compile lint step fails on the unrelated unused-`useMemo` warning in `interments/[intermentId]/plaque/page.tsx` (Story 6.8 owns that file).

### Completion Notes List

Scope deviations from the original AC narrative — the task brief (which the dev agent received from the parent) chose a NARROWER additive path than the original story spec for AC3 + AC4 (intentional, safer for the parallel-agent shared-file environment):

1. **AC3 — additive `sectionId`, NOT a string→FK rename.** The original spec called for replacing `lots.section: v.string()` with `lots.sectionId: v.id("sections")` and renaming the `by_section_block` index. The shipped implementation ADDS `sectionId` as an OPTIONAL FK alongside the existing free-text `section` string (additive schema change). The LotForm writes BOTH fields atomically when the user picks a section (the dropdown's `displayName` populates the legacy `section` column). The `by_section_block` index is preserved as-is; a new `by_sectionId` index was added for the section→lots count lookup. This keeps Story 1.8's existing tests + every read path that touches `lot.section` working unchanged. The follow-up that DROPS the legacy `section` column is deferred per the disaster-prevention "two deploys, not one" pattern.

2. **AC4 — `convex/internal/backfillLotSections.ts` instead of `convex/migrations/0015_backfillSections.ts`.** The task brief asked for the file at `convex/internal/backfillLotSections.ts` (the repo's existing `convex/internal/` convention from `bootstrapFirstAdmin.ts`) rather than a `migrations/` directory that does not exist yet. The mutation is `internal` (CLI-invocable only) and idempotent on re-run — same semantics as AC4 requires.

3. **Audit `entityType: "lot"` for section CRUD.** The `auditLog.entityType` union does not carry a dedicated `"section"` value; extending the enum would couple this story to the audit cornerstone owners. The `entityType: "lot"` + `before/after.kind === "section"` discriminator follows the exact pattern `convex/expenseCategories.ts` uses for `entityType: "expense"` with a `kind: "expenseCategory"` discriminator. Adding a `"section"` literal to `auditLog.entityType` is a small follow-up coordinated with the audit cornerstone owners.

4. **`retireSection` / `restoreSection` collapsed into `updateSection` with `patch.isRetired`.** The admin page surfaces "Retire" / "Restore" actions that call `updateSection({ patch: { isRetired: true|false } })`. The mutation detects the retire-only patch and emits `deactivate` / `reactivate` audit actions accordingly. Same operational semantics, one mutation surface to test.

5. **ADR + runbook + LotForm sectionDocument snapshot for the offline cache deferred.** Tasks 8 and 12 (ADR-0015 + docs/runbook.md updates) and the Story 1.13 offline cache `displayName` snapshot are deferred to follow-on stories that own `docs/**` and `convex/lib/offlineCache.ts`. The Phase 1 cache today reads `lot.section: string` directly, which the additive schema preserves — no breakage.

6. **Story 7.3 interment calendar's section filter wiring is deferred.** Story 7.3 owns `convex/interments.ts` + `src/app/(staff)/interments/calendar/page.tsx`; that file is in scope for a different parallel story. The new `listActiveSections` query is ready for 7.3 to consume once its agent re-wires the dropdown.

Everything else (sections table + indexes, admin CRUD UI, lot-form dropdown, backfill mutation, kebab-case derivation, the linked-lots deletion guard, the retired-section dropdown filter, and all the role/auth gating tests) shipped as specified.

### File List

NEW:
- `convex/sections.ts` — domain CRUD + reads (createSection, updateSection, deleteSection, listSections, listActiveSections, getSection)
- `convex/internal/backfillLotSections.ts` — one-shot idempotent backfill (`run` internalMutation + `deriveKebabName` helper)
- `src/components/SectionForm/SectionForm.tsx` — admin form for create + edit
- `src/components/SectionForm/schema.ts` — Zod schema mirroring server validators
- `src/components/SectionForm/index.ts` — barrel exports
- `src/app/(staff)/admin/sections/page.tsx` — admin CRUD UI mirroring `/admin/expense-categories`
- `tests/unit/convex/sections.test.ts` — 35 cases covering auth + CRUD + uniqueness + deletion-with-linked-lots + retired-filter
- `tests/unit/convex/backfillLotSections.test.ts` — 11 cases covering happy path / idempotency / kebab derivation / empty-value skipping / reuse-by-name
- `src/components/LotForm/LotForm-section-dropdown.test.tsx` — 5 cases covering dropdown options / submit payload / empty-registry hint / loading placeholder / required-field gating

UPDATED:
- `convex/schema.ts` — additive `sections` table (with `by_name` / `by_kind` / `by_sortOrder` indexes) + optional `sectionId` field on `lots` + new `by_sectionId` index on `lots`. NO other tables touched.
- `convex/lots.ts` — `createLot` + `updateLot` accept optional `sectionId` arg with section-exists + non-retired validation. Audit emissions include `sectionId`. `getLot` / `retireLot` / `setLotStatusReserved` UNTOUCHED (CRIT-G + other-story ownership respected).
- `src/components/LotForm/LotForm.tsx` — replaced free-text `section` input with `<select>` wired to `useQuery(listActiveSections)`. Submit composes `sectionId` + the section's `displayName` for the back-compat `section` column. Empty-registry helper note + loading placeholder + disabled state.
- `src/components/LotForm/schema.ts` — added required `sectionId` field; `section` becomes optional (derived at submit).
- `src/components/LotForm/LotForm.test.tsx` — adjusted existing tests to select section dropdown + supplied `sectionId` in edit-mode defaults.
- `src/app/(staff)/lots/new/page.tsx` — `createLot` function-reference type widened to carry optional `sectionId`.
- `src/app/(staff)/lots/[lotId]/edit/page.tsx` — `LotDoc` interface + `updateLot` function-reference type widened; `defaultValues` forwards `sectionId`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — added `1-15-named-sections-registry: review`.
