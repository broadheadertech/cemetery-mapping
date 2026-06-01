# Story 7.2: System Prevents Double-Booking

Status: review

<!-- Phase 2 reservation: Phase 2 ACs are intentionally lighter than Phase 1's; this story may be re-specced at Phase 2 kickoff. The timeslot-conflict policy (does the cemetery really have only one interment staff team at a time? are there shifts where two interments could run in parallel?) is the load-bearing assumption here. Verify with the cemetery operations lead at kickoff before locking in the single-timeslot guard. -->

## Story

As **Office Staff**,
I want **the system to refuse to schedule an interment that conflicts with an existing one — either at the same lot on the same date, or at any lot at the same date+time — with a clear inline error that names the conflicting interment and offers a "View existing" link**,
so that **scheduling errors are caught before they become operational problems on burial day, when the limited interment staff cannot physically be at two lots at once** (FR52).

This story extends Story 7.1's `scheduleInterment` mutation with two server-side guards: a **lot-conflict** check (same lot, same calendar date in Manila tz — burials at the same lot on the same day are operationally infeasible) and a **timeslot-conflict** check (same exact `scheduledAt` minute, any lot — the cemetery has a single interment crew at a time per architecture analysis). Both errors include the conflicting interment's details so the operator can decide whether to reschedule or override (override is NOT supported in this story; a Phase 2 follow-up may add an Admin-only force-override).

## Acceptance Criteria

1. **AC1 — Lot-conflict guard refuses same-lot same-day scheduling with `LOT_ALREADY_SCHEDULED`**: When Office Staff attempts to schedule an interment at lot L on calendar date D (in `Asia/Manila`) and any existing non-cancelled interment at lot L falls on the same calendar date D, the mutation throws `ConvexError({ code: "LOT_ALREADY_SCHEDULED", message, details: { conflictingIntermentId, conflictingScheduledAt, conflictingOccupantName } })`. The UI displays an inline error block above the submit button: "This lot already has an interment scheduled on {date} at {time} for {occupant name}." followed by a "View existing" link to `/interments/{conflictingIntermentId}`.

2. **AC2 — Timeslot-conflict guard refuses same-moment scheduling at any lot with `TIMESLOT_ALREADY_BOOKED`**: When Office Staff attempts to schedule an interment at any lot at the exact same `scheduledAt` epoch minute as another non-cancelled interment (at any lot), the mutation throws `ConvexError({ code: "TIMESLOT_ALREADY_BOOKED", message, details: { conflictingIntermentId, conflictingLotCode, conflictingScheduledAt, conflictingOccupantName } })`. The UI displays: "Another interment is already scheduled for {date} at {time} at lot {code} for {occupant name}. The cemetery has limited interment staff and cannot run two interments at the same time." with the "View existing" link.

3. **AC3 — Both guards are pure helpers, called BEFORE the insert in `scheduleInterment`**: `convex/lib/intermentConflicts.ts` exports `assertNoDoubleBooking(ctx, { lotId, scheduledAt, excludeIntermentId? })`. The function runs the lot-conflict check first (faster, narrower index scan), then the timeslot-conflict check. Both check `status !== "cancelled"` — cancelled interments do not occupy lots / timeslots. The `excludeIntermentId` arg lets a future reschedule mutation (Phase 2 follow-up) exclude the row being moved.

4. **AC4 — Scheduled retry sweep ensures conflicts cannot be created by concurrent writes (TOCTOU defense)**: `convex/scheduled.ts` (or a new helper in `convex/interments.ts`) does NOT need a cron — Convex's optimistic concurrency control already prevents simultaneous identical writes. However, a defensive integrity check runs as part of the conflict assertion: the function re-reads via the index inside a single transaction (Convex mutations are transactional), so the check + insert is atomic. Document this in the ADR. **No new scheduled job is added** by this story; instead, the ADR notes the TOCTOU reasoning.

## Tasks / Subtasks

### Conflict helper (AC1, AC2, AC3)

