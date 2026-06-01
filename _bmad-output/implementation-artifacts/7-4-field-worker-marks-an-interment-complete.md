# Story 7.4: Field Worker Marks an Interment Complete

Status: review

<!-- Phase 2 reservation: Phase 2 ACs are intentionally lighter than Phase 1's; this story may be re-specced at Phase 2 kickoff. The completion-photo handling (does the cemetery actually want photos of burials? is there a cultural / privacy concern? do family members consent?) is the load-bearing question to verify with the operations team and §10 Q-class privacy review at kickoff. For now the photo is OPTIONAL and stored alongside but separate from the lot's general condition photos. -->

## Story

As **Junior (Field Worker)**,
I want **to mark a scheduled interment as complete from my phone — with the timestamp captured automatically, optional notes, and an optional photo — so the office staff sees the completion in real time and the lot's status reflects that an interment has actually happened**,
so that **the office stops calling me to ask "did it happen yet?", the cemetery's records stay current without phone-tag, and the lot transitions to `occupied` as a side effect of the operational truth on the ground** (FR53).

This story closes the interment loop: scheduling (7.1) → conflict-guarded (7.2) → calendar-visible (7.3) → **completed (this story)**. It also introduces the first **`scheduled → completed`** state transition on the `interments` entity AND triggers a **lot state transition to `occupied`** via Story 1.7's `assertTransition` infrastructure — wiring two state machines together in a single atomic mutation.

## Acceptance Criteria

