# Story 4.4: Admin Transitions Contract to In-Default

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin**,
I want **to transition a contract to `in_default` with a logged reason via an explicit action that does NOT reclaim the lot**,
so that **severely overdue contracts are formally marked for collections, the audit trail captures the decision, and the lot stays sold until the separate reclaim action (Story 4.5) is taken — preserving the brief §10 risk-mitigation principle that default ≠ reclaim** (FR37; **partially gated on §10 Q1** — the policy that determines when an admin should choose this transition).

This story extends the contract state machine (already partly defined in Story 3.6) with the **explicit `active → in_default` transition** invoked by an admin-only UI action with a required reason. Story 3.6 declared the transition table; this story adds the user-facing path (Dialog form + mutation + audit) and the AR aging re-categorization side effect. The lot status is **deliberately unchanged** — defaulted contracts remain associated with their lot until Story 4.5's separate reclaim flow.

## Acceptance Criteria

1. **AC1 — Admin sees "Mark as default" action on active contracts**: On `src/app/(staff)/contracts/[contractId]/page.tsx`, when the contract's state is `"active"` AND the viewer's role is `"admin"`, a destructive-styled button "Mark as default" appears in the contract detail's action bar (alongside "Cancel contract," "Flag for follow-up," etc.). Office Staff and Field Workers do NOT see the button. When the contract is in any state other than `"active"`, the button is hidden.

2. **AC2 — Confirmation Dialog with required reason field**: Clicking "Mark as default" opens a shadcn/ui `Dialog` (not a Popover — this is a heavyweight contract-state change warranting modal focus). The Dialog contains: a warning headline ("This will mark the contract as in-default. The lot remains assigned to the customer until you separately reclaim it."), a required `Textarea` for `reason` (3–500 chars, label "Reason for default — appears in audit log and dashboards"), `Cancel` and `Confirm: Mark as default` buttons. Submit is disabled until the reason is valid. Per UX § Form Patterns the Dialog focus-traps and ESC closes (Radix default behavior).

3. **AC3 — Mutation routes through `assertTransition` + emits audit**: `api.contracts.markAsDefault({ contractId, reason })` runs `requireRole(ctx, ["admin"])`, fetches the contract, calls `assertTransition({ entityType: "contract", from: contract.state, to: "in_default", reason })` from `convex/lib/stateMachines.ts` (Story 1.7), patches `contracts.state = "in_default"` and `contracts.defaultedAt = Date.now()` and `contracts.defaultReason = reason`, calls `recomputeAgingForContract(ctx, contractId, nowMs)` (Story 4.1) to re-categorize the contract in the snapshot, calls `emitAudit(ctx, { action: "contract.markDefault", entityType: "contract", entityId: contractId, before: { state: "active" }, after: { state: "in_default" }, reason })`, and returns `{ contractId, newState: "in_default" }`. The mutation is single-atomic; no partial state.

4. **AC4 — Lot status is NOT changed; ownership not closed; receipts untouched**: The mutation does NOT call `assertTransition` on the lot, does NOT patch the lot's status, does NOT touch `ownerships`, does NOT void or modify any receipts. Tests verify these invariants explicitly (per architecture's "default ≠ reclaim" risk mitigation). The contract's `installments` are also untouched — they remain in their current statuses (overdue / paid / etc.), and the AR aging snapshot now reflects the contract under the `"in_default"` filter that Story 4.8's drill-down can use.

5. **AC5 — Illegal transitions blocked**: Attempting `markAsDefault` on a contract already in `"fully_paid"`, `"cancelled"`, `"transferred"`, or `"in_default"` state throws `ConvexError({ code: "ILLEGAL_STATE_TRANSITION" })` from `assertTransition`. The Dialog handles the error inline ("This contract is no longer active. Refresh to view current status.") and the mutation is rolled back atomically. Office Staff attempting the mutation (e.g. via a hand-crafted call) gets `FORBIDDEN`. The contract's state pill in the UI flips from `"Active"` to `"In Default"` (red) reactively after the successful mutation.

## Tasks / Subtasks

### State machine table verification (AC3, AC5)