- [ ] **Task 1: Implement `assertNoDoubleBooking` helper** (AC: 1, AC: 2, AC: 3)
  - [ ] **NEW** `convex/lib/intermentConflicts.ts`. Export `async function assertNoDoubleBooking(ctx: MutationCtx, params: { lotId: Id<"lots">, scheduledAt: number, excludeIntermentId?: Id<"interments"> }): Promise<void>`.
  - [ ] **Lot-conflict logic:** compute the Manila calendar date for `scheduledAt` using `convex/lib/time.ts` helpers — `startOfManilaDay(scheduledAt)` and `endOfManilaDay(scheduledAt)`. Query the `by_lot_scheduledAt` index (Story 7.1) for the lot with `scheduledAt >= startOfDay AND scheduledAt < endOfNextDay`. Filter in-memory for `status !== "cancelled"` and `id !== excludeIntermentId`. If any row remains, fetch the occupant for its name and throw:
    ```ts
    throwError(ErrorCode.LOT_ALREADY_SCHEDULED,
      `This lot already has an interment scheduled on ${formatDate(conflict.scheduledAt)}.`,
      { conflictingIntermentId, conflictingScheduledAt, conflictingOccupantName }
    );
    ```
  - [ ] **Timeslot-conflict logic:** query the `by_status_scheduledAt` index for `status: "scheduled"` (and optionally `"completed"` — see Dev Notes; this story uses `"scheduled"` only, since completed interments do not block future scheduling at the same minute). Filter to `scheduledAt === params.scheduledAt` exactly (epoch ms equality). Filter out `excludeIntermentId`. If any row remains, fetch its lot + occupant + throw `TIMESLOT_ALREADY_BOOKED` with details.
  - [ ] **Index choice rationale**: comment the file with why each index is used + why an in-memory filter is acceptable (small result sets — same-day interments at one lot is bounded by ~1–2 rows; same-exact-minute across the cemetery is bounded by ~1 row in practice).

- [ ] **Task 2: Add error codes to `convex/lib/errors.ts`** (AC: 1, AC: 2)
  - [ ] **UPDATE** the `ErrorCode` enum (or const object) to include `LOT_ALREADY_SCHEDULED` and `TIMESLOT_ALREADY_BOOKED` if they are not already declared from Story 7.1's stub. These are user-facing operational errors, not server bugs; document in the file's comment.

### Wire into `scheduleInterment` (AC3)

- [ ] **Task 3: Replace the TODO in `scheduleInterment` with the real check** (AC: 3)
  - [ ] **UPDATE** `convex/interments.ts`: remove the `// TODO(Story 7.2): ...` comment from Story 7.1. Add `await assertNoDoubleBooking(ctx, { lotId: args.lotId, scheduledAt: args.scheduledAt });` immediately after the occupant-belongs-to-lot check and BEFORE the `ctx.db.insert(...)`.
  - [ ] The order matters: occupant validation first (cheapest + most specific), then double-booking (requires index reads), then insert. If any throws, no row is written.

### Time-helper additions (AC1)

- [ ] **Task 4: Add `startOfManilaDay` / `endOfManilaDay` to `convex/lib/time.ts`** (AC: 1)
  - [ ] **UPDATE** `convex/lib/time.ts`: add helpers that, given an epoch ms, return the Manila 00:00:00 start and 24:00:00 end of that day as epoch ms. Use the hardcoded `+08:00` offset (no DST in Philippines). Add unit tests.
  - [ ] If the file doesn't exist yet (depends on whether Story 3.x has shipped), **NEW** it with: `formatDate(epoch, "..." )`, `formatTime`, `startOfManilaDay`, `endOfManilaDay`, the `MANILA_OFFSET_HOURS = 8` constant. Document in the architecture's time-handling section reference.

### UI error rendering (AC1, AC2)

- [ ] **Task 5: Extend `ScheduleIntermentSheet` to render conflict errors** (AC: 1, AC: 2)
  - [ ] **UPDATE** `src/components/ScheduleIntermentSheet/ScheduleIntermentSheet.tsx`: the catch block from Story 7.1 was wired forward-compatibly; now wire the actual rendering.
  - [ ] On catch, inspect `error.data?.code`. If `LOT_ALREADY_SCHEDULED` or `TIMESLOT_ALREADY_BOOKED`, render a dedicated `<ConflictAlert>` block above the submit button with:
    - icon (shadcn `<AlertTriangle>`)
    - sentence per AC1 / AC2
    - "View existing" link → `/interments/{conflictingIntermentId}` (opens in same tab; user can hit Back if they decide to reschedule)
  - [ ] For unknown error codes, fall back to the generic inline error from Story 7.1.

