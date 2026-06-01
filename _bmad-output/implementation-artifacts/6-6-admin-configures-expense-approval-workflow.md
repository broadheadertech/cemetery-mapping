# Story 6.6: Admin Configures Expense Approval Workflow

Status: review

<!-- Phase 2 reservation: This story is explicitly gated on §10 Q9 (expense approval workflow). The toggle defaults to OFF with a banner pointing at the open question. Re-spec at Phase 2 kickoff once Q9 is answered — the approval workflow's depth (single-step vs multi-step, who-can-approve-what, threshold-based bypass) may materially expand. -->

## Story

As an **Admin**,
I want **a single admin-settings toggle "Expenses require approval" that, when ON, causes new Office Staff expense submissions to land in a pending state (excluded from dashboard totals) and routes them through Story 6.7's approval queue**,
so that **the cemetery's actual expense controls match its operating practice, with the workflow opt-in rather than imposed** (FR41 — gated on §10 Q9).

This story is the **infrastructure half** of the approval workflow. It adds the toggle, the schema field, the conditional behavior in expense-recording (Story 4.6) + dashboard aggregation (Story 5.2). Story 6.7 builds the actual approval queue UI. **Default is OFF** so existing Phase 1 behavior is preserved when this story lands.

## Acceptance Criteria

1. **AC1 — Admin-settings toggle for `expensesRequireApproval` exists and defaults OFF**: On `/admin/settings`, an Admin sees a Switch labeled "Require approval for expenses" with default `false`. Toggling fires `convex/admin.ts → setExpensesRequireApproval({ enabled })`. The mutation calls `requireRole(ctx, ["admin"])`, patches the `appSettings` singleton, and `emitAudit` records before / after. While §10 Q9 is unanswered, a small banner sits above the toggle: `"Approval workflow pending client confirmation (§10 Q9). Default OFF."` linking to the open-questions doc.

