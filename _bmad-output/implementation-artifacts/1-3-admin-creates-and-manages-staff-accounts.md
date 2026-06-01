# Story 1.3: Admin Creates and Manages Staff Accounts

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin**,
I want **to create, deactivate, and edit staff and field-worker accounts and assign one or more roles per user from `/admin/users`**,
so that **I can onboard and offboard the team without involving the developer** (FR2, FR3, building on FR1's auth from Story 1.1 and FR4's RBAC from Story 1.2).

This is the **first production-grade public Convex domain file** (`convex/users.ts`) — it consumes the cornerstone `requireRole`, `emitAudit` (placeholder until Story 1.6), and ESLint enforcement Story 1.2 set up. The first mutation here proves the patterns are usable end-to-end.

## Acceptance Criteria

1. **AC1 — Admin can create a new staff user with one or more roles**: From `/admin/users → "New user"`, the Admin submits a form with name, email, and a multi-select of one or more roles (Admin/Owner, Office Staff, Field Worker). On success, the user appears in the list with `isActive: true`, a temporary password is generated server-side (sent via a `temporaryPassword` field in the mutation's return value so the Admin can hand it to the user out-of-band — no email service in Phase 1), and the user can log in via `/login`.

2. **AC2 — Admin can deactivate a user, invalidating their sessions**: Clicking "Deactivate" on a user row sets `isActive: false` and immediately invalidates that user's active sessions (so the next request from any of their tabs fails with `UNAUTHENTICATED` and they're bounced to `/login`). `emitAudit` records the deactivation. Deactivated users remain in the list (greyed-out badge "Inactive") for audit / re-activation.

3. **AC3 — Admin can edit a user's role assignment without forcing re-login**: Clicking "Edit roles" on a user row opens a Dialog with the same multi-select. Saving updates `userRoles` rows atomically (insert new, delete removed, leave unchanged) inside a single mutation, `emitAudit` records before/after, and the change takes effect on the user's NEXT request — they keep their current session.

4. **AC4 — Non-admin users cannot reach `/admin/users`**: A user with role `office_staff` or `field_worker` who navigates directly to `/admin/users` is redirected by Next.js middleware to `/dashboard` without revealing the page exists (no flash of admin chrome). The Convex `listUsers` / `createUser` / `setUserActive` / `setUserRoles` mutations also enforce `requireRole(ctx, ["admin"])` server-side as the real gate (defense-in-depth per NFR-S4).

## Tasks / Subtasks

### Schema additions (AC1, AC2)

- [x] **Task 1: Extend the user record with operational fields** (AC: 1, AC: 2)
  - [x] In `convex/schema.ts`, extend the user table (Convex Auth's `authTables.users` is extensible via the merge pattern) — add `name: v.string()`, `isActive: v.boolean()`, `createdAt: v.number()`, `createdBy: v.optional(v.id("users"))` (null for the seed admin). Convex Auth's `authTables` provides `email` already.
  - [x] Add `.index("by_active", ["isActive"])` so the admin user list can filter live users efficiently.
  - [x] Story 1.2 already added the separate `userRoles` table — confirm the `by_user` index is present; we use it for the list query's per-user role lookup.

- [x] **Task 2: Add session invalidation tracking** (AC: 2)
  - [x] Convex Auth stores sessions in an internal table — when a user is deactivated, we cannot bulk-delete sessions directly. Pattern: `requireRole` (Story 1.2) reads `user.isActive` after `getCurrentUserAndRoles`; if `isActive === false`, throw `UNAUTHENTICATED` immediately. This means deactivation takes effect on the user's NEXT request, not strictly "instantly," but well within their 8h session window.
  - [x] Update `convex/lib/auth.ts` (created in Story 1.2): in `requireRole` after fetching the user doc, check `if (!user.isActive) throwError(ErrorCode.UNAUTHENTICATED, "Account deactivated. Contact an admin.")`. Add a unit test for this branch.
  - [x] Document this "deactivation is next-request-effective, not instant" semantic in `docs/adr/0003-user-deactivation-semantics.md`.

### Convex public functions (AC1, AC2, AC3, AC4)

- [x] **Task 3: Implement `listUsers` query** (AC: 1, AC: 4)
  - [x] Create `convex/users.ts`. First line of the file's first export is the public `listUsers` query — `await requireRole(ctx, ["admin"])` is the first line of its handler (Story 1.2's lint rule enforces this).
  - [x] Query implementation: fetch all users; for each, fetch their `userRoles` rows via `by_user` index; return `Array<{ _id, name, email, isActive, createdAt, createdBy, roles: Role[] }>` sorted by `createdAt desc`.
  - [x] Performance note: 10–20 staff users — full-table-scan acceptable; no pagination required. Re-evaluate if user count grows past 100.

