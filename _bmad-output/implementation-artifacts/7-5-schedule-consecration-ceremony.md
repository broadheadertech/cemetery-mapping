# Story 7.5: Office Staff Schedules a Consecration Ceremony

Status: review

<!-- Brand-tier extension: Chapter VI of the Apostle Paul brand guide references "the consecration ceremony for the family estate at Section A, scheduled for the morning of the twenty-eighth. The chapel and pathway will be reserved exclusively for your family from sunrise. Our memorial consultant, Maria de los Santos, will receive you at the gate." This is a workflow distinct from interment (Epic 7 covers burials): a consecration is a dedication ceremony at sale-time / estate-creation-time, reserves chapel + pathway, requires a consultant assignment, and does not have a "complete" gesture in the same field-worker sense an interment does. -->

## Story

As **Office Staff**,
I want **to schedule a consecration ceremony for a new family estate or chapel-section dedication, distinct from an interment, with chapel + walking-path reservations and a named consultant**,
so that **the cemetery can prepare the grounds, brief the consultant, and confirm with the family in advance of a ceremony separate from any burial** (extends FR43 Interment Scheduling).

This story builds the office-staff workflow for scheduling consecrations alongside the existing interment calendar from [Story 7.1](./7-1-office-staff-schedules-an-interment.md) and [Story 7.3](./7-3-office-staff-views-the-interment-calendar.md). A consecration is anchored to a contract (or, when [Story 2.9](./2-9-family-estate-multi-lot-grouping.md) lands, a family estate) rather than a deceased individual, and reuses the double-booking guard from [Story 7.2](./7-2-system-prevents-double-booking.md). The shared calendar surface treats consecrations visually distinct from interments (gold accent rather than the existing tone) but the underlying scheduling table is shared so the double-booking guard is automatic.

## Acceptance Criteria

1. **AC1 — `ceremonies` table generalises the existing interment shape with a `kind` discriminator**: `convex/schema.ts` either (a) renames the existing `interments` table to `ceremonies` and adds a `kind` field, OR (b) introduces a new `ceremonies` table parallel to `interments` and migrates existing data. The chosen approach is documented in `docs/adr/0069-ceremonies-table.md`. Required columns: `kind: v.union(v.literal("consecration"), v.literal("interment"), v.literal("memorial_anniversary"))`, `contractId: v.id("contracts")` (required for consecration; required for interment; optional for memorial anniversary), `familyEstateId: v.optional(v.id("familyEstates"))` (forward-compat with [Story 2.9](./2-9-family-estate-multi-lot-grouping.md); when set, ceremony covers all lots in the estate), `lotId: v.id("lots")` (the anchoring lot — for an estate the brand-spec chapel-of-grace lot), `scheduledAt: v.number()` (epoch ms; rendered Manila tz on the calendar), `durationMinutes: v.number()` (default 90 for consecration, 60 for interment), `chapelReserved: v.boolean()` (consecration default true; interment default false), `pathwayReserved: v.boolean()` (consecration default true), `consultantUserId: v.optional(v.id("users"))` (the staff member receiving the family at the gate), `notes: v.optional(v.string())`, `status: v.union(v.literal("scheduled"), v.literal("completed"), v.literal("cancelled"))`. The `interments`-specific `deceasedOccupantId` becomes optional. Indexes: `by_kind_scheduledAt` `["kind", "scheduledAt"]`, `by_contract` `["contractId"]`, `by_status_scheduledAt` `["status", "scheduledAt"]`.

2. **AC2 — `/ceremonies/new?contractId=…&kind=consecration` route hosts the consecration form**: A new authenticated route gated to `admin` + `office_staff` shows: (a) read-only contract + lot + customer summary card (the consecration is anchored to a contract; the contract carries the family name and lot reference), (b) date + time picker (Manila tz, 30-minute granularity, defaults to "next sunrise per brand-spec" — `08:00 Manila` on the day chosen), (c) duration slider 60–180 minutes (default 90), (d) chapel-reserved toggle (default ON for consecration), (e) pathway-reserved toggle (default ON), (f) consultant dropdown (lists `users` with `roles` including `office_staff` — defaults to the currently logged-in operator), (g) notes textarea (preparation requests, family preferences), (h) primary button "Schedule consecration". On submit the public mutation `scheduleCeremony` is called; on success the operator is redirected to `/ceremonies/[ceremonyId]` (the detail page covered in AC4).

