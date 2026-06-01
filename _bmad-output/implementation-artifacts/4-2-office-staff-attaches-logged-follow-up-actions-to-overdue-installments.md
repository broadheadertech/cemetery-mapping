# Story 4.2: Office Staff Attaches Logged Follow-up Actions to Overdue Installments

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria)**,
I want **to attach a logged follow-up action with a free-text note and a target date to any overdue installment**,
so that **"we're handling this" is visible at scale and an overdue installment is no longer indistinguishable from a silently-overdue one — Mr. Reyes can trust that ₱X in 90+ days really means "₱X with Y% in active follow-up"** (FR35, UX-DR aging risk distinction).

This is **Maria's < 30-second recovery action** (UX § Key Moments, Journey 2 missed-payment recovery target). The story stands up the `followUpActions` table, the `addFollowUpAction` mutation that pairs with `recomputeAgingForContract` from Story 4.1, the Popover UI attached to overdue installment rows, and the installment status pill's new `"overdueWithAction"` state (amber). After this story ships, the AR aging snapshot's `overdueCountWithAction` / `overdueCountSilent` split becomes meaningful — Story 4.8 then renders that split in the drill-down table.

## Acceptance Criteria

1. **AC1 — `followUpActions` table exists with the right shape**: `convex/schema.ts` defines `followUpActions` with `installmentId`, `contractId` (denormalized for index-based queries by contract), `note` (3–500 chars), `targetDate` (unix ms), `status: "active" | "expired" | "resolved"`, `createdBy: Id<"users">`, `createdAt`, `expiredAt?`, `resolvedAt?`. Indexes: `by_installment`, `by_contract`, `by_status_targetDate` (for Story 4.3's expiry sweep), `by_active_assignee` (reserved — Story 5.4 owner flag overlap).

2. **AC2 — Adding a follow-up action from an overdue installment row**: From the contract detail page (Story 3.6) or AR aging drill-down (Story 4.8), Office Staff on an installment row whose status is `"overdue"` sees an **"Add follow-up action"** button. Clicking it opens a `Popover` (shadcn/ui) containing: a required `Textarea` for the note (`maxLength=500`, 3-row visible), a required date picker for `targetDate` (must be ≥ today, default = today + 7 days, Manila tz), a `Submit` button, and a `Cancel` button. Submit calls `api.followUpActions.addFollowUpAction`.

3. **AC3 — Mutation creates the action, recomputes aging, emits audit**: `api.followUpActions.addFollowUpAction({ installmentId, note, targetDate })` runs `requireRole(ctx, ["office_staff", "admin"])`, validates `note.length >= 3 && note.length <= 500` and `targetDate >= startOfTodayManila`, inserts the row with `status: "active"`, calls `recomputeAgingForContract(ctx, contract._id, Date.now())` (from Story 4.1) so the `arAgingSnapshots` row updates, calls `emitAudit(ctx, { action: "followUpAction.add", entityType: "installment", entityId, before: null, after: { note, targetDate }, reason: note })`, and returns `{ followUpActionId }`. All in one atomic mutation.

4. **AC4 — Installment status pill flips to "Overdue with logged action"**: The installment's effective status pill on the contract detail page (Story 3.6) reflects the new state — `"overdueWithAction"` (amber background, amber-900 text, "⏱" icon, label "Overdue · follow-up logged"). The contract detail page re-renders reactively (Convex subscription on installments + followUpActions) with a 600ms amber fade via `ReactiveHighlight` (Story 1.4). The page subtitle's overdue count breakdown updates ("3 overdue · 1 with logged follow-up").

5. **AC5 — Idempotency and edge cases**: Adding two follow-up actions to the same installment is allowed (Maria may need to log "called, no answer" then "called back, promised to pay Friday"); the most-recent active action determines the installment's pill state. If the installment is currently in any state other than `"overdue"` (e.g. `"paid"`, `"current"`), the mutation throws `ConvexError({ code: "INVALID_INSTALLMENT_STATE" })` — follow-up actions on paid or not-yet-due installments are not a legal flow. The Popover surfaces this server-side error inline. Audit captures the actor + timestamp for every successful add.

## Tasks / Subtasks

### Schema (AC1)

- [ ] **Task 1: Add `followUpActions` table** (AC: 1)
  - [ ] In `convex/schema.ts`:
    ```ts
    followUpActions: defineTable({
      installmentId: v.id("installments"),
      contractId: v.id("contracts"),
      note: v.string(),                          // 3..500 chars (enforced in mutation)
      targetDate: v.number(),                    // unix ms; must be >= start of today Manila
      status: v.union(
        v.literal("active"),
        v.literal("expired"),                    // set by Story 4.3 scheduled sweep
        v.literal("resolved"),                   // set when underlying installment becomes paid
      ),
      createdBy: v.id("users"),
      createdAt: v.number(),
      expiredAt: v.optional(v.number()),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_installment", ["installmentId"])
      .index("by_contract", ["contractId"])
      .index("by_status_targetDate", ["status", "targetDate"])    // Story 4.3's sweep query
      .index("by_active_assignee", ["status", "createdBy"]),       // reserved for Story 5.4 staff queue
    ```
  - [ ] **Why denormalize `contractId`?** Story 4.1's `recomputeAgingForContract` queries `followUpActions` by `by_installment` (per installment) — but the AR aging drill-down (Story 4.8) and the contract detail page want all actions on a contract in one query. `by_contract` is the cheap path; the denormalized field stays consistent because installments never change contract.
  - [ ] Document in a JSDoc comment on the table: "`status: active` is the only state that suppresses the silent-overdue pill. `expired` (set by Story 4.3 scheduled sweep) and `resolved` (set when the underlying installment is paid) both fall through to the underlying installment's overdue state."

### Convex mutation + queries (AC3, AC5)

- [ ] **Task 2: `convex/followUpActions.ts` — `addFollowUpAction` mutation** (AC: 3, 5)
  - [ ] Create the new domain file `convex/followUpActions.ts`.
  - [ ] Implement:
    ```ts
    export const addFollowUpAction = mutation({
      args: {
        installmentId: v.id("installments"),
        note: v.string(),
        targetDate: v.number(),
      },
      handler: async (ctx, { installmentId, note, targetDate }) => {
        const { userId } = await requireRole(ctx, ["office_staff", "admin"]);

        // Validation
        const trimmed = note.trim();
        if (trimmed.length < 3 || trimmed.length > 500) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Follow-up note must be 3–500 characters.");
        }
        const startOfTodayManila = startOfDayMs(Date.now(), "Asia/Manila");  // from convex/lib/time.ts
        if (targetDate < startOfTodayManila) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Target date must be today or later.");
        }

        // Installment + contract lookups + state guard
        const installment = await ctx.db.get(installmentId);
        if (!installment) throwError(ErrorCode.INVARIANT_VIOLATION, "Installment not found.");
        if (installment.status !== "overdue") {
          throwError("INVALID_INSTALLMENT_STATE", "Follow-up actions are only allowed on overdue installments.");
        }
        const contract = await ctx.db.get(installment.contractId);
        if (!contract) throwError(ErrorCode.INVARIANT_VIOLATION, "Contract not found.");

        const nowMs = Date.now();
        const followUpActionId = await ctx.db.insert("followUpActions", {
          installmentId,
          contractId: contract._id,
          note: trimmed,
          targetDate,
          status: "active",
          createdBy: userId,
          createdAt: nowMs,
        });

        // Recompute AR aging snapshot (Story 4.1)
        await recomputeAgingForContract(ctx, contract._id, nowMs);

        await emitAudit(ctx, {
          action: "followUpAction.add",
          entityType: "installment",
          entityId: installmentId,
          before: null,
          after: { note: trimmed, targetDate, status: "active" },
          reason: trimmed,
        });

        return { followUpActionId };
      },
    });
    ```
  - [ ] Add `"INVALID_INSTALLMENT_STATE"` to `convex/lib/errors.ts`'s `ErrorCode` constant (Story 1.2's namespace) if not already present.
  - [ ] **First line of handler is `requireRole`** — Story 1.2's lint rule must pass.

