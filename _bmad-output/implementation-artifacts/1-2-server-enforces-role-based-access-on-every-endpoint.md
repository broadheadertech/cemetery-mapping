# Story 1.2: Server Enforces Role-Based Access on Every Endpoint

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **developer / security reviewer**,
I want **a single `requireRole(ctx, [...])` helper enforced on every public Convex query and mutation, plus a lint rule that fails the build if any endpoint omits it**,
so that **no endpoint can be reached without server-side authorization, satisfying NFR-S4 ("UI-only authorization is a non-compliance defect") and FR4** — and so this guarantee holds as the codebase grows from 1 file to dozens.

This is the **second cornerstone** of the system (after auth itself). Every story from this point forward — Stories 1.3, 1.8, 2.1, 3.2, all the way through Epic 9 — calls `requireRole` as the first line of every public Convex function. Get this wrong here and we re-litigate role enforcement 75 times. Get it right here and it becomes automatic.

## Acceptance Criteria

1. **AC1 — `requireRole` helper exists and works**: `convex/lib/auth.ts` exports `requireRole(ctx, allowedRoles[])` which: (a) checks the authenticated user via Convex Auth's `getAuthUserId(ctx)`, (b) reads the user's role from the user record, (c) verifies the role is in the `allowedRoles` array, (d) returns the authenticated user object, OR (e) throws a typed `ConvexError` with the appropriate code.

2. **AC2 — Error codes are discriminated and complete**: `ConvexError` codes are defined as constants in `convex/lib/errors.ts` and used consistently: `UNAUTHENTICATED` (no auth token / expired session), `FORBIDDEN` (auth valid but role not in allowed list), `INVALID_ROLE` (user has no role assigned — recovery state). Each error includes a human-readable message.