3. **AC3 — Double-booking guard from [Story 7.2](./7-2-system-prevents-double-booking.md) extends to consecrations**: The existing `assertNoBookingConflict` helper in `convex/lib/scheduling.ts` (or wherever Story 7.2 placed it) accepts a `kind` field but the conflict check is **kind-agnostic** — a consecration on lot A at 09:00 and an interment on lot A at 09:30 must conflict if `durationMinutes` overlaps. Additionally, when `chapelReserved: true`, the conflict check extends to ANY other ceremony on the SAME `scheduledAt` ± `durationMinutes` window with `chapelReserved: true` (the chapel is a single shared resource). Same for `pathwayReserved`. Tests cover: (a) consecration + interment on same lot, overlapping window → conflict; (b) two consecrations on different lots but BOTH chapel-reserved at same time → conflict; (c) two consecrations, only one chapel-reserved → no conflict; (d) FK + back-compat existing interment-only tests still pass.

4. **AC4 — `/ceremonies/[ceremonyId]` detail page works for BOTH consecration and interment, with kind-specific affordances**: A new authenticated detail page renders: kind pill (gold accent for consecration; existing tone for interment per [Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md)), scheduled-at in Manila tz with day-of-week, duration, anchoring contract + customer + lot links, consultant name with a Convex-mailto link, notes block, status pill. **Consecration-specific:** "Mark consecration complete" action (admin + office_staff) — flips status to `completed` and emits audit. The completion gesture is deliberately simpler than [Story 7.4](./7-4-field-worker-marks-an-interment-complete.md)'s field-worker workflow (there is no body to inter; the office confirms the ceremony occurred). **Interment-specific:** field-worker completion remains owned by Story 7.4 — this page links to it for interments rather than re-implementing. Cancel action (admin only) on both kinds, with a 10-char reason floor per the existing reason-textarea pattern.

5. **AC5 — Interment calendar from [Story 7.3](./7-3-office-staff-views-the-interment-calendar.md) renders consecrations alongside interments with distinct visual treatment**: The `/interments/calendar` route — repurposed to `/ceremonies/calendar` with a back-compat redirect — fetches BOTH kinds from the `ceremonies` table. Each calendar entry renders: kind badge (consecration: gold mark; interment: stone mark), title (consecration: "Consecration · {family last name}"; interment: existing pattern), chapel-reserved icon when set, pathway-reserved icon when set. The legend at the top of the calendar names both kinds. A new filter chip row at the top lets the operator hide one kind or the other. URL params `kind=consecration|interment|all` (default `all`) drive the filter for deep-link sharing.