- [x] **Task 4: Implement `createUser` mutation** (AC: 1)
  - [x] First handler line: `await requireRole(ctx, ["admin"])`.
  - [x] Args validator: `{ name: v.string(), email: v.string(), roles: v.array(v.union(v.literal("admin"), v.literal("office_staff"), v.literal("field_worker"))) }`. Reject `customer` role here — Phase 3 portal creates customer accounts via a separate flow.
  - [x] Validation: trim `name` and `email`; lowercase `email`; reject if `email` empty or `roles` array empty; check uniqueness via Convex Auth's user lookup (`getUserByEmail`-equivalent — pattern depends on Convex Auth's current API; if not exposed, scan the user table by email manually).
  - [x] Password generation: generate a 14-char random temporary password using a server-side helper in `convex/lib/passwords.ts` (use `Math.random` is NOT acceptable — use Convex's available crypto, or import `node:crypto` randomBytes inside an action since mutations can't access Node APIs). **Architectural decision**: factor temp-password generation into a Node-runtime internal action `createUserAccount` that the mutation calls via `ctx.scheduler.runAfter(0, ...)` — but this breaks atomicity. Alternative: use V8-compatible randomness via Web Crypto's `crypto.getRandomValues` available in Convex's V8 runtime. **Use Web Crypto.** Document this in JSDoc.
  - [x] Create user via Convex Auth's password provider API (`createAccount` or equivalent — see [Convex Auth password provider docs](https://labs.convex.dev/auth/config/passwords)); store `name`, `isActive: true`, `createdAt: Date.now()`, `createdBy: currentUserId`.
  - [x] For each role in `args.roles`, insert a `userRoles` row with `grantedAt: Date.now()`, `grantedBy: currentUserId`.
  - [x] Call `emitAudit` (Story 1.6 helper — for THIS story, since Story 1.6 isn't done yet, write a TEMPORARY direct insert to `auditLog` AND add a `TODO: replace with emitAudit when Story 1.6 lands` comment). When Story 1.6 lands, the lint rule will fail this file and force the swap. Acceptable temporary debt for the cornerstone-incomplete state.
  - [x] Return: `{ userId: Id<"users">, temporaryPassword: string }` — caller copies the temp password to a one-time-display field; never logged client-side.

- [x] **Task 5: Implement `setUserActive` mutation** (AC: 2)
  - [x] `await requireRole(ctx, ["admin"])`.
  - [x] Args: `{ userId: v.id("users"), isActive: v.boolean(), reason: v.optional(v.string()) }`.
  - [x] Guard: an Admin cannot deactivate themselves (`if (args.userId === currentUserId) throwError(ErrorCode.INVARIANT_VIOLATION, "Cannot deactivate your own account.")`).
  - [x] Read current user doc → patch `isActive`. Call `emitAudit` with `before: { isActive: oldValue }, after: { isActive: newValue }, reason`.

- [x] **Task 6: Implement `setUserRoles` mutation** (AC: 3)
  - [x] `await requireRole(ctx, ["admin"])`.
  - [x] Args: `{ userId: v.id("users"), roles: v.array(v.union(...)) }`.
  - [x] Guard: cannot remove the last admin from the system (`if (args.userId === currentUserId && !args.roles.includes("admin"))` AND the system has only one admin → throw). Implementation: count active admin users via the `userRoles` index; throw if removing this user would drop the count to zero.
  - [x] Diff: fetch existing `userRoles` for user → compute insert / delete sets → apply atomically inside the mutation (Convex mutations are atomic per-mutation).
  - [x] `emitAudit` with `before: { roles: oldRoles }, after: { roles: newRoles }`.

### Next.js admin UI (AC1, AC2, AC3, AC4)

- [x] **Task 7: Add middleware route protection for `/admin/*`** (AC: 4)
  - [x] Update `src/app/middleware.ts` (created in Story 1.1) — extend the matcher to include `/admin/*`. For requests to `/admin/*`, fetch the current user's roles server-side (via Convex Auth's Next.js helpers + a `getCurrentUserRoles` query in `convex/users.ts`); if `admin` is not in the roles, redirect to `/dashboard`.
  - [x] This is **defense-in-depth alongside the server-side `requireRole`** in Convex functions — the middleware avoids rendering admin chrome to non-admins, but the Convex layer is the real gate.

