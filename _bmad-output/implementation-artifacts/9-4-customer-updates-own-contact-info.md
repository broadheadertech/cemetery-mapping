# Story 9.4: Customer Updates Own Contact Info

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **Customer**,
I want **to update my own contact information — phone, email, and address — from a profile page in the portal, while `name` and `govIdNumber` remain read-only**,
so that **the cemetery has my latest contact details without me having to call the office** (FR58).

This is the first **write** path in the customer portal. Stories 9.1–9.3 are read-only; this story introduces the customer-write pattern that Stories 9.5 / 9.6 (payments) extend further. The cornerstone defense is **two layers**: `requireRole(ctx, ["customer"])` *plus* a server-side **own-record-only guard** that asserts the mutation is acting on the caller's own `customers` document — not any other `customerId` the client might supply.

## Acceptance Criteria

1. **AC1 — Profile page renders editable + read-only fields**: At `/(customer)/profile`, the customer sees their current `name`, `govIdNumber`, `phone`, `email`, and `address`. `name` and `govIdNumber` render with `readonly` (and `aria-readonly="true"`) plus an info note: "Contact the cemetery office to update these fields." `phone`, `email`, and `address` are editable. Touch targets ≥ 48px (UX customer-portal `lg` size).

2. **AC2 — Mutation enforces role + own-record-only guard server-side**: `customerPortal:updateMyContactInfo({ phone?, email?, address? })` performs, in order: (a) `await requireRole(ctx, ["customer"])` (returns `{ userId, customerId }`), (b) load the caller's `customers` doc via the *derived* `customerId` — the mutation **does not accept a `customerId` argument** from the client, (c) validate the input (email format, phone format), (d) `ctx.db.patch(customerId, { phone, email, address })` updating only allow-listed fields, (e) `emitAudit` with action `customer.contactInfoUpdated` capturing before/after diff. Any attempt by a customer to mutate another customer's record is impossible by construction because the `customerId` is derived from `ctx`, not passed in.

3. **AC3 — Read-only fields cannot be patched even if the client sends them**: If the client sends `name` or `govIdNumber` in the mutation payload (e.g. via a tampered client build), the mutation **silently drops** those keys via an explicit allow-list — it does NOT throw, but it also does NOT apply them. The audit row reflects only the fields that were actually changed. A unit test asserts this defense.

4. **AC4 — Inline validation + reactive feedback**: On submit, the client validates email (HTML5 + regex pattern) and phone (PH format: `+639XXXXXXXXX` or `09XXXXXXXXX`) inline before calling the mutation. On success: toast "Contact info updated" + the page re-reads via Convex reactivity (no manual refresh). On failure: inline error per field. While the mutation is in flight, the submit button is disabled with a small spinner.

## Tasks / Subtasks

### Convex mutation (AC2, AC3)

