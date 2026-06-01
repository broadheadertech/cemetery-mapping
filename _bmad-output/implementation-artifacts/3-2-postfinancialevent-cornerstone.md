# Story 3.2: `postFinancialEvent` Cornerstone

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / architect / compliance officer**,
I want **every financial mutation in the system (sale, payment, void, refund, Phase 3 webhook posting) to route through a single `postFinancialEvent(ctx, payload)` helper that performs receipt-counter allocation, idempotency-key dedup, payment + receipt + allocation inserts, contract balance update, and audit emission as one atomic Convex mutation**,
so that **atomicity (FR32), serial uniqueness (NFR-C1), receipt immutability (NFR-C2), idempotency (NFR-R5), and audit completeness are all guaranteed by construction — not by remembering to do them right at 75 call sites**.

This is **the most important file in the entire system.** Everything in Epic 3 (sale, payment, void), Epic 4 (default workflow, refunds), and Epic 9 (GCash/Maya/card webhook intake) routes through this helper. If it is wrong, the cemetery's books are wrong; if it is missing a code path, that code path inevitably becomes a back-door for direct-table writes that violate every invariant the architecture commits to. The story's scope is **the helper, the discriminated-union payload contract, the ≥ 95% line-coverage test suite, and the ESLint rules that prevent bypass.** No UI, no domain mutations that consume the helper — those come in Stories 3.3 onward.

This story takes longer than its line count suggests. Plan for it.

## Acceptance Criteria

1. **AC1 — `postFinancialEvent(ctx, payload)` exists with a discriminated-union payload contract**: `convex/lib/postFinancialEvent.ts` exports an async function whose `payload` is a Zod-validated discriminated union over `kind`: `"sale_full"`, `"sale_installment"`, `"payment"`, `"void_receipt"`, `"refund"` (refund stub — Phase 1 throws `NOT_IMPLEMENTED`; full impl in Epic 4). Each branch carries exactly the fields it needs; no shared "kitchen-sink" payload. The function returns `{ receiptId: Id<"receipts">, serialFormatted: string, contractId: Id<"contracts">, paymentId?: Id<"payments"> }`.

2. **AC2 — Every invocation atomically performs the full transactional bundle**: in one Convex mutation, the helper: (a) idempotency-key short-circuit (returns existing receipt if `idempotencyKey` already used), (b) allocates next serial via `allocateNextSerial` (Story 3.1), (c) inserts/updates the contract per `kind`, (d) inserts payment rows + paymentAllocations (per `kind`), (e) inserts the receipt with the allocated serial, (f) emits audit via `emitAudit` from Story 1.6, (g) schedules the PDF-generation action (Story 3.11) via `ctx.scheduler.runAfter(0, ...)` — **the schedule call is the LAST step inside the mutation; the action runs after the mutation commits**.