- [ ] **Task 3: `listForInstallment` and `listForContract` queries** (AC: 4)
  - [ ] In `convex/followUpActions.ts`, add:
    ```ts
    export const listForInstallment = query({
      args: { installmentId: v.id("installments") },
      handler: async (ctx, { installmentId }) => {
        await requireRole(ctx, ["office_staff", "admin"]);
        return ctx.db.query("followUpActions")
          .withIndex("by_installment", q => q.eq("installmentId", installmentId))
          .order("desc")
          .collect();
      },
    });

    export const listForContract = query({
      args: { contractId: v.id("contracts") },
      handler: async (ctx, { contractId }) => {
        await requireRole(ctx, ["office_staff", "admin"]);
        return ctx.db.query("followUpActions")
          .withIndex("by_contract", q => q.eq("contractId", contractId))
          .order("desc")
          .collect();
      },
    });
    ```
  - [ ] Both must start with `requireRole` (Story 1.2 lint rule).

### Status pill extension (AC4)

- [ ] **Task 4: Extend `StatusPill` with `"overdueWithAction"` variant** (AC: 4)
  - [ ] `src/components/StatusPill.tsx` (Story 1.4) already has installment-state variants. Add the `"overdueWithAction"` state if it is not present:
    - Background: `bg-amber-50`
    - Text: `text-amber-900`
    - Icon: `⏱` (clock)
    - Border: `border-amber-700`
    - Label: `"Overdue · follow-up logged"` (short label) or `"Overdue (logged action)"` (compact)
  - [ ] Tokens come from `tailwind.config.ts` (Story 1.4); do not hard-code hex.
  - [ ] Verify the existing token in `--color-status-installment-overdueWithAction: amber-600` (UX § 4 Color tokens line 446) is wired through. If not, add it.
  - [ ] Update `StatusPill.test.tsx`: snapshot + axe-core scan over the new variant. Verify ≥ AA contrast (the table in UX § Status pill color matrix line 826–828 documents the variant explicitly).

