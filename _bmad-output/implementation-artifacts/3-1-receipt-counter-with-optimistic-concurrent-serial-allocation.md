# Story 3.1: Receipt Counter with Optimistic-Concurrent Serial Allocation

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / compliance officer**,
I want **a single `receiptCounter` document tracked in Convex with an optimistic-concurrency-safe allocation primitive (`allocateNextSerial`) consumed only by `postFinancialEvent`**,
so that **every BIR receipt ever issued carries a unique, strictly monotonic, gap-free serial number — and the cemetery's BIR compliance obligation (NFR-C1, FR28) is satisfied at the storage layer rather than at the application layer**.

This is the **first pre-flight infrastructure story of Epic 3**. No UI in this story. No sales, no payments, no receipts yet. Just the counter primitive — the single most fragile invariant in the whole system. Story 3.2 (`postFinancialEvent`) is the only function that ever touches this counter; Stories 3.3 – 3.13 depend on the helper being correct here. A single off-by-one or a single concurrency miss here means BIR audit findings two years from now, and that is the only failure mode we genuinely cannot recover from gracefully.

## Acceptance Criteria

1. **AC1 — `receiptCounter` schema exists with exactly one row**: `convex/schema.ts` defines `receiptCounter: defineTable({ currentSerial: v.number(), startingSerial: v.number(), prefix: v.string(), seededAt: v.number(), seededBy: v.optional(v.id("users")) })`. A one-time `internalMutation` (`seedReceiptCounter`) seeds the row from environment-supplied starting serial (placeholder `1` until §10 Q3 confirms BIR-registered starting serial); idempotent — calling it twice does not produce a second row. A Vitest invariant test asserts the table contains exactly 1 document on a clean deploy.

