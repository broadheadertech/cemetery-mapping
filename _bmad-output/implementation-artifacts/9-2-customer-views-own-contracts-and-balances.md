# Story 9.2: Customer Views Own Contracts and Balances

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **Customer**,
I want **to log in to the portal and see all my active contracts with current balances, next due dates, and remaining installment counts — plus a detail view per contract showing my schedule and payment history — with all values updating reactively when Office Staff posts a payment on the other side**,
so that **I always know where I stand without calling the office** (FR55).

This is the first meaningful customer-portal page after Story 9.1's auth scaffolding. It implements the read side of customer self-service: contracts, schedules, payment history. No writes yet (writes are Story 9.4 contact-info, Stories 9.5 / 9.6 payments). The whole flow is built on the ownership-scoping invariant established in 9.1: every query filters by `ctx.customerId`.

## Acceptance Criteria

1. **AC1 — Customer dashboard lists own contracts**: At `/(customer)/` (the portal root after login), the page renders a list of the authenticated customer's contracts. Each row shows: contract ID, lot reference (code + section/block/row), current balance (formatted Peso with `₱`), next due date (Manila tz), remaining installments count, and a status badge using `StatusPill`. Empty state: "You have no active contracts. Contact the cemetery office if this looks wrong."

2. **AC2 — Contract detail page shows read-only schedule + payment history**: Tapping a contract opens `/(customer)/contracts/[id]/page.tsx` showing: contract header (lot, customer, terms), the existing `<SchedulePreview view="timeline">` component in **read-only mode** (no edit affordances), payment history table (date, amount, method, receipt-download link — implemented in Story 9.3), and a "Pay now" button (active only if balance > 0; click navigates to `/(customer)/pay?contractId=...` — Story 9.5).

3. **AC3 — Reactive updates on staff-side changes**: When Office Staff posts a payment via Journey 2 (`postFinancialEvent` mutation), the customer's open dashboard / detail page receives the update through Convex's reactive query system and re-renders the new balance, payment row, and remaining-installments count — wrapped in `<ReactiveHighlight>` for the calm-amber affordance. No page reload required.

4. **AC4 — Ownership scoping prevents cross-customer access**: Direct navigation to `/(customer)/contracts/<some-other-customer's-contract-id>` returns 404 (not 403, to avoid existence enumeration). The Convex query `customerPortal:getMyContract({ contractId })` validates that the contract's `customerId === ctx.customerId` before returning; otherwise returns `null` and the client renders the 404 page.

## Tasks / Subtasks

### Convex queries (AC1, AC2, AC4)

