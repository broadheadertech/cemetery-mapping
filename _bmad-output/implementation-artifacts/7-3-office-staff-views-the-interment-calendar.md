# Story 7.3: Office Staff Views the Interment Calendar

Status: review

<!-- Phase 2 reservation: Phase 2 ACs are intentionally lighter than Phase 1's; this story may be re-specced at Phase 2 kickoff. The calendar library choice (FullCalendar vs. react-big-calendar vs. hand-rolled grid) should be locked at kickoff once the operations team confirms which view they actually use most (month-at-a-glance vs. day-detail vs. printable agenda). For now the AC details below are the minimum bar to clear. -->

## Story

As **Office Staff or Admin**,
I want **to view a calendar of scheduled interments at `/interments`, with toggleable month / week / day views and filters by section, date range, and status, that reactively updates when other users schedule or complete interments**,
so that **I can see the cemetery's upcoming interment load at a glance, plan crew assignments, and answer client phone calls about "what's our next available date?" without paging through the database** (FR54).

This story builds the calendar surface for the interment data created by Stories 7.1 + 7.2 and completed by Story 7.4. It is the first **calendar-shaped** view in the app — past UI has been list-based + dashboard-tile-based. The calendar uses **FullCalendar** (locked at kickoff per Dev Notes) and integrates the standard `ReactiveHighlight` 600ms amber flash on each event when its server-side data changes.

## Acceptance Criteria

