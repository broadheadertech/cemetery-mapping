# Story 5.4: Admin Flags a Contract for Staff Follow-up

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin / Owner (Mr. Reyes)**,
I want **to flag a specific contract for staff follow-up with a short comment from the contract detail page, with the flag appearing in the assigned staff member's queue and updating Maria's dashboard in real time**,
so that **I can route attention to staff without a phone call or a multi-step ticket workflow** (FR44, Journey 4 climax).

This is the **one mutation** the owner performs from his phone in a typical week. Single-tap, single-comment, reactive cross-role sync. Maria sees the flag appear in her dashboard within 1 second with the 600ms amber fade. No multi-step ticketing, no notification system — just a comment that shows up in the right place at the right time.

## Acceptance Criteria

1. **AC1 — "Flag for follow-up" Popover on contract detail page**: On `/contracts/[contractId]/page.tsx`, an Admin (and only an Admin) sees a "Flag for follow-up" button in the contract header / actions area. Tapping opens a shadcn/ui `Popover` containing: a single `<textarea>` for the comment (max 280 chars, character counter visible), a "Submit" primary button, and a "Cancel" secondary button. Office Staff and Field Worker do not see the button (server-enforced — see AC3).

2. **AC2 — Submit creates a `flaggedContracts` record + reactively updates Maria's dashboard ≤ 1 second**: Submitting the form calls `api.flaggedContracts.create({ contractId, comment, assignee?: "all_staff" | userId })` which: (a) calls `requireRole(ctx, ["admin"])` as first line, (b) inserts a `flaggedContracts` row with `status: "open"`, `flaggedBy: currentUserId`, `flaggedAt: now`, `comment`, `contractId`, `assignee` (default `"all_staff"`), (c) calls `emitAudit(ctx, { action: "flag.create", subjectId: flagId, ... })`, (d) returns the new flag id. Maria's open dashboard (in a separate browser/tab) reactively updates her "Flagged for me" tile + count + most-recent-comment within 1 second, with the 600ms amber fade on the tile.

3. **AC3 — Role enforcement: only Admin can create flags**: `convex/flaggedContracts.ts → create` calls `requireRole(ctx, ["admin"])` only — not `["admin", "office_staff"]`. Office Staff who somehow reach the mutation (e.g. via curl, or a UI bug) receive `FORBIDDEN`. The UI button is also hidden for non-Admins via `useCurrentUser()` role check, but that's the cosmetic layer per NFR-S4 ("UI-only authorization is a non-compliance defect" — server enforces).

4. **AC4 — Flag lifecycle: open → viewed → resolved**: Office Staff opening the underlying contract via the flagged-followups list (Story 5.3) triggers an automatic transition `open → viewed` via a mutation `api.flaggedContracts.markViewed({ flagId })` (or via a query observation pattern — see Task 4 for decision). The flag remains visible but no longer counts as "new." Either Admin or Staff can explicitly resolve via `api.flaggedContracts.resolve({ flagId, resolutionNote? })` → status becomes `resolved`. State machine: `open → viewed → resolved` (no reverse transitions in this story).

## Tasks / Subtasks

### Schema (AC2, AC4)

