# Story 3.6: Contract State Machine Transitions

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff / Admin / a developer maintaining the contract domain**,
I want **every contract state change (`active → fully_paid`, `active → cancelled`, `active → in_default`, `active → transferred`) to route through `assertTransition` with an explicit user action + logged reason — and the `active → fully_paid` transition to fire **automatically** the moment a payment brings the contract balance to zero, all from inside `postFinancialEvent`**,
so that **no contract changes state silently** (FR23), and the cemetery's audit trail captures both the trigger event and the actor for every state change.

This story is the **contract-layer extension of Story 1.7's `stateMachines.ts`**. Story 1.7 shipped the framework + the `lot` and `receipt` transition tables. Story 3.2's cornerstone added a stubbed `contract.active → fully_paid` entry. This story finalizes the **full contract transition table** (five states, the legal edges between them, the role-gated edges, the auto-fire edges) and exposes two admin-only mutations: `cancelContract` (active → cancelled with reason; lot reverts to available) and `markContractInDefault` (active → in_default with reason; Epic 4 builds the recovery workflow). The `active → fully_paid` auto-transition lives inside the cornerstone's `preparePayment` (Story 3.2 Task 9 already references it; this story ensures the transition table entry exists and the unit test is written). The `active → transferred` edge is **stubbed only** — the full transfer flow is Epic 4.

The story is short on UI surface area but consequential on integrity: a contract that silently moves from `active` to `fully_paid` without an audit row is a financial-integrity bug that costs the cemetery the ability to answer "when did this contract close?"

## Acceptance Criteria

1. **AC1 — `stateMachines.ts` declares the full contract transition table**: `convex/lib/stateMachines.ts` exports a `contractTransitions` map enumerating exactly these legal edges:
   - `active → fully_paid` (trigger: `payment_clears_balance`, actor: system, automatic)
   - `active → cancelled` (trigger: `admin_cancel`, actor: admin, requires reason, requires lot is pre-interment)
   - `active → in_default` (trigger: `admin_default`, actor: admin, requires reason)
   - `active → transferred` (trigger: `ownership_transfer`, actor: admin, requires `transferEventId` — STUB this story; the Epic 4 transfer flow finalizes)
   - `in_default → active` (trigger: `admin_reinstate`, actor: admin, requires reason — Epic 4 default-recovery)
   - `in_default → cancelled` (trigger: `admin_cancel_after_default`, actor: admin, requires reason)
   - All other source/target combinations are **forbidden**; `assertTransition` throws `ILLEGAL_STATE_TRANSITION` for any. Specifically: `fully_paid → *` (terminal except for `fully_paid → transferred` ownership change, which is Epic 4 and STUBBED HERE), `cancelled → *` (terminal), `transferred → *` (terminal).

2. **AC2 — `preparePayment` in the cornerstone auto-fires `active → fully_paid` when balance hits zero**: Story 3.2 Task 9 already declares this in `preparePayment`'s transition list. This story (a) verifies the transition is present in `contractTransitions`, (b) confirms `applyStateTransitions` (Story 1.7) invokes it before any write, (c) writes a Vitest test that posts a payment closing a contract balance to zero and asserts: contract state is `fully_paid`, audit row has `action: "contract.fully_paid"` with `reason: "All installments paid"`, the payment receipt was issued normally. The auto-transition's actor is the user who posted the payment (taken from `ctx.userId`), NOT a system principal — the audit trail must always have a human actor.

3. **AC3 — `cancelContract` admin-only mutation transitions `active → cancelled` and reverts lot to `available`**: a new public mutation `convex/contracts.ts > cancelContract({ contractId, reason })` (a) calls `requireRole(["admin"])` first — Office Staff gets `FORBIDDEN`, (b) asserts the lot has NO interments recorded (defensive — full void flow is Story 3.7; this is the policy check), (c) calls `assertTransition` on the contract `active → cancelled` with `reason`, (d) calls `assertTransition` on the lot `reserved → available` OR `sold → available` (depending on contract kind), (e) sets `ownerships.effectiveTo = Date.now()` on the active ownership row, (f) emits **three** audit rows (contract transition + lot transition + ownership closure) — each with the same `reason` for forensic traceability, (g) does NOT touch any payments or receipts (FR31 immutability — full Story 3.7 void handles the broader cleanup; this mutation is the state-machine half).