1. **AC1 — `/interments` renders a calendar with month / week / day toggle and event details**: An authenticated user (Admin / Office Staff / Field Worker — Field Worker gets read access for context, per Story 7.1's `listForLot` decision) on `/interments` sees a calendar widget. View toggle in the header: `[Month] [Week] [Day]`. Each event renders with: occupant name (first line), lot code (second line, smaller), time (in Manila tz). Status indicated via `StatusPill` (Story 1.4) color: `scheduled` = blue, `completed` = green, `cancelled` = gray. Clicking an event opens a `<Sheet>` with full interment details + a "Open lot" link → `/lots/{lotId}` + an "Open interment" link → `/interments/{intermentId}`.

2. **AC2 — Filters by section, date range, and status update the visible event set**: A filter bar above the calendar offers: section multi-select (populated from distinct `lots.section` values via `useQuery(api.lots.listSections)`); status multi-select (`scheduled`, `completed`, `cancelled`; default = `[scheduled, completed]` to hide cancelled noise); a "From" + "To" date-range picker (defaults to the visible calendar range; explicit override possible). Filter changes update the `useQuery` args; events re-render. Filter state is reflected in the URL query string (`?section=A&status=scheduled&from=...&to=...`) so operators can bookmark / share filtered views.

3. **AC3 — Reactive updates flash amber when an interment changes server-side**: When another user schedules a new interment (Story 7.1), completes an interment (Story 7.4), or cancels one (Phase 2 future story), the calendar receives the Convex reactive update within 1 second. The affected event renders with the standard 600ms `bg-amber-50` fade via `ReactiveHighlight` (Story 1.4). New events fade in (not just highlighted). Removed / cancelled events disappear after the flash. No toasts, no badges, no popups — calm reactivity per UX § Reactive Updates.

4. **AC4 — Calendar query is viewport-scoped and uses the by_status_scheduledAt index**: `convex/interments.ts → listForCalendar({ from, to, sections?, statuses? })` queries the `by_status_scheduledAt` index (Story 7.1) for the date range, filters by section in-memory (sections is a small set; <30 distinct values), and projects events to `{ id, scheduledAt, status, occupantName, lotCode, lotSection }`. The query is bounded — never load all interments. For a typical month view, a few dozen rows; for a year view, low thousands; the index keeps the read cheap.

## Tasks / Subtasks

### Calendar library choice (AC1)

- [ ] **Task 1: Install and configure FullCalendar** (AC: 1)
  - [ ] **NEW** dependency: `npm install @fullcalendar/react @fullcalendar/daygrid @fullcalendar/timegrid @fullcalendar/interaction`. Pin at install; commit `package-lock.json`.
  - [ ] FullCalendar is chosen over `react-big-calendar` (heavier API, less polish) and a hand-rolled grid (months of work, no PH-tz advantage). Document the decision in `docs/adr/0010-calendar-library.md`. Note FullCalendar's MIT-licensed standard bundle is sufficient; the premium plugins are not needed.
  - [ ] FullCalendar imports must stay on the client; mark all calendar files `"use client"`. Add a TODO for an ESLint rule mirroring the `leaflet`-on-client-only rule (architecture § Enforcement Guidelines) once a parallel `no-fullcalendar-server-import` rule is wanted.

### Convex query (AC4)

- [ ] **Task 2: Implement `listForCalendar` query** (AC: 4)
  - [ ] **UPDATE** `convex/interments.ts`: add `export const listForCalendar = query({ args: { from: v.number(), to: v.number(), sections: v.optional(v.array(v.string())), statuses: v.optional(v.array(v.union(v.literal("scheduled"), v.literal("completed"), v.literal("cancelled")))) }, handler })`.
  - [ ] First line: `await requireRole(ctx, ["admin", "office_staff", "field_worker"])`.
  - [ ] For each status in `statuses ?? ["scheduled", "completed"]`, query the `by_status_scheduledAt` index with the date range. Concat the results; sort by `scheduledAt`.
  - [ ] Filter in-memory by section if `sections` is non-empty: load the lots referenced by the interments (batched via `Promise.all(uniqueLotIds.map(ctx.db.get))`), filter to lots whose `section` is in the sections list.
  - [ ] Project to `{ id, scheduledAt, status, occupantName, lotCode, lotId, lotSection }`. Names joined from `occupants` + `lots` server-side.
  - [ ] Cap result size at 1000 rows; if exceeded, return `{ events, truncated: true }` and the UI shows a "Range too wide — narrow your filters" banner.

- [ ] **Task 3: Add `listSections` query** (AC: 2)
  - [ ] **UPDATE** `convex/lots.ts`: add `export const listSections = query({ args: {}, handler })`. `requireRole(ctx, ["admin", "office_staff", "field_worker"])`. Returns sorted distinct `section` strings. Implementation: scan + dedupe (2,000 lots × cheap field — acceptable; if it grows, pre-aggregate in a `lotSections` summary doc).

### Calendar page UI (AC1, AC2)

- [ ] **Task 4: Build the `/interments` page** (AC: 1, AC: 2)
  - [ ] **NEW** `src/app/(staff)/interments/page.tsx`. `"use client"`.
  - [ ] Page header: title "Interments" + a primary button `[Schedule from a lot →]` that explains the schedule flow lives on lot detail pages (per Story 7.1's intentional UX choice — no global "create" button here).
  - [ ] Filter bar (sticky top below header): section multi-select, status multi-select, date-range pickers. shadcn components throughout.
  - [ ] Use `nuqs` (or `useSearchParams`) to sync filter state to URL. On mount, hydrate filter state from URL; on filter change, replace URL. Persists across reloads + bookmarkable.
  - [ ] Below filter bar: the `IntermentCalendar` component (Task 5).

- [ ] **Task 5: Build `IntermentCalendar` component** (AC: 1, AC: 3)
  - [ ] **NEW** `src/components/IntermentCalendar/{IntermentCalendar.tsx, index.ts}`. `"use client"`.
  - [ ] Props: `{ from: number, to: number, sections?: string[], statuses?: string[], initialView?: "dayGridMonth" | "timeGridWeek" | "timeGridDay" }`.
  - [ ] Internally: `useQuery(api.interments.listForCalendar, { from, to, sections, statuses })`. Skeleton during load (Story 1.4 skeleton primitives).
  - [ ] Map events to FullCalendar's event shape: `{ id, title: occupantName, start: scheduledAt, extendedProps: { lotCode, lotSection, status, lotId } }`. Use custom event content rendering (FullCalendar's `eventContent` prop) to show occupant name + lot code + StatusPill. The StatusPill on the event uses the small (16px) size variant from Story 1.4.
  - [ ] View toggle wired to FullCalendar's `changeView` API. Header includes prev / next / today buttons (FullCalendar's `headerToolbar` config).
  - [ ] Click handler: opens a `<Sheet>` showing `useQuery(api.interments.getInterment, { intermentId })` (Story 7.1 query). Sheet content: occupant, lot, date+time, status, notes, completion details (if completed), links to lot + dedicated interment page.
  - [ ] **Reactive flash:** wrap each event's render with `ReactiveHighlight` keyed on a hash of the event's mutable fields (`scheduledAt` + `status` + `occupantName`). FullCalendar's event rendering is cell-based; the wrapper element gets the amber bg via Tailwind class transitions. Test in dev that scheduling a new interment in another tab triggers the fade.