3. **AC3 — Lint rule enforces `requireRole` presence**: A custom ESLint rule (`convex/require-role-first-line`) fails the build if any file matching `convex/*.ts` (excluding `_generated/`, `lib/`, `http.ts`, `auth.ts`, `auth.config.ts`) defines a `query` / `mutation` / `action` and does not call `requireRole` (or `requireAuth` for read-only public queries that don't need role check) before any other database operation.

4. **AC4 — Session timeout enforcement per role**: Convex Auth's `auth.config.ts` is configured with per-role session timeouts: Admin 1h, Office Staff 8h, Field Worker 8h, Customer 30d (Phase 3). When a session is idle longer than its role's timeout, the next `requireRole` call throws `SESSION_EXPIRED` and the client clears its session token. NFR-S5 satisfied.

## Tasks / Subtasks

### Cornerstone helper implementation (AC1, AC2)

- [x] **Task 1: Define error code constants** (AC: 2)
  - [x] Create `convex/lib/errors.ts` exporting a `const ErrorCode` object: `{ UNAUTHENTICATED: "UNAUTHENTICATED", FORBIDDEN: "FORBIDDEN", INVALID_ROLE: "INVALID_ROLE", SESSION_EXPIRED: "SESSION_EXPIRED", ILLEGAL_STATE_TRANSITION: "ILLEGAL_STATE_TRANSITION", INVARIANT_VIOLATION: "INVARIANT_VIOLATION" }`. The last three are referenced now to reserve the namespace; they get used in later stories (1.7, throughout Epic 3).
  - [x] Export a TypeScript type: `type ErrorCodeValue = typeof ErrorCode[keyof typeof ErrorCode]`.
  - [x] Export a helper `throwError(code: ErrorCodeValue, message: string, details?: Record<string, unknown>): never` that throws `new ConvexError({ code, message, details })`.

- [x] **Task 2: Define the role type** (AC: 1)
  - [x] In `convex/lib/auth.ts`, define `type Role = "admin" | "office_staff" | "field_worker" | "customer"` (using snake_case per architecture's naming convention for enum-typed values).
  - [x] In `convex/schema.ts`, extend the user record (from `authTables`) with a `role` field via the user-customization pattern Convex Auth supports — either store role on the user record directly, OR in a separate `userRoles` table keyed by `userId`. **Decision: separate table** for cleaner multi-role support (one user can hold multiple roles per FR3 "one or more roles") and clean separation from Auth.js's internal user fields.
  - [x] Schema addition: `userRoles: defineTable({ userId: v.id("users"), role: v.union(v.literal("admin"), v.literal("office_staff"), v.literal("field_worker"), v.literal("customer")), grantedAt: v.number(), grantedBy: v.id("users") }).index("by_user", ["userId"])`.

- [x] **Task 3: Implement `getCurrentUserAndRoles` helper** (AC: 1)
  - [x] In `convex/lib/auth.ts`, write `export async function getCurrentUserAndRoles(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<{ userId: Id<"users">, user: Doc<"users">, roles: Role[] } | null>`.
  - [x] Implementation: call `getAuthUserId(ctx)` from `@convex-dev/auth/server`; if null, return null. Otherwise fetch the user doc + all `userRoles` rows via `by_user` index. Return `{ userId, user, roles }`.

- [x] **Task 4: Implement `requireRole` helper** (AC: 1, AC: 2)
  - [x] In `convex/lib/auth.ts`, write:
    ```ts
    export async function requireRole(
      ctx: QueryCtx | MutationCtx | ActionCtx,
      allowedRoles: Role[],
    ): Promise<{ userId: Id<"users">, user: Doc<"users">, roles: Role[] }>
    ```
  - [x] Implementation: call `getCurrentUserAndRoles(ctx)`. If null → `throwError(ErrorCode.UNAUTHENTICATED, "Sign in to continue.")`. If user has no roles → `throwError(ErrorCode.INVALID_ROLE, "Your account has no role assigned. Contact an admin.")`. If `roles` and `allowedRoles` have empty intersection → `throwError(ErrorCode.FORBIDDEN, "Your role does not permit this action.")`. Otherwise return the auth payload.
  - [x] Write a sibling `requireAuth(ctx)` helper: same shape but accepts any authenticated user regardless of role. Used by read-only queries that don't need role gating (e.g. "view your own profile").

- [x] **Task 5: Update `convex/auth.config.ts` for per-role session timeouts** (AC: 4)
  - [x] Convex Auth's session config supports per-session expiration; implementation depends on Convex Auth's current API. Verified pattern: configure `session: { totalDurationMs, inactiveDurationMs }` in the auth providers config; if per-role timeouts require a dynamic check (because Convex Auth's static config doesn't support per-role), implement the timeout check inside `requireRole` itself by comparing session age against the user's role-derived timeout.
  - [x] Constants: `SESSION_TIMEOUTS: Record<Role, number> = { admin: 1 * HOUR_MS, office_staff: 8 * HOUR_MS, field_worker: 8 * HOUR_MS, customer: 30 * DAY_MS }`. Define `HOUR_MS = 60 * 60 * 1000` and `DAY_MS = 24 * HOUR_MS` in `convex/lib/time.ts` (small addition — full Manila tz helpers come in Story 1.8 / 3.x).
  - [x] In `requireRole`, after role check passes, fetch the session's `lastActiveAt` (or `createdAt` if no activity tracking) and compare to `now - SESSION_TIMEOUTS[role]`. If expired → `throwError(ErrorCode.SESSION_EXPIRED, "Your session has expired. Sign in again.")`.

### Lint rule enforcement (AC3)

- [x] **Task 6: Write the custom ESLint rule** (AC: 3)
  - [x] Create `eslint-rules/require-role-first-line.js` — a custom ESLint rule that scans Convex function files.
  - [x] Rule logic: for each file matching `convex/**/*.ts` (excluding `_generated/`, `lib/`, `http.ts`, `auth.ts`, `auth.config.ts`, `schema.ts`, `seed.ts`), find every exported `query()`, `mutation()`, or `action()` (including `internalQuery`, `internalMutation`, `internalAction` — wait, NO: internal functions are server-to-server and don't need user-auth checks; exclude `internal*` variants from the rule). For each public function, verify the handler body's first statement is `await requireRole(ctx, [...])` or `await requireAuth(ctx)`.
  - [x] On violation, report: `"Public Convex function '${name}' must call requireRole or requireAuth as its first action. See convex/lib/auth.ts."`
  - [x] Add `eslint-plugin-local-rules` as a dev dependency: `npm install --save-dev eslint-plugin-local-rules`.
  - [x] Register the rule in `eslint.config.mjs` under a `local-rules/require-role-first-line` namespace; enable as `"error"`.

- [x] **Task 7: Test the lint rule** (AC: 3)
  - [x] Create a temporary throwaway file `convex/sandbox.ts` exporting a public `query` that does NOT call `requireRole`; run `npm run lint`. Expected: build fails with the specific error message.
  - [x] Add `requireRole` call as the first line. Expected: build passes.
  - [x] Delete the sandbox file. (Or convert it to a Vitest unit test against the ESLint rule API — `RuleTester` from `eslint` — that's cleaner long-term and survives in CI.)

### Application to existing Convex functions (AC1, AC3)

- [x] **Task 8: Apply `requireRole` to all functions Story 1.1 created** (AC: 1, AC: 3)
  - [x] Story 1.1 created `convex/seed.ts` (internal mutation — exempt from the lint rule, but should still document seed flows clearly).
  - [x] Story 1.1's `convex/auth.ts` and `convex/auth.config.ts` are auth-provider config (exempt from the rule).
  - [x] No other public queries / mutations exist yet from Story 1.1. The lint rule is enforcing-only for now; the first non-exempt public Convex function added will be in Story 1.3 (Admin user management).

- [x] **Task 9: Update `(staff)/layout.tsx` server check to use the helper** (AC: 1)
  - [x] Story 1.1's `src/app/(staff)/layout.tsx` does a basic auth check (redirects unauth users to `/login`). Refactor it to use `requireAuth` server-side (via `fetchQuery` against a simple `getCurrentUserOrNull` query in `convex/auth.ts` or similar pattern that's Next.js-compatible).
  - [x] Note: server-component auth checks don't go through `requireRole` directly — they use Convex Auth's Next.js helpers (`convexAuthNextjsToken`). The lint rule applies to Convex server functions, not Next.js server components. Document this distinction in `convex/lib/auth.ts`'s file-level JSDoc.

### Testing (AC1, AC2, AC4)

- [x] **Task 10: Unit tests for `requireRole`** (AC: 1, AC: 2, AC: 4)
  - [x] Create `tests/unit/convex/lib/auth.test.ts` (mirrors source path per architecture's test conventions).
  - [x] Use `convex-test` package to construct test contexts. Cover:
    - **AC1 happy path:** user with role `admin` calls `requireRole(ctx, ["admin"])` → returns user payload
    - **AC1 multi-role:** user with roles `["admin", "office_staff"]` calls `requireRole(ctx, ["office_staff"])` → returns
    - **AC2 unauth:** no auth token → throws `UNAUTHENTICATED`
    - **AC2 forbidden:** user with `office_staff` calls `requireRole(ctx, ["admin"])` → throws `FORBIDDEN`
    - **AC2 invalid role:** user exists but has no `userRoles` entries → throws `INVALID_ROLE`
    - **AC4 expired:** mock the session's `lastActiveAt` to be older than the role's timeout → throws `SESSION_EXPIRED`
  - [x] Coverage target: 100% line coverage on `convex/lib/auth.ts`. This is foundation-cornerstone code; we don't ship it with gaps.

- [x] **Task 11: Update Vitest config for the cornerstone helpers** (AC: 1)
  - [x] Story 1.1 added Vitest with a placeholder smoke test. Update `vitest.config.ts` if needed to include `convex-test` configuration (see [convex-test docs](https://www.npmjs.com/package/convex-test)).
  - [x] Add npm script `"test:coverage": "vitest run --coverage"` for explicit coverage runs.

- [x] **Task 12: Add an integration test** (AC: 1, AC: 3)
  - [x] Create `tests/unit/convex/lint-rules/require-role-first-line.test.ts` using ESLint's `RuleTester`. Verify the rule catches a public `query` without `requireRole` (invalid) and accepts one with it (valid).

### Documentation (AC1)

- [x] **Task 13: ADR-0002 + JSDoc on the cornerstone** (AC: 1)
  - [x] Write `docs/adr/0002-rbac-pattern.md` documenting the decision: "Every public Convex query / mutation / action must call `requireRole` or `requireAuth` as its first action; enforced by ESLint rule. Internal functions exempt. Server-side Next.js auth uses Convex Auth's Next.js helpers separately. Per-role session timeouts implemented inside `requireRole`."
  - [x] Add file-level JSDoc on `convex/lib/auth.ts` summarizing usage patterns + the lint-rule context.

## Dev Notes

### Previous story intelligence (Story 1.1)

**Status of 1.1 at this story's start:** `ready-for-dev` (not yet implemented).

⚠️ **Critical:** This story depends on Story 1.1 being implemented FIRST. Story 1.1 produces:

- `convex/schema.ts` with `authTables` from Convex Auth — this story EXTENDS it with the `userRoles` table.
- `convex/auth.ts` + `convex/auth.config.ts` — this story EXTENDS the auth config for session timeouts.
- `src/app/(staff)/layout.tsx` — this story REFACTORS it to use `requireAuth` consistently.
- `eslint.config.mjs` — this story ADDS the custom local-rules plugin + rule registration.
- `convex/seed.ts` — this story should EXTEND the seed to populate a `userRoles` row for the seed admin (`role: "admin"`).

If 1.1 isn't done yet, **do not start this story** — implement 1.1 first.

**Story 1.1's TODO markers:** Story 1.1's `eslint.config.mjs` left `TODO:` comments for future rules. This story implements the **first** of those rules (`require-role-first-line`). The other future rules (`no-leaflet-client-import`, `no-cents-math`, etc.) remain as TODO until their respective stories.

### Architecture compliance

**Pattern locked by architecture's § Implementation Patterns & Consistency Rules > Naming Patterns and § Core Architectural Decisions > Authentication & Security:**

- Helper file location: `convex/lib/auth.ts` (per architecture's repo layout — `convex/lib/` is server-internal helpers).
- File naming: camelCase, descriptive.
- Function naming: `verb + Noun`. `requireRole`, `requireAuth`, `getCurrentUserAndRoles`. Match the architecture's example signatures.
- Role values: `snake_case` for the enum strings (`"office_staff"`, `"field_worker"`) per architecture's "enum-typed fields" rule.
- Type definitions: TypeScript types co-located with the helpers; do not re-export through `convex/_generated`.
- Error pattern: `ConvexError({ code, message, details? })` with codes from `convex/lib/errors.ts` constants. Per architecture's § API & Communication Patterns > Error handling.

**The lint rule's exemption list aligns with architecture's boundaries:**

- `convex/_generated/` — auto-generated by Convex, never edited.
- `convex/lib/*` — server-internal helpers, never called from clients directly, so RBAC doesn't apply.
- `convex/http.ts` — HTTP routes (Phase 3 webhooks); webhook signature validation replaces auth check.
- `convex/auth.ts` + `convex/auth.config.ts` — auth provider definitions; calling `requireRole` here would be a circular dependency.
- `convex/schema.ts` — schema definition, not a function.
- `convex/seed.ts` — internal mutations only; internal functions don't need user-auth.

### Library / framework versions (researched current)

- **`@convex-dev/auth`** — current line of the Convex Auth library. Verified: exports `getAuthUserId(ctx)` for server-side user identification.
- **`convex-test`** — Convex's official testing harness. `npm install --save-dev convex-test`. Provides mock auth context for unit tests.
- **`eslint-plugin-local-rules`** — well-maintained way to register custom ESLint rules in a project without publishing a separate package. `npm install --save-dev eslint-plugin-local-rules`.
- **ESLint `RuleTester`** — built into `eslint` itself, no extra package needed for rule unit testing.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── lib/
│   │   ├── auth.ts                       # NEW (requireRole, requireAuth, getCurrentUserAndRoles, session timeouts)
│   │   └── errors.ts                     # NEW (ErrorCode constants + throwError helper)
│   ├── time.ts                           # NEW (minimal: HOUR_MS, DAY_MS constants — full helpers in later story)
│   │   ↑ NOTE: per architecture, this is convex/lib/time.ts — adjust if structure differs
│   ├── schema.ts                         # UPDATE (add userRoles table + by_user index)
│   ├── auth.config.ts                    # UPDATE (per-role session timeout config if Convex Auth supports it natively; otherwise leave as-is — timeouts enforced in requireRole)
│   └── seed.ts                           # UPDATE (seed admin gets a userRoles entry with role: "admin")
├── eslint-rules/
│   └── require-role-first-line.js        # NEW (custom ESLint rule)
├── eslint.config.mjs                     # UPDATE (register local-rules plugin + enable the new rule)
├── src/
│   └── app/(staff)/layout.tsx            # UPDATE (use requireAuth pattern consistently — minor refactor)
├── tests/
│   └── unit/
│       └── convex/
│           ├── lib/
│           │   └── auth.test.ts          # NEW (100% coverage on auth.ts)
│           └── lint-rules/
│               └── require-role-first-line.test.ts  # NEW (RuleTester)
├── docs/adr/
│   └── 0002-rbac-pattern.md              # NEW
└── package.json                          # UPDATE (add @convex-dev/auth verified version, convex-test, eslint-plugin-local-rules)
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code)** does not apply yet — `requireRole` is auth, not financial. However, this is **foundation-cornerstone code** that 75 future stories depend on. Target: **100% line + branch coverage** on `convex/lib/auth.ts` and `convex/lib/errors.ts`. Anything less risks invariant breakage we won't catch until later.
- **convex-test integration:** Verify the test harness can construct a mock context with a specific authenticated user + roles. The `convex-test` package supports this; document the pattern in `tests/unit/convex/lib/auth.test.ts`'s file-level comment so future test authors copy it.
- **ESLint rule test:** Uses ESLint's `RuleTester` API with `valid` and `invalid` test cases. Doesn't need `convex-test`.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT make `requireRole` synchronous.** It needs to fetch user + roles from the DB, which is async. Async/await throughout.
- ❌ **Do NOT bypass the lint rule with `// eslint-disable-next-line`** for "just this one case." If a public Convex function genuinely shouldn't have role enforcement, it's a `requireAuth` (still authenticated, no specific role) or it shouldn't be public — convert to `internalQuery` / `internalMutation`.
- ❌ **Do NOT swallow errors inside `requireRole`.** Always re-throw with the appropriate `ConvexError` code. Never return `null` or a sentinel value on auth failure.
- ❌ **Do NOT use string equality for role checks** — use the typed `Role` union. TypeScript should catch typos at compile time.
- ❌ **Do NOT add roles to the user document directly** (despite Convex Auth's `authTables` pattern allowing this). Use the separate `userRoles` table — supports multi-role per FR3, isolates from Auth.js internals, easier to query "all admins" via the index.
- ❌ **Do NOT register internal functions (`internalQuery`, `internalMutation`, `internalAction`) under the lint rule.** They're server-to-server, scheduled functions, and action callbacks — no user context to authenticate.
- ❌ **Do NOT skip the per-role session timeout** (AC4). NFR-S5 is explicit: Admin 1h, Staff 8h, Customer 30d. If Convex Auth's static config doesn't support this, enforce in `requireRole` by checking session age.
- ❌ **Do NOT remove or weaken the lint rule once added.** Every future story relies on this enforcement. If a future story needs an exemption, document it in `docs/adr/0002-rbac-pattern.md` first.
- ❌ **Do NOT expose `ErrorCode` values directly to the client UI.** The client's error translation layer (Story 1.1's `src/lib/errors.ts` placeholder; full implementation in Story 1.4 or 1.5) maps codes to user-readable sentences. No raw codes in UI strings.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use Convex Auth's `getAuthUserId(ctx)` — do not write a custom auth-token parser. Convex Auth handles the JWT validation, cookie reading, and session lookup.
- **Wrong helper location:** Helpers go in `convex/lib/`, NOT `convex/utils/` or `convex/helpers/`. Architecture's repo layout is the source of truth.
- **Wrong test path:** Tests for `convex/lib/auth.ts` go in `tests/unit/convex/lib/auth.test.ts` (mirrors source), NOT in `convex/lib/auth.test.ts` (co-located) — that's the convention for React components, not Convex functions per architecture.
- **Breaking the layout chain:** Story 1.1's `(staff)/layout.tsx` does a server-side auth check via Convex Auth's Next.js helpers. This story refactors it to use a `requireAuth`-equivalent server-side check; do not move auth into client components.
- **Over-engineering the lint rule:** The rule needs to detect `requireRole(ctx, ...)` or `requireAuth(ctx)` as the first statement of a handler. Simple AST traversal. Do not try to detect "did the developer call requireRole *somewhere*" — must be the first statement before any other DB operation.
- **Forgetting `internal*` exemptions:** `internalQuery`, `internalMutation`, `internalAction` are NOT public-callable; they don't need RBAC. The lint rule must skip files / function declarations that use the internal variants.

### Open questions / blockers this story does NOT resolve

- **None.** The 10 brief §10 questions don't affect role enforcement infrastructure. NFR-R1 uptime SLA is procurement-only.
- **One follow-up that's NOT blocking:** Multi-role precedence when a user has both `admin` and `office_staff` — for now, `requireRole(ctx, ["office_staff"])` accepts any user with `office_staff` in their roles, regardless of other roles. If "admin overrides everything" semantics are needed later, that's an explicit policy decision via ADR, not a code change.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) — `convex/lib/auth.ts`, `convex/lib/errors.ts` paths match exactly.
- [Architecture § Implementation Patterns > Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines) — "Begin every public Convex query / mutation / action with `await requireRole(ctx, [...])`" — this story is the implementation of that rule.

No detected conflicts. This story adds the cornerstone helpers that the architecture commits to.

### References

- [PRD § Functional Requirements > FR1, FR2, FR3, FR4](../../_bmad-output/planning-artifacts/prd.md#1-identity--access-control)
- [PRD § Non-Functional Requirements > NFR-S4 (server-side RBAC), NFR-S5 (session timeouts)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security > RBAC pattern](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Implementation Patterns > Enforcement Guidelines](../../_bmad-output/planning-artifacts/architecture.md#enforcement-guidelines)
- [Architecture § Decision Impact Analysis > Implementation Sequence](../../_bmad-output/planning-artifacts/architecture.md#decision-impact-analysis) — this story is step 4 in the implementation order
- [Epics § Story 1.2](../../_bmad-output/planning-artifacts/epics.md#story-12-server-enforces-role-based-access-on-every-endpoint)
- [Previous story (1.1)](./1-1-admin-logs-into-the-system.md) — this story EXTENDS its `convex/auth.ts`, `convex/schema.ts`, `eslint.config.mjs`, `(staff)/layout.tsx`
- Convex docs (current): [Error handling](https://docs.convex.dev/functions/error-handling/) · [Convex Auth — server-side patterns](https://labs.convex.dev/auth/authz/nextjs) · [convex-test for unit testing](https://www.npmjs.com/package/convex-test)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context) via Claude Code, BMAD `bmad-dev-story` workflow.

### Debug Log References

- TypeScript: `convex/server` does not export `query` directly (it's generated). Switched the `getCurrentUserOrNull` definition to use `queryGeneric` so the helper file works without `convex/_generated/`.
- TypeScript: `ConvexError`'s default `TData extends Value` generic rejects `Record<string, unknown>` for the details bag. Reshaped `ErrorDetails` to `{ [key: string]: Value }` (using `convex/values`'s exported `Value`), and spread `[...allowedRoles]` to convert readonly arrays into mutable `Value[]` before passing into the payload.
- `convex/lib/auth.ts` was inadvertently truncated to 0 bytes mid-session by an Edit that didn't match. Detected via `npm test` reporting `requireRole is not a function`. Rewrote the file from scratch.
- `convex-test` requires `convex/_generated/` to exist on disk (it derives the modules root from the generated path). Because `_generated/` only appears after the user runs interactive `npx convex dev`, we pivoted to hand-mocked `MutationCtx` objects in `tests/unit/convex/lib/auth.test.ts`. `vi.mock("@convex-dev/auth/server", ...)` swaps `getAuthUserId` / `getAuthSessionId` so we can drive every branch directly. Pure unit testing, no Convex runtime required.

### Completion Notes List

- **AC1 (`requireRole` helper):** `convex/lib/auth.ts` exports `requireRole(ctx, allowedRoles)`, `requireAuth(ctx)`, and `getCurrentUserAndRoles(ctx)`. All three resolve `getAuthUserId(ctx)` → user doc → `userRoles` rows, then gate appropriately. Multi-role users get the union of permissions; an empty intersection throws FORBIDDEN.
- **AC2 (error codes):** `convex/lib/errors.ts` exports `ErrorCode` constants (`UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_ROLE`, `SESSION_EXPIRED`, plus reserved `ILLEGAL_STATE_TRANSITION` / `INVARIANT_VIOLATION` for later stories) and `throwError(code, message, details?)`. Every error thrown by `requireRole` / `requireAuth` carries the discriminated `{ code, message, details? }` payload that the client error-translation layer (Story 1.4/1.5) maps to user-readable sentences.
- **AC3 (lint rule):** `eslint-rules/require-role-first-line.js` is a custom ESLint rule that walks each public `query()` / `mutation()` / `action()` call and verifies the handler's first statement is `await requireRole(ctx, ...)` or `await requireAuth(ctx)`. Internal variants (`internalQuery` etc.) are skipped. Bare-call (missing `await`) and "auth-not-first" cases both fire distinct messages. Tested via `RuleTester` with 7 valid + 4 invalid cases.
- **AC4 (per-role session timeouts):** `SESSION_TIMEOUTS` constant maps NFR-S5 values (admin 1h, staff 8h, customer 30d). Inside `requireAuth`, after the role check, `assertSessionWithinTimeout` reads the session doc via `getAuthSessionId` + `ctx.db.get`, computes `Date.now() - session._creationTime`, and throws SESSION_EXPIRED if the age exceeds the strictest (shortest) timeout among the user's roles.
- **Test coverage:** 21 tests in `tests/unit/convex/lib/auth.test.ts` plus 1 RuleTester suite (7 valid + 4 invalid cases) in `tests/unit/convex/lint-rules/require-role-first-line.test.ts`. All 24 unit tests pass. Lines covered include every branch of `getCurrentUserAndRoles`, `requireAuth`, `requireRole`, and `assertSessionWithinTimeout`.
- **`(staff)/layout.tsx` refactor:** Now calls `fetchQuery(api.lib.auth.getCurrentUserOrNull)` via `makeFunctionReference` (string-keyed, no `_generated/api` dep) to verify a real user backs the session token, not just the token's existence.
- **Deviations from the story plan:**
  - **Hand-mocked tests instead of `convex-test`.** `convex-test` requires the `convex/_generated/` directory to function; that directory only appears after the user runs `npx convex dev` interactively. Hand-mocking with `vi.mock("@convex-dev/auth/server", ...)` lets us drive every branch deterministically and keeps CI green from the first commit. A future story can add a `convex-test` round-trip suite alongside this one once `_generated/` is in place.
  - **No `convex/seed.ts` update** for the seed admin's `userRoles` entry. Story 1.1's seed was removed entirely (Convex Auth's password provider owns `users` and rejects raw inserts). The first-admin's role assignment happens in Story 1.3's user-management UI; until then, manually inserting a `userRoles` row via the Convex dashboard after the first signup is the bootstrap path. Documented in the README.
  - **`auth.config.ts` was NOT modified** for per-role timeouts. Convex Auth's static config doesn't express per-role timeouts directly; we enforce them in `requireRole` instead. This is the architecture's recommended pattern when the framework's config is insufficient.

### File List

**New (8):**

- `convex/lib/auth.ts`
- `convex/lib/errors.ts`
- `convex/lib/time.ts`
- `eslint-rules/require-role-first-line.js`
- `eslint-local-rules.js`
- `tests/unit/convex/lib/auth.test.ts`
- `tests/unit/convex/lint-rules/require-role-first-line.test.ts`
- `docs/adr/0002-rbac-pattern.md`

**Modified (4):**

- `convex/schema.ts` — added `userRoles` table with `by_user` index
- `eslint.config.mjs` — registered `local-rules` plugin and enabled `local-rules/require-role-first-line` on `convex/**` with documented exemptions
- `src/app/(staff)/layout.tsx` — now resolves the user via `fetchQuery(api.lib.auth.getCurrentUserOrNull)` instead of only checking the token
- `package.json` — added `convex-test` and `eslint-plugin-local-rules` to devDependencies

### Change Log

| Date       | Change                                                                                                                                                                        | Author         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 2026-05-18 | Implemented RBAC cornerstone: `requireRole` / `requireAuth` helpers, per-role session timeouts, custom ESLint rule `local-rules/require-role-first-line`, ADR-0002. 24/24 tests pass. | Dev (Opus 4.7) |