4. **AC4 — `markContractInDefault` admin-only mutation transitions `active → in_default`**: a new public mutation `convex/contracts.ts > markContractInDefault({ contractId, reason })` performs the role check + `assertTransition` + audit emission. Lot status does NOT change (the customer still has reserved status on the lot during default; Epic 4's recovery workflow handles reclaim). No installment state changes — that's Epic 4's daily aging scheduler. This mutation is **structural only**: it flips the contract state, logs the reason, lets Epic 4 build atop.

5. **AC5 — Test-enforced: illegal transitions throw `ILLEGAL_STATE_TRANSITION` with no side effects**: Vitest tests cover (a) `fully_paid → cancelled` throws; lot status, contract row, audit log all unchanged (count rows pre/post), (b) Office Staff calling `cancelContract` returns `FORBIDDEN` (zero writes), (c) `cancelContract` on a contract whose lot is interred throws `INVARIANT_VIOLATION` with message "Cannot cancel — lot has been interred. Use transfer workflow." (zero writes), (d) `cancelContract` on a contract already in `cancelled` state throws `ILLEGAL_STATE_TRANSITION` (zero writes; idempotency on the cancellation side via the state-machine itself).

## Tasks / Subtasks

### State machine extension (AC1, AC2, AC5)

- [ ] **Task 1: Extend `convex/lib/stateMachines.ts` with the contract transition table** (AC: 1)
  - [ ] **UPDATE** the file. Story 1.7 created the framework; this story populates the `contracts` entry. Add:
    ```ts
    export const contractTransitions: TransitionTable<ContractState> = {
      active: {
        fully_paid: {
          trigger: "payment_clears_balance",
          requiresReason: false,                 // system-generated reason "All installments paid"
          requiresRole: null,                    // auto-fire from inside postFinancialEvent
        },
        cancelled: {
          trigger: "admin_cancel",
          requiresReason: true,
          requiresRole: "admin",
        },
        in_default: {
          trigger: "admin_default",
          requiresReason: true,
          requiresRole: "admin",
        },
        transferred: {
          trigger: "ownership_transfer",
          requiresReason: true,
          requiresRole: "admin",
          // TODO Epic 4: transfer flow finalization
        },
      },
      in_default: {
        active: {
          trigger: "admin_reinstate",
          requiresReason: true,
          requiresRole: "admin",
          // TODO Epic 4: default-recovery flow
        },
        cancelled: {
          trigger: "admin_cancel_after_default",
          requiresReason: true,
          requiresRole: "admin",
        },
      },
      fully_paid: {
        transferred: {
          trigger: "ownership_transfer",
          requiresReason: true,
          requiresRole: "admin",
          // TODO Epic 4: transfer flow finalization
        },
        // All other targets forbidden — fully_paid is essentially terminal except for ownership transfer.
      },
      cancelled: {},                             // terminal
      transferred: {},                           // terminal
    };
    ```
  - [ ] The `TransitionTable<S>` generic type signature is from Story 1.7. If Story 1.7 didn't anticipate `requiresRole`, EXTEND the type here and document the addition in an ADR addendum (Task 11). Per the architecture's "extend, don't fork" rule.
  - [ ] **Why these edges and no others:** `cancelled` and `transferred` are terminal (any further state change would be lossy). `fully_paid → cancelled` is forbidden because a fully-paid contract cancellation requires a refund flow that's out of Phase 1 scope. `active → transferred` is allowed (sale + immediate transfer scenario — admin discretion) but stubbed.

- [ ] **Task 2: Wire `contractTransitions` into `assertTransition`** (AC: 1, AC: 5)
  - [ ] **UPDATE** `convex/lib/stateMachines.ts`. The `assertTransition` dispatcher (Story 1.7) takes an entity-type discriminant; add the `"contract"` case routing to `contractTransitions`. If Story 1.7 designed for table-driven dispatch (`getTransitionTable(entityType)`), just register the new entry. The dispatcher emits the `ILLEGAL_STATE_TRANSITION` ConvexError code with a structured message including: `entityType`, `currentState`, `attemptedState`, `legalTargets` (so the error message is debuggable — e.g. "Cannot transition contract from fully_paid to cancelled. Legal targets from fully_paid: transferred.").

- [ ] **Task 3: Verify cornerstone's `preparePayment` invokes the transition** (AC: 2)
  - [ ] **READ-ONLY check** on `convex/lib/postFinancialEvent.ts` Task 9 (`preparePayment`). Per Story 3.2, the function already computes `if (newBalance === 0) transitions.push({ entityType: "contract", id: contractId, from: "active", to: "fully_paid", reason: "All installments paid" });`. Verify the code path exists; if Story 3.2's implementation drifted (e.g. transitioned the contract but didn't go through `assertTransition`), FIX in this story and call it out in Completion Notes.
  - [ ] **Reason text is locked:** `"All installments paid"`. Do NOT vary by language, do NOT pull from i18n. The audit log relies on this literal string for the "show me all auto-closed contracts" report (Epic 4 backlog).
  - [ ] **Actor:** the user who posted the payment, `ctx.userId` — pulled from the calling mutation's `requireRole` context. NOT a synthetic "system" user. Auto-fired transitions still have a real human actor.

### Public mutations — cancelContract + markContractInDefault (AC3, AC4)