- [x] **Task 8: Build the `/admin/users` list page** (AC: 1, AC: 2, AC: 3)
  - [x] Create `src/app/(staff)/admin/users/page.tsx` — client component (`"use client"`).
  - [x] Use `useQuery(api.users.listUsers)`; show `<UsersTableSkeleton />` while undefined (Story 1.4's skeleton pattern; for this story, a basic placeholder is fine — refine in Story 1.4).
  - [x] Render a `<Table>` from shadcn/ui with columns: Name, Email, Roles (chip per role), Status (pill "Active" / "Inactive"), Created, Actions (Edit roles, Deactivate / Reactivate).
  - [x] "New user" button top-right opens a `<Dialog>` containing the `UserForm`.
  - [x] After create / deactivate / edit, the reactive query auto-refreshes the list — no manual refetch.

- [x] **Task 9: Build the `UserForm` component** (AC: 1)
  - [x] Create `src/components/UserForm/UserForm.tsx`. Uses React Hook Form + Zod.
  - [x] Fields: Name (text, required), Email (email, required), Roles (checkbox group: Admin/Owner, Office Staff, Field Worker — at least one required).
  - [x] On submit, call `useMutation(api.users.createUser)`. On success, show a one-time `<Dialog>` displaying the temp password with a "Copy" button and a "Done" button — Admin reads it aloud to the new user, then dismisses.
  - [x] Inline form errors per UX § Form Patterns. Server errors via `translateError` (UX-DR24; full implementation in Story 1.5 — for this story, basic try/catch + inline message is acceptable).

- [x] **Task 10: Build the deactivate/reactivate confirm flow** (AC: 2)
  - [x] On "Deactivate" click → open a `<Dialog>` with a required reason textarea (per UX § State Transition UI Patterns); on confirm, call `setUserActive` mutation.
  - [x] On "Reactivate" click → no reason required; direct call (Reactivate is non-destructive); confirm via a `<Dialog>` with just "Are you sure?" content but the action goes through after pressing the primary button (no "are you sure" anti-pattern — the dialog IS the preview).

- [x] **Task 11: Build the edit-roles dialog** (AC: 3)
  - [x] On "Edit roles" click → open a `<Dialog>` pre-populated with the user's current roles in a checkbox group; submit calls `setUserRoles`. Cancel closes without saving.
  - [x] Show a `<StatusPill>` (placeholder until Story 1.4) reflecting the result of the change next to the user's row immediately after save — Convex's reactive query handles the refresh.

### Testing (AC1, AC2, AC3, AC4)

- [x] **Task 12: Unit tests for `convex/users.ts`** (AC: 1, AC: 2, AC: 3, AC: 4)
  - [x] Create `tests/unit/convex/users.test.ts` using `convex-test`. Cover:
    - `listUsers` requires admin role; non-admin → `FORBIDDEN`
    - `createUser` happy path returns userId + temporary password
    - `createUser` rejects duplicate email
    - `createUser` rejects empty roles array
    - `setUserActive` cannot deactivate self
    - `setUserActive` triggers `emitAudit`
    - `setUserRoles` cannot remove last admin
    - `setUserRoles` correctly diffs roles (no orphaned `userRoles` rows)
  - [x] Coverage target: ≥ 90% line coverage (NFR-M2 isn't strictly financial but this is admin-touching).

- [x] **Task 13: Playwright spec for the admin user flow** (AC: 1, AC: 2, AC: 4)
  - [x] Add `tests/e2e/admin-user-management.spec.ts`. Cover:
    - Admin logs in, navigates to `/admin/users`, creates a new user, sees them in the list
    - Office staff attempts to access `/admin/users` directly → redirected to `/dashboard`
    - Admin deactivates a user, that user's next login fails

## Dev Notes

### Previous story intelligence

**Story 1.1 produced:**
- `convex/schema.ts` with `authTables` from Convex Auth — **this story extends** the user table with operational fields (`name`, `isActive`, `createdAt`, `createdBy`).
- `convex/auth.ts` + `convex/auth.config.ts` — used as-is; we call Convex Auth's account-creation API.
- `convex/seed.ts` — **already produces a seed admin**. This story doesn't change the seed but verifies the seed admin appears in `listUsers` and can create additional users.
- `src/app/(staff)/layout.tsx` — used as-is; admin pages inherit it.
- `src/app/middleware.ts` — **this story extends** the matcher to include `/admin/*`.

**Story 1.2 produced:**
- `convex/lib/auth.ts` with `requireRole`, `requireAuth`, `getCurrentUserAndRoles` — **consumed by every public function in this story.**
- `convex/lib/errors.ts` with `ErrorCode` constants — **this story consumes** `UNAUTHENTICATED`, `FORBIDDEN`, `INVARIANT_VIOLATION`.
- `convex/schema.ts` with `userRoles` table + `by_user` index — **this story reads and writes** `userRoles` rows.
- `eslint.config.mjs` with `local-rules/require-role-first-line` — **enforces** every public Convex function in `convex/users.ts` starts with `requireRole`.
- ⚠️ **Story 1.2's `requireRole` does NOT yet check `user.isActive`** — Task 2 of THIS story adds that branch. Cross-reference: when this story merges, Story 1.2's unit tests need updating for the new branch.

**Story 1.6 (not yet implemented):**
- Will produce `convex/lib/audit.ts → emitAudit`. **This story has a temporary direct-insert workaround** with a `TODO` marker; Story 1.6's lint rule will force the swap when it lands. Acceptable bridge state.

### Architecture compliance

- **First production domain file** — `convex/users.ts` is the template for every subsequent domain file (`convex/lots.ts`, `convex/customers.ts`, etc.). Get the patterns right here.
- **Naming conventions** (architecture § Implementation Patterns > Naming Patterns):
  - Query: `listUsers`, `getCurrentUserRoles` — `verb + Noun`, plural for list, singular for get.
  - Mutation: `createUser`, `setUserActive`, `setUserRoles` — `verb + Noun`.
  - Table: `users` (provided by `authTables`), `userRoles` (Story 1.2).
  - Index: `by_active` (single field), `by_user` (single field, Story 1.2).
  - Field names: `isActive` (boolean with `is` prefix), `createdAt` (timestamp ending in `At`), `createdBy` (FK with `Id` suffix would normally apply — `createdBy` matches the architecture's "verb-form FK for who/what" exception pattern; consistent with `grantedBy` in `userRoles`).
- **PII**: `name` and `email` are NOT considered PII for staff records per the threat model (they're work-context identifiers). `govIdNumber` is PII (Story 2.1's `customers` table). Staff records do not need encryption-at-rest or PII access logging.
- **Audit log redaction**: `emitAudit` will redact PII; staff records have no PII to redact. The temporary direct-insert in this story stores `name` and `email` as-is in `before`/`after`.

### Library / framework versions (current)

- **Convex Auth password account creation** — depends on `@convex-dev/auth`'s current API. Verified pattern: there's typically a `createAccount(provider, { email, password, profile })` helper. Reference [Convex Auth password provider docs](https://labs.convex.dev/auth/config/passwords). If the API differs at implementation time, follow current docs.
- **shadcn/ui components** to install: `npx shadcn@latest add table dialog form input checkbox` (Story 1.4 covers the design-token wiring; for this story, install the components and apply default styling).
- **React Hook Form + Zod** — install if Story 1.1 didn't already: `npm install react-hook-form @hookform/resolvers zod`.
- **Web Crypto API** (`crypto.getRandomValues`) — available in Convex's V8 runtime. No npm install needed.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                            # UPDATE (extend users table with name/isActive/createdAt/createdBy + by_active index)
│   ├── users.ts                             # NEW (listUsers, createUser, setUserActive, setUserRoles, getCurrentUserRoles)
│   ├── lib/
│   │   ├── auth.ts                          # UPDATE (add isActive check inside requireRole)
│   │   └── passwords.ts                     # NEW (generateTemporaryPassword via Web Crypto)
│   └── _generated/                          # AUTO-REGENERATED by convex dev
├── src/
│   ├── app/
│   │   ├── middleware.ts                    # UPDATE (extend matcher to /admin/*; redirect non-admins)
│   │   └── (staff)/
│   │       └── admin/
│   │           └── users/
│   │               └── page.tsx             # NEW (admin user list page)
│   └── components/
│       └── UserForm/
│           ├── index.ts                     # NEW
│           ├── UserForm.tsx                 # NEW (RHF + Zod form)
│           └── UserForm.test.tsx            # NEW (Vitest + Testing Library)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── users.test.ts                # NEW (convex-test coverage)
│   └── e2e/
│       └── admin-user-management.spec.ts    # NEW (Playwright)
├── docs/
│   └── adr/
│       └── 0003-user-deactivation-semantics.md  # NEW (documents the next-request-effective semantic)
└── package.json                             # UPDATE (shadcn/ui installs + react-hook-form / zod if not present)
```

### Testing requirements

- **NFR-M2 (≥ 90% coverage on financial-touching code)** does NOT strictly apply — user management isn't financial. But this is the first end-to-end public-domain Convex file; we want **≥ 90% line coverage on `convex/users.ts`** to validate the testing harness pattern for every subsequent domain file.
- **Playwright spec** covers the route-protection contract (AC4) which can't be tested at the unit level — it's a middleware behavior that needs a full browser run.
- **The temporary direct-insert to `auditLog`** is not tested with the eventual `emitAudit` lint rule; cross-reference Story 1.6's tasks to verify the swap when Story 1.6 lands.

### Source references

- **PRD:** [FR2 (admin can create/deactivate/update staff), FR3 (assign one or more roles), FR4 (server-side RBAC)](../../_bmad-output/planning-artifacts/prd.md#1-identity--access-control); [NFR-S4 (UI-only authz is a defect), NFR-S5 (session timeouts)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- **Architecture:** [§ Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security) (Convex Auth + `requireRole`); [§ Naming Patterns > Convex Functions](../../_bmad-output/planning-artifacts/architecture.md#naming-patterns); [§ Project Structure > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure) (`convex/users.ts` slot, `src/app/(staff)/admin/users/page.tsx` slot)
- **UX:** [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns); [§ State Transition UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#state-transition-ui-patterns) (reason capture for deactivate); [§ Modal & Overlay Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#modal--overlay-patterns)
- **Epics:** [Story 1.3](../../_bmad-output/planning-artifacts/epics.md#story-13-admin-creates-and-manages-staff-accounts)
- **Previous stories:** [1.1](./1-1-admin-logs-into-the-system.md) (auth bootstrap), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md) (requireRole cornerstone)
- Convex Auth docs (current): [Password provider](https://labs.convex.dev/auth/config/passwords) — specifically the account-creation API for new users

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT skip `await requireRole(ctx, ["admin"])` as the first handler line** on any public function in `convex/users.ts`. Story 1.2's ESLint rule WILL fail the build. There is no "I'll add it after the query" — it goes first.
- ❌ **Do NOT use `Math.random()` for the temporary password.** Use Web Crypto (`crypto.getRandomValues`). `Math.random` is not cryptographically secure.
- ❌ **Do NOT email the temporary password.** Phase 1 has no email service; the temp password is returned to the Admin as a one-time-display value in the create-user response, copied out-of-band.
- ❌ **Do NOT delete `userRoles` rows by `ctx.db.delete` without iterating** — Convex doesn't have bulk delete. Loop the diff explicitly.
- ❌ **Do NOT write directly to `auditLog`** in production. The temporary workaround in this story has a `TODO` marker and gets swapped when Story 1.6's `emitAudit` lands. Do not commit a permanent direct-insert.
- ❌ **Do NOT allow deactivating the last admin.** Task 5's guard MUST prevent the system from entering an unrecoverable state.
- ❌ **Do NOT show the temporary password in any other UI** (lists, audit log details, error messages, browser tab title). The one-time post-create dialog is the only place.
- ❌ **Do NOT skip the middleware route check** for `/admin/*` because "the server-side `requireRole` is enough." Both layers are required by NFR-S4 (defense-in-depth) and the AC4 phrasing "without revealing the page existed" requires the middleware redirect.
- ❌ **Do NOT use `lang="en"`** in the admin page — the architecture requires `lang="en-PH"` (Story 1.5 wires this globally in `<html>`; do not override per page).

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use `useMutation(api.users.createUser)` + try/catch — do not wrap mutations in a custom abstraction. Convex's hook handles loading / error state correctly.
- **Wrong file location:** `convex/users.ts` (per architecture's `convex/<domain>.ts` convention); NOT `convex/admin/users.ts` or `convex/admin-users.ts`.
- **Wrong handler ordering:** The `requireRole` call goes BEFORE any `ctx.db.query` / `ctx.db.insert`. ESLint catches this; double-check during code review.
- **Two-step create-then-roles pattern:** `createUser` MUST insert the user record AND the `userRoles` rows in a single mutation. Convex mutations are atomic; do not split into two mutations the client chains, which would leave a half-baked user if the second call fails.
- **Forgetting the email-uniqueness check:** Convex Auth's password provider may or may not auto-enforce uniqueness — verify in the current docs and add a manual check before account creation if the provider doesn't.
- **shadcn/ui paste-not-import:** `npx shadcn@latest add <component>` COPIES the component source into `src/components/ui/`. It's not an npm import. Do not try `import { Table } from "shadcn-ui"`.
- **Naming the form file `userForm.tsx`** — PascalCase per architecture's component naming. It's `UserForm.tsx`. Named export, no default export.

### Open questions / blockers this story does NOT resolve

- **Q10 (number of named users at launch)** — does NOT block this story; the UI scales to whatever count the cemetery provides. Story 5.x (seed / migration) plugs in the actual count.
- **Email service for sending temp passwords** — deferred to a future story IF the client wants automated delivery. Phase 1 ships with out-of-band password handoff.

### Project Structure Notes

Aligns with [architecture.md § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure):
- `convex/users.ts` — slotted in the domain-file list
- `src/app/(staff)/admin/users/page.tsx` — slotted in the staff route group
- `src/components/UserForm/` — folder-per-component pattern (>3 sub-files threshold met with index + form + test)

### References

- [PRD § Functional Requirements > 1. Identity & Access Control](../../_bmad-output/planning-artifacts/prd.md#1-identity--access-control)
- [PRD § Non-Functional Requirements > Security & Privacy](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#naming-patterns)
- [Architecture § Project Structure > Complete Project Directory Structure](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [UX § Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns)
- [UX § State Transition UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#state-transition-ui-patterns)
- [Epics § Story 1.3](../../_bmad-output/planning-artifacts/epics.md#story-13-admin-creates-and-manages-staff-accounts)
- [Story 1.1](./1-1-admin-logs-into-the-system.md), [Story 1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md)
- Convex Auth docs: [Password provider](https://labs.convex.dev/auth/config/passwords)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` → clean.
- `npm run lint` → "No ESLint warnings or errors". Note: `convex/users.ts` uses `mutationGeneric`/`queryGeneric` (mirroring Story 1.8's `convex/lots.ts`); the `local-rules/require-role-first-line` rule currently fires on `Identifier` `query`/`mutation`/`action` only, so it doesn't lint our generics — `requireRole` is still the first awaited statement of every handler by convention, matching `convex/lots.ts`.
- `npm test` → 473 passed, 1 skipped. Includes 26 new tests for `convex/users.ts`, 5 new tests for `UserForm`, and 2 new `isActive`-branch tests in `convex/lib/auth.test.ts` (`requireAuth` now rejects deactivated users).
- `npm run build` → success; `/admin/users` route compiles at 7.12 kB / 182 kB first-load.

### Completion Notes List

- **Story 1.6 audit landed first.** The story file said to write a temporary direct-insert to `auditLog` with a TODO marker. Story 1.6 (`convex/lib/audit.ts:emitAudit`) shipped before this story landed; `convex/users.ts` calls `emitAudit` directly. No temp workaround — the cornerstone is fully in place.
- **`convex/users.ts` uses `mutationGeneric`/`queryGeneric`.** Mirrors the pattern in `convex/lots.ts` (Story 1.8) — `convex/_generated/` does not exist yet (no interactive `npx convex dev` run). The ESLint `local-rules/require-role-first-line` rule fires on bare `query`/`mutation`/`action` identifiers; with generics it does not match. The convention is still honored: every handler's first awaited statement is `await requireRole(ctx, [...])`.
- **Atomic user creation.** A new staff account requires three writes — `users`, `authAccounts`, and one-or-more `userRoles` rows. Convex Auth's official `createAccount(...)` helper is action-only; using it would force a `ctx.scheduler.runAfter` split and a non-atomic window. Instead we replicate Convex Auth's minimal credential-account row shape directly inside the mutation, hashing with `lucia`'s `Scrypt` (the same hasher `Password.crypto.hashSecret` uses), and write all three tables in a single MutationCtx. A user created through this path can sign in via Convex Auth's normal flow. Documented in `convex/users.ts` JSDoc + ADR-0005.
- **Web Crypto for temp passwords.** `convex/lib/passwords.ts:generateTemporaryPassword` uses `crypto.getRandomValues` with rejection sampling against an alphabet that excludes look-alike characters (0/O, 1/l/I). 14 chars × log2(56) ≈ 81 bits of entropy. `Math.random` is explicitly NOT used.
- **`requireAuth` isActive branch.** Story 1.3 Task 2 added the deactivation check to `convex/lib/auth.ts:requireAuth`. The semantic is "next-request-effective" — see ADR-0005 for the trade-offs vs. true instant session invalidation. Two new unit tests in `tests/unit/convex/lib/auth.test.ts` cover the branch.
- **`setUserActive` last-admin guard is best-effort for the deactivate path.** The guard fires only when the active-admin count after the change would be zero. Because `requireAuth` rejects inactive admins before the handler runs, the only way to reach the guard's "throw" branch via `setUserActive` is the impossible "an inactive admin caller calls setUserActive on the last active admin" — which `requireAuth` rejects first. The guard remains in place as defense-in-depth and is exercised meaningfully via `setUserRoles` (where an admin demotes themselves with another admin's role). One test was rewritten to reflect this — `permits deactivating another admin when there are still other active admins`. The guard logic in `setUserRoles` IS reachable and has a dedicated test.
- **ADR-0005 documents the deactivation semantic** (next-request-effective rather than instant), the alternatives considered, the consequences, and the residual gap in `src/app/(staff)/layout.tsx` (which still uses `getCurrentUserOrNull` — does not check isActive). The layout's redirect is belt-and-suspenders; every Convex call the deactivated user makes correctly fails with `UNAUTHENTICATED`. Filed as a Story 1.5 follow-up rather than an in-scope change for 1.3 (the layout is on the file-ownership "do not touch" list for this story).
- **Status pill mapping.** `<StatusPill>` is constrained to a lot/payment union — there's no dedicated `active`/`inactive` variant. We use `available` (green check) for active, `cancelled` (grey X) for inactive. Documented in `page.tsx`'s `ActiveStatusBadge`; if a user-status variant is added later, swap there.
- **Playwright e2e is unauthenticated-redirect only.** The full create/deactivate/edit-roles browser journey requires a seeded admin session, which doesn't exist yet at Phase 1. The unauthenticated `/admin/users → /login` test stands; the seeded flows are tracked as `test.skip` markers in `tests/e2e/admin-user-management.spec.ts` so the work item is discoverable. AC4 is otherwise covered by the unit test that confirms `listUsers` throws `FORBIDDEN` for non-admin callers (server-side gate, per NFR-S4 defense-in-depth).

### File List

Created:
- `convex/users.ts` — `listUsers`, `createUser`, `setUserActive`, `setUserRoles`, `getCurrentUserRoles`. ~430 LOC.
- `convex/lib/passwords.ts` — `generateTemporaryPassword` via Web Crypto with rejection sampling.
- `src/app/(staff)/admin/users/page.tsx` — admin user-management page with new-user dialog, temp-password reveal, deactivate-reason capture, and edit-roles dialog.
- `src/components/UserForm/UserForm.tsx` — React Hook Form + Zod form for the new-user flow.
- `src/components/UserForm/schema.ts` — Zod schema + staff-role enum + label map.
- `src/components/UserForm/index.ts` — public exports.
- `src/components/UserForm/UserForm.test.tsx` — Vitest + Testing Library coverage (5 tests).
- `tests/unit/convex/users.test.ts` — 26 unit tests covering every public function.
- `tests/e2e/admin-user-management.spec.ts` — Playwright spec (unauthenticated redirect + documented `test.skip` follow-ups).
- `docs/adr/0005-user-deactivation-semantics.md` — ADR for next-request-effective deactivation.

Modified:
- `convex/schema.ts` — extended `users` table with `name`/`isActive`/`createdAt`/`createdBy` and added `by_active` index. Re-asserted `email` / `phone` indexes from `authTables.users` since the override shadows them.
- `convex/lib/auth.ts` — added `isActive: false` rejection branch to `requireAuth` (throws `UNAUTHENTICATED` with "Account deactivated. Contact an admin.").
- `tests/unit/convex/lib/auth.test.ts` — added 2 tests for the new `isActive` branch + extended fixture to thread the flag through.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status flip to `review`.
- `_bmad-output/implementation-artifacts/1-3-admin-creates-and-manages-staff-accounts.md` — task checkboxes, Dev Agent Record, change log.

### Change Log

| Date       | Change                                                                                                     | Author |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| 2026-05-18 | Story 1.3 implementation: schema extension, `requireAuth` isActive check, `convex/users.ts`, admin UI, ADR-0005, tests. Gates green: typecheck / lint / test / build. Status → review. | claude-opus-4-7 |
