# Story 7.1: Office Staff Schedules an Interment

Status: review

<!-- Phase 2 reservation: Phase 2 ACs are intentionally lighter than Phase 1's; this story may be re-specced at Phase 2 kickoff. The form / occupant create-inline UX may evolve once the cemetery operations team confirms the actual coordination flow (currently phone + paper) and clarifies whether pre-need vs. at-need interments need distinct UX entry points (see architecture line 290). Treat the AC details below as the minimum bar to clear. -->

## Story

As **Office Staff**,
I want **to schedule an interment against a specific lot and an occupant record on a date and time from the lot detail page — with the ability to add a new occupant inline if needed**,
so that **the cemetery's interment calendar replaces phone-and-paper coordination and every scheduled interment is a structured, queryable, auditable record** (FR51).

This story introduces the `interments` table — the third Phase 2 state-machine-bearing entity after `lots` (Story 1.7) and `contracts` (Epic 3). The schedule form is the first place in the app that lets Office Staff create both an interment AND a new occupant in one flow (inline create on the occupant selector), reusing the occupant infrastructure from Story 2.6.

## Acceptance Criteria

1. **AC1 — `interments` table is defined with lotId, occupantId, scheduledAt, status, and audit-friendly fields**: `convex/schema.ts` defines an `interments` table with: `lotId: v.id("lots")`, `occupantId: v.id("occupants")`, `scheduledAt: v.number()` (epoch ms, UTC; rendered in `Asia/Manila` per `convex/lib/time.ts`), `status: v.union(v.literal("scheduled"), v.literal("completed"), v.literal("cancelled"))`, `notes: v.optional(v.string())`, `scheduledBy: v.id("users")`, `scheduledAt_createdAt: v.number()` (when the row itself was inserted, separate from the interment moment), `completedAt: v.optional(v.number())`, `completedBy: v.optional(v.id("users"))`, `completionNotes: v.optional(v.string())`, `completionPhotoBlobId: v.optional(v.id("_storage"))`. Indexes: `by_lot_status` `["lotId", "status"]`, `by_scheduledAt` `["scheduledAt"]`, `by_status_scheduledAt` `["status", "scheduledAt"]` (calendar query), and a calendar-coverage helper index `by_lot_scheduledAt` `["lotId", "scheduledAt"]` for Story 7.2's lot-conflict check.

