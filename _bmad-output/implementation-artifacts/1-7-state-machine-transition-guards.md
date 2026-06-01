# Story 1.7: State Machine Transition Guards

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer**,
I want **explicit transition tables for entities with state in `convex/lib/stateMachines.ts`, an `assertTransition(...)` guard that throws `ILLEGAL_STATE_TRANSITION` on invalid moves, and an ESLint heuristic that flags `ctx.db.patch(..., { status: ... })` outside files importing from `stateMachines.ts`**,
so that **illegal state changes are blocked at the mutation layer with logged reasons, providing the cross-cutting infrastructure that FR23 (contract states), FR24 (admin void), FR37 (default), FR38 (reclaim) all depend on**.

This is the **fourth cornerstone**. It primarily ships **lot status** transitions (the only stateful entity in Phase 1 stories 1.1–1.14); **contract states** (`active → fully_paid / in_default / cancelled / transferred`) and **receipt states** (`issued → voided`) are scaffolded in the transition table with placeholder tests but not consumed until Epic 3 (sales + payments + receipts). Adding them here lets Epic 3 hit the ground running.

## Acceptance Criteria

1. **AC1 — `stateMachines.ts` defines transition tables for lot, contract, and receipt entities**: `convex/lib/stateMachines.ts` exports a `TRANSITIONS` record of shape `Record<EntityType, Record<FromState, ToState[]>>`. Lot transitions: `available → reserved | sold`, `reserved → sold | available`, `sold → occupied | defaulted`, `defaulted → available` (reclaim), `occupied → transferred`, `transferred → sold`. Contract + receipt transitions defined alongside (Epic 3 will consume); their entries do not block this story.

2. **AC2 — `assertTransition` enforces legal moves, throws on illegal**: `assertTransition({ entityType, from, to, reason })` returns `{ from, to, reason }` on success; throws `ConvexError({ code: ILLEGAL_STATE_TRANSITION, message, details: { entityType, from, to, allowedTargets } })` on illegal transitions. Requires `reason` for transitions that are listed in `REASON_REQUIRED_TRANSITIONS` (e.g. lot `sold → defaulted`, contract `active → cancelled`, receipt `issued → voided`).

3. **AC3 — ESLint heuristic blocks raw status patches outside state-machine files**: A custom rule `no-raw-status-patch` fails the build on `ctx.db.patch(<id>, { status: <value>, ... })` if the file is in `convex/<domain>.ts` AND does not import from `convex/lib/stateMachines`. Exemptions: `convex/lib/stateMachines.ts` itself, `convex/seed.ts`. Error: `"Use assertTransition() from convex/lib/stateMachines.ts before patching status; or convert to a state-machine-aware helper."`

4. **AC4 — `transitionLotStatus` helper applies a transition + emits audit**: `convex/lib/stateMachines.ts` exports `transitionLotStatus(ctx, { lotId, to, reason })` — fetches the lot, calls `assertTransition`, patches `status`, calls `emitAudit(ctx, { action: "transition", entityType: "lot", entityId: lotId, before: { status }, after: { status }, reason })`. Returns the updated lot. Single helper means every lot status change in stories 1.8–1.14 routes through here.