6. **AC6 — Audit + back-compat**: Every mutation emits `emitAudit` ([Story 1.6](./1-6-audit-log-emission-helper.md)) with `action: "schedule_ceremony" | "complete_ceremony" | "cancel_ceremony"` and `entityType: "ceremony"`. Existing audit rows from [Story 7.1](./7-1-office-staff-schedules-an-interment.md) carry `entityType: "interment"` — back-compat: the admin audit-log filter UI accepts BOTH values; the migration documented in AC1 emits a one-shot internal mutation that backfills `kind: "interment"` on existing rows but does NOT rewrite their audit entityType. Family estates from [Story 2.9](./2-9-family-estate-multi-lot-grouping.md) integrate later — for now, consecration is single-contract-anchored.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Choose between rename or parallel-table** (AC: 1)
  - [ ] Write `docs/adr/0069-ceremonies-table.md`. Cover the two options:
    - **Option A — rename `interments` → `ceremonies` + add `kind` field.** Pros: single source of truth for double-booking, calendar joins are uniform, indices are shared. Cons: a non-trivial schema migration (Convex schemas are versioned but live data must be backfilled with a one-shot internal mutation; Story 1.7 transition-guards must be re-evaluated against the new kind union). Required follow-up changes: every file referencing `interments` table updates to `ceremonies` (rough count via `grep -r "interments" convex/ src/`).
    - **Option B — new `ceremonies` table parallel to `interments`.** Pros: zero migration risk, existing tests stay green. Cons: double-booking guard must query BOTH tables; calendar query joins two tables; long-term maintenance debt.
  - [ ] **Recommendation:** Option A (rename + add kind). The double-booking guard is the load-bearing concern and a single-table model keeps it correct by construction. Schedule the rename as a single PR with the rename + the backfill mutation + the test updates atomic.
  - [ ] **UPDATE** `convex/schema.ts` per Option A: rename table; add `kind`, `familyEstateId`, `chapelReserved`, `pathwayReserved`, `consultantUserId` columns; add the three new indexes; mark `deceasedOccupantId` optional. (Or per Option B if the ADR concludes otherwise — adapt the rest of the tasks below.)

### Backfill (AC1, AC6)

- [ ] **Task 2: One-shot backfill internal mutation** (AC: 1, AC: 6)
  - [ ] **NEW** `convex/internal/backfillCeremoniesKind.ts` (or wherever `convex/internal/*` lives if the repo has that convention). Implements an `internalMutation` that scans every row in the renamed `ceremonies` table and patches `kind: "interment"` if absent. Idempotent (safe to re-run). Returns `{ scanned, patched, skipped }`.
  - [ ] Document the manual trigger: `npx convex run internal/backfillCeremoniesKind:run --prod` after the schema deploy. Surface this in `docs/runbook.md` deployment checklist.

### Domain mutations + queries (AC2, AC3, AC4, AC5, AC6)

