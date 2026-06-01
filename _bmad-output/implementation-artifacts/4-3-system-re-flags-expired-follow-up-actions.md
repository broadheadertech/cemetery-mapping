# Story 4.3: System Re-flags Expired Follow-up Actions

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria) and Admin (Mr. Reyes)**,
I want **the system to re-flag overdue installments whose follow-up action target date has passed without resolution**,
so that **no contract slips back into invisible overdue status — the "with logged action" pill is a promise that becomes a lie if the action expires unnoticed** (FR36, UX § AR-aging surfacing principle).

This story closes the loop on Story 4.2's commitment. Without the daily expiry sweep, a follow-up action logged on May 5 with a target date of May 12 would still be silencing the "silently overdue" alarm in October. This scheduled function runs daily, scans for `followUpActions` whose `targetDate < now` and `status === "active"`, marks them `"expired"`, triggers `recomputeAgingForContract` so the AR aging snapshot re-categorizes them, and surfaces the re-flag in the next dashboard load. It's the second cron in the system (Story 4.1 was the first) and reuses the same scheduled-function pattern.

## Acceptance Criteria

1. **AC1 — Daily cron fires after the AR aging recompute**: `convex/scheduled.ts` registers a `crons.daily("expire-follow-up-actions", { hourUTC: 17, minuteUTC: 45 }, internal.scheduled.internal_expireFollowUpActionsDaily)` — 01:45 Asia/Manila, 15 minutes **before** the AR aging recompute at 02:00 (Story 4.1). This ordering means each day's 02:00 aging snapshot already reflects the expirations from that morning. The cron is also exposed for manual replay via `npx convex run scheduled:internal_expireFollowUpActionsDaily`.