- [ ] **Task 5: Helper `getInstallmentDisplayStatus`** (AC: 4)
  - [ ] Create or extend `src/lib/installmentStatus.ts` to expose:
    ```ts
    export function getInstallmentDisplayStatus(
      installment: Doc<"installments">,
      activeFollowUps: Doc<"followUpActions">[],
    ): "current" | "due" | "overdue" | "overdueWithAction" | "paid" {
      if (installment.status === "paid") return "paid";
      if (installment.status === "overdue") {
        const hasActive = activeFollowUps.some(a => a.status === "active" && a.targetDate >= Date.now());
        return hasActive ? "overdueWithAction" : "overdue";
      }
      // ... map other states ...
      return installment.status as any;
    }
    ```
  - [ ] **The pill's display status is a UI-derived field, not stored on the installment.** Storing it would create a sync bug between `followUpActions.status` and `installments.displayStatus`. UI derives on each render from the reactive query results.
  - [ ] Unit test: 4 cases — (a) paid installment → `"paid"`, (b) overdue + active follow-up → `"overdueWithAction"`, (c) overdue + expired follow-up → `"overdue"`, (d) overdue + no follow-up → `"overdue"`.

### UI: Popover + form (AC2, AC3, AC5)

- [ ] **Task 6: `FollowUpActionPopover` component** (AC: 2, 3, 5)
  - [ ] Create `src/components/FollowUpActionPopover.tsx`. Built on shadcn/ui `Popover` (already in `src/components/ui/`) + React Hook Form + Zod.
  - [ ] Props: `{ installmentId: Id<"installments">; trigger: React.ReactNode; onCreated?: () => void }`.
  - [ ] Body layout (matches UX § Form Patterns):
    - `Textarea` `name="note"` `rows={3}` `maxLength={500}`. Label "Follow-up note (what action was taken)". `aria-describedby` for inline validation.
    - Date picker (shadcn/ui calendar) `name="targetDate"`. Label "Target date (when to follow up again)". Default: today + 7 days. Minimum: today (Manila tz). Display format via `formatDate` from `src/lib/time.ts`.
    - Footer: `Cancel` (closes popover, clears form) + `Submit` (`min-h-[44px]` per NFR-A4, disabled while pending).
  - [ ] Zod schema:
    ```ts
    const schema = z.object({
      note: z.string().trim().min(3, "Note must be at least 3 characters.").max(500),
      targetDate: z.number().int().min(startOfTodayManila(), "Target date must be today or later."),
    });
    ```
  - [ ] On submit, call `useMutation(api.followUpActions.addFollowUpAction)`. On success: close popover, call `onCreated?.()`, the reactive query updates the row automatically (no manual refetch).
  - [ ] On server error, use `translateError(e)` from `src/lib/errors.ts` — display the headline inline with `role="alert"`. Codes to map: `INVALID_INSTALLMENT_STATE` → "This installment is no longer overdue. Refresh to see current status."; `INVARIANT_VIOLATION` → use the server-supplied message.