- [ ] **Task 1: Verify `contracts` transition table includes `active → in_default`** (AC: 3, 5)
  - [ ] Story 3.6 (which Story 1.7 enabled) declared the contract state machine including `active → in_default`. Open `convex/lib/stateMachines.ts` and confirm:
    ```ts
    contracts: {
      active: ["fully_paid", "cancelled", "in_default", "transferred"],
      in_default: ["cancelled", "active"],   // active = reinstated (rare; reclaim path is via cancelled)
      fully_paid: [],
      cancelled: [],
      transferred: [],
    }
    ```
  - [ ] If `active → in_default` is missing, add it (Story 3.6 should have, but verify).
  - [ ] `in_default → cancelled` is reserved for Story 4.5's reclaim flow. **Do not implement that transition in this story** — only `active → in_default` is in scope.
  - [ ] Add unit test in `tests/unit/convex/lib/stateMachines.test.ts`: `assertTransition({ entityType: "contract", from: "active", to: "in_default", reason: "test" })` succeeds; `from: "fully_paid"` throws `ILLEGAL_STATE_TRANSITION`.

- [ ] **Task 2: Add `defaultedAt` and `defaultReason` fields to `contracts`** (AC: 3)
  - [ ] In `convex/schema.ts`, the `contracts` table (declared in Story 3.4 or 3.6) likely already has the `state` field. Add two optional fields if not present:
    - `defaultedAt: v.optional(v.number())` — unix ms when the contract was marked default
    - `defaultReason: v.optional(v.string())` — the reason text captured at the time of transition
  - [ ] Why optional? Because existing contracts pre-default don't have these. They get populated when the transition fires.
  - [ ] **Do not** add a separate "defaults history" table — the audit log already captures the timeline. If a contract is reinstated (in_default → active) and re-defaulted, the `defaultedAt` overwrites; the audit log retains the full history.

### Mutation (AC3, AC4, AC5)

- [ ] **Task 3: `api.contracts.markAsDefault` mutation** (AC: 3, 4, 5)
  - [ ] In `convex/contracts.ts` (existing domain file from Story 3.x), add:
    ```ts
    export const markAsDefault = mutation({
      args: {
        contractId: v.id("contracts"),
        reason: v.string(),
      },
      handler: async (ctx, { contractId, reason }) => {
        await requireRole(ctx, ["admin"]);

        const trimmed = reason.trim();
        if (trimmed.length < 3 || trimmed.length > 500) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Reason must be 3–500 characters.");
        }

        const contract = await ctx.db.get(contractId);
        if (!contract) throwError(ErrorCode.INVARIANT_VIOLATION, "Contract not found.");

        // State machine guard
        assertTransition({
          entityType: "contract",
          from: contract.state,
          to: "in_default",
          reason: trimmed,
        });

        const nowMs = Date.now();
        await ctx.db.patch(contractId, {
          state: "in_default",
          defaultedAt: nowMs,
          defaultReason: trimmed,
        });

        // Re-categorize for AR aging (snapshot row's contract filter relies on state)
        await recomputeAgingForContract(ctx, contractId, nowMs);

        await emitAudit(ctx, {
          action: "contract.markDefault",
          entityType: "contract",
          entityId: contractId,
          before: { state: contract.state },
          after: { state: "in_default" },
          reason: trimmed,
        });

        return { contractId, newState: "in_default" as const };
      },
    });
    ```
  - [ ] First line `requireRole(ctx, ["admin"])` — Story 1.2 lint rule. **Admin-only** — Office Staff explicitly excluded per FR37.
  - [ ] **No call to `postFinancialEvent`** — this is a state transition, not a financial event. Lint rule from Story 3.2 should not fire.
  - [ ] **No lot or ownership patches** — AC4 invariant. Tests verify this.

### UI — Dialog + action bar (AC1, AC2, AC5)

