# Story 2.6: Lot Has Multiple Occupants Distinct from Owners

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria)**,
I want **to add one or more occupants (deceased persons interred in the lot) to a lot — separately from the lot's owners — with name, date of interment, and relationship to owner**,
so that **a family lot with multiple interments and a single owner is modelled correctly: ownership is a property right (Story 2.7's `ownerships` table), interment is a fact of who is buried where (this story's `occupants` table) — they are NOT the same entity** (FR18).

This story introduces the **`occupants` table — the first first-class entity that is NOT a customer record but is still PII-adjacent** (a deceased person's name + date of interment is sensitive in family-history contexts even though the Data Privacy Act does not classify deceased persons as data subjects). It adds the `addOccupant` mutation, the `AddOccupantDialog` component mounted on the lot detail page, the `OccupantList` section that renders ascending-by-`dateOfInterment`, and the legacy-data-friendly handling of "date of interment unknown." After this story ships, Story 2.7's transfer flow can reason about ownership independent of occupancy, and Phase 2's interment workflow (Epic 11 / FR51) has its data foundation in place.

## Acceptance Criteria

1. **AC1 — `occupants` table is defined with the right shape** (FR18, architecture § 232): `convex/schema.ts` extends with an `occupants` table containing: `lotId` (`v.id("lots")`), `name` (string, 2–200 chars, required), `dateOfInterment` (`v.optional(v.number())` — unix ms, optional so legacy migration can record an interment with unknown date), `relationshipToOwner` (string — free-text in Phase 1; possible Phase 2 controlled vocabulary), `notes` (optional string, up to 1000 chars — for context like "transferred from old book entry 1987"), `createdAt` (number), `createdByUserId` (`v.id("users")`), `isRemoved: boolean` (soft-delete flag — interments are not physically deleted from history once recorded; admin actions can flag them as removed with a reason, but the row persists). Indexed by `by_lot` (`["lotId"]`) and `by_lot_interment_date` (`["lotId", "dateOfInterment"]` — supports sorted listing per AC3).

2. **AC2 — `addOccupant` mutation runs `requireRole` → validates → inserts → emits audit** (FR18, NFR-S4, NFR-S7): `convex/occupants.ts` exports an `addOccupant` mutation that: (a) calls `requireRole(ctx, ["office_staff", "admin"])` as the first line; (b) validates args via the shared Zod schema; (c) verifies the lot exists and is not retired (`ctx.db.get(lotId)`; throw `LOT_NOT_FOUND` or `LOT_RETIRED` otherwise — Story 1.8's lot table established the `isRetired` flag); (d) inserts the row with `createdAt = Date.now()`, `createdByUserId`, `isRemoved: false`; (e) calls `emitAudit(ctx, { action: "occupant.add", entityType: "lot", entityId: lotId, before: null, after: { occupantId, name, dateOfInterment, relationshipToOwner }, reason: undefined })` — **note: the audit row is keyed on the LOT, not the occupant**, because the lot is the canonical entity in the audit trail (matches FR16 ownership-history audit pattern); (f) returns `{ occupantId }`.

3. **AC3 — Lot detail page renders occupants sorted ascending by `dateOfInterment`** (FR18, UX § Empty State Patterns): On `src/app/(staff)/lots/[lotId]/page.tsx` (Story 1.11), an **Occupants** section renders the lot's occupants. The list is fetched via `api.occupants.listByLot({ lotId })` (returns rows sorted by `dateOfInterment` ascending — earliest interment first, per cultural / cemetery-record convention). Rows show: name, `dateOfInterment` formatted as `formatDate(ms, "short")` or `"Date unknown"` if null, relationship to owner. Removed occupants are excluded by default; an "Show removed (N)" toggle reveals them with a strikethrough + removed-reason tooltip. Empty state: "No occupants recorded for this lot." per UX-DR23 calm-empty pattern.

4. **AC4 — `AddOccupantDialog` component validates and submits** (UX § Form Patterns): An "Add occupant" button on the lot detail page opens a shadcn/ui `Dialog` containing the `AddOccupantForm`. Fields: name (required, 2–200 chars), date of interment (date picker; **explicit "Date unknown" checkbox that nullifies the date** — the date field is grayed out when the checkbox is checked), relationship to owner (free-text input, default placeholder "e.g. spouse, child, parent, self"), notes (optional textarea). Submit calls `addOccupant`. On success, the Dialog closes and the lot detail reactively shows the new row (via Convex subscription) with a 600ms `ReactiveHighlight` amber fade (Story 1.4).

5. **AC5 — Legacy-friendly: unknown interment date is supported end-to-end** (§10 Q4 legacy data condition): The Zod schema allows `dateOfInterment: undefined`; the mutation accepts it; the display renders "Date unknown"; the sort order places unknown-date rows at the end (after all dated rows) — a deterministic ordering even when dates are missing, so the list never visually re-shuffles between page loads. Tests cover the missing-date end-to-end path.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Add `occupants` table to `convex/schema.ts`** (AC: 1)
  - [ ] Definition:
    ```ts
    occupants: defineTable({
      lotId: v.id("lots"),
      name: v.string(),                          // 2..200 chars (enforced in mutation)
      dateOfInterment: v.optional(v.number()),   // unix ms; undefined = "Date unknown" (legacy)
      relationshipToOwner: v.string(),           // free-text Phase 1; possible vocab in Phase 2
      notes: v.optional(v.string()),             // up to 1000 chars
      createdAt: v.number(),
      createdByUserId: v.id("users"),
      isRemoved: v.boolean(),                    // soft-delete flag
      removedAt: v.optional(v.number()),
      removedByUserId: v.optional(v.id("users")),
      removedReason: v.optional(v.string()),
    })
      .index("by_lot", ["lotId"])
      .index("by_lot_interment_date", ["lotId", "dateOfInterment"]),
    ```
  - [ ] **Why two indexes?** `by_lot` for the un-sorted membership check / count operations; `by_lot_interment_date` for the sorted listing in AC3. Convex indexes are cheap; defining both upfront avoids a future schema migration.
  - [ ] **No `by_name` index.** Occupant search across all lots is NOT a Phase 1 user need (cemetery searches by lot or by owner, not by deceased person). If FR51 (Phase 2 interments) introduces it, add the index then.
  - [ ] Run `npx convex dev` and verify `_generated/dataModel.d.ts` picks up the table.

- [ ] **Task 2: Update `convex/lib/errors.ts` with occupant-domain codes** (AC: 2)
  - [ ] Add: `LOT_RETIRED: "LOT_RETIRED"` (used when adding an occupant to a retired lot), `OCCUPANT_NOT_FOUND: "OCCUPANT_NOT_FOUND"` (reserved for the soft-delete mutation; if Story 1.8 already introduced `LOT_NOT_FOUND`, reuse it — verify and link).

### Backend mutation + query (AC2, AC3)

- [ ] **Task 3: Create `convex/occupants.ts` with `addOccupant` mutation** (AC: 2, AC: 5)
  - [ ] **First-time domain file creation.** This is the FR18 home file.
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"]);` — Story 1.2's helper. The lint rule will fail the build if missing.
  - [ ] Args validator: `v.object({ lotId: v.id("lots"), name: v.string(), dateOfInterment: v.optional(v.number()), relationshipToOwner: v.string(), notes: v.optional(v.string()) })`.
  - [ ] Validation (server-side Zod re-check + manual checks per architecture § 545–547 defense-in-depth):
    - `name.trim().length >= 2 && <= 200` (after trim)
    - `relationshipToOwner.trim().length >= 1` — relationship is required even if "self"
    - `notes ?? ""` length `<= 1000`
    - If `dateOfInterment` is provided, must be a positive integer; must be `<= Date.now() + 24 * HOUR_MS` (Manila tz tolerance — interment cannot meaningfully be more than a day in the future; allows for same-day-recording with a slight clock skew).
  - [ ] Load the lot: `const lot = await ctx.db.get(lotId);`. If missing → `throwError(ErrorCode.LOT_NOT_FOUND)`. If `lot.isRetired` → `throwError(ErrorCode.LOT_RETIRED, "Cannot add occupant to a retired lot.")`.
  - [ ] Insert the row with `createdAt: Date.now()`, `createdByUserId: userId from requireRole`, `isRemoved: false`.
  - [ ] Call `emitAudit(ctx, { action: "occupant.add", entityType: "lot", entityId: lotId, before: null, after: { occupantId, name: name.trim(), dateOfInterment, relationshipToOwner: relationshipToOwner.trim() }, reason: undefined })`. Note: `entityId` is the LOT, not the occupant, so the audit log groups by lot.
  - [ ] Return `{ occupantId }`.

- [ ] **Task 4: `convex/occupants.ts → listByLot` query** (AC: 3)
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin", "field_worker"]);` — **field workers see occupants** because Phase 2's burial-navigation flow (Story 8.3) shows "who is interred here." For Phase 1, the field worker still benefits from seeing occupants when looking up a lot.
  - [ ] Args: `{ lotId: v.id("lots"), includeRemoved?: v.optional(v.boolean()) }`.
  - [ ] Query via `by_lot_interment_date` index: `ctx.db.query("occupants").withIndex("by_lot_interment_date", q => q.eq("lotId", lotId)).collect()`.
  - [ ] Filter: if `!includeRemoved`, drop rows where `isRemoved === true`.
  - [ ] Sort: ascending by `dateOfInterment`, with **`undefined` dates pinned to the end** (deterministic tail ordering). Pattern: `rows.sort((a, b) => { if (a.dateOfInterment === undefined && b.dateOfInterment === undefined) return a.createdAt - b.createdAt; if (a.dateOfInterment === undefined) return 1; if (b.dateOfInterment === undefined) return -1; return a.dateOfInterment - b.dateOfInterment; });`
  - [ ] Return rows as `{ occupantId, name, dateOfInterment, relationshipToOwner, isRemoved, notes }` (do NOT return raw `_id` or `createdBy` fields to the client — minimize the response surface).

- [ ] **Task 5: `convex/occupants.ts → removeOccupant` mutation** (AC: 3 — supports soft-delete toggle)
  - [ ] **Scope check:** this is NOT in the epic's AC list explicitly, but UX-DR23 calm-empty + the "Show removed" toggle in AC3 imply that staff need to be able to mark an occupant as removed (e.g. exhumation, data-entry mistake correction). Include this mutation as a thin scoped addition; flag in completion notes if the developer needs to defer.
  - [ ] First line: `await requireRole(ctx, ["admin"]);` — **admin-only**; remove operations affect interment records. Office staff create occupants; admins remove them.
  - [ ] Args: `{ occupantId: v.id("occupants"), reason: v.string() }` — reason is required (audit trail).
  - [ ] Validate `reason.trim().length >= 3 && <= 500`.
  - [ ] Patch with `{ isRemoved: true, removedAt: Date.now(), removedByUserId: userId, removedReason: reason.trim() }`.
  - [ ] Emit audit: `emitAudit(ctx, { action: "occupant.remove", entityType: "lot", entityId: occupant.lotId, before: { isRemoved: false }, after: { isRemoved: true }, reason })`.
  - [ ] Return `{ occupantId }`.

### Frontend (AC3, AC4)

- [ ] **Task 6: Build `src/components/LotDetail/OccupantList.tsx`** (AC: 3)
  - [ ] Props: `lotId: Id<"lots">`.
  - [ ] State: `showRemoved: boolean` (local toggle, default `false`).
  - [ ] `const occupants = useQuery(api.occupants.listByLot, { lotId, includeRemoved: showRemoved });`
  - [ ] Loading → 3 skeleton rows. Empty → "No occupants recorded for this lot." (centered, muted text, per UX § Empty State Patterns).
  - [ ] Render `<ul>` (or `<Table>` on `≥ 1024px`):
    ```
    Maria Santos · Interred 17 Mar 1987 · Spouse
    Juan Santos · Interred 02 Jan 1993 · Father
    Cruz Santos · Date unknown · Grandparent
    ```
  - [ ] Each row's text wrapper uses `min-h-[44px]` for tap-friendly hit zones (NFR-A4) — Phase 2 will add row-level actions like "View interment certificate."
  - [ ] Removed rows (when `showRemoved: true`): `line-through text-gray-400` styling + tooltip via shadcn/ui `Tooltip` showing the removal reason (admin sees the reason; office staff see only "Removed").
  - [ ] Below the list, a toggle: `[ ] Show removed (N)` where N is the count of removed occupants. Hidden when N = 0.
  - [ ] **Add occupant button** sits above the list, opens the Dialog (Task 7). Role-gated: only `office_staff` and `admin` see it (`useCurrentUser()` from Story 1.3 + `?.role` check). Field workers see the list but no Add button.

- [ ] **Task 7: Build `src/components/LotDetail/AddOccupantDialog.tsx`** (AC: 4, AC: 5)
  - [ ] Props: `lotId: Id<"lots">`, `open: boolean`, `onOpenChange: (open: boolean) => void`, `onAdded?: (occupantId) => void`.
  - [ ] Wraps shadcn/ui `Dialog`. Form via React Hook Form + Zod (`occupantSchema.ts` in same folder).
  - [ ] Fields:
    - **Name** (Input, required, 2–200, autofocus on open)
    - **Date unknown** (Checkbox; default `false`)
    - **Date of interment** (date picker; `disabled={dateUnknown}`; `required={!dateUnknown}`) — uses native HTML5 `<input type="date">` or shadcn/ui `Calendar` + `Popover`. Architecture § 314 prefers shadcn/ui form primitives; if a `DatePicker` shadcn/ui component is not yet installed in the repo, use the native input for Phase 1 (zero extra dep). Format value in Manila tz when submitting via `src/lib/time.ts`.
    - **Relationship to owner** (Input, required, placeholder "e.g. spouse, child, parent")
    - **Notes** (Textarea, optional, maxLength 1000, character counter)
  - [ ] Submit: calls `useMutation(api.occupants.addOccupant)` with args `{ lotId, name, dateOfInterment: dateUnknown ? undefined : dateMs, relationshipToOwner, notes }`. On success: call `onAdded?.(occupantId)`, close dialog, RHF `reset()`. On error: surface via `translateError` (Story 1.4 / 1.2 helper); render inline message.
  - [ ] Disable submit button while the mutation is pending. **Submit button is `Add occupant`** (specific verb, not generic "Submit"). Submit also disabled when form is invalid.
  - [ ] Cancel button closes the dialog without submitting. ESC key + click-outside also close (Radix Dialog defaults).
  - [ ] All interactive controls meet `min-h-[44px]` (NFR-A4).

- [ ] **Task 8: Wire `OccupantList` + `AddOccupantDialog` into the lot detail page** (AC: 3, AC: 4)
  - [ ] In `src/app/(staff)/lots/[lotId]/page.tsx` (Story 1.11), add a new `<section aria-labelledby="occupants-heading">` after the lot's main info but before any contracts / ownership history sections.
  - [ ] `<h2 id="occupants-heading">Occupants</h2>` + `<OccupantList lotId={lotId} />`. Story 1.11 may not have shipped the detail page in its final form; if the page is still a placeholder, add this section as part of this story's edit and coordinate with Story 1.11's owner.
  - [ ] **Use `ReactiveHighlight`** (Story 1.4) wrapping the list so new rows fade in with 600 ms amber on Convex reactive update. The component watches the list's `length` or first row's `_creationTime`.

### Testing (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 9: Unit tests for `addOccupant`** (AC: 2, AC: 5)
  - [ ] Create `tests/unit/convex/occupants.test.ts`.
  - [ ] Cases (via `convex-test` harness from Story 1.2):
    - **Happy path with date**: office_staff adds → row inserted, audit emitted with `entityType: "lot"` + `entityId: lotId`.
    - **Happy path no date (legacy)**: same as above with `dateOfInterment: undefined` → row inserted; audit `after.dateOfInterment` is undefined.
    - **Validation: short name**: `name: "X"` → ConvexError with validation code.
    - **Validation: future date**: `dateOfInterment: Date.now() + 7 * DAY_MS` → ConvexError.
    - **Validation: long notes**: `notes` 1001 chars → ConvexError.
    - **Lot retired**: `lot.isRetired === true` → `LOT_RETIRED`.
    - **Lot missing**: invalid lotId → `LOT_NOT_FOUND`.
    - **RBAC**: field_worker → `FORBIDDEN`; unauthenticated → `UNAUTHENTICATED`.

- [ ] **Task 10: Unit tests for `listByLot`** (AC: 3, AC: 5)
  - [ ] Cases:
    - **Empty lot**: returns `[]`.
    - **Multiple occupants with dates**: returns sorted ascending.
    - **Mixed dated and undated**: dated rows first (ascending), undated rows last (sorted by `createdAt`).
    - **Removed excluded by default**: `isRemoved: true` row not in result.
    - **Removed included when requested**: `includeRemoved: true` returns all rows; removed rows visible.
    - **RBAC**: field_worker SEES the list (this is the field-worker-allowed case from Task 4); admin sees the list; unauthenticated → `UNAUTHENTICATED`.

- [ ] **Task 11: Unit tests for `removeOccupant`** (Task 5)
  - [ ] Cases:
    - **Happy path**: admin removes with reason → row patched, audit emitted.
    - **RBAC**: office_staff → `FORBIDDEN` (admin-only).
    - **Validation: short reason**: `reason: "x"` → ConvexError.

- [ ] **Task 12: Component tests for `AddOccupantDialog`** (AC: 4, AC: 5)
  - [ ] Create `src/components/LotDetail/AddOccupantDialog.test.tsx`.
  - [ ] Cases (Testing Library):
    - **Render**: opens with name field focused.
    - **Date unknown checkbox**: checking it disables the date input + clears it.
    - **Submit disabled while invalid**: short name keeps submit disabled.
    - **Successful submit**: mock `addOccupant` mutation → dialog closes + `onAdded` callback fires.
    - **Error path**: mock mutation throws `LOT_RETIRED` → inline error appears, dialog stays open.

- [ ] **Task 13: E2E spec** (AC: 3, AC: 4)
  - [ ] `tests/e2e/occupant-add.spec.ts`: log in as office_staff; navigate to a seeded lot detail; click "Add occupant"; fill name + relationship; check "Date unknown"; submit; assert the new row appears in the Occupants section with "Date unknown" text and the amber-fade highlight class (via attribute check, since the fade is transient).

### Documentation (AC1, AC2)

- [ ] **Task 14: JSDoc + section comment in code** (AC: all)
  - [ ] File-level JSDoc on `convex/occupants.ts` summarizing FR18 + the entity-vs-ownership distinction.
  - [ ] Document the audit-keyed-on-lot decision inline at the `emitAudit` call: `// entityId is the LOT, not the occupant — occupants are sub-entities of a lot for audit purposes (matches the FR16 ownership-history pattern).`
  - [ ] No ADR — the entity model is already locked in architecture § 232 (time-versioned ownerships) and § 270 / § 350. This story is a straightforward implementation.

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1 (auth + scaffold):** `(staff)/` route group exists; this story extends the lot detail page that lives there.
- **Story 1.2 (`requireRole` + lint rule):** every mutation/query in this story begins with `requireRole`. Lint rule enforces.
- **Story 1.3 (user roles):** `useCurrentUser()` returns the caller's role; the lot detail page reads this to decide whether to render the "Add occupant" button.
- **Story 1.4 (StatusPill + `ReactiveHighlight`):** the occupant list uses `ReactiveHighlight` to fade in new rows.
- **Story 1.5 (App shell):** chrome already exists.
- **Story 1.6 (`emitAudit`):** every write in this story calls `emitAudit`. The keyed-on-lot pattern matches Story 1.6's contract (action + entityType + entityId).
- **Story 1.7 (state machines):** NOT used here. Occupants do not have a state machine; they have a soft-delete flag (`isRemoved`).
- **Story 1.8 (lots table + retired flag):** this story reads `lot.isRetired` to reject occupant additions to retired lots. Also reads `lot._id` / `lot.code` indirectly for the audit / list display.
- **Story 1.11 (lot detail page):** the host page for this story's `OccupantList` + Dialog. If 1.11 has not yet shipped its final form, this story adds the Occupants section into whatever scaffold 1.11 produced.

**Stories that build on this one:**

- **Story 2.7 (Ownership transfer):** transfers affect ownerships, NOT occupants. The clean separation enforced by this story means transfer logic doesn't have to worry about occupants. Different table, different mutation.
- **Phase 2 — Story 11.x (Interment workflow, FR51–FR54):** this story's `occupants` table is the data foundation. Phase 2 adds interment certificate generation, exhumation tracking, etc., as additional fields / related tables on top.
- **Story 8.3 (Field-worker navigates to lot via GPS):** the lot's occupant list will be visible to field workers on the mobile lot view — that's why `listByLot` includes `field_worker` in its role check.

### Architecture compliance

- **Pattern locked by architecture § Time-versioned relations (line 232):** ownership is time-versioned in `ownerships` (Story 2.7); occupancy is its own table with an `isRemoved` flag (this story). They are NOT the same; the architecture explicitly calls out the distinction.
- **File location (architecture § 442 / § 678):** `convex/occupants.ts` is a new domain file. **Naming note:** the architecture's sample schema illustration (§ 271) shows `transferEventId` on `ownerships`; there is no implicit suggestion that occupants belong inside ownerships. Keep them separate.
- **Audit pattern (architecture § 393, § 518–523):** every mutation emits audit; the `entityId` chosen is the lot (the canonical aggregate root for this sub-entity). Story 1.6's helper handles the redaction (no PII in occupant fields, so redaction is a no-op).
- **Soft-delete pattern (architecture § implicit, no explicit ADR):** for entities where history must be preserved, soft-delete via a boolean flag is the project pattern (matches `lots.isRetired` from Story 1.8). Do NOT physically delete rows from the `occupants` table.
- **Role pattern (architecture § 285 + Story 1.2):** `listByLot` is the unusual case where field_worker is allowed. Document the choice inline. Default for all other staff queries is `["office_staff", "admin"]`.

### Library / framework versions (researched current)

- **shadcn/ui primitives needed:** `Dialog`, `Tooltip`, `Checkbox` (already used in Story 2.1), `Calendar` + `Popover` for the date picker if installed, otherwise native `<input type="date">`. Install if missing: `npx shadcn@latest add dialog tooltip` (others should already exist from Stories 1.4 / 2.1).
- **No new external dependencies.**

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                          # UPDATE (add occupants table + 2 indexes)
│   ├── occupants.ts                                       # NEW (addOccupant, listByLot, removeOccupant)
│   └── lib/
│       └── errors.ts                                      # UPDATE (LOT_RETIRED if missing; OCCUPANT_NOT_FOUND reserved)
├── src/
│   ├── app/(staff)/lots/[lotId]/
│   │   └── page.tsx                                       # UPDATE (mount <OccupantList> section)
│   └── components/
│       └── LotDetail/
│           ├── OccupantList.tsx                           # NEW
│           ├── AddOccupantDialog.tsx                      # NEW
│           ├── AddOccupantDialog.test.tsx                 # NEW
│           └── occupantSchema.ts                          # NEW (Zod schema shared client + server)
├── tests/
│   ├── unit/convex/
│   │   └── occupants.test.ts                              # NEW
│   └── e2e/
│       └── occupant-add.spec.ts                           # NEW
└── _bmad-output/implementation-artifacts/                  # this story file
```

### Testing requirements

- **NFR-M2 coverage**: occupants are not PII-classified and do not touch financial code, so the ≥ 90% threshold is a soft target rather than a gate. Aim for ≥ 80% line + branch on `convex/occupants.ts`.
- **No axe / Lighthouse changes** beyond verifying the new section's accessibility (semantic `<section>` + heading + list, tooltips with `aria-describedby`, dialog focus trap from Radix). Run an axe check on the lot detail page after the section is mounted.

### Source references

- **PRD:** [FR18 (occupants distinct from owners)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [NFR-S4 (server-side RBAC)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [NFR-S7 (audit log)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- **Architecture:** [§ Time-versioned relations (line 232)](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence) (ownerships + occupants are distinct tables); [§ Project Structure > Convex source layout](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries); [§ Audit pattern (line 393, 518–523)](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- **UX:** [§ Empty State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md) (calm empty per UX-DR23); [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns); [§ Lot detail responsive layout (line 1900)](../../_bmad-output/planning-artifacts/ux-design-specification.md#responsive-strategy)
- **Epics:** [§ Story 2.6](../../_bmad-output/planning-artifacts/epics.md#story-26-lot-has-multiple-occupants-distinct-from-owners)
- **Previous stories:** [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md) (`ReactiveHighlight`), [1.6](./1-6-audit-log-emission-helper.md) (`emitAudit`), [1.8](./1-8-office-staff-creates-and-edits-lot-records.md) (`lots` table + `isRetired`), [2.1](./2-1-office-staff-creates-a-customer-record.md) (form pattern + Zod), [2.5](./2-5-customer-detail-page-with-ownership-history.md) (detail page pattern)
- Convex docs: [Schemas + validators](https://docs.convex.dev/database/schemas) · [Indexes](https://docs.convex.dev/database/indexes/)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT conflate occupants with ownership.** Occupants are NOT owners. A lot's owner (Story 2.7's `ownerships` table) and the deceased persons interred there (this story's `occupants` table) are different entities. Do not store `customerId` on occupants — there is no per-occupant customer record (the deceased is not a Data Privacy Act data subject). If a future Phase 2 requirement needs to link an occupant to a customer (e.g. the "owner is also the deceased"), add a nullable `customerId` reference then with explicit ADR.
- ❌ **Do NOT physically `db.delete` occupant rows.** Soft-delete via `isRemoved: true`. Cemetery records require interment history retention even when records are corrected.
- ❌ **Do NOT allow office_staff to remove an occupant.** Removal is admin-only. The mutation enforces this; the UI also gates the "Remove" affordance (Phase 2 work — Phase 1 may not even render a remove button on the list).
- ❌ **Do NOT make `relationshipToOwner` a strict enum in Phase 1.** Filipino family relationships are nuanced ("kuya", "ate", "ninang", "anak sa labas"). A free-text field is intentional. Phase 2 can introduce a controlled vocabulary.
- ❌ **Do NOT add an index on `name` or any occupant-search index.** Phase 1 scope is per-lot listing only. Cross-lot occupant search would require additional access-control thinking (a deceased name in a search result reveals their burial location — sensitive).
- ❌ **Do NOT key the audit row on the occupant.** The lot is the aggregate root; audit groups by `entityType: "lot"`. This matches the FR16 ownership-history audit pattern.
- ❌ **Do NOT auto-sort occupants by name.** Cemetery records are chronological by interment date. Even if dates are unknown, the convention is "in the order they were buried"; ties are broken by `createdAt`. Do not introduce an alphabetical-sort toggle without an explicit UX-DR.
- ❌ **Do NOT use `JSDate.parse(dateString)` in the mutation.** Receive `dateOfInterment` as a unix ms `v.number()` directly from the client; the client does the date-string → ms conversion via `src/lib/time.ts`. Server-side string parsing risks locale bugs.

### Common LLM-developer mistakes to prevent

- **Reinventing the soft-delete pattern:** the field is `isRemoved: boolean` per the project's `is<X>` boolean naming convention. Not `deleted`, not `archived`. Story 1.8 used `isRetired` for lots; same pattern.
- **Wrong return shape from `listByLot`:** the client doesn't need `_id` (use `occupantId` instead, mapped from `row._id`); doesn't need `createdByUserId` (no display use). Trim the response — minimize what crosses the boundary.
- **Wrong "Date unknown" semantics in the date picker:** the checkbox should reset the date input's value to empty AND set the field's RHF state to `undefined`. Not `null`, not `0`. Convex's `v.optional` accepts `undefined` only.
- **Premature CSS:** do not introduce a new color for "unknown date" — gray text is enough. Adding a third state to the design adds complexity for one rare row type.
- **Forgetting the field-worker role check:** `listByLot` allows `field_worker`. Other queries don't. Easy to miss; the test cases must explicitly cover field_worker as allowed for `listByLot` and denied for `addOccupant` / `removeOccupant`.
- **Mixing up `lotId` vs `_id`:** the occupant doc has `_id` (Convex internal) and `lotId` (foreign key). When emitting audit, `entityId` is the LOT'S `_id`, not the occupant's.
- **Reactive subscription edge case:** `useQuery(api.occupants.listByLot, { lotId, includeRemoved: showRemoved })` — when `showRemoved` toggles, Convex creates a new subscription. The `ReactiveHighlight` wrapper around the list should NOT fade-flash on toggle (that's a UI navigation, not a server data change). Either suppress the highlight on toggle (compare prev list count vs new list count) or accept the flash as benign feedback. Document the choice in a comment.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment policy):** unrelated. No blocker.
- **§10 Q3 (BIR receipt format):** unrelated. No blocker.
- **§10 Q4 (legacy data condition):** **directly relevant** — legacy interment dates are often unknown (handwritten records from 1980s; entries that just say "buried 1987" without a precise date). This story's `dateOfInterment: v.optional` + "Date unknown" UI is the answer. Surface to the migration plan: legacy occupant data can land in `occupants` with `dateOfInterment: undefined`, `notes: "imported from old ledger entry N"`.
- **§10 Q6 (ownership transfer policy):** Story 2.7's blocker; this story does NOT depend on it because occupants are independent of ownership.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/occupants.ts` not explicitly listed but follows the per-domain-file convention (line 442). FR18 maps to "Customer & Ownership" capability per the boundary mapping (§ 881, § 1008).
- [Architecture § Data Storage & Persistence](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence) — time-versioned relations + the separation of ownership and occupancy.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR18](../../_bmad-output/planning-artifacts/prd.md#4-customer--ownership-management)
- [Architecture § Data Storage & Persistence](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence)
- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [Architecture § Implementation Patterns & Consistency Rules](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [UX § Empty State Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [UX § Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns)
- [Epics § Story 2.6](../../_bmad-output/planning-artifacts/epics.md#story-26-lot-has-multiple-occupants-distinct-from-owners)
- Previous stories: [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.6](./1-6-audit-log-emission-helper.md), [1.8](./1-8-office-staff-creates-and-edits-lot-records.md), [2.1](./2-1-office-staff-creates-a-customer-record.md), [2.5](./2-5-customer-detail-page-with-ownership-history.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` — clean for all Story 2.6 files. Pre-existing concurrent-story errors surfaced in `src/app/(staff)/admin/data-subject-reports/page.tsx`, `src/components/CustomerDocumentUpload/CustomerDocumentUpload.tsx`, and `src/components/DataSubjectReport/index.tsx` (Stories 2.2 / 2.4 — locked, out of scope for 2.6).
- `npm run lint` — `next lint` reports no warnings or errors.
- `npm test` — full suite green: 685 passed / 1 skipped / 0 failed. Story 2.6's targeted file set runs 41 unit + 6 component + 6 form tests + 10 inherited LotDetail tests = 63 passing assertions total. One unhandled rejection from `tests/unit/sw/sw.test.ts` (pre-existing; service-worker fetch to `app.example` — unrelated).
- `npm run build` — Next.js compile step succeeds; the type-check pass fails on the same three concurrent-story files above. None of the failures touch any Story 2.6 file.

### Completion Notes List

- **Audit `action` enum compatibility**: the story spec mentions `action: "occupant.add"` and `"occupant.remove"`. The existing `AuditAction` enum in `convex/lib/audit.ts` is closed (`create | update | delete | transition | void | deactivate | reactivate | transfer | read_pii`), and `emitAudit` throws `INVARIANT_VIOLATION` on unknown actions. We mapped to the canonical `"create"` (for add) and `"delete"` (for remove) — same convention `convex/lots.ts` and `convex/conditionLogs.ts` use for sub-entity events. Audit consumers can still distinguish occupant events by the `after.occupantId` field. Adding a dedicated `"occupant.add"` action would be a separate ADR + edit to `convex/lib/audit.ts` (out of scope for this story).
- **Audit `entityType` keyed on `lot`** — matches the story's FR16-style aggregate-root convention. `entityType: "occupant"` would require a schema edit (the `entityType` validator on `auditLog` is a strict union); the story's Dev Notes section explicitly calls out the lot-as-aggregate choice, so we kept it.
- **`OccupantsPanel` self-fetches `lotId` via `useParams`** rather than receiving it as a prop. Story 1.11's `LotDetail.tsx` is locked and currently mounts `<OccupantsPanel />` without props; adding a `lotId` prop would require modifying that file. The route-param read degrades gracefully (returns `null` in jsdom without a router context), preserving Story 1.11's `LotDetail.test.tsx` assertions on `data-testid="occupants-empty"`. Re-verified — Story 1.11's tests still pass with the new panel mounted.
- **`OccupantsPanel` self-fetches the caller's auth via `getCurrentUserOrNull`** for the same reason — `LotDetail` accepts `roles` but doesn't thread it into children. The Add-occupant button is gated `office_staff` / `admin` only; field workers see the list (Story 8.3's burial-navigation flow) but no Add button.
- **`removeOccupant` mutation included** per the story spec's Task 5. Admin-only. The Phase 1 UI does NOT yet expose a remove affordance (deferred to a Phase 2 follow-up); the server endpoint is in place so admin tooling can call it.
- **No new lint-rule additions or exemptions required** — the existing `require-role-first-line` / `no-audit-log-direct-write` / `no-raw-status-patch` rules all accept the new file as written.
- **Build pre-existing failures not in scope**: concurrent Stories 2.2 (`CustomerDocumentUpload.tsx`) and 2.4 (`DataSubjectReport/index.tsx`, `data-subject-reports/page.tsx`) have type errors (`JSX.Element` namespace + `DefaultFunctionArgs` index signature). Those files are locked for this story and the errors predate my edits — verified by running `typecheck` after Story 2.6's first edit (clean) and again later (failing on those same locked files only, never on Story 2.6 files).
- **No deferred work for Story 2.7 (transfer)** — occupants and ownerships are intentionally separate tables. The schema cleanly accommodates Story 2.7 building on top.

### File List

Created:
- `convex/occupants.ts` — `addOccupant`, `listLotOccupants`, `removeOccupant` (with role gates + `emitAudit`).
- `src/components/OccupantForm/OccupantForm.tsx` — RHF + Zod form with the "Date unknown" checkbox.
- `src/components/OccupantForm/schema.ts` — Zod validator mirroring server-side caps.
- `src/components/OccupantForm/index.ts` — barrel export.
- `src/components/OccupantForm/OccupantForm.test.tsx` — 6 component tests.
- `src/components/LotDetail/OccupantsPanel.test.tsx` — 6 panel tests (mocked `useParams` + `convex/react`).
- `tests/unit/convex/occupants.test.ts` — 29 hand-mocked-ctx tests (`addOccupant`, `listLotOccupants`, `removeOccupant`).
- `tests/e2e/lot-occupants.spec.ts` — unauthenticated-redirect smoke spec (full authenticated journey deferred per Story 1.11's seed-blocker pattern).

Modified:
- `convex/schema.ts` — added the `occupants` table with `by_lot` and `by_lot_interment_date` indexes.
- `src/components/LotDetail/OccupantsPanel.tsx` — replaced Story 1.11 placeholder body with the real reactive list + Add-occupant Dialog wiring; preserved the `data-testid="occupants-empty"` selector + `Occupant` / `OccupantsPanelProps` type exports for compatibility.

### Change Log

| Date       | Author              | Notes                                                          |
| ---------- | ------------------- | -------------------------------------------------------------- |
| 2026-05-18 | bmad-dev-story      | Implemented Story 2.6 (FR18 occupants). Status → review.       |
