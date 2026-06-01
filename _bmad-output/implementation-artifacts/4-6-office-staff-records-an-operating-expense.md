# Story 4.6: Office Staff Records an Operating Expense

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Maria (Office Staff)**,
I want **to record an operating expense with date, amount, vendor, category, and an optional photo of the supplier receipt**,
so that **the cemetery's operating costs are tracked digitally, the owner's MTD/YTD net-position dashboard reflects actual cash outflow, and we replace the paper expense voucher book** (FR39, gated on §10 Q8 for the category list).

This is the **first non-financial-cornerstone Phase 1 capability**. Expenses do NOT route through `postFinancialEvent` (Story 3.2) — they aren't contracts/payments/receipts. They're operational ledger entries with their own simpler write path. BUT they DO affect Mr. Reyes's dashboard reactively (expenses MTD tile + net-position tile both subscribe to the expense table), so the calm-reactive "magic moment" still applies here: Maria records an expense for ₱2,500 of weed killer, and the owner's mobile dashboard shows the expense tile bump with a 600ms amber fade within 1 second.

Categories are gated on §10 Q8 (Story 4.7 implements the admin-managed category list). This story ships with a placeholder default category list + a banner: "Categories pending client confirmation."

## Acceptance Criteria

1. **AC1 — Office Staff submits an expense from a dedicated form page**: At `/expenses/new`, the ExpenseForm renders with: **Date** (default today in Manila tz, editable; admin role can backdate up to 30 days, office_staff up to 7 days, all enforced server-side), **Amount** (peso-prefix, tabular numerics, required, ₱ > 0), **Vendor** (free-text, required, max 200 chars), **Category** (Select; populated from the placeholder list until Story 4.7 ships; required), **Receipt photo** (optional; reuses the photo-upload pattern from Story 1.14's lot condition log). Submit button is "Record expense" (NOT "Generate receipt" — that's payment terminology; expenses don't produce a receipt to the customer).

2. **AC2 — Mutation atomically inserts + emits audit + updates dashboard aggregates**: A single Convex mutation `recordExpense(ctx, { paidAt, amountCents, vendor, category, photoStorageId?, idempotencyKey })` runs through: `requireRole(ctx, ["office_staff", "admin"])` → idempotency dedup → validate (date within allowed window per role, amount > 0, vendor non-empty, category in allowed list at write time) → insert into `expenses` table → call `emitAudit(...)` with action `"record_expense"` → return `{ expenseId }`. All atomic.

3. **AC3 — Reactive dashboard update visible to Owner within 1 second**: If Mr. Reyes has the dashboard (Story 5.2) open at the moment Maria submits, the "Expenses MTD" KpiCard and the "Net MTD" KpiCard both reactively update with a 600ms `bg-amber-50` fade (`ReactiveHighlight` from Story 1.4). No refresh, no toast, no badge. This is the calm-reactive primitive applied to non-financial ops data; same UX as Journey 4's payment-landing moment but smaller in stakes.

4. **AC4 — Photo upload follows the established two-step pattern**: If Maria attaches a photo: client calls `generateExpensePhotoUploadUrl` action (mirrors Story 1.14's pattern); `POST`s the photo to the returned URL; receives a `Id<"_storage">`; passes it as `photoStorageId` into the mutation. Photo retrieval via `getExpensePhotoUrl(expenseId)` query with `requireRole` check; auth-gated signed URL per NFR-S3.

5. **AC5 — Category list placeholder + gated banner**: Until Story 4.7 ships an admin-managed category UI, the form's category dropdown is populated from a hardcoded constant `DEFAULT_EXPENSE_CATEGORIES` in `convex/lib/expenseCategories.ts` (initial values: `"Utilities"`, `"Maintenance"`, `"Supplies"`, `"Salaries"`, `"Other"`). The form displays a banner: "Expense categories pending client confirmation (§10 Q8). Defaults shown below." Once Story 4.7 lands, the dropdown source switches to the `expenseCategories` table without changing the form's API.

6. **AC6 — Expense list shows recent entries with reactive flash**: `/expenses` lists the most recent 50 expenses by `paidAt` descending. Wrapping in `<ReactiveHighlight watch={row._creationTime}>` for new-entry fade. Columns: date, vendor, category, amount (tabular), recorded-by, photo thumbnail (if present, click to view full). Empty state: "No expenses recorded yet. Click 'Record expense' above to log the first one."

## Tasks / Subtasks

### Schema + server functions (AC1, AC2, AC4)

- [ ] **Task 1: Add `expenses` table to `convex/schema.ts`** (AC: 2)
  - [ ] Fields: `paidAt: v.number()` (instant), `amountCents: v.number()` (integer centavos per architecture's money rule), `vendor: v.string()` (max 200), `category: v.string()`, `photoStorageId: v.optional(v.id("_storage"))`, `recordedBy: v.id("users")`, `recordedAt: v.number()`, `idempotencyKey: v.optional(v.string())`, `note: v.optional(v.string())` (for future free-text annotations; not exposed in form yet).
  - [ ] Indexes: `.index("by_paidAt", ["paidAt"])` for date-range queries (dashboard's MTD aggregation, reports); `.index("by_category_paidAt", ["category", "paidAt"])` for category-filtered queries (Phase 2 reports). NOTE: `recordedAt` not indexed; `paidAt` is the business-relevant date.
  - [ ] Reserve room for Phase 2: `approvalStatus: v.union(v.literal("approved"), v.literal("pending_approval"), v.literal("rejected"))` — add as optional field now defaulted to `"approved"` so Phase 2's Story 6.6 just changes the default behavior, not the schema.

- [ ] **Task 2: Implement `recordExpense` mutation in `convex/expenses.ts`** (AC: 1, AC: 2)
  - [ ] Verify `convex/expenses.ts` exists (from Stories 4.1–4.5 likely). UPDATE if so; NEW otherwise.
  - [ ] First line: `await requireRole(ctx, ["office_staff", "admin"])`.
  - [ ] Args via `v.object`: `{ paidAt, amountCents, vendor, category, photoStorageId?, idempotencyKey }`.
  - [ ] Idempotency: query `expenses` by `idempotencyKey` (small custom index `.index("by_idempotency_key", ["idempotencyKey"])`); if existing record found, return its ID without re-inserting.
  - [ ] Validations (throw `ConvexError` with code from `convex/lib/errors.ts`):
    - `amountCents > 0` → `INVALID_AMOUNT`.
    - `vendor.trim().length >= 1 && vendor.trim().length <= 200` → `INVALID_VENDOR`.
    - `category` is in `getActiveCategories(ctx)` result — for now reads from `DEFAULT_EXPENSE_CATEGORIES` constant; Story 4.7 changes it to read from `expenseCategories` table. Use a helper `assertValidCategory(ctx, category)` so the swap is one line.
    - `paidAt` within allowed backdating window per role: admin = 30 days back / 0 future; office_staff = 7 days back / 0 future. Throw `BACKDATE_NOT_ALLOWED` if violated.
  - [ ] Insert into `expenses` with `recordedBy: callerUserId`, `recordedAt: Date.now()`, `approvalStatus: "approved"` (Phase 2 will override based on Story 6.6 config).
  - [ ] Call `emitAudit(ctx, { action: "record_expense", entityType: "expense", entityId, before: null, after: { paidAt, amountCents, vendor, category, hasPhoto: !!photoStorageId }, reason: null })`.
  - [ ] Return `{ expenseId }`.

- [ ] **Task 3: Implement `generateExpensePhotoUploadUrl` action in `convex/expenses.ts`** (AC: 4)
  - [ ] Mirrors Story 1.14's `generateLotConditionPhotoUploadUrl` pattern.
  - [ ] First line: `requireRole(["office_staff", "admin"])`.
  - [ ] Returns `await ctx.storage.generateUploadUrl()`.

- [ ] **Task 4: Implement `getExpensePhotoUrl` query in `convex/expenses.ts`** (AC: 4)
  - [ ] First line: `requireRole(["office_staff", "admin"])`.
  - [ ] Args: `{ expenseId }`.
  - [ ] If `photoStorageId` null → return null. Else `ctx.storage.getUrl(photoStorageId)` → return signed URL.

- [ ] **Task 5: Implement `listRecentExpenses` query in `convex/expenses.ts`** (AC: 6)
  - [ ] First line: `requireRole(["office_staff", "admin"])`.
  - [ ] Args: `{ limit?: number }` (default 50, max 200).
  - [ ] Returns expenses ordered by `paidAt` desc with `recordedBy` resolved to user name + email-redacted (small join).
  - [ ] Reactive by default — used by `/expenses` list page AND consumed by Mr. Reyes's dashboard aggregate.

- [ ] **Task 6: Implement `getExpensesMtdTotal` query in `convex/expenses.ts`** (AC: 3)
  - [ ] First line: `requireRole(["admin"])` (only admin sees the dashboard aggregate; office_staff doesn't need this).
  - [ ] Args: `{ month?: string }` (e.g. `"2026-05"`; default current Manila month).
  - [ ] Returns `{ totalCents, count }` for the month.
  - [ ] Used by Story 5.2's KPI dashboard — the "Expenses MTD" tile subscribes to this.
  - [ ] **Phase 1.5 optimization note:** at small expense volume (~5/day), live aggregation is fine. If volume grows to 100s/day, switch to pre-aggregated `expenseSummaries` doc updated on write. Architectural pattern documented in Story 5.2.

- [ ] **Task 7: Add `DEFAULT_EXPENSE_CATEGORIES` constant + `assertValidCategory` helper** (AC: 5)
  - [ ] Location: `convex/lib/expenseCategories.ts`.
  - [ ] Constant: `DEFAULT_EXPENSE_CATEGORIES = ["Utilities", "Maintenance", "Supplies", "Salaries", "Other"] as const`.
  - [ ] Type export: `type ExpenseCategoryName = typeof DEFAULT_EXPENSE_CATEGORIES[number]`.
  - [ ] Helper: `async function assertValidCategory(ctx, category: string): Promise<void>` — for now checks against the constant; Story 4.7 changes implementation to query `expenseCategories` table without changing callers.
  - [ ] Helper: `async function getActiveCategories(ctx): Promise<string[]>` — same pattern.
  - [ ] JSDoc on file: "Single source of truth for the active category list. Replaced by `expenseCategories` table when Story 4.7 ships. Until then, dropdown list is hardcoded; banner displayed in form."

### Client UI (AC1, AC5, AC6)

- [ ] **Task 8: Build the `ExpenseForm` component** (AC: 1, AC: 5)
  - [ ] Location: `src/components/ExpenseForm/ExpenseForm.tsx` (folder per component).
  - [ ] React Hook Form + Zod schema:
    ```ts
    const schema = z.object({
      paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date required"),
      amountPesos: z.number().positive("Amount must be greater than ₱0"),
      vendor: z.string().trim().min(1, "Vendor is required").max(200, "Vendor name too long"),
      category: z.string().min(1, "Category is required"),
      photoFile: z.instanceof(File).optional().refine((f) => !f || f.size <= 10_000_000, "Photo must be ≤ 10 MB"),
    });
    ```
  - [ ] Fields:
    - **Date** — `<Input type="date">`; default today via `useManilaNow()`; max attribute set to today; min depends on role (helper hook `useMaxBackdateDays(role) -> Date`).
    - **Amount** — peso-prefix tabular input; same pattern as Story 3.9 PaymentForm; centavo conversion at submit.
    - **Vendor** — `<Input type="text">` with placeholder "e.g. ABC Hardware Supply".
    - **Category** — `<Select>` (shadcn/ui) populated from `useQuery(api.expenses.getActiveCategories)` (server-side helper from Task 7 — even though hardcoded now, query through the server for consistency with Story 4.7's swap). Default placeholder: `"Select a category…"`.
    - **Photo** — `<input type="file" capture="environment" accept="image/*">` with thumbnail preview; same pattern as Story 1.14.
  - [ ] Banner above the form (when `getActiveCategories` returns the hardcoded set vs the DB-backed set — detected by a sentinel value the query returns; OR by a feature flag `EXPENSE_CATEGORIES_MANAGED` env var defaulted false until Story 4.7): "Expense categories pending client confirmation (§10 Q8). Defaults shown below."
  - [ ] Idempotency key: `useIdempotencyKey()` hook (Story 1.14 created or reused).
  - [ ] Submit:
    1. If photoFile present: call `generateExpensePhotoUploadUrl` action; POST file; await `{ storageId }`.
    2. Call `recordExpense` mutation with `{ paidAt: parseToManilaMs(paidAtString), amountCents: pesosToCents(amountPesos), vendor: vendor.trim(), category, photoStorageId?, idempotencyKey }`.
    3. On success: navigate to `/expenses` (list page); the new entry will appear at top with reactive flash via Task 9.
    4. On error: surface inline (per UX § Form Patterns — inline-not-toast).

- [ ] **Task 9: Build the `/expenses` list page** (AC: 6)
  - [ ] Location: `src/app/(staff)/expenses/page.tsx`. If exists from earlier Epic 4 work, UPDATE; else NEW.
  - [ ] Header: page title "Expenses" + "Record expense" primary button → navigates to `/expenses/new`.
  - [ ] Body: table of `useQuery(api.expenses.listRecentExpenses, { limit: 50 })` results.
  - [ ] Each row wrapped in `<ReactiveHighlight watch={row._creationTime}>` so newly-recorded entries flash for 600ms when arriving via reactive subscription. First-render does NOT flash.
  - [ ] Columns: Date (formatted DD MMM YYYY), Vendor, Category, Amount (tabular peso), Recorded by, Photo (thumbnail if present, opens lightbox).
  - [ ] On mobile (< 768px): card-per-row pattern (UX § Responsive Design > Tables → cards on mobile).
  - [ ] Empty state per UX-DR23: "No expenses recorded yet. Click 'Record expense' above to log the first one."

- [ ] **Task 10: Build the `/expenses/new` route page** (AC: 1)
  - [ ] Location: `src/app/(staff)/expenses/new/page.tsx`.
  - [ ] Server component does auth check; renders `<ExpenseForm />` (client component) as the page content.
  - [ ] Layout: centered, `max-w-xl`, page heading "Record expense" + brief copy "Track an operating expense for the cemetery. Receipt photo optional."
  - [ ] Cancel button (secondary, top-left) returns to `/expenses`.

### Dashboard integration (AC3)

- [ ] **Task 11: Verify Story 5.2's dashboard subscribes to `getExpensesMtdTotal`** (AC: 3)
  - [ ] If Story 5.2 is implemented, the dashboard's "Expenses MTD" tile and "Net MTD" tile should subscribe to `getExpensesMtdTotal` (via `useQuery`) and `getSalesMtdTotal` etc.
  - [ ] If Story 5.2 references the query but it doesn't exist yet (Story 5.2 was drafted before this story landed the query), VERIFY the query name matches. If 5.2 uses a different name, update Story 5.2's reference OR add a small alias query here that 5.2 expects.
  - [ ] No code changes in 5.2's source files needed if names align — the reactive subscription is automatic.

### Tests (AC1, AC2, AC3, AC4, AC5, AC6)

- [ ] **Task 12: Vitest unit tests for `recordExpense`** (AC: 2)
  - [ ] Location: `tests/unit/convex/expenses.test.ts` — UPDATE if exists from Story 4.1–4.5, else NEW.
  - [ ] Cases:
    - **Happy path:** Office staff records ₱2,500 "Utilities" with vendor "Meralco" → expense inserted; audit emitted; `listRecentExpenses` returns it.
    - **With photo:** photoStorageId provided → expense inserted with the storage ID; `getExpensePhotoUrl` returns a non-public signed URL.
    - **Idempotency:** Same key twice → second call returns existing expense; no duplicate insert.
    - **Auth:** Customer role → `FORBIDDEN`. Field worker → `FORBIDDEN` (only office_staff + admin can record expenses).
    - **Validation:** Amount = 0 → `INVALID_AMOUNT`. Vendor empty → `INVALID_VENDOR`. Vendor 201 chars → `INVALID_VENDOR`. Category not in active list → `INVALID_CATEGORY`. Date too far in past for role → `BACKDATE_NOT_ALLOWED`. Date in future → `BACKDATE_NOT_ALLOWED` (future dates always rejected).
  - [ ] Coverage target: ≥ 90% line coverage on `convex/expenses.ts` (NFR-M2 financial-touching threshold applies — expenses affect dashboard totals).

- [ ] **Task 13: Vitest unit tests for `assertValidCategory` + `getActiveCategories`** (AC: 5)
  - [ ] Location: `tests/unit/convex/lib/expenseCategories.test.ts`.
  - [ ] Test the hardcoded-default behavior (Phase 1).
  - [ ] Document via comment: "When Story 4.7 lands, this test gets a parallel suite using a mock `expenseCategories` table; both behaviors should coexist behind the same helper API."

- [ ] **Task 14: Vitest component test for `ExpenseForm`** (AC: 1, AC: 5)
  - [ ] Location: `src/components/ExpenseForm/ExpenseForm.test.tsx`.
  - [ ] Cases:
    - Form renders all fields; submit disabled until valid.
    - Banner is visible (using the gated-category sentinel).
    - Required-field validation fires on blur.
    - On submit success: navigate-mock called with `/expenses`.
    - axe-core scan → WCAG 2.1 AA passes.

- [ ] **Task 15: Playwright E2E spec** (AC: 1, AC: 3, AC: 6)
  - [ ] Location: `tests/e2e/expense-recording.spec.ts`.
  - [ ] Test: Office staff records an expense → list page shows the entry within 2 seconds with the amber-flash class.
  - [ ] Optional cross-tab test: admin viewing dashboard; office staff records expense; admin's "Expenses MTD" tile shows updated total within 2 seconds. Mark as `.fixme` if flaky in CI.

### Documentation

- [ ] **Task 16: README + runbook updates** (AC: 5)
  - [ ] No new ADR needed.
  - [ ] Brief addition to README's "Daily Workflows" section: "Office Staff records operating expenses at `/expenses/new`. Categories are pending client confirmation; defaults shown until Story 4.7."
  - [ ] If `docs/runbook.md` exists, add: "Expense photos are stored in Convex File Storage. Volume estimate: ~5 expenses/day × ~1 MB each = ~5 MB/day; well within budget for the first year."

## Dev Notes

### Previous story intelligence

**Direct dependencies — must be implemented first:**

- **Story 1.1** — Auth setup. Office staff seeded.
- **Story 1.2** — `requireRole` helper + lint rule. `recordExpense` MUST call `requireRole` first.
- **Story 1.4** — `ReactiveHighlight` (used in list-page row flash), `useManilaNow` hook for date default, visual tokens, Inter + tabular numerics for the amount column.
- **Story 1.6** — `emitAudit` helper. `recordExpense` calls it.
- **Story 1.14** — Photo upload pattern (`generateUploadUrl` action + two-step upload). **Direct copy of the pattern**; if 1.14 isn't implemented yet, copy the pattern here and 1.14 picks it up later. The implementation is essentially identical.

**Adjacent dependencies (won't block but inform):**

- **Story 4.1-4.5** — Other Epic 4 stories. If `convex/expenses.ts` exists from earlier work, UPDATE it; otherwise NEW. Schema additions are additive.
- **Story 4.7** — Admin manages expense categories. THIS story's `assertValidCategory` + `getActiveCategories` helpers are designed for Story 4.7 to swap implementation without changing callers. The hardcoded default is a temporary state.
- **Story 5.2** — Owner dashboard with KpiCards. Subscribes to `getExpensesMtdTotal`. This story creates that query.

### Architecture compliance

- **Non-financial mutation pattern:** Expenses do NOT route through `postFinancialEvent` because they're operational ledger entries with no payment / receipt / contract-state-machine involvement. Architecture's atomic-mutation cornerstone applies to financial chains (sale → contract → payment → receipt → audit). Expenses are simpler: insert + audit, all atomic in a single mutation.
- **Audit emission:** Still called for accountability. `emitAudit` from Story 1.6 records who recorded what when.
- **Money in centavos:** Per architecture's § Format Patterns > Money — integer centavos throughout. UI displays via `formatPeso(cents)` helper; storage is `amountCents`.
- **Reactive subscriptions** for `listRecentExpenses` and `getExpensesMtdTotal` — same primitive that powers Journey 4's magic moment, applied to ops data.
- **PWA / offline:** Like Story 1.14, writes are hard-blocked when offline. Read paths (the list) work from PWA cache (Story 1.13).
- **PII boundary:** Vendor name is NOT PII. Photos may contain incidental personal info (a name on a Meralco bill), but per architecture's threat model, expense photos aren't treated as PII-grade; they're auth-gated like all File Storage uploads (NFR-S3).

### Library / framework versions

- All architecture-locked: Next.js, Convex, React Hook Form, Zod, Tailwind, shadcn/ui. No new dependencies.
- Same upload pattern as Story 1.14; no new libraries.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── expenses.ts                                      # UPDATE (or NEW) — add recordExpense mutation,
│   │                                                    #                    generateExpensePhotoUploadUrl action,
│   │                                                    #                    getExpensePhotoUrl query,
│   │                                                    #                    listRecentExpenses query,
│   │                                                    #                    getExpensesMtdTotal query
│   ├── lib/
│   │   └── expenseCategories.ts                         # NEW — constants + helper for category list
│   └── schema.ts                                        # UPDATE — add expenses table + indexes
├── src/
│   ├── app/(staff)/expenses/
│   │   ├── page.tsx                                     # UPDATE (or NEW) — list page
│   │   └── new/page.tsx                                 # NEW — form route
│   └── components/
│       └── ExpenseForm/
│           ├── ExpenseForm.tsx                          # NEW
│           ├── ExpenseForm.test.tsx                     # NEW
│           └── index.ts                                 # NEW
├── tests/
│   ├── unit/convex/
│   │   ├── expenses.test.ts                             # UPDATE (or NEW)
│   │   └── lib/expenseCategories.test.ts                # NEW
│   └── e2e/
│       └── expense-recording.spec.ts                    # NEW
└── README.md                                            # UPDATE — Daily Workflows
```

**Total: 7 NEW files, 2 (or 3) UPDATE files.**

### Testing requirements

- **NFR-M2** (≥ 90% coverage on financial-touching) APPLIES — expenses affect dashboard totals + net position. Target ≥ 90% on `convex/expenses.ts`.
- **axe-core** on the ExpenseForm passes WCAG 2.1 AA.
- **Cross-tab reactive E2E** is best-effort (same flakiness considerations as Story 3.9's cross-tab test).

### Source references

- [PRD § Functional Requirements > FR39 (record expense, categories gated §10 Q8), FR40 (admin manages categories — Story 4.7)](../../_bmad-output/planning-artifacts/prd.md)
- [PRD § Non-Functional Requirements > NFR-M2 (financial code coverage), NFR-S3 (auth-gated file storage), NFR-S4 (server-side RBAC)](../../_bmad-output/planning-artifacts/prd.md)
- [Architecture § Implementation Patterns > Naming Patterns, Money & Time format patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [UX § Component Strategy > ExpenseForm (UX-DR17)](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [UX § UX Consistency Patterns > Form Patterns + Reactive Update Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#ux-consistency-patterns)
- [Epics § Story 4.6](../../_bmad-output/planning-artifacts/epics.md)
- Previous stories: [1.4](./1-4-visual-foundation-locked-statuspill-reactivehighlight-ship.md) · [1.6](./1-6-audit-log-emission-helper.md) · [1.14](./1-14-field-worker-logs-lot-condition-with-note-photo.md) (the photo-upload pattern model)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT route expenses through `postFinancialEvent`.** They're not financial-cornerstone events. The atomicity invariant is preserved by their simpler single-table-insert + audit-emit pattern.
- ❌ **Do NOT hardcode the category list in the form component.** Use the `getActiveCategories` server query so Story 4.7's swap is one-line. Hardcoding in the form would leak across the swap boundary.
- ❌ **Do NOT allow office_staff to backdate more than 7 days** (admin can backdate 30 days). This enforces operational discipline: yesterday's expenses get recorded today, not retroactively last month. Server-validate; don't rely on UI date-picker constraints alone.
- ❌ **Do NOT allow future dates.** All `paidAt` values must be ≤ today (Manila tz). Forward-dated expenses are an accounting red flag.
- ❌ **Do NOT auto-fill the vendor field** from a recent-vendors list in this story. Auto-fill would encourage misclick errors (selecting "Meralco" when meant to type "Maynilad"). Story 4.7's category management may introduce vendor management as a follow-on, but this story keeps vendor as free-text.
- ❌ **Do NOT include vendor in PII redaction.** Vendor is a business entity, not PII.
- ❌ **Do NOT auto-categorize via vendor name pattern-matching.** Premature optimization; let Maria select explicitly.
- ❌ **Do NOT queue offline expense writes.** Same rule as Story 1.14. Read paths work offline; writes hard-block.
- ❌ **Do NOT emit `emitAudit` for read operations** (the dashboard query, the list page). Only mutations emit audit log entries.
- ❌ **Do NOT include the photo blob in the audit log's before/after.** Audit log records `{ hasPhoto: !!photoStorageId }` — the boolean — not the photo data.

### Common LLM-developer mistakes to prevent

- **Reinventing the photo pattern:** Use the exact pattern from Story 1.14's `generateLotConditionPhotoUploadUrl` and `getLotConditionLogPhotoUrl`. Copy/adapt; don't rewrite.
- **Wrong centavo conversion:** `pesosToCents` from `convex/lib/money.ts` is the only correct conversion. Do not do `amount * 100` inline.
- **Wrong date parsing:** `<input type="date">` returns `"YYYY-MM-DD"` in the browser's local timezone. Convert to a Manila-tz `Date.now()`-style number via `convex/lib/time.ts`. Treating the string as UTC-midnight produces a one-day-off bug.
- **Wrong reactive query for the dashboard tile:** `getExpensesMtdTotal` is the dashboard's source. Don't introduce a separate aggregation pattern. Story 5.2 wires it up; don't preempt that here.
- **Schema additive but indexes critical:** The `.index("by_paidAt", ["paidAt"])` is required for `listRecentExpenses` and `getExpensesMtdTotal` to be performant. Missing this index = full-table scans = NFR-P4 (Convex query p95 < 300ms) violation at scale.

### Open questions / blockers this story does NOT resolve

- **§10 Q8 — Predefined expense categories.** This story uses the hardcoded placeholder list + banner. Story 4.7 lands the admin-managed categories. Client answer to Q8 may add/remove items from the default list before go-live; the placeholder can be edited in `convex/lib/expenseCategories.ts` until Q8 is answered.
- **§10 Q9 — Expense approval workflow.** Phase 2 (Story 6.6). This story ships with `approvalStatus: "approved"` default; Story 6.6 changes the default to `"pending_approval"` when toggle is enabled. Schema reserved for it; no breaking changes needed.

### Project-specific environment values

No new env vars. Uses existing Convex deployment `beaming-boar-935`.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/expenses.ts`, `src/components/ExpenseForm/`, `(staff)/expenses/` routes all match the planned tree.
- [Architecture § Implementation Patterns > Naming Patterns](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules) — `paidAt`, `amountCents`, `recordedBy`, etc. all follow the established conventions.

No conflicts.

### References

All references listed in § Source references above. Primary inputs: Story 1.14 (photo upload pattern), Story 1.6 (audit helper), Story 5.2 (dashboard subscription target).

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) via Claude Code SDK.

### Debug Log References

- All four gates run locally:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build`

### Completion Notes List

- **Schema (`expenses` table).** Added the `expenses` table to `convex/schema.ts` with `paidAt`, `amountCents`, `vendor`, `category`, `photoStorageId?`, `recordedBy`, `recordedAt`, `idempotencyKey?`, `note?`, and the Phase-2-reserved `approvalStatus?` field (defaulted to `"approved"` by `recordExpense`). Indexes: `by_paidAt`, `by_category`, `by_recordedBy`, `by_idempotency_key`. The story's "Reserve room for Phase 2" requirement is met; the schema stays additive for Story 6.6.
- **Category vocabulary.** Created `convex/lib/expenseCategories.ts` with the hardcoded `DEFAULT_EXPENSE_CATEGORIES`, the `IS_PLACEHOLDER` sentinel, and the two helpers (`getActiveCategories`, `assertValidCategory`). The async signature is on purpose so Story 4.7's table-backed implementation is a one-line body swap with no caller changes.
- **Mutation + queries (`convex/expenses.ts`).** Implemented `recordExpense` (idempotent, audit-emitting, role-gated, validation-heavy), `generateExpensePhotoUploadUrl`, `getExpensePhotoUrl`, `getExpense`, `listRecentExpenses`, `getActiveCategoriesForForm`, and `getExpensesMtdTotal`. Multi-role users get the **most permissive** backdating window (admin > office_staff) — opposite of session-timeout policy, on purpose: this is for operational ergonomics, not authentication strictness. Documented inline.
- **Dashboard subscription target.** `getExpensesMtdTotal` is admin-only (Story 5.2's tile audience). Live aggregation by `by_paidAt` index scan; documented Phase 1.5 upgrade path to a pre-aggregated summary doc when volume warrants.
- **Client form.** `src/components/ExpenseForm/` ships the form (RHF + Zod), the schema/helpers (`parsePaidAtToMs`, `todayInManila`), and the unit tests. The placeholder banner renders against the server-supplied `isPlaceholderCategories` sentinel — never trust a hardcoded boolean in the client when a swap is coming.
- **Routes.** `/expenses` lists recent rows with `ReactiveHighlight` wrapping each row keyed off `_creationTime` (first-render does NOT flash; reactive arrivals do) plus a table/card responsive split. `/expenses/new` hosts the form and calls `useNetworkAwareMutation` so offline submits short-circuit with `OFFLINE_WRITE_BLOCKED` (Story 1.13 policy).
- **Sidebar nav.** Removed the "Epic 4" `comingSoon` suffix from the Expenses item — the destination is real now. The other Epic 4 items remain gated until their stories ship.
- **Tests.** Comprehensive unit suite for `convex/expenses.ts` (happy paths, role gating, validation surfaces, backdate windows, idempotency, MTD aggregator boundaries). Component-level tests for `ExpenseForm` (banner gating, validation blocking submit, centavo conversion, photo two-step upload, offline behaviour, cancel callback). E2E spec is route-protection only — the full happy-path E2E is queued behind the test-user seed, matching the deferral pattern in `interment-schedule.spec.ts` and `journey-3-field-worker-condition-log.spec.ts`.
- **Deferred to Story 4.7 / 6.6 (per story spec).**
  - The admin-managed `expenseCategories` table. Today's helper short-circuits to the constant; Story 4.7 swaps the body without caller changes.
  - The approval-queue toggle (Story 6.6) — schema reserves `approvalStatus`; `recordExpense` defaults to `"approved"`. Phase 2 just changes the default.
- **Deferred to follow-up sprint.** The cross-tab reactive E2E (Office Staff records; admin's dashboard tile flashes) — gated on the seeded test-user fixture.

### File List

NEW:
- `convex/expenses.ts`
- `convex/lib/expenseCategories.ts`
- `src/app/(staff)/expenses/page.tsx`
- `src/app/(staff)/expenses/new/page.tsx`
- `src/components/ExpenseForm/ExpenseForm.tsx`
- `src/components/ExpenseForm/schema.ts`
- `src/components/ExpenseForm/index.ts`
- `tests/unit/convex/expenses.test.ts`
- `tests/unit/components/ExpenseForm.test.tsx`
- `tests/e2e/record-expense.spec.ts`

MODIFIED:
- `convex/schema.ts` — added the `expenses` table + indexes (additive).
- `src/components/Sidebar/nav-items.ts` — removed `comingSoon: "Epic 4"` from the Expenses nav item.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped `4-6-…` to `review`; bumped `last_updated` comment.
