# Story 4.7: Admin Manages Expense Categories

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-system. -->

## Story

As **Mr. Reyes (Admin/Owner)**,
I want **to define and edit the list of expense categories the cemetery uses, including the ability to deactivate stale categories without losing the historical expense records that reference them**,
so that **the cemetery's expense taxonomy matches actual operations, reports group correctly, and §10 Q8's category list is no longer a placeholder** (FR40).

This story is the **swap target** for Story 4.6's banner. Story 4.6 introduced expense recording with a hardcoded `DEFAULT_EXPENSE_CATEGORIES` constant + a "categories pending §10 Q8" banner. THIS story implements the admin-managed `expenseCategories` table and swaps the implementation of the `getActiveCategories` + `assertValidCategory` helpers from constant-based to DB-backed. The form (Story 4.6) does not change — same calling code, different source.

The **deactivate-not-delete pattern** is the architectural backbone here. Existing expenses reference categories by string name. If the admin deletes "Utilities," the historical expense from 3 months ago would orphan. Solution: categories have an `isActive` boolean. Deactivated categories are hidden from new-entry dropdowns but remain queryable for historical reports. Deletion is only allowed if no expenses reference the category — same pattern as Story 1.8's lot retirement rule.

## Acceptance Criteria

1. **AC1 — Admin lists, creates, and edits categories at `/admin/expense-categories`**: An admin (only — `requireRole(["admin"])`) sees a list of all categories sorted by `name` ascending, with active categories first then inactive. Columns: name, description (optional), status (Active/Inactive), # expenses linked, actions. A "New category" button at the top opens a Dialog to create a new category (fields: name required + max 50 chars + unique case-insensitive, description optional + max 200 chars). Each row has "Edit name/description" + "Deactivate" (or "Reactivate") actions; Admin role required for all.

2. **AC2 — Category schema + DB-backed helper swap**: A new `expenseCategories` table with `name: v.string()`, `description: v.optional(v.string())`, `isActive: v.boolean()`, `createdBy: v.id("users")`, `createdAt: v.number()`. Indexed on `.index("by_name", ["name"])` (for uniqueness check + lookups). The `convex/lib/expenseCategories.ts` helpers from Story 4.6 (`getActiveCategories`, `assertValidCategory`) are swapped from reading the hardcoded constant to querying the table. The ExpenseForm (Story 4.6) consumes the same API and just sees a different result; no UI change required in the form. The "pending §10 Q8" banner from 4.6 disappears once the table has rows.

3. **AC3 — Initial seed runs once and aligns with Story 4.6's defaults**: A one-time internal mutation `seedDefaultExpenseCategories` populates the `expenseCategories` table with the same 5 defaults from Story 4.6 (`"Utilities"`, `"Maintenance"`, `"Supplies"`, `"Salaries"`, `"Other"`) if the table is empty. Idempotent: re-running has no effect once rows exist. Invoked manually via `npx convex run seed:seedDefaultExpenseCategories` after schema deploy, OR optionally via a deployment hook (developer choice; default to manual to avoid surprises).