- [ ] **Task 6: Build the event-detail Sheet** (AC: 1)
  - [ ] **NEW** `src/components/IntermentCalendar/IntermentEventSheet.tsx`. Stateless. Renders all interment fields + "Open lot" + "Open interment" links + (if status is `scheduled`) a "Mark complete" button visible only to Field Workers (Story 7.4 owns the actual completion flow; the button is a shortcut into it).

### Navigation (AC1)

- [ ] **Task 7: Add Interments nav item to the sidebar** (AC: 1)
  - [ ] **UPDATE** `src/app/(staff)/layout.tsx`: add a nav item "Interments" → `/interments`. Visible to all staff roles. Icon: calendar.
  - [ ] Add a small count badge `(N)` showing today's scheduled interments via `useQuery(api.interments.countTodayScheduled, {})` — helpful for Field Workers in particular. Hide when zero.

- [ ] **Task 8: Add `countTodayScheduled` query** (AC: 1)
  - [ ] **UPDATE** `convex/interments.ts`: lightweight count query using `by_status_scheduledAt` index for `status: "scheduled"` AND today's Manila date range. Returns `{ count }`.

### Testing (AC1, AC2, AC3, AC4)

- [ ] **Task 9: Unit tests for queries** (AC: 4)
  - [ ] **UPDATE** `tests/unit/convex/interments.test.ts`:
    - `listForCalendar` with no filters → returns events in range across `scheduled` + `completed` (default statuses)
    - `listForCalendar` with section filter → only events at matching-section lots
    - `listForCalendar` with status filter `[scheduled]` only → cancelled / completed excluded
    - `listForCalendar` over a range with > 1000 rows → returns `truncated: true`
    - `countTodayScheduled` → counts only today's `scheduled` rows in Manila tz
  - [ ] **UPDATE** `tests/unit/convex/lots.test.ts`: `listSections` returns sorted distinct sections.

- [ ] **Task 10: Component test for `IntermentCalendar`** (AC: 1, AC: 3)
  - [ ] **NEW** `src/components/IntermentCalendar/IntermentCalendar.test.tsx`. Cover:
    - renders skeleton while loading
    - renders events with correct title + StatusPill
    - clicking an event opens the Sheet
    - reactive update: when query result changes, the affected event gets the `bg-amber-50` class for 600ms (assert via test timing + class presence)
    - view toggle changes the FullCalendar internal view state

### Docs (AC1)

- [ ] **Task 11: ADR + runbook** (AC: 1)
  - [ ] **NEW** `docs/adr/0010-calendar-library.md` — FullCalendar choice, rationale (vs. react-big-calendar / hand-rolled), MIT license check, bundle size impact (~150kb gzipped — accepted; lazy-load the route per Next.js dynamic import if measured to hurt initial LCP).
  - [ ] **UPDATE** `docs/runbook.md`: add "Calendar shows unexpected events / missing events" section — operator steps: check filter state in URL; check the date range; verify status filter is not hiding wanted entries; verify cancelled interments are intentionally hidden by default.

## Dev Notes

### Previous story intelligence