- [ ] **Task 1: Add `flaggedContracts` table to schema** (AC: 2, AC: 4)
  - [ ] If Story 5.2 already added the table (see Story 5.2's conditional schema UPDATE), verify the schema matches the spec below; extend if needed. If not yet added, add in this story.
  - [ ] Schema:
    ```ts
    flaggedContracts: defineTable({
      contractId: v.id("contracts"),
      flaggedBy: v.id("users"),
      flaggedAt: v.number(),                      // ms epoch
      comment: v.string(),                        // max 280 chars (app-enforced; schema is just v.string())
      assignee: v.union(v.literal("all_staff"), v.id("users")),  // "all_staff" or specific user
      status: v.union(v.literal("open"), v.literal("viewed"), v.literal("resolved")),
      viewedAt: v.optional(v.number()),
      viewedBy: v.optional(v.id("users")),
      resolvedAt: v.optional(v.number()),
      resolvedBy: v.optional(v.id("users")),
      resolutionNote: v.optional(v.string()),
    })
      .index("by_contract", ["contractId"])
      .index("by_status", ["status"])
      .index("by_assignee_status", ["assignee", "status"])
      .index("by_flagged_by_status", ["flaggedBy", "status"]),
    ```

### Convex mutations + queries (AC1, AC2, AC3, AC4)

- [ ] **Task 2: Implement `create` mutation** (AC: 2, AC: 3)
  - [ ] Create or extend `convex/flaggedContracts.ts`.
  - [ ] `export const create = mutation({ args: { contractId: v.id("contracts"), comment: v.string(), assignee: v.optional(v.union(v.literal("all_staff"), v.id("users"))) }, handler: async (ctx, args) => { ... } });`
  - [ ] Body:
    1. `const { userId } = await requireRole(ctx, ["admin"]);` — **NOT** `["admin", "office_staff"]`. AC3 demands Admin-only.
    2. Validate `args.comment.trim().length >= 1 && args.comment.length <= 280` else `throwError(VALIDATION_ERROR, "Flag comment must be 1–280 characters.")`. Use a new error code `VALIDATION_ERROR` if Story 1.2's `convex/lib/errors.ts` already has it; otherwise add it as a small extension in this story.
    3. Verify the contract exists: `const contract = await ctx.db.get(args.contractId); if (!contract) throwError(NOT_FOUND, "Contract not found.");`
    4. Insert: `const flagId = await ctx.db.insert("flaggedContracts", { contractId, flaggedBy: userId, flaggedAt: Date.now(), comment: args.comment.trim(), assignee: args.assignee ?? "all_staff", status: "open" });`
    5. `await emitAudit(ctx, { actorId: userId, action: "flag.create", entityType: "flaggedContracts", entityId: flagId, payload: { contractId, comment: args.comment.trim().slice(0, 80) /* truncate in audit */, assignee: args.assignee ?? "all_staff" } });` — audit log entry per Story 1.x's `emitAudit` pattern.
    6. Return `flagId`.

- [ ] **Task 3: Implement `markViewed` mutation** (AC: 4)
  - [ ] `export const markViewed = mutation({ args: { flagId: v.id("flaggedContracts") }, handler: ... });`
  - [ ] Body: `requireRole(ctx, ["admin", "office_staff"])` (both can view). Fetch flag; if `status !== "open"`, no-op (already viewed or resolved). If open, patch `status: "viewed", viewedAt: now, viewedBy: userId`. Emit audit `flag.view`.
  - [ ] **Idempotent.** Calling twice is harmless. Office Staff opening the contract page should always feel safe to trigger this.

- [ ] **Task 4: Implement `resolve` mutation** (AC: 4)
  - [ ] `export const resolve = mutation({ args: { flagId: v.id("flaggedContracts"), resolutionNote: v.optional(v.string()) }, handler: ... });`
  - [ ] Body: `requireRole(ctx, ["admin", "office_staff"])`. Fetch flag; if already resolved → `ILLEGAL_STATE_TRANSITION`. Else patch `status: "resolved", resolvedAt: now, resolvedBy: userId, resolutionNote: args.resolutionNote ?? null`. Emit audit `flag.resolve`.
  - [ ] State-machine check uses Story 1.7's `assertTransition` helper if it's been built; otherwise inline a small check `if (flag.status === "resolved") throwError(ILLEGAL_STATE_TRANSITION, "Flag already resolved.")`.

- [ ] **Task 5: Implement `list` query** (AC: 4, drill-down support for Story 5.3)
  - [ ] `export const list = query({ args: { status: v.optional(v.union(v.literal("open"), v.literal("viewed"), v.literal("resolved"))) }, handler: ... });`
  - [ ] Body: `requireRole(ctx, ["admin", "office_staff"])`. Filter by `status` if provided, default = all-non-resolved (`open` + `viewed`). Return rows with `contractId`, `flaggedAt`, `comment`, `flaggedBy` (joined to user name via lightweight per-row `ctx.db.get(flaggedBy)`), `assignee`, `status`, and the related contract's `contractNumber` + `customerName` (joined per-row).
  - [ ] For a typical-load steady state of ≤ 50 open flags, per-row joins are fine. If this grows to thousands, refactor to a snapshot doc — defer.
  - [ ] This query was scaffolded as part of Story 5.3 Task 9 — this story OWNS it.

- [ ] **Task 6: Update `convex/dashboards.ts → getFlaggedForFollowupSummary` for Maria's view** (AC: 2)
  - [ ] Story 5.2 implemented this query for the Admin's view ("flags I created"). Extend now for the Staff view ("flags assigned to me").
  - [ ] Body branch on `roles`: if the caller's role is `admin`, return open flags where `flaggedBy === userId`. If `office_staff`, return open flags where `assignee === userId OR assignee === "all_staff"` AND `status === "open"`. If both roles (rare — same user is admin + staff), unify both queries.
  - [ ] Use the new `by_assignee_status` and `by_flagged_by_status` indexes.

### UI: Flag-for-follow-up Popover on contract detail (AC1)

- [ ] **Task 7: Add Popover to `/contracts/[contractId]/page.tsx`** (AC: 1, AC: 2)
  - [ ] Edit `src/app/(staff)/contracts/[contractId]/page.tsx` (built by Epic 3 — verify exists; if not, this story creates a minimal version with just the flag button + page chrome).
  - [ ] Render `Flag for follow-up` button only when `currentUser.roles.includes("admin")` (use `useCurrentUser` hook from Story 1.x).
  - [ ] On click, open a shadcn/ui `Popover` (installed in Story 1.4 / shadcn primitives) anchored to the button.
  - [ ] Popover content: form with a `<label>` "Why are you flagging this contract?" → `<textarea aria-describedby="char-counter" maxLength={280} rows={3}>` → character counter `<span id="char-counter">{count}/280</span>` (announcing `aria-live="polite"` when near the limit) → "Submit" + "Cancel" buttons. The `min-h-[44px]` rule applies to both buttons (NFR-A4).
  - [ ] Assignee picker: **for this story, leave assignee fixed at `"all_staff"`** (the default). Per-user assignment is a follow-up enhancement if the cemetery's staff structure later needs it. Document deferral in Completion Notes.
  - [ ] On Submit: call `useMutation(api.flaggedContracts.create)` with `{ contractId, comment }`. On success: close popover; show a calm inline confirmation ("Flagged — staff will see it on their dashboard.") via `aria-live="polite"`. On error: keep popover open, render the error sentence below the textarea via the translateError pattern.
  - [ ] **No success toast.** Per UX § Feedback patterns, reactive UI changes ARE the confirmation. Maria's dashboard update IS the confirmation Mr. Reyes will see if he switches back to it.

- [ ] **Task 8: Show existing flags on the contract detail page** (AC: 1, AC: 4)
  - [ ] Under the contract header, render an "Active flags" section listing any open or viewed flags for this contract via `useQuery(api.flaggedContracts.listByContract, { contractId })` (NEW query — add it: filters by contract + status in (open, viewed)).
  - [ ] Each flag row: timestamp, flagged-by name, comment, status pill (open=amber, viewed=blue, resolved=neutral). For Admins: "Resolve" button → calls `resolve` mutation. For Office Staff: same. (Both roles can resolve.)
  - [ ] If no active flags: do not render the section at all (empty-state design — quiet absence is better than empty placeholder, UX voice).

### Reactive cross-tab verification + tests (AC2, AC3, AC4)

- [ ] **Task 9: Convex unit tests** (AC: 2, AC: 3, AC: 4)
  - [ ] Create `tests/unit/convex/flaggedContracts.test.ts`.
  - [ ] **AC3 — Admin-only create:** seed two users (admin, office_staff). Admin calls `create` → success. office_staff calls `create` → `FORBIDDEN`. Unauth → `UNAUTHENTICATED`.
  - [ ] **AC2 — successful create:** verify the inserted row has correct `flaggedBy`, `flaggedAt` (within 1s of test wall clock), `status: "open"`, `assignee: "all_staff"` default.
  - [ ] **Comment validation:** empty string → `VALIDATION_ERROR`. 281 chars → `VALIDATION_ERROR`. 280 chars → success. Whitespace-only ("   ") → trim to empty → `VALIDATION_ERROR`.
  - [ ] **AC4 — markViewed:** open flag → markViewed → status: viewed, viewedAt set. markViewed again → idempotent no-op (no throw, status stays viewed, viewedAt does NOT update).
  - [ ] **AC4 — resolve:** open flag → resolve → resolved. Resolve again → `ILLEGAL_STATE_TRANSITION`.
  - [ ] **Audit log entries:** verify each mutation emits an audit row with the expected `action` + payload (read from the audit log via the Story-1.x test helper).
  - [ ] Coverage target ≥ 90% on `convex/flaggedContracts.ts` (financial-adjacent — flags route attention to overdue contracts; not strictly financial but high-trust).

- [ ] **Task 10: Playwright e2e — Journey 4 climax** (AC: 1, AC: 2)
  - [ ] Extend `tests/e2e/journey-4-admin-dashboard.spec.ts` with the climax scenario:
    1. Sign in as Admin in browser context 1; sign in as Office Staff (Maria) in browser context 2; both load their dashboards.
    2. Admin navigates to a contract detail page (use a seeded contract id).
    3. Admin clicks "Flag for follow-up," types a comment ("Customer called about installment 5 — confirm date"), submits.
    4. Within 2 seconds (generous), Maria's "Flagged for me" tile updates: count increments, comment text reflects the new flag, the 600ms amber fade plays on the tile.
    5. Maria clicks the tile → drill-down to `/flagged-followups?status=open` → sees the row → clicks the contract link → lands on the contract detail.
    6. Maria clicks "Resolve" → flag status pill transitions to "resolved" with the 300ms StatusPill crossfade (Story 5.9-applied behavior).
  - [ ] This is the **highest-stakes scenario in the whole product**: Owner → Staff cross-role reactive sync. If flaky, the Journey-4 magic moment is unverified. Use generous timeouts; consider running in retry mode 3× in CI.

### Documentation (AC2)

- [ ] **Task 11: Audit log entries documented** (AC: 2)
  - [ ] In `docs/audit-events.md` (NEW or UPDATE if Story 1.x established it), document the three new audit actions: `flag.create`, `flag.view`, `flag.resolve` — payload schemas, who can emit, retention.
  - [ ] No new ADR — flag-for-followup is a feature, not an architectural decision. The pattern (mutation → audit → reactive update) is already documented in earlier ADRs.

## Dev Notes

### Previous story intelligence

- **Story 1.2** — `requireRole`, `emitAudit`, error codes. The Admin-only role check is critical here.
- **Story 1.7** (if shipped) — `assertTransition` helper for state machine validation. If not shipped, inline checks for the flag status transitions.
- **Story 5.2** — `flaggedContracts` table may have been created there as a conditional schema UPDATE. Verify schema matches; if 5.2 ships first, this story OWNS the table but inherits the schema. If this story ships first, 5.2 consumes the schema.
- **Story 5.3** — `/flagged-followups` drill-down list page. This story's `list` query is what 5.3 reads. If 5.3 already implemented a stub of `list`, this story owns the canonical version.
- **Epic 3** — `/contracts/[contractId]/page.tsx` contract detail page. This story adds the Flag UI there.
- **Story 5.9** — applies the StatusPill 300ms crossfade across the system. The flag status pill (open / viewed / resolved) automatically benefits when 5.9 ships; no extra work here.

**Sequencing rule:** Story 5.4 should land AFTER Story 5.2 (for the dashboard tile reactive update) and AFTER Epic 3 contract detail page (for the host UI). Order vs. Story 5.3 is flexible — they share schema; whichever lands first creates the table.

### Architecture compliance

- **`requireRole(ctx, ["admin"])` for create** is the **first time in the codebase** that a mutation is admin-only-not-also-office-staff (most mutations allow both). The lint rule from Story 1.2 should accept this; verify the rule allows any subset of `Role[]` not just multi-role lists.
- **Audit log on every state-changing mutation** (architecture § Data Boundary > `emitAudit` is the only write path to `auditLog`). Three new event types added.
- **State machine for flag lifecycle**: simple linear `open → viewed → resolved`. No state-machine helper needed for a 3-state linear chain; inline checks suffice. If a future story adds branching (e.g. `dismissed`), promote to `convex/lib/stateMachines.ts`.
- **Reactive cross-role sync**: Office Staff's dashboard query (`getFlaggedForFollowupSummary` for their scope) subscribes to `flaggedContracts`; insertions trigger automatic re-evaluation. No pub/sub setup needed — Convex's reactivity model handles it.
- **No notifications, no toasts, no email**: per UX § Journey 4 "No notifications, no alerts — reactive fade IS the alert." If a future requirement adds out-of-app notification (SMS, email), it's a Phase 3 concern, not Phase 1.

### Library / framework versions

- shadcn/ui `Popover` — installed by Story 1.4 if not already. Verify before consuming.
- Convex `mutation`, `query` — same as elsewhere.
- No new dependencies.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                    # UPDATE — add flaggedContracts table (or no-op if 5.2 already did)
│   ├── flaggedContracts.ts          # NEW — create, markViewed, resolve, list, listByContract
│   └── dashboards.ts                # UPDATE — extend getFlaggedForFollowupSummary for Staff scope
├── src/app/(staff)/contracts/[contractId]/page.tsx   # UPDATE — add Flag-for-follow-up button + Popover + Active flags section
├── tests/
│   └── unit/convex/flaggedContracts.test.ts          # NEW
└── docs/audit-events.md             # UPDATE (or NEW) — document flag.create/view/resolve
```

### Testing requirements

- **Coverage target ≥ 90%** on `convex/flaggedContracts.ts`. Each mutation has at least 3 test cases (happy / role-denied / state-error).
- **Playwright e2e** — the Journey-4 climax scenario. This is THE end-to-end product validation for the dashboard + flag flow.
- **Audit log assertion in unit tests** — verify every state-changing mutation writes the expected audit row.

### Source references

- **PRD:** [FR44 — flag for follow-up](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards).
- **Architecture:** [§ Capability area 8 — Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping), [§ Data Boundary > emitAudit](../../_bmad-output/planning-artifacts/architecture.md#data-boundary).
- **UX:** [§ Journey 4 — climax](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business), [§ Reactive Update Patterns > Cross-tab sync](../../_bmad-output/planning-artifacts/ux-design-specification.md#reactive-update-patterns), [§ Feedback patterns > Reactive fade is the confirmation](../../_bmad-output/planning-artifacts/ux-design-specification.md#feedback-patterns).
- **Epics:** [Story 5.4](../../_bmad-output/planning-artifacts/epics.md#story-54-admin-flags-a-contract-for-staff-follow-up).

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT allow Office Staff to call `create`.** AC3 is explicit. The semantic is "Admin instructs Staff via flag." If both roles can create, the audit trail loses meaning. Server-side `requireRole(ctx, ["admin"])` is the truth; UI hiding is cosmetic.
- ❌ **Do NOT add notifications, toasts, or modals** on Mr. Reyes's side after submit. The reactive update on Maria's dashboard is THE confirmation. Adding a "Flag created" toast on the Admin's screen would be noisy and inconsistent with the calm-reactivity UX.
- ❌ **Do NOT store flags inside the contract document.** Use a separate `flaggedContracts` table per the schema above. Embedding would make the contract doc grow unbounded over a 10-year horizon and would require the contract reactive subscription to re-fire on every flag change (over-subscription).
- ❌ **Do NOT skip `emitAudit` calls.** Every state-changing mutation logs. The whole compliance posture relies on this.
- ❌ **Do NOT add email / SMS notifications.** Phase 3 concern at earliest. Phase 1 is in-app reactive only.
- ❌ **Do NOT skip the 280-char limit or rely solely on `maxLength` HTML attribute.** Validate server-side too. A curl attacker can post arbitrary length; the mutation must reject.
- ❌ **Do NOT make the Popover modal.** It's an inline Popover anchored to the button per shadcn/ui `Popover`. Modal would be a different component (`Dialog`) — wrong UX for a quick comment.
- ❌ **Do NOT implement assignee picker in this story.** Out of scope. The schema supports it (`assignee: union("all_staff", userId)`), the mutation accepts it as optional, but the UI always sends `"all_staff"`. A follow-up story adds per-user assignment if the cemetery's staff structure later differentiates.
- ❌ **Do NOT use `useState` for the comment string and forget to clear it on Popover close.** Bug-prone. Use React Hook Form (Story 1.x established) or controlled state with `useEffect` cleanup on `open` change.
- ❌ **Do NOT show resolved flags on the contract detail's "Active flags" section.** Section filters to `status in (open, viewed)`. Resolved flags are still queryable for history (audit log, drill-down with `?status=resolved`) but not shown in the contract's active-attention section.
- ❌ **Do NOT auto-resolve flags on payment receipt.** Resolution is a deliberate Admin/Staff action. If a customer pays, the flag stays open until someone explicitly resolves — that's the "human in the loop" model the product is built around.

### Common LLM-developer mistakes to prevent

- **Reinventing audit logging:** call `emitAudit` from `convex/lib/audit.ts`. Don't insert directly into `auditLog`.
- **Wrong table name:** `flaggedContracts` (camelCase, plural) — matches architecture's naming convention. NOT `flagged_contracts`, `flags`, or `contractFlags`.
- **Confusing `markViewed` with `resolve`:** `markViewed` is automatic / silent; `resolve` is explicit. A flag remains "active" until resolved; viewing just stops the "new" indicator.
- **Forgetting the `by_assignee_status` index:** without it, Maria's dashboard query scans the full `flaggedContracts` table on every dashboard load.
- **Showing the Flag button to Office Staff:** the UI check is `currentUser.roles.includes("admin")`. Easy to typo as `currentUser.role === "admin"` (singular). Story 1.2's user model has `roles: Role[]` (array).
- **Forgetting to trim the comment:** `args.comment.trim()` before storing. Whitespace-only submissions look empty in the UI but pass length validation if not trimmed.
- **Popover doesn't close on Submit:** shadcn/ui Popover needs explicit `setOpen(false)` after successful mutation.

### Open questions / blockers this story does NOT resolve

- **Per-user assignee selection:** out of scope. Always `"all_staff"` in this story.
- **Flag SLA / auto-escalation:** out of scope. No "if open > 48 hours, escalate" automation. Mr. Reyes manages by looking.
- **Resolution requires a note?:** AC4 makes `resolutionNote` optional. PRD doesn't require it. Defer to owner feedback after launch.
- **§10 Q5 (commission tracking) — does sales-agent assignment affect flag routing?** No. Out of scope.

### Project Structure Notes

Aligns with:

- [Architecture § Capability mapping > Reporting & Financial Dashboards](../../_bmad-output/planning-artifacts/architecture.md#requirements-to-structure-mapping).
- [UX § Journey 4 — climax](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business).

### References

- [PRD § FR44](../../_bmad-output/planning-artifacts/prd.md#8-reporting--financial-dashboards).
- [Architecture § Data Boundary](../../_bmad-output/planning-artifacts/architecture.md#data-boundary).
- [UX § Journey 4](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-4--mr-reyes-checks-the-business).
- [UX § Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#reactive-update-patterns).
- [Epics § Story 5.4](../../_bmad-output/planning-artifacts/epics.md#story-54-admin-flags-a-contract-for-staff-follow-up).
- [Previous story (5.2)](./5-2-admin-views-the-kpi-dashboard.md).
- [Previous story (5.3)](./5-3-admin-drills-down-from-dashboard-metrics.md).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (BMAD dev-story flow, 2026-05-20).

### Debug Log References

- `npm run typecheck` — clean.
- `npm run lint` — clean (`next lint` deprecation banner only).
- `npx vitest run` — 1762 passed, 1 skipped (pre-existing). New
  `tests/unit/convex/contracts-flag.test.ts` adds 21 cases, new
  `tests/unit/components/FlagContractDialog.test.tsx` adds 8 cases,
  `tests/unit/convex/dashboard.test.ts` updated for the rewired
  `getFlaggedForFollowupSummary` data path (1 added case).
- `npm run build` — clean. `/contracts/[contractId]` grew from
  4.7 kB → 5.27 kB (flag card + dialog).

### Completion Notes List

- **Implementation shape deviated from the original story spec** per the
  user's narrowed prompt. The original story called for a separate
  `flaggedContracts` table with a three-state lifecycle (open → viewed
  → resolved), an assignee union, three mutations (`create` /
  `markViewed` / `resolve`), and a `listByContract` query. The shipped
  implementation collapses to four flat fields on `contracts`
  (`isFlagged`, `flagReason`, `flaggedAt`, `flaggedBy`) plus two
  mutations (`flagContract`, `unflagContract`) and one list query
  (`listFlaggedContracts`). The simpler shape matches the user's
  prompt and matches the calmer Phase-1 owner workflow (a single binary
  flag is enough for Mr. Reyes to route attention; richer state-machine
  semantics can land later if Maria's queue grows).
- **Assignee-picker deferral preserved** — all flags are implicitly
  "all_staff" because there is no per-staff routing field. A future
  story can add `flaggedAssignee: v.id("users")` if the cemetery's
  staff structure differentiates.
- **Audit transport uses the existing `update` action** rather than
  introducing new `flag.create` / `flag.clear` enum members. The audit
  row's `reason` field (`"Contract flagged for staff follow-up."` /
  `"Contract follow-up flag cleared."`) plus the `before` / `after`
  payloads carry the semantic intent. This avoids amending
  `AuditAction` for two events that fit cleanly under the
  patch-and-record pattern Story 1.6 established.
- **Server-side gate is admin-only on BOTH mutations** (AC3 demanded
  admin-only on `create`). Making `unflagContract` admin-only too keeps
  the audit-trail semantics clean — the owner-routed directive is
  cleared by the owner.
- **`listFlaggedContracts` accepts admin + office_staff** so the staff
  dashboard tile (Story 5.2) can drill into the queue. Office_staff
  cannot create or clear flags; they can read the work routed to them.
- **`getContract` extended to surface flag state** so the contract
  detail page renders the flag indicator + admin controls without a
  secondary fetch. `isFlagged: boolean` is always present (false when
  not flagged); the other three are populated only when flagged.
- **Dashboard query rewired** — `getFlaggedForFollowupSummary` now
  reads from `contracts.isFlagged` via the new `by_isFlagged` index.
  `isPlaceholder` is `false` whenever the query executes (kept on the
  shape for API stability with Story 5.2).
- **Index added:** `contracts.by_isFlagged` bounds the staff-queue
  scan + the dashboard tile to the flagged subset.
- **Out of scope (per the user's prompt):** no Playwright e2e was
  authored; the audit-events doc was not touched. These can land in a
  follow-up if the original story's broader scope is reactivated.

### File List

- `convex/schema.ts` — UPDATE: added four flag fields + `by_isFlagged`
  index to the `contracts` table.
- `convex/contracts.ts` — UPDATE: appended `flagContract`,
  `unflagContract`, `listFlaggedContracts` (plus extended
  `getContract` / `ContractDetailResult` to surface flag state).
- `convex/dashboard.ts` — UPDATE: rewired
  `getFlaggedForFollowupSummary` to read real flag data via
  `by_isFlagged`.
- `src/app/(staff)/contracts/[contractId]/page.tsx` — UPDATE: added
  flag indicator pill in header, flag/clear-flag card with admin-only
  buttons, FlagContractDialog wiring + `getCurrentUserOrNull` role
  read.
- `src/components/FlagContractDialog/FlagContractDialog.tsx` — NEW:
  controlled dialog with 280-char textarea + counter, role-gated by
  parent.
- `src/components/FlagContractDialog/index.ts` — NEW: barrel export.
- `tests/unit/convex/contracts-flag.test.ts` — NEW: 21 cases covering
  role gates, validation, NOT_FOUND, audit emission, idempotency,
  ordering.
- `tests/unit/components/FlagContractDialog.test.tsx` — NEW: 8 cases
  covering rendering, validation, error surfacing, pre-fill, counter.
- `tests/unit/convex/dashboard.test.ts` — UPDATE: replaced the
  placeholder-only assertion with the real data-path test (counts
  flagged + surfaces most-recent comment).