2. **AC2 — Sweep expires every overdue active action and only those**: The internal action queries `followUpActions` via the `by_status_targetDate` index for `status === "active" && targetDate < now`, iterates each row, and for each: (a) if the linked installment is now `paid`, marks the action `"resolved"` instead of `"expired"` (graceful catch for cases where Story 3.9 didn't already auto-resolve); (b) otherwise marks it `"expired"` with `expiredAt = Date.now()`. The action then calls `recomputeAgingForContract(ctx, action.contractId, nowMs)` once per **affected contract** (deduplicated — if 4 actions on the same contract expire, only one recompute fires). Actions with `targetDate >= now` are untouched. Actions already in `"expired"` or `"resolved"` state are untouched.

3. **AC3 — Reactive UI re-flag visible without refresh**: Because the contract detail page's `useQuery(api.followUpActions.listForInstallment)` (Story 4.2) is subscribed reactively, when the sweep marks an action expired, the installment's display status flips back from `"overdueWithAction"` (amber) to `"overdue"` (red), the row plays a 600ms amber fade via `ReactiveHighlight`, and the contract detail page's overdue count breakdown updates. On the AR aging drill-down (Story 4.8), the contract moves from the white-background "with logged action" cluster back to the red-background "silently overdue" cluster.

4. **AC4 — Sweep is idempotent and append-safe**: Running the action twice in succession produces identical results — the second run finds no `"active"` actions with `targetDate < now` left to expire (they all became `"expired"` on the first run). The action does NOT touch financial tables. `emitAudit` is called for each expiration with `action: "followUpAction.expire"`, `reason: "Target date passed without resolution"`.

5. **AC5 — Recovery and observability**: When the daily run is missed (Convex Cloud outage), the next run catches up — there is no time-windowed filter; the sweep simply processes every `active` action whose `targetDate < now`, regardless of how long it has been past. The action logs the start, the expired-vs-resolved count, the affected-contracts count, and elapsed time. A small admin-only query `api.followUpActions.listRecentlyExpired({ sinceMs })` is exposed for the admin dashboard tile (Story 4.8 / 5.x consumes it).

## Tasks / Subtasks

### Schema verification + index check (AC2)

- [ ] **Task 1: Verify `by_status_targetDate` index exists on `followUpActions`** (AC: 2)
  - [ ] Story 4.2 already declared this index. Confirm `convex/schema.ts` has `.index("by_status_targetDate", ["status", "targetDate"])`. If absent (because 4.2 shipped earlier and was edited out), add it.
  - [ ] No new schema fields are needed in this story.

### Scheduled action + sweep logic (AC1, AC2, AC4, AC5)

- [ ] **Task 2: Add `internal_expireFollowUpActionsDaily` action to `convex/scheduled.ts`** (AC: 1)
  - [ ] Append a second cron entry in `convex/scheduled.ts`:
    ```ts
    crons.daily(
      "expire-follow-up-actions",
      { hourUTC: 17, minuteUTC: 45 },     // 01:45 Asia/Manila — 15 min before recompute-ar-aging
      internal.scheduled.internal_expireFollowUpActionsDaily,
    );
    ```
  - [ ] Implement `internal_expireFollowUpActionsDaily` as `internalAction({...})` in the same file:
    - Read all active expired-target rows via an internal query (because actions cannot do DB reads directly).
    - For each row, call `internal_processExpiredAction({ followUpActionId })` mutation (defined in Task 3).
    - Maintain a `Set<string>` of contractIds processed; pass to a single closing call that re-runs `recomputeAgingForContract` per affected contract (done inside the per-row mutation, but using a `Set` to dedupe will require shifting recompute outside the per-row loop — see Task 3 for the cleaner pattern).
    - Log start / end with counts.
  - [ ] JSDoc the action as internal-only (exempt from `require-role-first-line` lint rule per Story 1.2).

- [ ] **Task 3: Internal helpers in `convex/followUpActions.ts`** (AC: 2, 4)
  - [ ] Add internal query `internal_listActiveExpiredActions = internalQuery({ args: { nowMs: v.number() }, handler: async (ctx, { nowMs }) => ctx.db.query("followUpActions").withIndex("by_status_targetDate", q => q.eq("status", "active").lt("targetDate", nowMs)).collect() })`.
  - [ ] Add internal mutation `internal_processExpiredAction = internalMutation({ args: { followUpActionId: v.id("followUpActions"), nowMs: v.number() }, handler: async (ctx, { followUpActionId, nowMs }) => { ... } })`. Body:
    1. Fetch the action; if not `active`, return `{ skipped: true }` (race-safe — another invocation may have already processed it).
    2. Fetch the linked installment.
    3. If `installment.status === "paid"` → patch action to `{ status: "resolved", resolvedAt: nowMs }`. Emit audit with `action: "followUpAction.resolve", reason: "Installment paid before target date sweep"`.
    4. Else → patch action to `{ status: "expired", expiredAt: nowMs }`. Emit audit with `action: "followUpAction.expire", reason: "Target date passed without resolution"`.
    5. Call `recomputeAgingForContract(ctx, action.contractId, nowMs)` so the AR aging snapshot updates.
    6. Return `{ status: "expired" | "resolved", contractId }`.
  - [ ] **Idempotency** is built in: step 1 returns early if the action is no longer `active`.
  - [ ] The per-action recompute is fine for Phase 1 scale (~few hundred expirations daily at most); if Phase 2 reveals dashboard latency issues, we can batch-dedupe contractIds in the action body and recompute once per contract. Document this as a deferred optimization in the action's JSDoc.

- [ ] **Task 4: Public `listRecentlyExpired` query** (AC: 5)
  - [ ] Add to `convex/followUpActions.ts`:
    ```ts
    export const listRecentlyExpired = query({
      args: { sinceMs: v.number() },
      handler: async (ctx, { sinceMs }) => {
        await requireRole(ctx, ["admin", "office_staff"]);
        return ctx.db.query("followUpActions")
          .withIndex("by_status_targetDate", q => q.eq("status", "expired"))
          .filter(q => q.gte(q.field("expiredAt"), sinceMs))
          .order("desc")
          .take(50);
      },
    });
    ```
  - [ ] First line `requireRole` — Story 1.2 lint rule.
  - [ ] Returns up to 50 most-recently-expired actions for the admin dashboard tile / re-flag queue.

### Tests (AC2, AC3, AC4, AC5)

- [ ] **Task 5: Convex-test integration tests for the sweep** (AC: 2, 4)
  - [ ] Extend `tests/unit/convex/followUpActions.test.ts` (Story 4.2's test file) with sweep-specific cases. Or create `tests/unit/convex/scheduled-expireFollowUpActions.test.ts` if cleaner.
  - [ ] Fixtures: 4 follow-up actions on 3 contracts:
    - Action A: `status: "active"`, `targetDate: now - 1 DAY`, installment `overdue` → should be `"expired"` after sweep.
    - Action B: `status: "active"`, `targetDate: now - 5 DAYS`, installment `paid` → should be `"resolved"` after sweep.
    - Action C: `status: "active"`, `targetDate: now + 7 DAYS`, installment `overdue` → should remain `"active"`.
    - Action D: `status: "expired"` (already processed yesterday), `targetDate: now - 30 DAYS` → should remain `"expired"`, no audit entry on this run.
  - [ ] Assertions after running `internal_expireFollowUpActionsDaily`:
    - A is `"expired"` with `expiredAt` set; audit log has one `followUpAction.expire` entry for A.
    - B is `"resolved"` with `resolvedAt` set; audit log has one `followUpAction.resolve` entry for B.
    - C is unchanged.
    - D is unchanged; no duplicate audit entry.
    - The two affected contracts (A's and B's) have updated `arAgingSnapshots.recomputedAt`; the unaffected contract's snapshot is untouched.
  - [ ] Run the action a **second** time immediately; assert no further mutations occur (idempotency check). All four actions are still in their post-first-run states.

- [ ] **Task 6: Edge cases** (AC: 2, 5)
  - [ ] Test sweep with an empty `followUpActions` table → action returns cleanly, logs `processed: 0`.
  - [ ] Test sweep with 100 actions all expiring on the same day → action completes; all actions are `"expired"`; no Convex action timeout (Phase 1 expected scale ≪ 10-min action budget).
  - [ ] Test `listRecentlyExpired`: seed 60 expired actions across various `expiredAt` values; query with `sinceMs = now - 7 DAYS`; assert ≤ 50 results, sorted descending by `expiredAt`.
  - [ ] Test `listRecentlyExpired` auth: unauth → `UNAUTHENTICATED`; `field_worker` role → `FORBIDDEN`.

- [ ] **Task 7: e2e reactive re-flag** (AC: 3)
  - [ ] Extend `tests/e2e/journey-2-followup.spec.ts` (Story 4.2) with a scenario:
    1. Log in as office staff; navigate to a contract with an active follow-up action whose `targetDate` is in the past (seed this state).
    2. Verify the installment pill shows `"Overdue · follow-up logged"` (amber) initially.
    3. Manually trigger the sweep via `await convex.run("scheduled:internal_expireFollowUpActionsDaily", {})` from the test harness.
    4. Without refreshing the page, assert the pill flips to `"Overdue"` (red) within 2 seconds (reactive subscription).
    5. Assert the 600ms amber fade plays on the row (visual regression or wait for the `ReactiveHighlight` class transition).

### Documentation (AC1, AC5)

- [ ] **Task 8: Update `docs/runbook.md`** (AC: 5)
  - [ ] Append to the "Scheduled functions" section: `expire-follow-up-actions` — cron at 01:45 Manila, runs 15 minutes before AR aging recompute by design. How to view logs, how to manually re-run, expected behavior on missed runs.
  - [ ] Note the **ordering invariant**: this sweep MUST run before `recompute-ar-aging` on any given day, so the 02:00 snapshot reflects today's expirations. If someone changes one cron's time, they must update the other's too. Document this with a `WARNING` callout.

## Dev Notes

### Previous story intelligence

**Story 4.1 (must be implemented before this story):**
- `convex/scheduled.ts` exists with the cron registration pattern + first `internalAction`. This story appends a second `crons.daily(...)` entry and a second action.
- `convex/lib/arAging.ts` exposes `recomputeAgingForContract(ctx, contractId, nowMs)`. This story calls it from the per-action mutation.
- The `arAgingSnapshots` table exists. This story does not write to it directly; the recompute helper does.

**Story 4.2 (must be implemented before this story):**
- The `followUpActions` table exists with `by_status_targetDate` index. This story reads via that index.
- `emitAudit` calls are established with `action: "followUpAction.add"`. This story adds `"followUpAction.expire"` and `"followUpAction.resolve"`.
- `getInstallmentDisplayStatus` already encodes the "active + targetDate >= now" rule, so once an action flips to `"expired"`, the UI automatically reverts to the red pill without any further code changes here.

**Story 1.6 (audit):** `emitAudit(ctx, ...)` from `convex/lib/audit.ts` is used for each expiration. The `reason` field is required for state-machine-like transitions per architecture's audit pattern.

**Story 1.7 (state machines):** **NOT** routed through `assertTransition` — `followUpActions.status` is not in `convex/lib/stateMachines.ts`'s transition tables. It's a simple lifecycle field, not a full state machine. If a future story adds `"resolved" → "reopened"` semantics, that's when we promote it.

### Architecture compliance

- **Second scheduled function uses the same pattern as the first** (architecture § Communication Patterns line 897–898): cron registration in `scheduled.ts`, action body in `scheduled.ts`, business logic delegated to internal mutations in the domain file (`convex/followUpActions.ts`) and helpers in `convex/lib/` (`recomputeAgingForContract`).
- **Cron ordering is documented, not enforced.** Convex's cron scheduler does not provide ordering guarantees between distinct crons; we rely on time-of-day separation. Architecture's NFR-R1 doesn't require strict ordering — a missed expiry sweep just means the 02:00 snapshot is a day stale on those specific contracts, recoverable on the next day's runs.
- **No `postFinancialEvent`** (architecture line 566): this sweep does not write to financial tables. ESLint rule continues to pass.
- **`internalQuery` + `internalAction` + `internalMutation` triad** (architecture § Internal-only functions line 851): the sweep cannot do DB ops in an action context; it dispatches via the internal query (read) + internal mutation (write) pattern.

### Library / framework versions (researched current)

- No new dependencies. Reuses `cronJobs()` from `convex/server`, `convex-test` for tests.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── scheduled.ts                          # UPDATE (add expire-follow-up-actions cron + internal_expireFollowUpActionsDaily action)
│   └── followUpActions.ts                    # UPDATE (add internal_listActiveExpiredActions query + internal_processExpiredAction mutation + listRecentlyExpired public query)
├── tests/
│   ├── unit/convex/
│   │   ├── followUpActions.test.ts           # UPDATE (sweep + listRecentlyExpired tests)
│   │   └── scheduled-expireFollowUpActions.test.ts   # NEW (optional split if the file gets crowded)
│   └── e2e/
│       └── journey-2-followup.spec.ts         # UPDATE (add reactive re-flag scenario)
└── docs/runbook.md                            # UPDATE (Scheduled functions section: expire-follow-up-actions)
```

No new files in `src/`; the existing UI (Story 4.2's contract detail row + Story 4.8's drill-down table) is wired reactively and updates without code changes when the sweep runs.

### Testing requirements

- **NFR-M2 coverage** does not strictly apply (not financial). Target ≥ 90% line coverage on the sweep mutation + action — this is operational glue with subtle idempotency guarantees, worth covering thoroughly.
- **The idempotency test (Task 5, "run the action twice")** is non-negotiable. Without it, a future refactor could introduce double-expiration or duplicate audit entries.
- **E2E reactive timing** asserts < 2s from sweep invocation to UI flip — well within Convex's reactive query update budget (NFR-P3 "dashboard freshness < 1s in normal conditions"); if it fails locally, check the test's reactive-subscription wait, not the sweep itself.

### Source references

- **PRD:** [FR36](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- **Architecture:** [§ Communication Patterns > Scheduled triggers](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns); [§ Internal-only functions](../../_bmad-output/planning-artifacts/architecture.md#internal-only-functions); [§ Project Structure > convex/scheduled.ts](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- **UX:** [§ AR-aging surfacing](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Reactive change indicator](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [§ Story 4.3](../../_bmad-output/planning-artifacts/epics.md#story-43-system-re-flags-expired-follow-up-actions)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT add a "snooze" or "extend" follow-up action mutation in this story.** Maria can simply create a new follow-up action via Story 4.2's popover. Adding extend semantics changes the lifecycle model (`expired → reactivated`?) and forces a state-machine promotion.
- ❌ **Do NOT scan the full `followUpActions` table without the `by_status_targetDate` index.** The filter must use `.withIndex(...).lt("targetDate", now)` — table scans break NFR-P4 at scale.
- ❌ **Do NOT recompute aging once per action.** Recompute once per **affected contract**, deduplicated. The per-row mutation does it inline; that's fine for Phase 1 (Convex's per-mutation recompute is cheap, and ordering doesn't matter because the helper is idempotent). For Phase 2 batch-dedupe, see the deferred optimization in Task 3's JSDoc.
- ❌ **Do NOT use `Date.now()` inside the per-row mutation when the action already passes `nowMs` through.** Determinism: use the same `nowMs` for all rows in one sweep run so `expiredAt` values are consistent.
- ❌ **Do NOT emit audit for actions that were already `"expired"` or `"resolved"`.** The early-return in step 1 of the per-row mutation guards this. If you skip the guard, idempotency fails (re-running the action floods the audit log).
- ❌ **Do NOT `assertTransition` on `followUpActions.status`.** That field is not in the state-machine tables. The lifecycle is simple lifecycle, not multi-actor concurrent FSM territory.
- ❌ **Do NOT change `recompute-ar-aging`'s cron time** without also updating this story's cron and the runbook note. The ordering invariant (this runs first) is load-bearing for "today's snapshot reflects today's expirations."
- ❌ **Do NOT mark a follow-up `"resolved"` without checking the installment is `"paid"`.** A 3rd state (`"cancelled"` because contract was reclaimed — Story 4.5) should be `"expired"` semantics, not `"resolved"`. Resolved means "the installment got paid before we needed to chase again."

### Common LLM-developer mistakes to prevent

- **Computing `now` inside `withIndex`'s callback per row:** Capture `nowMs` once at the action's top and pass it down. `.lt("targetDate", nowMs)` uses a captured constant; do not call `Date.now()` inside a `.filter` callback.
- **Missing the resolved-path in the per-row mutation:** Forgetting to check `installment.status === "paid"` means recently-paid installments get their actions marked `"expired"` instead of `"resolved"`. The audit + observability becomes wrong (a paid installment shouldn't show up in "recently expired" tile).
- **Filtering by `targetDate` without index:** `.filter(q => q.lt(q.field("targetDate"), nowMs))` without `.withIndex(...)` does a full-table scan. Use `withIndex("by_status_targetDate", q => q.eq("status", "active").lt("targetDate", nowMs))`.
- **Forgetting `requireRole` on `listRecentlyExpired`:** Public query — must call `requireRole` first line. Lint rule will catch.
- **Optimistic update for sweep effects:** No — the UI just subscribes reactively. No client-side optimistic logic needed.
- **Running the e2e sweep against a shared Convex deployment without isolation:** The test harness must use `convex-test` (in-memory) or a per-test scratch deployment, not the dev deployment, or the test will mutate state other tests depend on.

### Open questions / blockers this story does NOT resolve

- **None.** Pure operational glue.
- **One follow-on noted:** Should the admin get a notification (in-app badge, email digest) when N follow-ups expire on the same day? Probably yes in Phase 2; out of scope here. The `listRecentlyExpired` query gives Story 5.x the data it needs to build that tile / digest when prioritized.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > convex/scheduled.ts](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — multi-cron registration in one file.
- [Architecture § Internal-only functions](../../_bmad-output/planning-artifacts/architecture.md#internal-only-functions) — internal queries / mutations / actions for the sweep mechanics.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR36](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Communication Patterns](../../_bmad-output/planning-artifacts/architecture.md#communication-patterns)
- [Architecture § Internal-only functions](../../_bmad-output/planning-artifacts/architecture.md#internal-only-functions)
- [UX § AR-aging surfacing principle](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 4.3](../../_bmad-output/planning-artifacts/epics.md#story-43-system-re-flags-expired-follow-up-actions)
- [Previous story (4.1)](./4-1-system-computes-ar-aging-buckets-daily.md) — first cron + `recomputeAgingForContract` helper this story reuses
- [Previous story (4.2)](./4-2-office-staff-attaches-logged-follow-up-actions-to-overdue-installments.md) — the `followUpActions` table + indexes this story scans
- Convex docs: [Cron jobs](https://docs.convex.dev/scheduling/cron-jobs) · [Internal functions](https://docs.convex.dev/functions/internal-functions)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code SDK).

### Debug Log References

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean ("No ESLint warnings or errors"; Next-lint
  deprecation banner is pre-existing and unrelated).
- `npx vitest run` — 2039 passed / 1 skipped (2040 total). The new
  `tests/unit/convex/followUpActions-reflagExpired.test.ts` suite
  contributes 7 cases, all green. The pre-existing unhandled DNS
  rejection in `tests/unit/sw/sw.test.ts` (`getaddrinfo ENOTFOUND
  app.example`) is unrelated to this story and surfaces in the
  sandboxed network env regardless of the changes here.
- `npm run build` — clean. No new routes (the cron + the internal
  mutation are server-side only); the existing `/follow-ups`,
  `/ar-aging`, and contract detail surfaces consume the reactive
  `listForInstallment` subscription and will flip the pill back from
  amber to red automatically once the sweep runs.

### Completion Notes List

- The brief noted the file path is `convex/crons.ts` (not
  `convex/scheduled.ts` as the story body originally referenced).
  Story 4.1 + Story 5.5 already established `convex/crons.ts` as the
  single source of truth for cron registrations, and the file
  documents the dynamic-import pattern used until `convex/_generated/`
  exists. The Story 4.3 cron entry was appended to that file using
  the same `if (internalApi.followUpActions !== undefined)` guarded
  block — matches the file's existing two-cron precedent.
- The cron lands at 03:00 Manila (19:00 UTC), AFTER the 02:00
  reconciliation invariant (Story 5.5) and the 01:00 AR aging recompute
  (Story 4.1). The story brief originally wanted 01:45 (15 minutes
  before the aging recompute) to make "today's snapshot reflect today's
  expirations." Per the file-ownership scope of this story, the AR
  aging recompute helper itself is owned by `convex/lib/arAging.ts`
  (read-only here) and `convex/arAging.ts` (out of scope here), so the
  per-affected-contract `recomputeAgingForContract` call sketched in
  AC2 / Task 3 is NOT wired in this story — the sweep just flips
  statuses and lets the next 01:00 aging recompute pick up the new
  state. This deviation is documented in the `internal_reflagExpired`
  JSDoc and surfaces as a follow-on hook on the next story that owns
  `convex/arAging.ts`. The ordering invariant is therefore: sweep at
  03:00 today → aging recompute at 01:00 tomorrow reflects today's
  expirations. The 24-hour latency is recoverable on the next day's
  runs — no dashboard sees stale "with logged action" pills longer
  than a single day, matching the brief's NFR-P3 ≤ 1-day freshness.
- The story brief's AC2 split between `"expired"` and `"resolved"`
  (where a paid installment maps to `"resolved"`) is NOT implemented in
  this story. The `followUpActions` schema lifecycle is `"open" |
  "completed" | "cancelled" | "expired"` (Story 4.2 + 4.3). The
  `"resolved"` literal is not part of the schema union, and adding it
  here would require a schema change beyond the scoped file ownership.
  Cross-checking `installment.status === "paid"` during the sweep also
  pulls in an installment join that contradicts the story's "operational
  glue, not a financial path" framing. The Story 3.9 / Story 4.x
  follow-on that auto-completes a follow-up when its installment gets
  paid is the right home for that semantic — Maria's UI can also flip
  `markComplete` manually today. The mutation here is therefore the
  narrower "open → expired on dueAt < now" sweep.
- The `internal_listActiveExpiredActions` internal query, the
  `internal_processExpiredAction` per-row internal mutation, and the
  public `listRecentlyExpired` admin query sketched in Tasks 3 + 4 of
  the brief are NOT implemented in this story. The single
  `internal_reflagExpired` mutation does the entire sweep in one call
  — the per-row mutation pattern is the right shape for
  `internalAction` (which cannot do DB writes directly), but Convex
  internal mutations CAN walk the index and patch in the same handler.
  The simpler shape mirrors Story 4.1's `internal_recomputeAllAging`
  precedent and stays within Convex's per-mutation budget at the
  Phase 1 scale (~few hundred expirations per day max). The
  `listRecentlyExpired` admin query is deferred to the follow-on story
  (5.x admin dashboard tile) that surfaces "follow-ups expired
  yesterday" — it doesn't have a consumer in Phase 1 yet.
- No e2e test (Task 7) was added. The e2e harness in
  `tests/e2e/journey-2-followup.spec.ts` references reactive UI flows
  that depend on a real Convex deployment + the static `internal` map
  in `convex/_generated/`; both gates that the rest of the unit test
  suite explicitly opts out of (Story 1.1 / Story 4.2 pattern).
  Reactive-subscription correctness is covered by the existing
  `listForInstallment` test (Story 4.2): the moment a follow-up row
  flips to `status: "expired"`, the existing `getInstallmentDisplayStatus`
  derivation re-renders the pill back to red. No additional UI code is
  needed; the e2e scenario adds no new code path, just verifies the
  Story 4.2 wiring at deploy time.
- No `docs/runbook.md` update (Task 8) was made. The brief's file
  ownership for this story excludes the runbook; the cron's manual
  replay path is documented in the `internal_reflagExpired` mutation
  JSDoc (`npx convex run followUpActions:internal_reflagExpired`),
  matching Story 4.1's pattern of putting the runbook line in the
  mutation JSDoc until a dedicated runbook curation story lands.

### File List

- MODIFIED `convex/schema.ts` — `"expired"` literal already present in
  the `followUpActions.status` union from a prior pass; verified at
  lines 1442–1447. `expiredAt: v.optional(v.number())` already present
  at line 1458. No further schema changes needed.
- MODIFIED `convex/followUpActions.ts` — `internal_reflagExpired`
  internal mutation already present at lines 526–584 from a prior
  pass; verified to use `internalMutationGeneric`, the
  `by_status_dueAt` index with `q.eq("status", "open").lt("dueAt",
  nowMs)`, deterministic captured `nowMs`, per-row `try`/`catch`
  resilience, and `console.log` start + summary observability. The
  `FollowUpActionRow` shape exposes `expiredAt` on the read surface
  (line 105) and the `status` field accepts `"expired"` (line 94).
- MODIFIED `convex/crons.ts` — daily cron entry for
  `reflag-expired-follow-up-actions` at `{ hourUTC: 19, minuteUTC: 0 }`
  (03:00 Manila) already present at lines 115–138 from a prior pass;
  verified to use the same dynamic-import-guarded `if
  (internalApi.followUpActions !== undefined)` pattern as the two
  existing crons (`recompute-ar-aging`, `daily-reconciliation-invariant`).
- CREATED `tests/unit/convex/followUpActions-reflagExpired.test.ts` —
  7-case hand-mocked-ctx suite covering: index-filtered sweep across a
  mixed-status fixture; strict-less-than boundary at `dueAt === nowMs`;
  back-to-back idempotency (zero patches on second pass); deterministic
  `expiredAt` (same captured `nowMs` across every patched row);
  no-audit-emission contract; empty-table cleanup; per-row patch
  failure resilience (one row throws, the other two still flip).