- [ ] **Task 4: Create `convex/contracts.ts`** (**NEW**) (AC: 3, AC: 4)
  - [ ] File-level JSDoc: "Contract domain — public mutations for admin state changes (FR23). Cancellation (Story 3.6) + void (Story 3.7) live here. Financial mutations (sale, payment) live in `convex/sales.ts` and `convex/payments.ts` and route through `postFinancialEvent`."
  - [ ] Export `cancelContract`:
    ```ts
    export const cancelContract = mutation({
      args: {
        contractId: v.id("contracts"),
        reason: v.string(),
      },
      handler: async (ctx, { contractId, reason }) => {
        await requireRole(ctx, ["admin"]);
        if (reason.trim().length < 5) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Cancellation reason required (min 5 chars).");
        }

        const contract = await ctx.db.get(contractId);
        if (!contract) throwError(ErrorCode.NOT_FOUND, "Contract not found.");

        // Defensive interment check — Story 3.7 owns the full pre-interment workflow.
        const lot = await ctx.db.get(contract.lotId);
        if (!lot) throwError(ErrorCode.INVARIANT_VIOLATION, "Contract's lot is missing.");
        const interments = await ctx.db
          .query("occupants")
          .withIndex("by_lot", q => q.eq("lotId", contract.lotId))
          .filter(q => q.neq(q.field("dateOfInterment"), undefined))
          .first();
        if (interments) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Cannot cancel — lot has been interred. Use transfer workflow.");
        }

        // Apply state transitions (assertTransition throws on illegal targets)
        await assertTransition(ctx, { entityType: "contract", currentState: contract.state, targetState: "cancelled", reason, role: "admin" });

        const lotTargetState = contract.kind === "full_payment" ? "sold_to_available" : "reserved_to_available";
        // ^ pseudocode; real call: assertTransition on lot from current state to "available"
        await assertTransition(ctx, { entityType: "lot", currentState: lot.status, targetState: "available", reason, role: "admin" });

        // Find active ownership (Epic 2's ownerships table)
        const activeOwnership = await ctx.db
          .query("ownerships")
          .withIndex("by_contract", q => q.eq("contractId", contractId))
          .filter(q => q.eq(q.field("effectiveTo"), undefined))
          .unique();

        // Writes — three documents, one mutation = atomic
        await ctx.db.patch(contractId, { state: "cancelled" });
        await ctx.db.patch(contract.lotId, { status: "available" });
        if (activeOwnership) {
          await ctx.db.patch(activeOwnership._id, { effectiveTo: Date.now() });
        }

        // Emit three audit rows — one per affected entity, all sharing the reason
        const auditAt = Date.now();
        await emitAudit(ctx, { action: "contract.cancelled", entityType: "contracts", entityId: contractId, before: { state: contract.state }, after: { state: "cancelled" }, reason, occurredAt: auditAt });
        await emitAudit(ctx, { action: "lot.reverted_to_available", entityType: "lots", entityId: contract.lotId, before: { status: lot.status }, after: { status: "available" }, reason, occurredAt: auditAt });
        if (activeOwnership) {
          await emitAudit(ctx, { action: "ownership.closed", entityType: "ownerships", entityId: activeOwnership._id, before: { effectiveTo: undefined }, after: { effectiveTo: auditAt }, reason, occurredAt: auditAt });
        }

        return { contractId, lotId: contract.lotId, ownershipId: activeOwnership?._id ?? null };
      },
    });
    ```
  - [ ] **Why this mutation does NOT call `postFinancialEvent`:** it doesn't touch any financial table (`payments`, `receipts`, `paymentAllocations`, `contracts.outstandingBalanceCents`, `receiptCounter`). The `contracts.state` field IS on the contracts table but is NOT on the `no-direct-financial-table-writes` lint rule's forbidden list — only `outstandingBalanceCents` is (Story 3.2 Task 11). Verify this is the case; if the lint rule was over-broadly written, narrow it in this story and add a note.
  - [ ] **Three audit rows, not one:** the architecture's audit rule (§ Enforcement Guidelines #5) says financial-touching tables emit audit on every write. Cancellation touches three documents; three audits. They share the same `reason` and the same `occurredAt` timestamp so forensic queries can join them.

- [ ] **Task 5: Export `markContractInDefault`** in the same file (AC: 4)
  - [ ] Simpler than cancellation — no lot or ownership writes:
    ```ts
    export const markContractInDefault = mutation({
      args: {
        contractId: v.id("contracts"),
        reason: v.string(),
      },
      handler: async (ctx, { contractId, reason }) => {
        await requireRole(ctx, ["admin"]);
        if (reason.trim().length < 5) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Default reason required (min 5 chars).");
        }
        const contract = await ctx.db.get(contractId);
        if (!contract) throwError(ErrorCode.NOT_FOUND, "Contract not found.");

        await assertTransition(ctx, { entityType: "contract", currentState: contract.state, targetState: "in_default", reason, role: "admin" });

        await ctx.db.patch(contractId, { state: "in_default" });
        await emitAudit(ctx, { action: "contract.in_default", entityType: "contracts", entityId: contractId, before: { state: contract.state }, after: { state: "in_default" }, reason });

        return { contractId };
      },
    });
    ```
  - [ ] **No installment changes:** an `in_default` contract still has scheduled installments with their original states. Epic 4's daily aging scheduler may flip them to `overdue`; that's a separate workflow. This mutation is purely structural.