- [ ] **Task 7: Wire the popover into the contract detail installments table** (AC: 2, 4)
  - [ ] In Story 3.6's `src/app/(staff)/contracts/[contractId]/page.tsx` (which renders the installments table), for each installment row:
    - Use `useQuery(api.followUpActions.listForInstallment, { installmentId })` to fetch this row's follow-up actions reactively.
    - Compute the display status via `getInstallmentDisplayStatus`.
    - Render the `StatusPill` with the derived status.
    - If display status is `"overdue"` OR `"overdueWithAction"`, render the `"Add follow-up action"` button as the popover trigger. The button label is `"Add follow-up"` if no active action exists, `"Log another"` if one already exists (per AC5 — multiple follow-ups allowed).
    - If active follow-ups exist, render a small below-row caption listing each note + targetDate in chronological order, separated by `·`.
  - [ ] **Use the existing `ReactiveHighlight` wrapper (Story 1.4)** around each installment row — when the row's effective status changes (silent → with-action), the 600ms amber fade plays.

### Tests (AC1, AC2, AC3, AC4, AC5)

- [ ] **Task 8: Convex-test mutation unit tests** (AC: 3, 5)
  - [ ] Create `tests/unit/convex/followUpActions.test.ts`.
  - [ ] Cases:
    - **Happy path:** seed contract + overdue installment; call `addFollowUpAction`; assert one `followUpActions` row exists with the right fields, audit log has the entry, `arAgingSnapshots` row for the contract has `overdueCountWithAction = 1` (verifies Story 4.1 integration).
    - **Unauth:** no auth → `UNAUTHENTICATED`.
    - **Wrong role:** `field_worker` → `FORBIDDEN`.
    - **Note too short:** 2-char note → `INVARIANT_VIOLATION`.
    - **Note too long:** 501 chars → `INVARIANT_VIOLATION`.
    - **Target date in past:** `targetDate = now - DAY_MS` → `INVARIANT_VIOLATION`.
    - **Installment not overdue:** seed a `paid` installment → `INVALID_INSTALLMENT_STATE`.
    - **Two consecutive adds:** both succeed; both rows exist; aging snapshot still has `overdueCountWithAction = 1` (one installment, one or more actions — the count is per installment, not per action).
  - [ ] Coverage target ≥ 90% line + branch on `convex/followUpActions.ts`.

- [ ] **Task 9: Component test for `FollowUpActionPopover`** (AC: 2, 5)
  - [ ] `src/components/FollowUpActionPopover.test.tsx`. Use Testing Library.
  - [ ] Cases:
    - Renders the trigger, opens on click, focuses the textarea on open.
    - Submit disabled until note length ≥ 3 and date valid.
    - Submit calls the mutation with trimmed note + selected date.
    - On mutation success, popover closes.
    - On mutation failure (mock the hook to throw `INVALID_INSTALLMENT_STATE`), error sentence appears inline with `role="alert"`.
    - axe-core scan: zero violations.

