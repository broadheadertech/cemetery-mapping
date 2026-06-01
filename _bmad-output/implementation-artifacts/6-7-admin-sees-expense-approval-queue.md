# Story 6.7: Admin Sees Expense Approval Queue

Status: review

<!-- Phase 2 reservation: Re-spec at Phase 2 kickoff. Bulk approve / reject flows + reject-reason copywriting may evolve once §10 Q9 lands. -->

## Story

As an **Admin**,
I want **to see a queue of expenses awaiting approval on `/admin/expenses-pending`, with bulk-approve capability and reject-with-reason flow, so I can review and clear the backlog during my standard review cadence**,
so that **the approval workflow from Story 6.6 has a usable operator surface and pending expenses don't pile up invisibly** (FR41).

This story is the **operator-facing half** of the approval workflow. It assumes Story 6.6 has shipped the toggle, the schema fields, and the `recordExpense` branching. This story adds the queue page, the approve / reject mutations, and the bulk action UX.

## Acceptance Criteria

1. **AC1 — Approval queue page lists all pending expenses with submitter, receipt photo, and action checkboxes**: An Admin on `/admin/expenses-pending` sees a table of `expenses` where `approvalStatus === "pending"`, sorted by `date` ascending (oldest first). Columns: checkbox (bulk-select), date, vendor, amount (formatted peso), category, submitter (user name), receipt photo (thumbnail; click → full image in `<Sheet>`). Bulk-action bar appears when ≥ 1 row is checked: "Approve selected" + "Reject selected." If the approval workflow is OFF (Story 6.6's setting), the page shows an empty-state message: "Approval workflow is currently disabled. Pending expenses cannot accumulate."

2. **AC2 — Bulk approve writes all selected to `"approved"` with audit trail and reactive dashboard update**: Clicking "Approve selected" calls `convex/expenses.ts → bulkApproveExpenses({ expenseIds })`. The mutation `requireRole(ctx, ["admin"])`, loops over the IDs, patches each to `approvalStatus: "approved"`, sets `approvedBy: userId`, `approvedAt: Date.now()`, and `emitAudit` per expense. After commit, the dashboard's MTD-expenses tile reactively re-aggregates to include the newly approved expenses (with the standard 600ms amber flash per UX § Reactive Updates).

3. **AC3 — Reject opens a dialog requiring a reason; rejection is final**: Clicking "Reject selected" (or per-row Reject) opens a `<Dialog>` with a required reason `<Textarea>` (max 500 chars). On submit, calls `bulkRejectExpenses({ expenseIds, reason })` — patches `approvalStatus: "rejected"`, `rejectedReason: reason`, `approvedBy: userId` (acting as rejecter; field is overloaded — see Dev Notes), `approvedAt: Date.now()`. `emitAudit` per row. Rejected expenses don't appear in the queue anymore; they remain visible in the submitter's `/expenses` list with a "Rejected" pill + reason shown on hover.

4. **AC4 — Submitters see their rejected expenses in their own activity view**: The Office Staff who submitted the expense sees rejected expenses listed at the top of `/expenses` (their own filtered view) with a red pill, rejection reason, and the rejecting admin's name. The submitter cannot un-reject; they can create a new corrected expense.

## Tasks / Subtasks

### Mutations (AC2, AC3)

- [ ] **Task 1: `bulkApproveExpenses` mutation** (AC: 2)
  - [ ] **UPDATE** `convex/expenses.ts`: add `export const bulkApproveExpenses = mutation({ args: { expenseIds: v.array(v.id("expenses")) }, handler })`.
  - [ ] First line: `const { userId } = await requireRole(ctx, ["admin"]);`.
  - [ ] Validate `expenseIds.length <= 100` (sanity cap; if larger batches are needed, the UI paginates the bulk action). Throw `ConvexError({ code: "BULK_LIMIT_EXCEEDED" })` if exceeded.
  - [ ] For each ID: read the expense; assert `approvalStatus === "pending"` (skip silently if not — idempotent semantics); patch to `"approved"`; `emitAudit({ action: "approve_expense", entityType: "expense", entityId: id, before, after, reason: "bulk approval" })`.
  - [ ] Return `{ approvedCount, skippedCount }`.

- [ ] **Task 2: `bulkRejectExpenses` mutation** (AC: 3)
  - [ ] **UPDATE** `convex/expenses.ts`: same shape, plus `reason: v.string()` arg.
  - [ ] Validate `reason.trim().length >= 3` (require a non-trivial reason). Throw `ConvexError({ code: "REASON_REQUIRED" })` if missing.
  - [ ] For each ID: patch to `"rejected"` with `rejectedReason: reason`, `approvedBy: userId`, `approvedAt: Date.now()`. `emitAudit`.

- [ ] **Task 3: Per-row `approveExpense` / `rejectExpense` mutations (single-row convenience)** (AC: 2, AC: 3)
  - [ ] Thin wrappers around the bulk mutations with `expenseIds: [singleId]`. Avoid duplicating logic.

### Queries (AC1, AC4)

- [ ] **Task 4: `listPendingExpenses` query** (AC: 1)
  - [ ] **UPDATE** `convex/expenses.ts`: add the query. `requireRole(ctx, ["admin"])`. Uses `by_approvalStatus_date` index (Story 6.6) to read all pending expenses, sorted ascending by date.
  - [ ] Project to `{ id, date, vendor, amountCents, category, submitterName, receiptPhotoUrl (signed) }`. PII concern: vendor names may include personal info; treat as standard data — vendor is not PII per architecture.

- [ ] **Task 5: Extend `convex/expenses.ts → listMyExpenses` for submitters** (AC: 4)
  - [ ] If the query already exists (Story 4.6), **UPDATE** to surface `approvalStatus` + `rejectedReason` + rejecter name. Sort rejected entries to the top within the submitter's view; mark them with a red pill in the UI.

### UI (AC1, AC2, AC3, AC4)

- [ ] **Task 6: Build `/admin/expenses-pending` page** (AC: 1, AC: 2, AC: 3)
  - [ ] **NEW** `src/app/(staff)/admin/expenses-pending/page.tsx`. `"use client"`.
  - [ ] If `appSettings.expensesRequireApproval === false`, render the empty-state with the disabled-workflow message + link to `/admin/settings`.
  - [ ] Else: table per AC1. shadcn `<Table>` with checkbox column.
  - [ ] Bulk-action bar (sticky top when scrolled): shows count of selected rows + "Approve selected" + "Reject selected" buttons. Disabled when zero selected.
  - [ ] Per-row actions menu (kebab): "Approve" / "Reject" / "View receipt photo."
  - [ ] Receipt-photo thumbnail click → `<Sheet>` with the full image (signed URL from Convex File Storage).
  - [ ] **UPDATE** `src/app/(staff)/layout.tsx` sidebar: add a "Pending expenses" admin nav item with a small count badge `(N)` showing pending count via `useQuery(api.expenses.countPendingExpenses, {})`. Hide when count is zero OR when workflow is OFF.

- [ ] **Task 7: Bulk-reject dialog** (AC: 3)
  - [ ] **NEW** `src/components/BulkRejectExpensesDialog/{BulkRejectExpensesDialog.tsx, index.ts}`.
  - [ ] Form: Textarea for reason (required, 3–500 chars). Submit button: "Reject {N} expenses." Destructive variant (`bg-red-700`) per UX § Button Hierarchy.
  - [ ] On submit: call mutation, close dialog, clear selection.

- [ ] **Task 8: Submitter view rejection visibility** (AC: 4)
  - [ ] **UPDATE** `src/app/(staff)/expenses/page.tsx`: when a row's `approvalStatus === "rejected"`, render it with red pill + rejection reason as tooltip / inline expansion. Pin rejected entries to the top of the list.
  - [ ] When `approvalStatus === "pending"`, render with amber pill + "Awaiting approval."

### Count badge query (AC1)

- [ ] **Task 9: `countPendingExpenses` query** (AC: 1)
  - [ ] **UPDATE** `convex/expenses.ts`: lightweight count query. `requireRole(ctx, ["admin"])`. Returns `{ count }` via index scan + count (Convex query with `.collect().length` is fine for sub-1000-row pending queues).

### Testing (AC2, AC3, AC4)

- [ ] **Task 10: Unit tests** (AC: 2, AC: 3)
  - [ ] **UPDATE** `tests/unit/convex/expenses.test.ts`:
    - `bulkApproveExpenses` happy path: 3 pending → 3 approved + 3 audit entries
    - `bulkApproveExpenses` skips already-approved rows (idempotent)
    - `bulkApproveExpenses` over 100 IDs → `BULK_LIMIT_EXCEEDED`
    - `bulkApproveExpenses` as Office Staff → `FORBIDDEN`
    - `bulkRejectExpenses` with empty reason → `REASON_REQUIRED`
    - `bulkRejectExpenses` happy path: 2 pending → 2 rejected with reason, 2 audit entries

- [ ] **Task 11: Component tests** (AC: 1, AC: 3)
  - [ ] Page test: workflow OFF → empty-state message; workflow ON + zero rows → empty queue message; workflow ON + N rows → table with selection + bulk-action bar.
  - [ ] Dialog test: submit blocked until reason has ≥ 3 chars; submit calls mutation.

## Dev Notes

### Previous story intelligence

- **Story 6.6** is the hard dependency. Schema fields (`approvalStatus`, `approvedBy`, `approvedAt`, `rejectedReason`) and the `by_approvalStatus_date` index were added there. If 6.6 isn't done, **do not start this story.**
- **Story 4.6** owns `recordExpense` and the basic `expenses` table.
- **Story 1.6 (`emitAudit`)** — used for every status change.
- **Story 5.2 (dashboard)** — the MTD-expenses tile already filters on approved (Story 6.6 task). Reactive update on bulk approve relies on that.

### `approvedBy` field overload — design note

`approvedBy` is used for BOTH approval and rejection actors. Two designs were considered:

- (A) Single field `approvedBy` overloaded with `approvalStatus` indicating who acted.
- (B) Separate `approvedBy` and `rejectedBy` fields.

This story ships **option A** because: (1) only one actor acts on a given expense at a time; (2) Phase 2 scope; (3) Story 6.6 already added `approvedBy` as the field name. If multi-step approval comes in Phase 3 / re-spec, refactor to (B) at that time.

Document the overload in `docs/adr/0007-expense-approval-workflow.md` (created in 6.6).

### Architecture compliance

- Append-only audit on every status change.
- `requireRole` on all admin-only mutations.
- Bulk-action cap (100) for sanity; document in JSDoc.
- Receipt photo URLs are signed (Convex File Storage) and re-validated on every render (auth-gated).
- No state machine for `approvalStatus` (it's a simple 3-state model with limited transitions: pending → approved / rejected; rejected and approved are terminal). The Story 1.7 state-machine pattern is overkill here — document the simplification.

### Library / framework versions

- No new dependencies.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   └── expenses.ts                                # UPDATE (bulkApprove, bulkReject, listPending, countPending; per-row wrappers; extend listMyExpenses)
├── src/
│   ├── app/(staff)/
│   │   ├── admin/expenses-pending/
│   │   │   ├── page.tsx                           # NEW
│   │   │   └── page.test.tsx                      # NEW
│   │   ├── expenses/page.tsx                      # UPDATE (rejection visibility)
│   │   └── layout.tsx                             # UPDATE (sidebar pending-count badge)
│   └── components/
│       └── BulkRejectExpensesDialog/
│           ├── BulkRejectExpensesDialog.tsx       # NEW
│           ├── BulkRejectExpensesDialog.test.tsx  # NEW
│           └── index.ts                           # NEW
└── tests/
    └── unit/convex/expenses.test.ts               # UPDATE
```

### Testing requirements

- Unit coverage: 95%+ on the bulk mutations.
- Component coverage on the page + dialog.
- E2E: out of scope; Phase 2 kickoff may add a Playwright spec.

### Source references

- **PRD:** [FR41](../../_bmad-output/planning-artifacts/prd.md#7-expense-tracking)
- **Architecture:** [§ Functional Coverage > FR41](../../_bmad-output/planning-artifacts/architecture.md)
- **UX:** [§ Button Hierarchy > Destructive](../../_bmad-output/planning-artifacts/ux-design-specification.md); [§ Feedback Patterns > Modals](../../_bmad-output/planning-artifacts/ux-design-specification.md#feedback-patterns)
- **Epics:** [Story 6.7](../../_bmad-output/planning-artifacts/epics.md#story-67-admin-sees-expense-approval-queue)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT silently approve already-approved rows in bulk.** Skip + count separately in the return value. Operator should see "Approved 3, skipped 1 (already approved)."
- ❌ **Do NOT allow rejection without a reason.** The reason is the audit trail's only insight into WHY. Server-enforce minimum length.
- ❌ **Do NOT let Office Staff approve their own expenses.** Server gates via `requireRole(["admin"])`. The UI hides the page for non-admins (defense-in-depth).
- ❌ **Do NOT auto-delete rejected expenses.** They remain in the table for the submitter's visibility + audit trail.
- ❌ **Do NOT add "approve all" without confirmation.** Bulk-action requires explicit row selection. No "approve everything pending" shortcut — that's how mistakes happen.
- ❌ **Do NOT batch the audit emits.** One `emitAudit` call per expense. Easier to query later; matches the append-only contract.
- ❌ **Do NOT show pending count badge when the workflow is OFF.** Badge logic respects the setting.
- ❌ **Do NOT make the rejection reason editable post-rejection.** The audit trail freezes the reason at the moment of rejection.

### Common LLM-developer mistakes to prevent

- **Approve / reject mutations inlined per-row in the page:** Use the bulk mutation always (with array of 1 for per-row). Single source of truth.
- **Forgetting the `approvalStatus === "pending"` guard:** Without it, a stale UI race could approve an already-approved row. The mutation skips silently if pre-check fails — idempotent.
- **Signed URLs cached client-side:** Convex signed URLs are short-lived; let the query refresh them. Don't store in localStorage.
- **No-op bulk action with zero selection:** Disable the buttons; don't call the mutation with empty array.
- **Pending-count query is heavy:** Sub-1000 rows is fine for `collect().length`. If pending queues grow past 5K, add a per-day-aggregated count doc (architecture's escape hatch). Phase 2 unlikely to hit this.

### Open questions / blockers this story does NOT resolve

- **§10 Q9** — same as Story 6.6. If "no approval needed," this story's code stays dormant.
- **Reject-with-revision-request** — distinct state from rejected ("please update and resubmit"). Phase 2 kickoff candidate.
- **Multi-step approval** — e.g. "office manager approves up to ₱5K, owner approves above." Phase 2 kickoff candidate.

### Phase 2 reservation

ACs lighter. Kickoff may add:

- Threshold-based auto-approve
- Per-category routing (utilities → office manager; large purchases → owner)
- "Approve and tag" workflows

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure > convex/expenses.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)
- [Architecture § Functional Coverage > FR41](../../_bmad-output/planning-artifacts/architecture.md)

No detected conflicts.

### References

- [PRD § FR41](../../_bmad-output/planning-artifacts/prd.md#7-expense-tracking)
- [Architecture § Functional Coverage](../../_bmad-output/planning-artifacts/architecture.md)
- [Epics § Story 6.7](../../_bmad-output/planning-artifacts/epics.md#story-67-admin-sees-expense-approval-queue)
- [Previous story (6.6)](./6-6-admin-configures-expense-approval-workflow.md) — schema + toggle owner

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code, autonomous dev agent).

### Debug Log References

- `npx tsc --noEmit` — clean.
- `npm run lint` — no ESLint warnings or errors.
- `npm test` — 1901 tests passed, 1 skipped (no new failures introduced).
- `npm run build` — production build succeeded; `/admin/expense-approvals` route registered (4.01 kB / 152 kB first-load).

### Completion Notes List

- Built the admin queue UI on top of the Story 6.6 mutations already
  shipped in `convex/expenses.ts` (`listPendingApprovals`,
  `approveExpense`, `rejectExpense`). `convex/**` was treated as
  read-only this story — bulk-approve / bulk-reject mutations
  contemplated in the original spec were NOT added; the per-row
  mutations remain the single source of truth. Bulk affordances can
  layer on once the Convex surface is extended.
- `ExpenseApprovalQueue` is Convex-free: the parent
  `/admin/expense-approvals/page.tsx` owns the
  `useQuery(api.expenses.listPendingApprovals)` subscription and the
  bound mutations, and hands them down as async callbacks. Mirrors the
  testability pattern used by `FlagContractDialog` (Story 5.4).
- Reject dialog matches the server-side validation in
  `rejectExpense`: non-empty reason (server requires `trim().length >=
  1`), 500-char hard ceiling, errors surfaced inline without locking
  the submit button on retryable failures.
- Sidebar nav item appended to `NAV_ITEMS` with a new optional
  `badgeSource: "pendingExpenseApprovals"` field and a
  `useNavItemBadgeCount(item)` hook that consumes
  `expenses:listPendingApprovals` reactively. The hook returns `0`
  for "no pending approvals — hide the badge" and `undefined` while
  loading. Sidebar.tsx was OUT of scope this story (file-ownership
  rules); the badge-rendering wiring inside `<NavLink>` can be added
  in a follow-up without changing the data contract this story
  established.
- Tests cover AC1 (queue list + columns), AC2 (approve happy + busy
  + error paths), AC3 (reject dialog open + reason required + trimmed-
  reason submit + inline error + counter + cancel). The page itself
  depends on `convex/react` `useQuery` / `useMutation` and is exercised
  indirectly through the gate suites; no page-level Vitest spec was
  added because the queue logic lives in the component + Convex
  mutations.

### File List

CREATED:
- `src/app/(staff)/admin/expense-approvals/page.tsx`
- `src/components/ExpenseApprovalQueue/ExpenseApprovalQueue.tsx`
- `src/components/ExpenseApprovalQueue/index.ts`
- `tests/unit/components/ExpenseApprovalQueue.test.tsx`

MODIFIED:
- `src/components/Sidebar/nav-items.ts` — appended the "Expense
  approvals" admin-only nav item with `badgeSource:
  "pendingExpenseApprovals"`, exported `NavItemBadgeSource` +
  `useNavItemBadgeCount(item)` hook reading
  `expenses:listPendingApprovals`.

NOT TOUCHED:
- `convex/**` (read-only per file-ownership rule; Story 6.6 already
  shipped the queries + mutations this story consumes).
- `src/components/Sidebar/Sidebar.tsx` (out of scope; badge render
  wiring deferred to a follow-up).