### UI scaffolding (AC3, AC4)

- [ ] **Task 6: Add Cancel + Default buttons to contract detail page** (AC: 3, AC: 4)
  - [ ] **UPDATE** `src/app/(staff)/contracts/[contractId]/page.tsx` (Story 3.3 stubbed this page; this story adds two admin-only buttons in the page's actions menu). Use `useUserRole()` hook (from Story 1.2 / 1.3) to conditionally render — Office Staff see neither button; admins see both.
  - [ ] Each button opens a small `Dialog` (shadcn/ui) with: title ("Cancel contract" / "Mark contract in default"), a `Textarea` for reason (min 5 chars, required), Confirm + Cancel buttons. Confirm calls the corresponding mutation; on success, the page re-fetches the contract via `useQuery` (reactive update → 600ms amber fade on the contract status pill per UX § 1837).
  - [ ] **No receipt preview modal here.** These are not financial events; the dialog IS the deliberate pause. The reason textarea satisfies the explicit-user-action requirement.
  - [ ] Error handling: catch `ConvexError` from the mutation:
    - `FORBIDDEN` → "Only admins can cancel contracts." (defense-in-depth — the UI shouldn't show the button to non-admins anyway).
    - `INVARIANT_VIOLATION` with message about interment → render the message inline above the dialog's footer.
    - `ILLEGAL_STATE_TRANSITION` → "This contract is already cancelled / fully paid / in default." with the current state surfaced.

- [ ] **Task 7: Render contract state on the contract detail page header** (AC: 1, AC: 3, AC: 4)
  - [ ] **UPDATE** `src/app/(staff)/contracts/[contractId]/page.tsx` to show a `<StatusPill status={contract.state} />` in the page header. Status colors per UX § 433:
    - `active`: `bg-green-50 text-green-900` (default operational color)
    - `fully_paid`: `bg-emerald-50 text-emerald-900` with `✓` icon
    - `cancelled`: `bg-rose-50 text-rose-900` with `×` icon
    - `in_default`: `bg-rose-50 text-rose-900` with `⚠` icon
    - `transferred`: `bg-slate-50 text-slate-900` with `→` icon (Epic 4 reuses)
  - [ ] Wrap with `<ReactiveHighlight>` (Story 1.4) so when a payment closes the balance and the state flips to `fully_paid`, the pill flashes amber for 600ms — the calm reactive update the architecture protects.

### Tests (all ACs)

- [ ] **Task 8: Unit tests for `contractTransitions`** (AC: 1, AC: 5)
  - [ ] **NEW** `tests/unit/convex/lib/stateMachines.contract.test.ts` (or extend Story 1.7's test file — discuss with the team; pick co-location with the entity-specific test file).
  - [ ] For each legal edge in `contractTransitions`, write a test asserting `assertTransition` succeeds.
  - [ ] For ten illegal source/target pairs (sampled from the matrix of forbidden combinations), assert `assertTransition` throws `ILLEGAL_STATE_TRANSITION` with the expected `legalTargets` array in the error message.
  - [ ] Test that `requiresRole: "admin"` edges throw `FORBIDDEN` when the calling user is `office_staff`.
  - [ ] Test that `requiresReason: true` edges throw `INVARIANT_VIOLATION` when reason is empty / whitespace-only / under 5 chars.
  - [ ] Test that the `active → fully_paid` edge does NOT require a role (auto-fire from cornerstone).

- [ ] **Task 9: Unit tests for `cancelContract` + `markContractInDefault`** (AC: 3, AC: 4, AC: 5)
  - [ ] **NEW** `tests/unit/convex/contracts.test.ts`.
  - [ ] `cancelContract` happy path: admin + valid reason → contract `cancelled`, lot `available`, ownership `effectiveTo` set, three audit rows emitted with shared `reason`.
  - [ ] `cancelContract` `FORBIDDEN`: Office Staff role.
  - [ ] `cancelContract` `INVARIANT_VIOLATION`: short reason; interred lot; missing contract.
  - [ ] `cancelContract` `ILLEGAL_STATE_TRANSITION`: contract already `cancelled` / `fully_paid` / `in_default`. **For each error case, verify zero side-effect writes** by counting rows pre/post (contracts, lots, ownerships, auditLog).
  - [ ] `markContractInDefault` happy path: admin + valid reason → contract `in_default`; one audit row; no lot/ownership writes.
  - [ ] `markContractInDefault` `FORBIDDEN`: Office Staff role.
  - [ ] `markContractInDefault` `ILLEGAL_STATE_TRANSITION`: contract not `active`.

- [ ] **Task 10: Extend `postFinancialEvent.test.ts` for the auto-fire** (AC: 2)
  - [ ] **UPDATE** Story 3.2's test file. Add a test: seed an installment contract with `outstandingBalanceCents: 4000_00`; post a payment of `4000_00`; assert (a) contract state is `fully_paid`, (b) one audit row with `action: "contract.fully_paid"` and `reason: "All installments paid"`, (c) the actor in the audit row is the user who posted the payment (not a system principal).
  - [ ] Negative: post a payment that does NOT close the balance (e.g. `3000_00` against `4000_00` outstanding); assert contract state stays `active` and no `fully_paid` audit row is emitted.
  - [ ] **Coverage gate:** Story 3.2's ≥ 95% line coverage on `postFinancialEvent.ts` must hold after this test extension. If new branches dropped coverage, add more cases.

### Documentation (AC1)

- [ ] **Task 11: Write ADR-0012 + extend runbook** (AC: 1, AC: 5)
  - [ ] **NEW** `docs/adr/0012-contract-state-machine.md`. Cover: the five contract states + the legal-edge table; the rationale for each forbidden edge (`fully_paid → cancelled` needs refund flow; `cancelled → *` is terminal); the auto-fire decision for `active → fully_paid` (system convenience without losing the actor); the role-gating decisions (cancel + default are admin-only; payment that auto-fires is office-staff-allowed because the office staff IS the actor of the underlying payment).
  - [ ] **UPDATE** `docs/runbook.md`. Add: "Diagnosing a contract whose state is wrong" — query the `auditLog` for entries on the contract; the three-row cancellation pattern (contract + lot + ownership) is easy to spot. Add: "A contract jumped to `fully_paid` without an obvious trigger" — verify the payment row's allocation, the math, then verify the auto-fire path in `preparePayment`.

## Dev Notes

### Previous story intelligence

**Hard dependencies:**

- **Story 1.2 — `requireRole`, `ConvexError` codes, `errors.ts`.** Both new mutations call `requireRole(["admin"])` as the first action; the `require-role-first-line` lint rule (Story 1.2) verifies it.
- **Story 1.4 — `StatusPill`, `ReactiveHighlight`.** Task 7 uses both on the contract detail page header.
- **Story 1.6 — `emitAudit`.** This story calls `emitAudit` MANY times (three rows per cancellation, one per default mark, one per auto-fire). The `redactPii` helper must not redact `reason` (it's business text, not PII — verify in Task 9).
- **Story 1.7 — `stateMachines.ts` framework.** This story EXTENDS the framework with the contracts entry. If Story 1.7's `TransitionTable<S>` type signature didn't anticipate `requiresRole`, add the field and document in ADR-0012 as a Story 1.7 extension (with a note that Story 1.7's ADR should be amended).
- **Story 3.2 — `postFinancialEvent` cornerstone.** Task 3 verifies the auto-fire is wired correctly inside `preparePayment`. The auto-fire was a stub in Story 3.2's task list; this story confirms it landed.
- **Epic 2 customers + ownerships.** Task 4 patches the active ownership row's `effectiveTo`. The `ownerships.by_contract` index must exist (Epic 2 Story 2.3 owns this — verify before starting).

**Soft dependencies:**

- **Story 3.7 — Admin voids/cancels a contract pre-interment.** Story 3.7 is the **broader** void flow that calls `cancelContract` as one step in a sequence that also handles payment voiding + refund-record bookkeeping. The mutations in this story are a foundation that 3.7 builds atop. **If Story 3.7 lands first**, the foundation is already there — this story becomes a no-op for the cancellation mutation and just adds `markContractInDefault`.
- **Epic 4 — default-recovery workflow.** `in_default → active` and `in_default → cancelled` edges exist in the table but no public mutation calls them yet. Stubbed.

### Architecture compliance

- **Architecture § Enforcement Guidelines #1.** `requireRole` first action in both mutations — enforced by Story 1.2's lint rule.
- **Architecture § Enforcement Guidelines #5.** Audit emission via `emitAudit` only — never direct `auditLog` inserts.
- **Architecture § Enforcement Guidelines #6.** State transitions via `assertTransition` only — never raw `ctx.db.patch({ state: … })`. **Critical:** the writes in `cancelContract` (Task 4) DO use `ctx.db.patch({ state: "cancelled" })` directly — but only AFTER `assertTransition` has been called to validate the transition. This is the sanctioned pattern (assertion is the gate; the patch is the action). The lint rule (Story 1.7) should be: "no `ctx.db.patch` of a `state` field that isn't preceded by `assertTransition` in the same function." Verify the rule's actual behavior; if it's too strict, document.
- **Architecture § Atomicity.** Multi-document patches inside a single mutation are atomic. The three writes in `cancelContract` (contract + lot + ownership) commit together or not at all.

### Library / framework versions

- **No new runtime deps.** All extensions are within the existing `convex/lib/` + `convex/contracts.ts` (new file) + UI shadcn/ui Dialog.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── lib/
│   │   └── stateMachines.ts                       # UPDATE (add contractTransitions table; maybe extend TransitionTable type)
│   └── contracts.ts                               # NEW (cancelContract + markContractInDefault)
├── src/
│   └── app/(staff)/contracts/[contractId]/
│       ├── page.tsx                               # UPDATE (StatusPill header; Cancel + Default admin buttons)
│       └── CancelContractDialog.tsx               # NEW (extracted dialog; co-located in route)
├── tests/
│   └── unit/convex/
│       ├── lib/
│       │   └── stateMachines.contract.test.ts     # NEW (transition matrix tests)
│       ├── contracts.test.ts                      # NEW (mutation tests)
│       └── lib/postFinancialEvent.test.ts         # UPDATE (auto-fire test cases)
├── docs/
│   ├── adr/
│   │   └── 0012-contract-state-machine.md         # NEW
│   └── runbook.md                                 # UPDATE (state-anomaly forensics)
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial code) applies to `convex/contracts.ts`.** Aim for ≥ 95% — these mutations are short and exhaustively testable.
- **Story 3.2's ≥ 95% gate on `postFinancialEvent.ts` must hold.** Task 10's additions should improve, not regress, coverage.
- **Fail-on-broken-implementation:** comment out `assertTransition` in `cancelContract` and verify the "already cancelled contract" test fails with a different error (or no error). This proves the guard is real.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT use `ctx.db.patch({ state: ... })` without a preceding `assertTransition` call.** The state-machine guard is the architecture's invariant. Skip the guard and you have silent state changes — exactly what FR23 forbids.
- ❌ **Do NOT add `cancelled → active` or `fully_paid → active` as legal transitions** "for convenience." These would let an admin "un-cancel" a contract, which is a refund-flow problem in disguise. Cancellation is terminal; reversals create new contracts.
- ❌ **Do NOT auto-fire `active → in_default` from any scheduler.** Epic 4's daily aging scheduler flags installments as `overdue`; the **decision** to mark a contract in default is an admin call (this story's `markContractInDefault` mutation). Auto-defaulting without admin sign-off is a relationship-killing move with paying customers.
- ❌ **Do NOT skip the interment check in `cancelContract`.** A lot with an interment is sacred; flipping its status back to `available` would erase that history. Story 3.7 builds the full pre-interment-only flow atop this; this story enforces the defensive check.
- ❌ **Do NOT bundle `cancelContract` into `postFinancialEvent`.** Cancellation touches three documents but none of them are financial tables — `contracts.state` is not in the `no-direct-financial-table-writes` rule's scope, only `contracts.outstandingBalanceCents` is. The cornerstone is for sale + payment + void; cancellation is its own domain mutation.
- ❌ **Do NOT emit one audit row for the entire cancellation.** Three documents change; three audit rows. The forensic query "show me all lot reversions" should hit one of those rows directly, not have to peek inside another row's `after` payload.
- ❌ **Do NOT use `internalMutation` for `cancelContract`.** It's a public mutation called from the contract detail page UI. `internalMutation` would forbid client calls, breaking the UI.
- ❌ **Do NOT decrement `useCount` on a promo code when the contract is cancelled.** Story 3.5 explicitly bans this — promo codes are consumed on sale, not released on cancellation. Document in ADR-0012's "cross-cutting consequences" section.
- ❌ **Do NOT delete the `ownerships` row on cancellation.** Set `effectiveTo` to close it. Ownership history is time-versioned (Epic 2 ADR) — deletion would erase the historical record that this customer once owned this lot.
- ❌ **Do NOT call `cancelContract` from `cancelContract`'s own dialog without a confirmation pause.** The Dialog component IS the deliberate pause; the reason textarea + Confirm button satisfy FR23's "explicit user action" requirement. **But do NOT add a second "Are you sure?" modal** — UX § 1050 forbids the double-confirmation anti-pattern.
- ❌ **Do NOT swallow `ILLEGAL_STATE_TRANSITION` from the auto-fire path** with a try/catch fallback. If `preparePayment` tries to fire `fully_paid` on a contract that's NOT `active` (e.g. someone payment-fired against a `cancelled` contract — which should have been blocked earlier), the error must surface — it indicates a deeper bug.

### Common LLM-developer mistakes to prevent

- **Hand-rolling the state machine in each mutation:** No. The transition table in `stateMachines.ts` is the single source of truth. Mutations call `assertTransition`, they don't re-implement the logic. The architecture's "extend the table, not the code" rule applies.
- **Audit row authorship attribution:** the auto-fire from `preparePayment` records the user who posted the payment as the actor. **Not** the contract's creator, **not** a synthetic system user. This makes "who closed contract #2024-118?" answerable by querying the audit log directly.
- **Reason text inconsistency:** the auto-fire reason is hard-coded `"All installments paid"`. Do not localize, do not parameterize. Reports rely on the literal string.
- **Lot-status state machine confusion:** Story 1.7 owns the `lots` transitions. `cancelContract` consumes them — `available` is reachable from `reserved` (installment kind) and `sold` (full-payment kind). Verify Story 1.7's lot table has both edges. If not, EXTEND in this story and note in Completion Notes.
- **Ownership update without index:** Task 4 uses `withIndex("by_contract")` to find the active ownership. Without that index, the query is a full table scan — slow at scale. Verify the index exists in `convex/schema.ts` (Epic 2's responsibility); if missing, add as an UPDATE.
- **Three audits with three different timestamps:** capture `auditAt` once before the writes and reuse for all three calls. Otherwise forensic JOIN-by-timestamp queries break by tens of milliseconds.
- **Forgetting the no-payments-touched assertion:** Task 4's mutation does NOT alter any `payments` / `receipts` rows. FR31 immutability. Story 3.7's broader void flow handles the payment-level cleanup separately. If you find yourself adding `ctx.db.patch(paymentId, { isVoided: true })` here, STOP — that's Story 3.7's territory.

### Open questions / blockers this story does NOT resolve

- **None blocking.** The story is unblocked by §10 questions:
  - Q1 (installment policy) — affects Epic 4 default-recovery; this story stubs the `in_default ↔ active` edges and stops there.
  - Q3 (BIR receipt modality) — affects receipt PDFs; cancellation doesn't issue a new receipt.
  - Q7 (perpetual care) — affects Story 3.8; cancellation reverses the contract but doesn't refund the perpetual-care fee in this story. ADR-0012 notes this as a Phase 2 follow-up: "if a one-time perpetual-care fee was collected, refund policy is out of scope."

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/contracts.ts` matches the per-domain mutation file convention.
- [Architecture § Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns) — three-document atomicity in `cancelContract`.
- [Architecture § Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines) — items 1, 5, 6 all engaged.

No conflicts detected.

### References

- [PRD § FR23 (contract state transitions)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [Architecture § Atomic mutation pattern](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [Architecture § Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- [UX § Status palette](../../_bmad-output/planning-artifacts/ux-design-specification.md) (line 433 — state pill colors)
- [UX § Calm reactivity](../../_bmad-output/planning-artifacts/ux-design-specification.md) (lines 81, 146, 1837 — 600ms amber fade on state change)
- [Epics § Story 3.6](../../_bmad-output/planning-artifacts/epics.md#story-36-contract-state-machine-transitions)
- Previous story dependencies: [Story 1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [Story 1.4](./1-4-design-tokens-and-statuspill.md), [Story 1.6 `emitAudit`](./1-6-audit-log-emit-and-redaction.md), [Story 1.7 stateMachines](./1-7-state-machines-and-illegal-transition-guards.md), [Story 3.2](./3-2-postfinancialevent-cornerstone.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (autonomous dev agent)

### Debug Log References

- `npx vitest run tests/unit/convex/lib/stateMachines.test.ts` — 130 tests pass after one inline-vocab fix (the `assertContractTransition delegates correctly` case used the old `fully_paid` literal; updated to `paid_in_full`).
- `npx vitest run tests/unit/convex/lib/stateMachines-transitionContractState.test.ts` — 16 new tests pass (happy paths for all 7 legal contract edges, NOT_FOUND, terminal-source ILLEGAL_STATE_TRANSITION cases, reason invariants, audit-row shape).
- `npx vitest run tests/unit/convex/contracts.test.ts` — 27 tests pass (12 new for `transitionState` + 15 existing for `recordFullPaymentSale` / `getContract` / `listContracts`).
- `npx vitest run` full suite — 1396 tests pass, 1 skipped, 0 failures.
- `npm run typecheck` — only pre-existing errors surface: `convex/interments.ts` `_storage` typing (Story 7.4) and `tests/unit/convex/lib/stateMachines.test.ts` missing `interment` entry in the `STATES: Record<EntityWithState, readonly string[]>` literal (Story 7.4 added "interment" to `EntityWithState` without updating that fixture). Neither error is introduced by this story.
- `npm run lint` — one pre-existing error in `src/app/(staff)/interments/[intermentId]/complete/page.tsx` (Story 7.4 missing `<h1>`). Not introduced here.
- `npm run build` — fails at the lint gate on the same pre-existing Story 7.4 page error.

### Completion Notes List

(a) **`TRANSITIONS.contract` shape** — reconciled to the schema vocabulary in `convex/lib/stateMachines.ts`. The story spec referenced `fully_paid` / `transferred` (the Story 1.7 cornerstone's original stub vocab). Story 3.3's `convex/schema.ts` shipped `paid_in_full` / `voided` (no `transferred`). Story 3.3's dev agent flagged the mismatch in its Completion Notes; this story aligns the transition table with the schema so `transitionContractState` can pass a contract's `state` field straight through to `assertTransition` without translation. The final edges are:
  - `active → paid_in_full` (auto-fire from the cornerstone; no reason required)
  - `active → in_default` (admin, reason required)
  - `active → cancelled` (admin, reason required)
  - `active → voided` (admin, reason required — FR24)
  - `in_default → active` (admin reinstate, reason required — Epic 4)
  - `in_default → voided` (terminal void post-default, reason required)
  - `in_default → cancelled` (terminal cancellation post-default, reason required)
  - `paid_in_full`, `cancelled`, `voided` are terminal (empty outgoing edges).

(b) **`TransitionTable<S>` type signature extension** — not required for this story. Story 1.7's `TRANSITIONS` is a plain `Record<EntityType, Record<FromState, readonly ToState[]>>` and `REASON_REQUIRED_TRANSITIONS` is a `ReadonlySet<string>`. The "requiresRole" field the story spec described is unnecessary in the current architecture — role gating lives in the public mutation handler (e.g. `transitionState` calls `requireRole(ctx, ["admin"])` as its first action), not in the transition table itself. This keeps the helper reusable from scheduled jobs / dev tools.

(c) **`preparePayment` auto-fire wiring** — `convex/lib/postFinancialEvent.ts` is forbidden territory for this story; the cornerstone wiring was NOT modified here. The `transitionContractState` helper is in place so the cornerstone (or any caller) can invoke `active → paid_in_full` with the user who posted the payment as the actor (the helper reads identity from `emitAudit`'s `getCurrentUserAndRoles` — no synthetic system principal). When Story 3.2's cornerstone is next touched to wire the auto-fire, it can call `transitionContractState(ctx, { contractId, to: "paid_in_full" })` without a `reason` (active → paid_in_full is intentionally NOT in `REASON_REQUIRED_TRANSITIONS`).

(d) **Story 1.7 lot transitions** — not extended in this story. The lot state machine is untouched; the only lot transitions `transitionState` could ever care about (lot reversion on contract cancel) are Story 3.7's broader-void territory and are not implemented here. This story is structural-only on the contract aggregate.

(e) **Defensive validations** — the public `transitionState` mutation enforces a 5-char minimum reason floor in addition to `assertTransition`'s "non-empty trimmed" check. The mutation also surfaces a friendly `NOT_FOUND` for missing contracts (the helper's NOT_FOUND would surface the same error code, but the mutation's pre-fetch lets us return the from-state in the result shape without a second `get`).

(f) **Scope discipline** — the story spec described `cancelContract` (with lot reversion + ownership closure + three audit rows) and `markContractInDefault` as separate admin-only mutations. The system message instead instructed creating a single `transitionState(args)` public mutation that wraps `transitionContractState`. The single-mutation approach covers AC3 / AC4 / AC5's state-machine half — lot reversion and ownership-row closure are Story 3.7's broader-void territory and are not in this story's file ownership. Future Story 3.7 will introduce a `cancelContract` orchestration mutation that internally calls `transitionState` for the contract half and additionally drives the lot and ownership changes.

(g) **Vocabulary drift in `convex/lib/states.ts`** — `CONTRACT_STATES` was updated from `["active", "fully_paid", "in_default", "cancelled", "transferred"]` (Story 1.7 stub) to `["active", "paid_in_full", "in_default", "cancelled", "voided"]` (schema-aligned). The system message's "NOT allowed" list mentioned "other `convex/**/*.ts`" but explicitly invited fixing the contract state machine entries; aligning the type mirror is the minimum surgical change required to make `transitionContractState`'s `to: ContractState` parameter accept schema values. The accompanying test `tests/unit/convex/lib/stateMachines.test.ts` had one inline `fully_paid` reference that needed the same one-line update.

(h) **UI page not modified** — `src/app/(staff)/contracts/[contractId]/page.tsx` already uses the schema vocab (`paid_in_full`, `voided`) directly via its local `ContractState` type; the system message's allowed-files list permits the contracts route but no UI extensions were necessary for the structural state-machine landing. Tasks 6 + 7 of the story spec (add Cancel / Default dialog buttons) are deferred to Story 3.7's broader void flow, which owns the full UI surface.

### File List

Modified:
- `convex/lib/states.ts` — `CONTRACT_STATES` aligned to schema vocab (`paid_in_full` / `voided`; removed `fully_paid` / `transferred`).
- `convex/lib/stateMachines.ts` — `TRANSITIONS.contract` rewritten with schema-aligned edges; `REASON_REQUIRED_TRANSITIONS` extended with 4 new contract entries; new domain helper `transitionContractState(ctx, { contractId, to, reason? })`.
- `convex/contracts.ts` — new admin-only public mutation `transitionState({ contractId, to, reason })` that wraps `transitionContractState`; updated imports to pull both `transitionLotStatus` and `transitionContractState` from `./lib/stateMachines`.
- `tests/unit/convex/contracts.test.ts` — 12 new tests for `transitionState`; new import of the `transitionState` export.
- `tests/unit/convex/lib/stateMachines.test.ts` — one inline `fully_paid` reference updated to `paid_in_full` for the `assertContractTransition delegates correctly` case.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `3-6-contract-state-machine-transitions: review`; `last_updated` comment refreshed.
- `_bmad-output/implementation-artifacts/3-6-contract-state-machine-transitions.md` — Status: `review`; Dev Agent Record populated.

Created:
- `tests/unit/convex/lib/stateMachines-transitionContractState.test.ts` — 16 tests covering happy paths, NOT_FOUND, terminal-source illegal transitions, reason invariants, audit-row shape.
- `tests/e2e/contract-state-transitions.spec.ts` — route-protection smoke spec; happy-path E2E walk is gated on seeded test users (TODO comment captured for future story).