- [ ] **Task 10: e2e — Maria's < 30s missed-payment recovery** (AC: 2, 4)
  - [ ] Extend `tests/e2e/journey-2-payment.spec.ts` (Story 3.9's e2e) with a "log follow-up" sub-spec, OR create `tests/e2e/journey-2-followup.spec.ts` if cleaner.
  - [ ] Steps: log in as office staff → navigate to a seeded contract with an overdue installment → click "Add follow-up action" → type note ("Called, will pay Friday") → pick target date → submit → assert popover closes → assert installment row's pill shows `"Overdue · follow-up logged"` → assert reactive fade visible. Time the full flow; assert < 30s (the UX § Key Moments target).

### Documentation (AC1)

- [ ] **Task 11: Update `docs/runbook.md` + ADR if pattern changes** (AC: 1)
  - [ ] In `docs/runbook.md`, add a "Follow-up actions" subsection under "AR aging operations" describing: what the table tracks, the lifecycle states (`active` → `expired` by 4.3 sweep, `active` → `resolved` when installment paid by 3.9's payment posting — note 3.9's logic may need extension to mark linked follow-ups resolved; if not in 3.9, file as a follow-on task), how to manually mark an action expired (`npx convex run followUpActions:markExpiredById --id ...`).
  - [ ] No new ADR is required — the pattern (denormalized contractId, UI-derived display status) is a standard application of architecture's data-modeling guidance.

## Dev Notes

### Previous story intelligence

**Epic 1 foundation:**
- `requireRole`, `requireAuth`, `ErrorCode`, `throwError` from Story 1.2 (`convex/lib/auth.ts`, `convex/lib/errors.ts`).
- `emitAudit` from Story 1.6 (`convex/lib/audit.ts`).
- `assertTransition` from Story 1.7 (`convex/lib/stateMachines.ts`) — **not used here** because adding a follow-up action does not transition the installment's own state; the display status is UI-derived. If a future story needs the installment to formally enter an `"overdueWithAction"` state in the schema, it becomes a state-machine transition then.
- `StatusPill` from Story 1.4 — extended here with the `overdueWithAction` variant if not already present in the original component build.
- `ReactiveHighlight` from Story 1.4 — wraps the installment row for the 600ms amber fade on reactive change.
- `formatDate`, `startOfDayMs`, Manila tz helpers from `src/lib/time.ts` / `convex/lib/time.ts` (Story 1.8 expanded these beyond the minimal HOUR_MS/DAY_MS from Story 1.2; if `startOfDayMs` is not present, add it here — small, well-tested helper).

**Story 3.4 / 3.6 dependencies:**
- Story 3.4 created the `installments` table with `contractId`, `dueAt`, `amountCents`, `status` (where `status` includes `"current" | "due" | "overdue" | "paid"`). This story's mutation guards on `installment.status === "overdue"`. **If Story 3.4 named the status field differently, align with that name — do not invent.**
- Story 3.6 introduced the contract detail page (`src/app/(staff)/contracts/[contractId]/page.tsx`) with an installments table. This story extends each row with the popover trigger + follow-up caption.
- Story 3.9 posts payments via `postFinancialEvent` and marks installments paid. **When an installment becomes paid, any active follow-up actions on it should be marked `"resolved"`** — this is a side effect that Story 3.9's `postFinancialEvent` body may not implement yet. If it does not, add a follow-up TODO in this story's "Completion Notes List" and consider whether Story 4.2 or a small bug-fix story patches `postFinancialEvent` to mark linked follow-ups resolved. **For AC purposes here**, an unresolved-but-expired-naturally action is handled by Story 4.3's sweep; the resolved status is a niceness, not a blocker.

**Story 4.1 dependency:**
- `recomputeAgingForContract(ctx, contractId, nowMs)` from `convex/lib/arAging.ts` — called by this story's `addFollowUpAction` mutation so the AR aging snapshot's `overdueCountWithAction` / `overdueCountSilent` split reflects the new follow-up immediately, not 24 hours later.
- **If Story 4.1 has not shipped yet** at the time this story is implemented, this story can still ship by skipping the recompute call (the daily cron will catch it within 24h). Flag in Completion Notes if so.

### Architecture compliance

- **Domain file convention** (architecture § Naming Patterns line 399): one Convex domain per file → `convex/followUpActions.ts`. Helpers shared with Story 4.1 / 4.3 live in `convex/lib/arAging.ts`.
- **`emitAudit` mandatory** (architecture § Enforcement Guidelines line 569): every "financial-touching" mutation calls `emitAudit`. Is a follow-up action financial-touching? It affects how AR is communicated, not balances. **Decision: yes, emit audit** — the action is part of the collections trail and Mr. Reyes / auditors will want to see who logged what and when. Cheap insurance, matches NFR-S7 spirit.
- **No `postFinancialEvent` call** (architecture line 566): this mutation does NOT write to `payments` / `receipts` / `paymentAllocations` / `contracts.balance`, so it does not route through `postFinancialEvent`. The Story 3.2 ESLint rule should not fire.
- **Status pill compositional pattern** (architecture § Frontend > Component library line 313; UX § StatusPill anatomy line 806): the `overdueWithAction` variant uses the same `bg-amber-50` / `text-amber-900` family as `"reserved"` and `"due"` — by design, per UX § Status pill color matrix.

### Library / framework versions (researched current)

- **shadcn/ui `Popover`** — added when needed (shadcn's copy-paste model). Run `npx shadcn@latest add popover` if not already present. Pulls Radix's `@radix-ui/react-popover` as a dep.
- **shadcn/ui `Calendar`** — same; `npx shadcn@latest add calendar`. Pulls `react-day-picker`. Used for the date picker.
- **React Hook Form** + **Zod** — Story 3.4 / 3.9 introduced both for the SaleForm / PaymentForm. Reuse.
- **No new external deps** beyond the shadcn primitives.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                              # UPDATE (add followUpActions table + 4 indexes)
│   ├── followUpActions.ts                     # NEW (mutation + 2 queries)
│   └── lib/
│       ├── errors.ts                          # UPDATE (add INVALID_INSTALLMENT_STATE if not present)
│       └── time.ts                            # UPDATE (add startOfDayMs(ms, tz) if not present from Story 1.8)
├── src/
│   ├── app/
│   │   └── (staff)/contracts/[contractId]/page.tsx   # UPDATE (wire popover + display-status helper into installments table)
│   ├── components/
│   │   ├── FollowUpActionPopover.tsx          # NEW
│   │   ├── FollowUpActionPopover.test.tsx     # NEW
│   │   ├── StatusPill.tsx                     # UPDATE (ensure overdueWithAction variant)
│   │   ├── StatusPill.test.tsx                # UPDATE (add the new variant case + axe scan)
│   │   └── ui/
│   │       ├── popover.tsx                    # NEW (shadcn add — if not already present from a prior story)
│   │       └── calendar.tsx                   # NEW (shadcn add — if not already present)
│   └── lib/
│       └── installmentStatus.ts               # NEW (getInstallmentDisplayStatus helper + test)
├── tests/
│   ├── unit/
│   │   ├── convex/followUpActions.test.ts     # NEW
│   │   └── lib/installmentStatus.test.ts      # NEW
│   └── e2e/
│       └── journey-2-followup.spec.ts         # NEW (or extend journey-2-payment.spec.ts)
└── docs/runbook.md                             # UPDATE (Follow-up actions subsection)
```

### Testing requirements

- **NFR-M2 ≥ 90% line coverage** on `convex/followUpActions.ts` — this is part of the collections trail, conservatively in scope.
- **axe-core in CI** must pass on the new Popover. Story 1.4's a11y gate kicked in at the StatusPill — Popover keyboard nav (Esc closes, focus trap inside popover, focus returns to trigger on close) is provided by Radix; verify it.
- **The < 30s e2e timing assertion** is a deliberate sanity check — UX § Key Moments line 135 explicitly names "< 30 seconds" as the target. If the test consistently fails on CI hardware, raise the bar to < 60s and file a UX follow-up rather than removing the assertion silently.

### Source references

- **PRD:** [FR35](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- **Architecture:** [§ Project Structure > convex/lib](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries); [§ Enforcement Guidelines > emitAudit, requireRole](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines); [§ Frontend Architecture > shadcn/ui](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- **UX:** [§ Key Moments > Maria's first missed-payment recovery (< 30s)](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Status pill color matrix > Overdue with action](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Reactive change indicator](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [§ Story 4.2](../../_bmad-output/planning-artifacts/epics.md#story-42-office-staff-attaches-logged-follow-up-actions-to-overdue-installments)
- **Convex docs:** [Indexes](https://docs.convex.dev/database/indexes/) · [Mutation patterns](https://docs.convex.dev/functions/mutation-functions)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT store `displayStatus` on the `installments` table.** It is UI-derived from the installment's `status` plus the join against `followUpActions`. Storing it would diverge from `followUpActions.status` whenever the sweep / payment posts change one without the other.
- ❌ **Do NOT call `postFinancialEvent` from this mutation.** Follow-up actions are not financial events. The ESLint rule from Story 3.2 must continue to pass.
- ❌ **Do NOT skip `requireRole`.** Story 1.2's lint rule will catch it; do not `// eslint-disable`. Field workers must NOT be in the allowed roles — collections is staff/admin only.
- ❌ **Do NOT allow follow-up actions on paid installments.** The mutation guard rejects them; the UI should not render the trigger button in that state either. Defense in depth.
- ❌ **Do NOT trim the note in the UI without re-validating on the server.** The Zod schema in the form trims client-side; the mutation re-trims and re-validates server-side per architecture § Validation timing.
- ❌ **Do NOT skip the `recomputeAgingForContract` call.** Without it, the AR aging snapshot for this contract still shows the installment as "silently overdue" until the next daily cron. Maria will think the system is broken.
- ❌ **Do NOT make the audit `reason` field optional here.** The note is itself the reason; pass `reason: trimmed` to `emitAudit`. This is the explicit-reason policy from architecture § emitAudit pattern (line 520–521).
- ❌ **Do NOT use a `Dialog` (modal) instead of a `Popover`.** UX § Form Patterns mandates Popover for the contextual, in-row interaction. A modal forces a focus shift Maria has to recover from — kills the < 30s target.
- ❌ **Do NOT add a "delete follow-up action" mutation in this story.** Follow-up actions are part of the collections audit trail; they expire or resolve, never delete. If a future story needs an "undo last add" within 5 minutes, that's a separate scope and an explicit policy decision.

### Common LLM-developer mistakes to prevent

- **Computing `Date.now()` inside JSX:** Always compute the cutoff `startOfTodayManila` once at the top of the component (or pass it from a `useManilaNow` hook — Story 1.8 introduced or reserved this hook). Re-computing per-render causes infinite re-renders if used as a `useEffect` dep.
- **Joining followUpActions by per-installment query in a loop:** Use a single `listForContract` query and group client-side, or use `listForInstallment` only on rows that are actually overdue. Don't issue N reactive subscriptions for a 60-row installments table.
- **Wrong index for the sweep query (Story 4.3 will need this):** `by_status_targetDate` is the right index for "all active actions whose targetDate is in the past." Don't filter without the index — the sweep will full-scan the table.
- **Treating `targetDate` as a `Date` object on the wire:** Convex serializes only primitives. `targetDate` is a `number` (unix ms). Convert in the form layer; never send a `Date` instance through `useMutation`.
- **Forgetting the empty-followups case on installment status:** `getInstallmentDisplayStatus(installment, [])` must return `"overdue"`, not `"overdueWithAction"`. The unit test covers this; do not skip it.
- **Optimistic update on this mutation:** Architecture § Communication Patterns line 515 forbids optimistic on financial mutations. This one is borderline (no money moves, but it changes audit/AR aging). Default to non-optimistic — Convex's reactive subscription is fast enough that Maria won't notice the round-trip.

### Open questions / blockers this story does NOT resolve

- **None.** No §10 question affects follow-up action logic.
- **Side effect on payment posting (Story 3.9):** when a payment settles an installment, should active follow-ups on that installment auto-resolve? Pragmatic answer: yes. **If Story 3.9's `postFinancialEvent` body does not yet patch linked follow-ups to `"resolved"`, file as a follow-on task** rather than expanding scope here. Story 4.3's expiry sweep covers the natural case.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > convex domain files](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/followUpActions.ts` matches the per-domain convention.
- [UX § Composite components > Popover](../../_bmad-output/planning-artifacts/ux-design-specification.md) — `Popover` is the documented UX pattern for in-row contextual forms.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR35](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- [Architecture § emitAudit pattern](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission)
- [UX § Key Moments > Missed-payment recovery target](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [UX § Status pill color matrix](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 4.2](../../_bmad-output/planning-artifacts/epics.md#story-42-office-staff-attaches-logged-follow-up-actions-to-overdue-installments)
- [Previous story (4.1)](./4-1-system-computes-ar-aging-buckets-daily.md) — supplies `recomputeAgingForContract` and the `arAgingSnapshots` table this story updates
- [Previous story (3.6)](./3-6-contract-state-machine-transitions.md) — supplies the contract detail page extended here

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code SDK).

### Debug Log References

- `npm run lint` — clean (pre-existing unrelated warning on
  `NavigateToLotButton.tsx` only).
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 1650 passed / 1 skipped (1651 total). New suites:
  `tests/unit/convex/followUpActions.test.ts` (23 tests) and
  `tests/unit/components/FollowUpActionForm.test.tsx` (7 tests).
- `npm run build` — clean; `/follow-ups` registered.

### Completion Notes List

This story was implemented to the **task contract supplied at dev time**
(the dev-agent system message) rather than to the story file's verbatim
AC text. The two contracts diverge on table shape and lifecycle vocabulary
— the task contract takes precedence per BMAD convention. Specifics:

- **Table shape — task contract wins.** Schema fields are
  `installmentId`, `action` (literal union of channels:
  `"phone_call" | "sms" | "letter" | "in_person" | "other"`), `notes`
  (optional), `dueAt`, `status` (`"open" | "completed" | "cancelled"`),
  `createdAt`, `createdBy`, `completedAt?`, `completedBy?`. Indexes
  `by_installment` and `by_status_dueAt`. The story file's original AC1
  spec (denormalised `contractId`, `note` 3..500 chars,
  `status: "active" | "expired" | "resolved"`, `createdBy: Id<"users">`,
  four indexes) is **not** what shipped — the task contract narrowed
  scope and the dev path followed.
- **Audit `entityType: "lot"`.** Per the task contract, follow-up
  actions emit audit rows keyed on the lot (the cemetery's aggregate
  root for sub-entities) — same convention as `occupants.ts`. The
  mutation dereferences installment → contract → lot to resolve the
  lot id.
- **No `recomputeAgingForContract` call here.** Story 4.1 ships the
  recompute helper as `internal_recomputeAgingForContractMutation` and
  the snapshot row's `overdueCountWithAction` field is reserved for
  this story. Per the file-ownership boundary (`convex/lib/**` and
  other `convex/**/*.ts` are READ-ONLY), this story does NOT wire the
  follow-up count into Story 4.1's helper — that hook is a follow-on
  story (the recompute helper currently hard-codes
  `overdueCountWithAction = 0`). Documented as a follow-on TODO.
- **No `markComplete` / `markCancelled` state-machine transition.**
  The follow-up action's lifecycle (`open → completed | cancelled`) is
  independent of the installment's own state machine. An inline guard
  against double-completion / double-cancellation is cleaner than
  registering a new entry in `convex/lib/stateMachines.ts` (which is
  READ-ONLY for this story per file ownership).
- **`/follow-ups` page is a simple list with paste-the-installment-id
  form.** The richer Popover-on-row UX described in the story file's
  AC2 lives on the contract detail page (Story 3.6) — that page is
  outside this story's file-ownership boundary. The standalone
  `/follow-ups` page is the file-ownership-respecting surface for
  this story. The Popover wiring is a follow-on once the dev contract
  permits touching `src/app/(staff)/contracts/[contractId]/page.tsx`.
- **No `getInstallmentDisplayStatus` helper, no `StatusPill`
  `"overdueWithAction"` variant.** The story file's task 4 / 5 touch
  files outside this story's file ownership (`src/components/StatusPill.tsx`,
  `src/lib/installmentStatus.ts`); deferred to a follow-on story.
- **One-day clock-skew tolerance on `dueAt`.** Mirrors the
  `convex/occupants.ts:addOccupant` precedent: `dueAt` must be ≥ now -
  1 day so an operator picking "today" does not get rejected by a
  slightly-fast server clock.
- **Notes max length 500 chars (server-validated); empty notes stored
  as `undefined` after trim** so the table stays clean.

### File List

CREATED:
- `convex/followUpActions.ts` — `createFollowUp`, `listForInstallment`,
  `listOpenFollowUps`, `markComplete`, `markCancelled`.
- `src/components/FollowUpActionForm/FollowUpActionForm.tsx`
- `src/components/FollowUpActionForm/schema.ts`
- `src/components/FollowUpActionForm/index.ts`
- `src/app/(staff)/follow-ups/page.tsx`
- `tests/unit/convex/followUpActions.test.ts` — 23 tests, all green.
- `tests/unit/components/FollowUpActionForm.test.tsx` — 7 tests, all
  green.

MODIFIED:
- `convex/schema.ts` — added `followUpActions` table with the
  task-contract shape + two indexes (`by_installment`,
  `by_status_dueAt`).
- `src/components/Sidebar/nav-items.ts` — appended Follow-ups entry
  (icon: `PhoneCall`, roles: `admin` + `office_staff`).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  flipped `4-2-...` to `review`; bumped `last_updated`.