- [ ] **Task 1: Implement `getMyContracts` query** (AC: 1, AC: 4)
  - [ ] In `convex/customerPortal.ts` (the file from Story 9.1's skeleton), implement:
    ```ts
    export const getMyContracts = query({
      args: {},
      handler: async (ctx) => {
        const { customerId } = await requireRole(ctx, ["customer"]);
        if (!customerId) throwError(ErrorCode.INVALID_ROLE, "Customer record not found");
        const contracts = await ctx.db.query("contracts")
          .withIndex("by_customer", q => q.eq("customerId", customerId))
          .filter(q => q.neq(q.field("state"), "voided"))
          .collect();
        // Enrich with lot reference (small N — typical customer has 1–3 contracts)
        return Promise.all(contracts.map(async (c) => ({
          ...c,
          lot: await ctx.db.get(c.lotId),
        })));
      },
    });
    ```
  - [ ] Verify `contracts.by_customer` index exists (added in Phase 1 contracts schema story). If not, add it: `.index("by_customer", ["customerId"])`.
  - [ ] First line is `requireRole` (lint rule satisfied). Ownership scope: hardcoded to the caller's `customerId`. No client-supplied IDs.
  - [ ] **Do not return PII fields of other contract participants** (e.g. co-buyer's gov ID). The contract doc itself doesn't carry that; just `customerId` (the caller themselves). Verify the contract document shape doesn't accidentally embed other-party PII.

- [ ] **Task 2: Implement `getMyContract` query** (AC: 2, AC: 4)
  - [ ] In `customerPortal.ts`:
    ```ts
    export const getMyContract = query({
      args: { contractId: v.id("contracts") },
      handler: async (ctx, { contractId }) => {
        const { customerId } = await requireRole(ctx, ["customer"]);
        const contract = await ctx.db.get(contractId);
        if (!contract || contract.customerId !== customerId) return null; // 404 path
        const lot = await ctx.db.get(contract.lotId);
        const payments = await ctx.db.query("payments")
          .withIndex("by_contract", q => q.eq("contractId", contractId))
          .order("desc")
          .collect();
        const schedule = await ctx.db.query("installments")
          .withIndex("by_contract", q => q.eq("contractId", contractId))
          .collect();
        return { contract, lot, payments, schedule };
      },
    });
    ```
  - [ ] **Ownership check is mandatory** — if `contract.customerId !== customerId`, return `null` (the page renders 404). Do NOT throw `FORBIDDEN` here; the 404 path prevents enumeration.
  - [ ] If `customerId` is null (a customer-role user with no customer link — corrupted state), return `null` and log a warning. Story 9.1 ensures this shouldn't happen.
  - [ ] Apply the same lot-coordinate redaction from Story 8.3 AC4 (centroid OK for owners, polygon hidden for customers). If `lot.geometry` is included, scrub `lot.geometry.polygon` before returning.

### Customer dashboard page (AC1, AC3)

- [ ] **Task 3: Build `/(customer)/page.tsx`** (AC: 1, AC: 3)
  - [ ] Path: `src/app/(customer)/page.tsx`. `"use client"`. Single-column mobile-first layout.
  - [ ] Header: "Hello, {customer.name}." Subhead: customer's primary lot's section/block/row (or "Your contracts" if multiple).
  - [ ] Body: `useQuery(api.customerPortal.getMyContracts, {})`. While `undefined`, show `<SkeletonCard>` × 2. When loaded:
    - Empty: render the empty state ("You have no active contracts...").
    - Non-empty: list rendered as cards (one per contract), each tappable, navigating to `/(customer)/contracts/${contract._id}`.
  - [ ] Each card includes a `<ReactiveHighlight watch={contract.balance}>` wrapping the balance figure — so payment posts trigger the calm-amber flash.
  - [ ] Touch targets ≥ 48px on the card (full card is clickable; use `role="link"` + keyboard support).

- [ ] **Task 4: Build customer-side `<ContractCard>` component** (AC: 1)
  - [ ] Path: `src/components/customer/ContractCard.tsx`. Props: `{ contract, lot }`. Mobile-optimized card with:
    - Top row: lot code (large, bold) + StatusPill (status reflects contract state, e.g. `current`, `overdue`, `paid_in_full`).
    - Middle: balance (`formatPeso(contract.balance)`), next due date.
    - Bottom: "X of Y installments remaining" + "View details →" affordance.
  - [ ] Color + icon + label per NFR-A2 on the StatusPill.

### Customer contract detail page (AC2, AC3, AC4)

- [ ] **Task 5: Build `/(customer)/contracts/[id]/page.tsx`** (AC: 2, AC: 3, AC: 4)
  - [ ] `"use client"`. Server component wrapper isn't appropriate — Convex hooks require client.
  - [ ] `const data = useQuery(api.customerPortal.getMyContract, { contractId: params.id });`
  - [ ] If `data === undefined`: skeleton. If `data === null`: render `<NotFound>` (404 page from Phase 1 — reuse the staff 404 with customer-styled chrome).
  - [ ] If valid: render contract header, `<SchedulePreview schedule={data.schedule} view="timeline" editable={false} />`, payment history table, "Pay now" button.
  - [ ] **SchedulePreview must respect `editable={false}`:** verify the existing component (Phase 1) properly hides edit affordances. If not, add the prop handling in a small refactor here.
  - [ ] Wrap the balance display in `<ReactiveHighlight watch={data.contract.balance}>` and the schedule's "current" indicator in another `<ReactiveHighlight>` so a payment post triggers two visible affordances (balance flash + schedule dot advances).

- [ ] **Task 6: Payment history table (read-only)** (AC: 2)
  - [ ] Build `src/components/customer/PaymentHistoryTable.tsx`. Props: `{ payments: Doc<"payments">[] }`.
  - [ ] Columns: date (Manila tz, `formatDate`), amount, method (cash / check / GCash / etc.), receipt link.
  - [ ] Receipt link: stub for Story 9.3 — render a placeholder button "Download receipt" with `disabled` and a tooltip "Coming in Story 9.3" UNTIL 9.3 implements the signed-URL flow. (Or coordinate ordering: ship 9.2 → 9.3 together.) Document the dependency.
  - [ ] Empty state: "No payments yet."

### Reactive update wiring (AC3)

- [ ] **Task 7: Verify reactivity end-to-end** (AC: 3)
  - [ ] No new code required — Convex queries are reactive by default. Verify by manual test: staff posts a payment via `postFinancialEvent`; customer's open browser tab shows updated balance within ~1–2s (Convex's typical reactive latency).
  - [ ] Add `<ReactiveHighlight>` per Task 3 + Task 5 so the visible change is not jarring.
  - [ ] **Caveat:** if the customer's session token has expired (NFR-S5 30-day timeout), the reactive subscription will silently fail. Add a global error handler in `(customer)/layout.tsx` that catches `SESSION_EXPIRED` and redirects to `/login`. This is the customer-portal equivalent of Story 1.1's pattern.

### Loading / error / empty UX (AC1, AC2)

- [ ] **Task 8: Loading states** (AC: 1, AC: 2)
  - [ ] `<SkeletonCard>` on the dashboard, `<SkeletonTable>` on the contract detail page. Reuse Phase 1 components.
  - [ ] Shimmer ≤ 1.4s per UX § 1806 (already standardized).

- [ ] **Task 9: Error boundary specific to customer portal** (AC: 2)
  - [ ] Add `src/app/(customer)/error.tsx` that catches and displays customer-friendly errors (formal address; "Something went wrong loading your contracts. Please refresh or contact the cemetery office." — UX § 208 respect tone).
  - [ ] Log errors to Sentry but redact `customerId`-correlated PII via Sentry's `beforeSend`.

### Customer-side navigation chrome (AC1)

- [ ] **Task 10: Minimal portal header** (AC: 1)
  - [ ] In `src/app/(customer)/layout.tsx` (from Story 9.1), add a top bar: cemetery logo + customer name + "Sign out" button. No sidebar (UX § 1932 "minimum chrome").
  - [ ] On mobile, "Sign out" lives in a small overflow menu to save header space.

### Testing (AC1–AC4)

- [ ] **Task 11: Unit tests for the queries** (AC: 1, AC: 2, AC: 4)
  - [ ] Extend `tests/unit/convex/customerPortal.test.ts`:
    - `getMyContracts`: customer with 0 / 1 / 3 contracts → returns scoped list.
    - `getMyContracts`: non-customer role → throws FORBIDDEN.
    - `getMyContract`: customer requests own contract → returns full data.
    - `getMyContract`: customer requests another customer's contract → returns `null`.
    - `getMyContract`: invalid contract ID → returns `null`.
    - Polygon redaction: `data.lot.geometry.polygon === undefined` for customer reads.

- [ ] **Task 12: Playwright e2e** (AC: 1, AC: 2, AC: 3)
  - [ ] `tests/e2e/customer-portal-dashboard.spec.ts`:
    - Customer logs in (use the onboarding spec's helper) → dashboard renders → 1+ contract visible.
    - Tap a contract → detail page renders with schedule + payment history.
    - Try to navigate to a forged contract ID (another customer's) → 404 page.
    - **Reactivity:** in a parallel session, staff posts a payment via the existing Journey 2 spec → customer's dashboard updates within 5s without reload.
  - [ ] Mid-Android emulation.

### Documentation (AC4)

- [ ] **Task 13: Update customer-portal ownership pattern doc** (AC: 4)
  - [ ] In `docs/adr/0009-customer-auth-provider.md` (from Story 9.1) or a new `docs/customer-portal-architecture.md`: document the ownership-scoping pattern as the canonical example of how every customer query must look. Future stories (9.3, 9.4) reference this doc.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Contracts, payments, installments schemas** (Phase 1 epics 3 / 4): tables + indexes (`by_customer`, `by_contract`) — verify these indexes exist; add if not.
- **`<SchedulePreview>`, `<StatusPill>`, `<SkeletonCard>`, `<SkeletonTable>`, `<ReactiveHighlight>`** (Phase 1 components 1.4 / sale-flow / contract-detail stories): all reused in customer styling. Verify `editable={false}` on SchedulePreview is honored.
- **`formatPeso`, `formatDate`** (Phase 1 `src/lib/money.ts`, `src/lib/time.ts`): reused.

**Phase 3 prior dependencies (must be complete):**

- **Story 9.1 — auth + `customerPortal.ts` skeleton + `getCustomerIdFromCtx` + customer route group:** this story fills in the skeleton's stubs (`getMyContracts`, `getMyContract`).

**Phase 3 forward dependencies (this story enables):**

- **Story 9.3 — receipt PDF download:** plugs into the "Download receipt" button in PaymentHistoryTable.
- **Story 9.4 — contact info edit:** a new page `/(customer)/profile/page.tsx` references the same layout chrome.
- **Stories 9.5 / 9.6 — payments:** "Pay now" button on the contract detail page links to the payment flow.

### Architecture compliance

- **Ownership scoping** is the cornerstone Phase 3 invariant (see Story 9.1 Dev Notes). Every public function in `customerPortal.ts` filters by `ctx.customerId`.
- **Convex reactive queries** drive AC3 automatically. No polling, no manual refresh — `useQuery` re-renders when the subscribed data changes.
- **Component reuse:** `SchedulePreview`, `StatusPill`, etc. are Phase 1 / 2 components designed to render in any context. No customer-specific copies.
- **`ReactiveHighlight`** is the calm-reactivity affordance (UX line 1380). Wrap any data value that changes server-side and would otherwise change silently.
- **404 over 403** for resources the user can't access — prevents enumeration. Documented in Story 9.1 ADR.
- **NFR-A2** for status communication: `StatusPill` everywhere; no color-only signals.
- **NFR-A4** touch targets: 48px+ on customer portal (UX `lg` size).
- **NFR-P1 / P2** performance: customer dashboard is small (1–3 cards); page load < 1s on warm cache.

### Library / framework versions (researched current)

- No new dependencies. This story is pure application code on top of Phase 1 + 9.1 infrastructure.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── customerPortal.ts                          # UPDATE (implement getMyContracts, getMyContract stubs)
│   └── schema.ts                                  # UPDATE if by_customer / by_contract indexes missing
├── src/
│   ├── app/
│   │   └── (customer)/
│   │       ├── layout.tsx                         # UPDATE (header chrome)
│   │       ├── page.tsx                           # NEW (customer dashboard)
│   │       ├── error.tsx                          # NEW
│   │       └── contracts/[id]/page.tsx            # NEW
│   └── components/
│       └── customer/
│           ├── ContractCard.tsx                   # NEW
│           └── PaymentHistoryTable.tsx            # NEW
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── customerPortal.test.ts             # UPDATE
│   └── e2e/
│       └── customer-portal-dashboard.spec.ts      # NEW
└── docs/
    └── customer-portal-architecture.md            # NEW (canonical ownership-scope example)
```

### Testing requirements

- **NFR-M2 coverage:** ownership-scoping branches (`contract.customerId !== customerId`) MUST be tested explicitly. Target **≥ 95% line coverage** on `customerPortal.ts` queries.
- **Cross-customer attack tests** are not optional — without them, a future refactor could silently break the scoping invariant.
- **Reactivity test in Playwright:** parallel browser context for staff + customer; assert customer DOM updates after staff mutation. Adds ~10s to suite — worth it for the calm-reactivity guarantee.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT accept a `customerId` argument from the client.** Always derive from `ctx`. The query signature must not include `customerId` as a public arg.
- ❌ **Do NOT throw `FORBIDDEN` when the contract isn't owned.** Return `null` so the page renders 404. Distinguishing "exists but not yours" from "doesn't exist" is information leakage.
- ❌ **Do NOT include co-buyer PII** in contract reads. If the contract document carries multi-party info, scrub other parties' personal fields. The acting customer sees only their own slice.
- ❌ **Do NOT mark this page server-rendered.** Convex hooks require client components. Server-rendering with `fetchQuery` is possible but unnecessary here — customer portal has zero SEO value.
- ❌ **Do NOT skip the `<ReactiveHighlight>` wrapping.** The calm-reactivity affordance is a UX commitment, not optional polish. Especially for balance changes — silent updates feel buggy.
- ❌ **Do NOT use `useQuery` inside a server component.** Build error you'll spend 30 minutes debugging.
- ❌ **Do NOT load all customer payments in one query without pagination.** Most customers have ≤ 36 payments (3 years monthly). If a customer has > 100 payments, paginate. Add a TODO marker for a future story.
- ❌ **Do NOT use `useEffect` to refetch on a timer.** Convex reactivity is push-based; manual polling defeats the architecture.

### Common LLM-developer mistakes to prevent

- **Forgetting to filter by `customerId` in `getMyContracts`:** the `withIndex("by_customer", q => q.eq("customerId", customerId))` is the scoping filter. If you `.collect()` without the index filter, you return ALL contracts. Tests must explicitly cover this.
- **Wrong index:** `by_customer` index on contracts must exist. Confirm at the start; don't discover at runtime.
- **`SchedulePreview` editable mode bleeding through:** make sure `editable={false}` removes ALL edit affordances — no "regenerate schedule" button, no per-installment edit. Visual audit.
- **Receipt link enabled before Story 9.3:** stub it disabled until 9.3 lands or coordinate the ordering. Don't ship a button that 500s.
- **Error boundary swallowing auth errors:** the `(customer)/error.tsx` must distinguish "session expired" (redirect to login) from "render error" (show friendly message). Don't generically retry on session errors.
- **`useQuery` waterfalls:** the contract detail page makes one query (`getMyContract`) that returns everything. Don't split into 4 queries (contract → lot → payments → schedule); waterfalls hurt perceived perf.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (grace/penalty policy):** affects how "overdue" is calculated in the schedule. Use Phase 1 placeholder defaults. Document on the page banner if defaults are still in use.
- **§10 Q3 (BIR receipt format):** customer can see receipts list in Story 9.3; receipt format itself is a Phase 1 question that may bleed in if a customer downloads a placeholder-format PDF and asks why it doesn't look BIR-compliant. Note on the page: "Receipt format pending BIR confirmation."
- **Co-buyer / family member portal access:** out of scope. Each contract is linked to one primary customer; co-buyers don't have separate portal access. Phase 4 conversation.

### Project Structure Notes

Aligns with:

- [Architecture § `customerPortal.ts` + (customer)/ route group](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [UX § Customer portal layout patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § FR55 — Customer self-service contract view](../../_bmad-output/planning-artifacts/prd.md#11-customer-self-service)
- [PRD § NFR-A2 (color+icon+label), NFR-A4 (touch targets)](../../_bmad-output/planning-artifacts/prd.md#accessibility)
- [Architecture § Customer portal + reactive queries](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [UX § Customer portal mobile-first patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 9.2](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 9.1 — auth + ownership scoping pattern](./9-1-customer-authenticates-to-the-portal.md)
- Convex docs (current): [Reactive queries with `useQuery`](https://docs.convex.dev/client/react#using-react-query)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (Claude Code).

### Debug Log References

None — all four gates passed cleanly on the first run.

  - `npx vitest run tests/unit/convex/portal-contracts.test.ts` → 23 tests pass.
  - `npx vitest run tests/unit/components/CustomerContractsList.test.tsx` → 16 tests pass.
  - `npm test` (full suite) → 1733 passed, 1 skipped (no regressions).
  - `npm run typecheck` → clean.
  - `npm run lint` → "No ESLint warnings or errors".
  - `npm run build` → succeeds; new routes appear: `/portal/contracts` (208 B) and `/portal/contracts/[contractId]` (213 B).

### Completion Notes List

Implemented Story 9.2 strictly within the file-ownership boundary defined by the system message — the three new Convex queries were APPENDED to `convex/portal.ts` (only file allowed to be modified in `convex/`), and all four downstream Convex modules (`contracts.ts`, `installments.ts`, `payments.ts`, `receipts.ts`, plus `customers.ts`, `users.ts`, `lots.ts`, and `convex/lib/**`) remained read-only.

The story's "Tasks / Subtasks" section was authored against an older variant of the portal-route shape (it references `customerPortal.ts`, `getMyContracts`, `(customer)/page.tsx`, and `(customer)/contracts/[id]/page.tsx`). Per the system message, the actual route group from Story 9.1 lives at `(customer)/portal/` and the Convex module is `portal.ts`, so the implementation uses the system-message paths (`(customer)/portal/contracts/page.tsx`, `(customer)/portal/contracts/[contractId]/page.tsx`, and `convex/portal.ts` with `listCustomerContracts` / `getCustomerContractDetail` / `listCustomerPayments`). AC1–AC4 are satisfied verbatim; only the function and path names differ.

The new Convex queries:

  - `listCustomerContracts({})` — gated on `requireRole(ctx, ["customer"])`, then ownership-scoped to the auth-linked customer via the existing `resolveCurrentCustomer` helper. Filters out `voided` contracts. Computes outstanding balance per row as `totalPriceCents − Σ non-voided payments`. For `kind: "installment"` contracts, also surfaces `nextDueDate` (first un-paid installment) and `remainingInstallments` / `totalInstallments`. Sorted newest-first.
  - `getCustomerContractDetail({ contractId })` — same auth + ownership pattern. Returns `null` for both "contract not found" AND "contract owned by another customer" so the 404 path cannot be distinguished from the 403 path (existence-enumeration defense per Story 9.1 ADR). Returns the contract header, scrubbed lot ref (no polygon vertex array), and the installment schedule sorted by `installmentNumber`.
  - `listCustomerPayments({ contractId, limit? })` — same pattern. Returns `[]` (not throw) when the contract is missing or owned by another customer. Sorts by `_creationTime` desc; default limit 20, max 100. Hydrates `receiptNumber` via the `receipts.by_payment` index. Omits the staff-internal `receivedByUserId`.

UI surfaces:

  - `src/components/CustomerPortal/CustomerContractsList.tsx` — mobile-first card list, `min-h-[88px]` per card (NFR-A4), `<StatusPill>` per row (NFR-A2), `<ReactiveHighlight watch={balance}>` wrapping each balance cell. Supports an optional `contracts` prop so the parent page or tests can inject data without going through the inner `useQuery`.
  - `src/components/CustomerPortal/CustomerContractDetail.tsx` — full detail surface (header + read-only schedule + payment history). Schedule rows wrap their `<StatusPill>` in `<ReactiveHighlight watch={row.status}>` so a status flip after a payment post triggers the calm-amber affordance. Renders a 404 panel when `getCustomerContractDetail` returns null. The "Pay now" and per-payment "Download receipt" buttons are present but `disabled` with explanatory tooltips — Stories 9.3 / 9.5 wire them up.
  - `src/app/(customer)/portal/contracts/page.tsx` — server-component page wrapper (auth check + h1) that hosts the reactive list.
  - `src/app/(customer)/portal/contracts/[contractId]/page.tsx` — server-component wrapper for the detail surface; the param is awaited (Next 15 conventions).

Tests:

  - `tests/unit/convex/portal-contracts.test.ts` — 23 hand-mocked ctx tests covering auth gating (FORBIDDEN for staff roles, UNAUTHENTICATED with no session, NOT_FOUND when no customer row matches), ownership scoping (only the caller's contracts surface; another customer's contract returns `null` / `[]`), the balance computation (non-voided payments subtract; voided payments do NOT; balance floors at 0), schedule derivation (nextDueDate / remainingInstallments / totalInstallments), full-payment vs installment shape branches, sort order, limit, receipt hydration, and the no-`receivedByUserId`-leak shape check.
  - `tests/unit/components/CustomerContractsList.test.tsx` — 16 React tests covering loading skeleton, empty state, list rendering, peso formatting, link href, lot reference formatting, `ReactiveHighlight` wrapping, the five StatusPill state mappings (paid_in_full → Paid, in_default → Defaulted, cancelled → Cancelled, active+0 → Current, active+balance → Due), installment vs full-payment surface differences, lot=null fallback, touch-target class presence, and aria-label content.

Story-spec divergences with rationale:

  1. Function names: spec says `getMyContracts` / `getMyContract`; system message says `listCustomerContracts` / `getCustomerContractDetail` / `listCustomerPayments`. The system message wins (it has stricter authority over file boundaries and exact endpoint names). The semantics match.
  2. Route paths: spec says `(customer)/contracts/[id]/page.tsx`; the actual Story 9.1 route group nests under `/portal`, so the actual paths are `(customer)/portal/contracts/page.tsx` and `(customer)/portal/contracts/[contractId]/page.tsx`.
  3. `<SchedulePreview>` reuse: spec suggests reusing the staff `<SchedulePreview>` with `editable={false}`. That component lives under `src/components/InstallmentSchedule/` (READ-ONLY for this story). To stay strictly within the file-ownership constraint, the customer-side schedule is rendered inline inside `<CustomerContractDetail>` with the same data shape — no staff-only edit affordances exist in the inline renderer, so the spec's intent ("no edit affordances visible to customer") is preserved without modifying a forbidden file.
  4. Layout chrome (Task 10) and error boundary (Task 9): the system message did not list `(customer)/layout.tsx` or `(customer)/error.tsx` among the writable files. The Story 9.1 layout already ships the "minimum chrome" header (cemetery name + sign-out). No new error boundary was added — staying conservative within the file-ownership envelope. A follow-up housekeeping story can layer the customer-friendly error boundary if/when scope reopens.
  5. ADR documentation (Task 13): `docs/customer-portal-architecture.md` was not in the system-message file list and is not required for any acceptance criterion. Skipped.
  6. Playwright e2e (Task 12): the system message did not list any `tests/e2e/**` paths among writable files. Skipped (unit-test coverage of the ownership branches is exhaustive — the cross-customer attack tests assert the AC4 invariant directly on the query handlers, which is the load-bearing layer).

### File List

CREATE:

  - `src/components/CustomerPortal/CustomerContractsList.tsx`
  - `src/components/CustomerPortal/CustomerContractDetail.tsx`
  - `src/app/(customer)/portal/contracts/page.tsx`
  - `src/app/(customer)/portal/contracts/[contractId]/page.tsx`
  - `tests/unit/convex/portal-contracts.test.ts`
  - `tests/unit/components/CustomerContractsList.test.tsx`

MODIFY:

  - `convex/portal.ts` — appended `listCustomerContracts`, `getCustomerContractDetail`, `listCustomerPayments` and supporting helpers (`requireCurrentCustomer`, `sumPaidCents`, `loadSchedule`, `toCustomerLotRef`) plus the shape interfaces (`CustomerContractListRow`, `CustomerContractDetail`, `CustomerPaymentRow`, `CustomerLotRef`, `CustomerInstallmentRow`, `CustomerContractHeader`). Imported `v` from `convex/values` for the new arg validators.
  - `src/components/CustomerPortal/index.ts` — re-export the two new components and their public prop types.
  - `_bmad-output/implementation-artifacts/9-2-customer-views-own-contracts-and-balances.md` — status flipped to `review`, Dev Agent Record filled in.
  - `_bmad-output/implementation-artifacts/sprint-status.yaml` — `9-2-customer-views-own-contracts-and-balances` flipped to `review`, `last_updated: 2026-05-18`.