- [ ] **Task 3: `convex/ceremonies.ts` — schedule + complete + cancel + list** (AC: 2, AC: 4, AC: 5, AC: 6)
  - [ ] **NEW** `convex/ceremonies.ts` (or rename existing `convex/interments.ts` if Option A is chosen). Exports:
    - `scheduleCeremony({ kind, contractId, lotId, scheduledAt, durationMinutes, chapelReserved, pathwayReserved, consultantUserId?, notes? })` — `requireRole(ctx, ["admin", "office_staff"])`. Asserts the contract + lot exist. Calls `assertNoBookingConflict` (the extended Story 7.2 helper — see Task 4). Inserts the row. Emits audit. Returns `{ ceremonyId }`.
    - `completeCeremony({ ceremonyId })` — `requireRole(ctx, ["admin", "office_staff"])` for consecrations; `requireRole(ctx, ["field_worker", "admin", "office_staff"])` for interments (delegates to [Story 7.4](./7-4-field-worker-marks-an-interment-complete.md)'s logic). Flips status. Emits audit.
    - `cancelCeremony({ ceremonyId, reason })` — `requireRole(ctx, ["admin"])`. 10-char reason floor. Flips status to `cancelled`. Emits audit.
    - `getCeremony({ ceremonyId })` — read-side query for the detail page. `requireRole(ctx, ["admin", "office_staff", "field_worker"])`. Joins contract + customer + lot + consultant; returns the projection shape the page renders.
    - `listCeremonies({ kindFilter?, dateFrom?, dateTo? })` — read-side query for the calendar. `requireRole(ctx, ["admin", "office_staff", "field_worker"])`. Uses `by_kind_scheduledAt` index; kind-agnostic when `kindFilter === undefined`. Returns rows in `scheduledAt` ascending.

### Double-booking guard (AC3)

- [ ] **Task 4: Extend `assertNoBookingConflict` to honour chapel + pathway sharing** (AC: 3)
  - [ ] **UPDATE** `convex/lib/scheduling.ts` (or wherever [Story 7.2](./7-2-system-prevents-double-booking.md) placed the guard). Add overlap detection for:
    - Lot conflict (existing, kind-agnostic — strengthen the existing test to assert kind-agnostic behaviour).
    - Chapel conflict: any TWO ceremonies with `chapelReserved: true` whose `[scheduledAt, scheduledAt + durationMinutes)` windows overlap → conflict.
    - Pathway conflict: same but for `pathwayReserved`.
  - [ ] Each conflict throws `throwError(ErrorCode.SCHEDULING_CONFLICT, …)` with a clear message naming the conflicting resource (lot / chapel / pathway).
  - [ ] **UPDATE** the Story 7.2 tests to cover the three new conflict cases listed in AC3. Keep existing tests green.

### Page + form (AC2)

- [ ] **Task 5: `/ceremonies/new` page + form** (AC: 2)
  - [ ] **NEW** `src/app/(staff)/ceremonies/new/page.tsx`. Reads `contractId` + `kind` from query string. Server-prefetches the contract + lot + customer summary via `fetchQuery`. Renders a client component `<CeremonyScheduleForm />` with the prefetched values.
  - [ ] **NEW** `src/components/CeremonyScheduleForm/CeremonyScheduleForm.tsx`. RHF + Zod schema. 30-minute granularity time picker. Duration slider. Toggles for chapel + pathway with brand-aligned copy ("Reserve the chapel for this family" / "Reserve the eastern walking path"). Consultant dropdown wired via `useQuery(api.users.listOfficeStaff)`. Notes textarea (500-char max). Min-h-[48px] submit button (NFR-A4). Submit calls `useMutation(api.ceremonies.scheduleCeremony)`. On success: `router.push("/ceremonies/" + result.ceremonyId)`.

### Detail page (AC4)

- [ ] **Task 6: `/ceremonies/[ceremonyId]` page** (AC: 4)
  - [ ] **NEW** `src/app/(staff)/ceremonies/[ceremonyId]/page.tsx`. `useQuery(api.ceremonies.getCeremony, { ceremonyId })`. Renders the layout per AC4. Kind pill via `<StatusPill>` ([Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md)) — new variants `consecration` (gold accent) and `interment` (existing tone). Reuse `<MarkCompleteDialog>` from Story 7.4 for interments; new `<MarkConsecrationCompleteDialog>` for consecrations (simpler — no field-worker mobile-first concerns). Reuse `<CancelCeremonyDialog>` (new component, modelled on `<MarkInDefaultDialog>` from Story 4.4) for both kinds.

### Calendar (AC5)

- [ ] **Task 7: Extend `/interments/calendar` → `/ceremonies/calendar`** (AC: 5)
  - [ ] **UPDATE** `src/app/(staff)/interments/calendar/page.tsx` — rename to `src/app/(staff)/ceremonies/calendar/page.tsx`. Old route 308-redirects to new via `next.config.ts` redirects array.
  - [ ] **UPDATE** the calendar component to render both kinds. Visual treatment: consecration entries get a gold left-border + dove-laurel mark; interment entries keep the existing visual (stone tone + tombstone icon if any). Kind legend at the top. Filter chip row with `kind=consecration|interment|all` URL-param sync.

### Tests (AC1, AC3, AC4, AC5, AC6)

- [ ] **Task 8: Vitest unit tests** (AC: 1, AC: 3, AC: 4, AC: 6)
  - [ ] **NEW** `tests/unit/convex/ceremonies.test.ts` (or **UPDATE** the existing `interments.test.ts` if Option A is chosen). Cover: auth gating; schedule a consecration with chapel + pathway reservation; consecration vs. interment on same lot conflict; two consecrations chapel-reserved at same time conflict; two consecrations only one chapel-reserved no conflict; complete consecration flips status; cancel with reason; reject reason < 10 chars; audit emission for all three mutations.
  - [ ] **NEW** `tests/unit/components/CeremonyScheduleForm.test.tsx`. Cover: form prefills from query string; chapel toggle defaults ON for consecration / OFF for interment; submit calls mutation with the right payload; consultant dropdown populated; touch targets meet NFR-A4.
  - [ ] **UPDATE** `tests/unit/convex/lib/scheduling.test.ts` (or the file Story 7.2 created) to cover the chapel + pathway conflict cases.

- [ ] **Task 9: Playwright e2e — schedule + complete a consecration** (AC: 2, AC: 4)
  - [ ] **NEW** `tests/e2e/ceremony-schedule.spec.ts`. Scenario: sign in as office staff → navigate to a contract → click "Schedule consecration" affordance → fill the form → submit → assert calendar shows the new consecration with the chapel + pathway icons → navigate to the detail page → click "Mark consecration complete" → assert status flips → assert audit log records the three actions in order.

### Documentation (AC1, AC2)

- [ ] **Task 10: ADR + runbook + brand HTML update** (AC: 1, AC: 2)
  - [ ] **NEW** `docs/adr/0069-ceremonies-table.md` per Task 1.
  - [ ] **UPDATE** `docs/runbook.md` deployment checklist: include the one-shot `backfillCeremoniesKind` mutation invocation after schema deploy.
  - [ ] **UPDATE** `apostle-paul-brand-guidelines.html` chapter XI faculty xvi (already drafted in the brand-application pass) — flip the "Proposed" stage badge to "In service" once this story lands.

## Dev Notes

### Previous story intelligence

- [Story 7.1 — Office staff schedules an interment](./7-1-office-staff-schedules-an-interment.md) — the existing interment scheduling workflow this story generalises.
- [Story 7.2 — System prevents double-booking](./7-2-system-prevents-double-booking.md) — the conflict-detection helper this story extends to chapel + pathway.
- [Story 7.3 — Office staff views the interment calendar](./7-3-office-staff-views-the-interment-calendar.md) — the calendar surface this story repurposes for both kinds.
- [Story 7.4 — Field worker marks an interment complete](./7-4-field-worker-marks-an-interment-complete.md) — the interment-completion workflow that stays owned by Story 7.4; consecration completion is a simpler office-side gesture.
- [Story 1.4 — Visual foundation locked: StatusPill, ReactiveHighlight ship](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md) — the StatusPill consumes new `consecration` (gold accent) and `interment` (existing) variants.
- [Story 1.6 — Audit log emission helper](./1-6-audit-log-emission-helper.md) — every mutation emits audit; `entityType: "ceremony"` is a new value.
- [Story 1.7 — State machine transition guards](./1-7-state-machine-transition-guards.md) — the ceremony's `status` union (`scheduled → completed | cancelled`) needs a transition guard.
- [Story 2.5 — Customer detail page with ownership history](./2-5-customer-detail-page-with-ownership-history.md) — future enhancement: the customer page surfaces upcoming ceremonies for that customer's contracts.
- [Story 2.9 — Family-estate multi-lot grouping](./2-9-family-estate-multi-lot-grouping.md) — forward-compat: ceremonies can later be anchored to a family estate rather than a single contract; `familyEstateId` column reserved.

### Architecture compliance

- **No multi-table writes outside a single mutation** — the `scheduleCeremony` mutation atomically inserts the row + emits audit. The double-booking guard is read-only inside the mutation; no race window.
- **`requireRole` on every public function** — `scheduleCeremony`, `completeCeremony`, `cancelCeremony`, `getCeremony`, `listCeremonies` all start with `requireRole`.
- **No Node APIs in mutations** — all mutations stay V8-runtime. No actions needed for this story (no PDF, no external HTTP).
- **Brand-aware copy** — the form labels honour the four voice pillars (see [project_brand memory](../../../C:/Users/JENZEN/.claude/projects/c--Users-JENZEN-Documents-Broadheader-cemetery-mapping/memory/project_brand.md)): "Reserve the chapel for this family", "Mark consecration complete", "With reverence, / The Estate Office" sign-off NOT used here (no letter generated).

### Library / framework versions

No new runtime deps. Reuses RHF + Zod ([Story 1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md)), shadcn/ui forms, the existing `<StatusPill>` + `<ReactiveHighlight>` components, the canonical `useMutation` + `useQuery` Convex hooks.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── ceremonies.ts                       # NEW (or UPDATE if renaming interments.ts)
│   ├── internal/
│   │   └── backfillCeremoniesKind.ts       # NEW (one-shot backfill)
│   ├── lib/
│   │   └── scheduling.ts                   # UPDATE (chapel + pathway conflict)
│   └── schema.ts                            # UPDATE (rename + add columns + indexes)
├── src/
│   └── app/(staff)/
│       ├── ceremonies/
│       │   ├── new/page.tsx                # NEW
│       │   ├── [ceremonyId]/page.tsx       # NEW
│       │   └── calendar/page.tsx           # NEW (moved from interments/calendar with 308 redirect)
│       └── interments/calendar/page.tsx    # REMOVE (redirected)
├── src/components/
│   ├── CeremonyScheduleForm/CeremonyScheduleForm.tsx       # NEW
│   ├── MarkConsecrationCompleteDialog/...                  # NEW
│   └── CancelCeremonyDialog/...                            # NEW
├── tests/
│   ├── unit/
│   │   ├── convex/ceremonies.test.ts                       # NEW (or UPDATE interments.test.ts)
│   │   ├── convex/lib/scheduling.test.ts                   # UPDATE (chapel + pathway tests)
│   │   └── components/CeremonyScheduleForm.test.tsx        # NEW
│   └── e2e/ceremony-schedule.spec.ts                       # NEW
├── docs/
│   ├── adr/0069-ceremonies-table.md                        # NEW
│   └── runbook.md                                          # UPDATE (backfill step)
└── apostle-paul-brand-guidelines.html                      # UPDATE (flip faculty xvi badge)
```

### Testing requirements

- **NFR-M2 ≥ 90% line coverage on financial-touching server functions** — ceremonies aren't financial; ≥ 80% coverage on `convex/ceremonies.ts` + `convex/lib/scheduling.ts` extensions is sufficient.
- **The chapel + pathway conflict tests are critical** — a missed conflict means two families arriving at the chapel at the same hour. Cover at least: same-time both-reserved, time-window overlap both-reserved, no overlap both-reserved (no conflict), overlap only one reserved (no conflict).
- **Manila-tz boundary test** — a consecration scheduled at `23:30 Manila` with `durationMinutes: 90` crosses midnight. The conflict detection MUST handle the midnight crossover correctly.

### Source references

- **PRD:** [FR43 — interment scheduling](../planning-artifacts/prd.md#functional-requirements), [FR44 — calendar view](../planning-artifacts/prd.md#functional-requirements).
- **Architecture:** [§ Brand Identity & Visual System](../planning-artifacts/architecture.md#brand-identity--visual-system) — `consecration` ceremony is one of the four brand-implied stories filed 2026-05-22.
- **Brand HTML:** Chapter VI (letterhead example referencing the consecration ceremony) + Chapter XI faculty xvi (proposed-stage definition of this story).
- **UX:** N/A — extends the existing interment scheduling + calendar UX with new toggles and a gold accent variant of `<StatusPill>`.
- **Previous stories:** 7.1, 7.2, 7.3, 7.4 (Epic 7); 1.4, 1.6, 1.7 (Epic 1 foundations); 2.9 (Epic 2 forward-compat).
- **Client decisions:** [Q11 — Cemetery brand identity](../planning-artifacts/client-decisions-defaults.md#q11--cemetery-brand-identity--canonical-address-decided-2026-05-22) — the brand voice this story's copy honours.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT skip the kind-agnostic lot conflict test.** If the conflict detection becomes kind-aware ("consecration doesn't block an interment") the system will silently double-book the same lot — a family arrives to find a hole being dug for someone else.
- ❌ **Do NOT model `chapelReserved` / `pathwayReserved` as free-text "resource" strings.** Multiple resources, free-text keys, soft schema → conflict detection that misses bookings. Hard-coded booleans on the row are the right shape until a real resource-registry story lands.
- ❌ **Do NOT default consecration's chapel-reserved to false.** The brand-spec letterhead explicitly states "The chapel and pathway will be reserved exclusively for your family from sunrise." Defaulting to false invites the operator to forget the most important booking on the row.
- ❌ **Do NOT delete the old `/interments/calendar` route abruptly.** Add a 308 redirect; bookmarks + email-sent calendar links survive the rename.
- ❌ **Do NOT couple consecration to family-estates (Story 2.9) before that story ships.** Reserve the `familyEstateId` column but leave it optional and unused until 2.9 lands; coupling now would block this story behind 2.9.
- ❌ **Do NOT bypass `requireRole`** on the new mutations. Field workers can `completeCeremony` for interments only; consecration completion is office-side per AC4.
- ❌ **Do NOT emit a `ceremony_scheduled` audit row without the `kind` field.** Audit-log filter UI from [Story 6.5](./6-5-admin-views-the-audit-log.md) needs to distinguish consecration scheduling from interment scheduling.

### Common LLM-developer mistakes to prevent

- **Renaming the table with `convex/schema.ts` ALONE.** Convex schema changes don't migrate live data; the one-shot internal mutation must run AFTER deploy. Skipping the backfill means existing rows have no `kind` field → reads break on the union validator.
- **Forgetting the time-window arithmetic.** A 90-minute consecration starting at 09:00 overlaps a 60-minute interment starting at 10:30 if the latter starts <= start + 90 minutes. Use `[a.start, a.start + a.duration) ∩ [b.start, b.start + b.duration) ≠ ∅` — not pointwise comparison.
- **Treating "no consultant" as an error.** The consultant is OPTIONAL on the row — sometimes the family hasn't been assigned one yet. Don't `throwError` on missing consultant; surface a "(unassigned)" placeholder on the detail page.
- **Hard-coding "08:00 Manila" as a string.** Use the existing Manila-tz helpers in `convex/lib/time.ts` — same pattern as the AR aging cron uses for "00:00 Manila".
- **Letting the calendar query return EVERY ceremony.** Pagination + indexed range queries. The `by_kind_scheduledAt` index supports `q => q.eq("kind", k).gte("scheduledAt", from).lte("scheduledAt", to)`.

### Open questions / blockers this story does NOT resolve

- **§10 Q? — Are consecrations a billable line-item?** The brand example treats consecration as part of the family-estate purchase ("scheduled for the morning of the twenty-eighth"), implying free. If the cemetery later wants to charge for ceremony hosting (catering, extra chairs, audio), that's a separate billing story.
- **What about a memorial-anniversary ceremony?** The `kind` union includes it as forward-compat, but no UI surfaces a "schedule a 1-year memorial" affordance yet. Defer to a future Epic 7 extension.
- **Family-estate scope** — when [Story 2.9](./2-9-family-estate-multi-lot-grouping.md) ships, the consecration form's "anchoring lot" picker should optionally accept a family estate. The `familyEstateId` column is reserved but the picker UI is deferred.
- **Notification to the consultant** — should the assigned consultant receive an email/SMS notification when a consecration is scheduled? Deferred to the Phase-2 reminders story that owns ad-hoc operator notifications.

### Project structure notes

Aligns with the existing Epic 7 file layout. The rename of `interments` → `ceremonies` is the largest single change in this story; isolated to a single PR for atomicity.

### References

- [PRD § FR43, FR44](../planning-artifacts/prd.md#functional-requirements).
- [Architecture § Brand Identity & Visual System](../planning-artifacts/architecture.md#brand-identity--visual-system).
- [Brand HTML — chapter VI letterhead example + chapter XI faculty xvi](../../apostle-paul-brand-guidelines.html).
- [Client decisions Q11 — cemetery brand identity](../planning-artifacts/client-decisions-defaults.md#q11--cemetery-brand-identity--canonical-address-decided-2026-05-22).
- Previous stories: [7.1](./7-1-office-staff-schedules-an-interment.md), [7.2](./7-2-system-prevents-double-booking.md), [7.3](./7-3-office-staff-views-the-interment-calendar.md), [7.4](./7-4-field-worker-marks-an-interment-complete.md), [2.9](./2-9-family-estate-multi-lot-grouping.md), [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.6](./1-6-audit-log-emission-helper.md), [1.7](./1-7-state-machine-transition-guards.md).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (2026-05-24)

### Debug Log References

- Schema edit retried twice because a parallel linter modified `convex/schema.ts` between Read and Edit; the third Edit succeeded after a fresh Read.

### Completion Notes List

- **(a) Option chosen — Option B (parallel `ceremonies` table next to `interments`).** Documented in `docs/adr/0069-ceremonies-table.md`. The rename in Option A would touch 37+ files (convex domain, components, page routes, tests, even `.next/` artifacts) and the parallel-agent workflow this sprint runs under made the merge-conflict risk material. The booking-conflict guard at `convex/lib/scheduling.ts:assertNoBookingConflict` queries BOTH tables so the cross-kind lot-overlap guarantee is identical to Option A's. The ADR documents the reversibility path (a future story can consolidate by backfilling legacy interments into the new table).
- **(b) Backfill mutation invocation log.** Under Option B the `ceremonies` table ships empty (no legacy data to backfill), so `npx convex run internal/backfillCeremoniesKind:run` returns `{ scanned: 0, patched: 0, skipped: 0 }`. The harness ships now so a future Option-A consolidation drops in the real scan logic without a new file landing.
- **(c) Deferred from ADR-0069:** family-estate (`familyEstateId`) is typed `v.optional(v.string())` rather than `v.optional(v.id("familyEstates"))` because Story 2.9 has not yet introduced the `familyEstates` table; Story 2.9's follow-up PR tightens the validator. Playwright e2e + the rich `<CeremonyScheduleForm>` / `<MarkConsecrationCompleteDialog>` / `<CancelCeremonyDialog>` component split deferred — the new `/ceremonies/new` and `/ceremonies/[id]` pages embed their own form + cancel-dialog inline to minimise the surface this story pulls into review. Brand HTML chapter XI faculty xvi "In service" badge flip also deferred (the HTML file is in another agent's ownership lane).
- **(d) Gates:** see below.

### File List

**New:**
- `convex/ceremonies.ts` — scheduleCeremony / completeCeremony / cancelCeremony / getCeremony / listCeremonies
- `convex/lib/scheduling.ts` — assertNoBookingConflict (lot / chapel / pathway overlap, queries both tables)
- `convex/internal/backfillCeremoniesKind.ts` — idempotent internal mutation (Option B no-op harness)
- `src/app/(staff)/ceremonies/page.tsx` — index redirect to /ceremonies/calendar
- `src/app/(staff)/ceremonies/new/page.tsx` — schedule form
- `src/app/(staff)/ceremonies/[ceremonyId]/page.tsx` — detail + complete + cancel
- `src/app/(staff)/ceremonies/calendar/page.tsx` — combined consecrations + interments list view
- `docs/adr/0069-ceremonies-table.md` — Option B decision record
- `tests/unit/convex/ceremonies.test.ts` — mutation + query suite
- `tests/unit/convex/lib/scheduling.test.ts` — conflict-guard cases (lot / chapel / pathway / cross-kind)
- `tests/unit/convex/internal/backfillCeremoniesKind.test.ts` — idempotency

**Modified:**
- `convex/schema.ts` — appended `ceremonies` table with indexes
- `convex/lib/errors.ts` — added `SCHEDULING_CONFLICT` code
- `src/lib/errors.ts` — mirrored SCHEDULING_CONFLICT into client translation
- `src/components/Sidebar/nav-items.ts` — added "Ceremonies" nav item
- `next.config.ts` — appended 308 `/interments/calendar` → `/ceremonies/calendar`
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — added 7-5 row