4. **AC4 — Deactivate-not-delete preserves historical references**: Clicking "Deactivate" on a category that has linked expenses sets `isActive: false`; existing expenses continue to render their category name in historical reports (Phase 2 reports + Story 4.6's list page); new ExpenseForm submissions exclude this category from the dropdown. Reactivation flips `isActive: true`.

5. **AC5 — Delete is allowed only if no expenses link to the category**: A "Delete" action (only visible when the category has 0 linked expenses) hard-removes the category from the table. If any expense links, the action is disabled with a tooltip: "Cannot delete — N expenses reference this category. Deactivate to hide from new entries while preserving history."

6. **AC6 — Name uniqueness is enforced case-insensitive**: Creating or renaming a category to a name that already exists (case-insensitive, trimmed) → `ConvexError("DUPLICATE_CATEGORY_NAME", "A category with this name already exists.")`. Inline form validation surfaces this before the user clicks save. The uniqueness check considers BOTH active and inactive categories (can't have two "Utilities" categories even if one is deactivated).

7. **AC7 — Audit emission on every change**: Each create/update/deactivate/reactivate/delete emits an `emitAudit` entry with the appropriate action code and before/after state. Category changes are operationally significant (they affect how reports group) so the audit trail captures who changed what.

## Tasks / Subtasks

### Schema + helper swap (AC2, AC3, AC6)

- [ ] **Task 1: Add `expenseCategories` table to `convex/schema.ts`** (AC: 2)
  - [ ] Fields: `name: v.string()` (1–50 chars), `description: v.optional(v.string())` (max 200 chars), `isActive: v.boolean()`, `createdBy: v.id("users")`, `createdAt: v.number()`, `lastModifiedAt: v.optional(v.number())`, `lastModifiedBy: v.optional(v.id("users"))`.
  - [ ] Indexes:
    - `.index("by_name_lowercased", ["nameLowercased"])` — store a denormalized lowercased name for case-insensitive uniqueness lookup. Add `nameLowercased: v.string()` to the schema as the indexed field, derived from `name.trim().toLowerCase()` on every write.
    - `.index("by_active_name", ["isActive", "name"])` — for the list page's "active first, then inactive, sorted by name" rendering.
  - [ ] Reserve room for future ordering (drag-to-reorder): `displayOrder: v.optional(v.number())` defaulting to 0 — Phase 2 enhancement; harmless to ship now.

- [ ] **Task 2: Swap `convex/lib/expenseCategories.ts` helper implementations** (AC: 2)
  - [ ] Replace `getActiveCategories(ctx)` body: was returning `DEFAULT_EXPENSE_CATEGORIES`; now queries `expenseCategories.by_active_name` for `isActive: true`, returns array of names sorted by name asc.
  - [ ] Replace `assertValidCategory(ctx, name)` body: was checking against the constant; now queries `expenseCategories` by `nameLowercased: name.trim().toLowerCase()` AND `isActive: true`. Throws `INVALID_CATEGORY` if not found or inactive.
  - [ ] **Keep the `DEFAULT_EXPENSE_CATEGORIES` constant** in the file — used by `seedDefaultExpenseCategories` (Task 3). Mark it as `_DEFAULT_EXPENSE_CATEGORIES` (underscore prefix indicating internal use).
  - [ ] Add JSDoc on the file: "Source of truth for active categories. Backed by the `expenseCategories` table since Story 4.7. Story 4.6's calling code is unchanged."
  - [ ] The ExpenseForm's `getActiveCategories` reactive query (Story 4.6 Task 8) now automatically reflects admin changes to the categories table — no client-side changes needed.

- [ ] **Task 3: Implement `seedDefaultExpenseCategories` internal mutation** (AC: 3)
  - [ ] Location: `convex/seed.ts` (UPDATE — file exists from Story 1.1).
  - [ ] `internalMutation`. Args: `{}`. Idempotent: if `expenseCategories` table has ≥ 1 row, return `{ seeded: false, count: existingCount }` without writing.
  - [ ] Otherwise iterate `_DEFAULT_EXPENSE_CATEGORIES` constant; for each, insert with `isActive: true`, `createdBy: <first admin user>`, `createdAt: Date.now()`. Returns `{ seeded: true, count: 5 }`.
  - [ ] Add invocation note to README setup section: "After first deploy, run `npx convex run seed:seedDefaultExpenseCategories` to populate the default expense categories. Idempotent — safe to re-run."

### Admin CRUD mutations (AC1, AC4, AC5, AC6, AC7)

- [ ] **Task 4: Create `convex/expenseCategories.ts`** (AC: 1)
  - [ ] NEW file (separate domain file per architecture's "one Convex domain per file" rule).
  - [ ] All exported public functions begin with `await requireRole(ctx, ["admin"])` per NFR-S4 + Story 1.2 lint rule.

- [ ] **Task 5: Implement `listExpenseCategories` query** (AC: 1)
  - [ ] Args: `{ includeInactive?: boolean }` (default false; admin list page sets true).
  - [ ] Returns categories with linked-expense counts: for each category, also return `linkedExpenseCount` (computed via small count query against `expenses` table — at small scale ~hundreds of expenses; switch to a maintained counter if it grows to 10k+).
  - [ ] Sort: active first (by `name` asc), inactive after (by `name` asc).
  - [ ] Reactive.

- [ ] **Task 6: Implement `createExpenseCategory` mutation** (AC: 1, AC: 6, AC: 7)
  - [ ] Args: `{ name: string, description?: string }`.
  - [ ] Validate: name trimmed, 1–50 chars; description ≤ 200 chars; no duplicate by `nameLowercased` (case-insensitive, includes inactive).
  - [ ] On duplicate → throw `ConvexError("DUPLICATE_CATEGORY_NAME", ...)`.
  - [ ] Insert with `isActive: true`, `createdBy: callerUserId`, `createdAt: Date.now()`, `nameLowercased: name.trim().toLowerCase()`.
  - [ ] `emitAudit(ctx, { action: "create_expense_category", entityType: "expenseCategory", entityId, before: null, after: { name, description, isActive: true }, reason: null })`.

- [ ] **Task 7: Implement `updateExpenseCategory` mutation** (AC: 1, AC: 6, AC: 7)
  - [ ] Args: `{ categoryId, name?, description? }` (partial update).
  - [ ] If `name` changes: validate uniqueness; throw `DUPLICATE_CATEGORY_NAME` if conflict. Update `nameLowercased` alongside.
  - [ ] **Important:** Renaming the category does NOT rename it on existing expense records. Existing expenses store the category as a string (denormalized at write time) — they keep the old name in their historical record. New expense entries get the new name. This is intentional: financial-history immutability principle. Document this in the dialog: "Renaming this category will not change how it appears on past expenses."
  - [ ] `emitAudit` with before/after diff.

- [ ] **Task 8: Implement `setExpenseCategoryActive` mutation** (AC: 4, AC: 7)
  - [ ] Args: `{ categoryId, isActive: boolean }`.
  - [ ] Update only `isActive`.
  - [ ] `emitAudit` with action `"deactivate_expense_category"` or `"reactivate_expense_category"`.

- [ ] **Task 9: Implement `deleteExpenseCategory` mutation** (AC: 5, AC: 7)
  - [ ] Args: `{ categoryId }`.
  - [ ] Pre-check: query `expenses` for any record with this category name → if count ≥ 1 → throw `CANNOT_DELETE_CATEGORY_WITH_EXPENSES`.
  - [ ] Hard-delete the row.
  - [ ] `emitAudit` with action `"delete_expense_category"`, before: { name, description, isActive }.

### Admin UI (AC1, AC4, AC5, AC6)

- [ ] **Task 10: Build `/admin/expense-categories` page** (AC: 1)
  - [ ] Location: `src/app/(staff)/admin/expense-categories/page.tsx`.
  - [ ] Server component does role check (`admin` only — middleware redirects others); renders client component for the interactive table.
  - [ ] Layout: page title "Expense Categories" + "New category" primary button. Below: table of `useQuery(api.expenseCategories.listExpenseCategories, { includeInactive: true })`.
  - [ ] Each row: name (with description below as muted text if present), `StatusPill` for active/inactive (uses existing palette — emerald-50/text-emerald-900 for "Active", zinc-100/text-zinc-600 for "Inactive"), linked-expense count, actions ("Edit", "Deactivate"/"Reactivate", "Delete" — only shown when count = 0).
  - [ ] Empty state: "No expense categories defined yet. Click 'New category' to add the first one, OR run the seed mutation to populate defaults."

- [ ] **Task 11: Build the `CategoryEditDialog` component** (AC: 1, AC: 6)
  - [ ] Location: `src/components/ExpenseCategoryManager/CategoryEditDialog.tsx`.
  - [ ] shadcn/ui `<Dialog>` with title "New category" or "Edit category" depending on mode (`create` vs `edit`).
  - [ ] React Hook Form + Zod schema:
    ```ts
    const schema = z.object({
      name: z.string().trim().min(1, "Name is required").max(50, "Name too long (max 50 characters)"),
      description: z.string().trim().max(200, "Description too long (max 200 characters)").optional().or(z.literal("")),
    });
    ```
  - [ ] Inline duplicate-name check on blur: debounced (200ms) call to `useQuery(api.expenseCategories.checkNameAvailability, { name })` — if duplicate, surface inline below the field: "A category with this name already exists." Submit button disabled.
  - [ ] On edit mode, the dialog shows the warning: "Renaming this category does not change how it appears on past expenses."
  - [ ] On submit: call `createExpenseCategory` or `updateExpenseCategory` mutation; on success close dialog; on error surface inline.

- [ ] **Task 12: Implement `checkNameAvailability` query** (AC: 6)
  - [ ] Args: `{ name: string, excludeCategoryId?: Id<"expenseCategories"> }`.
  - [ ] `requireRole(["admin"])`.
  - [ ] Returns `{ available: boolean }`. Looks up `nameLowercased`; if found AND not matching `excludeCategoryId`, returns `{ available: false }`.

- [ ] **Task 13: Wire deactivate/reactivate/delete actions** (AC: 4, AC: 5)
  - [ ] Deactivate button: confirms via a small inline confirmation (NOT a dialog — operationally low stakes): "Deactivate this category? It will be hidden from new expense entries but remain on past records." [Cancel] [Deactivate].
  - [ ] Reactivate: same pattern.
  - [ ] Delete: ONLY visible when linked count = 0. Confirm via Dialog (this IS irreversible): "Delete '{name}'? This category will be permanently removed. This cannot be undone." [Cancel] [Delete].
  - [ ] On confirm, call the respective mutation; reactive query updates the table automatically.

### Update Story 4.6's banner behavior (AC2)

- [ ] **Task 14: Hide the "pending §10 Q8" banner once Story 4.7 ships** (AC: 2)
  - [ ] Story 4.6's ExpenseForm displays a banner using a feature-flag or sentinel ("categories list is hardcoded"). After Story 4.7, this sentinel changes.
  - [ ] Approach: ExpenseForm queries `useQuery(api.expenseCategories.listExpenseCategories, { includeInactive: false })`. If the response indicates "no admin-managed categories yet" (e.g. the table is empty AND the query falls back to defaults), show the banner. Otherwise hide it.
  - [ ] Simpler: have `getActiveCategories` return `{ categories: string[], source: "hardcoded" | "managed" }`. Form shows banner when source = "hardcoded". Once Story 4.7's seed runs (or Admin creates the first category), source flips to "managed" and the banner disappears.
  - [ ] This is a minor UI tweak; document in the dev notes.

### Tests (AC2, AC4, AC5, AC6, AC7)

- [ ] **Task 15: Vitest unit tests for `convex/expenseCategories.ts`** (AC: 6, AC: 7)
  - [ ] Location: `tests/unit/convex/expenseCategories.test.ts`.
  - [ ] Cases:
    - **Happy path:** Admin creates "Insurance" → row inserted; audit emitted; `listExpenseCategories` returns it.
    - **Duplicate (exact case):** Create "Utilities" when it already exists → `DUPLICATE_CATEGORY_NAME`.
    - **Duplicate (different case):** Create "UTILITIES" → also `DUPLICATE_CATEGORY_NAME` (case-insensitive check).
    - **Duplicate (whitespace-trimmed):** Create " Utilities " → same error.
    - **Validation:** Empty name → `INVALID_NAME`. 51-char name → `INVALID_NAME`.
    - **Update:** Rename "Utilities" → "Public Utilities" → succeeds; old expenses still show "Utilities" (verify by querying expenses).
    - **Deactivate:** Set isActive false → `getActiveCategories` no longer includes it; `assertValidCategory` rejects new uses; existing expenses still display the name.
    - **Delete with linked expenses:** Try delete "Maintenance" when 1 expense references it → `CANNOT_DELETE_CATEGORY_WITH_EXPENSES`.
    - **Delete with zero linked:** Create "Test", then delete → succeeds.
    - **Auth:** office_staff role tries to call any mutation → `FORBIDDEN`.

- [ ] **Task 16: Vitest swap-test for `getActiveCategories`** (AC: 2)
  - [ ] Update `tests/unit/convex/lib/expenseCategories.test.ts` (from Story 4.6).
  - [ ] Add a parallel suite that seeds the table and verifies `getActiveCategories` reads from DB. Mark old hardcoded test as "Phase 1 pre-4.7 — keep until removal at the next refactor."
  - [ ] Add a transition test: with table empty → returns hardcoded defaults + `source: "hardcoded"`. After insert → returns DB rows + `source: "managed"`.

- [ ] **Task 17: Playwright E2E spec** (AC: 1, AC: 4, AC: 5)
  - [ ] Location: `tests/e2e/admin-expense-categories.spec.ts`.
  - [ ] Test 1: Admin creates "Insurance" via the New Category dialog; row appears in the list with linked count = 0; Delete button is visible.
  - [ ] Test 2: Admin deactivates "Maintenance" (which has linked expenses); StatusPill changes to Inactive; Delete button is NOT visible (linked count > 0).
  - [ ] Test 3 (cross-flow): After admin deactivates a category, a fresh ExpenseForm at `/expenses/new` no longer offers that category in the dropdown. Existing expenses on `/expenses` still display the deactivated name.

### Documentation

- [ ] **Task 18: README + ADR + Story 4.6 cross-reference** (AC: 2)
  - [ ] No new ADR required (this story applies existing patterns; the "deactivate-not-delete" pattern is generalized in Story 1.8's lot retirement but worth documenting for expenses specifically).
  - [ ] OPTIONAL ADR-0012-expense-category-rename-immutability.md: documents the decision that renaming a category does not retroactively rename it on past expenses (financial-history immutability principle). One short page.
  - [ ] README: add "Admin operations > Expense category management" section with: how to manage categories, how renaming affects historical data, how deactivation differs from deletion, when to use each.
  - [ ] Add a note in Story 4.6's file: "Once Story 4.7 is implemented, the 'pending §10 Q8' banner disappears automatically."

## Dev Notes

### Previous story intelligence

**Direct dependencies — must be implemented first:**

- **Story 1.1** — Auth + admin seeded.
- **Story 1.2** — `requireRole` helper. All `expenseCategories.ts` functions begin with `requireRole(["admin"])`.
- **Story 1.4** — `StatusPill` (used for Active/Inactive in the admin table).
- **Story 1.6** — `emitAudit` (called on every CRUD operation).
- **Story 4.6** — Establishes the `getActiveCategories` + `assertValidCategory` helpers AND the `expenses` table. **This story's primary work is swapping those helpers' implementations from hardcoded to DB-backed.** If 4.6 is not implemented, do not start this story — there's nothing to swap.

**Adjacent dependencies (informational):**

- **Phase 2 Story 6.6 (expense approval workflow)** — does not interact with this story. Categories and approval status are independent concerns.

### Architecture compliance

- **Deactivate-not-delete pattern:** Same architectural family as Story 1.8's lot retirement (`isRetired: boolean`). Historical references preserved; new entries gated.
- **Audit on operational changes:** Even though categories aren't financial-cornerstone entities, changes to the taxonomy have operational and reporting impact. `emitAudit` on every CRUD ensures the "who changed the categories last week?" question has an answer.
- **Case-insensitive uniqueness:** A `nameLowercased` denormalized field + index is the standard pattern for case-insensitive lookup in Convex (no built-in case-insensitive index). Recompute on every write.
- **Historical rename immutability:** Renaming the category in the table does NOT rewrite existing expense records' category strings. The expense's category was captured at write time. This mirrors the architecture's broader immutability principle (receipts, payments, contracts).
- **One Convex domain per file:** `convex/expenseCategories.ts` is separate from `convex/expenses.ts`. Different domain.

### Library / framework versions

No new libraries. Reuses all of architecture-locked stack (Convex, React Hook Form, Zod, shadcn/ui Dialog).

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── expenseCategories.ts                            # NEW — admin CRUD + checkNameAvailability
│   ├── seed.ts                                         # UPDATE — add seedDefaultExpenseCategories
│   ├── schema.ts                                       # UPDATE — add expenseCategories table + indexes
│   └── lib/
│       └── expenseCategories.ts                        # UPDATE — swap implementation from constant → DB
├── src/
│   ├── app/(staff)/admin/expense-categories/page.tsx   # NEW
│   └── components/
│       └── ExpenseCategoryManager/
│           ├── ExpenseCategoryManager.tsx              # NEW (the table)
│           ├── CategoryEditDialog.tsx                  # NEW (the form Dialog)
│           ├── ExpenseCategoryManager.test.tsx         # NEW
│           └── index.ts                                # NEW
├── tests/
│   ├── unit/convex/
│   │   ├── expenseCategories.test.ts                   # NEW
│   │   └── lib/expenseCategories.test.ts               # UPDATE — add swap-tests
│   └── e2e/
│       └── admin-expense-categories.spec.ts            # NEW
├── docs/adr/0012-expense-category-rename-immutability.md  # NEW (optional)
└── README.md                                           # UPDATE — Admin Operations section
```

**Total: 7 NEW files, 4 UPDATE files.**

### Testing requirements

- **NFR-M2** (≥ 90% coverage on financial code) — Expense categories are taxonomy-management, not financial. Target ≥ 85% line coverage on `convex/expenseCategories.ts`.
- **The swap test is critical** — verify that AFTER 4.7 the form's category dropdown updates when admin creates a new category, and the form's banner disappears once a category exists.
- **Cross-flow E2E** (admin deactivates → form excludes → past expenses still show) is the highest-value test in this story.

### Source references

- [PRD § Functional Requirements > FR40 — Admin manages expense categories](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Non-Functional Requirements > NFR-M2 (≥ 90% financial coverage; relaxed to 85% here), NFR-S4 (server RBAC)](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Implementation Patterns > Naming Patterns (camelCase tables, isActive boolean)](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [UX § UX Consistency Patterns > Form Patterns + Modal & Overlay Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#ux-consistency-patterns)
- [Epics § Story 4.7](../../_bmad-output/planning-artifacts/epics.md)
- Previous stories: [1.6](./1-6-audit-log-emission-helper.md) · [1.8](./1-8-office-staff-creates-and-edits-lot-records.md) (lot retirement pattern model) · [4.6](./4-6-office-staff-records-an-operating-expense.md) (the swap target)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT remove the `_DEFAULT_EXPENSE_CATEGORIES` constant from `convex/lib/expenseCategories.ts`.** The seed mutation still uses it. Mark it private (underscore prefix) but keep it.
- ❌ **Do NOT rename existing expenses' category field when the category is renamed.** Financial-history immutability. The historical expense record retains its original category string at write time.
- ❌ **Do NOT cascade delete.** Deleting a category with linked expenses must hard-fail. Soft-deactivate instead.
- ❌ **Do NOT use case-sensitive uniqueness.** "Utilities" and "utilities" are the same category for human purposes. Always normalize via the `nameLowercased` field.
- ❌ **Do NOT add foreign-key constraints from `expenses.category` to `expenseCategories.id`.** Convex doesn't have FK constraints, but more importantly, the denormalized string captures the category at write-time so even if the row is deleted, the expense's display is preserved.
- ❌ **Do NOT skip the seed mutation.** Without seeding, the production deploy starts with an empty category table and Maria can't record any expense (validation fails — no valid categories). The README documents the manual seed invocation; do not assume it's automatic.
- ❌ **Do NOT allow office_staff to manage categories.** Admin-only. Other roles get `FORBIDDEN` from `requireRole`.
- ❌ **Do NOT show the "Delete" button always.** It must be conditional on `linkedExpenseCount === 0`. Otherwise an admin clicks delete on a heavily-used category, hits an error, and develops the muscle memory to ignore validation errors.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use the established `requireRole` + `emitAudit` pattern. Don't write custom auth or audit logic.
- **Wrong helper-swap location:** The swap is in `convex/lib/expenseCategories.ts` (a single file). Don't sprinkle conditional logic across the codebase. The ExpenseForm and assertValidCategory consumers don't change.
- **Wrong table name:** `expenseCategories` (plural, camelCase) per architecture's naming convention.
- **Forgetting the lowercased index:** Without `nameLowercased` + its index, the case-insensitive uniqueness check becomes O(n) full-table-scan and breaks NFR-P4.
- **Wrong audit action codes:** Use consistent verbs: `create_expense_category`, `update_expense_category`, `deactivate_expense_category`, `reactivate_expense_category`, `delete_expense_category`. Don't mix `update` and `edit` for the same operation.
- **Banner-display logic in two places:** The banner-vs-no-banner decision lives in one place — the `getActiveCategories` query's return shape. Don't duplicate the check on the client side.

### Open questions / blockers this story does NOT resolve

- **§10 Q8 — Predefined category list.** This story enables the admin to manage the list, but the actual list values are still TBD via client conversation. Until the client confirms, the defaults from Story 4.6 (`Utilities`, `Maintenance`, `Supplies`, `Salaries`, `Other`) are seeded. The admin UI lets the client edit them in real time once signed off. **Story 4.7 unblocks the categories-managed UX; client confirmation finalizes the actual values.**

### Project-specific environment values

No new env vars. Uses existing Convex deployment `beaming-boar-935`.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/expenseCategories.ts`, `src/app/(staff)/admin/expense-categories/page.tsx` follow the established admin-routes convention.
- [Architecture § Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules) — camelCase plural table name, boolean `isActive` prefix, `createdAt`/`createdBy` time conventions, all consistent.

No conflicts.

### References

All references listed in § Source references above. Primary inputs: Story 4.6 (the swap target), Story 1.6 (audit), Story 1.8 (deactivate-not-delete pattern).

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code dev agent, 2026-05-20).

### Debug Log References

- `npm run typecheck` — no errors in Story 4.7 files. Pre-existing
  `convex/interments.ts` `_storage` type errors (Story 7.4 carryover)
  remain unchanged; their line numbers shifted by ~8 because the new
  `expenseCategories` table re-orders inferred type pretty-printing.
- `npm run lint` — clean for Story 4.7 files. Pre-existing
  `single-h1-per-page` error in `interments/[intermentId]/complete/page.tsx`
  (Story 7.4 carryover) unchanged.
- `npx vitest run tests/unit/convex/expenseCategories.test.ts
  tests/unit/components/ExpenseCategoryForm.test.tsx` — 44 tests pass.
- `npx vitest run tests/unit/convex/expenses.test.ts` — 34 tests pass
  after a one-line mock update (default `ctx.db.query(...)` shape now
  exposes top-level `.first()` so `assertValidCategory`'s bootstrap
  fallback compiles) and the form-banner test now asserts the post-
  4.7 `isPlaceholder: false` shape.
- `npm test` — 1257 tests pass, 1 skip, 1 pre-existing
  `stateMachines.test.ts` failure (Story 7.x carryover, the
  `interment` state-machine entry is missing from
  `TRANSITIONS` — unrelated to this story).
- `npm run test:e2e -- tests/e2e/admin-expense-categories.spec.ts` —
  could not start the Next.js dev server because of the pre-existing
  `interments/[intermentId]/complete/page.tsx` lint blocker. The new
  spec file itself parses cleanly; the four `test.skip(...)` cases
  match the deferral pattern in `record-expense.spec.ts` and
  `admin-user-management.spec.ts` (full happy-path requires the
  test-user seed scheduled for a later Phase 1 story).

### Completion Notes List

- **Bootstrap fallback over an explicit seed mutation.** The story
  spec's Task 3 prescribes a `seedDefaultExpenseCategories` internal
  mutation in `convex/seed.ts`. Two facts shaped the alternative
  approach: (1) `convex/seed.ts` does not exist in the repo today
  (Story 1.1 did not ship that file) and (2) the parent agent's
  file ownership directive does NOT include `convex/seed.ts` in the
  allowed-to-create list. Instead, the runtime helper
  `getActiveCategories` now falls back to
  `_DEFAULT_EXPENSE_CATEGORIES` when the table is empty, and
  `assertValidCategory` accepts the default names while the table is
  unpopulated. This preserves the Phase-1 acceptance criterion
  ("Maria can still record expenses on a fresh deploy") without the
  out-of-scope file. A follow-up story can add the seed mutation
  once `convex/seed.ts` is introduced.
- **`IS_PLACEHOLDER` flipped to `false` permanently.** The story
  spec hints at a dynamic check ("returns true when no DB rows");
  the existing wire shape (`expenses.ts`'s `getActiveCategoriesForForm`
  reads `IS_PLACEHOLDER` as a constant boolean) and the
  read-only constraint on `convex/expenses.ts` forced a static
  swap to `false`. The bootstrap fallback in
  `getActiveCategories` carries the "table is empty" UX (office
  staff can still pick defaults); the banner-vs-no-banner UX is no
  longer needed because the admin owns the taxonomy via
  `/admin/expense-categories` as soon as 4.7 ships.
- **Audit `entityType: "expense"` (not a new `"expenseCategory"`).**
  The `auditLog.entityType` schema validator and
  `convex/lib/audit.ts`'s `AuditEntityType` union do not include
  `"expenseCategory"`. Both files are read-only by the parent
  agent's directive, so all category mutations emit with
  `entityType: "expense"` and the `before/after` payload's
  `kind: "expenseCategory"` field acts as the discriminator. A
  follow-up that adds the dedicated `expenseCategory` entity type
  in both files is straightforward but coordinated with the audit
  cornerstone owners.
- **`DUPLICATE_CATEGORY_NAME` lives in `details.kind`, not the
  `ErrorCode` enum.** Adding a new code requires updating both
  `convex/lib/errors.ts` and `src/lib/errors.ts`; the former is
  read-only here. The discriminator is exposed via
  `error.data.details.kind === "DUPLICATE_CATEGORY_NAME"` so the
  client can surface the inline message. Same pattern applies to
  `CANNOT_DELETE_CATEGORY_WITH_EXPENSES`.
- **`checkNameAvailability` is implemented (Task 12)** but the
  current dialog wires duplicate hints from the live category list
  on the page rather than calling the query through a debounce.
  This is a minor UX optimisation: the page already has the full
  list in memory via `listExpenseCategories`, so the redundant
  reactive subscription would add noise without value. The
  separate query is preserved for any future detached use (e.g.
  the form lifted into another surface).
- **Component folder name follows the parent-agent directive
  (`ExpenseCategoryForm`), not the story spec's
  `ExpenseCategoryManager`.** The parent agent's file ownership
  block explicitly listed `src/components/ExpenseCategoryForm/**`;
  the story spec's older "Manager" naming reflected an earlier
  draft.
- **ADR-0012-expense-category-rename-immutability.md NOT created.**
  Story Task 18 marks it as OPTIONAL; the rename-immutability
  decision is documented inline (file headers + Edit dialog warning
  + audit `before/after` shape). Not load-bearing without a paired
  follow-up that touches financial-history immutability elsewhere.

### File List

**Created:**

- `convex/expenseCategories.ts` — admin CRUD: `listExpenseCategories`,
  `checkNameAvailability`, `createExpenseCategory`,
  `updateExpenseCategory`, `setExpenseCategoryActive`,
  `deleteExpenseCategory`. All gated `requireRole(["admin"])` first
  line; all mutations emit `emitAudit`.
- `src/app/(staff)/admin/expense-categories/page.tsx` — admin list
  page with New / Edit / Deactivate / Reactivate / Delete flows.
- `src/components/ExpenseCategoryForm/ExpenseCategoryForm.tsx` —
  React Hook Form + Zod create/edit form.
- `src/components/ExpenseCategoryForm/schema.ts` — Zod schema +
  size constants.
- `src/components/ExpenseCategoryForm/index.ts` — barrel.
- `tests/unit/convex/expenseCategories.test.ts` — 34 unit tests
  covering CRUD, auth, validation, case-insensitive uniqueness,
  deactivate-not-delete, delete-with-linked-expenses refusal, and
  audit emission on every change.
- `tests/unit/components/ExpenseCategoryForm.test.tsx` — 10
  component tests covering required-name validation, payload
  normalisation, edit-mode warning + pre-fill, duplicate hint
  blocking submit, and server-error translation.
- `tests/e2e/admin-expense-categories.spec.ts` — Playwright
  route-protection smoke + four `test.skip(...)` placeholders for
  the full authenticated flow (deferred behind the test-user seed
  story, matching the project pattern).

**Modified:**

- `convex/schema.ts` — added the `expenseCategories` table with
  `by_nameLowercased` and `by_active_name` indexes; rich field
  docstring documents the deactivate-not-delete + rename-
  immutability principles.
- `convex/lib/expenseCategories.ts` — swapped `getActiveCategories`
  and `assertValidCategory` from hardcoded constant to
  `expenseCategories`-table reads with a hardcoded-defaults
  bootstrap fallback. `_DEFAULT_EXPENSE_CATEGORIES` (underscore-
  prefixed per Story 4.7 § Disaster prevention) preserved for the
  fallback path; `DEFAULT_EXPENSE_CATEGORIES` alias preserved for
  backwards compatibility. `IS_PLACEHOLDER` flipped to `false`.
- `tests/unit/convex/expenses.test.ts` — minor mock update so the
  default `ctx.db.query(...)` shape exposes top-level `.first()`
  (the post-4.7 `assertValidCategory` bootstrap fallback calls it),
  and the form-banner test now asserts `isPlaceholder: false`
  alongside the bootstrap default list.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  flipped Story 4.7 from `ready-for-dev` to `review`;
  `last_updated: 2026-05-18`.
- `_bmad-output/implementation-artifacts/4-7-admin-manages-expense-categories.md`
  — Status `review`; this Dev Agent Record.