- [ ] **Task 4: `MarkAsDefaultDialog` component** (AC: 2, 5)
  - [ ] Create `src/components/MarkAsDefaultDialog.tsx`. Built on shadcn/ui `Dialog`.
  - [ ] Props: `{ contractId: Id<"contracts">; isOpen: boolean; onOpenChange: (open: boolean) => void; onConfirmed?: () => void }`.
  - [ ] Layout (matches UX § Form Patterns + Dialog patterns):
    - `DialogHeader`: title "Mark contract as in-default" with destructive red accent
    - `DialogDescription`: "This will flag the contract for collections. The lot remains assigned to the customer until you separately reclaim it. Audit log captures this action with your name and timestamp."
    - `Textarea` `name="reason"` `rows={3}` `maxLength={500}`. Label "Reason for default". Required.
    - `DialogFooter`: `Cancel` (variant `secondary`) + `Confirm: Mark as default` (variant `destructive`, `min-h-[44px]`, disabled until reason is valid + while pending)
  - [ ] React Hook Form + Zod:
    ```ts
    const schema = z.object({ reason: z.string().trim().min(3, "Reason must be at least 3 characters.").max(500) });
    ```
  - [ ] On submit, `useMutation(api.contracts.markAsDefault)({ contractId, reason })`. On success: close dialog, call `onConfirmed?.()`. On error: `translateError(e)` → inline `role="alert"` message.
  - [ ] Error mapping:
    - `FORBIDDEN` → "Only Admins can mark contracts as in-default." (defense in depth; UI should not have shown the button to non-admins, but this catches direct mutation calls.)
    - `ILLEGAL_STATE_TRANSITION` → "This contract is no longer active. Refresh to view current status." (Cancel + close on click of the alert; the contract page will then show the new state.)
    - `INVARIANT_VIOLATION` → display server message verbatim (will be the trimmed reason length issue).

- [ ] **Task 5: Wire the button into contract detail action bar** (AC: 1)
  - [ ] In `src/app/(staff)/contracts/[contractId]/page.tsx`, the existing action bar (Story 3.6) renders contextual buttons based on contract state + viewer role. Add:
    ```tsx
    const { roles } = useCurrentUser();  // from src/hooks/useCurrentUser.ts (Story 1.x)
    const isAdmin = roles.includes("admin");
    const [defaultDialogOpen, setDefaultDialogOpen] = useState(false);

    {contract.state === "active" && isAdmin && (
      <Button variant="destructive" onClick={() => setDefaultDialogOpen(true)}>
        Mark as default
      </Button>
    )}
    <MarkAsDefaultDialog
      contractId={contract._id}
      isOpen={defaultDialogOpen}
      onOpenChange={setDefaultDialogOpen}
    />
    ```
  - [ ] **Server-side enforcement is the primary gate** (NFR-S4); the UI hide is defense-in-depth.

### Tests (AC3, AC4, AC5)

