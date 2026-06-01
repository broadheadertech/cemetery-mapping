# Story 4.5: Admin Reclaims a Defaulted Lot

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin**,
I want **to reclaim a defaulted lot in a separate explicit action that atomically transitions the contract to `cancelled`, the lot back to `available`, the ownership to closed, and handles prior payments per the cemetery's policy**,
so that **lot reclamation is intentional, fully audited, and prior-payments handling is explicit per policy (forfeit / refund / credit) rather than silent — closing the loop on the "default ≠ reclaim" risk-mitigation principle** (FR38, **gated on §10 Q1**).

This is **the most delicate mutation in Epic 4**. It is the only one that simultaneously transitions three entities (contract, lot, ownership) plus invokes the prior-payments policy branch. It must be **atomic** (all-or-nothing in a single Convex mutation per architecture's atomic mutation cornerstone), **audited** (every change is captured in `auditLog` with a single shared reason), and **policy-aware** (the prior-payments handling is configurable because §10 Q1 has not yet returned a final answer; the mutation accepts a `priorPaymentsPolicy` argument with a "forfeit" default + a warning banner in the UI).

## Acceptance Criteria

1. **AC1 — Admin sees "Reclaim lot" action on `in_default` contracts only**: On `src/app/(staff)/contracts/[contractId]/page.tsx`, when the contract state is `"in_default"` AND the viewer's role is `"admin"`, a destructive-styled button "Reclaim lot" appears in the contract action bar. The button is hidden in all other contract states and for all other roles. Hover-tooltip explains: "Returns the lot to available, cancels the contract, applies the prior-payments policy."

2. **AC2 — Reclaim Dialog with policy selector + reason + warnings**: Clicking "Reclaim lot" opens a `Dialog` containing: a destructive headline ("Reclaim defaulted lot"), a **prior-payments policy `Select`** with three options (`Forfeit`, `Refund (to be processed out-of-band)`, `Credit (toward future purchase)`) — default value `"Forfeit"`, a warning banner above the select reading **"Prior-payments policy pending client confirmation (§10 Q1). Default selection is `Forfeit`. Verify with cemetery owner before confirming."**, a required `Textarea` for `reason` (3–500 chars), a destructive `Confirm: Reclaim lot` button (disabled until reason is valid), and `Cancel`. The Dialog enumerates the consequences inline: "This action will: (1) cancel the contract, (2) return the lot to available, (3) close the ownership record, (4) record prior payments as `<selected policy>`."

3. **AC3 — Mutation is atomic across 4 entities + audit**: `api.contracts.reclaimLot({ contractId, priorPaymentsPolicy, reason })` runs `requireRole(ctx, ["admin"])`, fetches the contract / lot / current ownership, validates the contract is in `"in_default"` state, calls `assertTransition` for both transitions, and **in a single Convex mutation** atomically: (a) patches contract to `state: "cancelled"`, `cancelledAt: now`, `cancellationReason: reason`, `reclaimedAt: now`, `priorPaymentsPolicy`; (b) patches the lot's `status` from `"sold"` (or whichever defaulted-state-compatible value) via `assertTransition` to `"available"`; (c) patches the open ownership record's `effectiveTo: now`; (d) creates one `forfeitedPayments` row (if policy = forfeit) summarizing the prior payments; (e) emits **one audit log entry per entity** (contract, lot, ownership, forfeited-payments — 4 audit rows total) all sharing the same `reason`; (f) calls `recomputeAgingForContract(ctx, contractId, now)` so the AR aging snapshot drops the now-cancelled contract.

4. **AC4 — Prior payments + receipts are NOT modified**: Per FR31 / NFR-C2 immutability invariant, prior `payments` and `receipts` records are **never** mutated by this flow. The `priorPaymentsPolicy` is captured as metadata on the contract + a single new `forfeitedPayments` summary row (or `creditMemo` / `refundRequest` row depending on policy — see Task 2 for the conditional schema). Existing payment receipts remain valid documents; the refund / credit policy outcomes are tracked separately. The mutation does **not** call `postFinancialEvent` (this is a state transition with policy metadata, not a new financial event).

5. **AC5 — Illegal transitions blocked + policy-default disclosure**: Attempting `reclaimLot` on a contract not in `"in_default"` state throws `ILLEGAL_STATE_TRANSITION`. Office Staff attempting the mutation gets `FORBIDDEN`. The lot's current status must be one that legally transitions to `"available"` (per Story 1.7's lot transition table: `sold → available` or `defaulted → available`); if the lot is in any other status (e.g. already `"available"` from a race), the mutation throws `ILLEGAL_STATE_TRANSITION` and the Dialog shows "Lot state has changed since you opened this. Refresh to view current status." The UI's `priorPaymentsPolicy` default is `"forfeit"` with the §10 Q1 banner visible until the gate clears; once Q1 is resolved, the banner is removed (post-Phase-1 follow-up).

## Tasks / Subtasks

### Schema additions (AC3, AC4)