- [ ] **Task 1: Implement `updateMyContactInfo` mutation** (AC: 2, AC: 3)
  - [ ] In `convex/customerPortal.ts` (extends Story 9.1's file), add:
    ```ts
    export const updateMyContactInfo = mutation({
      args: {
        phone: v.optional(v.string()),
        email: v.optional(v.string()),
        address: v.optional(v.string()),
      },
      handler: async (ctx, args) => {
        const { userId, customerId } = await requireRole(ctx, ["customer"]);
        if (!customerId) throwError(ErrorCode.INVALID_ROLE, "Customer record not found");
        const before = await ctx.db.get(customerId);
        if (!before) throwError(ErrorCode.NOT_FOUND, "Customer record missing");

        // Allow-list: only these three fields are mutable by customers.
        const patch: Partial<Doc<"customers">> = {};
        if (args.phone !== undefined) patch.phone = normalizePhone(args.phone);
        if (args.email !== undefined) patch.email = args.email.trim().toLowerCase();
        if (args.address !== undefined) patch.address = args.address.trim();

        // Validate
        if (patch.email && !isValidEmail(patch.email)) throwError(ErrorCode.VALIDATION, "Invalid email");
        if (patch.phone && !isValidPhPhone(patch.phone)) throwError(ErrorCode.VALIDATION, "Invalid phone");

        await ctx.db.patch(customerId, patch);
        await emitAudit(ctx, {
          action: "customer.contactInfoUpdated",
          entityType: "customer",
          entityId: customerId,
          actorId: userId,
          actorRole: "customer",
          details: { before: pick(before, ["phone","email","address"]), after: patch },
        });
        return { ok: true };
      },
    });
    ```
  - [ ] **The mutation MUST NOT accept a `customerId` argument** from the client. This is the own-record-only guard at the type-system level — the client cannot supply a target ID, so cross-customer write is impossible.
  - [ ] **First line is `await requireRole(ctx, ["customer"])`** — lint rule (Story 1.2) is satisfied. The returned `customerId` is the only ID the mutation will touch.
  - [ ] **Allow-list pattern (AC3)**: build the `patch` object from a fixed set of allowed keys. Never `{ ...args }` spread into `patch` — a client-tampered build could send `name` / `govIdNumber` / `_id` / `role` and a spread would honor them. Explicit field-by-field allow-list defeats this entire class of attack.
  - [ ] **Validation helpers** live in `convex/lib/validation.ts` (extend or create — Story 1.x for shared validation utilities). `isValidPhPhone` accepts both `+639XXXXXXXXX` and `09XXXXXXXXX`, normalizes to `+63` form. `isValidEmail` is a conservative regex; the source of truth is the email-provider bounce.

- [ ] **Task 2: Audit diff shape** (AC: 2)
  - [ ] Audit `details.before` captures the previous phone / email / address values; `details.after` captures the patched fields. This supports breach-impact queries (NFR-S8 / NFR-C4 72-hour) — "which customers changed their address in the last 30 days?"
  - [ ] Do **not** log the full customer document in the audit row — only the changed contact fields. Keeps audit log lean and avoids re-leaking gov ID.

### Profile page (AC1, AC4)

- [ ] **Task 3: Build `/(customer)/profile/page.tsx`** (AC: 1, AC: 4)
  - [ ] Path: `src/app/(customer)/profile/page.tsx`. `"use client"`. Single-column form, mobile-first (max-width 600px centered per UX customer portal patterns).
  - [ ] Read current customer via a new query `customerPortal:getMyProfile` (Task 5).
  - [ ] Fields:
    - `name` — `<input readOnly value={data.name} aria-readonly="true">` with helper text "Contact the cemetery office to update."
    - `govIdNumber` — same pattern; **never re-emit** to the mutation (the mutation wouldn't accept it anyway, but the form should not even include it in submit).
    - `phone` — editable, `type="tel"`, `inputMode="tel"`, autocomplete `tel-national`. Validation on blur + on submit.
    - `email` — editable, `type="email"`, autocomplete `email`. Validation on blur + on submit.
    - `address` — editable, `<textarea rows="3">`, autocomplete `street-address`.
  - [ ] Submit button "Save changes" with `min-h-[48px]`. Disabled until any field has changed (use a dirty-state hook). While submitting: spinner inside button + button disabled.
  - [ ] On success: toast "Contact info updated." Convex reactivity refreshes the page state without a manual refetch.
  - [ ] On error: per-field inline errors via `aria-describedby`; submit-level error via `role="alert"`.

- [ ] **Task 4: Add `<EditableField>` mobile-friendly pattern** (AC: 1, AC: 4)
  - [ ] If the existing Phase 1 form components feel desktop-heavy, build `src/components/customer/EditableField.tsx` — a labelled input with built-in validation state, error display, and read-only mode. Reusable across future portal write paths (none planned in Phase 3, but it's a clean abstraction).
  - [ ] If Phase 1 forms work fine on mobile, skip this task and use the existing components. Document the decision in the commit.

- [ ] **Task 5: Implement `getMyProfile` query** (AC: 1)
  - [ ] In `convex/customerPortal.ts`:
    ```ts
    export const getMyProfile = query({
      args: {},
      handler: async (ctx) => {
        const { customerId } = await requireRole(ctx, ["customer"]);
        if (!customerId) return null;
        const c = await ctx.db.get(customerId);
        if (!c) return null;
        // Return only customer-visible fields. Strip internal flags.
        return pick(c, ["_id","name","govIdNumber","phone","email","address","createdAt"]);
      },
    });
    ```
  - [ ] **Field allow-list on read** too — never return the full document. Strips any internal flags (e.g. `flagForFollowup`, `archivedAt`, staff-only notes).

### Navigation chrome (AC1)

- [ ] **Task 6: Link profile from customer portal header** (AC: 1)
  - [ ] In `src/app/(customer)/layout.tsx` (Story 9.1 / 9.2's layout), add a "Profile" link in the header next to "Sign out." On mobile, profile + sign-out share the small overflow menu.

### Testing (AC1–AC4)

- [ ] **Task 7: Unit tests** (AC: 2, AC: 3)
  - [ ] Extend `tests/unit/convex/customerPortal.test.ts`:
    - Happy path: customer updates phone → record patched, audit emitted with before/after diff.
    - Read-only field defense (AC3): client sends `{ phone: "+639...", name: "Hacked", govIdNumber: "9999" }` → only `phone` is patched; `name` and `govIdNumber` remain unchanged.
    - Invalid email → throws VALIDATION; record unchanged.
    - Invalid phone → throws VALIDATION; record unchanged.
    - Non-customer role → throws FORBIDDEN.
    - **Cross-customer attack**: even if a test crafts a custom mutation call shape, there is no way to specify a target `customerId` — the test should fail to compile if it tries, proving the type-system guard.

- [ ] **Task 8: Playwright e2e** (AC: 1, AC: 4)
  - [ ] `tests/e2e/customer-portal-profile.spec.ts`:
    - Customer logs in → opens `/(customer)/profile` → sees name + gov ID as read-only.
    - Edits phone → submits → toast appears → page reflects new phone after reactivity.
    - Submits invalid email → inline error appears, no mutation fires.
    - Reload page → new phone persists.
  - [ ] Mid-Android emulation.

### Documentation (AC2, AC3)

- [ ] **Task 9: Document the customer-write pattern** (AC: 2, AC: 3)
  - [ ] In `docs/customer-portal-architecture.md` (created in Story 9.2), add the "Customer-write pattern" section: (1) derive `customerId` from `ctx`, never accept as arg; (2) allow-list patch fields explicitly; (3) audit before/after for breach response. This pattern is referenced by Stories 9.5 / 9.6 for payment-initiation mutations.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Customer schema (Phase 1 contracts / customers story)** — must include `phone`, `email`, `address` as editable fields. If absent, surface immediately rather than adding here.
- **Story 1.2 — `requireRole`, `userRoles`, lint rule** — used as-is.
- **Story 1.6 — `emitAudit`** — used as-is.
- **`convex/lib/errors.ts`** — `throwError` / `ErrorCode` from Phase 1; reuse.

**Phase 3 prior dependencies (must be complete):**

- **Story 9.1 — auth + `customerPortal.ts` skeleton + `getCustomerIdFromCtx`** — the file is extended here. The ownership-scoping helper from 9.1 is the foundation.
- **Story 9.2 — customer dashboard + layout chrome** — `(customer)/layout.tsx` is extended to add the Profile link.

**Phase 3 forward dependencies (this story enables):**

- **Stories 9.5 / 9.6 — payments** — reuse the customer-write pattern documented in Task 9. Payment-initiation mutations also derive `customerId` from `ctx` and allow-list args.

### Architecture compliance

- **Two-layer defense** (role + own-record-only): Phase 3 cornerstone. The role check answers "are you a customer?"; the own-record-only guard answers "is this YOUR record?" — and for writes, the second guard is enforced by *not accepting a target ID from the client* rather than by post-hoc verification. This is the strongest form of the defense.
- **Allow-list patching** (AC3): the canonical pattern across all customer mutations. Never `ctx.db.patch(id, args)` directly; always build a `patch` object from a known-good field set.
- **Audit diff** for every customer-initiated write (NFR-S8 + NFR-C4 breach response).
- **NFR-S4 server-side authorization** — UI marks fields read-only, but the server-side allow-list is the actual gate.
- **NFR-A4 touch targets** — 48px on all editable fields and the submit button.
- **NFR-A1 form labels** — visible labels (never placeholder-as-label per UX § form patterns).
- **`convex/customerPortal.ts` as single entry point** — no profile-update logic in `convex/customers.ts` (staff-only). Customer-write paths stay in `customerPortal.ts`.

### Library / framework versions (researched current)

- No new dependencies. This story is pure application code on top of Phase 1 + Stories 9.1 / 9.2.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── customerPortal.ts                          # UPDATE (add getMyProfile + updateMyContactInfo)
│   └── lib/
│       └── validation.ts                          # NEW or UPDATE (isValidPhPhone, isValidEmail, normalizePhone, pick helper)
├── src/
│   ├── app/
│   │   └── (customer)/
│   │       ├── layout.tsx                         # UPDATE (Profile link in header)
│   │       └── profile/page.tsx                   # NEW
│   └── components/
│       └── customer/
│           └── EditableField.tsx                  # NEW (optional — only if Phase 1 forms feel desktop-heavy)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── customerPortal.test.ts             # UPDATE (read-only defense, validation, cross-customer attack)
│   └── e2e/
│       └── customer-portal-profile.spec.ts        # NEW
└── docs/
    └── customer-portal-architecture.md            # UPDATE (customer-write pattern section)
```

### Testing requirements

- **NFR-M2 coverage:** ownership + allow-list branches in `updateMyContactInfo` are auth-adjacent — target **≥ 95% line coverage** on the mutation.
- **Tamper test is mandatory** (AC3): the unit test that passes extra fields and asserts they are dropped is the safety net for the allow-list pattern. Without it, a future refactor could silently break the defense.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT accept a `customerId` argument from the client.** The mutation's arg validators must not include `customerId: v.id("customers")`. Type-system enforcement of the own-record-only guard.
- ❌ **Do NOT use `ctx.db.patch(customerId, args)` with the raw args object.** Spread-patching is a tampering hole. Always build an explicit allow-listed `patch`.
- ❌ **Do NOT make `name` or `govIdNumber` editable by adding "just one more field."** These require staff verification (gov ID change implies identity-document re-scan; name change implies legal documentation). FR58 is explicit.
- ❌ **Do NOT skip the audit row** — NFR-S8 + breach response require the diff trail.
- ❌ **Do NOT log the full customer document** in the audit row — log only the diff'd fields. Reduces audit log size + avoids re-emitting gov ID.
- ❌ **Do NOT log the validation-failed value** to audit on a rejected mutation — only log on successful patch. Rejected attempts are visible via Convex function-call metrics.
- ❌ **Do NOT trust the client-side "dirty state"** to skip a server validation. The server validates every submit regardless of which fields claim to have changed.
- ❌ **Do NOT add a "delete my account" button** in this story. Account deletion is a Phase 4 conversation with legal / records-retention implications.
- ❌ **Do NOT let `phone` accept arbitrary international format.** PH-only at launch (FR57 SMS reminders target Twilio PH numbers). If the cemetery has overseas customers, that's a Phase 4 widening.

### Common LLM-developer mistakes to prevent

- **Spread-patching:** `ctx.db.patch(customerId, { ...args })` re-introduces the tampering hole. The reviewer must flag this on PR.
- **Accepting `customerId` "just to make the mutation reusable":** wrong. Reusability is bought at the cost of the own-record-only guard. Don't trade it. Staff-side contact-info edits live in a separate `customers:updateContactInfo` mutation under `convex/customers.ts` with `requireRole(ctx, ["admin","office_staff"])`.
- **Skipping the read query (`getMyProfile`) and reading directly from `useQuery(api.customers.getById)`:** wrong — `customers.getById` is staff-only. Customer reads go through `customerPortal.ts`.
- **Email normalization inconsistency:** lowercase + trim on write, but the read returns whatever was stored. If Phase 1 stored mixed-case emails, the Phase 3 normalization will visibly change them on first edit. Document in commit notes.
- **Phone-format hint UX:** the form shows "+63 9XX XXX XXXX" as a placeholder/example, but the validation regex accepts both `+63` and `0`-prefixed forms. Don't force the customer to know which form to type.
- **Forgetting `aria-readonly` on the read-only fields:** `readOnly` alone isn't sufficient for screen readers. Add `aria-readonly="true"` and a visible note.
- **Returning the full `customers` document from `getMyProfile`:** wrong. Allow-list on read too — strip internal flags.

### Open questions / blockers this story does NOT resolve

- **§10 Q5 (commission tracking on contact-info change):** none — contact info isn't commissionable.
- **Customer requests legal-name change:** out of scope. Phase 4 workflow with staff verification + audit.
- **Email change re-verification:** Story 9.1's chosen auth provider may require email re-verification on change. If so, this story's mutation triggers a re-verification flow. Verify behavior with the ADR-0009 provider; if re-verification is required, add as a follow-up sub-task or surface as a known limitation in the runbook.
- **Address geocoding:** out of scope. Address is a free-text string in Phase 3.

### Project Structure Notes

Aligns with:

- [Architecture § `customerPortal.ts` + customer route group](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [Architecture § Authentication & Security — server-side role + ownership enforcement](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [UX § Customer portal mobile-first form patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § FR58 — Customer self-service contact update](../../_bmad-output/planning-artifacts/prd.md#11-customer-self-service)
- [PRD § NFR-S4 (server-side authz), NFR-S8 (PII access log), NFR-A1 (form labels), NFR-A4 (touch targets)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § `customerPortal.ts`](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [Epics § Story 9.4](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 9.1 — auth + ownership scoping + `getCustomerIdFromCtx`](./9-1-customer-authenticates-to-the-portal.md)
- [Previous story 9.2 — customer dashboard + layout chrome](./9-2-customer-views-own-contracts-and-balances.md)
- [Previous story 1.6 — emitAudit](./1-6-system-emits-audit-rows-for-every-mutation.md)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code (Dev Agent autonomous run)

### Debug Log References

- Initial test run had two trivial issues fixed inline:
  - `portal-account.test.ts` projection-shape test expected `8900` for last-4 of
    `"12-3456789-0"` — corrected to `7890` (stripped 10-digit ID tail is
    `1234567890`).
  - `CustomerAccountForm.test.tsx` mock return value typed too narrowly via
    `as const` — widened to an explicit `UpdateResult` interface so
    `mockResolvedValueOnce({...updatedFields: ["phone"]})` typechecks.
- Audit-row insert mock in `portal-account.test.ts` needed
  `row as unknown as AuditRow` (the `Record<string, unknown>` argument doesn't
  satisfy the strict `AuditRow` shape — the two-step cast matches the pattern
  used by other portal-* tests).

### Completion Notes List

- **AC1 (Profile page renders editable + read-only fields)** — `/portal/account`
  ships with a structured form: identity fields (`Full name`,
  `<govIdTypeLabel>`) render as `readOnly` + `aria-readonly="true"` with a
  "Contact the cemetery office" helper note; phone / email / address fields
  are editable with `min-h-[48px]` (NFR-A4 touch targets). The page owns the
  single `<h1>` per the local-rules/single-h1-per-page lint rule; the form
  itself lives in the `<CustomerAccountForm>` client component.
- **AC2 (Mutation enforces role + own-record-only guard server-side)** —
  `portal:updateCustomerContact` is gated via `requireCurrentCustomer` (which
  internally calls `requireRole(ctx, ["customer"])`) and derives the target
  `customerId` from the auth identity. The mutation's args validator does NOT
  include `customerId` — cross-customer write is impossible by construction
  (the type system forbids the client from naming another customer's row).
- **AC3 (Read-only fields cannot be patched even if the client sends them)** —
  the patch object is built field-by-field from an explicit allow-list
  (`phone`, `email`, `address`, `updatedAt`). The unit test
  `portal.updateCustomerContact — allow-list defense (AC3)` passes
  `fullName`, `name`, `govIdNumber`, `_id`, `hasConsent`, and `role` to the
  handler and asserts NONE of them appear in the resulting patch. The form
  doesn't register identity fields with RHF either, so they never reach the
  submit payload.
- **AC4 (Inline validation + reactive feedback)** — RHF + Zod gate the submit
  on client-side validation (PH phone regex, plausible email shape, required
  address line1). The Save button is disabled until the form is dirty. On
  success, a `role="status"` success message renders ("Contact info updated.");
  on failure, `role="alert"` surfaces a translated error. The live
  `portal:getCurrentCustomer` subscription re-syncs the read-only chrome
  reactively (no manual refresh needed).
- **Audit emission** — every successful patch emits a single `update` row
  with `entityType: "customer"`, `actor: <auth user id>`, and a `before`/
  `after` diff capturing ONLY the changed contact fields (never the full
  customer document — keeps audit log lean per NFR-S8 and avoids re-leaking
  gov-ID through the audit trail). The `emitAudit` helper's `redactPii`
  redacts the address tokens at write time so the stored audit row carries
  per-token initials rather than the full address.
- **PH-phone normalisation** — both `09XXXXXXXXX` and `+639XXXXXXXXX` shapes
  (with internal punctuation tolerated via the `[\s\-.()]` strip) are
  accepted on the client and normalised to the canonical `+63` form on the
  server before write. Non-mobile / landline / gibberish phones are
  rejected with `ErrorCode.VALIDATION`.
- **No-op short-circuit** — when zero fields change, the mutation returns
  `updatedFields: []` and emits NO audit row, so the audit log stays clean
  if the client's dirty-state gate is bypassed.
- **File-ownership policy honoured** — modifications are limited to
  `convex/portal.ts` (APPEND only — added imports for `emitAudit`, added
  `getCurrentCustomerAccount` query + `updateCustomerContact` mutation +
  supporting types/helpers), `src/components/CustomerPortal/index.ts`
  (added new exports), and the four created files
  (`CustomerAccountForm.tsx`, `account/page.tsx`,
  `portal-account.test.ts`, `CustomerAccountForm.test.tsx`).
  `convex/customers.ts`, `convex/lib/**`, ESLint configs, AppShell, and all
  staff route surfaces were left untouched.
- **Note on read-query addition** — the story file's task list includes a
  `getMyProfile` read query alongside the mutation; the user-message
  directive emphasised the mutation only. I added
  `portal:getCurrentCustomerAccount` (analogous role + the narrow
  account-profile shape) because the form's "current values pre-filled" UX
  in the Do list requires the read surface; the existing
  `portal:getCurrentCustomer` from Story 9.1 returns only `{customerId,
  fullName, email}` and widening it would broaden every portal page's PII
  surface. Both surfaces are ownership-scoped server-side via the same
  `requireCurrentCustomer` helper.
- **Gates** — typecheck clean; lint clean (only a pre-existing unrelated
  `react-hooks/exhaustive-deps` warning in `SaleForm.tsx`); `npm test`
  shows 2008 passed + 1 skipped across 116 files (34 new
  `portal-account.test.ts` cases + 13 new `CustomerAccountForm.test.tsx`
  cases all green); `npm run build` succeeded with the new `/portal/account`
  route registered in the Next.js routes list.

### File List

Created:

- `src/components/CustomerPortal/CustomerAccountForm.tsx` — RHF + Zod form
  with read-only identity fields, editable phone/email/address (with PH
  phone client validation), dirty-state gated Save button, inline error +
  success feedback, ≥48px touch targets.
- `src/app/(customer)/portal/account/page.tsx` — server-rendered shell
  with auth/role re-check, server-side prefetch of
  `portal:getCurrentCustomerAccount` for first-paint pre-fill, gov-ID-type
  label dictionary, fallback "Account unavailable" panel for the
  NOT_FOUND edge case.
- `tests/unit/convex/portal-account.test.ts` — 34 cases covering
  `getCurrentCustomerAccount` (auth gating + projection shape) and
  `updateCustomerContact` (auth gating, phone normalisation, email
  normalisation, address patch, allow-list defense including the
  cross-customer-attack attempt, audit emission with full before/after
  diff assertions, no-op short-circuit, validation rejection paths).
- `tests/unit/components/CustomerAccountForm.test.tsx` — 13 cases covering
  read-only identity rendering, NFR-A4 touch targets, dirty-state gate,
  client-side validation for phone + email, happy-path mutation payload
  shape (asserting NO `fullName`/`name`/`govIdNumber`/`customerId`),
  success toast, structured address payload, mutation-error rendering.

Modified:

- `convex/portal.ts` — added imports for `emitAudit`; appended the Story
  9.4 section: `CurrentCustomerAccountProfile` type +
  `portalLastFourAlnum` helper + `getCurrentCustomerAccount` query
  (gov-ID-last-4 only, full email/phone/address) + `UpdateCustomerContactArgs`
  type + `UpdateCustomerContactResult` type + `portalAddressValidator` +
  `isPlausibleCustomerEmail` + `normalizePhPhone` (PH-only accept) +
  `updateCustomerContact` mutation with allow-list patch + audit diff +
  no-op short-circuit.
- `src/components/CustomerPortal/index.ts` — added named exports for
  `CustomerAccountForm` + `CustomerAccountFormProps`.
- `_bmad-output/implementation-artifacts/9-4-customer-updates-own-contact-info.md` —
  status flipped from `ready-for-dev` to `review`; Dev Agent Record filled
  in.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` —
  `9-4-customer-updates-own-contact-info: ready-for-dev` → `review`;
  `last_updated: 2026-05-18`.