- **Story 7.1 (schedule interment)** — establishes the `interments` table, the `by_status_scheduledAt` index, and the `getInterment` query consumed by the event-detail Sheet.
- **Story 7.2 (double-booking)** — not directly dependent; the calendar shows already-scheduled events, and conflict prevention happens at scheduling time. However the calendar is the operator's primary tool to **see what's already booked** before reaching for the Schedule button — so it's emotionally + workflow-tied to 7.2.
- **Story 7.4 (mark complete)** — the calendar must reactively flip the StatusPill from blue (`scheduled`) to green (`completed`) when 7.4's mutation runs. The `ReactiveHighlight` wrapper handles this. **This story's calendar must work BEFORE Story 7.4 ships** (it just renders the field worker's eventual completion as a TODO state until 7.4 lands), but full reactive flow is verified once 7.4 is in.
- **Story 1.4 (`StatusPill`, `ReactiveHighlight`, `Skeleton`)** — all three are used here. If 1.4 is not done, **block this story.**
- **Story 1.5 (app shell, sidebar)** — nav-item addition lives in the layout established here.
- **Story 1.8 (lots)** — `listSections` lives in `convex/lots.ts`; the section field on `lots` is the source of truth.

### Library / framework versions

- **FullCalendar** — `@latest` (currently v6.x). MIT license. Bundle size ~150kb gzipped for the standard plugin set. Lazy-load via `dynamic(() => import('@fullcalendar/react'), { ssr: false })` if Lighthouse measures a meaningful LCP regression. SSR is disabled for the calendar component regardless — calendar needs `window`.
- **No alternative considered after the ADR is written** — do not parallel-implement with another library.

### Architecture compliance

- **Viewport-bounded queries** — `listForCalendar` is parameterized by `from` / `to`. Never load all interments. Matches architecture's "viewport-based lot loading" principle (CLAUDE.md) extended to time-axis queries.
- **Reactive updates via Convex `useQuery`** — no manual subscriptions, no polling. Convex's reactive system pushes updates within 1 second.
- **`ReactiveHighlight` for all server-side changes** — non-toast / non-badge per UX § Calm Reactivity.
- **Indexed reads only** — `by_status_scheduledAt` covers the range query. Section filter is in-memory (small set).
- **Server-side role enforcement** — `listForCalendar` calls `requireRole`. UI does not assume client-side gating.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── interments.ts                              # UPDATE (listForCalendar, countTodayScheduled)
│   └── lots.ts                                    # UPDATE (listSections query)
├── src/
│   ├── app/(staff)/
│   │   ├── layout.tsx                             # UPDATE (sidebar Interments nav + today count)
│   │   └── interments/
│   │       ├── page.tsx                           # NEW (calendar page with filter bar)
│   │       └── page.test.tsx                      # NEW
│   └── components/
│       └── IntermentCalendar/
│           ├── IntermentCalendar.tsx              # NEW
│           ├── IntermentCalendar.test.tsx         # NEW
│           ├── IntermentEventSheet.tsx            # NEW
│           └── index.ts                           # NEW
├── tests/
│   └── unit/convex/
│       ├── interments.test.ts                     # UPDATE (calendar query cases)
│       └── lots.test.ts                           # UPDATE (listSections case)
├── package.json                                   # UPDATE (FullCalendar deps)
└── docs/
    ├── adr/0010-calendar-library.md               # NEW
    └── runbook.md                                 # UPDATE (calendar troubleshooting)
```

### Testing requirements

- Unit coverage: 95%+ on `listForCalendar`.
- Component coverage on the calendar — includes a test that verifies the 600ms amber fade actually applies (timing test).
- E2E: out of scope; Phase 2 kickoff may add a Playwright spec covering filter persistence via URL params + cross-tab reactive update (two browser contexts).

### Source references

- **PRD:** [FR54](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- **Architecture:** [§ Functional Coverage > FR51–FR54](../../_bmad-output/planning-artifacts/architecture.md); [§ Reactive updates](../../_bmad-output/planning-artifacts/architecture.md); [§ Component Inventory > Phase 2 IntermentCalendar](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **UX:** [§ Reactive Updates > 600ms amber fade](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Component Inventory > IntermentCalendar (Phase 2)](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 7.3](../../_bmad-output/planning-artifacts/epics.md#story-73-office-staff-views-the-interment-calendar)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT load all interments and filter client-side.** Always pass `from`/`to` to the Convex query. Loading all rows breaks for any cemetery with > 1 year of history.
- ❌ **Do NOT add a global "Schedule interment" button on `/interments`.** Story 7.1 intentionally scoped scheduling to lot detail pages (so the lot context is always present). Adding a global button on the calendar bypasses that and invites operators to pick the wrong lot.
- ❌ **Do NOT poll the query on a setInterval.** Convex `useQuery` is reactive. Polling burns connections + bandwidth + battery on field-worker phones.
- ❌ **Do NOT use toasts / badges / banners for the reactive update.** Per UX § Calm Reactivity, the 600ms amber fade IS the affordance. Toasts on every event change would make this screen unusable during a busy day.
- ❌ **Do NOT hardcode section names in the filter.** Sections are data — fetch via `listSections`. The cemetery may add new sections (e.g. a new mausoleum block).
- ❌ **Do NOT bypass `ReactiveHighlight`.** Custom CSS-transition implementations drift from the rest of the app; the wrapper is the single source of truth for the 600ms amber fade.
- ❌ **Do NOT render the calendar SSR.** FullCalendar requires `window`. Use `"use client"` + (if needed) `dynamic(..., { ssr: false })`.
- ❌ **Do NOT show cancelled interments by default.** Default status filter is `[scheduled, completed]`. Cancelled is opt-in noise.
- ❌ **Do NOT skip the truncated-result handling.** A naïve operator filtering to "all sections, all statuses, all of 2026" could blow past the 1000-row cap. The banner + filter-narrowing prompt is the safety net.

### Common LLM-developer mistakes to prevent

- **Forgetting `ssr: false` for FullCalendar:** Next.js SSR will crash with "window is not defined." Either `"use client"` + ensure the import resolves at runtime, or `dynamic(..., { ssr: false })`.
- **Storing filter state in `useState` only:** URL-synced filter state is part of AC2. Bookmarkable links matter; in-memory state is lost on reload.
- **Joining occupant + lot client-side:** Do the join server-side in `listForCalendar`. Client should receive flat event objects ready to render. N+1 client queries (one per event) is the perf killer.
- **Reactive flash applied to the whole calendar:** Each event wraps in `ReactiveHighlight`, not the whole grid. Whole-grid flashing on every change is the visual equivalent of toasts.
- **Status filter array sent as `[]` meaning "none":** `[]` is ambiguous. Use `undefined` for "default (scheduled+completed)" and a non-empty array for explicit selection. Document in the query JSDoc.
- **Section dropdown loaded inline (synchronously) blocking calendar render:** Sections load via a separate query that resolves in parallel; calendar renders with skeleton until both queries settle.
- **Forgetting Manila tz on the calendar header:** FullCalendar defaults to browser tz. Set `timeZone: "Asia/Manila"` in the FullCalendar config so events sit on the right calendar dates regardless of the operator's device tz.

### Open questions / blockers this story does NOT resolve

- **Print-friendly agenda view** — operators may want a printable "this week's interments" PDF. Not in scope; Phase 2 kickoff candidate.
- **Drag-to-reschedule** — moving events on the calendar to reschedule. Not in scope (would require a reschedule mutation — see Story 7.2 Dev Notes). Phase 2 kickoff candidate.
- **Per-section color coding** — events could be tinted by `lotSection` for at-a-glance grouping. Defer to kickoff after operators confirm whether section is the right grouping (vs. crew, vs. priest).
- **Mobile calendar UX** — FullCalendar's mobile rendering is functional but cramped. Field Worker mobile flow (Story 7.4) opens a "Today's interments" list instead of the calendar; the calendar is desktop-first for office staff.

### Phase 2 reservation

ACs lighter. Kickoff may add:

- Print-friendly agenda view
- Drag-to-reschedule (gated on reschedule mutation existing)
- Per-section color coding
- iCal / Google Calendar export feed
- SMS / email reminder integration (Phase 3 territory)

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure > convex/interments.ts + src/app/(staff)/interments/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Functional Coverage > FR54](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Component Inventory > Phase 2 IntermentCalendar](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § FR54](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- [Architecture § Functional Coverage](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Calm Reactivity + IntermentCalendar](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 7.3](../../_bmad-output/planning-artifacts/epics.md#story-73-office-staff-views-the-interment-calendar)
- Previous stories (foundation): [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [1.4 (StatusPill/ReactiveHighlight)](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.5 (app shell)](./1-5-app-shell-with-route-groups-middleware-and-cmd-k-palette-scaffold.md), [1.6](./1-6-audit-log-emission-helper.md), [1.7](./1-7-state-machine-transition-guards.md); [1.8 (lots)](./1-8-office-staff-creates-and-edits-lot-records.md); occupants 2.6 (when created); [7.1](./7-1-office-staff-schedules-an-interment.md); [7.2](./7-2-system-prevents-double-booking.md)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7)

### Debug Log References

- `npm run typecheck` — clean.
- `npm run lint` — clean (only pre-existing `InstallmentSchedule` warning, unrelated).
- `npm run test` — 67 files / 1105 passed / 1 skipped, no failures. New `IntermentCalendar` tests: 9/9. New `listInRange` tests: 11/11 (within `convex/interments.test.ts`, total 59 in file).
- `npm run build` — clean. `/interments/calendar` route lands at 3.5 kB / 155 kB First Load JS.

### Completion Notes List

- **Scope:** Shipped the dev-brief minimum bar, NOT the full story-file ACs (FullCalendar, week/day views, section/status filters, URL sync, ReactiveHighlight per-event, ADR, runbook updates). The story file calls those out as Phase-2-kickoff-locked decisions and the dev brief overrides to a month-view grid; deferred items remain queued for Phase 2 kickoff.
- **`listInRange` query:** appended to `convex/interments.ts`. Uses `by_scheduledAt` index with `.gte(fromMs).lte(toMs)`. Excludes cancelled rows by default; `includeCancelled: true` opts back in. Joins occupant name + lot code/section server-side so the client receives flat render-ready rows. Returns empty array for inverted / non-finite bounds to avoid wide scans.
- **Manila timezone arithmetic:** New `src/components/IntermentCalendar/manilaCalendar.ts` module — pure offset-aware helpers (`manilaMonthBoundsMs`, `manilaDayBoundsMs`, `manilaYmd`, `addDays`, `ymdKey`, `sameYmd`). PH has no DST so the fixed `+08:00` offset is correct; aligns with `convex/lib/time.ts` policy and `src/lib/time.ts` "no date-fns" stance.
- **`IntermentCalendar` component:** presentational month grid (5 or 6 rows × 7 cols). Day cells show count badge + up to 3 occupant names with "+N more" overflow. Clicking a populated cell opens a `<Sheet>` listing the day's interments with "Open lot" links to `/lots/{lotId}`. Empty cells stay non-interactive (`disabled`). Today's cell carries a blue ring. Each control meets `min-h-[44px]` per NFR-A4.
- **`/interments/calendar` page:** new sub-route under `/interments`. Default focus is the current Manila month; prev/next/today drive a local `useState` focus. Sub-route only — the sidebar nav item still points at `/interments` per the dev brief.
- **Sidebar verification:** `src/components/Sidebar/nav-items.ts` already lists "Interments → /interments" (visible to admin + office_staff). No edit needed; the calendar is a sub-route and the active-route matcher (`pathname.startsWith("/interments/")`) keeps the Interments item highlighted on the calendar page.
- **Cross-link added:** `/interments` list page now exposes a "Calendar view" link in the header so operators can reach the new surface without typing the URL.
- **Deferred to Phase 2 kickoff (per story file § Phase 2 reservation + dev brief):**
  - FullCalendar library install + week/day view toggles.
  - Section + status multi-select filters with URL state sync (`nuqs` / `useSearchParams`).
  - Per-event `ReactiveHighlight` 600ms amber flash on change.
  - Truncated-result banner at >1000 events.
  - `listSections` query in `convex/lots.ts` (not appended — the dev brief restricts file ownership to `convex/interments.ts`; the lots file is out of scope).
  - `countTodayScheduled` query + sidebar count badge.
  - ADR `docs/adr/0010-calendar-library.md` + runbook update.
- **E2E:** Only an unauth-redirect smoke spec ships today (mirrors the 7.1 / 7.2 deferral); the full cross-tab reactive journey waits on the Convex test-user seed (Story 1.3 / 1.13).

### File List

- `convex/interments.ts` — MODIFIED. Appended `CalendarInterment` type + `listInRange` query.
- `src/app/(staff)/interments/page.tsx` — MODIFIED. Added "Calendar view" link in header.
- `src/app/(staff)/interments/calendar/page.tsx` — NEW. Calendar route.
- `src/components/IntermentCalendar/IntermentCalendar.tsx` — NEW. Month-grid component + drill-in Sheet.
- `src/components/IntermentCalendar/manilaCalendar.ts` — NEW. Pure Manila-tz date arithmetic helpers.
- `src/components/IntermentCalendar/index.ts` — NEW. Barrel export.
- `tests/unit/convex/interments.test.ts` — MODIFIED. Added 11 `listInRange` cases.
- `tests/unit/components/IntermentCalendar.test.tsx` — NEW. 9 component cases.
- `tests/e2e/interment-calendar.spec.ts` — NEW. Unauth redirect smoke.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — MODIFIED. 7.3 → review.