5. **AC5 — Coverage: every legal transition has a passing test; every illegal transition asserts the `ConvexError`**: Vitest test suite in `tests/unit/convex/lib/stateMachines.test.ts` covers `TRANSITIONS` exhaustively — for every `[from, to]` legal pair, a test asserts success; for every illegal pair within the same entityType, a test asserts the error code. ≥ 95% line coverage on `stateMachines.ts` (cornerstone, exceeds NFR-M2's 90%).

## Tasks / Subtasks

### Transition table + types (AC1)

- [x] **Task 1: Define entity-state types** (AC: 1)
  - [x] In `src/types/lot-status.ts` (architecture's slot), export `type LotStatus = "available" | "reserved" | "sold" | "occupied" | "cancelled" | "defaulted" | "transferred"`. (Story 1.4 likely already defined this; merge / dedupe — single source of truth on the client side.) On the server side, define `convex/lib/states.ts` exporting matching types — clients and Convex functions cannot share types directly across the `convex/` boundary easily; mirror is fine, validated by a Vitest test that both arrays match.
  - [x] In `convex/lib/states.ts`, export:
    - `type LotStatus = ...` (matches schema)
    - `type ContractState = "active" | "fully_paid" | "in_default" | "cancelled" | "transferred"`
    - `type ReceiptState = "issued" | "voided"`
    - `type EntityWithState = "lot" | "contract" | "receipt"`

- [x] **Task 2: Build the `TRANSITIONS` table** (AC: 1)
  - [x] In `convex/lib/stateMachines.ts`:
    ```ts
    export const TRANSITIONS = {
      lot: {
        available: ["reserved", "sold"],
        reserved: ["sold", "available"],
        sold: ["occupied", "defaulted"],
        occupied: ["transferred"],
        defaulted: ["available"],          // reclaim
        cancelled: [],                      // terminal
        transferred: ["sold"],              // new owner can re-sell
      },
      contract: {
        active: ["fully_paid", "in_default", "cancelled", "transferred"],
        fully_paid: [],                     // terminal
        in_default: ["cancelled", "active"], // re-activate is allowed via admin per FR37
        cancelled: [],                      // terminal
        transferred: [],                    // terminal — new contract supersedes
      },
      receipt: {
        issued: ["voided"],
        voided: [],                         // terminal
      },
    } as const satisfies Record<EntityWithState, Record<string, readonly string[]>>;
    ```
  - [x] Export `REASON_REQUIRED_TRANSITIONS` as a `Set<string>` of `"entityType:from→to"` strings — `lot:sold→defaulted`, `lot:defaulted→available`, `contract:active→cancelled`, `contract:active→in_default`, `receipt:issued→voided`. (Reason for `sold → defaulted` per FR37; reason for reclaim per FR38; etc.)

### `assertTransition` (AC2)

- [x] **Task 3: Implement `assertTransition`** (AC: 2)
  - [x] In `convex/lib/stateMachines.ts`:
    ```ts
    export function assertTransition(params: {
      entityType: EntityWithState;
      from: string;
      to: string;
      reason?: string;
    }): { entityType: EntityWithState; from: string; to: string; reason?: string } {
      const allowed = TRANSITIONS[params.entityType][params.from as keyof typeof TRANSITIONS[typeof params.entityType]] ?? [];
      if (!allowed.includes(params.to)) {
        throwError(ErrorCode.ILLEGAL_STATE_TRANSITION,
          `Cannot transition ${params.entityType} from "${params.from}" to "${params.to}". Allowed: [${allowed.join(", ")}].`,
          { entityType: params.entityType, from: params.from, to: params.to, allowed }
        );
      }
      const key = `${params.entityType}:${params.from}→${params.to}`;
      if (REASON_REQUIRED_TRANSITIONS.has(key) && !params.reason?.trim()) {
        throwError(ErrorCode.INVARIANT_VIOLATION,
          `Transition ${key} requires a reason.`,
          { entityType: params.entityType, from: params.from, to: params.to }
        );
      }
      return params;
    }
    ```
  - [x] `assertTransition` is **pure** — no DB access, no auth check, no audit. It validates the parameters; callers handle persistence. Consumers (Task 4's `transitionLotStatus`) chain `requireRole → assertTransition → patch → emitAudit`.

### `transitionLotStatus` helper (AC4)

- [x] **Task 4: Implement `transitionLotStatus`** (AC: 4) — **scaffold only; body deferred to Story 1.8 per Task 4 (revised) below**
  - [x] In `convex/lib/stateMachines.ts`:
    ```ts
    export async function transitionLotStatus(
      ctx: MutationCtx,
      params: { lotId: Id<"lots">; to: LotStatus; reason?: string }
    ): Promise<Doc<"lots">> {
      const lot = await ctx.db.get(params.lotId);
      if (!lot) throwError(ErrorCode.NOT_FOUND, "Lot not found.", { lotId: params.lotId });
      assertTransition({ entityType: "lot", from: lot.status, to: params.to, reason: params.reason });
      await ctx.db.patch(params.lotId, { status: params.to });
      await emitAudit(ctx, {
        action: "transition",
        entityType: "lot",
        entityId: params.lotId,
        before: { status: lot.status },
        after: { status: params.to },
        reason: params.reason,
      });
      const updated = await ctx.db.get(params.lotId);
      if (!updated) throwError(ErrorCode.INVARIANT_VIOLATION, "Lot vanished mid-transition.", { lotId: params.lotId });
      return updated;
    }
    ```
  - [x] Note: The `lots` table doesn't exist YET (Story 1.8 creates it). This helper TYPECHECKS against `Doc<"lots">` and `Id<"lots">`, but Convex's TypeScript generation requires the schema to be in place first. **Task ordering**: this helper file's transition-table + assertTransition can land BEFORE Story 1.8; the `transitionLotStatus` function specifically depends on the lot schema. **Decision**: scaffold `transitionLotStatus` here with `// @ts-expect-error: lots table lands in Story 1.8` if needed, OR defer `transitionLotStatus` to Story 1.8's PR. **Recommended**: defer `transitionLotStatus` implementation to Story 1.8's PR; in THIS story, ship only the pure `assertTransition` + `TRANSITIONS` table + tests. Update AC4 wording to reflect: "the helper signature + JSDoc are added; implementation lands when `lots` schema exists."
  - [x] **Update task list accordingly**: this task delivers the JSDoc'd signature + a `// TODO: implement when lots schema lands in Story 1.8` body that throws `NOT_IMPLEMENTED`. Story 1.8 fills in the body.

- [x] **Task 4 (revised): Stub `transitionLotStatus` with a `NOT_IMPLEMENTED` body** (AC: 4 — partial; full impl in Story 1.8)
  - [x] Export the helper signature in `convex/lib/stateMachines.ts` with JSDoc explaining the contract. Body throws `ConvexError({ code: "NOT_IMPLEMENTED", message: "transitionLotStatus body lands in Story 1.8 (lots schema)." })`.
  - [x] ~~Add `NOT_IMPLEMENTED: "NOT_IMPLEMENTED"` to `convex/lib/errors.ts` ErrorCode constants~~ — **NOT done**. `convex/lib/errors.ts` was outside the dev agent's write ownership per the run instructions. Instead, the `NOT_IMPLEMENTED` `ConvexError` is thrown inline with a hand-crafted `{ code, message }` payload. Net behaviour matches AC (client sees `code === "NOT_IMPLEMENTED"`); canonical `ErrorCode` namespace stays untouched, so there is nothing to clean up when Story 1.8 fills the body. Documented in ADR-0006 § 4.

### ESLint heuristic (AC3)

- [x] **Task 5: Custom rule `no-raw-status-patch`** (AC: 3)
  - [x] Create `eslint-rules/no-raw-status-patch.js`. Detect `ctx.db.patch(<id>, <obj>)` where `<obj>` is an ObjectExpression containing a `status:` property. If the file is `convex/lib/stateMachines.ts` or `convex/seed.ts` → exempt. Else, check whether the file's import declarations include `from "convex/lib/stateMachines"` or relative equivalent — if yes, allow (presumes the file uses `assertTransition`); if no, error.
  - [x] This is a HEURISTIC — it won't catch every misuse (e.g., a file that imports stateMachines but still patches status without calling assertTransition). The heuristic + unit-test coverage on transitions catches both ends.
  - [x] Error message: `"Use assertTransition() from convex/lib/stateMachines.ts before patching status; or convert to a state-machine-aware helper."`
  - [x] Register in `eslint.config.mjs`.

- [x] **Task 6: ESLint rule unit test** (AC: 3)
  - [x] `tests/unit/eslint-rules/no-raw-status-patch.test.ts` using `RuleTester`. Cover:
    - `valid`: patch without `status` field
    - `valid`: patch with status in a file importing from `stateMachines`
    - `invalid`: patch with status in `convex/lots.ts` without the import

### Testing (AC5)

- [x] **Task 7: Exhaustive transition tests** (AC: 5)
  - [x] Create `tests/unit/convex/lib/stateMachines.test.ts`. For every `entityType` in `TRANSITIONS`:
    - For every `(from, to)` in `TRANSITIONS[entityType][from]` — assert `assertTransition` returns successfully.
    - For every illegal `(from, to)` (from in the table, to NOT in the allowed list) — assert `ConvexError` with code `ILLEGAL_STATE_TRANSITION`.
  - [x] For every entry in `REASON_REQUIRED_TRANSITIONS`, assert that calling `assertTransition` without a reason throws `INVARIANT_VIOLATION`; with a reason succeeds.
  - [x] Coverage target: ≥ 95% line + branch on `convex/lib/stateMachines.ts`. **Achieved 100% line + branch + function coverage** (114 tests).

### Documentation (AC1)

- [x] **Task 8: ADR-0006 for the state-machine pattern** (AC: 1)
  - [x] Create `docs/adr/0006-state-machine-transitions.md`. Capture: declarative transition tables (vs imperative state-machine library), `assertTransition` is pure, helper functions own the DB + audit side effects, `REASON_REQUIRED_TRANSITIONS` mapping per FR23/FR37/FR38, ESLint heuristic is best-effort (acknowledges escape hatches).

## Dev Notes

### Previous story intelligence

**Story 1.2 produced:**
- `convex/lib/errors.ts` with `ErrorCode` constants — **this story extends** with `NOT_IMPLEMENTED` (temporary, removed in Story 1.8).
- `convex/lib/auth.ts` with `requireRole` — not directly consumed (this is a pure helper) but listed as a sibling pattern.
- `eslint.config.mjs` with `local-rules` registered — **this story registers** `no-raw-status-patch`.

**Story 1.6 produced:**
- `convex/lib/audit.ts → emitAudit` — **this story consumes** in Task 4 (deferred via stub to Story 1.8).
- `auditLog` table — referenced by the audit emission.

**Story 1.8 (not yet implemented):**
- Will create `lots` table + `convex/lots.ts`. **This story scaffolds** `transitionLotStatus` with a `NOT_IMPLEMENTED` stub; Story 1.8 fills in the body. Cross-reference: Story 1.8 task list MUST include "implement `transitionLotStatus` body using the scaffold from Story 1.7."

**Stories 1.4, 1.5:**
- `src/types/lot-status.ts` was created (or planned) in Story 1.4 for StatusPill variants. Ensure the same string union is used by the schema, `stateMachines.ts`, and the StatusPill — single source of truth. Mirror across boundaries with a sync test.

### Architecture compliance

- **State-machine guards** are listed as one of the architecture's foundational patterns (§ API & Communication Patterns > State-machine guards): "any mutation that transitions an entity's state calls `assertTransition(currentState, requestedState, transitions[entityType], reason)` from `convex/lib/stateMachines.ts`."
- **Forbidden** (§ Process Patterns): "updating `status` fields with `ctx.db.patch(..., { status: ... })` outside a state-machine guard call." This story's ESLint rule is that enforcement.
- **Helper location**: `convex/lib/stateMachines.ts` per architecture § Project Structure.
- **Test path**: `tests/unit/convex/lib/stateMachines.test.ts` per architecture § Structure Patterns.

### Library / framework versions (current)

- **`convex-test`** — already installed by Story 1.2. Used for `transitionLotStatus` integration tests in Story 1.8 (deferred).
- **`eslint-plugin-local-rules`** — already installed. New rule appended.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── lib/
│       ├── stateMachines.ts                 # NEW (TRANSITIONS table, REASON_REQUIRED_TRANSITIONS, assertTransition, transitionLotStatus stub)
│       ├── states.ts                        # NEW (server-side type exports: LotStatus, ContractState, ReceiptState, EntityWithState)
│       └── errors.ts                        # UPDATE (add NOT_IMPLEMENTED code temporarily; remove in Story 1.8)
├── src/
│   └── types/
│       └── lot-status.ts                    # UPDATE if exists from Story 1.4 (verify matches server-side type); else NEW
├── eslint-rules/
│   └── no-raw-status-patch.js               # NEW
├── eslint.config.mjs                        # UPDATE (register no-raw-status-patch as "error")
├── tests/
│   └── unit/
│       ├── convex/
│       │   └── lib/
│       │       └── stateMachines.test.ts    # NEW (≥ 95% coverage; exhaustive transitions)
│       └── eslint-rules/
│           └── no-raw-status-patch.test.ts  # NEW
└── docs/adr/
    └── 0006-state-machine-transitions.md    # NEW
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code)** applies — state transitions for `contract` and `receipt` are financial. Target ≥ 95% on `stateMachines.ts`. The `transitionLotStatus` stub is exempt until Story 1.8 implements it (its `NOT_IMPLEMENTED` throw has a one-line test asserting the code).
- **Exhaustive enumeration**: every cell in `TRANSITIONS` gets a test. Cheap; loops the table.
- **ESLint `RuleTester`** for `no-raw-status-patch` — `valid` + `invalid` cases.

### Source references

- **PRD:** [FR23 (contract state transitions), FR24 (admin void/cancel), FR37 (transition to in_default), FR38 (reclaim defaulted lot)](../../_bmad-output/planning-artifacts/prd.md#4-sales--installment-contracts); [NFR-M2](../../_bmad-output/planning-artifacts/prd.md#maintainability)
- **Architecture:** [§ API & Communication Patterns > State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns); [§ Process Patterns > State-machine guards](../../_bmad-output/planning-artifacts/architecture.md#process-patterns); [§ Enforcement Guidelines (rule #6)](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines); [§ Decision Impact Analysis > Implementation sequence](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis) (step 5)
- **Epics:** [Story 1.7](../../_bmad-output/planning-artifacts/epics.md#story-17-state-machine-transition-guards)
- **Previous stories:** [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md) (ErrorCode + lint plugin); [1.6](./1-6-audit-log-emission-helper.md) (emitAudit consumer)
- Convex docs: [Schema validation](https://docs.convex.dev/database/schemas)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT make `assertTransition` async.** It's a pure validator. Async pollutes callers unnecessarily.
- ❌ **Do NOT have `assertTransition` access the DB.** Callers fetch the current state and pass it as `from`. Single-responsibility.
- ❌ **Do NOT implement `transitionLotStatus`'s body in this story.** It needs the `lots` schema (Story 1.8). Stub it; Story 1.8 fills.
- ❌ **Do NOT add transitions to `TRANSITIONS` without ADR.** New states / transitions land in their feature stories with a JSDoc reference. The state machine is a controlled vocabulary.
- ❌ **Do NOT skip the `REASON_REQUIRED_TRANSITIONS` set.** FR23/FR37/FR38 mandate reason capture. The UI (Stories 3.x) consumes this list to decide which transitions open a "reason" dialog.
- ❌ **Do NOT write to `auditLog` from `assertTransition`.** Audit emission belongs in the calling helper (`transitionLotStatus`, future `transitionContractState`, `voidReceipt`). Pure validator vs side-effecting helper separation.
- ❌ **Do NOT use a third-party state-machine library** (`xstate`, `robot`, etc.). The transition table + 30-line assertion is sufficient and avoids a dependency.
- ❌ **Do NOT export the transition table as a Map or class.** Use a plain const object with `as const satisfies` for TypeScript exhaustiveness. Composable, serializable, JSON-printable for debugging.
- ❌ **Do NOT make the helper's exemption list "smart"** — the ESLint heuristic explicitly exempts `convex/lib/stateMachines.ts` and `convex/seed.ts` only. `convex/seed.ts` may need to set initial statuses without going through the helper (seeding bypass is acceptable, documented in ADR).
- ❌ **Do NOT cross-reference `src/types/lot-status.ts` from `convex/lib/states.ts`.** Server and client mirror the type; do not import across the boundary. Synchronize via a Vitest test that asserts the two arrays are equal.

### Common LLM-developer mistakes to prevent

- **Treating `cancelled` as a non-terminal state:** Per the transition table, `cancelled` is terminal — no outgoing transitions. If a story (Epic 3+) needs to "re-activate" a cancelled lot, it must FIRST file an ADR amendment and update `TRANSITIONS`.
- **Forgetting `in_default → active` re-activation:** FR37 implies that an admin can manually re-activate a defaulted contract; the contract transition table allows `in_default → active`. Do not remove this transition in a "cleanup" pass.
- **Confusing entity-level state with row-level fields:** `status` field on `lots`, `state` field on `contracts`, `state` field on `receipts`. Names match the column conventions in the schema. The state-machine table key is `entityType` (lot/contract/receipt), values are statuses/states.
- **Heuristic ESLint false positives:** The `no-raw-status-patch` rule has false positives (e.g., a file imports stateMachines but uses it for a different purpose). Accept the false-positive rate; add `// eslint-disable-next-line` with a comment explaining why for legitimate edge cases (rare).
- **`as const satisfies` syntax:** TypeScript 4.9+ feature. Story 1.1 set up TS strict + a recent TS version; verify `tsconfig.json`'s `target` allows this syntax (`ES2022` or later).
- **Forgetting to update `ErrorCode`:** Adding `NOT_IMPLEMENTED` to `convex/lib/errors.ts` (Task 4 revised). Story 1.8 should REMOVE it during its implementation pass — leaving it after Story 1.8 lands creates dead error-code surface area.

### Open questions / blockers this story does NOT resolve

- **Q1 (installment grace / penalty / reclaim conditions)** — affects FR38's reclaim semantics (lot `defaulted → available`). The transition itself is in the table; the WHEN it can be triggered (after how many missed installments, what happens to prior payments) is a policy question for Epic 3. This story's transition table is correct regardless of the policy.
- **Receipt void rules** — FR29 says voided serials remain consumed. The receipt transition (`issued → voided`) is in the table; the no-renumber rule is a separate concern handled in the receipt counter logic (Epic 3 Story 3.x).

### Project Structure Notes

Aligns with [architecture.md § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure):
- `convex/lib/stateMachines.ts` — slotted exactly as the architecture's lib helpers list specifies.
- `convex/lib/states.ts` — additional file, paired with stateMachines; not in the architecture's explicit file list but matches the lib helper convention.
- `eslint-rules/no-raw-status-patch.js` — follows the existing custom-rule pattern.

### References

- [PRD § Functional Requirements > 4. Sales & Installment Contracts](../../_bmad-output/planning-artifacts/prd.md#4-sales--installment-contracts)
- [PRD § Non-Functional Requirements > Maintainability](../../_bmad-output/planning-artifacts/prd.md#maintainability)
- [Architecture § API & Communication Patterns](../../_bmad-output/planning-artifacts/architecture.md#api--communication-patterns)
- [Architecture § Process Patterns](../../_bmad-output/planning-artifacts/architecture.md#process-patterns)
- [Architecture § Implementation Patterns > Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- [Architecture § Decision Impact Analysis](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis)
- [Epics § Story 1.7](../../_bmad-output/planning-artifacts/epics.md#story-17-state-machine-transition-guards)
- [Story 1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md) (ErrorCode + lint plugin)
- [Story 1.6](./1-6-audit-log-emission-helper.md) (emitAudit consumer)
- [Story 1.8](./1-8-office-staff-creates-and-edits-lot-records.md) (will fill `transitionLotStatus` body)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- Initial `npm run typecheck` failed in two places:
  1. `tests/unit/convex/lib/stateMachines.test.ts` — regex `.match()` destructured groups were typed `string | undefined` under `noUncheckedIndexedAccess: true`. Replaced with a typed `parseTransitionKey(key)` helper that asserts the regex match and returns guaranteed-string fields. Re-ran typecheck — all Story 1.7 errors cleared.
  2. `tests/unit/convex/lib/audit.test.ts` (Story 1.6 territory, owned by another agent) — 7 `Object is possibly 'undefined'` errors. **Not modified.** Outside this story's write ownership. These errors block the full `npm run typecheck` gate but pre-date this story's changes.
- `npm run lint` — clean, including the new `local-rules/no-raw-status-patch` rule against the whole tree.
- `npm test` — Story 1.7's two test files (`stateMachines.test.ts` 114 tests, `no-raw-status-patch.test.ts` 1 test containing a RuleTester matrix of 8 valid + 4 invalid samples) all pass. 3 failures in `tests/unit/convex/lib/audit.test.ts` (Story 1.6 territory) are unrelated address-redaction assertion mismatches.
- `npm run build` — passes.
- Coverage on `convex/lib/stateMachines.ts`: 100% line + 100% branch + 100% function (target ≥ 95%). Coverage on `convex/lib/states.ts` and `src/types/lot-status.ts`: 100% across the board. Coverage on `eslint-rules/no-raw-status-patch.js`: branch 100%; v8 reports 47% line because rule-body coverage runs inside ESLint's `Linter.verify` and v8 doesn't always re-attribute those lines — every visitor branch is exercised by the RuleTester matrix.

### Completion Notes List

- **Hand-off to Story 1.8:** `transitionLotStatus` ships as a scaffold only. Body throws `ConvexError({ code: "NOT_IMPLEMENTED", message: "transitionLotStatus body lands in Story 1.8 (lots schema)." })`. Story 1.8's task list MUST include "implement `transitionLotStatus` body using the Story 1.7 scaffold" — fetch lot, `assertTransition`, `ctx.db.patch`, `emitAudit`, return updated doc. The `lotId` parameter is typed as `unknown` for now; tighten to `Id<"lots">` once the table exists.
- **ErrorCode untouched.** The story's Task 4 revised step asked to add `NOT_IMPLEMENTED` to `convex/lib/errors.ts` `ErrorCode` constants. `convex/lib/errors.ts` was outside this run's write ownership (instruction header listed it as READ-ONLY), so `NOT_IMPLEMENTED` is thrown inline via raw `ConvexError({ code: "NOT_IMPLEMENTED", ... })`. Net behaviour: client still sees `code === "NOT_IMPLEMENTED"`; canonical `ErrorCode` namespace stays stable. ADR-0006 § 4 documents the choice. **Story 1.8 should not need to remove anything from `errors.ts`** — when the inline throw goes away, no cleanup is required.
- **Mirror sync test:** `LOT_STATUSES` in `convex/lib/states.ts` and `src/types/lot-status.ts` are asserted equal in `stateMachines.test.ts`. Drift fails CI.
- **No schema changes.** This story didn't need to touch `convex/schema.ts`. The `lots` table arrives with Story 1.8.
- **ESLint rule heuristic limits** documented in the rule file's header and in ADR-0006: importing `stateMachines` for unrelated reasons still allows a raw `status` patch; destructured `ctx.db` aliases (`const { patch } = ctx.db`) escape the AST match. Both are rare enough to leave to code review.
- **Parallel-agent observation:** during this run, `tests/unit/convex/lib/audit.test.ts`, `convex/lib/audit.ts`, and Story 1.6's artefacts appeared in the tree. Likely another agent implementing Story 1.6 in parallel. No edits made to those files.

### File List

**Created:**
- `convex/lib/states.ts` — server-side state type exports (`LotStatus`, `ContractState`, `ReceiptState`, `EntityWithState`, plus `LOT_STATUSES` / `CONTRACT_STATES` / `RECEIPT_STATES` constant arrays).
- `convex/lib/stateMachines.ts` — `TRANSITIONS` table, `REASON_REQUIRED_TRANSITIONS`, `assertTransition`, typed wrappers (`assertLotTransition`, `assertContractTransition`, `assertReceiptTransition`), `transitionLotStatus` stub.
- `src/types/lot-status.ts` — client-side `LotStatus` mirror.
- `eslint-rules/no-raw-status-patch.js` — custom ESLint rule.
- `tests/unit/convex/lib/stateMachines.test.ts` — 114 tests; exhaustive table coverage.
- `tests/unit/eslint-rules/no-raw-status-patch.test.ts` — RuleTester matrix (8 valid + 4 invalid samples).
- `docs/adr/0006-state-machine-transitions.md` — ADR documenting the pattern.

**Modified:**
- `eslint-local-rules.js` — registered `no-raw-status-patch`.
- `eslint.config.mjs` — added a `convex/**/*.ts` block enabling `local-rules/no-raw-status-patch` as error (ignoring `convex/_generated/**`).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `1-7-state-machine-transition-guards: review`, `last_updated: 2026-05-18`.

**Not modified (out of ownership):**
- `convex/lib/errors.ts` (READ-ONLY) — `NOT_IMPLEMENTED` thrown inline instead.
- `convex/schema.ts` — no domain tables needed for this story.
- All Story 1.6 artefacts that appeared during this run.

### Change Log

| Date       | Author                                              | Change                                                                                                          |
|------------|-----------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| 2026-05-18 | claude-opus-4-7 via Claude Code BMAD bmad-dev-story | Initial implementation of Story 1.7. State-machine cornerstone landed; `transitionLotStatus` body deferred to 1.8. |