3. **AC3 — Idempotency-key dedup is bulletproof**: a Vitest test calls `postFinancialEvent` twice with the same `idempotencyKey` and otherwise-identical payload. The second call returns the exact same `{ receiptId, serialFormatted, contractId, paymentId }` as the first; no second payment row, no second receipt, no second audit entry, no second serial allocation. A third call with the same key but **different** financial payload throws `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` (per NFR-R5 + the architecture's idempotency invariant).

4. **AC4 — ESLint rule `no-direct-financial-table-writes` prevents bypass**: any `ctx.db.insert("payments" | "receipts" | "paymentAllocations", ...)`, or `ctx.db.patch` of `contracts.outstandingBalanceCents`, or any `ctx.db.*` touching `receiptCounter` in a file other than `convex/lib/postFinancialEvent.ts` (and the helpers under `convex/lib/receiptCounter.ts`), fails the build with: `"Direct write to financial table forbidden — use postFinancialEvent. See docs/adr/0006-postFinancialEvent-pattern.md."`

5. **AC5 — ≥ 95% line coverage on `convex/lib/postFinancialEvent.ts`**: the test suite under `tests/unit/convex/lib/postFinancialEvent.test.ts` exercises every branch of the discriminated union, every error path (`ILLEGAL_STATE_TRANSITION`, `INVARIANT_VIOLATION`, `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`, `FORBIDDEN` propagation from the calling mutation's `requireRole`), and the post-commit scheduler call. CI fails if coverage on this file drops below 95% (architecture § Test-enforced > "postFinancialEvent has ≥ 95% line coverage"). Branch coverage target ≥ 90%.

## Tasks / Subtasks

### Schema accretion for financial tables (AC1, AC2)

- [ ] **Task 1: Add `contracts`, `payments`, `receipts`, `paymentAllocations`, `idempotencyKeys` tables to `convex/schema.ts`** (AC: 1, AC: 2, AC: 3)
  - [ ] **`contracts`** — minimal Phase-1 fields; later stories accrete more (3.4 adds installment fields, 3.6 adds state-machine state, 3.8 adds perpetual care):
    ```ts
    contracts: defineTable({
      lotId: v.id("lots"),
      customerId: v.id("customers"),
      kind: v.union(v.literal("full_payment"), v.literal("installment")),
      basePriceCents: v.number(),
      discountCents: v.number(),               // 0 in Phase 1 until Story 3.5
      totalCents: v.number(),                  // basePrice - discount + perpetualCare
      outstandingBalanceCents: v.number(),     // updated by postFinancialEvent only
      state: v.union(v.literal("active"), v.literal("fully_paid"), v.literal("cancelled"), v.literal("in_default"), v.literal("transferred")),
      createdAt: v.number(),
      createdBy: v.id("users"),
    })
      .index("by_lot", ["lotId"])
      .index("by_customer", ["customerId"])
      .index("by_state", ["state"]),
    ```
  - [ ] **`payments`** — every recorded money-in event:
    ```ts
    payments: defineTable({
      contractId: v.id("contracts"),
      amountCents: v.number(),
      method: v.union(v.literal("cash"), v.literal("check"), v.literal("bank"), v.literal("gcash"), v.literal("maya"), v.literal("card")),
      reference: v.optional(v.string()),
      paidAt: v.number(),                      // Manila tz, captured at submission
      idempotencyKey: v.string(),              // UUIDv4 from client
      isVoided: v.boolean(),                   // set true by void workflow (Story 3.12)
      voidedAt: v.optional(v.number()),
      voidReason: v.optional(v.string()),
      recordedBy: v.id("users"),
      recordedAt: v.number(),                  // server Date.now()
    })
      .index("by_contract", ["contractId"])
      .index("by_idempotency_key", ["idempotencyKey"]),
    ```
  - [ ] **`receipts`** — one per payment, plus one per sale (the down payment / full payment is itself a receipt):
    ```ts
    receipts: defineTable({
      paymentId: v.id("payments"),
      contractId: v.id("contracts"),
      customerId: v.id("customers"),
      serial: v.number(),                      // numeric counter value
      serialFormatted: v.string(),             // "OR-0000123" — pre-formatted, immutable
      issuedAt: v.number(),
      issuedBy: v.id("users"),
      amountCents: v.number(),                 // mirror of payments.amountCents at issue time (immutability)
      isVoided: v.boolean(),
      voidedAt: v.optional(v.number()),
      voidReason: v.optional(v.string()),
      pdfStatus: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
      pdfStorageId: v.optional(v.id("_storage")),  // Convex File Storage blob (Story 3.11)
    })
      .index("by_payment", ["paymentId"])
      .index("by_serial", ["serial"])
      .index("by_contract", ["contractId"])
      .index("by_customer", ["customerId"]),
    ```
  - [ ] **`paymentAllocations`** — splits a payment across installments (Stories 3.9, 3.10). Phase 1 full-payment sales create a single allocation row; installment payments create one row per touched installment:
    ```ts
    paymentAllocations: defineTable({
      paymentId: v.id("payments"),
      contractId: v.id("contracts"),
      installmentId: v.optional(v.id("installments")),  // optional — full-payment sales allocate to the contract directly
      amountCents: v.number(),
      allocationKind: v.union(v.literal("auto_oldest"), v.literal("manual_override"), v.literal("down_payment"), v.literal("full_payment"), v.literal("perpetual_care")),
      note: v.optional(v.string()),
    })
      .index("by_payment", ["paymentId"])
      .index("by_installment", ["installmentId"]),
    ```
  - [ ] **`idempotencyKeys`** — dedicated index-backed lookup table; faster than re-scanning `payments.by_idempotency_key` for the dedup check, and survives even if a payment was never written (e.g. mutation aborted after dedup-check writes — defensive):
    ```ts
    idempotencyKeys: defineTable({
      key: v.string(),
      receiptId: v.id("receipts"),
      contractId: v.id("contracts"),
      paymentId: v.optional(v.id("payments")),  // optional for void/refund kinds that don't produce a new payment
      payloadHash: v.string(),                 // SHA-256 of canonical-JSON-serialized payload; mismatch = different-payload-reuse error
      kind: v.string(),                        // mirrors payload.kind
      createdAt: v.number(),
    })
      .index("by_key", ["key"]),
    ```
  - [ ] **`installments`** — STUBBED here (full implementation in Story 3.4); add the table definition so the contract foreign keys typecheck:
    ```ts
    installments: defineTable({
      contractId: v.id("contracts"),
      sequence: v.number(),                    // 1, 2, 3, … starting from down-payment's next
      dueAt: v.number(),
      amountCents: v.number(),
      paidAmountCents: v.number(),
      state: v.union(v.literal("scheduled"), v.literal("partial"), v.literal("paid"), v.literal("overdue"), v.literal("written_off")),
      // additional fields land in Story 3.4
    })
      .index("by_contract", ["contractId"])
      .index("by_contract_due", ["contractId", "dueAt"]),
    ```
  - [ ] All tables get audit-log coverage: the architecture's audit rule says financial-touching tables emit audit on every write. `postFinancialEvent` is the single emission point — no per-table emitters.
  - [ ] Run `npx convex dev`; commit `_generated/`. Verify the schema typechecks against existing `lots`, `customers`, `userRoles`.

### Idempotency, payload hashing, contract math helpers (AC1, AC3)

- [ ] **Task 2: Implement `hashPayload` in `convex/lib/postFinancialEvent.ts`** (AC: 3)
  - [ ] Pure function: takes the discriminated-union payload (minus `idempotencyKey`), produces a deterministic SHA-256 hex digest. Use `crypto.subtle.digest("SHA-256", canonicalJsonBytes)` (works in Convex's V8 runtime; no Node imports).
  - [ ] **Canonical JSON serialization is essential** — `{a:1, b:2}` and `{b:2, a:1}` must produce the same hash. Implement a 20-line canonical-stringify helper that sorts object keys at every depth before joining. Do NOT use third-party canonical-JSON libraries unless they explicitly support deterministic output across V8 versions; the architecture's "no new runtime deps unless justified" rule applies.
  - [ ] **Why hash, not full-equality compare?** The `idempotencyKeys` row stores the hash, not the original payload — keeps the row small + comparison O(1). Store the hash; compare hashes on re-submission.

- [ ] **Task 3: Implement `checkIdempotency(ctx, key, currentPayloadHash, currentKind)` helper** (AC: 3)
  - [ ] Lookup via `ctx.db.query("idempotencyKeys").withIndex("by_key", q => q.eq("key", key)).unique()`.
  - [ ] If null → return `{ hit: false }` (caller proceeds with the full transaction).
  - [ ] If found and `payloadHash === currentPayloadHash` and `kind === currentKind` → return `{ hit: true, receiptId, contractId, paymentId }` (caller short-circuits, returns existing receipt).
  - [ ] If found but `payloadHash !== currentPayloadHash` or `kind !== currentKind` → throw `ConvexError(ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD, "This idempotency key was previously used with a different payload. Generate a new key.")`. **Critical:** this is not a retry-friendly error; it is a programming bug (the same UUID was reused with different financial intent). Surface loudly.
  - [ ] **Why `.unique()` not `.first()`** — the table has a unique-by-key invariant; `.unique()` is the documented Convex pattern that throws if multiple rows match (a defense-in-depth check).

- [ ] **Task 4: Implement contract-math helpers in `convex/lib/money.ts`** (extends Story 1.something — `money.ts` already exists with `add`, `sub`, `mul`, `pctOf` from earlier helper stories; this story ADDS contract-balance utilities):
  - [ ] `applyPaymentToBalance(currentBalanceCents: number, paymentCents: number): { newBalance: number; overpaymentCents: number }` — returns the new outstanding balance + any overpayment (positive when the payment exceeds the balance; e.g. customer rounds up). Throw `INVARIANT_VIOLATION` if `currentBalanceCents < 0` on entry (an invariant breach upstream).
  - [ ] `assertNonNegativeMoney(cents: number, fieldName: string): void` — sanity-check helper used everywhere; throws `INVARIANT_VIOLATION` with the field name in the message.

### Helper structure + state-machine integration (AC1, AC2)

- [ ] **Task 5: Define the payload type in `convex/lib/postFinancialEvent.ts`** (AC: 1)
  - [ ] Use Convex's `v.union` for runtime validation since this helper is called from inside Convex mutations whose `args` already pass through `v.*` validators. The internal function signature uses TypeScript discriminated-union types:
    ```ts
    export type PostFinancialEventPayload =
      | {
          kind: "sale_full";
          lotId: Id<"lots">;
          customerId: Id<"customers">;
          basePriceCents: number;
          discountCents: number;                // 0 unless Story 3.5 supplies
          method: PaymentMethod;
          reference?: string;
          paidAt: number;
          idempotencyKey: string;
        }
      | {
          kind: "sale_installment";
          lotId: Id<"lots">;
          customerId: Id<"customers">;
          basePriceCents: number;
          discountCents: number;
          downPaymentCents: number;
          installments: Array<{ sequence: number; dueAt: number; amountCents: number }>;
          method: PaymentMethod;
          reference?: string;
          paidAt: number;
          idempotencyKey: string;
        }
      | {
          kind: "payment";
          contractId: Id<"contracts">;
          amountCents: number;
          method: PaymentMethod;
          reference?: string;
          paidAt: number;
          allocations: Array<{ installmentId: Id<"installments">; amountCents: number; allocationKind: AllocationKind }>;
          idempotencyKey: string;
        }
      | { kind: "void_receipt"; receiptId: Id<"receipts">; reasonCategory: string; reasonText: string; idempotencyKey: string }
      | { kind: "refund"; /* deferred to Epic 4 — throws NOT_IMPLEMENTED in Phase 1 */ idempotencyKey: string };
    ```
  - [ ] Define `PaymentMethod` + `AllocationKind` types in `convex/types/financial.ts` (**NEW** server-side types file mirroring `src/types/`); architecture allows `convex/types/` under `convex/lib/` if preferred — pick one and document.

- [ ] **Task 6: Implement the helper's top-level dispatcher** (AC: 1, AC: 2)
  - [ ] Skeleton (this is the file's spine — do not deviate from the step order):
    ```ts
    export async function postFinancialEvent(
      ctx: MutationCtx,
      payload: PostFinancialEventPayload,
    ): Promise<PostFinancialEventResult> {
      // 1. Idempotency check (early short-circuit)
      const payloadHash = await hashPayload(payload);
      const idempotency = await checkIdempotency(ctx, payload.idempotencyKey, payloadHash, payload.kind);
      if (idempotency.hit) {
        return idempotencyHitResult(idempotency);
      }

      // 2. Dispatch by kind — each branch returns a typed bundle
      let bundle: TransactionBundle;
      switch (payload.kind) {
        case "sale_full":         bundle = await prepareSaleFull(ctx, payload); break;
        case "sale_installment":  bundle = await prepareSaleInstallment(ctx, payload); break;
        case "payment":           bundle = await preparePayment(ctx, payload); break;
        case "void_receipt":      bundle = await prepareVoidReceipt(ctx, payload); break;
        case "refund":            throwError(ErrorCode.NOT_IMPLEMENTED, "Refund flow lands in Epic 4."); break;
      }

      // 3. Apply state-machine guards (Story 1.7) BEFORE any write
      await applyStateTransitions(ctx, bundle.transitions);

      // 4. Allocate serial (only AFTER state guards pass, so a rejected
      //    sale does NOT burn a serial)
      const { serial, formatted } = await allocateNextSerial(ctx);

      // 5. Persist writes in order: contracts → installments → payments → allocations → receipts → idempotencyKeys
      const writeResult = await applyWrites(ctx, bundle, { serial, formatted });

      // 6. Emit audit (Story 1.6)
      await emitAudit(ctx, {
        action: bundle.auditAction,
        entityType: "receipts",
        entityId: writeResult.receiptId,
        before: bundle.auditBefore,
        after: bundle.auditAfter,
        reason: bundle.auditReason,
      });

      // 7. Schedule PDF generation (Story 3.11) — LAST. Runs after this
      //    mutation commits; failure does not roll back the payment.
      await ctx.scheduler.runAfter(0, internal.actions.generateReceiptPdf.run, { receiptId: writeResult.receiptId });

      return { receiptId: writeResult.receiptId, serialFormatted: formatted, contractId: writeResult.contractId, paymentId: writeResult.paymentId };
    }
    ```
  - [ ] **Critical: the order is locked.** State-machine guard before serial allocation. Serial allocation before any writes. All writes inside the mutation, all in one logical transaction. Scheduler call is the **last statement before return**. This sequencing is the architecture's atomicity guarantee.

- [ ] **Task 7: Implement `prepareSaleFull`** (AC: 2)
  - [ ] Reads: lot (assert `status === "available"`), customer (assert exists), Phase 1 has no contracts on this lot yet (defensive — duplicate-sale prevention).
  - [ ] State transitions to apply: `lot.status: available → sold` (via `assertTransition` from Story 1.7).
  - [ ] Writes: new `contracts` row (kind=`"full_payment"`, totalCents=basePrice-discount, outstandingBalance=0 immediately, state=`"fully_paid"`); new `payments` row (full amount); new `paymentAllocations` row (allocationKind=`"full_payment"`, full amount); new `receipts` row (serial filled by step 4 of Task 6); new `ownerships` row (per Epic 2 schema — `customerId`, `lotId`, `effectiveFrom = paidAt`, `effectiveTo = undefined`).
  - [ ] **Ownership creation belongs here, not in Story 3.3.** The cornerstone is the source of truth for "what happens atomically when a sale posts" — Story 3.3 is the UI/mutation that calls into this with `kind: "sale_full"`. Cleaner boundary.

- [ ] **Task 8: Implement `prepareSaleInstallment`** (AC: 2)
  - [ ] Reads + transitions: lot from `available → reserved` (lot becomes `sold` only after final payment; this matches PRD Domain Patterns).
  - [ ] Writes: contract (kind=`"installment"`, totalCents, outstandingBalance=totalCents-downPayment), installments rows from the supplied schedule array, payment for the down payment, paymentAllocations row (allocationKind=`"down_payment"`), receipt, ownership.
  - [ ] If `installments` is empty AND `downPaymentCents === totalCents`, throw `INVARIANT_VIOLATION` — that would be a full-payment sale, the caller used the wrong `kind`.
  - [ ] **Schedule validation:** sum of installment amountCents + downPaymentCents must equal totalCents. Throw `INVARIANT_VIOLATION` on mismatch. (Story 3.4's UI also validates this client-side; defense-in-depth.)

- [ ] **Task 9: Implement `preparePayment`** (AC: 2)
  - [ ] Reads: contract, all unpaid installments. Transitions: depend on whether this payment brings the contract balance to 0. If yes: `contract.state: active → fully_paid`. Per-installment transitions: any installment fully covered by this allocation transitions `scheduled|partial|overdue → paid`; any partially covered transitions to `partial`.
  - [ ] Writes: payment row, allocation rows (one per touched installment per the `allocations` array), patch contract `outstandingBalanceCents`, patch each touched installment's `paidAmountCents` + `state`, receipt row.
  - [ ] **Overpayment handling:** if `applyPaymentToBalance` reports `overpaymentCents > 0`, write an additional `paymentAllocations` row with `allocationKind: "credit"` (add the literal to the union in Task 1's schema) and tag it on the contract as available credit. Phase 1 may treat this as `INVARIANT_VIOLATION` ("UI must prevent overpayment") if "credit" semantics aren't yet defined — choose the strict-fail path for Phase 1 and add a TODO; the UX already shows a warning before submit (UX § 696 "Customer would overpay by ₱500.00").

- [ ] **Task 10: Implement `prepareVoidReceipt`** (AC: 2 — partial; full void workflow is Story 3.12)
  - [ ] Reads: receipt, payment, contract. Assert receipt is not already voided.
  - [ ] **No new serial allocation** (FR29 — voids consume the original serial). The void path is the **one** exception to "every postFinancialEvent call allocates a serial" — Task 6's step 4 must guard with `if (payload.kind !== "void_receipt") { allocate… }`.
  - [ ] Writes: patch receipt `{ isVoided: true, voidedAt, voidReason }`, patch payment `{ isVoided: true, voidedAt, voidReason }`, patch contract `outstandingBalanceCents` (reverse the payment), emit audit, schedule PDF regeneration with VOIDED watermark.
  - [ ] Story 3.12 will add the UI + the `voidedReceipts` audit-companion table; this story implements only the postFinancialEvent side of the contract.

### Lint enforcement (AC4)

- [ ] **Task 11: Write `no-direct-financial-table-writes` ESLint rule** (AC: 4)
  - [ ] Create `eslint-rules/no-direct-financial-table-writes.js`. Forbidden patterns (all in files OTHER than `convex/lib/postFinancialEvent.ts` and `convex/lib/receiptCounter.ts`):
    - `ctx.db.insert("payments", ...)` — financial-table insert
    - `ctx.db.insert("receipts", ...)` — financial-table insert
    - `ctx.db.insert("paymentAllocations", ...)` — financial-table insert
    - `ctx.db.insert("idempotencyKeys", ...)` — financial-table insert
    - `ctx.db.patch(<contractId>, { outstandingBalanceCents: ... })` — balance update (heuristic: any patch whose argument object key includes `"outstandingBalanceCents"`)
    - `ctx.db.patch(<receiptId>, { isVoided: ... })` — void flag (heuristic: patch with `"isVoided"` key on a receipts-context variable)
  - [ ] Error message: `"Direct write to financial table forbidden — use postFinancialEvent. See docs/adr/0006-postFinancialEvent-pattern.md."`
  - [ ] Register in `eslint.config.mjs` under `local-rules/no-direct-financial-table-writes` as `"error"`.
  - [ ] **Honest limitation:** static-only detection is heuristic. A determined developer using a dynamic table name (`const t = "payments"; ctx.db.insert(t, …)`) bypasses the rule. The architectural boundary + code review catches this; the rule catches the 95% straightforward case.

- [ ] **Task 12: Write `RuleTester` tests for the new rule** (AC: 4)
  - [ ] Create `tests/unit/convex/lint-rules/no-direct-financial-table-writes.test.ts`. Valid cases: the helper file itself, reads from financial tables in non-helper files (allowed). Invalid cases: each forbidden pattern above.

### Test suite for ≥ 95% coverage (AC1, AC2, AC3, AC5)

- [ ] **Task 13: Build the `postFinancialEvent` test harness** (AC: 5)
  - [ ] Create `tests/unit/convex/lib/postFinancialEvent.test.ts`. The file is long (50–80 tests). Structure with nested `describe` blocks: `idempotency`, `sale_full`, `sale_installment`, `payment`, `void_receipt`, `refund (NOT_IMPLEMENTED)`, `state-machine integration`, `audit emission`, `scheduler call`.
  - [ ] **Fixture builder:** create `tests/fixtures/financialFixtures.ts` exporting `seedContract({ kind, basePriceCents, … })`, `seedAvailableLot(...)`, `seedCustomer(...)`, `seedAuthedUser({ role })`, `buildSalePayload(...)`, `buildPaymentPayload(...)`. The tests' arrange-act-assert blocks should be readable in 10 lines.

- [ ] **Task 14: Idempotency tests** (AC: 3, AC: 5)
  - [ ] Test: same key + same payload → second call returns same receipt; no second write (verify by counting rows pre/post).
  - [ ] Test: same key + different payload → throws `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
  - [ ] Test: different key + same payload → produces two distinct receipts with two distinct serials.
  - [ ] Test: idempotency works across kinds — a `sale_full` and a `payment` with the same key throws `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.

- [ ] **Task 15: Per-kind happy-path tests** (AC: 2, AC: 5)
  - [ ] `sale_full`: lot transitions, ownership row created, receipt issued, audit emitted, scheduler called once.
  - [ ] `sale_installment`: lot → reserved, installments table populated, down-payment receipt issued.
  - [ ] `payment`: oldest-unpaid-first default allocation (basic — Story 3.9 handles full UI-level allocator logic, but the helper exercises the math). Verify installment state transitions and contract balance update.
  - [ ] `payment` with overpayment: throws `INVARIANT_VIOLATION` per Task 9 decision (or, if a `credit` allocation kind is approved, verify the credit row).
  - [ ] `payment` that closes the contract: contract transitions to `fully_paid`, audit reason="All installments paid" (matches Story 3.6 AC1 expectation).
  - [ ] `void_receipt`: serial not re-allocated, receipt + payment flagged voided, contract balance reversed.

- [ ] **Task 16: Error-path tests** (AC: 2, AC: 5)
  - [ ] Sale on a lot that's already `sold` → `ILLEGAL_STATE_TRANSITION` from `assertTransition`; verify no writes occurred (count rows pre/post).
  - [ ] Sale with `basePriceCents < 0` → `INVARIANT_VIOLATION` from `assertNonNegativeMoney`.
  - [ ] Payment on a `cancelled` contract → `ILLEGAL_STATE_TRANSITION`.
  - [ ] Void of an already-voided receipt → `INVARIANT_VIOLATION` ("already voided").
  - [ ] Refund payload → `NOT_IMPLEMENTED`.
  - [ ] **Critical pre-allocation guard test:** trigger an `ILLEGAL_STATE_TRANSITION` and assert the `receiptCounter.currentSerial` did NOT increment (the architecture requires the serial to be allocated *after* state guards pass — this is the test that proves Task 6's step ordering is correct).

- [ ] **Task 17: Scheduler-call test** (AC: 2, AC: 5)
  - [ ] Use `convex-test`'s scheduler-introspection API (verify exact method name in current `convex-test` docs) to assert `ctx.scheduler.runAfter` was called with `internal.actions.generateReceiptPdf.run` and the new receipt's id, exactly once, AFTER all writes completed.
  - [ ] Negative test: when `void_receipt` runs, verify the scheduler IS called (regenerate PDF with VOIDED watermark per Story 3.12); when `refund` runs (returns early), verify the scheduler is NOT called.

- [ ] **Task 18: Audit-emission test** (AC: 2, AC: 5)
  - [ ] For each `kind`, assert exactly one `auditLog` row is written with the correct `action`, `entityType="receipts"`, `entityId`, and `reason`. Validate that PII redaction (from Story 1.6's `redactPii`) is applied — e.g. customer name appears in audit `before/after` snapshots without the gov ID.

- [ ] **Task 19: Coverage gate verification** (AC: 5)
  - [ ] Update `vitest.config.ts` (**UPDATE**) to add per-file coverage thresholds:
    ```ts
    coverage: {
      thresholds: {
        "convex/lib/postFinancialEvent.ts": { lines: 95, branches: 90, functions: 100, statements: 95 },
        "convex/lib/receiptCounter.ts":     { lines: 100, branches: 90, functions: 100, statements: 100 },
      },
    },
    ```
  - [ ] Verify `npm run test:coverage` fails when an artificial uncovered branch is introduced (sanity check) and passes when the suite is complete.

### Documentation (AC1, AC4)

- [ ] **Task 20: Write ADR-0006 + update CLAUDE.md + receipt-flow runbook** (AC: 1, AC: 4)
  - [ ] Write `docs/adr/0006-postFinancialEvent-pattern.md`. Cover: the architectural cornerstone (atomic financial writes, FR32, NFR-C1, NFR-C2, NFR-R5); the discriminated-union payload contract; the step ordering (idempotency → state guard → serial → writes → audit → schedule); the ESLint enforcement rules (`no-direct-financial-table-writes` + `no-direct-receipt-counter-access`); the test-coverage gate (≥ 95% lines); the void-doesn't-allocate exception; the scheduler-is-last decision and its consequence (PDF generation can fail without rolling back the payment — Story 3.11 handles retry).
  - [ ] Update CLAUDE.md "Architecture intent" section: pin the helper as the single financial-write entry point; reference ADR-0006.
  - [ ] Append `docs/runbook.md`: "Diagnosing a duplicate-receipt complaint" (idempotency-key lookup), "Diagnosing a missing serial gap" (which should be impossible — but if it ever appears, this is the runbook page), "Diagnosing a contract whose balance is wrong" (the audit log + the paymentAllocations table are the forensic trail).

## Dev Notes

### Previous story intelligence

**Hard dependencies (must be complete before this story starts):**

- **Story 1.2 — `requireRole`, `ConvexError` codes, `errors.ts`.** This story does NOT call `requireRole` directly — it is called by the public mutations (Stories 3.3, 3.9, 3.12) before they invoke `postFinancialEvent`. The cornerstone trusts that its callers have already authorized. Document this contract clearly in the helper's file-level JSDoc; the `no-direct-financial-table-writes` rule does NOT enforce `requireRole`-was-called-first (that's Story 1.2's `require-role-first-line` rule on the calling mutation file).
- **Story 1.6 — `emitAudit`** from `convex/lib/audit.ts`. This story calls `emitAudit` once per `postFinancialEvent` invocation. The `before/after` snapshots use the redaction helper Story 1.6 provides.
- **Story 1.7 — state machines (`assertTransition`)** from `convex/lib/stateMachines.ts`. This story consumes:
  - `lot` transitions: `available → sold` (full sale), `available → reserved` (installment sale), `available → reserved → sold` (Story 3.4 installment → fully-paid final), `reserved → available` (Story 3.7 contract void).
  - `contract` transitions: `active → fully_paid` (final payment), `active → cancelled` (Story 3.7), `active → in_default` (Epic 4).
  - `installment` transitions: `scheduled → partial`, `scheduled → paid`, `partial → paid`, `scheduled → overdue` (Epic 4).
  - `receipt` transitions: `issued → voided` (no other contract states for receipts — they are effectively immutable except for the void flag).
  - Story 1.7 must already have defined these transitions in `stateMachines.ts`; if any are missing, this story EXTENDS that file. Mark the extensions in the file diff and reference 1.7's ADR.
- **Story 3.1 — `allocateNextSerial`** from `convex/lib/receiptCounter.ts`. Step 4 of Task 6 imports it.

**Soft dependency (handled by stub):**

- **Story 3.11 — `generateReceiptPdf` action.** Step 7 of Task 6 schedules an internal action that does not yet exist when this story lands. **Solution:** create a stub `convex/actions/generateReceiptPdf.ts` (**NEW** in this story) that exports an `internalAction` with the right name + signature whose body is `// TODO Story 3.11: PDFKit implementation; for now mark pdfStatus="ready" so receipt-list UI works.` Replace `ctx.db.patch(receiptId, { pdfStatus: "ready" })` as the body so Phase 1 tests don't dangle on `pdfStatus: "pending"` forever. Story 3.11 replaces the stub with real PDF generation.

### Architecture compliance

This story IS the implementation of two architecture documents (verbatim — re-read them before writing code):

- **Architecture § API & Communication Patterns → Atomic mutation pattern (cornerstone).** Single most important pattern. Tasks 5 – 10 implement it; Tasks 13 – 19 verify it.
- **Architecture § Architectural Boundaries → Financial-entity write boundary + Receipt counter boundary.** Tasks 11 – 12 enforce them.

Pattern-rule cross-references:

- Audit emission via `emitAudit`, never direct insert into `auditLog` (§ Enforcement Guidelines #5). Task 6 step 6.
- State transitions via `assertTransition`, never raw `ctx.db.patch({ state: … })` (§ Enforcement Guidelines #6). Task 6 step 3.
- Money math via `convex/lib/money.ts`, never raw `*` / `/` 100 (§ Format Patterns > Money). Task 4 extends it.
- `ConvexError` with discriminated codes (§ Error responses). Tasks 3, 9, 10, 16.
- Internal-only PDF action via `convex/actions/` Node-runtime split (§ Service boundary). Task 6 step 7 stub.

### Library / framework versions

- **No new runtime dependencies.** Canonical-JSON-stringify is a 20-line in-house helper; SHA-256 hashing uses the V8 runtime's `crypto.subtle` Web Crypto API (Convex V8 runtime supports this — verify against current Convex runtime docs; if not available, use a tiny in-repo SHA-256 implementation or import `@noble/hashes/sha256` which is dependency-free).
- **`convex-test`** already added in Story 1.2; this story uses its scheduler-introspection capabilities heavily (verify exact API in current version).
- **`eslint-plugin-local-rules`** already registered in Story 1.2; this story adds two more local rules.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (add 6 financial tables: contracts, payments, receipts, paymentAllocations, idempotencyKeys, installments-stub)
│   ├── lib/
│   │   ├── postFinancialEvent.ts                  # UPDATE (Story 3.1 created the scaffold; this story fills in the full cornerstone)
│   │   ├── money.ts                               # UPDATE (add applyPaymentToBalance, assertNonNegativeMoney)
│   │   ├── stateMachines.ts                       # UPDATE (extend Story 1.7's tables with contract + installment + receipt transitions if not already defined)
│   │   └── audit.ts                               # (no change — consumed)
│   ├── types/
│   │   └── financial.ts                           # NEW (PaymentMethod, AllocationKind, ContractState type aliases)
│   └── actions/
│       └── generateReceiptPdf.ts                  # NEW STUB (internalAction stub; Story 3.11 replaces body with real PDFKit code)
├── eslint-rules/
│   └── no-direct-financial-table-writes.js        # NEW (custom ESLint rule)
├── eslint.config.mjs                              # UPDATE (register the new rule)
├── tests/
│   ├── unit/convex/
│   │   ├── lib/
│   │   │   └── postFinancialEvent.test.ts         # NEW (≥ 95% line coverage; 50–80 tests)
│   │   └── lint-rules/
│   │       └── no-direct-financial-table-writes.test.ts  # NEW (RuleTester)
│   └── fixtures/
│       └── financialFixtures.ts                   # NEW (seedContract, seedLot, seedCustomer, buildSalePayload, buildPaymentPayload)
├── vitest.config.ts                               # UPDATE (per-file coverage thresholds)
├── docs/
│   ├── adr/
│   │   └── 0006-postFinancialEvent-pattern.md     # NEW
│   └── runbook.md                                 # UPDATE (forensic procedures)
└── CLAUDE.md                                      # UPDATE (cornerstone is THE entry point)
```

### Testing requirements

- **Coverage gate is hard.** ≥ 95% lines on `convex/lib/postFinancialEvent.ts` is the architecture's published target (§ Test-enforced). The vitest config update (Task 19) enforces this; PR merges blocked below the threshold.
- **The "fail-on-broken-implementation" check applies here too.** Pick one assertion (e.g. "second idempotency call returns same receipt") and verify the test fails when the implementation is deliberately broken (e.g. comment out the idempotency short-circuit). This proves the test is exercising the right code path — not just running.
- **No Playwright in this story.** End-to-end coverage for the sale + payment journeys comes with Stories 3.3 and 3.9. This story is the helper + its unit tests.
- **Run the 100-concurrent test from Story 3.1 AGAIN in this story** — but routing through `postFinancialEvent` with fake payment payloads instead of calling `allocateNextSerial` directly. This proves the cornerstone preserves the concurrency guarantee end-to-end, not just at the counter primitive.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT call `postFinancialEvent` from inside an `action`** (Node runtime). Actions cannot participate in a Convex mutation's transaction. The architecture's § Service boundary explicitly forbids this. The pattern is: client → mutation (calls `postFinancialEvent`) → mutation schedules action; never the other way around.
- ❌ **Do NOT allocate the serial before the state-machine guard runs.** A rejected sale that already burned a serial = an audit-traceable gap = an NFR-C1 violation. Step ordering in Task 6 is locked.
- ❌ **Do NOT call `ctx.scheduler.runAfter` before the writes complete.** The scheduler fires after the mutation commits; if the writes fail mid-way and roll back, the scheduler would still execute against a non-existent receipt. Step 7 is **last**.
- ❌ **Do NOT swallow `ILLEGAL_STATE_TRANSITION`** with a try/catch + fallback. Surface the error to the caller; the UI maps it to a user-readable sentence (e.g. "This lot was just sold to someone else").
- ❌ **Do NOT use `Math.random()` for `idempotencyKey` generation server-side.** Idempotency keys come from the **client** (UUIDv4 generated once per form mount — UX uses the `useIdempotencyKey` hook documented in architecture's § Frontend Architecture). Server-generated keys defeat the purpose: a retry produces a new key, defeating dedup.
- ❌ **Do NOT split `postFinancialEvent` into separate exported functions** for "sale" vs. "payment" vs. "void." The single-helper model is the architectural commitment; splitting breaks the lint enforcement, the test boundary, and the discriminated-union safety. Keep it one function with the `kind` dispatch.
- ❌ **Do NOT add a new code path** that writes to `payments` / `receipts` / `paymentAllocations` "just for this one case." If the kinds enumeration doesn't cover the new case, extend the union (with an ADR addendum), not the bypass.
- ❌ **Do NOT use `Promise.all` to parallelize the writes inside the helper.** All writes are sequential inside the Convex mutation — Convex serializes per-document writes within a mutation anyway; parallel calls produce no speedup and make the code harder to reason about under failure.
- ❌ **Do NOT shape the `auditLog` row inline.** Use `emitAudit(ctx, { … })` from Story 1.6 — that helper handles the PII redaction + the append-only invariant + the schema validation.
- ❌ **Do NOT make `postFinancialEvent` an exported Convex `mutation`.** It is a TypeScript function called from inside other mutations. Exposing it as a `mutation` would (a) skip the per-mutation `requireRole` call, (b) let clients craft arbitrary `payload`s, (c) defeat the entire architectural boundary.
- ❌ **Do NOT decrement the receipt counter on void.** Story 3.1 AC4 forbids it; this story's `prepareVoidReceipt` (Task 10) re-confirms the rule.
- ❌ **Do NOT use `ctx.db.replace` on payments / receipts / contracts.** Immutability per FR31 is enforced by **only using `patch` for the voided/balance fields**; never `replace` (would clobber history).
- ❌ **Do NOT inline state-transition table entries.** The transitions live in `convex/lib/stateMachines.ts` (Story 1.7); calling `assertTransition` is the only sanctioned path. Adding `if (currentState === "x" && newState === "y") { … }` inline defeats the testability guarantee.

### Common LLM-developer mistakes to prevent

- **Reaching for a generic "EventBus" or "saga" abstraction:** No. The helper IS the architectural pattern. Adding pub/sub or saga middleware on top of Convex's atomic mutations is overkill and breaks atomicity.
- **Confusing "idempotency" with "retries":** Idempotency keys deduplicate client-initiated retries (browser refresh after submit, double-click submit). They do NOT make the helper retry on its own failures — that's Convex's OCC layer, transparent to this code.
- **Hashing payloads inconsistently:** A `Date` object and a `number` ms-since-epoch serialize differently. The payload type uses `number` everywhere (Task 5 enforces); the hash function must not stringify objects with `JSON.stringify` directly (key order is non-deterministic across V8 versions — use the canonical-stringify helper).
- **Forgetting the `void_receipt` allocation-skip:** Task 6 step 4 must guard with `if (payload.kind !== "void_receipt")`. Forgetting this means every void burns a new serial, which is wrong (FR29 says voids consume the original serial, not a new one).
- **Writing the test fixtures with stale schema:** the fixture builders in Task 13 must match the Task 1 schema exactly. If the schema diverges mid-implementation, regenerate the fixtures or the tests fail in confusing ways. Run `npx convex codegen` and let TypeScript catch the drift.
- **Wrong action scheduling pattern:** the architecture's § Service boundary specifies `ctx.scheduler.runAfter(0, internal.actions.foo.run, args)`. Not `ctx.runAction(internal.actions.foo.run, args)` — the latter blocks the mutation (or fails entirely in some Convex contexts). Use the scheduler.
- **Skipping the "fail-on-broken-implementation" sanity check:** without it, the 95%-coverage gate can be met by tests that "exercise" code without actually asserting outcomes. The architecture's "test-enforced" guarantee is empirical, not statistical.

### Open questions / blockers this story does NOT resolve

- **None for the helper's mechanism.** The cornerstone is independent of all §10 client gates.
- **§10 Q3 (BIR receipt modality)** affects Story 3.11's PDF action body, not this story's scheduling stub. The stub patches `pdfStatus: "ready"` immediately, allowing Phase 1 to ship the cornerstone before §10 Q3 is answered.
- **§10 Q1 (installment policy)** affects how the calling mutation in Story 3.4 constructs its `installments` array. The cornerstone accepts whatever schedule the caller supplies — policy decisions live in the calling layer.
- **Refund flow** is deferred to Epic 4. Phase 1 throws `NOT_IMPLEMENTED`. Adding it later is a payload-union extension, not a structural change.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/lib/postFinancialEvent.ts` path matches.
- [Architecture § Architectural Boundaries](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — all three boundaries (financial-write, receipt-counter, audit-write) enforced by lint rules from this story + Story 3.1 + Story 1.6.
- [Architecture § API & Communication Patterns](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns) — atomic-mutation pattern verbatim.
- [Architecture § Decision Impact Analysis > Implementation Sequence](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis) — step 7 of the architect's implementation order is "Implement `convex/lib/postFinancialEvent.ts` — tested to ≥ 95% coverage before any UI work."

No conflicts detected.

### References

- [PRD § Functional Requirements > FR32 (atomic transactions), FR28 (receipts), FR29 (voids), FR31 (immutability)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Non-Functional Requirements > NFR-C1, NFR-C2, NFR-R5, NFR-M2](../../_bmad-output/planning-artifacts/prd.md#non-functional-requirements)
- [Architecture § API & Communication Patterns > Atomic mutation pattern (cornerstone)](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [Architecture § Architectural Boundaries > Financial-entity write boundary + Receipt counter boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [Architecture § Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- [Architecture § Pattern Examples > Good payment posting](../../_bmad-output/planning-artifacts/architecture.md#pattern-examples)
- [Architecture § Implementation Sequence > Step 7](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis)
- [UX § Defining Experience — receipt preview modal, the "deliberate pause"](../../_bmad-output/planning-artifacts/ux-design-specification.md) (lines 580–745 — informs the user-facing surface that Stories 3.3 and 3.9 build atop this helper)
- [Epics § Story 3.2](../../_bmad-output/planning-artifacts/epics.md#story-32-postfinancialevent-cornerstone)
- Previous story dependencies: [Story 1.2 (`requireRole`, `ConvexError`)](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [Story 1.6 `emitAudit` (referenced)], [Story 1.7 state machines (extended)], [Story 3.1 `allocateNextSerial`](./3-1-receipt-counter-with-optimistic-concurrent-serial-allocation.md)
- Convex docs (current): [Mutations + atomicity](https://docs.convex.dev/functions/mutation-functions), [Scheduler](https://docs.convex.dev/scheduling/scheduled-functions), [convex-test](https://www.npmjs.com/package/convex-test)

## Dev Agent Record

### Agent Model Used

_To be filled by dev agent_

### Debug Log References

_To be filled by dev agent_

### Completion Notes List

_To be filled by dev agent — capture: (a) final test count + measured coverage on `convex/lib/postFinancialEvent.ts`; (b) any deviation from the step ordering in Task 6; (c) which Convex-test scheduler-introspection API was used; (d) overpayment-handling resolution (strict-fail vs. credit allocation); (e) any state-machine transitions that had to be added to Story 1.7's tables; (f) any test fixture patterns the implementation invented and should be promoted to the canonical fixture library._

### File List

_To be filled by dev agent — list every file created or modified._