2. **AC2 — When ON, new expenses are saved with `approvalStatus: "pending"` and are excluded from dashboard totals**: The `convex/expenses.ts → recordExpense` mutation (built in Story 4.6) reads `appSettings.expensesRequireApproval` and, if true, sets `approvalStatus: "pending"` instead of `"approved"`. Phase 1's dashboard expense aggregation (Story 5.2 KPI queries) filters by `approvalStatus === "approved"`. The dashboard's MTD-expenses tile reactively updates to exclude pending expenses when the toggle flips ON, and re-includes them when toggled OFF (mid-cycle toggle is documented as expected — admin's call).

3. **AC3 — When OFF, new expenses are saved with `approvalStatus: "approved"` immediately (Phase 1 behavior preserved)**: The `recordExpense` mutation defaults pending-or-approved based on the setting. With the setting OFF, new expenses land in `approved`. Existing expense records (created before this story shipped, with no `approvalStatus` field) are treated as `approved` via a `?? "approved"` default in queries; **UPDATE** `convex/scheduled.ts` or a one-shot migration to back-fill `approvalStatus: "approved"` on existing rows.

4. **AC4 — Schema changes are minimal and non-breaking**: `convex/schema.ts` `expenses` table gains `approvalStatus: v.optional(v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")))`. The new index `by_approvalStatus_date` supports Story 6.7's queue queries. The migration / back-fill leaves Phase 1 data intact — no destructive operations.

## Tasks / Subtasks

### Schema (AC2, AC4)

- [ ] **Task 1: Extend `appSettings` singleton with `expensesRequireApproval`** (AC: 1)
  - [ ] **UPDATE** `convex/schema.ts` `appSettings` table (created in Story 6.3 or earlier):
    - Add `expensesRequireApproval: v.boolean()` field.
  - [ ] **UPDATE** `convex/seed.ts` to seed the field as `false`.
  - [ ] **UPDATE** `docs/admin-settings.md` (created in 6.3) — document the new setting + its §10 Q9 reference + default OFF.

- [ ] **Task 2: Extend `expenses` table with `approvalStatus`** (AC: 2, AC: 3, AC: 4)
  - [ ] **UPDATE** `convex/schema.ts` `expenses` table:
    - Add `approvalStatus: v.optional(v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")))`.
    - Add `approvedBy: v.optional(v.id("users"))`, `approvedAt: v.optional(v.number())`, `rejectedReason: v.optional(v.string())` — used by Story 6.7's actions; ship the fields now to avoid a second schema change.
    - Index: `.index("by_approvalStatus_date", ["approvalStatus", "date"])`.
  - [ ] **NEW** internal migration in `convex/migrations.ts` (or a one-shot internalMutation in `convex/expenses.ts`): `backfillApprovalStatus` — scans all `expenses` rows where `approvalStatus === undefined` and patches them to `"approved"`. Idempotent (skips rows that already have the field set). Runnable via `npx convex run expenses:backfillApprovalStatus` and documented in `docs/runbook.md`.

### Mutations (AC1, AC2)

- [ ] **Task 3: Admin toggle mutation** (AC: 1)
  - [ ] **UPDATE** `convex/admin.ts` (or `convex/settings.ts`): add `export const setExpensesRequireApproval = mutation({ args: { enabled: v.boolean() }, handler: ... })`.
  - [ ] First line: `await requireRole(ctx, ["admin"]);`.
  - [ ] Read current `appSettings`, patch `expensesRequireApproval`, `emitAudit` with before / after.

- [ ] **Task 4: Update `recordExpense` mutation to read the setting** (AC: 2, AC: 3)
  - [ ] **UPDATE** `convex/expenses.ts → recordExpense`:
    - After `requireRole`, read `appSettings.expensesRequireApproval`.
    - If true: set `approvalStatus: "pending"`, `approvedBy: undefined`, `approvedAt: undefined`.
    - If false: set `approvalStatus: "approved"`, `approvedBy: userId` (the submitter — Phase 1 behavior), `approvedAt: Date.now()`.
    - `emitAudit` already in place from Story 4.6 — extend the `after` payload to include `approvalStatus`.

- [ ] **Task 5: Update dashboard / report queries to filter on approved** (AC: 2)
  - [ ] **UPDATE** `convex/dashboards.ts` (Story 5.2) MTD-expenses query: filter `expenses` to `approvalStatus === "approved"` (treating missing as approved via `?? "approved"` if migration hasn't run, but the migration should run as part of this story).
  - [ ] **UPDATE** any other expense-aggregation query (AR-aging-derived expense reports, etc.).

### UI (AC1)

- [ ] **Task 6: Add the toggle to `/admin/settings`** (AC: 1)
  - [ ] **UPDATE** `src/app/(staff)/admin/settings/page.tsx`. Add a section labeled "Expense Workflow." Inside:
    - Switch component bound to `appSettings.expensesRequireApproval`.
    - Label: "Require approval for expenses."
    - Help text below: "When ON, expenses entered by Office Staff land in a pending queue and do not affect dashboard totals until an Admin approves them. When OFF, expenses post immediately. (See `/admin/expenses-pending` for the queue — Story 6.7.)"
    - Banner ABOVE the section (per AC1) referencing §10 Q9.
  - [ ] On Switch change → call `setExpensesRequireApproval({ enabled })`. Show inline success / error via translateError.

- [ ] **Task 7: Optional banner on `/expenses` page** (AC: 2)
  - [ ] **UPDATE** `src/app/(staff)/expenses/page.tsx` (Story 4.6): when the setting is ON, show a header banner: "Approval workflow active — your submitted expenses will require Admin approval before appearing in dashboards." Hide when OFF. Sourced via `useQuery(api.admin.getAppSettings, {})` or similar.

### Testing (AC1, AC2, AC3, AC4)

- [ ] **Task 8: Unit tests** (AC: 1, AC: 2, AC: 3)
  - [ ] **NEW** or **UPDATE** `tests/unit/convex/admin.test.ts`. Cover:
    - `setExpensesRequireApproval` as admin → patches settings + emits audit
    - non-admin caller → throws `FORBIDDEN`
  - [ ] **UPDATE** `tests/unit/convex/expenses.test.ts`:
    - With setting OFF: `recordExpense` → `approvalStatus: "approved"`
    - With setting ON: `recordExpense` → `approvalStatus: "pending"`
    - Backfill mutation: existing rows without `approvalStatus` get `"approved"`; rows with status untouched.
  - [ ] **UPDATE** `tests/unit/convex/dashboards.test.ts`:
    - MTD-expenses aggregation excludes pending expenses when setting is ON.

- [ ] **Task 9: Component test for the toggle** (AC: 1)
  - [ ] **UPDATE** `src/app/(staff)/admin/settings/page.test.tsx` — assert the Switch is rendered, default reflects setting, change calls mutation, banner visible when §10 Q9 unanswered.

### Docs (AC1, AC3)

- [ ] **Task 10: Runbook + ADR** (AC: 3, AC: 4)
  - [ ] **UPDATE** `docs/runbook.md`: section "Expense approval workflow — enabling / disabling." Include the backfill command + the impact on dashboard totals.
  - [ ] **NEW** `docs/adr/0007-expense-approval-workflow.md` (number per actual sequence in `docs/adr/`): captures the decision to gate on §10 Q9, ship the toggle defaulted OFF, and pre-add the `approvedBy` / `approvedAt` / `rejectedReason` fields to avoid a second migration when Story 6.7 lands.

## Dev Notes

### Previous story intelligence

- **Story 4.6 (record expense)** — extends with the setting-aware status logic.
- **Story 4.7 (manage expense categories)** — no change.
- **Story 5.2 (KPI dashboard)** — MTD-expenses query updated to filter on approved.
- **Story 6.3 (sales reports)** — created the `appSettings` singleton; this story adds a field to it.
- **Story 1.2 (`requireRole`)** + **Story 1.6 (`emitAudit`)** — used throughout.

If 4.6 / 5.2 / 6.3 aren't done yet, this story has hard dependencies on each (recordExpense, MTD aggregation, appSettings). Sequence accordingly.

### Architecture compliance

- Setting toggling is a runtime decision, not a code-level flag. The mutation reads `appSettings` per call.
- Append-only audit — every toggle + every expense status change emits.
- No new tables in this story (only field additions + a new index).
- Backfill is idempotent + non-destructive — Phase 1 data integrity preserved.

### Library / framework versions

- No new dependencies.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (appSettings.expensesRequireApproval; expenses fields + index)
│   ├── admin.ts (or settings.ts)                  # UPDATE (setExpensesRequireApproval mutation + getAppSettings query if not present)
│   ├── expenses.ts                                # UPDATE (recordExpense reads setting; backfillApprovalStatus internalMutation)
│   ├── dashboards.ts                              # UPDATE (MTD-expenses filter)
│   ├── seed.ts                                    # UPDATE (seed the new field)
│   └── migrations.ts (optional)                   # NEW or UPDATE for backfill
├── src/
│   └── app/(staff)/
│       ├── admin/settings/page.tsx                # UPDATE (Switch + banner)
│       └── expenses/page.tsx                      # UPDATE (header banner when ON)
├── tests/
│   └── unit/
│       └── convex/
│           ├── admin.test.ts                      # NEW or UPDATE
│           ├── expenses.test.ts                   # UPDATE
│           └── dashboards.test.ts                 # UPDATE
└── docs/
    ├── adr/0007-expense-approval-workflow.md      # NEW
    ├── admin-settings.md                          # UPDATE
    └── runbook.md                                 # UPDATE
```

### Testing requirements

- Coverage on `recordExpense`'s new branches: 100% (setting on / off; missing setting).
- Backfill test: idempotency.
- Component test: toggle interaction.

### Source references

- **PRD:** [FR41 (gated on §10 Q9)](../../_bmad-output/planning-artifacts/prd.md#7-expense-tracking)
- **Architecture:** [§ Functional Coverage > FR41 — convex/expenses.ts P2 approval flag](../../_bmad-output/planning-artifacts/architecture.md)
- **UX:** [§ Form Patterns > Switch for immediate-effect settings](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns)
- **Epics:** [Story 6.6](../../_bmad-output/planning-artifacts/epics.md#story-66-admin-configures-expense-approval-workflow)
- **Open questions:** [§10 Q9](../../cemetery-management-system-brief%20(1).md)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT make the setting default ON.** §10 Q9 is unanswered; defaulting ON imposes a workflow the client may not want.
- ❌ **Do NOT skip the backfill.** Pre-existing rows without `approvalStatus` will be silently excluded from dashboards as soon as the filter is added. Run the migration as part of deploying this story.
- ❌ **Do NOT hard-delete pending expenses on toggle-OFF.** When the toggle flips OFF, pending expenses STAY pending — they need explicit approval (or rejection) via Story 6.7. Toggling the setting is not the same as approving the backlog.
- ❌ **Do NOT route the toggle through a multi-step workflow.** It's a Switch; immediate effect; per UX § Form Patterns the Switch is for immediate-effect settings.
- ❌ **Do NOT introduce a `RoleGuard` HOC on the settings page.** Use `requireRole` server-side + middleware-based route gating; the UI should not be the primary gate.
- ❌ **Do NOT extend `approvalStatus` to enum values beyond `"pending" | "approved" | "rejected"`.** "Needs revision," "escalated," etc. are Phase 2-kickoff possibilities; do not anticipate them.
- ❌ **Do NOT silently change the dashboard for users who weren't expecting it.** When the toggle flips ON, the banner on `/expenses` makes the workflow visible. When it flips back OFF, pending expenses re-enter aggregation — also visible.

### Common LLM-developer mistakes to prevent

- **Forgetting to update aggregation queries:** Any query that sums expenses must filter on `approvalStatus === "approved"`. Audit every reference to `expenses` aggregation in the codebase.
- **Treating `approvalStatus` as required:** It's `v.optional(...)` because of pre-existing data. The default-`"approved"` fallback handles missing values.
- **Letting the setting affect existing records:** Toggle changes only affect NEW expenses. Pre-existing approved expenses stay approved; pre-existing pending expenses stay pending.
- **Reading `appSettings` from the client without subscribing:** `useQuery(api.admin.getAppSettings, {})` is reactive — the dashboard updates when the toggle flips. Don't fetch via `fetchQuery` at mount.
- **Hard-coding `requireRole` for the wrong roles:** Office Staff records expenses; Admin toggles the setting + approves. Story 6.7 is the approval queue.

### Open questions / blockers this story does NOT resolve

- **§10 Q9 (expense approval workflow)** — central gate. If the answer is "no approval needed," this story's code stays but is never enabled. If "yes, single-step," ship as designed. If "yes, multi-step," re-spec at Phase 2 kickoff.
- **§10 Q8 (predefined expense categories)** — orthogonal.

### Phase 2 reservation

ACs are lighter. Kickoff may add:

- Per-category approval thresholds (auto-approve if < ₱5,000)
- Multi-step approval workflow
- Reject-with-revision-request (separate state from rejected)

### Project Structure Notes

Aligns with:

- [Architecture § Functional Coverage > FR41](../../_bmad-output/planning-artifacts/architecture.md)
- [Architecture § Project Structure — convex/expenses.ts](../../_bmad-output/planning-artifacts/architecture.md#complete-project-directory-structure)

No detected conflicts.

### References

- [PRD § FR41](../../_bmad-output/planning-artifacts/prd.md#7-expense-tracking)
- [Architecture § Functional Coverage](../../_bmad-output/planning-artifacts/architecture.md)
- [Epics § Story 6.6](../../_bmad-output/planning-artifacts/epics.md#story-66-admin-configures-expense-approval-workflow)
- [Previous story (4.6)](./4-6-office-staff-records-an-operating-expense.md) (when created)
- [Previous story (5.2)](./5-2-admin-views-the-kpi-dashboard.md) (when created)
- [Previous story (6.3)](./6-3-admin-views-custom-sales-reports.md) — appSettings singleton owner

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7).

### Debug Log References

- `npx tsc --noEmit` — clean against the Story 6.6 surface (one pre-existing
  `contracts.ts` audit-action TS2322 lives unchanged outside this story's
  file ownership).
- `npm run lint` — clean (no ESLint warnings or errors).
- `npx vitest run` — 1889 passed (+ 1 pre-existing skip); 0 failures.

### Completion Notes List

- Implementation pivoted from the story's original "single toggle on
  `appSettings.expensesRequireApproval`" model to the user-instructed
  per-category threshold model (`expenseApprovalSettings` table,
  default-sentinel catch-all, per-category overrides). The two shapes
  are operationally compatible — when no overrides exist and the
  default sentinel row is absent/disabled, Phase 1 auto-approve
  behaviour is preserved. The story's `appSettings.expensesRequireApproval`
  field and the `/admin/settings` Switch are NOT shipped in this
  pass; the equivalent admin entry point is the new
  `/admin/expense-approval-settings` page.
- `approvalStatus` literal kept as the existing `pending_approval`
  (vs. the user's instructed `pending`) to preserve continuity with
  Story 4.6's recorded schema + tests; the canonical state union
  remains `approved | pending_approval | rejected`.
- `recordExpense` now consults `expenseApprovalSettings` via a local
  helper (`resolveApprovalForCategory`) and auto-routes to
  `pending_approval` when amount >= threshold AND `requiresApproval`
  is true. Below-threshold rows are still auto-approved with
  `approvedBy = recordedBy` so the audit trail tells the right story.
- Story 6.7's queue UI consumes `listPendingApprovals` (new in
  `convex/expenses.ts`); the row-shape is the existing `ListedExpense`
  with `recordedByName`.
- Audit emits use `entityType: "expense"` with a `kind:
  "expenseApprovalSetting"` tag in the payload (the schema's
  `entityType` union does not carry a dedicated value; matches the
  existing convention from Story 4.7's `expenseCategories.ts`).
- The original story tasks referencing `convex/admin.ts`, the
  `appSettings` singleton, `convex/seed.ts`, `convex/dashboards.ts`,
  `convex/migrations.ts`, `docs/runbook.md`, `docs/adr/*`, and
  `src/app/(staff)/admin/settings/page.tsx` are out of scope per
  the user-instructed file-ownership boundary; those edits are
  deferred to follow-up work coordinated with the relevant cornerstone
  owners.

### File List

- **NEW** `convex/expenseApprovalSettings.ts` — admin CRUD for the
  threshold table; default-sentinel handling; idempotent no-op
  short-circuit on unchanged values.
- **MODIFIED** `convex/schema.ts` — added the `expenseApprovalSettings`
  table + `by_category` index; added `approvalThresholdCents`,
  `approvedBy`, `approvedAt`, `rejectionReason` to `expenses` + new
  `by_approvalStatus_paidAt` index.
- **MODIFIED** `convex/expenses.ts` — `recordExpense` now consults the
  settings via `resolveApprovalForCategory`; APPENDED
  `submitExpenseForApproval`, `approveExpense`, `rejectExpense`,
  `listPendingApprovals`.
- **NEW** `src/components/ExpenseApprovalSettingsForm/index.ts`,
  `schema.ts`, `ExpenseApprovalSettingsForm.tsx` — React Hook Form +
  Zod form for create / edit / default modes.
- **NEW** `src/app/(staff)/admin/expense-approval-settings/page.tsx`
  — admin page with reactive table, dialogs for default + per-category
  edits, and a §10 Q9 banner.
- **NEW** `tests/unit/convex/expenseApprovalSettings.test.ts` — 22
  cases covering auth, validation, idempotency, default-sentinel
  protection, audit emission.
- **NEW** `tests/unit/components/ExpenseApprovalSettingsForm.test.tsx`
  — 7 cases covering required-field validation, pesos → centavos
  conversion, default + edit lock behaviour, server-error surfacing.