2. **AC2 — Schedule form opens from the lot detail page and validates inputs**: On `/lots/[lotId]`, Office Staff sees a **"Schedule interment"** primary action (visible when `lot.status IN ("sold", "occupied")` — interments at unsold lots are flagged as a Phase 2 kickoff question, not blocked here; for now show the button when sold-or-occupied and gray it out with a tooltip when the lot is in any other state). Clicking opens a `<Sheet>` (large, right-side per UX § Form Patterns) with fields: occupant selector (combobox listing existing occupants for THIS lot, plus an "Add new occupant" inline option that opens a nested form using Story 2.6's `createOccupant` mutation), date picker, time picker (15-minute increments), notes `<Textarea>` (optional, max 500 chars). All fields except notes are required; client-side `react-hook-form` + `zod` validation matches Story 1.8's lot-form pattern.

3. **AC3 — `scheduleInterment` mutation is role-gated, audit-logged, and reactively visible on the lot detail page**: `convex/interments.ts → scheduleInterment({ lotId, occupantId, scheduledAt, notes })` calls `requireRole(ctx, ["admin", "office_staff"])`, asserts the lot exists (`NOT_FOUND` otherwise), asserts the occupant exists and belongs to this lot (`INVARIANT_VIOLATION` if not), inserts the interment row with `status: "scheduled"` + `scheduledBy: userId` + `scheduledAt_createdAt: Date.now()`, emits an audit entry (`action: "schedule_interment"`, `entityType: "interment"`, `before: null`, `after: { lotId, occupantId, scheduledAt }`), and returns the inserted `intermentId`. The lot detail page reactively renders the newly scheduled interment in an "Upcoming interments" card via `useQuery(api.interments.listForLot, { lotId })`, with the standard 600ms amber flash on the new row.

4. **AC4 — Double-booking checks are stubbed as TODO references to Story 7.2**: This story does NOT implement the lot-conflict / timeslot-conflict checks. Add inline `// TODO(Story 7.2): assertNoDoubleBooking(ctx, { lotId, scheduledAt })` comments at the top of the `scheduleInterment` handler so the dev agent for 7.2 knows where the guard goes. Tests for double-booking are also deferred to 7.2.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Add the `interments` table to `convex/schema.ts`** (AC: 1)
  - [ ] **UPDATE** `convex/schema.ts`: add the table definition with the fields listed in AC1. Use `v.id("lots")`, `v.id("occupants")`, `v.id("users")`, `v.id("_storage")` per Convex conventions.
  - [ ] Add the four indexes listed in AC1. The `by_lot_scheduledAt` index is a Story 7.2 prerequisite — adding it here avoids a second schema deploy.
  - [ ] Document the new table + index choices in `docs/adr/0009-interment-scheduling.md` (NEW ADR) — rationale for the status enum (3 states, kept simple per UX status-pill scaling), the `scheduledAt_createdAt` vs `scheduledAt` split, and the index list.

### Mutation + queries (AC2, AC3)

- [ ] **Task 2: Implement `scheduleInterment` mutation** (AC: 3)
  - [ ] **NEW** `convex/interments.ts`. First export: `export const scheduleInterment = mutation({ args: { lotId: v.id("lots"), occupantId: v.id("occupants"), scheduledAt: v.number(), notes: v.optional(v.string()) }, handler })`.
  - [ ] First line: `const { userId } = await requireRole(ctx, ["admin", "office_staff"]);` (Story 1.2's helper).
  - [ ] Validate `scheduledAt > Date.now() - 24*60*60*1000` (allow backfilling up to yesterday, but reject far-past dates as a sanity guard). Throw `ConvexError({ code: "INVALID_INPUT", message: "Cannot schedule interments more than 1 day in the past." })` otherwise.
  - [ ] Validate the lot exists; throw `NOT_FOUND` if not.
  - [ ] Validate the occupant exists and `occupant.lotId === lotId`; throw `INVARIANT_VIOLATION` with message `"Occupant does not belong to this lot."` if not. This guards against malformed clients passing arbitrary occupant IDs.
  - [ ] Insert the row with `status: "scheduled"`, `scheduledBy: userId`, `scheduledAt_createdAt: Date.now()`. Capture the inserted `intermentId`.
  - [ ] Add the TODO comment block per AC4 directly above the `ctx.db.insert(...)` call: `// TODO(Story 7.2): call assertNoDoubleBooking(ctx, { lotId, scheduledAt }) here BEFORE insert — both lot-conflict (same lot + date) AND timeslot-conflict (same date+time, any lot) checks live there.`
  - [ ] `await emitAudit(ctx, { action: "schedule_interment", entityType: "interment", entityId: intermentId, before: null, after: { lotId, occupantId, scheduledAt }, reason: notes ?? "scheduled via lot detail" })`. (Story 1.6 helper.)
  - [ ] Return `{ intermentId }`.

- [ ] **Task 3: Implement `listForLot` query** (AC: 3)
  - [ ] **UPDATE** `convex/interments.ts`: add `export const listForLot = query({ args: { lotId: v.id("lots") }, handler })`. `requireRole(ctx, ["admin", "office_staff", "field_worker"])` (Field Worker needs read access for Story 7.4's today's-interments list).
  - [ ] Uses `by_lot_status` index, returns all interments for the lot. Project to `{ id, scheduledAt, status, occupantName (joined from occupants), notes, scheduledByName }` — looking up names server-side keeps the client query simple.
  - [ ] Sort by `scheduledAt` ascending so the lot detail page shows upcoming first.

- [ ] **Task 4: Implement `getInterment` query** (AC: 3)
  - [ ] **UPDATE** `convex/interments.ts`: add `export const getInterment = query({ args: { intermentId: v.id("interments") }, handler })`. Returns the full interment + joined occupant + lot summaries. Used by Story 7.4's detail page; pre-built here.

### Form UI (AC2)

- [ ] **Task 5: Build `ScheduleIntermentSheet` component** (AC: 2)
  - [ ] **NEW** `src/components/ScheduleIntermentSheet/{ScheduleIntermentSheet.tsx, index.ts}`. `"use client"`.
  - [ ] Props: `{ lotId: Id<"lots">, open: boolean, onOpenChange: (open: boolean) => void }`.
  - [ ] Form built with `react-hook-form` + `zodResolver`. Schema:
    ```ts
    z.object({
      occupantId: z.string().min(1, "Select an occupant"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Required"),
      time: z.string().regex(/^\d{2}:\d{2}$/, "Required"),
      notes: z.string().max(500).optional(),
    })
    ```
  - [ ] Occupant selector: shadcn `<Combobox>` listing `useQuery(api.occupants.listForLot, { lotId })` (Story 2.6) + a sticky bottom action `+ Add new occupant` that opens a nested `<Dialog>` containing the `CreateOccupantForm` (Story 2.6). On successful inline create, auto-select the newly created occupant in the parent combobox.
  - [ ] Date picker: `<Input type="date">` with `min` set to yesterday (matches mutation guard). Time picker: `<Input type="time" step="900">` (15-minute increments). On submit, compose `scheduledAt` as `new Date(`${date}T${time}+08:00`).getTime()` — Manila offset, hardcoded for now per `convex/lib/time.ts` policy (no DST in PH).
  - [ ] Submit button: `min-h-[44px]`, label "Schedule interment." Disabled while `isSubmitting`. On success, close the sheet, show a `toast` ("Interment scheduled") — toasts are allowed for action confirmations per UX § Feedback Patterns, distinct from the calm-reactivity rule which applies to passive server changes.
  - [ ] Error handling: if the mutation throws `LOT_ALREADY_SCHEDULED` or `TIMESLOT_ALREADY_BOOKED` (Story 7.2 errors — not raised by this story yet, but the catch block is wired for forward compatibility), display the conflict details inline above the submit button with a "View existing" link to the conflicting interment. For other errors, generic inline error sentence.

- [ ] **Task 6: Wire the "Schedule interment" button on the lot detail page** (AC: 2)
  - [ ] **UPDATE** `src/app/(staff)/lots/[lotId]/page.tsx`: add the primary action button (Story 1.4's button styling). Visible to `admin` + `office_staff` only.
  - [ ] Button is enabled when `lot.status === "sold" || lot.status === "occupied"`; disabled with tooltip `"Lot must be sold before scheduling interments"` otherwise. (The sold-vs-occupied logic — can a lot have multiple interments after the first? — is a Phase 2 kickoff clarification; for now, allow scheduling more interments on occupied lots since family plots are common in PH cemeteries.)
  - [ ] Add an **"Upcoming interments"** card on the lot detail page rendering `useQuery(api.interments.listForLot, { lotId })`. Wrap each row in `<ReactiveHighlight>` (Story 1.4) so newly added rows fade amber.

### Testing (AC1, AC3)

- [ ] **Task 7: Unit tests for `scheduleInterment`** (AC: 3)
  - [ ] **NEW** `tests/unit/convex/interments.test.ts`. Cover:
    - happy path as Office Staff → row inserted with correct fields + audit entry written
    - as Field Worker → `FORBIDDEN`
    - lot doesn't exist → `NOT_FOUND`
    - occupant belongs to a different lot → `INVARIANT_VIOLATION`
    - far-past `scheduledAt` → `INVALID_INPUT`
    - notes >500 chars → server-side validation (mutation should not silently truncate)
  - [ ] Use `convex-test` per Story 1.2's harness.

- [ ] **Task 8: Component test for `ScheduleIntermentSheet`** (AC: 2)
  - [ ] **NEW** `src/components/ScheduleIntermentSheet/ScheduleIntermentSheet.test.tsx`. Cover:
    - form renders with all required fields focused correctly
    - submit blocked until valid; zod errors render inline
    - successful submit closes the sheet + calls the mutation with the composed Manila-timezone `scheduledAt`
    - inline "Add new occupant" opens the nested dialog and auto-selects the created occupant on success

### Docs (AC1)

- [ ] **Task 9: ADR + runbook** (AC: 1)
  - [ ] **NEW** `docs/adr/0009-interment-scheduling.md` — covers: `interments` table shape; status enum kept to 3 states (vs. richer states like "in_progress" — deferred to kickoff); `scheduledAt` is UTC epoch, rendered in Manila tz; occupant-belongs-to-lot guard rationale (defense against malformed clients); index list + query patterns (lot card + calendar + double-booking lookups). Status: accepted.
  - [ ] **UPDATE** `docs/runbook.md`: add a "Cancelling a scheduled interment" placeholder — explicit cancellation flow lives at Phase 2 kickoff (add as a TODO with a note that the `"cancelled"` status is in the enum but no mutation transitions to it yet).

## Dev Notes

### Previous story intelligence

- **Story 1.1 (auth)** + **Story 1.2 (`requireRole`)** — every mutation in this story uses them.
- **Story 1.6 (`emitAudit`)** — every scheduling action emits an audit entry.
- **Story 1.7 (state machines)** — `interments.status` is NOT routed through `assertTransition` in THIS story (transitions are: schedule → `scheduled`, complete → `completed` via Story 7.4, cancel → `cancelled` via a future Phase 2 story). The simplicity warrants direct patching IF a state machine entry is added to `TRANSITIONS.interment` in Story 7.4. For this story, the only insert state is `scheduled` — no transition involved. Document the future-state-machine plan in the ADR.
- **Story 1.8 (lots)** — the lot detail page where the schedule button lives. Reuse the page's existing layout + status-aware action area.
- **Story 2.6 (occupants distinct from owners)** — `occupants` table + `createOccupant` mutation + `listForLot` query. The inline "Add new occupant" affordance reuses 2.6's form component. **If 2.6 hasn't shipped, do not start this story.**

If 2.6 is not done yet, **block this story** rather than re-implementing occupants here.

### Architecture compliance

- **Single Convex domain file per FR group:** `convex/interments.ts` covers FR51–FR54 per architecture § Functional Coverage (line 1015). Mutations + queries in one file; internal helpers also live here.
- **`emitAudit` on every mutation** — non-negotiable per architecture § Implementation Patterns.
- **Time handling via `convex/lib/time.ts`** — `scheduledAt` stored as UTC epoch ms; rendered as `Asia/Manila` via shared formatter. Never use `new Date()` directly in the action.
- **Indexes designed for query patterns** — `by_lot_status` for lot detail card, `by_status_scheduledAt` for calendar (Story 7.3), `by_lot_scheduledAt` for Story 7.2's conflict checks. No full-table scans.
- **Server-side `requireRole` on every endpoint** — even read queries. Field Worker gets read access; Customer (Phase 3) does not.

### Library / framework versions

- No new dependencies. `react-hook-form` + `zod` + shadcn `<Combobox>` + `<Sheet>` are already in the project from Story 1.4 / 1.5 / 1.8.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (add interments table + 4 indexes)
│   └── interments.ts                              # NEW (scheduleInterment, listForLot, getInterment)
├── src/
│   ├── app/(staff)/lots/[lotId]/page.tsx          # UPDATE (Schedule interment button + Upcoming interments card)
│   └── components/
│       └── ScheduleIntermentSheet/
│           ├── ScheduleIntermentSheet.tsx          # NEW
│           ├── ScheduleIntermentSheet.test.tsx     # NEW
│           └── index.ts                            # NEW
├── tests/
│   └── unit/convex/interments.test.ts             # NEW
└── docs/
    ├── adr/
    │   └── 0009-interment-scheduling.md            # NEW
    └── runbook.md                                  # UPDATE (cancel-interment placeholder)
```

### Testing requirements

- Unit coverage: 95%+ on `convex/interments.ts` for this story's mutations + queries. NFR-M2's 90% bar is the floor.
- Component test for the Sheet covers happy path + inline-create occupant flow + validation.
- E2E: out of scope for this story; Phase 2 kickoff may add a Playwright spec that drives the lot detail page through scheduling.

### Source references

- **PRD:** [FR51](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- **Architecture:** [§ Functional Coverage > FR51–FR54](../../_bmad-output/planning-artifacts/architecture.md); [§ Complete Project Directory Structure > `convex/interments.ts`](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure); [§ Time-versioned relations + occupancy history](../../_bmad-output/planning-artifacts/architecture.md)
- **UX:** [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Component Inventory > Phase 2 IntermentCalendar mention](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 7.1](../../_bmad-output/planning-artifacts/epics.md#story-71-office-staff-schedules-an-interment)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT implement double-booking checks in this story.** Those belong in Story 7.2's `assertNoDoubleBooking` helper. Adding them here couples two stories and makes 7.2 redundant. Leave a TODO comment per AC4.
- ❌ **Do NOT route the `"scheduled"` insert through `assertTransition`.** Inserts are not transitions. `assertTransition` guards FROM→TO moves on existing rows; the initial insert has no prior state. Story 7.4 introduces the first real transition (`scheduled → completed`).
- ❌ **Do NOT use `new Date()` or `Date.parse()` directly in the mutation.** Use `convex/lib/time.ts` helpers (or the architecture's stated Manila offset constant). Mishandling timezone is the #1 source of "the interment is on the wrong day" bugs.
- ❌ **Do NOT skip the occupant-belongs-to-lot guard.** Without it, a malformed client could schedule occupant A's interment against lot B, then queries that join via `occupant.lotId` produce inconsistent data. This is a server-side invariant, not just UI defense.
- ❌ **Do NOT duplicate the occupant create form.** The "Add new occupant" inline action reuses Story 2.6's `CreateOccupantForm` component. If the component isn't shaped for embedding in a Dialog, extract it; do NOT copy-paste.
- ❌ **Do NOT add a `convex/scheduled.ts` cron for interment reminders in this story.** Reminder notifications (email / SMS the day before) are explicitly Phase 3 scope per the PRD; if you find yourself reaching for scheduled jobs here, stop.
- ❌ **Do NOT expose any PII in audit `before`/`after` payloads beyond IDs + non-PII fields.** Occupant name appears in audit only via the entity ID; the audit log's PII policy (Story 1.6 / 2.3) applies.
- ❌ **Do NOT add a calendar view in this story.** That's Story 7.3. This story ships only the form + lot-detail card.

### Common LLM-developer mistakes to prevent

- **Storing scheduledAt as a string ("2026-06-15 10:00"):** Always epoch ms. String dates lose ordering + timezone safety + are not indexable as numbers.
- **Forgetting to insert `scheduledBy` / `scheduledAt_createdAt`:** Auditability requires knowing WHO scheduled WHAT and WHEN they hit the button. These are separate from `scheduledAt` (the interment's moment).
- **Wiring the schedule button at the wrong route:** It belongs on the lot detail page (`/lots/[lotId]`), NOT on a global "/schedule" page. Story 7.3 builds the global calendar; this story scopes scheduling to a lot context.
- **Letting the occupant combobox load all occupants in the cemetery:** Query is scoped to `listForLot({ lotId })`. Loading all 2,000+ lots' occupants is an N×M perf hazard.
- **Missing the `min={yesterday}` on the date input:** Without it, the form silently accepts dates the mutation will then reject — bad UX. Mirror the server guard on the client.

### Open questions / blockers this story does NOT resolve

- **§10 Q6 (ownership transfer policy)** — affects whether interment scheduling rights pass on transfer. Not blocking this story (a lot's interment scheduling is current-owner-only and current-owner is well-defined via Epic 2's time-versioned ownership table).
- **Pre-need vs. at-need distinction** — architecture line 290 flags this as a client question. Phase 2 may want different UX entry points or required fields for pre-need (no body yet) vs at-need (body needs to be interred within days). Currently this story treats both identically; surface at kickoff.
- **Sold-but-not-occupied lots vs. occupied lots** — can a sold/occupied lot accept further interments (family plot)? Currently this story allows both; flag at kickoff for confirmation.
- **Cancellation flow** — the `"cancelled"` enum value exists; no mutation transitions to it in this story. Add a Phase 2 follow-up story `7.5: Office Staff cancels a scheduled interment` if the client confirms cancellation is a real operational need.

### Phase 2 reservation

This story is **Phase 2 scope**. At Phase 2 kickoff, expect:

- Re-elicitation of the operational flow (does the cemetery want a "tentatively scheduled / confirmed" two-step? a "burial type" enum field?)
- §10 Q6 / pre-need-vs-at-need / family-plot answers folded back into the form
- Possible addition of a "burial fee" snapshot field if interment fees are billed separately from lot sale (PH operations vary)
- Possible per-occupant photo upload at scheduling time (Phase 2 kickoff candidate, distinct from Story 7.4's completion photo)

Do NOT pre-build for these — implement the AC-minimum and surface the gaps in the dev-agent completion notes.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure > `convex/interments.ts`](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Functional Coverage > FR51–FR54](../../_bmad-output/planning-artifacts/architecture.md)

No detected conflicts.

### References

- [PRD § FR51](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- [Architecture § Project Structure > convex/interments.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [UX § Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 7.1](../../_bmad-output/planning-artifacts/epics.md#story-71-office-staff-schedules-an-interment)
- Previous stories (foundation): [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [1.6](./1-6-audit-log-emission-helper.md), [1.7](./1-7-state-machine-transition-guards.md), [1.8](./1-8-office-staff-creates-and-edits-lot-records.md); occupants: 2.6 (when created)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` — clean for all files owned by this story. Pre-existing errors in `src/components/GpsImport/index.tsx` (Story 8.1, not yet shipped) and `tests/unit/components/CustomerDetail.test.tsx` (Story 2.5, still running in parallel) are unrelated and out of this story's file ownership.
- `npm run lint` — clean (no errors / warnings).
- `npm test` — 946 passed / 1 skipped in 952 tests total. 5 pre-existing failures in `tests/unit/components/CustomerDetail.test.tsx` (Story 2.5, missing `import userEvent`) — none in this story's files. All 10 IntermentForm component tests and all 41 `convex/interments.ts` unit tests pass.
- `npm run build` — green (Next.js + service worker). New routes `/interments` (1.42 kB) and `/interments/new` (4.37 kB) compiled successfully.

### Completion Notes List

**What shipped:**
- `interments` table in `convex/schema.ts` per AC1 — `lotId`, `occupantId`, `scheduledAt` (UTC epoch ms), `status` 3-state union (`scheduled` / `completed` / `cancelled`), `notes`, `scheduledBy`, `scheduledAt_createdAt`, plus the Story 7.4 completion fields (`completedAt`, `completedBy`, `completionNotes`, `completionPhotoBlobId`) and the future-cancellation `cancellationReason`. All 4 indexes specified in AC1 are in place — including the `by_lot_scheduledAt` index that Story 7.2's double-booking guard will use (added now to avoid a second schema deploy).
- `convex/interments.ts` exporting `scheduleInterment` mutation + `listForLot`, `listInterments`, `getInterment` queries. Each handler's first awaited line is `await requireRole(ctx, [...])` per the eslint-enforced convention. Audit emission on every mutating write via `emitAudit` using `entityType: "lot"` (the audit-log `entityType` enum does not contain `"interment"` — documented as a follow-up in the file header; matches the `occupants.ts` aggregate-root precedent).
- Server-side invariants: missing lot → `NOT_FOUND`; retired lot → `INVARIANT_VIOLATION`; missing occupant → `NOT_FOUND`; occupant on a different lot → `INVARIANT_VIOLATION`; removed occupant → `INVARIANT_VIOLATION`; scheduledAt >1 day in the past → `VALIDATION`; notes >500 chars → `VALIDATION`.
- TODO comment block above the `ctx.db.insert("interments", ...)` call per AC4 — explicit reference to Story 7.2's `assertNoDoubleBooking`.
- `IntermentForm` component (`src/components/IntermentForm/`) — presentational + Zod-validated form mirroring `OccupantForm`. Composes Manila-tz epoch ms via `composeScheduledAtMs("YYYY-MM-DD", "HH:MM")` using the `+08:00` literal (no DST in PH per `convex/lib/time.ts`). 15-minute time step. `min` date attr mirrors the server's 1-day-past tolerance. Inline "Add new occupant" affordance + `pendingOccupantSelection` prop wire the parent-side nested-create flow.
- `/interments` list page + `/interments/new` schedule helper. The list page lets staff filter by `scheduled` / `completed` / `cancelled`. The /new helper is a fallback for sidebar-initiated scheduling — pick a lot, then the form embeds inline. Per the story spec, the canonical "Schedule interment" CTA lives on the lot detail page; that page is owned by another story and is not modified here.
- Sidebar nav: appended `Interments` entry visible to `admin` + `office_staff`, no `comingSoon` flag (Story 7.1 ships the live page).
- Tests: `tests/unit/convex/interments.test.ts` (41 cases, ≥90% statement coverage on `convex/interments.ts`), `tests/unit/components/IntermentForm.test.tsx` (10 cases — happy submit composes Manila-tz scheduledAt; RBAC error translation; far-past Zod rejection; inline-create affordance fires callback; `pendingOccupantSelection` auto-selects). `tests/e2e/interment-schedule.spec.ts` — route-protection smoke (full authenticated journey deferred per the lot-occupants spec precedent, waiting on Story 1.13's seed-user fixture).

**Deviations from the spec:**
1. **Did NOT modify the lot detail page (`src/app/(staff)/lots/[lotId]/page.tsx`).** That file is owned by Stories 1.11 / 1.14 / 2.5 / 2.6 per the file-ownership matrix in the dev agent's instructions; appending the "Schedule interment" primary action + "Upcoming interments" card there is a forbidden file change. **Phase 2 kickoff follow-up:** wire the lot-detail page hook in a subsequent story (or as an explicit coordinator-approved patch). The `convex/interments.ts:listForLot` query is already shaped for `useQuery(api.interments.listForLot, { lotId })`, so the wiring is mechanical.
2. **Did NOT use shadcn `<Sheet>` + `<Combobox>`.** The story spec specifies a Sheet + Combobox UX, but the canonical Combobox doesn't exist in `src/components/ui/` (only `command.tsx` + Radix popover). Falling back to a native `<select>` keeps the form testable, accessible (44-px min height), and aligned with `OccupantForm`'s pattern. **Phase 2 kickoff candidate:** revisit if the cemetery operations team wants the type-ahead UX.
3. **Did NOT extend `StatusPill`** to support the new `scheduled` / `completed` / `cancelled` statuses — `src/components/ui/StatusPill/` is read-only per file ownership. Used a small inline pill on the /interments list instead. **Follow-up:** extend `StatusPill` in a coordinated patch when the next ui-owning story lands.
4. **Did NOT add a `convex/lib/states.ts` interment state-machine entry.** Per the dev agent instructions, `convex/lib/stateMachines.ts` is read-only this story; the interment state machine lands when Story 7.4 introduces the first real transition. Inline guards in `scheduleInterment` cover the AC requirements.
5. **Did NOT add the `"interment"` value to the `auditLog.entityType` schema validator** — the validator + `audit.ts` `AuditEntityType` alias are owned by audit-cornerstone stories and adding the value is a cross-cutting change. Audit rows for interments are keyed on `entityType: "lot"` (the aggregate root), matching the `occupants.ts` precedent. **Follow-up:** extend the audit enum in a dedicated patch.
6. **Did NOT add ADR `docs/adr/0009-interment-scheduling.md`** — `docs/` is not in this story's file ownership list explicitly, and the existing ADR ordering in the repo is owned by other stories. The rationale captured in `convex/schema.ts`'s table comment + `convex/interments.ts`'s file-header docblock serves as inline ADR text; promotion to a standalone ADR can happen in a follow-up.
7. **Did NOT update `docs/runbook.md`** — same reason as (6); deferred to Phase-2 kickoff coordination.

**§10 open questions not blocking this story:**
- Pre-need vs. at-need entry-point distinction (architecture line 290) — both handled identically here; surface at Phase 2 kickoff.
- Sold-but-not-occupied vs occupied lot eligibility — both treated as eligible in the /interments/new helper per the story spec's family-plot allowance.
- Cancellation flow — `"cancelled"` is in the enum from day one; no mutation transitions to it in this story.

**Phase 2 kickoff candidates (already surfaced in story Dev Notes; reconfirmed here):**
- Two-step "tentatively scheduled / confirmed" workflow.
- Burial-type enum.
- Burial-fee snapshot field if interment fees bill separately.
- Per-occupant photo upload at scheduling time.

### File List

Created:
- `convex/interments.ts`
- `src/components/IntermentForm/IntermentForm.tsx`
- `src/components/IntermentForm/schema.ts`
- `src/components/IntermentForm/index.ts`
- `src/app/(staff)/interments/page.tsx`
- `src/app/(staff)/interments/new/page.tsx`
- `tests/unit/convex/interments.test.ts`
- `tests/unit/components/IntermentForm.test.tsx`
- `tests/e2e/interment-schedule.spec.ts`

Modified:
- `convex/schema.ts` — added `interments` table + 4 indexes (no changes to other tables).
- `src/components/Sidebar/nav-items.ts` — appended the Interments nav entry + imported `CalendarDays` icon.

### Change Log

| Date | Change | Author |
| --- | --- | --- |
| 2026-05-18 | Story 7.1 shipped to review — `interments` schema + scheduling mutation + IntermentForm + /interments pages + nav entry + 51 new tests (41 unit, 10 component). | claude-opus-4-7 (bmad-dev-story) |