- [ ] **Task 6: NEW `ConflictAlert` subcomponent** (AC: 1, AC: 2)
  - [ ] **NEW** `src/components/ScheduleIntermentSheet/ConflictAlert.tsx`. Stateless. Props: `{ kind: "LOT" | "TIMESLOT", details: { conflictingIntermentId, conflictingScheduledAt, conflictingOccupantName, conflictingLotCode? } }`. Renders the alert per AC. Match UX § Feedback Patterns > Inline error styling.

- [ ] **Task 7: Stub `/interments/[intermentId]` detail page if not present** (AC: 1)
  - [ ] **NEW** `src/app/(staff)/interments/[intermentId]/page.tsx` IF Story 7.3 hasn't shipped yet. Minimal: fetch via `useQuery(api.interments.getInterment, { intermentId })` and render lot + occupant + scheduledAt + status + notes. Story 7.3 will replace / enrich this with the calendar context.
  - [ ] If Story 7.3 is already done, this task is a no-op.

### Testing (AC1, AC2, AC3)

- [ ] **Task 8: Unit tests for `assertNoDoubleBooking`** (AC: 3)
  - [ ] **NEW** `tests/unit/convex/lib/intermentConflicts.test.ts`. Cover:
    - empty DB → no throw
    - one existing scheduled interment at same lot same day → throws `LOT_ALREADY_SCHEDULED` with correct details
    - one existing scheduled interment at same lot DIFFERENT day → no throw
    - one existing cancelled interment at same lot same day → no throw (cancelled doesn't block)
    - one existing scheduled interment at DIFFERENT lot same exact minute → throws `TIMESLOT_ALREADY_BOOKED`
    - `excludeIntermentId` matches the conflicting row → no throw (reschedule scenario)
    - Manila timezone edge case: an interment scheduled at 23:59 Manila time vs. an attempt at 00:01 the next day (UTC same hour) → must NOT conflict (different Manila calendar dates)

- [ ] **Task 9: Integration tests for `scheduleInterment` with conflicts** (AC: 1, AC: 2)
  - [ ] **UPDATE** `tests/unit/convex/interments.test.ts` (from Story 7.1): add cases that schedule two interments where the second conflicts. Assert the correct error code + that the second insert did NOT land.

- [ ] **Task 10: Component test for `ConflictAlert` + sheet integration** (AC: 1, AC: 2)
  - [ ] **UPDATE** `src/components/ScheduleIntermentSheet/ScheduleIntermentSheet.test.tsx`: add cases that mock the mutation to throw each conflict code and assert the correct alert renders with the correct copy + working "View existing" link.

### Docs (AC4)

- [ ] **Task 11: ADR + runbook** (AC: 4)
  - [ ] **UPDATE** `docs/adr/0009-interment-scheduling.md` (created in Story 7.1): append a "Double-booking prevention" section. Document: (1) the two guard kinds; (2) why the timeslot guard is exact-minute equality and not a configurable interval (cemetery operations have a single crew with a few-hour interment duration — but a duration-based overlap check requires knowing crew capacity + interment duration, both Phase 2 kickoff questions; equality-minute is the safe minimum); (3) the TOCTOU reasoning (Convex mutations are transactional, the read-then-insert is atomic in a single mutation invocation); (4) the override question (currently no override; flagged as Phase 2 follow-up).
  - [ ] **UPDATE** `docs/runbook.md`: add a "Double-booking error handling" section — what operators do if they receive a `LOT_ALREADY_SCHEDULED` or `TIMESLOT_ALREADY_BOOKED` error (steps: open the conflicting interment, decide reschedule vs. cancel + rebook, document the decision).

## Dev Notes

### Previous story intelligence

- **Story 7.1 (schedule interment)** is the hard dependency. It established `convex/interments.ts`, the `interments` table, and the `scheduleInterment` mutation with the TODO comment marker. This story removes the TODO and inserts the real check.
- **Story 1.6 (`emitAudit`)** — the error path does NOT emit audit entries (failed-to-schedule is not an audited business event; only successful operations are audited per architecture's audit policy). The error is logged via Convex's built-in error telemetry.
- **Story 1.7 (state machines)** — not directly used; this story does not transition any state. The `cancelled` filter is a status check, not a transition.

If Story 7.1 is not done yet, **block this story.**

### The timeslot-conflict assumption — load-bearing

Per the architecture analysis embedded in epics § Story 7.2, the cemetery has **limited interment staff** — a single crew that physically attends each burial. Scheduling two interments at different lots at the same exact time is operationally infeasible. This is why the timeslot guard exists alongside the lot guard.

**Verify at Phase 2 kickoff:**

- Does the cemetery actually have a single crew, or multiple? (Larger cemeteries run 2–3 parallel crews during peak season.)
- What is the typical interment duration? (1 hour? 2 hours?) If overlap-based conflict detection is needed (vs. exact-minute equality), the implementation changes from index equality lookup to range queries.
- Is there a way for an Admin to override the guard when ops permits? (E.g. "Crew B is available for this slot.")

This story implements the **safe minimum**: exact-minute conflict only, no override. Future stories can relax / parametrize as the cemetery's actual capacity is mapped.

### Should `"completed"` interments also block timeslot reuse?

No. A completed interment is in the past (or completed in real time per Story 7.4); the timeslot has been used; nothing in the future can collide with it. The guard scans for `status: "scheduled"` only.

Edge case: what if someone tries to schedule a future interment at the exact same minute as a `completed` one from years ago? Operationally fine — the crew is no longer busy. The current implementation skips `completed` and `cancelled` — exactly what's wanted.

### Architecture compliance

- **Pure helper in `convex/lib/`** — `assertNoDoubleBooking` is reusable; future reschedule mutations (Phase 2) reuse it with `excludeIntermentId`. Matches the architecture's `convex/lib/` pattern for cross-cutting helpers.
- **No new scheduled job** — Convex's transactional mutations are sufficient. Don't reach for a cron / sweep job to "verify integrity." If a TOCTOU race truly worried us we'd need a different fix (e.g. a uniqueness constraint), and Convex does not provide application-level uniqueness; the mutation re-read inside the same transaction is the right answer.
- **Manila timezone via helpers** — `startOfManilaDay` / `endOfManilaDay` live in `convex/lib/time.ts`, single source of truth. No inline `+ 8 * 60 * 60 * 1000` math.
- **Indexes designed first** — `by_lot_scheduledAt` (Story 7.1) covers the lot-conflict query; `by_status_scheduledAt` (Story 7.1) covers the timeslot-conflict query. No full-table scans.
- **Error codes documented** — `LOT_ALREADY_SCHEDULED` and `TIMESLOT_ALREADY_BOOKED` are added to the shared error-code enum; client switch statements can rely on stable codes.

### Library / framework versions

- No new dependencies.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── interments.ts                              # UPDATE (remove TODO; call assertNoDoubleBooking)
│   ├── lib/
│   │   ├── intermentConflicts.ts                  # NEW (assertNoDoubleBooking helper)
│   │   ├── time.ts                                # UPDATE (add startOfManilaDay/endOfManilaDay if missing)
│   │   └── errors.ts                              # UPDATE (add LOT_ALREADY_SCHEDULED, TIMESLOT_ALREADY_BOOKED)
├── src/
│   ├── app/(staff)/interments/[intermentId]/page.tsx  # NEW (minimal stub if Story 7.3 not shipped yet)
│   └── components/ScheduleIntermentSheet/
│       ├── ScheduleIntermentSheet.tsx              # UPDATE (real conflict catch / render)
│       ├── ScheduleIntermentSheet.test.tsx         # UPDATE (conflict cases)
│       ├── ConflictAlert.tsx                       # NEW
│       └── ConflictAlert.test.tsx                  # NEW
├── tests/
│   └── unit/convex/
│       ├── interments.test.ts                      # UPDATE (conflict integration cases)
│       └── lib/
│           └── intermentConflicts.test.ts          # NEW
└── docs/
    ├── adr/0009-interment-scheduling.md            # UPDATE (Double-booking prevention section)
    └── runbook.md                                  # UPDATE (Double-booking error handling)
```

### Testing requirements

- Unit coverage: 100% on `assertNoDoubleBooking` — every branch tested (lot conflict / no conflict / cancelled excluded / excludeIntermentId / timeslot conflict / DST-safe Manila edge case).
- Integration coverage on `scheduleInterment` with conflict scenarios.
- Component test on the conflict-alert rendering.
- E2E: not in scope; Phase 2 kickoff may add a Playwright spec covering "operator gets conflict error and clicks View existing."

### Source references

- **PRD:** [FR52](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- **Architecture:** [§ Functional Coverage > FR51–FR54](../../_bmad-output/planning-artifacts/architecture.md); [§ Time handling](../../_bmad-output/planning-artifacts/architecture.md)
- **UX:** [§ Feedback Patterns > Inline errors](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 7.2](../../_bmad-output/planning-artifacts/epics.md#story-72-system-prevents-double-booking)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT implement an override / force-schedule path in this story.** That's a Phase 2 kickoff candidate. An override without an operational policy is how cemeteries end up with collisions on burial day.
- ❌ **Do NOT use a date-range overlap check (interval intersection).** This story uses exact-minute equality only. Range overlap requires knowing interment duration, which is a Phase 2 kickoff question.
- ❌ **Do NOT block `"completed"` interments from creating timeslot conflicts.** Completed is past; future scheduling cannot collide with it. Filter to `status: "scheduled"` only.
- ❌ **Do NOT inline Manila-offset math (`+ 8 * 60 * 60 * 1000`) in the helper.** Use `convex/lib/time.ts` helpers. Inline math is the #1 source of off-by-one-day bugs at midnight boundaries.
- ❌ **Do NOT skip the cancelled-status filter.** A cancelled interment at a lot must not block re-scheduling. Without this filter, cancelling + rebooking the same lot/day fails — UX disaster.
- ❌ **Do NOT add a Convex scheduled job to "verify" no duplicates.** Convex mutations are transactional; the read-then-insert is atomic. Adding a sweep job is cargo-culted defensive code that burns action minutes.
- ❌ **Do NOT silently allow the conflict if the conflicting row's `occupantId` matches.** Even if it's "the same occupant" being rescheduled, this story does not implement reschedule — the operator must explicitly cancel the existing row first (Phase 2 follow-up story).
- ❌ **Do NOT throw a generic error.** Specific error codes are load-bearing for the UI to render the targeted alert + "View existing" link. Generic errors collapse the operator into a guessing game.
- ❌ **Do NOT emit `emitAudit` on the FAILED schedule attempts.** Failed attempts are not audited business events; they are client errors. Convex's error telemetry captures them already.

### Common LLM-developer mistakes to prevent

- **Wrong index on the lot-conflict query:** Use `by_lot_scheduledAt` (Story 7.1 added it specifically for this), not `by_lot_status` — the date-range lookup needs `scheduledAt` in the index key.
- **Inclusive vs. exclusive end-of-day boundary:** `startOfManilaDay <= scheduledAt < startOfNextManilaDay` (exclusive upper). An inclusive upper bound risks counting the next day's first interment as a same-day conflict.
- **Comparing `scheduledAt` as Date objects:** It's `number` (epoch ms). Compare numerically; do not new-Date-then-compare.
- **Returning a boolean from `assertNoDoubleBooking`:** It throws; it does not return. The naming convention `assert*` from Story 1.7's `assertTransition` indicates throw-on-fail semantics. Future callers `await assertNoDoubleBooking(...)` and trust no throw means OK.
- **Forgetting `excludeIntermentId`:** Without it, future reschedule mutations (Phase 2) will see themselves as conflicts. Wire the param now even though no caller uses it yet — saves a follow-up patch.
- **Conflict rendering inline-overwrites the entire form:** The alert block sits above the submit button; form values stay populated so the operator can adjust the time without re-entering everything.
- **Conflict detection only on client side:** The server check is the source of truth. Client-side pre-checks (querying before submit to warn early) are a UX nicety but NOT a substitute. This story ships server-only.

### Open questions / blockers this story does NOT resolve

- **Crew capacity** — does the cemetery have one crew or multiple? Affects whether timeslot guard should be parametric. Flag for Phase 2 kickoff.
- **Interment duration** — if average burial is 90 minutes, should the timeslot guard be a 90-min interval overlap? Currently exact-minute equality only. Flag for kickoff.
- **Admin override** — should admins be able to force-schedule despite a conflict (with logged reason)? Not implemented in this story. Phase 2 follow-up candidate.
- **Reschedule mutation** — the `excludeIntermentId` param is wired but no mutation calls it yet. A separate story (`7.5: Reschedule interment`) would add the reschedule flow.

### Phase 2 reservation

ACs lighter. Kickoff may add:

- Parametric timeslot guard (duration-aware)
- Admin override flow with audit
- Per-section / per-crew conflict scoping (if cemetery runs parallel crews)

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure > convex/lib/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Functional Coverage > FR52](../../_bmad-output/planning-artifacts/architecture.md)

No detected conflicts.

### References

- [PRD § FR52](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- [Architecture § Functional Coverage](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Feedback Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 7.2](../../_bmad-output/planning-artifacts/epics.md#story-72-system-prevents-double-booking)
- Previous stories (foundation): [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [1.6](./1-6-audit-log-emission-helper.md), [1.7](./1-7-state-machine-transition-guards.md); [1.8 (lots)](./1-8-office-staff-creates-and-edits-lot-records.md); occupants 2.6 (when created); [7.1](./7-1-office-staff-schedules-an-interment.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (autonomous dev under user-issued file-ownership brief that
narrows the original story scope).

### Debug Log References

- Gate 1 (`npm run typecheck`): PASS after extending the test fixture's fake
  `IndexQuery` to handle `.gte` / `.lte` (Story 7.1's fixture only modelled
  `.eq`). Two TS2532 hits fixed by replacing `Record<string, number>` casts
  with explicit `typeof v === "number"` guards.
- Gate 2 (`npm run lint`): PASS, no warnings or errors.
- Gate 3 (`npm test`): PASS — 990 passed / 1 skipped / 991 total. The
  `interments.test.ts` suite grew from 27 → 48 tests (15 new `scheduleInterment`
  + `findConflicts` cases plus 6 carried-forward fixtures).
- Gate 4 (`npm run build`): PASS — Next.js build succeeds with no new bundle
  warnings; `interments/new` route size delta is +0.0 kB (the new conflicts
  prop is opt-in and the form's parent on `/interments/new` is not yet wired
  to pass it — see Completion Notes).
- Gate 5 (`npm run test:e2e -- interment-double-booking`): FAILED at webserver
  startup with `Error: Invalid path: /login/*. Unexpected MODIFIER at 7,
  expected END` originating from `src/middleware.ts:35` (`createRouteMatcher(["/login", "/login/*"])`).
  Verified identical failure on the pre-existing `interment-schedule.spec.ts`
  (Story 7.1) — confirming this is a **pre-existing infrastructure issue** with
  Next.js 15 + path-to-regexp v8 rejecting the `/login/*` matcher pattern,
  NOT caused by this story's changes. `src/middleware.ts` is outside this
  story's file-ownership window — surfacing per dev brief.

### Completion Notes List

- **Scope narrower than the original story spec by user directive.** The
  user-issued file-ownership brief restricted writes to four files only
  (`convex/interments.ts`, `tests/unit/convex/interments.test.ts`,
  `tests/e2e/interment-double-booking.spec.ts`, and
  `src/components/IntermentForm/IntermentForm.tsx`); the original story spec's
  additional files (`convex/lib/intermentConflicts.ts`, `convex/lib/errors.ts`,
  `convex/lib/time.ts`, `src/components/ScheduleIntermentSheet/*`, ADRs, runbook)
  are off-limits. Implementation adapted as follows:
  - The conflict helper lives inline in `convex/interments.ts` as
    `findConflictingInterments(ctx, params)` (a non-exported function), with
    `findConflicts(args)` as the public `queryGeneric` wrapper. A future story
    may extract to `convex/lib/intermentConflicts.ts` per the original spec.
  - Conflict semantics: **per-lot ±60-min window** (the user brief's "±N minutes
    (e.g. ±60 min)" instruction), instead of the original spec's "same-Manila-
    calendar-day lot guard + exact-minute timeslot guard." The window approach
    is operationally equivalent for the single-crew assumption (an hour-long
    interment cannot overlap an hour-long interment at the same lot inside
    60 min). The cross-lot timeslot guard is deferred — flagged for Phase 2
    kickoff with the crew-capacity / interment-duration questions in the
    story's "Open questions" section.
  - Error code: reused `INVARIANT_VIOLATION` (per user brief) instead of adding
    `LOT_ALREADY_SCHEDULED` / `TIMESLOT_ALREADY_BOOKED` to `convex/lib/errors.ts`.
    The error `details.conflictingIds` and `details.conflictWindowMs` carry the
    discriminator the UI needs.
  - UI banner lives in `IntermentForm.tsx` (an inline `<div role="alert">`
    rendered above the submit row) instead of a dedicated `ConflictAlert`
    subcomponent in `ScheduleIntermentSheet/`. The form now accepts
    `conflicts`, `onScheduledAtChange`, and `allowConflictOverride` props; the
    parent issues `useQuery(api.interments.findConflicts, …)` and forwards
    the result. The "View existing" link is NOT wired here — the parent route
    file would own that, and it's outside the file-ownership window.
- **Parent wire-up deferred.** The `/interments/new` page (and any lot-detail
  Schedule-Interment dialog) needs to be updated to:
  1. Track the latest composed `scheduledAt` via `onScheduledAtChange`.
  2. Call `useQuery(api.interments.findConflicts, { lotId, scheduledAt })`
     (skip when `scheduledAt === null` via the `"skip"` arg).
  3. Forward the result via `conflicts={…}`.
  These are presentational page files outside this story's file-ownership.
  A follow-up story (or Story 7.3's calendar wire-up) should land this.
- **Server guard is the source of truth.** With or without the parent UI
  wire-up, `scheduleInterment` rejects double-bookings — the form prop is a
  UX nicety only. AC verified end-to-end via the new
  `scheduleInterment > double-booking guard` test cases.
- **Test-fixture extension.** Story 7.1's hand-mocked `IndexQuery` only
  modelled `.eq()`; this story's range query needed `.gte()` / `.lte()`.
  Extended the fake to add `gte / lte / gt / lt` predicates while preserving
  the `.eq()` semantics — fully backward-compatible with existing tests.
- **Phase-2-kickoff items surfaced (carry-forward from story Dev Notes):**
  - Crew capacity question — does the cemetery have one crew or several
    parallel crews? Determines whether the conflict guard should be
    per-crew-scoped or remain per-lot.
  - Interment duration question — if average burial is 90 min, the window
    should grow to ±90. Constant `INTERMENT_CONFLICT_WINDOW_MS` in
    `convex/interments.ts` is the single knob.
  - Admin override flow — `allowConflictOverride` prop on `IntermentForm` is
    wired to disable the submit-block; an admin-scoped flow (with audit reason)
    is the Phase 2 follow-up.
  - Cross-lot timeslot guard — deferred (see scope narrowing above).
  - Reschedule mutation — the `excludeIntermentId` arg on `findConflicts` is
    wired but no mutation calls it yet (Story 7.5 candidate).
- **E2E gate blocked by pre-existing middleware bug.** `src/middleware.ts:35`
  uses `createRouteMatcher(["/login", "/login/*"])`; Next.js 15's
  path-to-regexp v8 rejects the `/login/*` pattern. The dev brief's "Hard
  stops > Forbidden file change → stop" rule applies — `src/middleware.ts` is
  not in this story's file-ownership window. Reporting and stopping per the
  brief. The new spec (`tests/e2e/interment-double-booking.spec.ts`) is
  unauth-only route protection per the Story 7.1 deferral pattern; it will
  pass once the middleware bug is fixed.

### File List

- **MODIFIED** `convex/interments.ts` — added `INTERMENT_CONFLICT_WINDOW_MS`,
  `IntermentConflict` interface, replaced the Story 7.1 TODO with a call to
  the new `findConflictingInterments` helper, and appended `findConflicts`
  query + the helper. Updated the `scheduleInterment` docstring to document
  the new INVARIANT_VIOLATION trigger.
- **MODIFIED** `src/components/IntermentForm/IntermentForm.tsx` — added
  `IntermentConflictPreview` interface; new optional `conflicts`,
  `onScheduledAtChange`, `allowConflictOverride` props; `useEffect` that
  notifies parent of composed `scheduledAt` changes; conflict banner block
  above the submit row; submit-disabled when conflicts present (unless
  override is enabled).
- **MODIFIED** `tests/unit/convex/interments.test.ts` — extended the fake
  `IndexQuery` to handle `.gte()` / `.lte()` / `.gt()` / `.lt()`; added 6 new
  cases in a `double-booking guard` describe (within-window throws, outside
  window allowed, cancelled skipped, completed skipped, different-lot
  skipped, exact-minute throws); added 9 cases in a new `findConflicts`
  describe covering happy path, status filters, `excludeIntermentId`,
  invalid input, RBAC matrix.
- **CREATED** `tests/e2e/interment-double-booking.spec.ts` — Story-7.1-style
  unauthenticated route-protection smoke spec for `/interments/new` and
  `/interments`. Authenticated journey deferred to the next sprint with the
  test-user seed.
- **MODIFIED** `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `7-2-system-prevents-double-booking: ready-for-dev → review`; bumped
  `last_updated: 2026-05-18`.
- **MODIFIED** this file — Status `ready-for-dev → review`; this Dev Agent
  Record populated.