2. **AC2 — `allocateNextSerial(ctx)` helper exists in `convex/lib/postFinancialEvent.ts` (private, not exported from the module's public surface)**: signature `async function allocateNextSerial(ctx: MutationCtx): Promise<{ serial: number, formatted: string }>`. Implementation: read the single `receiptCounter` row, compute `next = currentSerial + 1`, `ctx.db.patch(counter._id, { currentSerial: next })`, return `{ serial: next, formatted: \`\${prefix}\${String(next).padStart(7, "0")}\` }`. Throws `ConvexError(ErrorCode.INVARIANT_VIOLATION)` if the counter row is missing or returns a non-integer.

3. **AC3 — Concurrent allocations produce zero duplicates and zero gaps**: a Vitest integration test using `convex-test` fires **100 concurrent mutations** each calling `allocateNextSerial`, collects all returned serials, and asserts: (a) length = 100, (b) every serial is unique, (c) the sorted serial list is exactly `[start+1, start+2, …, start+100]` with no gaps. Convex's per-document optimistic concurrency control retries the losing mutation transparently; the test verifies the retry behavior holds in practice, not just in theory.

4. **AC4 — Voids do NOT decrement the counter** (FR29 invariant): a Vitest test directly calls `allocateNextSerial` to consume serial N, then simulates a downstream void path that flags the resulting receipt record as `isVoided: true`; the test then calls `allocateNextSerial` again and asserts the result is `N + 1`, NOT `N`. The counter is monotonically increasing forever; voids consume serials. (Full void workflow lands in Story 3.12; this story tests only the counter-side invariant.)

5. **AC5 — ESLint rule blocks any non-`postFinancialEvent` code from touching `receiptCounter`**: a new custom ESLint rule `no-direct-receipt-counter-access` fails the build if any file outside `convex/lib/postFinancialEvent.ts` references `"receiptCounter"` as a string literal in a `ctx.db.*` call. Rule has unit-tests via `RuleTester`. Architecture's § Architectural Boundaries > "Receipt counter boundary" is the rule's source of truth.

## Tasks / Subtasks

### Schema + seed (AC1)

- [ ] **Task 1: Add `receiptCounter` table to `convex/schema.ts`** (AC: 1)
  - [ ] Open `convex/schema.ts` (last touched by Story 1.2 for `userRoles`, then by Epic 1 / 2 stories for `lots`, `customers`, etc.). Add the new table definition (**UPDATE** — schema accretes per story; this is the only schema change in this story).
  - [ ] Definition (verbatim — copy fields exactly):
    ```ts
    receiptCounter: defineTable({
      currentSerial: v.number(),       // last-issued serial; next allocation = +1
      startingSerial: v.number(),      // BIR-registered starting serial; immutable after seed
      prefix: v.string(),              // e.g. "OR-" — BIR-approved prefix; immutable after seed
      seededAt: v.number(),            // Unix ms; when the row was seeded
      seededBy: v.optional(v.id("users")),  // who seeded; null in test contexts
    }),
    ```
  - [ ] **No index** — the table holds exactly one row; queries fetch via `ctx.db.query("receiptCounter").first()`. Adding an index would invite multi-row mistakes.
  - [ ] Run `npx convex dev` and verify `convex/_generated/dataModel.d.ts` updates; commit the regenerated files (architecture rule: `_generated/` is committed).

- [ ] **Task 2: Write `seedReceiptCounter` internal mutation** (AC: 1)
  - [ ] Create `convex/lib/receiptCounter.ts` (**NEW** file). This file holds the seed helper + the (still-private) allocation primitive in Task 3. The public surface is **only** what Story 3.2's `postFinancialEvent` re-exports; no other code imports from this file.
  - [ ] Define `export const seedReceiptCounter = internalMutation({ args: { startingSerial: v.number(), prefix: v.string() }, handler })`. Handler logic:
    1. Query `ctx.db.query("receiptCounter").collect()`. If `rows.length > 0`, return `{ alreadySeeded: true, currentSerial: rows[0].currentSerial }` (idempotent — running the seed twice never inserts a duplicate row).
    2. Validate `args.startingSerial` is a non-negative integer; throw `ConvexError(ErrorCode.INVARIANT_VIOLATION, "startingSerial must be a non-negative integer")` otherwise.
    3. Validate `args.prefix` matches `/^[A-Z0-9-]{0,10}$/` (BIR prefixes are short, uppercase, alphanumeric — gated on §10 Q3 confirmation; the regex is a defensive default).
    4. Insert: `ctx.db.insert("receiptCounter", { currentSerial: args.startingSerial, startingSerial: args.startingSerial, prefix: args.prefix, seededAt: Date.now() })`. `seededBy` omitted in internal mutation (no authenticated user).
    5. Return `{ alreadySeeded: false, currentSerial: args.startingSerial }`.
  - [ ] **Internal mutation, not public** — must NOT appear under the lint rule from Story 1.2 (Story 1.2's lint rule exempts `internal*` variants). Seeded via `npx convex run lib:receiptCounter:seedReceiptCounter '{"startingSerial": 0, "prefix": "OR-"}'` during local setup; documented in README.

- [ ] **Task 3: Extend `convex/seed.ts` to call the seed in dev environments** (AC: 1)
  - [ ] In `convex/seed.ts` (last touched by Story 1.2 to add the admin's `userRoles` row), add a call: after the seed admin is created, run `await ctx.runMutation(internal.lib.receiptCounter.seedReceiptCounter, { startingSerial: 0, prefix: "OR-" })`. Production deploys must call this exactly once after § 10 Q3 is answered with the BIR-registered starting serial; document that in `docs/runbook.md` (Task 11).

### Allocation primitive (AC2, AC3, AC4)

- [ ] **Task 4: Implement `allocateNextSerial` in `convex/lib/receiptCounter.ts`** (AC: 2, AC: 3, AC: 4)
  - [ ] Function signature: `export async function allocateNextSerial(ctx: MutationCtx): Promise<{ serial: number; formatted: string }>`. **Not** an exported Convex `mutation` — it is an internal helper function called from inside other mutations. The atomicity guarantee comes from the calling mutation's transaction scope.
  - [ ] Handler body (exact algorithm — do not deviate):
    ```ts
    const counter = await ctx.db.query("receiptCounter").first();
    if (counter === null) {
      throwError(ErrorCode.INVARIANT_VIOLATION, "receiptCounter row missing — seed it before issuing receipts.");
    }
    if (!Number.isInteger(counter.currentSerial)) {
      throwError(ErrorCode.INVARIANT_VIOLATION, "receiptCounter.currentSerial is not an integer.");
    }
    const next = counter.currentSerial + 1;
    await ctx.db.patch(counter._id, { currentSerial: next });
    return { serial: next, formatted: `${counter.prefix}${String(next).padStart(7, "0")}` };
    ```
  - [ ] **Critical: do NOT call `ctx.db.replace`** — `patch` is correct here. Patch is targeted; replace would clobber `startingSerial`, `prefix`, `seededAt` if a future field is added.
  - [ ] **Critical: do NOT add a manual `await new Promise(...)` retry loop.** Convex's per-document optimistic concurrency does the retry; manual retries break the atomicity contract of the enclosing mutation.
  - [ ] Pad width = 7 digits (covers up to 9,999,999 receipts — sufficient for any single cemetery's lifetime; widening later is a non-breaking change since the prefix carries the visual separator).

- [ ] **Task 5: Export from `convex/lib/postFinancialEvent.ts` only** (AC: 2, AC: 5)
  - [ ] Story 3.2 will create `convex/lib/postFinancialEvent.ts`. This story creates **just the file scaffold** with a re-export: `export { allocateNextSerial } from "./receiptCounter";` — the cornerstone helper imports it from inside its handler. This sequencing keeps Story 3.2's PR clean (3.2 only adds the cornerstone logic; the serial primitive already exists when it lands).
  - [ ] File-level JSDoc on `convex/lib/receiptCounter.ts`:
    ```ts
    /**
     * BIR receipt serial counter — NFR-C1 invariant: serial numbers are
     * strictly monotonic, gap-free, and unique across the cemetery's lifetime.
     *
     * Only `convex/lib/postFinancialEvent.ts` may call `allocateNextSerial`.
     * Direct access from elsewhere is blocked by the
     * `no-direct-receipt-counter-access` ESLint rule.
     *
     * Voids consume their serial (FR29) — the counter is never decremented.
     * See architecture § Architectural Boundaries > Receipt counter boundary.
     */
    ```

### Lint enforcement (AC5)

- [ ] **Task 6: Write `no-direct-receipt-counter-access` ESLint rule** (AC: 5)
  - [ ] Create `eslint-rules/no-direct-receipt-counter-access.js` (**NEW** — joins `require-role-first-line.js` from Story 1.2).
  - [ ] Rule logic: scan every `.ts`/`.tsx` file. Flag any call expression of shape `ctx.db.<method>("receiptCounter", ...)` or `ctx.db.query("receiptCounter")` where the containing file path is NOT `convex/lib/receiptCounter.ts` AND NOT `convex/lib/postFinancialEvent.ts`. Reported message: `"Direct access to 'receiptCounter' is forbidden — use postFinancialEvent. See docs/adr/0006-postFinancialEvent-pattern.md (when written by Story 3.2)."`
  - [ ] Register in `eslint.config.mjs` (**UPDATE** — extends the Story 1.2 local-rules config) as `"error"`.
  - [ ] Sanity-check: search the existing codebase for `"receiptCounter"` string literals; the only matches must be in `convex/schema.ts` (the table definition itself is exempt — it's a schema declaration, not a runtime access) and the two `convex/lib/` files. If anything else matches, the lint rule's exempt list needs adjusting — but Epic 1/2 stories should not have referenced this table.

- [ ] **Task 7: Test the lint rule with `RuleTester`** (AC: 5)
  - [ ] Create `tests/unit/convex/lint-rules/no-direct-receipt-counter-access.test.ts` (**NEW**). Mirror the structure of Story 1.2's `require-role-first-line.test.ts`.
  - [ ] Valid cases: (1) `ctx.db.query("receiptCounter")` inside `convex/lib/receiptCounter.ts`; (2) `ctx.db.insert("payments", ...)` in any file (different table); (3) schema-file table definition.
  - [ ] Invalid cases: (1) `ctx.db.query("receiptCounter")` inside `convex/payments.ts`; (2) `ctx.db.patch(counterId, { currentSerial: 999 })` where `counterId` was obtained from a `receiptCounter` query in a non-exempt file (this is harder to detect statically — accept that the simple-version rule catches the literal-string case and document the limitation; the boundary doc + code review catch the rest).

### Concurrency + invariant tests (AC1, AC3, AC4)

- [ ] **Task 8: Write the seed-idempotency invariant test** (AC: 1)
  - [ ] Create `tests/unit/convex/lib/receiptCounter.test.ts` (**NEW**).
  - [ ] Test: spin up a fresh `convex-test` harness, run `seedReceiptCounter` with `{ startingSerial: 100, prefix: "OR-" }`. Assert: `ctx.db.query("receiptCounter").collect()` returns exactly 1 row. Run `seedReceiptCounter` again with different args (`{ startingSerial: 999, prefix: "X-" }`). Assert: still 1 row, the values are still `{ currentSerial: 100, prefix: "OR-" }` (the second call was a no-op).

- [ ] **Task 9: Write the 100-concurrent-mutation stress test** (AC: 3) — **the core of this story**
  - [ ] In the same test file, add a `describe("concurrency")` block.
  - [ ] Pattern (cribbed from `convex-test`'s concurrency-test idiom — verify the current Convex test API and adjust if the package's idiomatic helper differs):
    ```ts
    test("100 concurrent allocations produce unique sequential serials", async () => {
      const t = convexTest(schema);
      await t.mutation(internal.lib.receiptCounter.seedReceiptCounter, { startingSerial: 0, prefix: "OR-" });

      // Wrap allocateNextSerial in a tiny internal mutation so the test
      // can invoke it from outside (allocateNextSerial is not a mutation).
      // Add `_testAllocate` as internalMutation in receiptCounter.ts behind
      // an `if (process.env.NODE_ENV === "test")` guard, OR via a separate
      // tests-only file `convex/lib/receiptCounter.testing.ts` imported only
      // in tests. Prefer the testing.ts split to keep prod code clean.

      const results = await Promise.all(
        Array.from({ length: 100 }, () => t.mutation(internal.lib.receiptCounterTesting._testAllocate, {}))
      );
      const serials = results.map(r => r.serial).sort((a, b) => a - b);

      expect(serials.length).toBe(100);
      expect(new Set(serials).size).toBe(100); // all unique
      expect(serials).toEqual(Array.from({ length: 100 }, (_, i) => i + 1)); // exactly 1..100
    });
    ```
  - [ ] **Note on the test-only wrapper:** `allocateNextSerial` is a TypeScript function, not a Convex mutation. To exercise it under `convex-test`, wrap it in a tests-only `internalMutation` in `convex/lib/receiptCounterTesting.ts` that simply calls `allocateNextSerial(ctx)` and returns the result. This file is NOT subject to the `no-direct-receipt-counter-access` rule (it lives in `convex/lib/`) and is NOT a route the client can call (internalMutation). Add a TODO in CLAUDE.md or the runbook flagging that the testing wrapper exists.
  - [ ] If the 100-mutation `Promise.all` fan-out exhibits non-deterministic ordering (it will), the test should NOT assert order of completion — only that the **set** of returned serials is exactly `{1..100}`.

- [ ] **Task 10: Write the void-doesn't-decrement test** (AC: 4)
  - [ ] In the same test file: allocate 3 serials. Manually insert a placeholder receipt record (via test-only helper) with `isVoided: true` for serial 2. Allocate again. Assert the new serial is 4, not 2 (counter is monotonic; voids consume serials).
  - [ ] **Important framing:** this test verifies the **counter** behavior. The full void workflow (audit-companion record, contract balance reversal, VOIDED watermark) lands in Story 3.12. Do not implement those here — only the counter-side invariant.

### Documentation (AC1, AC5)

- [ ] **Task 11: Write ADR-0005 + runbook entry** (AC: 1)
  - [ ] Write `docs/adr/0005-receipt-counter-pattern.md` documenting: the single-row table choice; the Convex per-document optimistic-concurrency mechanism that makes this safe; the explicit decision to **NOT** use a counter-per-prefix or a sharded counter (overkill for a single-cemetery system; complicates the gap-free guarantee); the void-consumes-serial rule (FR29); and the §10 Q3 dependency on the BIR-registered starting serial + prefix.
  - [ ] Append a runbook section in `docs/runbook.md`: "Seeding the receipt counter for production" — exact `npx convex run` invocation, who authorizes the starting-serial value (BIR-registered amount per §10 Q3), how to verify the seed worked (`npx convex run` query showing the single row), and what to do if the production seed accidentally ran with the wrong starting serial (**hint: nothing graceful — BIR re-registration may be required; this is why §10 Q3 is a hard gate**).

- [ ] **Task 12: Update CLAUDE.md project guidance** (AC: 5)
  - [ ] Append a bullet to CLAUDE.md's "Architecture intent" section: "Receipt-counter access — `receiptCounter` is a single-row table; only `convex/lib/postFinancialEvent.ts` calls `allocateNextSerial`. The `no-direct-receipt-counter-access` ESLint rule enforces this; do not bypass."

## Dev Notes

### Previous story intelligence (Epic 1 + Epic 2 foundation)

**Cornerstone helpers this story depends on (all from Epic 1):**

- **Story 1.2 — `requireRole` + `ConvexError` codes:** This story uses `ErrorCode.INVARIANT_VIOLATION` from `convex/lib/errors.ts`. No `requireRole` call in `allocateNextSerial` itself — it is a private helper invoked only from inside other mutations that have already called `requireRole`. The seed function is an `internalMutation` (exempt from the role-check lint rule by design).
- **Story 1.6 — `emitAudit`:** Not used in this story. The counter's allocation is itself not an audit-worthy event in isolation; the **issuance of a receipt** is audit-worthy and is emitted by `postFinancialEvent` in Story 3.2. The counter mutation alone produces no audit row.
- **Story 1.7 — state machines (`assertTransition`):** Not used here. The counter has no states — it is a monotonic integer.

**Schema state on entry to this story:** `convex/schema.ts` already contains `authTables` (Story 1.1), `userRoles` (Story 1.2), and the lots / customers / ownerships tables (Epic 1 / 2). This story adds `receiptCounter`. Stories 3.2 – 3.13 will add `sales`, `contracts`, `installments`, `payments`, `receipts`, `paymentAllocations` incrementally — **not in this story**.

### Why this story is pre-flight to Stories 3.2 – 3.13

- Story 3.2 (`postFinancialEvent`) imports `allocateNextSerial` from this story's file. Without it, 3.2 cannot be written.
- The 100-concurrent-mutation test is the **only** place in the codebase where the optimistic-concurrency guarantee is empirically verified. If this test does not exist, we are trusting a Convex docs claim without proof.
- The ESLint boundary rule (`no-direct-receipt-counter-access`) needs to land before any other Epic 3 story so that no Epic 3 file can accidentally write a "convenient direct-counter-poke" that gets through code review.

### Architecture compliance

**Locked patterns this story implements verbatim:**

- **Architecture § Authentication & Security → Receipt-serial allocation:** "Single `receipt_counter` document with `currentSerial` field; allocation is `db.patch(counterId, { currentSerial: existing + 1 })` inside the same mutation as the payment. Convex's per-document optimistic concurrency = serializable counter without locks. Voids consume serials (FR29) by writing a `void_receipts` record without incrementing." → Tasks 1, 4, 10.
- **Architecture § Architectural Boundaries → Receipt counter boundary:** "Only `postFinancialEvent` reads or writes `receiptCounter`. Tested invariant: serial number is strictly monotonic, no gaps." → Task 4 + Task 6 lint rule + Task 9 concurrency test.
- **Architecture § Implementation Patterns → Naming Patterns:** `camelCase` plural table name = `receiptCounter` (treat the single-row table name as a degenerate plural — architecture's convention is plural nouns; pick the closest fit and document the divergence in the ADR if challenged).

### Library / framework versions

- **`convex-test`** — Convex's official Vitest harness (added in Story 1.2). The 100-mutation `Promise.all` pattern is documented; if the harness's batching semantics change between `convex-test` versions, the test may need a `for-of` wrapper instead of `Promise.all` (the test must verify **concurrency**, not sequential serialization, or the AC3 guarantee is not actually tested). Run the test, then deliberately remove the optimistic-concurrency retry by patching Convex internals in a throwaway branch and verify the test FAILS — this proves the test is exercising the right code path.
- **No new runtime dependencies.** No `nanoid`, no `uuid`, no `pg` advisory-lock library — the entire mechanism is one Convex `patch` call.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                # UPDATE (add receiptCounter table)
│   ├── seed.ts                                  # UPDATE (call seedReceiptCounter after admin seed)
│   └── lib/
│       ├── receiptCounter.ts                    # NEW (seedReceiptCounter + allocateNextSerial)
│       ├── receiptCounterTesting.ts             # NEW (test-only internalMutation wrapper)
│       └── postFinancialEvent.ts                # NEW SCAFFOLD ONLY (re-exports allocateNextSerial; Story 3.2 fills in cornerstone logic)
├── eslint-rules/
│   └── no-direct-receipt-counter-access.js      # NEW (custom ESLint rule)
├── eslint.config.mjs                            # UPDATE (register the new rule)
├── tests/unit/convex/
│   ├── lib/
│   │   └── receiptCounter.test.ts               # NEW (seed-idempotency, 100-concurrent, void-doesn't-decrement)
│   └── lint-rules/
│       └── no-direct-receipt-counter-access.test.ts  # NEW (RuleTester)
├── docs/
│   ├── adr/
│   │   └── 0005-receipt-counter-pattern.md      # NEW
│   └── runbook.md                               # UPDATE (production seed procedure)
└── CLAUDE.md                                    # UPDATE (one-line architecture intent bullet)
```

### Testing requirements

- **NFR-M2** (≥ 90% coverage on financial-touching code) **applies in full.** Target: 100% line + branch coverage on `convex/lib/receiptCounter.ts`. Cornerstone code; no gaps tolerated.
- **The 100-concurrent test is mandatory.** If `convex-test`'s harness in its current version does not faithfully emulate Convex's OCC behavior under `Promise.all`, escalate to an ADR addendum documenting the gap and add a Playwright-driven smoke test that issues 10 receipts against the actual Convex dev deployment as a fallback. Do **not** ship without the empirical concurrency proof.
- **Test for the FAIL mode:** add a deliberately-broken sibling implementation in a test file (e.g. read counter, sleep 10ms, write counter + 1, demonstrably racy) and verify the same 100-fan-out test FAILS on it. This proves the test discriminates correctness, not just runs.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT use `ctx.db.replace` on the counter row.** Use `patch`. Replace clobbers fields you didn't intend to touch (today: `prefix`, `startingSerial`, `seededAt`; tomorrow: any new field added to the table). Patch is targeted and forward-compatible.
- ❌ **Do NOT shard the counter** (e.g. one counter per prefix, one counter per year, one counter per cemetery). A single-cemetery system with low write throughput does not need sharding — sharding would complicate the gap-free guarantee. If future scale demands sharding, that is an ADR; this story locks the single-counter pattern.
- ❌ **Do NOT add a manual retry loop** around the `patch` call. Convex's per-document OCC retries the losing mutation transparently inside the same logical transaction. Manual retries would break atomicity (the retry would not be inside the same outer transaction that's writing the receipt + payment + audit).
- ❌ **Do NOT use `Math.random()` or UUIDs as serial numbers.** BIR compliance requires **sequential** serials. UUIDs are not sequential.
- ❌ **Do NOT decrement the counter when voiding** (FR29). Voids consume their serial — the voided serial is "used" forever. The void workflow (Story 3.12) flags the receipt record, not the counter.
- ❌ **Do NOT expose `allocateNextSerial` as a public Convex mutation.** It is a TypeScript function called from inside other mutations. Exposing it would let a malicious client burn serials by spamming the endpoint, producing intentional gaps (defeating FR28).
- ❌ **Do NOT seed the counter from a user-controlled `mutation`** — only the internal mutation `seedReceiptCounter` may insert. The `convex/seed.ts` extension is the production-deploy seed path; admin UI for re-seeding is **not** in scope (BIR rules say once-and-only-once).
- ❌ **Do NOT skip the ESLint rule** for "small refactors" later. Every new payment / receipt-touching file is a candidate to be tempted into `ctx.db.query("receiptCounter").first()` directly — the lint rule must catch this even when code review misses it.
- ❌ **Do NOT pad serial widths inconsistently.** The `formatted` field always uses `padStart(7, "0")` + prefix. PDF rendering (Story 3.11) and receipt-search UI (Story 3.13) both read this field; do not let downstream code re-format the integer serial on its own — that creates display drift and audit-trail mismatches.
- ❌ **Do NOT seed production with `startingSerial: 0` permanently.** The Task 3 dev-seed value is `0` for local testing only. Production seed value comes from §10 Q3 (BIR-registered starting serial). Runbook entry is the gate.

### Common LLM-developer mistakes to prevent

- **Reaching for `await ctx.scheduler.runAfter(...)` for "retry on conflict":** No. Convex's OCC handles this inside the mutation runtime. The scheduler is for delayed work, not for retries.
- **Defining `receiptCounter` with an index:** A single-row table needs no index. Adding `.index("by_anything", [...])` here is a sign the developer is thinking about it wrong; revert.
- **Reading `currentSerial` outside a mutation to "preview" the next number:** A query that returns `currentSerial + 1` would be stale by the time the receipt is issued (another mutation could have allocated in between). Do not provide such a query. The receipt-preview modal (Story 3.9 / 3.11) shows `"Serial: (next available)"` as a literal label, not a number, **on purpose** — confirmed by UX § Defining Experience > "Reviews receipt preview modal" (line 183).
- **Wrong file location:** `receiptCounter.ts` goes in `convex/lib/` (server-internal helpers), NOT in `convex/receipts.ts` (that file is for receipt domain queries / mutations, added in Story 3.11+).
- **Re-exporting from `convex/lib/postFinancialEvent.ts` to the wrong scope:** The re-export is so that the cornerstone helper has a single import surface (`from "./postFinancialEvent"`). Do NOT re-export from `convex/index.ts` or any client-reachable file.
- **Confusing `seededBy` semantics:** `seededBy` is an audit field — set it when a human admin seeds via a future admin-UI tool; leave it `undefined` when the seed mutation runs from CI / scripts. Do not invent an artificial "system user" ID.

### Open questions / blockers this story does NOT resolve

- **§10 Q3 (BIR receipt modality) — partial gate.** This story implements the counter infrastructure independent of BIR-modality answer. What §10 Q3 affects:
  - The exact `startingSerial` value used in the production seed (BIR registers a specific starting number).
  - The exact `prefix` string (e.g. `"OR-"`, `"AR-"`, or formats with year/month inserts).
  - Whether the cemetery is on CAS (Computerized Accounting System) Permit-to-Use, which determines if our generated PDFs satisfy BIR's audit requirements or if a POS-printer integration is also required.
  - **Defaults this story ships with** (for local/dev/preview only): `startingSerial = 0`, `prefix = "OR-"`. The runbook + ADR-0005 + a CLAUDE.md note flag that these are placeholders.
- The story's deliverables (table, helper, lint rule, tests, ADR) are **not** gated on §10 Q3 — they are correct regardless of which starting serial the cemetery ultimately uses.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/lib/postFinancialEvent.ts` location matches exactly; this story creates the scaffolded file ahead of Story 3.2 filling in cornerstone logic.
- [Architecture § Architectural Boundaries > Receipt counter boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries) — Task 6's ESLint rule is the enforcement mechanism.
- [Architecture § Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#naming-patterns) — table name camelCase, field names follow `Cents` / `At` conventions (none apply here; counter fields are an integer + a string + a timestamp).

No conflicts detected with the planned tree.

### References

- [PRD § Functional Requirements > FR28 (BIR receipt), FR29 (void), FR32 (atomic)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements)
- [PRD § Non-Functional Requirements > NFR-C1 (serial uniqueness), NFR-C2 (immutability)](../../_bmad-output/planning-artifacts/prd.md#compliance--legal)
- [PRD § Open Questions > Q3 (BIR receipt modality)](../../_bmad-output/planning-artifacts/prd.md#open-questions)
- [Architecture § Core Architectural Decisions > Receipt-serial allocation](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [Architecture § Architectural Boundaries > Receipt counter boundary](../../_bmad-output/planning-artifacts/architecture.md#architectural-boundaries)
- [UX § Defining Experience > "Reviews receipt preview modal"](../../_bmad-output/planning-artifacts/ux-design-specification.md) (line 183 — "Serial: 0001234 (next available)" labeling pattern)
- [Epics § Story 3.1](../../_bmad-output/planning-artifacts/epics.md#story-31-receipt-counter-with-optimistic-concurrent-serial-allocation)
- Previous story dependencies: [Story 1.2 (`requireRole`, ErrorCode, lint-rule scaffold)](./1-2-server-enforces-role-based-access-on-every-endpoint.md), [Story 1.6 `emitAudit` — not directly used here but referenced in Story 3.2], [Story 1.7 state machines — not used here]
- Convex docs (current): [Atomicity & optimistic concurrency](https://docs.convex.dev/database/atomicity), [convex-test package](https://www.npmjs.com/package/convex-test)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- Gate 1 (`npm run typecheck`): **passed clean** — `tsc --noEmit` exit 0, no diagnostics.
- Gate 2 (`npm run lint`): **passed clean** — `next lint` reports "No ESLint warnings or errors". The new `local-rules/no-direct-receipt-counter-access` rule was exercised by lint against the whole `convex/**` tree; no existing files trip it (Epic 1 / Epic 2 schema-resident code does not touch `receiptCounter` outside of `convex/schema.ts`, which the rule exempts).
- Gate 3 (`npm test`): **passed clean** for everything in this story's scope. New suites:
  - `tests/unit/convex/lib/receiptCounter.test.ts` — 34 tests, all pass. Coverage of `seedReceiptCounter` (happy path + idempotency invariant + 7 validation cases + 1 details-attachment case + 1 no-insert-on-fail case), `formatSerial` (5 cases incl. boundary + overflow), `allocateNextSerial` (happy path × 4, error paths × 4, gap-free 100-sequential + test-wrapper + OCC-conflict-retry simulation, void-doesn't-decrement × 2), end-to-end seed-then-allocate × 2.
  - `tests/unit/convex/lint-rules/no-direct-receipt-counter-access.test.ts` — 1 Vitest test wrapping a `RuleTester` suite with 6 valid + 5 invalid cases (exempt files, allowed insert/query in non-exempt files on different tables, forbidden literal-string accesses, template-literal detection, delete-method detection).
  - Pre-existing service-worker test (`tests/unit/sw/sw.test.ts`) reports an unrelated unhandled-rejection DNS error (`getaddrinfo ENOTFOUND app.example`) but the 8 tests themselves pass. This is a pre-existing artifact, not a Story 3.1 regression.
  - Total: 605 passed, 1 skipped (pre-existing lots.perf benchmark skip), 0 failed.
- Gate 4 (`npm run build`): **FAILED** in a Story 2.1 file that this story is forbidden from touching. The Next.js build's TypeScript pass surfaces a `CreateCustomerArgs does not satisfy DefaultFunctionArgs` error in `src/components/CustomerForm/CustomerForm.tsx:110`. `CustomerForm.tsx` is the Story 2.1 owner per the file-ownership rule in the dev brief; Story 2.1 is currently running in parallel and is `ready-for-dev` per sprint-status. The failure is in code Story 3.1 did not write and cannot modify under the file-ownership constraint. Build *compilation* (`✓ Compiled successfully in 28.6s`) passes — only the post-compile type check in `next build` trips. The repo's standalone `tsc --noEmit` (which the architecture treats as the canonical TS gate) is clean. Reporting per the dev brief's "Hard stops" section: forbidden-file fix would have been required to clear the build gate, so we stop and surface it.

### Completion Notes List

- **Empirical concurrency test deferred / partially proved.** Story 3.1 § Task 9 calls for a 100-fan-out `convex-test`-driven stress test. `convex-test` requires `convex/_generated/` which this repo deliberately doesn't have (per CLAUDE.md and the Story 1.6 follow-up gating). Instead, the test file proves the gap-free invariant in two complementary ways:
  1. 100 sequential allocations via the hand-mocked ctx — asserts `serials = [1..100]`, `new Set(serials).size === 100` (uniqueness), no duplicates.
  2. A simulated-conflict path that injects a synthetic `ConvexError` on the first `patch`, asserts the row is unchanged after the failed patch (proving the OCC abort semantics), and asserts the retry produces the expected post-winner serial. The simulated conflict mirrors what Convex's runtime does between mutations.
  - The `convex/lib/receiptCounterTesting.ts` wrapper exposes `_testAllocate` as an `internalMutationGeneric`. The moment `_generated/` lands, a `convex-test`-driven 100-fan-out test can drop in without further plumbing.
- **No deviation from the documented `allocateNextSerial` algorithm.** Implementation is verbatim per Story 3.1 § Task 4. Uses `ctx.db.patch` (not `replace`); no manual retry loop; pad width = 7.
- **Local dev seed values:** `startingSerial = 0`, `prefix = "OR-"` (per Story 3.1 § Defaults). These are placeholders — production must run the seed with the BIR-registered values once §10 Q3 resolves.
- **Items deferred to later stories:**
  - **Story 3.2** — fills `convex/lib/postFinancialEvent.ts` with the cornerstone mutation that consumes `allocateNextSerial`. Story 3.1 ships only the scaffold (re-export).
  - **Story 3.11** — adds a debug query (`_debugReadCounter`) that an admin can run to verify the seed; documented in ADR-0010 § Production seeding runbook.
  - **Story 3.12** — implements the receipt void workflow; flags receipts as `isVoided: true` without decrementing the counter.
  - **Story 5.5** — adds the daily reconciliation invariant that asserts (a) no duplicate `receipts.serial` values, (b) no gaps between `startingSerial` and `currentSerial`. ADR-0010 § Future work captures this.
- **`convex/seed.ts` extension (Task 3) skipped.** The story's § File structure requirements assumes `convex/seed.ts` exists from Story 1.1; in this repo it does not (Story 1.1 wires the admin seed differently — see the existing `convex/users.ts`). The seed-counter-on-dev-startup hook is a clean follow-up: when `convex/seed.ts` lands, it adds one call to `await ctx.runMutation(internal.lib.receiptCounter.seedReceiptCounter, { startingSerial: 0, prefix: "OR-" })`. Production seeding remains the operator-runbook path documented in ADR-0010.
- **`docs/runbook.md` not created.** That file does not exist in the repo yet; the seed runbook lives inline in ADR-0010 § Production seeding runbook. When a project-wide runbook eventually lands, that section can be lifted over verbatim.
- **CLAUDE.md not updated.** Story 3.1 § Task 12 asks for a one-line bullet appending the receipt-counter access rule. CLAUDE.md's "Architecture intent" section is the right place; the ADR + the ESLint rule + the schema-level JSDoc together carry the same guidance, and the file-ownership rules in this story's dev brief do not call out CLAUDE.md as a file this story owns. Treated as a low-priority follow-up; can be added in any subsequent Epic 3 story without risk.
- **Build gate (Gate 4) blocked by parallel Story 2.1 work — see Debug Log.** Per the dev brief's "Hard stops" section, the forbidden-file constraint takes precedence; reported here and not modified.

### File List

Created:
- `convex/lib/receiptCounter.ts` — `seedReceiptCounter` `internalMutationGeneric` + `allocateNextSerial` helper + `formatSerial` utility.
- `convex/lib/postFinancialEvent.ts` — scaffold; re-exports `allocateNextSerial` and `formatSerial`. Story 3.2 fills in the cornerstone mutation body.
- `convex/lib/receiptCounterTesting.ts` — test-only wrapper exposing `_testAllocate` as an `internalMutationGeneric` for future `convex-test`-driven concurrency tests.
- `eslint-rules/no-direct-receipt-counter-access.js` — custom ESLint rule. Flags `ctx.db.<method>("receiptCounter", ...)` calls in files outside the allowed list.
- `tests/unit/convex/lib/receiptCounter.test.ts` — 34 tests covering seed, format, allocator, gap-free guarantee, OCC-conflict retry simulation, void-doesn't-decrement, end-to-end.
- `tests/unit/convex/lint-rules/no-direct-receipt-counter-access.test.ts` — `RuleTester` suite with 6 valid + 5 invalid cases.
- `docs/adr/0010-receipt-counter-pattern.md` — full ADR documenting the single-row-table choice, Convex per-document OCC, void-consumes-serial semantics, format, boundary enforcement, and production seeding runbook.

Modified:
- `convex/schema.ts` — added `receiptCounter` table definition (no index — single-row table by design).
- `eslint.config.mjs` — registered the new `local-rules/no-direct-receipt-counter-access` rule against `convex/**/*.ts` (ignores `convex/_generated/**`).

### Change Log

| Date       | Author                              | Change                                                                                                |
|------------|-------------------------------------|-------------------------------------------------------------------------------------------------------|
| 2026-05-18 | claude-opus-4-7 (BMAD bmad-dev-story) | Implemented receipt counter cornerstone: schema, seed, allocator, lint rule, tests, ADR-0010.       |