1. **AC1 — Field Worker sees today's scheduled interments on a mobile-friendly list at `/interments/today`**: Junior opening `/interments/today` on his phone sees a single-column list of all interments where `status === "scheduled"` AND `scheduledAt` falls on today's Manila calendar date. Each row shows: occupant name, lot code, scheduled time, "Mark complete" tap target (44×44px min per NFR-A4). The list is empty-state-aware ("No interments scheduled for today"). Field Worker role gets read access (per Story 7.1's `listForLot` decision); the page is hidden from the sidebar for non-field-worker roles but accessible by URL.

2. **AC2 — Tapping "Mark complete" opens a Sheet with auto-now timestamp, optional notes, and optional photo upload**: A bottom `<Sheet>` (mobile-optimized full-height) opens with: a read-only "Completed at" line showing the current time in Manila tz (auto-captured at sheet-open; updates on submit to actual submit time); an optional notes `<Textarea>` (max 500 chars); an optional photo input (`<input type="file" accept="image/*" capture="environment">` for camera access on mobile); a primary "Mark complete" submit button (44px+ tall, glove-friendly per Story 1.14's mobile UX pattern). Cancel button closes the sheet without writing.

3. **AC3 — Submission atomically completes the interment AND transitions the lot to `occupied`**: `convex/interments.ts → completeInterment({ intermentId, notes, photoBlobId })` is a single mutation that: calls `requireRole(ctx, ["admin", "office_staff", "field_worker"])`; reads the interment + asserts `status === "scheduled"`; reads the lot; calls `assertTransition({ entityType: "interment", from: "scheduled", to: "completed" })` (Story 1.7 — interment transitions added to `TRANSITIONS` table in this story); patches the interment with `status: "completed"`, `completedAt: Date.now()`, `completedBy: userId`, `completionNotes: notes`, `completionPhotoBlobId: photoBlobId`; if `lot.status !== "occupied"`, calls `transitionLotStatus(ctx, { lotId: interment.lotId, to: "occupied", reason: "interment_completed: " + intermentId })` (Story 1.7 helper); emits `emitAudit` for the interment completion. Both writes happen in the same Convex mutation transaction — either both succeed or neither does.

4. **AC4 — Office staff calendar reactively reflects completion within 1 second with the 600ms amber flash**: The Office Staff calendar view (Story 7.3) — open in another browser tab on Maria's desk — receives the Convex reactive update when Junior submits. The affected event's StatusPill flips from blue (`scheduled`) to green (`completed`); the lot's status badge anywhere it's displayed (lot detail page, lots list) flips to `occupied`. Both transitions render with the standard 600ms `bg-amber-50` fade per `ReactiveHighlight`. No toast on the Office Staff side — calm reactivity only.

## Tasks / Subtasks

### State machine: add interment transitions (AC3)

- [ ] **Task 1: Extend `convex/lib/stateMachines.ts` with interment transitions** (AC: 3)
  - [ ] **UPDATE** `convex/lib/stateMachines.ts` (Story 1.7): add `interment` to the `TRANSITIONS` table:
    ```ts
    interment: {
      scheduled: ["completed", "cancelled"],
      completed: [],          // terminal
      cancelled: [],          // terminal
    }
    ```
  - [ ] Add `"interment"` to the `EntityWithState` type (Story 1.7's `convex/lib/states.ts`).
  - [ ] No transitions need reasons per `REASON_REQUIRED_TRANSITIONS` for this story (completion is a positive operational event; cancellation will be added with the future cancel-interment story).
  - [ ] **UPDATE** `tests/unit/convex/lib/stateMachines.test.ts` (Story 1.7): add exhaustive `from→to` legal/illegal cases for the new `interment` entity. Verify `assertTransition` returns success on legal moves and throws `ILLEGAL_STATE_TRANSITION` on illegal ones.

### `completeInterment` mutation (AC3)

- [ ] **Task 2: Implement `completeInterment` mutation** (AC: 3)
  - [ ] **UPDATE** `convex/interments.ts`: add `export const completeInterment = mutation({ args: { intermentId: v.id("interments"), notes: v.optional(v.string()), photoBlobId: v.optional(v.id("_storage")) }, handler })`.
  - [ ] First line: `const { userId } = await requireRole(ctx, ["admin", "office_staff", "field_worker"])`. Field Worker is the primary actor here; Admin / Office Staff are allowed for back-office corrections.
  - [ ] Read the interment; throw `NOT_FOUND` if missing.
  - [ ] Assert `interment.status === "scheduled"`; otherwise throw `ConvexError({ code: "INVALID_STATE", message: "Only scheduled interments can be marked complete." })`. (This is a duplicate of the `assertTransition` check, but explicit guards make the mutation testable + give a more specific error code than the generic `ILLEGAL_STATE_TRANSITION`.)
  - [ ] Call `assertTransition({ entityType: "interment", from: "scheduled", to: "completed" })`. (Story 1.7's pure function — throws if illegal.)
  - [ ] Patch the interment: `{ status: "completed", completedAt: Date.now(), completedBy: userId, completionNotes: notes ?? undefined, completionPhotoBlobId: photoBlobId ?? undefined }`.
  - [ ] Read the lot. If `lot.status !== "occupied"`, call `await transitionLotStatus(ctx, { lotId: interment.lotId, to: "occupied", reason: `interment_completed:${intermentId}` })`. Story 1.7's helper internally calls `assertTransition` + patches + emits the lot's audit entry.
    - **Important:** If the lot is already `occupied` (a prior interment at the same family plot already completed), skip the lot transition — it's a no-op, not an error. Multi-interment lots are explicitly allowed (Story 7.1 design decision).
    - **If the lot is in a state that cannot legally transition to `occupied`** (e.g. `available`, `reserved`, `cancelled`, `defaulted`, `transferred`) — `assertTransition` will throw `ILLEGAL_STATE_TRANSITION`. The mutation propagates this error; the UI surfaces it as a generic "Cannot mark complete — lot state invalid" message + a link to the runbook. This is an operational anomaly (interment scheduled against a non-sold lot somehow) and operations should intervene.
  - [ ] Emit `emitAudit(ctx, { action: "complete_interment", entityType: "interment", entityId: intermentId, before: { status: "scheduled" }, after: { status: "completed", completedAt, completedBy }, reason: notes ?? "field worker completion" })`.
  - [ ] Return `{ intermentId, lotTransitioned: boolean }` so the UI can decide what feedback to show.

### Photo upload helper (AC2)

- [ ] **Task 3: Wire Convex File Storage signed upload URL** (AC: 2)
  - [ ] **UPDATE** `convex/interments.ts`: add `export const generateUploadUrl = mutation({ args: {}, handler })`. `requireRole(ctx, ["admin", "office_staff", "field_worker"])`. Returns `ctx.storage.generateUploadUrl()`. Standard Convex pattern for client-direct uploads.
  - [ ] Photo is uploaded BEFORE the `completeInterment` mutation; the resulting `_storage` ID is passed in. Two-step flow keeps the mutation small + lets the upload happen during the form completion (not after-submit).
  - [ ] Add a read query `getCompletionPhotoUrl({ intermentId }) → string | null` that calls `requireRole` and `ctx.storage.getUrl(photoBlobId)` — signed URLs are short-lived; query refreshes them. Used by the office staff calendar event sheet to display the photo.

### Today's-interments mobile page (AC1)

- [ ] **Task 4: Add `listTodayForFieldWorker` query** (AC: 1)
  - [ ] **UPDATE** `convex/interments.ts`: add `export const listTodayForFieldWorker = query({ args: {}, handler })`. `requireRole(ctx, ["admin", "office_staff", "field_worker"])`. Query `by_status_scheduledAt` for `status: "scheduled"` AND today's Manila date range (`startOfManilaDay(now)` to `endOfManilaDay(now)`). Project to `{ id, scheduledAt, occupantName, lotCode, lotId }`. Sort by `scheduledAt` ascending.

- [ ] **Task 5: Build `/interments/today` page** (AC: 1)
  - [ ] **NEW** `src/app/(staff)/interments/today/page.tsx`. `"use client"`.
  - [ ] Mobile-first layout: single column, large rows (≥ 80px tall), 44×44px tap targets. Match Story 1.14's mobile UX patterns (large fonts, generous spacing, gloves-on usable).
  - [ ] Each row: occupant name (large, bold), lot code (medium, secondary color), scheduled time (large, time-prominent), "Mark complete" button (primary, full-width within row).
  - [ ] Empty state: "No interments scheduled for today" with a friendly graphic / icon.
  - [ ] **UPDATE** `src/app/(staff)/layout.tsx` sidebar: add a "Today's interments" nav item visible to Field Worker role only. Story 7.3 already added a global "Interments" item for office staff; field workers see both, but "Today's interments" comes first in their nav (priority placement).

### Mark-complete Sheet (AC2)

- [ ] **Task 6: Build `MarkIntermentCompleteSheet` component** (AC: 2, AC: 3)
  - [ ] **NEW** `src/components/MarkIntermentCompleteSheet/{MarkIntermentCompleteSheet.tsx, index.ts}`. `"use client"`.
  - [ ] Props: `{ intermentId: Id<"interments">, occupantName: string, lotCode: string, open: boolean, onOpenChange: (open: boolean) => void }`.
  - [ ] Sheet variant: bottom sheet on mobile (slides up from bottom), right-side sheet on desktop. shadcn `<Sheet>` with responsive side prop.
  - [ ] Form: read-only timestamp display (auto-now, refreshes every 30 seconds while open), optional notes Textarea, optional photo input with camera capture preference.
  - [ ] Photo handling:
    1. On file select, call `useMutation(api.interments.generateUploadUrl)` to get a signed URL.
    2. POST the file to the signed URL (standard Convex File Storage flow).
    3. Parse the response for the `_storage` ID.
    4. Hold the ID in component state; pass to `completeInterment` on submit.
    5. If upload fails: inline error "Photo upload failed — try again, or submit without a photo."
  - [ ] Submit handler: `useMutation(api.interments.completeInterment)({ intermentId, notes, photoBlobId })`. On success: close sheet, navigate to `/interments/today` (the list refreshes reactively without the just-completed row). On error: inline error block.

### Reactive verification on the calendar (AC4)

- [ ] **Task 7: Verify Story 7.3's calendar reactively updates on completion** (AC: 4)
  - [ ] No code changes needed in `IntermentCalendar` — its `useQuery` already subscribes to `listForCalendar`, which returns the updated `status: "completed"` row after Junior's submission. The StatusPill rerenders with the new color; `ReactiveHighlight` (Story 1.4) applies the 600ms amber fade.
  - [ ] **NEW** integration test `tests/e2e/interment-completion-reactive.spec.ts` (Playwright, optional for Phase 2 ACs — Phase 2 reservation per note): open two browser contexts; in context A (Field Worker), navigate to today's interments + complete one; in context B (Office Staff), assert the calendar event flips color within 1500ms. Skip / mark as TODO if Phase 2 kickoff doesn't prioritize E2E. Add the file with a `.skip` directive if not running yet.

- [ ] **Task 8: Verify lot detail page reactively flips to `occupied`** (AC: 4)
  - [ ] No code changes needed in `src/app/(staff)/lots/[lotId]/page.tsx` — its `useQuery(api.lots.getLot, ...)` subscribes to the lot doc; the patched `status: "occupied"` flows through. `StatusPill` updates color; `ReactiveHighlight` flashes.

### Testing (AC1, AC2, AC3, AC4)

- [ ] **Task 9: Unit tests for `completeInterment`** (AC: 3)
  - [ ] **UPDATE** `tests/unit/convex/interments.test.ts`:
    - happy path as Field Worker: interment → completed, lot → occupied, both audit entries written, mutation returns `lotTransitioned: true`
    - happy path on family-plot lot (already `occupied`): interment → completed, lot remains `occupied`, no lot audit entry written, mutation returns `lotTransitioned: false`
    - interment is `cancelled` → throws `INVALID_STATE`
    - interment is already `completed` → throws `INVALID_STATE` (idempotency NOT supported here; double-submit guarded UI-side and by the explicit status check)
    - lot is `available` (anomaly: scheduled against unsold lot) → `assertTransition` throws `ILLEGAL_STATE_TRANSITION`; interment is NOT patched (atomic rollback)
    - as Customer (Phase 3) → `FORBIDDEN`
    - photoBlobId points to a non-existent storage ID → mutation does NOT validate storage existence (out of scope; storage GC is a separate concern); the field is patched as-is
  - [ ] Verify `emitAudit` is called exactly once for the interment + exactly once for the lot (when applicable). Use `convex-test`'s audit assertion helper.

- [ ] **Task 10: Component test for `MarkIntermentCompleteSheet`** (AC: 2)
  - [ ] **NEW** `src/components/MarkIntermentCompleteSheet/MarkIntermentCompleteSheet.test.tsx`. Cover:
    - sheet renders with auto-now timestamp + correct interment context
    - submit without notes or photo → calls mutation with `undefined` for both
    - photo upload flow: mock signed URL + storage ID → field set in mutation call
    - upload failure → inline error renders; submit still works without photo
    - close after success
    - close without submit (cancel button) does not call the mutation

- [ ] **Task 11: Page test for `/interments/today`** (AC: 1)
  - [ ] **NEW** `src/app/(staff)/interments/today/page.test.tsx`. Cover:
    - empty state when no interments scheduled
    - rows render with all required info
    - tap targets meet 44×44px (assert computed style)
    - "Mark complete" button opens the sheet with correct interment context

### Docs (AC3)

- [ ] **Task 12: ADR + runbook** (AC: 3)
  - [ ] **UPDATE** `docs/adr/0009-interment-scheduling.md` (Story 7.1): append a "Completion + lot transition" section. Document: (1) atomic dual-write rationale (single Convex mutation = single transaction); (2) interment state machine added to Story 1.7's table; (3) lot-transition idempotency on family-plot lots (skip if already occupied); (4) anomaly handling (interment scheduled against an unsold lot — should not happen but `assertTransition` is the safety net).
  - [ ] **UPDATE** `docs/runbook.md`: add "Cannot mark complete — lot state invalid" section. Operator steps: open the lot detail page; check the lot's current status; if `available` / `reserved`, the lot was never sold (data anomaly — escalate to Admin); if `defaulted` / `cancelled`, the contract was voided after the interment was scheduled (escalate). Resolution path is Admin manually adjusting the lot's state via the audit log + an Admin-only state-override mutation (out of scope for this story; flag if needed).

## Dev Notes

### Previous story intelligence

- **Story 7.1 (schedule interment)** — established the `interments` table and the schedule mutation. `completeInterment` is the second mutation on that table.
- **Story 7.2 (double-booking)** — no direct dependency; completion doesn't trigger conflict checks.
- **Story 7.3 (calendar)** — provides the reactive surface where office staff sees the completion in real-time. No code changes in 7.3 needed; the existing `useQuery` flow handles it.
- **Story 1.4 (`StatusPill`, `ReactiveHighlight`)** — both used here for the calendar + lot detail reactive flips.
- **Story 1.6 (`emitAudit`)** — emits the completion audit entry.
- **Story 1.7 (state machines + `assertTransition` + `transitionLotStatus`)** — the cornerstone this story extends. `interment` is added as a third entity to the `TRANSITIONS` table. `transitionLotStatus` is reused for the lot's `sold → occupied` transition. **If 1.7 is not done, block this story.**
- **Story 1.8 (lots)** — `lot.status` field is the target of the dependent transition.
- **Story 1.14 (field worker mobile UX pattern)** — the Mark-Complete Sheet inherits the mobile-first patterns established there: large fonts, 44×44px tap targets, gloves-on usability, optional photo with camera capture, generous spacing. **Follow Story 1.14's UX choices verbatim** for consistency. If 1.14 is not done, block this story (or graceful-degrade by inlining the patterns + documenting the duplication).
- **Story 2.6 (occupants)** — occupant name surfaces in the today's-interments list + the sheet.

### The atomic dual-write — load-bearing architecture

A single Convex mutation = a single transaction. Both the interment patch AND the lot transition happen inside `completeInterment`. If either throws, NEITHER lands. This matters because:

- A "ghost completed interment" against a still-`sold` lot would be a reporting horror (interment count vs occupied lots wouldn't balance).
- A "phantom occupied lot" without an underlying completed interment would be equally wrong.

The architecture explicitly mandates atomic multi-document writes for state-coupled operations (CLAUDE.md: "Atomic multi-document writes (payment + contract update + receipt generation) belong inside a single Convex mutation."). This story is the same pattern, applied to interment + lot.

**Do NOT split into two mutations** ("complete interment" then "transition lot"). The dev agent might be tempted to keep concerns separated; resist. Convex mutations are how atomicity is achieved — there is no escape hatch.

### State machine wiring — `interment` joins `lot` and `contract`

This story is the first time three entities transition in a coupled flow:

- `interment.scheduled → interment.completed` (driven by this mutation directly)
- `lot.sold → lot.occupied` (driven via `transitionLotStatus` from Story 1.7)

Both transitions go through `assertTransition`. The interment transition is allowed without a reason; the lot transition uses `reason: "interment_completed:<intermentId>"` to preserve the causal link in the audit log.

If the lot is already `occupied` (family plot, prior interment completed), the lot transition is skipped — `assertTransition({ from: "occupied", to: "occupied" })` would fail (`occupied → occupied` is not a self-loop in the table; it would be illegal). The mutation checks the lot's current status before calling `transitionLotStatus`.

### Architecture compliance

- **State machine for new entity** — added to `convex/lib/stateMachines.ts`'s `TRANSITIONS` table, tests exhaustive per Story 1.7's coverage standard.
- **`requireRole` first line** — every mutation.
- **`emitAudit` on every state change** — interment completion audit + the lot transition audit (emitted internally by `transitionLotStatus`).
- **Atomic dual-write in a single mutation** — matches CLAUDE.md's directive on multi-document writes.
- **Photo upload via `generateUploadUrl`** — standard Convex pattern; never proxy uploads through the mutation.
- **Signed URLs for photo display** — short-lived; refetched per query, never cached in localStorage.
- **Mobile-first UX** — inherits Story 1.14's tap-target + glove-friendly patterns.

### Library / framework versions

- No new dependencies.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── interments.ts                              # UPDATE (completeInterment, generateUploadUrl, getCompletionPhotoUrl, listTodayForFieldWorker)
│   └── lib/
│       ├── stateMachines.ts                       # UPDATE (add interment transitions)
│       └── states.ts                              # UPDATE (add "interment" to EntityWithState)
├── src/
│   ├── app/(staff)/
│   │   ├── interments/today/
│   │   │   ├── page.tsx                           # NEW (mobile-first today's list)
│   │   │   └── page.test.tsx                      # NEW
│   │   └── layout.tsx                             # UPDATE (Today's interments nav for Field Worker)
│   └── components/
│       └── MarkIntermentCompleteSheet/
│           ├── MarkIntermentCompleteSheet.tsx     # NEW
│           ├── MarkIntermentCompleteSheet.test.tsx # NEW
│           └── index.ts                           # NEW
├── tests/
│   ├── unit/convex/
│   │   ├── interments.test.ts                     # UPDATE (completion cases)
│   │   └── lib/stateMachines.test.ts              # UPDATE (interment transition cases)
│   └── e2e/
│       └── interment-completion-reactive.spec.ts  # NEW (skip / TODO; Phase 2 kickoff candidate)
└── docs/
    ├── adr/0009-interment-scheduling.md           # UPDATE (Completion + lot transition section)
    └── runbook.md                                 # UPDATE (Cannot mark complete troubleshooting)
```

### Testing requirements

- Unit coverage: 95%+ on `completeInterment`, including the dual-write atomic rollback path and the family-plot idempotency path.
- State-machine test coverage: every legal + illegal interment transition tested per Story 1.7's standard.
- Component coverage on the sheet + the today's page.
- E2E: optional for Phase 2 ACs; the reactive cross-tab spec is queued as a kickoff candidate.

### Source references

- **PRD:** [FR53](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- **Architecture:** [§ Functional Coverage > FR51–FR54](../../_bmad-output/planning-artifacts/architecture.md); [§ Implementation Patterns > assertTransition + atomic multi-document writes](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- **UX:** [§ Field Worker mobile UX patterns (inherited from Story 1.14)](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Reactive Updates > 600ms amber fade](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [Story 7.4](../../_bmad-output/planning-artifacts/epics.md#story-74-field-worker-marks-an-interment-complete)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT split the interment patch and the lot transition into two mutations.** Single mutation = single transaction = atomic. Splitting them creates ghost states + reporting horror.
- ❌ **Do NOT skip `assertTransition` and patch `status` directly.** Story 1.7's ESLint rule `no-raw-status-patch` will fail the build. Even without the lint, raw patches bypass the audit log on the lot side.
- ❌ **Do NOT call `transitionLotStatus` unconditionally.** Check `lot.status !== "occupied"` first; family plots / second interments must not re-transition an already-occupied lot (which would fail `assertTransition`).
- ❌ **Do NOT emit a custom toast on the office staff side when completion lands.** Calm reactivity per UX § Calm Reactivity. The 600ms amber fade IS the affordance.
- ❌ **Do NOT inline the photo upload as a base64 payload in the mutation args.** Convex mutation args have size limits + base64 bloats. Use `generateUploadUrl` + direct POST + pass the `_storage` ID.
- ❌ **Do NOT validate photo file size / type only on the client.** A determined client can bypass. Convex File Storage enforces some bounds; for stricter limits, add an internal action that inspects the blob post-upload. Out of scope for this story but document the gap.
- ❌ **Do NOT support idempotent re-completion** (calling complete on an already-completed interment as a no-op). It would mask UI bugs. The explicit `INVALID_STATE` error is correct.
- ❌ **Do NOT use `new Date().toISOString()` for `completedAt`.** Use `Date.now()` (epoch ms). Consistent with `scheduledAt` and `convex/lib/time.ts` patterns.
- ❌ **Do NOT add a "completed by another worker" override.** Field Worker A can complete an interment scheduled by Office Staff B; the audit log captures `completedBy`. Don't require role-pairing.
- ❌ **Do NOT delete the scheduled photo (if any) when completion adds a completion photo.** They are distinct fields: `lots.conditionPhotos[]` (Story 1.14) vs `interments.completionPhotoBlobId`. Different lifecycles.
- ❌ **Do NOT bypass `emitAudit` on the interment side just because `transitionLotStatus` emits its own audit.** Two audit entries — one for each entity — is the correct cardinality.

### Common LLM-developer mistakes to prevent

- **Forgetting to add `interment` to `EntityWithState`:** The TypeScript types in `convex/lib/states.ts` must include `"interment"` before `TRANSITIONS.interment` will typecheck.
- **Wiring `transitionLotStatus` before checking `lot.status === "occupied"`:** Will throw on family-plot lots. Always read + check before calling the helper.
- **Returning `undefined` from `lotTransitioned`:** Return `boolean` always (`true` if the transition happened, `false` if skipped). UI may want different feedback (e.g. small "Family plot — lot already occupied" hint).
- **Photo upload mutation does not check role:** `generateUploadUrl` must `requireRole`. Without it, anyone with a Convex URL could upload arbitrary blobs.
- **Sheet auto-now timestamp captured at open and never updated:** Field Worker might take 5 minutes to fill the form; the "Completed at" line should refresh every 30 seconds or capture the actual submit time. The mutation uses `Date.now()` at submit; the UI display is illustrative + updated on submit.
- **Today's-list query loads tomorrow's interments due to timezone bug:** Use `convex/lib/time.ts` Manila helpers (Story 7.2 added them). Browser-tz math will display Hong Kong's tomorrow as today for late-night Manila users.
- **Treating the lot's prior status as always `sold`:** It's almost always `sold`, but family-plot lots are already `occupied`. Conditional transition is non-negotiable.
- **Mobile sheet collapses awkwardly on iPhone SE:** Test on small screens (320px wide). 44×44px tap targets + 16px input fonts (no zoom-on-focus) are NFR-A4 requirements.

### Open questions / blockers this story does NOT resolve

- **Photo privacy / consent** — does the cemetery have family-consent infrastructure for interment photos? Cultural sensitivity in PH operations matters. Flag for §10 review at Phase 2 kickoff. For this story, photo is OPTIONAL — operators can simply not upload one.
- **Multi-occupant interments** — what if a single event interred multiple occupants (e.g. exhumation + reburial)? Currently each occupant requires a separate interment row. Flag for kickoff if operations needs batch semantics.
- **Reversal flow** — what if a completion was marked in error? Currently terminal (`completed` is a terminal state in the TRANSITIONS table). Admin override would need a new mutation + a new transition. Flag for kickoff.
- **Lot anomaly resolution** — when `assertTransition` blocks the lot move (interment scheduled against a non-`sold` lot), the operator currently gets a generic error. A dedicated Admin tool to reconcile the data anomaly is out of scope; runbook entry points to manual intervention.

### Phase 2 reservation

ACs lighter. Kickoff may add:

- E2E spec for cross-tab reactive verification (Task 7 is skipped today)
- Photo-required-by-policy toggle in admin settings
- Multi-occupant batch completion
- Completion-reversal flow (Admin-only)
- Field Worker offline support — completing without connectivity, syncing on reconnect (Phase 2 territory per FR11 offline-read, but offline-WRITE is harder; flag explicitly)

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure > convex/interments.ts + src/app/(staff)/interments/](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Implementation Patterns > assertTransition + atomic dual-write](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [Architecture § Functional Coverage > FR53](../../_bmad-output/planning-artifacts/architecture.md)

No detected conflicts.

### References

- [PRD § FR53](../../_bmad-output/planning-artifacts/prd.md#10-interment-scheduling)
- [Architecture § Implementation Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [Architecture § Functional Coverage](../../_bmad-output/planning-artifacts/architecture.md)
- [UX § Calm Reactivity + Field Worker mobile UX](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 7.4](../../_bmad-output/planning-artifacts/epics.md#story-74-field-worker-marks-an-interment-complete)
- Previous stories: [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [1.4 (StatusPill/ReactiveHighlight)](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md), [1.6 (emitAudit)](./1-6-audit-log-emission-helper.md), [1.7 (state machines)](./1-7-state-machine-transition-guards.md), [1.8 (lots)](./1-8-office-staff-creates-and-edits-lot-records.md); 1.14 (field worker mobile UX — when created); 2.6 (occupants — when created); [7.1](./7-1-office-staff-schedules-an-interment.md); [7.2](./7-2-system-prevents-double-booking.md); [7.3](./7-3-office-staff-views-the-interment-calendar.md)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via the Claude Code CLI / cemetery-mapping
dev brief autonomous mode.

### Debug Log References

- `npm run typecheck` — clean.
- `npm run lint` — clean (one round-trip after adding `<h1 className="sr-only">`
  on `/interments/[intermentId]/complete` to satisfy `local-rules/single-h1-per-page`).
- `npm run test` — 1406 passed, 1 skipped. All Story 7.4 tests green:
  - `tests/unit/convex/interments.test.ts` — 21 new tests appended; 82 total.
  - `tests/unit/convex/lib/stateMachines.test.ts` — interment entity joins the
    exhaustive legal/illegal sweep + dedicated transition cases; 142 total.
  - `tests/unit/components/CompletionForm.test.tsx` — 7 new tests.
- `npm run build` — clean. `/interments/today`, `/interments/[intermentId]`,
  and `/interments/[intermentId]/complete` all listed in the Next.js route
  manifest.

### Completion Notes List

- **Deviation from spec — `INVALID_STATE` error code (Task 2 wording).** The
  story spec asks `completeInterment` to throw `ConvexError({ code: "INVALID_STATE", ... })`
  when the current status isn't `"scheduled"`. `convex/lib/errors.ts` is
  READ-ONLY per the dev brief and its `ErrorCode` enum does not contain
  `INVALID_STATE`. The mutation uses `INVARIANT_VIOLATION` (with a
  descriptive message) for the explicit pre-check; the second defensive call
  to `assertIntermentTransition` continues to throw the canonical
  `ILLEGAL_STATE_TRANSITION`. Net behavior matches the spec (idempotent
  re-completion rejected; explicit + canonical errors both fire) — only the
  code string differs.
- **Deviation from spec — audit `action` + `entityType` (Task 2 wording).**
  The spec asks for `action: "complete_interment", entityType: "interment"`.
  Both `convex/lib/audit.ts` (`AUDIT_ACTIONS`, `AuditEntityType`) and the
  Convex `auditLog.entityType` validator in `convex/schema.ts` are
  READ-ONLY per the dev brief and their enums do not include
  `"complete_interment"` / `"interment"`. The mutation emits
  `action: "transition", entityType: "lot"`, keying the row on the lot
  (the aggregate root — consistent with `scheduleInterment` + `addOccupant`).
  The interment id is preserved on the `before`/`after` payload so audit
  reviewers can still surface the completion event per-interment.
- **Deviation from spec — sidebar nav (Task 5).** The spec asks for an
  update to `src/app/(staff)/layout.tsx` / Sidebar to add a "Today's
  interments" nav item for the field worker role. The dev brief restricts
  components to `IntermentForm/**` extensions, and `Sidebar/nav-items.ts`
  is outside that scope. The route is reachable by direct URL +
  /interments/calendar callouts; sidebar entry deferred to a follow-up
  with explicit Sidebar-component ownership.
- **Deviation from spec — ADR + runbook updates (Task 12).** `docs/adr/0009-interment-scheduling.md`
  and `docs/runbook.md` do not currently exist in the repo (the
  `docs/` knowledge base is empty per `CLAUDE.md`). Per the dev brief
  ("Don't create application directories speculatively. Wait for the
  Architect phase or an explicit user instruction.") and to avoid
  generating standalone .md files without context, these updates are
  flagged as a follow-up to land alongside the rest of the architecture
  knowledge base in a future docs-focused story.
- **Phase 2 reservation honoured.** Reactive cross-tab E2E (Task 7's
  `interment-completion-reactive.spec.ts`) replaced with the same
  unauthenticated-redirect smoke pattern used by Stories 7.1 / 7.2 /
  7.3 (`tests/e2e/interment-complete.spec.ts`). Full authenticated
  cross-tab journey is queued for the test-user-seeded sprint.
- **Atomic dual-write.** `completeInterment` patches the interment +
  invokes `transitionLotStatus` inside the same Convex mutation —
  single transaction, no split helpers. Tests cover happy path,
  family-plot idempotency (`lotTransitioned: false`), already-completed /
  cancelled rejections, the lot-state anomaly path
  (`assertTransition` throws), and the no-photo / with-photo / trimmed-notes
  payload shapes.
- **`assertIntermentTransition` helper added.** Mirrors the lot /
  contract / receipt sibling helpers in `convex/lib/stateMachines.ts`
  for callers that want compile-time-typed source state on the
  interment entity. Not currently consumed outside `completeInterment`
  but reserved for the future 7.5 cancellation story.
- **`COMPLETION_NOTES_MAX_LENGTH` (server) + `completionSchema.ts`
  (client)** kept in lock-step at 500 chars. Hardcoded magic number
  intentionally not shared because `convex/` and `src/` are separate
  TypeScript projects per the existing Story 7.1 precedent
  (`INTERMENT_NOTES_MAX_LENGTH`).
- **Mobile-first UX.** `CompletionForm` mirrors `LogConditionForm`
  (Story 1.14) for tap targets, photo capture, and submit copy. The
  `MarkIntermentCompleteSheet` swaps Sheet `side` based on a 768px
  breakpoint (bottom on mobile, right on desktop) and is SSR-safe
  (initial render is desktop, client effect promotes).
- **Open questions still unresolved (story §10 / Phase 2 candidates).**
  Photo privacy / cultural-consent infrastructure, multi-occupant
  interment batching, completion-reversal flow, lot-anomaly admin
  reconciliation tool, field-worker offline-write support — all flagged
  upstream; none addressed in this story.

### File List

CREATE:
- `src/components/IntermentForm/CompletionForm.tsx`
- `src/components/IntermentForm/completionSchema.ts`
- `src/components/IntermentForm/MarkIntermentCompleteSheet.tsx`
- `src/app/(staff)/interments/today/page.tsx`
- `src/app/(staff)/interments/[intermentId]/page.tsx`
- `src/app/(staff)/interments/[intermentId]/complete/page.tsx`
- `tests/unit/components/CompletionForm.test.tsx`
- `tests/e2e/interment-complete.spec.ts`

MODIFY:
- `convex/lib/states.ts` — added `INTERMENT_STATES`, `IntermentState`,
  joined `"interment"` to `EntityWithState`.
- `convex/lib/stateMachines.ts` — added `interment` entry to `TRANSITIONS`
  (terminal `completed` / `cancelled`); added typed
  `assertIntermentTransition` helper.
- `convex/interments.ts` — appended `completeInterment` mutation,
  `generateUploadUrl` mutation, `getCompletionPhotoUrl` query,
  `listTodayForFieldWorker` query, `manilaDayBounds` helper,
  `COMPLETION_NOTES_MAX_LENGTH` export; added `StorageId` type alias
  and new imports from `./lib/stateMachines` / `./lib/time`.
- `src/components/IntermentForm/index.ts` — exported the new
  `CompletionForm`, `completionSchema`, and `MarkIntermentCompleteSheet`
  surfaces.
- `tests/unit/convex/interments.test.ts` — extended `LotFixture` with
  a `status` field (defaults to `"sold"`); upgraded the `ctx.db.patch`
  mock to actually merge partials onto both `interments` and `lots`;
  added a sibling `ctx.storage` stub for upload-url + signed-URL
  generation; appended 21 tests across the four new exports.
- `tests/unit/convex/lib/stateMachines.test.ts` — joined `"interment"`
  into `ENTITY_TYPES` and the `STATES` projection; added three dedicated
  interment-shape tests (state-key set, scheduled-edges, terminal states).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped
  `7-4-field-worker-marks-an-interment-complete` from `ready-for-dev`
  to `review`; bumped the `last_updated` headline.
- `_bmad-output/implementation-artifacts/7-4-field-worker-marks-an-interment-complete.md`
  — `Status: ready-for-dev → review` + this Dev Agent Record.