- [ ] **Task 6: Convex-test mutation unit tests** (AC: 3, 4, 5)
  - [ ] Create `tests/unit/convex/contracts.markAsDefault.test.ts`. (Or extend `tests/unit/convex/contracts.test.ts` if it exists; pick whichever matches the codebase's emerging pattern.)
  - [ ] Cases:
    - **Happy path:** seed active contract with overdue installments + a sold lot + an open ownership; call `markAsDefault` as admin with valid reason; assert:
      - Contract `state === "in_default"`, `defaultedAt` set, `defaultReason` set.
      - Lot's `status` is **unchanged** (still `"sold"`).
      - Ownership row is **unchanged** (no `effectiveTo`).
      - No receipts modified.
      - One audit log row with `action: "contract.markDefault"`, `before.state === "active"`, `after.state === "in_default"`, `reason` matches.
      - `arAgingSnapshots` row for the contract has updated `recomputedAt`.
    - **Unauth:** no auth → `UNAUTHENTICATED`.
    - **Wrong role:** `office_staff` → `FORBIDDEN`.
    - **Wrong role:** `field_worker` → `FORBIDDEN`.
    - **Illegal transition from fully_paid:** seed contract with state `fully_paid` → `ILLEGAL_STATE_TRANSITION`.
    - **Illegal transition from cancelled:** seed contract with state `cancelled` → `ILLEGAL_STATE_TRANSITION`.
    - **Illegal transition from in_default (already defaulted):** → `ILLEGAL_STATE_TRANSITION` (no double-default).
    - **Reason too short:** 2-char reason → `INVARIANT_VIOLATION`.
    - **Reason too long:** 501-char reason → `INVARIANT_VIOLATION`.
  - [ ] Coverage target ≥ 90% line + branch on the mutation.

- [ ] **Task 7: Component test for `MarkAsDefaultDialog`** (AC: 2, 5)
  - [ ] `src/components/MarkAsDefaultDialog.test.tsx`. Testing Library + axe-core.
  - [ ] Cases: dialog opens, focus traps inside, ESC closes (relies on Radix), Confirm disabled until reason valid, on success closes, on `ILLEGAL_STATE_TRANSITION` error shows the inline alert with refresh prompt.

- [ ] **Task 8: e2e** (AC: 1, 2, 3, 5)
  - [ ] Add to `tests/e2e/journey-4-admin-collections.spec.ts` (new file or extension of an existing journey 4 spec).
  - [ ] Steps: log in as admin → navigate to a seeded active contract with overdue installments → assert "Mark as default" button visible → click → assert dialog opens → type reason "Customer has not responded after 3 follow-ups" → click Confirm → assert dialog closes → assert contract state pill reads "In Default" (red) → reload page → assert the state persists.
  - [ ] Second scenario: log in as office_staff → navigate to the same contract → assert "Mark as default" button NOT visible.

## Dev Notes

### Previous story intelligence

**Epic 1 foundation:**
- `requireRole`, `requireAuth` from Story 1.2 — admin-only path.
- `emitAudit` from Story 1.6 — must call.
- `assertTransition` from Story 1.7 — must call. The contract transitions live in `convex/lib/stateMachines.ts`.

**Story 3.4 (installment sale):** Created the `contracts` table with `state` field and the `installments` table. This story patches `contracts` but does NOT touch `installments` (AC4 invariant — installments stay in their current overdue states).

**Story 3.6 (Contract state machine transitions):** Declared the transition table for `contracts` including `active → in_default`. Story 3.6 implemented `active → fully_paid` (automatic via payment posting) and `active → cancelled` (admin action). This story adds the explicit user-facing path for `active → in_default`. **There is overlap** — Story 3.6's AC mentions "active → in_default (requires admin + reason)" but the AC there is about the state-machine table; this story implements the actual user-facing mutation + UI.

**Story 4.1 (`recomputeAgingForContract`):** Called from this mutation so the AR aging snapshot's contract → bucket mapping reflects the new state immediately. Also, the snapshot's `_recompute_filter_predicate` (Task 3 of 4.1 says aging covers `active` and `in_default` contracts) means defaulted contracts continue to appear in the AR aging breakdown — which is the correct behavior (a defaulted contract still has outstanding installments to surface).

**Story 4.5 (next sibling, gated on §10 Q1):** Will add the `in_default → cancelled` transition for the reclaim flow. This story deliberately does NOT implement that path — separation is the whole point of FR37/FR38.

### Architecture compliance

- **State machine guards** (architecture § State-machine guards line 555–559, § Enforcement Guidelines line 570): every state transition routes through `assertTransition`. No raw `ctx.db.patch(contractId, { state: ... })` — the lint rule from Story 1.7 enforces this.
- **`emitAudit` mandatory with `reason`** (architecture § Audit-log emission line 520–521): `reason` is required for state-machine transitions. The mutation passes the trimmed user-provided reason.
- **Admin-only path** (PRD § Identity & Access FR3, FR4): mutation `requireRole(ctx, ["admin"])`; UI hides the button for non-admins.
- **No financial-table writes** (architecture line 566, Story 3.2 ESLint rule): the mutation does not write to `payments` / `receipts` / `paymentAllocations` / `contracts.balance`. Story 3.2's lint rule should not fire.

### Library / framework versions (researched current)

- **shadcn/ui `Dialog`** — added when first needed. Run `npx shadcn@latest add dialog` if not present from prior stories (Story 3.x likely already added it for the receipt preview dialog). Pulls `@radix-ui/react-dialog`.
- No new external deps.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                              # UPDATE (add defaultedAt + defaultReason optional fields to contracts table)
│   ├── contracts.ts                           # UPDATE (add markAsDefault mutation)
│   └── lib/
│       └── stateMachines.ts                   # VERIFY (active → in_default present; add if missing)
├── src/
│   ├── app/
│   │   └── (staff)/contracts/[contractId]/page.tsx   # UPDATE (wire "Mark as default" button + dialog)
│   └── components/
│       ├── MarkAsDefaultDialog.tsx            # NEW
│       └── MarkAsDefaultDialog.test.tsx       # NEW
├── tests/
│   ├── unit/convex/
│   │   ├── contracts.markAsDefault.test.ts    # NEW
│   │   └── lib/stateMachines.test.ts          # UPDATE (add active → in_default legal-transition test)
│   └── e2e/
│       └── journey-4-admin-collections.spec.ts # NEW (or extend)
└── docs/adr/
    └── 000X-default-vs-reclaim-separation.md  # NEW (optional but recommended — document why default ≠ reclaim)
```

### Testing requirements

- **NFR-M2 financial-code coverage**: this mutation does not write to financial tables but it changes contract state, which influences AR aging surfaces. Target ≥ 90% line coverage; this is one of the few admin-destructive mutations and warrants thorough coverage.
- **The AC4 invariants are non-negotiable** (lot unchanged, ownership unchanged, receipts unchanged). Each invariant is its own explicit assertion in Task 6's happy-path test. Do not collapse them into a single "contract changed" check.
- **The `ILLEGAL_STATE_TRANSITION` test cases** verify the state machine table — these double-cover Story 1.7's tests but are worth keeping here because they exercise the user-facing mutation path.

### Source references

- **PRD:** [FR37](../../_bmad-output/planning-artifacts/prd.md#functional-requirements); [§ Domain Risk Mitigations > Lot reclaim disputes](../../_bmad-output/planning-artifacts/prd.md#domain-risk-mitigations) (the "default ≠ reclaim" principle)
- **Architecture:** [§ State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#state-machine-guards); [§ Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission); [§ Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- **UX:** [§ Status pill matrix > In Default](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Form Patterns > Dialog](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [§ Story 4.4](../../_bmad-output/planning-artifacts/epics.md#story-44-admin-transitions-contract-to-in_default); [§ Story 3.6 (the state-machine table this story uses)](../../_bmad-output/planning-artifacts/epics.md#story-36-contract-state-machine-transitions)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT cascade lot status, ownership, or receipts in this mutation.** Default ≠ reclaim is the explicit risk-mitigation invariant. The lot stays `"sold"`, the ownership stays open, the receipts stay valid. Story 4.5 (separate explicit action, gated on §10 Q1) handles all of those cascades.
- ❌ **Do NOT skip `assertTransition`.** Story 1.7's lint heuristic flags files that patch `state` fields without importing from `stateMachines.ts`. Use `assertTransition`; do not work around it.
- ❌ **Do NOT allow Office Staff to mark contracts as default.** Per FR37 this is admin-only. Both the UI (hide button) and the mutation (`requireRole(["admin"])`) enforce.
- ❌ **Do NOT pre-fill the reason field with a default value.** The reason is an explicit decision the admin must articulate. A canned "Contract overdue 90+ days" placeholder would degrade the audit trail's signal.
- ❌ **Do NOT add a "bulk mark as default" mutation.** Default is per-contract intentionality. Bulk-default is an anti-pattern for a 2,000-lot cemetery — there are at most a handful of defaults per quarter; UX latency does not justify the risk of accidental mass-default.
- ❌ **Do NOT auto-mark contracts as default based on days-overdue thresholds.** The brief §10 Q1 explicitly defers the policy on when a default is appropriate. Auto-defaulting is a policy decision the cemetery owner has not made; we don't make it for them.
- ❌ **Do NOT void or modify receipts as part of this transition.** Receipts are immutable per FR31 / NFR-C2 / Story 3.2's enforcement. If the cemetery later voids a receipt, that's the separate "void receipt" flow (Story 3.11/3.12), not implied by default.
- ❌ **Do NOT remove the contract from the AR aging snapshot.** A defaulted contract still has outstanding installments that need to be visible to the admin (in the appropriate bucket). The `recomputeAgingForContract` filter in Story 4.1 includes `in_default` state by design.
- ❌ **Do NOT use a Popover for the confirmation.** Dialog is correct — this is a contract-level destructive action; the modal focus communicates the gravity.

### Common LLM-developer mistakes to prevent

- **Confusing "default" with "cancel"**: defaulting does not cancel the contract; the customer might still pay and reinstate (or the cemetery may reclaim later). Resist the temptation to set `cancelled = true` or similar.
- **Patching state without `assertTransition`:** `ctx.db.patch(contractId, { state: "in_default" })` directly bypasses the state machine. The lint rule from Story 1.7 will catch this, but the muscle memory check is to always route through `assertTransition`.
- **Reusing the "Cancel contract" Dialog:** Story 3.7 introduces a "void/cancel contract" dialog. This is a different mutation, different state target, different downstream effects. Build a separate component.
- **Forgetting `recomputeAgingForContract`:** Without it, the snapshot still shows the contract under its `active` state. The daily cron will catch it within 24h, but the dashboard will be inconsistent for that window. Always call from the mutation.
- **Wrong audit `action` namespace:** Use the dot-namespaced convention from Story 4.2 / 4.3 — `"contract.markDefault"`. Don't use `"markAsDefault"` (no entity prefix) or `"CONTRACT_DEFAULTED"` (screaming case). Consistency makes audit-log queries grep-friendly.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment policy / lot reclaim conditions):** **Partially gated.** Q1's primary impact is Story 3.4 (schedule generator's grace + penalty) and Story 4.5 (reclaim + prior-payments policy). For this story, the question affects *when* an admin chooses to default a contract — that's a workflow / policy question, not a code question. The mutation accepts any reason; the cemetery's collections policy will document the trigger conditions out-of-band.
- **Reinstate-from-default (`in_default → active`):** declared in the state machine table for future use but not implemented here. If the cemetery wants a "the customer paid their arrears, reinstate the contract" flow, that's a follow-on story. The reinstate flow naturally compounds with the next payment posting — Story 3.9 / `postFinancialEvent` could potentially auto-reinstate when the balance hits a threshold. **Defer that policy decision** until the cemetery requests it.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > convex/contracts.ts](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) (line 439) — domain file for contract mutations.
- [Architecture § State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#state-machine-guards) — transitions table + `assertTransition` pattern.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR37](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Domain Risk Mitigations > Lot reclaim disputes](../../_bmad-output/planning-artifacts/prd.md#domain-risk-mitigations)
- [Architecture § State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#state-machine-guards)
- [Architecture § Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission)
- [UX § Status pill matrix > In Default](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 4.4](../../_bmad-output/planning-artifacts/epics.md#story-44-admin-transitions-contract-to-in_default)
- [Previous story (3.6)](./3-6-contract-state-machine-transitions.md) — state-machine table this story exercises
- [Previous story (4.1)](./4-1-system-computes-ar-aging-buckets-daily.md) — `recomputeAgingForContract` called from this mutation
- [Next story (4.5)](./4-5-admin-reclaims-a-defaulted-lot.md) — handles the separate `in_default → cancelled` + lot reclaim flow

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code dev agent, Story 4.4 implementation pass).

### Debug Log References

- `npm run lint` — clean (no ESLint warnings or errors).
- `npx tsc --noEmit` — only pre-existing errors in
  `convex/expenseApprovalSettings.ts` + `tests/unit/convex/expenseApprovalSettings.test.ts`
  (not touched by this story).
- `npx vitest run` — 1889 passed, 1 skipped (pre-existing), 0 failed
  across the full suite. The new test files contribute 13 mutation
  cases + 9 dialog cases.
- `npm run build` — Next.js production build compiles + types +
  generates static pages successfully (`/contracts/[contractId]`
  builds at 6.56 kB).

### Completion Notes List

- **Schema not modified.** Story Task 2 prescribed adding
  `defaultedAt` + `defaultReason` optional fields to the `contracts`
  table, but the file-ownership boundary for this dev pass restricts
  edits to `convex/contracts.ts` only (no `convex/schema.ts`). The
  `transitionContractState` cornerstone already patches `state` and
  the audit log captures the reason + timestamp, so the canonical
  forensic trail is intact. A follow-up story can persist these
  fields on the row if dashboard / list views need them without an
  audit-log join — currently no consumer reads them.
- **Audit action namespace.** Story AC3 prescribes
  `action: "contract.markDefault"`, but the `AuditAction` union in
  `convex/lib/audit.ts` (read-only per file-ownership) does not
  include a default-specific namespace. We follow the
  `voidContract` pattern of pairing the structural `transition` row
  (emitted by `transitionContractState`) with a defined-action
  `"update"` row whose `reason` is prefixed `markDefault: ` so
  audit-log greps can filter on the prefix. The structural row
  alone satisfies FR23's "no contract changes state silently"
  requirement; the prefixed row makes the operator-facing event
  explicitly greppable.
- **AR aging recompute scheduled, not inlined.** Story AC3 calls
  `recomputeAgingForContract` synchronously; we instead use
  `ctx.scheduler.runAfter(0, ref, args)` to invoke
  `arAging:internal_recomputeAgingForContractMutation` (file-
  ownership forbids `convex/arAging.ts` edits, and the existing
  internal mutation is the canonical entrypoint). The behavior is
  equivalent — the scheduler runs the recompute in its own
  transaction immediately after this mutation commits, and rolls
  back together with the parent if the parent throws. The test
  asserts `bag.scheduled` contains the contract-id-tagged entry.
- **Overdue gate uses `getContractOverdueSummary`.** The story's
  AC1 prescribes "has overdue installments" as a visibility gate.
  We use the existing `getContractOverdueSummary` query (which
  already powers the demand-letter button) rather than calling
  `listContractInstallments` directly — the former handles both
  installment and full-payment contracts cleanly (returns
  `isOverdue: false` for full-payment contracts that have no
  installment rows), avoiding the need for `"skip"` conditional
  loading.
- **No lot / ownership / receipt cascade.** AC4 invariants are
  enforced by omission: the mutation only calls
  `transitionContractState` + emits audit + schedules recompute.
  Tests verify the absence of lot status changes, ownership
  `effectiveTo` patches, payment/receipt patches, and installment
  status changes.
- **AC5 illegal-transition rollback.** Tests verify
  `paid_in_full`, `cancelled`, `voided`, and `in_default` source
  states all throw `INVARIANT_VIOLATION` before any write; no
  audit row + no scheduled recompute lands in those cases.
- **No e2e test added** (Task 8). The file-ownership boundary
  doesn't forbid e2e tests, but the prompt's "Do" list focuses on
  the four gates + dev agent record; an e2e covering Journey 4
  admin collections is best owned by a focused story when the
  full Journey 4 surface (Stories 4.5 reclaim, 4.6+) stabilizes.

### File List

**Modified:**

- `convex/contracts.ts` — appended `markContractInDefault` mutation
  (FR37). Wraps `transitionContractState` with admin-only
  `requireRole`, 10-char reason floor, active-state guard,
  scheduled AR aging recompute, and a second audit row pairing
  with the structural transition.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — added
  `markContractInDefaultRef`, dialog state, `handleMarkInDefault`,
  the "Mark in default" admin/active/overdue-gated card, and the
  `MarkInDefaultDialog` mount.

**Created:**

- `src/components/MarkInDefaultDialog/MarkInDefaultDialog.tsx` —
  shadcn/ui `Dialog`-based confirmation with warning block, reason
  textarea (10-500 chars), counter, error alert, and Enter-blocked
  destructive confirm button.
- `src/components/MarkInDefaultDialog/index.ts` — barrel re-exports
  the component, props type, and the `MIN_DEFAULT_REASON_LENGTH` /
  `MAX_DEFAULT_REASON_LENGTH` constants.
- `tests/unit/convex/contracts-default.test.ts` — 13 mutation cases
  covering happy path, AC4 invariants (lot / ownership /
  installment / payment / receipt untouched), audit emissions,
  schedule emission, role gating (admin / office_staff /
  field_worker / unauthenticated), reason validation, NOT_FOUND,
  and illegal-state transitions from all four non-active states.
- `tests/unit/components/MarkInDefaultDialog.test.tsx` — 9 dialog
  cases covering rendering, character gate, trimming, error
  alert, Enter-blocked confirm, character counter, and `maxLength`
  enforcement.