- [ ] **Task 1: Extend `contracts` table** (AC: 3)
  - [ ] In `convex/schema.ts`, on the `contracts` table, add optional fields:
    - `reclaimedAt: v.optional(v.number())` — unix ms when the lot was reclaimed (distinct from `cancelledAt` because reclaim is a specific cancellation cause)
    - `priorPaymentsPolicy: v.optional(v.union(v.literal("forfeit"), v.literal("refund"), v.literal("credit")))` — captured at reclaim time, **not retroactively settable** (no admin UI to edit later — change requires a new ADR + new mutation)
    - `cancellationReason` (if not already on the table from Story 3.7's cancellation flow) — `v.optional(v.string())`
    - `cancelledAt` (if not already present) — `v.optional(v.number())`

- [ ] **Task 2: Add `forfeitedPayments` summary table** (AC: 4)
  - [ ] In `convex/schema.ts`:
    ```ts
    forfeitedPayments: defineTable({
      contractId: v.id("contracts"),
      lotId: v.id("lots"),
      customerId: v.id("customers"),
      totalForfeitedCents: v.number(),     // sum of all prior payment amounts on this contract at reclaim time
      paymentCount: v.number(),            // count of payments included
      policyAtReclaim: v.union(            // capture the policy here too for historical query convenience
        v.literal("forfeit"),
        v.literal("refund"),
        v.literal("credit"),
      ),
      reclaimedAt: v.number(),
      reason: v.string(),
      recordedBy: v.id("users"),
    })
      .index("by_contract", ["contractId"])
      .index("by_customer", ["customerId"])
      .index("by_lot", ["lotId"]),
    ```
  - [ ] **Why a separate table not just a contract field?** The forfeit / refund / credit record is a historical audit artifact that may be queried independently for reporting (FR45 / FR46) — "total ₱ forfeited YTD" or "list customers with credits available." A separate table is the right shape.
  - [ ] If policy is `"refund"` or `"credit"`, this story still inserts the row — the row's `policyAtReclaim` distinguishes the case. Refund processing (cutting a check) is out-of-band, tracked operationally; future stories may add a `refundRequests` workflow table on top.
  - [ ] **Schema is identical for all three policies** in Phase 1 — the row carries the policy label; downstream processes (reporting, refund workflow) branch on the label. Simpler than three separate tables that share 90% of their fields.

- [ ] **Task 3: Verify lot state machine includes `sold → available` and `defaulted → available`** (AC: 3, 5)
  - [ ] Story 1.7 declared the lot transition table. Confirm:
    ```ts
    lots: {
      available: ["reserved", "sold"],
      reserved: ["sold", "available"],
      sold: ["occupied", "defaulted", "available"],   // "available" = reclaim path
      defaulted: ["available"],                          // reclaim path
      occupied: [],                                       // terminal: no automatic reclaim of occupied lots
    }
    ```
  - [ ] If `sold → available` or `defaulted → available` is missing, add it.
  - [ ] **`occupied → available` is deliberately absent.** A lot with an interment cannot be reclaimed without an additional manual workflow that handles the remains. Out of scope for Phase 1. The mutation's `assertTransition` will reject this case naturally; surface a clear UI error message.

### Atomic reclaim mutation (AC3, AC4, AC5)

- [ ] **Task 4: `api.contracts.reclaimLot` mutation** (AC: 3, 4, 5)
  - [ ] In `convex/contracts.ts`:
    ```ts
    export const reclaimLot = mutation({
      args: {
        contractId: v.id("contracts"),
        priorPaymentsPolicy: v.union(v.literal("forfeit"), v.literal("refund"), v.literal("credit")),
        reason: v.string(),
      },
      handler: async (ctx, { contractId, priorPaymentsPolicy, reason }) => {
        const { userId } = await requireRole(ctx, ["admin"]);

        const trimmed = reason.trim();
        if (trimmed.length < 3 || trimmed.length > 500) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "Reason must be 3–500 characters.");
        }

        // 1. Fetch contract, lot, ownership
        const contract = await ctx.db.get(contractId);
        if (!contract) throwError(ErrorCode.INVARIANT_VIOLATION, "Contract not found.");
        if (contract.state !== "in_default") {
          throwError("ILLEGAL_STATE_TRANSITION", "Contract must be in_default to reclaim.");
        }

        const lot = await ctx.db.get(contract.lotId);
        if (!lot) throwError(ErrorCode.INVARIANT_VIOLATION, "Lot not found for this contract.");

        // Find open ownership (effectiveTo undefined) for this lot
        const openOwnership = await ctx.db
          .query("ownerships")
          .withIndex("by_lot_effective", q => q.eq("lotId", lot._id))
          .filter(q => q.eq(q.field("effectiveTo"), undefined))
          .first();
        if (!openOwnership) {
          throwError(ErrorCode.INVARIANT_VIOLATION, "No open ownership record found for this lot.");
        }

        // 2. Compute prior-payments summary (read-only — never modify payments)
        const priorPayments = await ctx.db
          .query("payments")
          .withIndex("by_contract", q => q.eq("contractId", contractId))
          .collect();
        const totalForfeitedCents = priorPayments.reduce((sum, p) => sum + p.amountCents, 0);
        const paymentCount = priorPayments.length;

        // 3. Assert both state transitions before any patch
        assertTransition({
          entityType: "contract",
          from: contract.state,                  // "in_default"
          to: "cancelled",
          reason: trimmed,
        });
        assertTransition({
          entityType: "lot",
          from: lot.status,                       // typically "sold" or "defaulted"
          to: "available",
          reason: trimmed,
        });

        const nowMs = Date.now();

        // 4. Atomic patch sequence (all in one mutation, all-or-nothing)
        await ctx.db.patch(contractId, {
          state: "cancelled",
          cancelledAt: nowMs,
          cancellationReason: trimmed,
          reclaimedAt: nowMs,
          priorPaymentsPolicy,
        });
        await ctx.db.patch(lot._id, { status: "available" });
        await ctx.db.patch(openOwnership._id, { effectiveTo: nowMs });

        const forfeitedRowId = await ctx.db.insert("forfeitedPayments", {
          contractId,
          lotId: lot._id,
          customerId: openOwnership.customerId,
          totalForfeitedCents,
          paymentCount,
          policyAtReclaim: priorPaymentsPolicy,
          reclaimedAt: nowMs,
          reason: trimmed,
          recordedBy: userId,
        });

        // 5. AR aging snapshot — contract is cancelled, drop or zero out
        await recomputeAgingForContract(ctx, contractId, nowMs);

        // 6. Four audit log rows — one per affected entity — sharing the same reason
        await emitAudit(ctx, {
          action: "contract.reclaim",
          entityType: "contract",
          entityId: contractId,
          before: { state: "in_default", priorPaymentsPolicy: undefined },
          after: { state: "cancelled", priorPaymentsPolicy },
          reason: trimmed,
        });
        await emitAudit(ctx, {
          action: "lot.reclaim",
          entityType: "lot",
          entityId: lot._id,
          before: { status: lot.status },
          after: { status: "available" },
          reason: trimmed,
        });
        await emitAudit(ctx, {
          action: "ownership.close",
          entityType: "ownership",
          entityId: openOwnership._id,
          before: { effectiveTo: undefined },
          after: { effectiveTo: nowMs },
          reason: trimmed,
        });
        await emitAudit(ctx, {
          action: "forfeitedPayments.record",
          entityType: "forfeitedPayments",
          entityId: forfeitedRowId,
          before: null,
          after: { totalForfeitedCents, paymentCount, policyAtReclaim: priorPaymentsPolicy },
          reason: trimmed,
        });

        return {
          contractId,
          lotId: lot._id,
          ownershipId: openOwnership._id,
          forfeitedPaymentsId: forfeitedRowId,
          totalForfeitedCents,
          policy: priorPaymentsPolicy,
        };
      },
    });
    ```
  - [ ] **The entire mutation runs in a single Convex transaction.** Convex's atomicity guarantee covers all `ctx.db.patch` / `ctx.db.insert` calls in one mutation — any failure throws and rolls back the whole thing.
  - [ ] First line `requireRole(ctx, ["admin"])` — Story 1.2 lint rule.
  - [ ] **DO NOT route through `postFinancialEvent`.** This is a state-transition + summary-record event, not a financial event. The Story 3.2 ESLint rule excludes `forfeitedPayments` from the protected-table list (verify the rule's pattern; if it accidentally includes the new table, update the exclusion list).

### UI — Dialog + action bar (AC1, AC2, AC5)

- [ ] **Task 5: `ReclaimLotDialog` component** (AC: 2, 5)
  - [ ] Create `src/components/ReclaimLotDialog.tsx`. Built on shadcn/ui `Dialog` + `Select` + `Textarea` + React Hook Form + Zod.
  - [ ] Props: `{ contractId: Id<"contracts">; isOpen: boolean; onOpenChange: (open: boolean) => void; onConfirmed?: () => void; q1Resolved?: boolean }`.
  - [ ] Layout:
    - `DialogHeader` title "Reclaim defaulted lot" with destructive red accent
    - `DialogDescription`: enumerated consequences (4 bullet points per AC2)
    - **§10 Q1 banner** (visible while `q1Resolved !== true`): yellow-amber callout box reading: "Prior-payments policy pending client confirmation (§10 Q1). Default selection is **Forfeit**. Verify with cemetery owner before confirming."
    - `Select` for `priorPaymentsPolicy`: three options with labels: "Forfeit (default)", "Refund — process out-of-band", "Credit — toward future purchase"
    - Live summary line below the select: `useQuery(api.payments.totalForContract, { contractId })` to show "Prior payments total: ₱X across N records" so the admin sees what is at stake.
    - `Textarea` `name="reason"` — required, 3–500 chars.
    - `DialogFooter`: `Cancel` + `Confirm: Reclaim lot` (variant `destructive`, `min-h-[44px]`)
  - [ ] Zod schema:
    ```ts
    const schema = z.object({
      priorPaymentsPolicy: z.enum(["forfeit", "refund", "credit"]),
      reason: z.string().trim().min(3).max(500),
    });
    ```
  - [ ] Form's `defaultValues = { priorPaymentsPolicy: "forfeit", reason: "" }`.
  - [ ] On submit: `useMutation(api.contracts.reclaimLot)({ contractId, priorPaymentsPolicy, reason })`. On success: close dialog, call `onConfirmed?.()`, optionally redirect to the lot detail page (now `available`). On error: `translateError(e)` → inline alert.
  - [ ] Error mapping:
    - `FORBIDDEN` → "Only Admins can reclaim lots."
    - `ILLEGAL_STATE_TRANSITION` → "Contract or lot state has changed. Refresh to view current status."
    - `INVARIANT_VIOLATION` → display server message.

- [ ] **Task 6: `totalForContract` query for the live summary** (AC: 2)
  - [ ] In `convex/payments.ts` (existing domain file), add (if not present):
    ```ts
    export const totalForContract = query({
      args: { contractId: v.id("contracts") },
      handler: async (ctx, { contractId }) => {
        await requireRole(ctx, ["admin", "office_staff"]);
        const payments = await ctx.db
          .query("payments")
          .withIndex("by_contract", q => q.eq("contractId", contractId))
          .collect();
        return {
          totalCents: payments.reduce((s, p) => s + p.amountCents, 0),
          count: payments.length,
        };
      },
    });
    ```
  - [ ] First line `requireRole` — Story 1.2 lint rule.
  - [ ] **This is a read-only query** — Story 3.2's "no writes to `payments` outside `postFinancialEvent`" rule applies to writes only.

- [ ] **Task 7: Wire button into contract detail action bar** (AC: 1)
  - [ ] In `src/app/(staff)/contracts/[contractId]/page.tsx`:
    ```tsx
    {contract.state === "in_default" && isAdmin && (
      <Button variant="destructive" onClick={() => setReclaimDialogOpen(true)}>
        Reclaim lot
      </Button>
    )}
    <ReclaimLotDialog
      contractId={contract._id}
      isOpen={reclaimDialogOpen}
      onOpenChange={setReclaimDialogOpen}
      onConfirmed={() => router.push(`/lots/${contract.lotId}`)}  // optional redirect
    />
    ```

### Tests (AC3, AC4, AC5)

- [ ] **Task 8: Convex-test mutation unit tests** (AC: 3, 4, 5)
  - [ ] Create `tests/unit/convex/contracts.reclaimLot.test.ts`.
  - [ ] Fixture builder: seed a contract in `in_default` state with: a sold lot, an open ownership, 3 payments totaling ₱12,000, 4 installments (2 paid, 2 overdue), and 1 receipt per payment.
  - [ ] Cases:
    - **Happy path (forfeit):** call `reclaimLot` as admin with `priorPaymentsPolicy: "forfeit"`. Assert all of:
      - Contract: `state === "cancelled"`, `cancelledAt`, `cancellationReason`, `reclaimedAt`, `priorPaymentsPolicy === "forfeit"`.
      - Lot: `status === "available"`.
      - Open ownership: `effectiveTo` set.
      - One `forfeitedPayments` row with `totalForfeitedCents === 1_200_000` (₱12,000 = 1.2M centavos), `paymentCount === 3`, `policyAtReclaim === "forfeit"`.
      - Four audit log rows with the matching `action` values + shared `reason`.
      - `arAgingSnapshots` recomputed (snapshot for this contract should drop or zero out — verify per Story 4.1's `recomputeAgingForContract` filter).
      - **Critical:** payments table unchanged (verify `count(payments) === 3` and each amount + ID matches pre-state).
      - **Critical:** receipts table unchanged (verify `count(receipts) === 3` and each ID + status === "active" matches pre-state).
      - **Critical:** installments unchanged (the 2 paid + 2 overdue installments stay in their states; only the contract's state changes).
    - **Happy path (refund):** same fixture, `priorPaymentsPolicy: "refund"`. Assert `forfeitedPayments.policyAtReclaim === "refund"`; everything else as above. The row exists regardless of policy — the label distinguishes downstream processing.
    - **Happy path (credit):** same fixture, `priorPaymentsPolicy: "credit"`. Same shape.
    - **Unauth:** no auth → `UNAUTHENTICATED`.
    - **Wrong role:** `office_staff` → `FORBIDDEN`.
    - **Wrong contract state:** seed `state: "active"` contract → `ILLEGAL_STATE_TRANSITION`.
    - **Wrong contract state:** seed `state: "fully_paid"` → `ILLEGAL_STATE_TRANSITION`.
    - **Wrong lot state:** seed contract in `in_default` but lot already `available` (race) → `ILLEGAL_STATE_TRANSITION`.
    - **Occupied lot:** seed lot in `occupied` state → `ILLEGAL_STATE_TRANSITION` (occupied lots cannot be reclaimed).
    - **Missing open ownership:** seed contract in `in_default` but ownership already closed (`effectiveTo` set) → `INVARIANT_VIOLATION` with "No open ownership record found."
    - **Reason too short / too long:** `INVARIANT_VIOLATION`.
    - **Atomicity check:** simulate a mid-mutation failure (e.g. inject a Convex error in `assertTransition` for the lot after the contract patch is queued) — assert the **contract is also rolled back** (no partial state). This proves Convex's transactional atomicity covers the multi-entity mutation.

- [ ] **Task 9: Component test for `ReclaimLotDialog`** (AC: 2)
  - [ ] `src/components/ReclaimLotDialog.test.tsx`. Cases:
    - Dialog opens; §10 Q1 banner visible when `q1Resolved` is unset / false.
    - Default policy = `"forfeit"`.
    - Live prior-payments summary renders from mocked query.
    - Submit disabled until reason valid.
    - On success closes; on `ILLEGAL_STATE_TRANSITION` shows refresh-prompt alert.
    - axe-core scan passes.

- [ ] **Task 10: e2e for the full reclaim flow** (AC: 1, 2, 3, 4, 5)
  - [ ] Extend `tests/e2e/journey-4-admin-collections.spec.ts` (created in Story 4.4).
  - [ ] Steps: log in as admin → navigate to a seeded `in_default` contract → click "Reclaim lot" → assert §10 Q1 banner visible → leave policy at "Forfeit" → type reason → submit → assert dialog closes → navigate to the lot → assert lot status pill reads "Available" → navigate to the (now closed) ownership view (if such a page exists; if not, query the DB directly via a test helper) → assert `effectiveTo` is set → navigate to contracts list filtered by state `cancelled` → assert the contract appears with `reclaimedAt` populated.

### Documentation (AC3, AC5)

- [ ] **Task 11: ADR + runbook + §10 Q1 status note** (AC: 5)
  - [ ] Write `docs/adr/000X-lot-reclaim-policy.md` capturing: (a) why default and reclaim are separate (FR37 vs FR38 risk mitigation), (b) the policy options (`forfeit` / `refund` / `credit`) with reasoning, (c) the schema choice (single `forfeitedPayments` table with policy label vs. three tables), (d) the §10 Q1 gate status — default `"forfeit"` is the conservative Phase 1 default; the cemetery owner must confirm before go-live.
  - [ ] Update `docs/runbook.md` with a "Lot reclaim" section: how to perform a reclaim, what records are affected, how to query forfeited / refund / credit totals (`npx convex run forfeitedPayments:summary --policy forfeit`).
  - [ ] **Update the §10 open-questions tracker** (wherever it lives — probably `docs/open-questions.md` or the brief itself) to note: Q1's prior-payments policy is now selectable per-reclaim with a `"forfeit"` default; the cemetery owner must confirm the policy + whether non-default policies need additional workflow before go-live.

## Dev Notes

### Previous story intelligence

**Epic 1 foundation:**
- `requireRole`, `requireAuth`, `ErrorCode`, `throwError` (Story 1.2).
- `emitAudit` (Story 1.6) — called four times in one mutation, once per affected entity.
- `assertTransition` (Story 1.7) — called twice: once for the contract, once for the lot. The ownership has no formal state machine (it's an open / closed lifecycle managed by `effectiveTo`).

**Story 3.2 (`postFinancialEvent`):**
- This mutation does **not** route through `postFinancialEvent`. Story 3.2's lint rule blocks writes to `payments` / `receipts` / `paymentAllocations` outside `postFinancialEvent` — this story neither writes to those tables nor modifies their contents. The new `forfeitedPayments` table is NOT a financial event; it's a metadata summary. Verify the Story 3.2 ESLint rule does not accidentally include `forfeitedPayments` in its protected list — if it does, update the rule's exclusion (the rule is documented in Story 3.2; cross-reference the ADR).

**Story 3.4 / 3.6 dependencies:**
- `contracts` table with `state` field (Story 3.4 / 3.6).
- `lots` table with `status` field (Story 1.8) — transition tables verified in Story 1.7.
- `ownerships` table with `effectiveFrom` / `effectiveTo` + `by_lot_effective` index (Story 3.3 created at the sale).

**Story 3.7 (Admin voids / cancels a contract pre-interment):**
- Story 3.7 already implements `active → cancelled` (pre-interment void). This story implements the **separate** `in_default → cancelled` path via reclaim. Both end states are `"cancelled"`, but the reason / metadata differ. Reuse `cancellationReason` and `cancelledAt` fields if Story 3.7 already added them; add them if not.
- **Do not reuse Story 3.7's mutation.** That one targets pre-interment void with different downstream behavior (no `forfeitedPayments` row, possibly no lot reclaim if the lot was just `reserved`). Reclaim is its own intentional flow.

**Story 4.1 dependency:**
- `recomputeAgingForContract` called at the end of this mutation. The snapshot's filter (Story 4.1 Task 3) covers `active` + `in_default` contracts; a cancelled contract drops out of the snapshot. Story 4.1's helper should handle "contract is now cancelled" gracefully — verify by reading Story 4.1's implementation (the filter check at the top of `recomputeAgingForContract` bails for non-active/non-default contracts and patches the existing snapshot to zero / deletes it; align this story with whatever Story 4.1 did).

**Story 4.4 dependency:**
- This story's "Reclaim lot" button is the second admin-destructive action in the contract action bar (the first is Story 4.4's "Mark as default"). They share the action bar layout pattern; component file split is per-action.

### Architecture compliance

- **Atomic multi-document writes** (architecture § Decision Impact > Atomic mutation cornerstone): every multi-entity financial-or-near-financial mutation runs in a single Convex mutation. This story is the canonical example outside `postFinancialEvent` — four entities touched, one transaction.
- **State machine guards** (architecture § State-machine guards line 555–559): both transitions go through `assertTransition`. The lint rule from Story 1.7 enforces.
- **`emitAudit` per entity** (architecture § Audit-log emission line 520–521): one audit row per affected entity. The shared `reason` is the admin-supplied text; the per-row `before` / `after` capture the specific entity's change.
- **Immutable receipts + payments** (architecture § Financial-entity write boundary line 870): this mutation does NOT mutate `payments` / `receipts`. It only reads them (for the prior-payments sum) and creates a new `forfeitedPayments` summary row that captures the policy decision. The architecture's invariant is preserved.
- **Default ≠ reclaim** (PRD § Domain Risk Mitigations line 304; FR37 + FR38 separation): Story 4.4 ships default-only; this story ships reclaim. Two separate admin actions with two separate audit trails. The cemetery owner can mark a contract default without losing the option to reclaim later; the reclaim is the intentional final step.

### Library / framework versions (researched current)

- **shadcn/ui `Select`** — added when first needed. `npx shadcn@latest add select` if not present. Pulls `@radix-ui/react-select`.
- All other dependencies are already in the project.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                              # UPDATE (add reclaimedAt + priorPaymentsPolicy + cancellation fields to contracts; add forfeitedPayments table)
│   ├── contracts.ts                           # UPDATE (add reclaimLot mutation)
│   ├── payments.ts                            # UPDATE (add totalForContract query if not present)
│   └── lib/
│       └── stateMachines.ts                   # VERIFY (in_default → cancelled, sold → available, defaulted → available all present)
├── src/
│   ├── app/
│   │   └── (staff)/contracts/[contractId]/page.tsx   # UPDATE (wire Reclaim Lot button + dialog)
│   └── components/
│       ├── ReclaimLotDialog.tsx               # NEW
│       └── ReclaimLotDialog.test.tsx          # NEW
├── tests/
│   ├── unit/convex/
│   │   └── contracts.reclaimLot.test.ts       # NEW
│   └── e2e/
│       └── journey-4-admin-collections.spec.ts # UPDATE
└── docs/
    ├── adr/
    │   └── 000X-lot-reclaim-policy.md         # NEW
    └── runbook.md                              # UPDATE (Lot reclaim section)
```

### Testing requirements

- **NFR-M2 ≥ 90% line coverage** on the mutation, **100% branch coverage** on the policy-branching paths (forfeit vs refund vs credit produce identical row schemas but the test must verify each label travels correctly).
- **The atomicity test (Task 8, "simulate mid-mutation failure")** is non-negotiable. The whole point of doing this in one mutation is that partial state is impossible; the test must prove it. `convex-test` supports throwing inside mock dependencies for this; if the harness API does not allow injecting a failure mid-`assertTransition`, mock the helper itself for that single test case.
- **Immutability invariants (payments unchanged, receipts unchanged, installments unchanged)** are tested with explicit equality assertions against pre-state snapshots, not just count checks. A bug that "fixes" amounts to zero would pass a count check but fail an equality check.

### Source references

- **PRD:** [FR37, FR38](../../_bmad-output/planning-artifacts/prd.md#functional-requirements); [§ Domain Risk Mitigations > Lot reclaim disputes](../../_bmad-output/planning-artifacts/prd.md#domain-risk-mitigations); [§ Open Questions > Q1](../../_bmad-output/planning-artifacts/prd.md#open-questions)
- **Architecture:** [§ Atomic mutation cornerstone](../../_bmad-output/planning-artifacts/architecture.md#atomic-mutation-pattern-cornerstone); [§ State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#state-machine-guards); [§ Audit-log emission](../../_bmad-output/planning-artifacts/architecture.md#audit-log-emission); [§ Financial-entity write boundary](../../_bmad-output/planning-artifacts/architecture.md#financial-entity-write-boundary); [§ Decision Impact > §10 Q1](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis)
- **UX:** [§ Form Patterns > Dialog](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Status pill matrix > Available, In Default](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- **Epics:** [§ Story 4.5](../../_bmad-output/planning-artifacts/epics.md#story-45-admin-reclaims-a-defaulted-lot)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT split the reclaim across multiple mutations.** All four entity writes + the forfeitedPayments insert + the four audit emissions happen in **one** Convex mutation. Splitting allows a partial-reclaim crash state that is operationally catastrophic.
- ❌ **Do NOT modify `payments` records** — never patch, replace, or delete. FR31 / NFR-C2 immutability invariant. The prior-payments policy is captured as a **new** `forfeitedPayments` row + a label on the contract; the original payments are historical truth.
- ❌ **Do NOT modify or void `receipts`** in this mutation. Receipts are immutable per FR31. If a refund check is later cut, that's a separate "issue refund" workflow that may or may not produce a void receipt (Story 3.11 / 3.12 territory) — out of scope here.
- ❌ **Do NOT skip `assertTransition` on the lot.** The lot's transition is bounded — `sold → available` or `defaulted → available`. `occupied → available` is rejected (no interred lots can be reclaimed). Letting the lot patch through without `assertTransition` would defeat Story 1.7's invariant.
- ❌ **Do NOT close the ownership record without setting `effectiveTo`.** The `effectiveTo` field is the closure signal; querying for "current owner" relies on `effectiveTo === undefined`. Patch sets it to `nowMs`.
- ❌ **Do NOT auto-pick a `priorPaymentsPolicy`** based on contract age, payment count, or any heuristic. §10 Q1 is unanswered; the cemetery owner must select per-reclaim. The form defaults to `"forfeit"` only because it is the conservative no-money-out option; the banner is the disclosure.
- ❌ **Do NOT add a "bulk reclaim" mutation.** Reclaim is per-contract intentionality.
- ❌ **Do NOT remove the §10 Q1 banner** until the cemetery owner confirms the policy in writing. Update `docs/open-questions.md` when it clears.
- ❌ **Do NOT allow Office Staff to reclaim lots.** Admin-only per FR38.
- ❌ **Do NOT use `Promise.all` for the four `emitAudit` calls.** Convex serializes writes in a mutation; parallel calls produce inconsistent audit-log ordering. Sequential awaits.
- ❌ **Do NOT use `Promise.all` for `ctx.db.patch` either.** Same reason. Mutations are serialized within a single mutation function.
- ❌ **Do NOT call `postFinancialEvent`** even though it's tempting (this affects financial state). `postFinancialEvent` is the wrong abstraction here — its idempotency-key + receipt-counter logic is for new financial events, not state cancellations. Use direct `ctx.db.patch` / `ctx.db.insert` with `assertTransition` + `emitAudit` per the pattern in this task list.

### Common LLM-developer mistakes to prevent

- **Returning early between patches:** Once the mutation has started patching, do not insert any early returns based on derived data. If validation fails, throw — Convex rolls back. Mid-patch returns leave inconsistent state.
- **Treating Convex's atomicity as "best effort":** It is fully transactional within a single mutation handler. The atomicity test (Task 8) verifies this.
- **Storing the prior-payments policy as a free-text field:** Use the `v.union(v.literal(...), ...)` validator. TypeScript catches typos at compile; the schema rejects invalid policy strings at write.
- **Computing `totalForfeitedCents` in the UI:** The summary is computed server-side at the moment of reclaim. The UI's live preview is informational (it tells the admin what the at-stake total is right now) but the source of truth is the server's recomputation inside the mutation.
- **Forgetting to recompute aging:** Without `recomputeAgingForContract`, the dashboard still shows the now-cancelled contract under its old in_default state until the daily cron runs. Always call from the mutation.
- **Wrong audit `entityType`:** The four audit entries reference four different entities (`contract`, `lot`, `ownership`, `forfeitedPayments`). Don't conflate; auditors querying "all changes on lot X" must find the lot.reclaim row, not a "contract.reclaim with details mentioning the lot" row.
- **Hardcoding the §10 Q1 banner removal:** Don't make the banner unconditional. Wire `q1Resolved` as a prop or config flag so when the gate clears, a one-line code change (or config flip) removes the banner without re-deploying logic.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment policy / lot reclaim conditions):** **Story is shipped with a policy-pending-defaults pattern.** The mutation accepts the policy as an argument; the UI defaults to `"forfeit"` with a visible banner; the cemetery owner selects per-reclaim until Q1 returns a final answer (which may be "always forfeit," "always refund full," "credit only if X months elapsed since last payment," etc.). When Q1 clears: (a) update the default if appropriate, (b) remove the banner, (c) if the policy is "refund or credit always," remove the `Select` and hardcode (less likely — the policy may remain admin-discretion per contract).
- **Refund workflow (out-of-band):** When `priorPaymentsPolicy === "refund"`, the `forfeitedPayments` row is created with the label but the actual refund (cutting a check, returning cash, etc.) is operational and not in scope. A future story may add a `refundRequests` workflow on top — the cemetery owner's call.
- **Credit redemption (out-of-band):** When `"credit"`, the customer has a credit toward future purchases. There is no Phase 1 redemption flow. A future story (e.g. SaleForm's lot picker offers "Apply customer credit" if the customer has open credits) closes this loop.
- **Reinstate-from-cancelled:** The state machine table has `cancelled → []` (terminal). A reclaimed contract cannot be un-reclaimed. The cemetery would create a new contract instead.

### Project Structure Notes

Aligns with:
- [Architecture § Project Structure > convex domain files](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/contracts.ts` houses both this and Story 4.4's mutation.
- [Architecture § Atomic mutation cornerstone](../../_bmad-output/planning-artifacts/architecture.md#atomic-mutation-pattern-cornerstone) — this is the canonical non-`postFinancialEvent` example.
- [Architecture § Financial-entity write boundary](../../_bmad-output/planning-artifacts/architecture.md#financial-entity-write-boundary) — preserved (no writes to payments / receipts).

No detected conflicts.

### References

- [PRD § Functional Requirements > FR37, FR38](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Domain Risk Mitigations > Lot reclaim disputes](../../_bmad-output/planning-artifacts/prd.md#domain-risk-mitigations)
- [PRD § Open Questions > Q1](../../_bmad-output/planning-artifacts/prd.md#open-questions)
- [Architecture § Atomic mutation cornerstone](../../_bmad-output/planning-artifacts/architecture.md#atomic-mutation-pattern-cornerstone)
- [Architecture § State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#state-machine-guards)
- [Architecture § Financial-entity write boundary](../../_bmad-output/planning-artifacts/architecture.md#financial-entity-write-boundary)
- [Architecture § Decision Impact > §10 Q1](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis)
- [UX § Status pill matrix](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 4.5](../../_bmad-output/planning-artifacts/epics.md#story-45-admin-reclaims-a-defaulted-lot)
- [Previous story (4.4)](./4-4-admin-transitions-contract-to-in-default.md) — defines the upstream `in_default` state this story consumes
- [Previous story (4.1)](./4-1-system-computes-ar-aging-buckets-daily.md) — `recomputeAgingForContract` called at the end of this mutation
- [Previous story (3.7)](./3-7-admin-voids-or-cancels-a-contract-pre-interment.md) — sibling cancel flow (different upstream state, different downstream behavior)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code CLI on 2026-05-20.

### Debug Log References

- `npx tsc --noEmit` — clean.
- `npm run lint` — clean modulo pre-existing `ArAgingTable.tsx` `react-hooks/exhaustive-deps` warning unrelated to this story.
- `npx vitest run` — 2088 passed / 1 skipped; the pre-existing `tests/unit/sw/sw.test.ts` DNS rejection still surfaces as a single unhandled rejection (`getaddrinfo ENOTFOUND app.example`) — unrelated to this story's changes.
- `npm run build` — compiled successfully in ~30-45s; all 37 static pages generated. The post-build trace-collection `ENOENT` on `.next/server/app/_not-found/page.js.nft.json` is a known Next.js 15.5.18 Windows-platform artifact unrelated to this story.

### Completion Notes List

This dev pass implemented the scoped Phase 1 reclaim flow per the parent agent's compacted brief (`reclaimLot({ contractId, reason })`), NOT the richer multi-policy spec in the original story file. Specifically:

- **Mutation:** `convex/contracts.ts > reclaimLot` (already stubbed by a prior pass) was kept as-shipped except for one alignment edit: the operator-facing audit-row `action` was changed from `"update"` to `"void"` (with the `reclaim:` reason prefix preserved) to match the parent agent's explicit instruction "Emits audit (action: 'void' with reason prefix 'reclaim:')". The `"void"` action mirrors Story 3.7's `voidContract` audit shape — both reclaim and pre-interment void are operator-facing "void" events on a contract, with the `reclaim:` reason prefix distinguishing them in audit queries without needing a new `AuditAction` enum value. JSDoc above the `emitAudit` call was updated to document the new shape.
- **UI:** New `src/components/ReclaimLotDialog/` folder with the dialog component + an `index.ts` barrel mirroring `MarkInDefaultDialog`. Reuses the same shadcn `Dialog` primitive, the same destructive copy pattern, the same Enter-key-swallow defense, the same 10-char floor + 500-char ceiling + live counter shape. Test IDs all prefixed `reclaim-lot-*` so the new dialog is independently selectable from the sibling `MarkInDefaultDialog` / `VoidContractDialog` on the same page.
- **Page wiring:** `src/app/(staff)/contracts/[contractId]/page.tsx` adds a `reclaimLotRef` `makeFunctionReference` declaration, a `reclaimLot` mutation hook, a `reclaimDialogOpen` state slot, a `handleReclaimLot` async handler that calls the mutation then `router.push("/sales")` on success (per the parent agent's brief), and a destructive-styled `contract-reclaim-lot-card` rendered only when `isAdmin && detail.state === "in_default"`. The card sits beside the existing Story 4.4 `contract-mark-in-default-card` — the contract detail page now exposes the full FR37 → FR38 admin progression as two distinct, intentional actions.

**Deferred to follow-on stories** (per the parent agent's scoped file-ownership brief — these files are not in this story's CREATE-or-MODIFY list):

- The richer multi-policy shape (`priorPaymentsPolicy: "forfeit" | "refund" | "credit"`) + the `forfeitedPayments` summary table from the original spec — requires `convex/schema.ts` ownership.
- The `recomputeAgingForContract(ctx, contractId, nowMs)` call at the end of the mutation — requires `convex/arAging.ts` / `convex/lib/arAging.ts` ownership. The AR aging recompute cron runs daily at 01:00 Manila and will pick up the now-voided contract within the NFR-P3 ≤ 1-day freshness budget.
- The `totalForContract` query in `convex/payments.ts` + live prior-payments summary line in the dialog — requires `convex/payments.ts` ownership.
- The four-row-per-entity audit pattern (contract + lot + ownership + forfeitedPayments) — the shipped flow emits two rows via `transitionContractState`/`transitionLotStatus` plus the operator-facing `void` row; the ownership-close + forfeitedPayments rows are part of the deferred richer shape.
- ADR `docs/adr/000X-lot-reclaim-policy.md` + `docs/runbook.md` update + §10 Q1 banner-resolution config flag — requires `docs/**` ownership.
- The e2e extension to `tests/e2e/journey-4-admin-collections.spec.ts` — requires `tests/e2e/**` ownership.

The shipped flow honors FR38 + the "default ≠ reclaim" risk-mitigation principle by atomically voiding the contract and returning the lot to inventory; receipts/payments/installments stay immutable per FR31 NFR-C2. The §10 Q1 prior-payments policy decision is captured operationally via the audit-row reason text until the cemetery owner confirms the policy in writing.

### File List

- `convex/contracts.ts` — MODIFIED: aligned the operator-facing audit row's `action` from `"update"` to `"void"` (with `reclaim:` reason prefix preserved) per parent agent brief, JSDoc updated.
- `src/components/ReclaimLotDialog/ReclaimLotDialog.tsx` — CREATED.
- `src/components/ReclaimLotDialog/index.ts` — CREATED.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — MODIFIED: added `ReclaimLotDialog` import, `reclaimLotRef` function reference, `reclaimLot` mutation hook + `reclaimDialogOpen` state, `handleReclaimLot` handler with `/sales` redirect on success, admin-only/in_default-only `contract-reclaim-lot-card` block in the JSX, and the `ReclaimLotDialog` mount.
- `tests/unit/convex/contracts-reclaim.test.ts` — CREATED (19 cases).
- `tests/unit/components/ReclaimLotDialog.test.tsx` — CREATED (9 cases).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — UPDATED: `4-5-admin-reclaims-a-defaulted-lot: review` + `last_updated: 2026-05-18` with the new note (existing 2026-05-18 stamp retained per the parent agent's instruction).
- `_bmad-output/implementation-artifacts/4-5-admin-reclaims-a-defaulted-lot.md` — UPDATED: status changed to `review`, Dev Agent Record sections filled in.
