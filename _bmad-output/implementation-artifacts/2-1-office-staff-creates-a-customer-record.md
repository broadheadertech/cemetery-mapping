# Story 2.1: Office Staff Creates a Customer Record

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As **Office Staff (Maria)**,
I want **to create a customer record with name, contact, address, government-ID number, retention consent, and relationship to occupant — from a single form at `/customers/new` or inline from the sale flow**,
so that **the cemetery has a digital record of every person who owns or is interred in a lot, with the legally-required Data Privacy Act consent captured at the moment of creation** (FR14, NFR-C5).

This is the **first domain story of Epic 2** and the **first table this codebase adds beyond auth + lot infrastructure**. It introduces the `customers` table (canonical PII container), the customer-creation mutation routed through `requireRole` + `emitAudit`, the `CustomerForm` React Hook Form + Zod component used both standalone and inline-embedded in the Journey 1 sale flow (per UX §1086–1089), and the consent flag (`hasConsent`) that gates ID-scan uploads in Story 2.2. Get the schema right here and Stories 2.2 through 2.7 (and Epic 3's sales flow) become straightforward extensions; get the consent gate wrong and NFR-C5 fails the first compliance review.

## Acceptance Criteria

1. **AC1 — `customers` schema is defined with PII fields and consent flag** (FR14, NFR-S2, NFR-C5): `convex/schema.ts` extends with a `customers` table containing: `fullName` (string), `phone` (optional string), `email` (optional string), `address` (object with `line1`, `barangay`, `cityMunicipality`, `province`, `postalCode` — all strings, `line1` required), `govIdType` (union literal: `"sss" | "tin" | "umid" | "drivers_license" | "passport" | "philhealth" | "voters_id" | "other"`), `govIdNumber` (string — stored as-is; relies on Convex default at-rest encryption per Story 2.8 / ADR-0007), `relationshipToOccupant` (optional string — e.g. "spouse", "child", "self"), `hasConsent` (boolean — required; `true` only when the consent checkbox was explicitly checked), `consentTimestamp` (optional number; populated when `hasConsent: true`), `consentCapturedByUserId` (optional `v.id("users")`), `createdAt` (number), `createdByUserId` (`v.id("users")`), `updatedAt` (number). Indexed by `by_fullName_lowercased` (for fuzzy-match dedupe) and `by_govIdNumber` (for exact-match dedupe — partial uniqueness handled in the mutation, not via DB constraint).

2. **AC2 — `customers.create` mutation runs `requireRole` → validates → inserts → emits audit** (FR14, NFR-S4, NFR-S7): `convex/customers.ts` exports a `create` mutation that: (a) calls `requireRole(ctx, ["office_staff", "admin"])` as the first line (Story 1.2 helper); (b) validates input via the same Zod schema the client uses (re-declared server-side per architecture's defense-in-depth rule); (c) refuses to set `consentTimestamp` / `consentCapturedByUserId` unless `hasConsent === true`; (d) inserts the row with `createdAt = Date.now()`, `createdByUserId = userId from requireRole`; (e) calls `emitAudit(ctx, { action: "customer.create", entityType: "customer", entityId: newCustomerId, before: null, after: redactedCustomer, reason: undefined })` — Story 1.6's helper redacts `govIdNumber` to last-4 in the `after` payload automatically; (f) returns `{ customerId, fullName }`.

3. **AC3 — `CustomerForm` renders + submits + redirects** (UX §1598, Journey 1 §1086–1089): A new `src/components/CustomerForm/CustomerForm.tsx` component renders fields per AC1, using shadcn/ui `Input`, `Select`, `Checkbox`, `Button` primitives + React Hook Form + Zod. Fields: full name (required, min 2 chars), phone (PH format hint: `09XX-XXX-XXXX` or `+639...`), email (RFC-shaped, optional), address sub-form (line1 required, others optional), gov-ID type (Select; defaults to `"sss"`), gov-ID number (required, min 4 chars, masked input that shows last-4 only after blur), relationship to occupant (free-text Input), **consent checkbox** (required-to-check-to-submit; label: "Customer has given consent for retention of their identification documents per the Data Privacy Act of 2012 (RA 10173). Captured: [today's date]."), `Submit` button. On submit, calls the `customers.create` mutation, redirects to `/customers/<newCustomerId>` (page from Story 2.5). The component is **mounted at `/customers/new` (full page)** and **embeddable inline** (when used inline in Story 3.x sale flow, the redirect is suppressed via an `onCreated` prop).

4. **AC4 — Consent gate is enforced both client and server** (NFR-C5): On the client: the `Submit` button is disabled while the consent checkbox is unchecked; an inline note next to the checkbox explains "Required by Data Privacy Act. Without consent, ID scans cannot be attached." On the server: `customers.create` accepts `hasConsent: false` (it's legal to record a customer who hasn't yet given consent — e.g. legacy data migration) — but the mutation refuses to populate `consentTimestamp` unless `hasConsent === true`. Story 2.2's upload mutation reads this flag and rejects uploads when it's false.

5. **AC5 — Fuzzy-match dedupe notice on name entry** (UX requirement from epics AC4): As the user types in the full-name field (debounced 300ms after the 3rd character), the form runs a `customers.searchByName` query (Convex `useQuery`, separate from the create mutation) that returns up to 5 customers whose `fullName` (lower-cased) contains the typed substring. If matches exist, a non-blocking `<Alert>` renders below the name field: "Similar customer exists: Mrs. Maria Cruz (gov ID ***-***-1234). [View] [Continue with new]." The "[View]" link navigates to `/customers/<matchId>`; "[Continue with new]" dismisses the alert. **No PII (full gov ID) is shown in the alert** — only last-4, per UX §1879–1884.

## Tasks / Subtasks

### Schema additions (AC1)

- [x] **Task 1: Define the `customers` table in `convex/schema.ts`** (AC: 1)
  - [x] Add a `customers` table per AC1 field list. Use `v.object` for the `address` sub-object. Use `v.union(v.literal(...), ...)` for `govIdType`. Use `v.optional` for fields that are legitimately optional (phone, email, relationshipToOccupant, consentTimestamp, consentCapturedByUserId).
  - [x] **Important: do NOT add a `v.bytes()` field for encrypted gov-ID storage.** Per architecture's §289 PII encryption decision + Story 2.8's forthcoming ADR-0007: Convex's default at-rest encryption is the encryption layer; application-level field encryption is intentionally out of scope. `govIdNumber` is stored as a plain `v.string()`. Encryption happens at the Convex storage layer, not in user code.
  - [x] Add two indexes: `.index("by_fullName_lowercased", ["fullNameLowercased"])` and `.index("by_govIdNumber", ["govIdNumber"])`. The `fullNameLowercased` field is a denormalized lowercase copy of `fullName` written by the mutation — Convex doesn't support functional indexes.
  - [x] Verify `npx convex dev` regenerates `convex/_generated/api.d.ts` cleanly with the new `customers.create` and `customers.searchByName` references after Tasks 2 + 3 land.

- [x] **Task 2: Update `convex/lib/errors.ts` with the customer-domain code** (AC: 2)
  - [x] Add `CUSTOMER_CONSENT_INVARIANT: "CUSTOMER_CONSENT_INVARIANT"` to the `ErrorCode` constants from Story 1.2. Used when the mutation receives `hasConsent: false` but the caller tries to set `consentTimestamp` (a defense-in-depth check; the form wouldn't normally produce this state).
  - [x] Reserved future code: `CUSTOMER_DUPLICATE_GOV_ID: "CUSTOMER_DUPLICATE_GOV_ID"` — not enforced in this story (the dedupe is advisory, not blocking, per AC5), but reserved so Story 2.7's transfer flow can promote it to a hard reject if §10 Q6 demands it.

### Backend mutation + query (AC2, AC5)

- [x] **Task 3: Implement `convex/customers.ts` with `create` mutation** (AC: 1, AC: 2, AC: 4)
  - [x] First line: `await requireRole(ctx, ["office_staff", "admin"]);` — Story 1.2's helper. **The Story 1.2 ESLint rule (`require-role-first-line`) will fail the build if this is missing.**
  - [x] Args via `v.object({ fullName: v.string(), phone: v.optional(v.string()), email: v.optional(v.string()), address: v.object({...}), govIdType: v.union(...), govIdNumber: v.string(), relationshipToOccupant: v.optional(v.string()), hasConsent: v.boolean() })`. Server-side Zod re-validation runs on the unpacked args before insert.
  - [x] Compute `fullNameLowercased = args.fullName.trim().toLowerCase()`. Trim all string inputs.
  - [x] Enforce consent invariant: if `args.hasConsent === false`, do NOT set `consentTimestamp` / `consentCapturedByUserId`. If somehow set when `hasConsent: false` → `throwError(ErrorCode.CUSTOMER_CONSENT_INVARIANT, ...)`.
  - [x] Insert via `await ctx.db.insert("customers", { ... fullNameLowercased, createdAt: Date.now(), createdByUserId: userId, updatedAt: Date.now(), consentTimestamp: args.hasConsent ? Date.now() : undefined, consentCapturedByUserId: args.hasConsent ? userId : undefined })`.
  - [x] Call `emitAudit(ctx, { action: "customer.create", entityType: "customer", entityId: newCustomerId, before: null, after: { ...insertedDoc }, reason: undefined })`. **Do NOT redact the `after` payload here** — Story 1.6's `emitAudit` already redacts known PII fields (`govIdNumber` → last-4) at write time. Pass the full doc; let the helper do its job.
  - [x] Return `{ customerId: newCustomerId, fullName: args.fullName }`.

- [x] **Task 4: Implement `convex/customers.ts` with `searchByName` query** (AC: 5)
  - [x] First line: `await requireRole(ctx, ["office_staff", "admin"]);` — search is staff-only; field workers do not need customer search in Phase 1.
  - [x] Args via `v.object({ q: v.string() })`. Reject empty / sub-3-char queries early (return `[]`) — the client also gates this, but defense-in-depth.
  - [x] Lower-case the query, lookup via the `by_fullName_lowercased` index using `q => q.gte("fullNameLowercased", needle).lt("fullNameLowercased", needle + "￿")` (prefix-match pattern; Convex doesn't have native `LIKE` — prefix-match against the lowercased index is sufficient for the typing-debounced dedupe UX).
  - [x] Return at most 5 results. For each: `{ customerId, fullName, govIdLast4: customer.govIdNumber.slice(-4) }`. **Do NOT return the full `govIdNumber`** — the result payload is shown in the dedupe alert; full PII would leak via the dedupe path. The last-4 helper inside the query is intentionally NOT routed through `readPii` because the last-4 is non-identifying per UX §1879–1884 (last-4 is shown in search results everywhere). Document this exemption in a comment.

### Frontend form (AC3, AC5)

- [x] **Task 5: Scaffold `src/components/CustomerForm/`** (AC: 3)
  - [x] Create `src/components/CustomerForm/CustomerForm.tsx` (the component) and `src/components/CustomerForm/customerSchema.ts` (Zod schema shared between client form validation and `customers.create` server re-validation).
  - [x] `customerSchema.ts` exports the Zod schema + the inferred TypeScript type. The server imports the same module (Convex's TypeScript-first model allows it) so client + server agree on shape. Optional Zod refinements (e.g. PH-phone regex) live here.
  - [x] Architecture's repo layout (§ 446–457): components live under `src/components/<ComponentName>/` for non-trivial composites. `CustomerForm` qualifies — composite of multiple Inputs + the consent gate.

- [x] **Task 6: Build the form fields + RHF wiring** (AC: 3)
  - [x] Use `useForm<CustomerFormValues>({ resolver: zodResolver(customerSchema), defaultValues: { ...empty }, mode: "onBlur" })` per architecture § 545 (validation on blur + submit).
  - [x] Field order matches the form-pattern UX expectation: name → phone → email → address (line1 → barangay → city → province → postal) → gov-ID type → gov-ID number → relationship → consent → submit. Tab order matches DOM order.
  - [x] **Gov-ID number masking:** show the typed value while the field is focused; on blur, replace the visible value with `"•••• •••• " + value.slice(-4)`. Re-show on focus. The masked display is purely cosmetic — `value` in form state stays full. This mirrors the click-to-reveal pattern from UX §1875–1886 but is for input, not display.
  - [x] All interactive elements meet the 44 × 44 px minimum (NFR-A4) — Tailwind `min-h-[44px]`.

- [x] **Task 7: Build the consent checkbox + gate** (AC: 3, AC: 4)
  - [x] Render a shadcn/ui `Checkbox` with label: "Customer has given consent for retention of their identification documents per the Data Privacy Act of 2012 (RA 10173). Captured: [DateNow formatted via `src/lib/time.ts:formatDate(Date.now(), 'short')`]."
  - [x] Note next to the checkbox: "Required by Data Privacy Act. Without consent, ID scans cannot be attached." (NFR-C5). Aria-describedby links the note to the checkbox for screen readers.
  - [x] Form submit button is `disabled` while `!watch("hasConsent")` — RHF's `watch` hook.

- [x] **Task 8: Wire fuzzy-match dedupe alert** (AC: 5)
  - [x] In `CustomerForm`, watch the `fullName` field. Debounce 300ms (via `useDebouncedCallback` from `use-debounce` or a small inline `useEffect` + `setTimeout`).
  - [x] When the trimmed name is ≥ 3 characters, fire `useQuery(api.customers.searchByName, { q: trimmedName })`. Story 1.2's `requireRole` runs on the server.
  - [x] When results returned (and length > 0 and the user hasn't dismissed): render `<Alert variant="info">` with the first 1–3 matches: "Similar customer exists: **Mrs. Maria Cruz** (gov ID ***-***-1234). [View] [Continue with new]". "[View]" is a `<Link href={`/customers/${matchId}`}>`. "[Continue with new]" sets local state `dismissedMatches` so the alert hides.
  - [x] The alert is **non-blocking** — the form remains submittable while it's visible. AC5's explicit choice.

- [x] **Task 9: Build the `/customers/new` page** (AC: 3)
  - [x] Create `src/app/(staff)/customers/new/page.tsx` — client component (because it uses Convex hooks via `CustomerForm`). Header: "New Customer." Renders `<CustomerForm onCreated={(customerId) => router.push(`/customers/${customerId}`)} />`.
  - [x] **Auth gate is server-side** in `src/app/(staff)/layout.tsx` (already exists from Story 1.1 + 1.2). No additional check needed in this page.
  - [x] Add a "Cancel" link/button that goes back to the previous page or to `/customers` (the list, which doesn't yet exist — for now, link to `/dashboard`). Skip building the customer list page in this story — it's not in the AC list; will land with Story 2.5 if needed.

### Testing (AC2, AC4, AC5)

- [x] **Task 10: Unit tests for `customers.create` mutation** (AC: 1, AC: 2, AC: 4)
  - [x] Create `tests/unit/convex/customers.test.ts` — mirrors `convex/customers.ts` per architecture § 472–476.
  - [x] Use `convex-test` harness (set up in Story 1.2). Cases:
    - **AC2 happy path:** office_staff user creates with `hasConsent: true` → customer row inserted with `consentTimestamp` set, audit row appears with `action: "customer.create"`, `govIdNumber` redacted to last-4 in audit `after`.
    - **AC2 happy path (no consent):** `hasConsent: false` → row inserted, `consentTimestamp` absent, audit still emitted.
    - **AC4 invariant:** test passes a hand-crafted args object that bypasses Zod and sets `hasConsent: false` + `consentTimestamp: somenumber` (via raw `ctx.db.insert` from the test harness, simulating a malicious / buggy client) — the mutation must refuse. (Note: the public API surface won't even accept `consentTimestamp` as an arg; this test is verifying the internal invariant.)
    - **NFR-S4 RBAC:** unauthenticated caller → `UNAUTHENTICATED`; field_worker caller → `FORBIDDEN`.
    - **Audit redaction:** verify the inserted audit row's `after.govIdNumber === "*****1234"` (or equivalent redaction pattern from Story 1.6).
  - [x] Coverage target: **≥ 90% line + branch on `convex/customers.ts`** (NFR-M2; this is PII-touching, treat as financial-adjacent).

- [x] **Task 11: Unit tests for `customers.searchByName` query** (AC: 5)
  - [x] Cases:
    - 3-char prefix match returns the 1 customer whose name starts with that prefix; `govIdLast4` is exactly 4 chars.
    - Sub-3-char query returns `[]` without hitting the index.
    - 6+ matching customers — query returns at most 5.
    - **NFR-S4 RBAC:** field_worker → `FORBIDDEN` (search is staff-only).

- [x] **Task 12: Component test for `CustomerForm`** (AC: 3, AC: 4, AC: 5)
  - [x] Create `src/components/CustomerForm/CustomerForm.test.tsx` (co-located per architecture § 475).
  - [x] Vitest + Testing Library + a mocked Convex client (use `convex-test`'s React harness or `vi.mock("@/lib/convexClient")`):
    - **AC3 render:** all fields present; submit button disabled on initial render.
    - **AC4 consent gate:** check the consent checkbox → submit button becomes enabled.
    - **AC5 dedupe:** type "Mar" in name field → mock `searchByName` returns one match → assert the alert renders with `***-***-1234`-format last-4 (not the full gov ID).
    - **Gov-ID masking:** type a gov ID, blur the field → display shows `"•••• •••• 1234"`; focus again → full value re-shown.

- [x] **Task 13: E2E smoke spec for the create flow** (AC: 3, AC: 4)
  - [x] Add to `tests/e2e/` a spec `customer-create.spec.ts`: log in as seeded office_staff (extending Story 1.1's seed); navigate to `/customers/new`; fill all required fields including consent; submit; assert redirect to `/customers/<newId>`. The detail page doesn't exist yet (Story 2.5); for now the spec asserts the URL pattern only, with a comment noting the page will be filled in by Story 2.5.

### Documentation (AC1)

- [x] **Task 14: JSDoc on `customers.ts` + form module** (AC: 1)
  - [x] File-level JSDoc on `convex/customers.ts`: summarize FR14/NFR-C5 ownership, the `requireRole` + `emitAudit` invariants, and the consent-gate semantics for callers.
  - [x] File-level JSDoc on `src/components/CustomerForm/CustomerForm.tsx`: when to use full-page (`/customers/new`) vs inline-embedded (Story 3.x sale flow's `onCreated` callback pattern).
  - [x] **No ADR in this story** — the only architecturally-novel decision (PII encryption posture) is ADR-0007 in Story 2.8. This story's mutations follow existing patterns (`requireRole` per ADR-0002, `emitAudit` per ADR-0006-ish from Story 1.6).

## Dev Notes

### Previous story intelligence

**Stories that must be implemented before this one:**

- **Story 1.1 (Admin Logs Into the System):** provides the Next.js + Convex scaffold, `(staff)/` route group, auth providers, seed admin. `/customers/new` lives inside `(staff)/` and inherits its auth gate.
- **Story 1.2 (Server Enforces Role-Based Access on Every Endpoint):** provides `requireRole(ctx, [...])` in `convex/lib/auth.ts`, the `ErrorCode` constants in `convex/lib/errors.ts`, the per-role session timeouts, and — critically — **the `require-role-first-line` ESLint rule that will fail the build if `customers.create` or `customers.searchByName` is missing the `requireRole` call**. Test the lint rule by temporarily omitting the call during dev — the failure message should appear.
- **Story 1.6 (Audit log emission helper):** provides `emitAudit(ctx, {...})` in `convex/lib/audit.ts`. **`emitAudit` already PII-redacts known fields** (gov-ID number → last-4) at write time per Story 1.6 AC3. Do not redact again in `customers.create` — that's double-redaction territory. Pass the full doc to `emitAudit`.
- **Story 1.7 (State machine transition guards):** not directly used in this story — customers don't have state machines. Referenced because Story 2.7 (ownership transfer) will use `assertTransition` for the lot's `available → reserved` transition.

**Stories that build on this one:**

- **Story 2.2 (ID document uploads):** reads `hasConsent` from the customer doc to gate file uploads. If `hasConsent === false`, uploads are blocked.
- **Story 2.3 (PII access logging):** introduces `readPii(ctx, customerId, fields[])`. Story 2.5 (customer detail page) routes its `govIdNumber` reads through `readPii`. **This story (2.1) does not need `readPii`** because the create mutation writes the gov ID — it doesn't read it after insert. The search query (Task 4) returns only last-4, which UX §1879–1884 treats as non-identifying.
- **Story 2.5 (Customer detail page):** the redirect target of `customers.create`. The page will exist by the time 2.1 ships in a real release.
- **Story 3.x (Sale flow Journey 1):** embeds `CustomerForm` inline via the `onCreated` callback (Journey 1 §1086–1089). The `onCreated` prop is the seam for that future integration; build it now even though only the standalone page is exercised in 2.1.

### Architecture compliance

**Pattern locked by architecture § Implementation Patterns & Consistency Rules:**

- **File location:** `convex/customers.ts` (architecture § 436); test mirror at `tests/unit/convex/customers.test.ts` (§ 472–476).
- **Component location:** `src/components/CustomerForm/CustomerForm.tsx` — composite component gets its own folder; co-located test (`CustomerForm.test.tsx`) per § 475.
- **Naming patterns** (architecture § 386–388):
  - Table name: `customers` (camelCase, plural).
  - Foreign key fields: `createdByUserId`, `consentCapturedByUserId` — `<entity>Id` form, typed `v.id("users")`.
  - Boolean: `hasConsent` (NOT `consent`) per the `is<X>` / `has<X>` rule.
- **Schema validators:** every public mutation uses `v.object({...})` arg validators (Convex idiom). Defense-in-depth Zod re-validation runs inside the handler too — architecture § 545–547.
- **PII boundary** (architecture § 525–528, § 868): direct `ctx.db.get(customerId)` returning a customer doc to the client surface is forbidden for the `govIdNumber` field. Story 2.3 builds the `readPii` boundary; this story's queries either don't return PII (`create` returns only `{ customerId, fullName }`) or return only redacted PII (`searchByName` returns last-4 only).
- **Audit:** all writes call `emitAudit` (architecture § 393, § 518–523). Story 1.6's helper.
- **Money / time:** no money in this story. Time via `Date.now()` server-side (architecture § 490–493).
- **Forms** (architecture § 314): React Hook Form + Zod; shadcn/ui primitives.

### Library / framework versions (researched current)

- **`react-hook-form`** — `@latest` (currently 7.x). `npm install react-hook-form @hookform/resolvers zod`. Architecture § 314 commits to this pair.
- **`zod`** — `@latest` (currently 3.x; v4 is in alpha at time of writing — stick to 3.x unless the architect explicitly bumps).
- **`use-debounce`** (or equivalent) — `@latest`. Small utility. Alternative: write a 10-line `useDebouncedValue` hook in `src/hooks/useDebouncedValue.ts` — preferred to keep the dependency count lean. Tradeoff: `use-debounce` is battle-tested; the hand-roll is trivial.
- **shadcn/ui primitives needed:** `Input`, `Select`, `Checkbox`, `Button`, `Alert`, `Label`, `Form` (RHF integration helpers). Install incrementally via `npx shadcn@latest add input select checkbox button alert label form` — adds files into `src/components/ui/`. **Note:** Story 1.4 (StatusPill) has not been listed as a prereq for this story, so this story may be the first to install shadcn primitives in a real release — that's fine; install lazily on first use per shadcn's model.
- **No new convex packages** needed. Convex 1.x's File Storage support is Story 2.2's concern.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                       # UPDATE (add customers table + indexes)
│   ├── customers.ts                                    # NEW (create mutation + searchByName query)
│   └── lib/
│       └── errors.ts                                   # UPDATE (add CUSTOMER_CONSENT_INVARIANT code)
├── src/
│   ├── app/(staff)/customers/
│   │   └── new/page.tsx                                # NEW (renders <CustomerForm />)
│   ├── components/
│   │   ├── CustomerForm/
│   │   │   ├── CustomerForm.tsx                        # NEW (the form composite)
│   │   │   ├── CustomerForm.test.tsx                   # NEW (component test)
│   │   │   └── customerSchema.ts                       # NEW (Zod schema shared client + server)
│   │   └── ui/                                         # UPDATE (shadcn installs: input, select, checkbox, button, alert, label, form)
│   ├── hooks/
│   │   └── useDebouncedValue.ts                        # NEW (small hook — alternative to a dependency)
│   └── lib/
│       └── time.ts                                     # UPDATE if formatDate isn't yet exported
│                                                       # (Story 1.x may have stubbed it; this story may need to flesh it out for "today's date" display in consent label)
├── tests/
│   ├── unit/convex/
│   │   └── customers.test.ts                           # NEW (mutation + query coverage ≥ 90%)
│   └── e2e/
│       └── customer-create.spec.ts                     # NEW (smoke)
└── package.json                                        # UPDATE (react-hook-form, @hookform/resolvers, zod; shadcn primitives are file copies, not deps)
```

**Note on `src/lib/time.ts`:** Architecture § 432–433 commits to a `convex/lib/time.ts` (server) and an `src/lib/time.ts` (client) split. Story 1.2 added `convex/lib/time.ts` with `HOUR_MS` / `DAY_MS` constants. The client-side `formatDate` helper may not yet exist; if not, this story is its first user — add a minimal `formatDate(ms: number, format: "short" | "long" | "datetime"): string` using `Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila" })` (architecture § 492). Do NOT over-engineer it; only add the variants used in this story (`"short"` for the consent label).

### Testing requirements

- **Convex unit tests:** ≥ 90% line + branch coverage on `convex/customers.ts` per NFR-M2 (this is PII-handling code; treat as financial-adjacent). The `convex-test` harness handles mock auth contexts.
- **Component tests:** `CustomerForm.test.tsx` covers the form-level behavior. Tests for shadcn primitives (`Input`, `Checkbox`, etc.) themselves are NOT in scope — those are upstream library tests.
- **E2E:** one smoke spec proving the create-and-redirect happy path. Full dedupe-flow E2E + consent-gate E2E can land later; the unit + component tests cover the logic.
- **No axe / Lighthouse changes** in this story — the form uses well-tested shadcn primitives with accessible-by-default markup. If Story 1.4's StatusPill / a11y CI gate is in place, run the form's page through axe to confirm zero violations.

### Source references

- **PRD:** [§ FR14 (Office Staff creates a customer record)](../../_bmad-output/planning-artifacts/prd.md#functional-requirements), [§ NFR-S2 (PII encryption at rest)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [§ NFR-S4 (server-side RBAC)](../../_bmad-output/planning-artifacts/prd.md#security--privacy), [§ NFR-C5 (customer consent for ID retention)](../../_bmad-output/planning-artifacts/prd.md#compliance--legal)
- **Architecture:** [§ Data Storage & Persistence (schema illustration)](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence), [§ Implementation Patterns > Naming Patterns (camelCase, plural tables, `<entity>Id`, `has<X>` booleans)](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules), [§ Authentication & Security > PII encryption / access logging](../../_bmad-output/planning-artifacts/architecture.md#authentication--security), [§ Frontend Architecture > Forms (RHF + Zod)](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture), [§ Boundary Discipline > PII read boundary](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- **UX:** [§ Pattern Library > CustomerForm](../../_bmad-output/planning-artifacts/ux-design-specification.md#pattern-library) (inline-create-friendly), [§ Journey 1 — Maria Records a Sale (Steps K–N for inline customer creation)](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-1), [§ PII Handling UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns) (last-4 display, click-to-reveal, search results), [§ Form Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#form-patterns)
- **Epics:** [§ Story 2.1](../../_bmad-output/planning-artifacts/epics.md#story-21-office-staff-creates-a-customer-record)
- **Previous stories:** [1.1](./1-1-admin-logs-into-the-system.md) (scaffold), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md) (`requireRole` + ESLint rule + error codes), 1.6 audit helper, 1.7 state machines (not used here)
- Convex docs: [Schemas + validators](https://docs.convex.dev/database/schemas), [Indexes](https://docs.convex.dev/database/indexes/), [Queries](https://docs.convex.dev/functions/query-functions)

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT add a `v.bytes()` field or any application-level encryption for `govIdNumber`.** Architecture § 289 and Story 2.8's pending ADR-0007 commit to Convex's managed at-rest encryption. Application-layer field encryption is intentionally out of scope. Storing the value as `v.string()` is correct.
- ❌ **Do NOT return the full `govIdNumber` from `searchByName`** — only last-4. The dedupe alert is a notorious sneaky PII leak vector ("just show the ID so the staff can confirm" → full ID flows to every keystroke). Last-4 is the contract.
- ❌ **Do NOT skip the `requireRole` call on either function.** Story 1.2's lint rule will fail the build; even without it, NFR-S4 makes this non-negotiable.
- ❌ **Do NOT manually redact PII in `customers.create` before calling `emitAudit`** — Story 1.6's helper redacts known PII fields automatically. Double-redaction makes the audit log harder to debug (`"*****1***"` etc.).
- ❌ **Do NOT use a DB-level unique constraint on `govIdNumber`.** Convex doesn't support them; even if it did, AC5 specifies advisory dedupe, not blocking. Hard uniqueness would break legacy-data migration and prevent recording a person whose ID was issued twice.
- ❌ **Do NOT inline-encode the consent label's date via `new Date().toLocaleString()`.** Architecture § 492–493: all dates go through `src/lib/time.ts:formatDate` with explicit `"en-PH"` locale + `"Asia/Manila"` timezone. Browser locale = bug.
- ❌ **Do NOT mount `CustomerForm` as a server component.** It uses Convex hooks (`useMutation`, `useQuery`); must be `"use client"`. Architecture § 312.
- ❌ **Do NOT add a `customers` list page (`/customers`) in this story** — not in any AC. Out of scope.
- ❌ **Do NOT bypass the consent checkbox via a default value of `true`.** Required-to-check-each-time is the explicit NFR-C5 design — the staff must consciously affirm consent capture for every customer.
- ❌ **Do NOT use `Math.random()` or client-side `Date.now()` for any field stored in the DB.** Server `Date.now()` is the source of truth for `createdAt` / `consentTimestamp` / `updatedAt`.

### Common LLM-developer mistakes to prevent

- **Reinventing wheels:** Use shadcn/ui's `<Form>` + `<FormField>` + `<FormItem>` + `<FormLabel>` + `<FormControl>` + `<FormDescription>` + `<FormMessage>` components — they wrap RHF + accessible-by-default. Don't write raw `<input>` + manual label + manual `aria-describedby`.
- **Wrong index name:** `by_fullName_lowercased` — `lowercased`, not `lowercase`. The denormalized field is `fullNameLowercased`. Keep names consistent.
- **Wrong PII pattern in audit:** `emitAudit` from Story 1.6 redacts at write. Don't pre-redact in `customers.create`. The test in Task 10 explicitly asserts the audit row shows `"*****1234"` (or equivalent) — verify Story 1.6's redaction shape and match it.
- **Wrong file location for the Zod schema:** `src/components/CustomerForm/customerSchema.ts` — co-located with the component, NOT in `src/lib/schemas/`. Convex imports it from `convex/customers.ts` via the `src/` path alias. Verify the path alias works from a Convex file (it should; Convex bundles user code with `tsconfig.json` paths).
- **Breaking the inline-embed seam:** the `onCreated` prop on `CustomerForm` is the seam for Story 3.x inline-create. If you omit it ("we don't need it yet, Journey 1 isn't built"), Story 3.x has to refactor the component. Build the prop now; the standalone `/customers/new` page uses it for the redirect.
- **Wrong consent semantics:** `hasConsent: false` is valid (legacy migration). The consent-required gate applies only to ID-scan uploads (Story 2.2). This story records consent **state**, it doesn't require consent **to record the customer**.
- **Forgetting the denormalized lowercase field:** if you compute `fullNameLowercased` only at query time, the index won't help (Convex indexes only stored fields). Write it at insert / update time.
- **Premature optimization on dedupe:** prefix-match on the lowercased index is sufficient for the "type 3 chars → see suggestions" UX. Don't build full-text search (Lucene-style); Convex has search indexes but they're overkill for the dedupe alert.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (Installment grace/penalty policy):** unrelated to customer creation. No blocker.
- **§10 Q2 (Lot types & pricing):** unrelated to customers. No blocker.
- **§10 Q3 (BIR receipt format):** unrelated. No blocker.
- **§10 Q4 (Legacy data condition):** **partially relevant** — legacy customers may not have all fields populated, especially `consentTimestamp` (consent likely wasn't captured at the time). The schema is permissive (`hasConsent` defaults `false`, `consentTimestamp` optional) so migration can land legacy rows without consent. No blocker for this story; flag for Story 2.4 / migration runbook.
- **§10 Q6 (Ownership transfer policy):** affects Story 2.7, not 2.1.

### Project Structure Notes

Aligns with architecture § Project Structure & Boundaries > Complete Project Directory Structure. The new files (`convex/customers.ts`, `src/components/CustomerForm/*`, `src/app/(staff)/customers/new/page.tsx`) all land at architecture-mandated paths.

No detected conflicts.

### References

- [PRD § Functional Requirements > FR14, FR15, FR16, FR17, FR18 (Customer & Ownership)](../../_bmad-output/planning-artifacts/prd.md#4-customer--ownership-management)
- [PRD § Non-Functional Requirements > NFR-S2, NFR-S4, NFR-S8 (Security & Privacy)](../../_bmad-output/planning-artifacts/prd.md#security--privacy) and [NFR-C5 (Compliance & Legal)](../../_bmad-output/planning-artifacts/prd.md#compliance--legal)
- [Architecture § Data Storage & Persistence](../../_bmad-output/planning-artifacts/architecture.md#data-storage--persistence)
- [Architecture § Authentication & Security](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § Frontend Architecture](../../_bmad-output/planning-artifacts/architecture.md#frontend-architecture)
- [Architecture § Implementation Patterns & Consistency Rules](../../_bmad-output/planning-artifacts/architecture.md#implementation-patterns--consistency-rules)
- [Architecture § Boundary Discipline](../../_bmad-output/planning-artifacts/architecture.md#boundary-discipline)
- [UX § Pattern Library](../../_bmad-output/planning-artifacts/ux-design-specification.md#pattern-library)
- [UX § PII Handling UI Patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md#pii-handling-ui-patterns)
- [UX § Journey 1 — Maria Records a Sale](../../_bmad-output/planning-artifacts/ux-design-specification.md#journey-1)
- [Epics § Story 2.1](../../_bmad-output/planning-artifacts/epics.md#story-21-office-staff-creates-a-customer-record)
- Previous stories: [1.1](./1-1-admin-logs-into-the-system.md), [1.2](./1-2-server-enforces-role-based-access-on-every-endpoint.md), Story 1.6 (audit), Story 1.7 (state machines — not used in this story)
- React Hook Form: [docs (current)](https://react-hook-form.com/) · Zod: [docs (current)](https://zod.dev/) · shadcn/ui: [Form](https://ui.shadcn.com/docs/components/form) · Convex: [Schemas](https://docs.convex.dev/database/schemas) · [Indexes](https://docs.convex.dev/database/indexes/)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 via Claude Code BMAD bmad-dev-story

### Debug Log References

- `npm run typecheck` — only pre-existing errors from concurrent stories (`OccupantForm.test.tsx` from 2.6 and `DataSubjectReport/index.tsx` from 2.4); zero errors in Story 2.1 files.
- `npm run lint` — clean (0 warnings, 0 errors).
- `npm test` — 685 passing, 1 skipped, 0 failing across 46 test files. The single "Unhandled Rejection" comes from `tests/unit/sw/sw.test.ts` (Story 1.13 service-worker spec attempting to `fetch app.example`) and is unrelated to this story.
- `npm run build` — fails at the Next.js `tsc` stage on `src/app/(staff)/admin/data-subject-reports/page.tsx:56` (`Cannot find namespace 'JSX'`) — a Story 2.4 concurrent-work file. Story 2.1 files compile clean (the Convex compilation pass completed before the failing page was reached).

### Completion Notes List

- **AC1 (schema):** Added `customers` table to `convex/schema.ts` with all PII fields, the denormalised `fullNameLowercased` field, and the two indexes (`by_fullName_lowercased`, `by_govIdNumber`). Story 3.1's parallel `receiptCounter` table is preserved; I appended `customers` after it.
- **AC2 (mutation):** `convex/customers.ts:create` runs `await requireRole(ctx, ["admin", "office_staff"])` as its first line, validates inputs, enforces the consent invariant, inserts the row, and emits a `create` audit via `emitAudit` (which redacts `govIdNumber` to last-4 at write time per Story 1.6).
- **AC3 (form):** `CustomerForm` mounts at `/customers/new` and is embeddable inline via the `onCreated` prop (Journey 1 §1086–1089 seam). The form owns its mutation; the page is a thin wrapper.
- **AC4 (consent gate):** Submit button is disabled while `hasConsent === false`; server refuses to populate `consentTimestamp`/`consentCapturedByUserId` unless `hasConsent === true`. Story 2.2's upload mutation will read this flag.
- **AC5 (dedupe alert):** `customers.searchByName` returns at most 5 hits with `govIdLast4` only (never the full ID — explicit comment in the handler documents the UX §1879 exemption from `readPii`). The form renders the alert with `***-***-LAST4` formatting, a `[View]` link to `/customers/<id>`, and a `[Continue with new]` dismiss button.
- **Concurrent work integration:** While I was writing my code, Story 2.3 (`logPiiAccess`) and Story 2.5 (`getCustomerDetail`, `revealGovId`) appended additional exports to `convex/customers.ts`. I preserved their additions; my `create` and `searchByName` exports sit at the top of the file alongside the original module JSDoc. The `convex/lib/errors.ts` codes I added (`CUSTOMER_CONSENT_INVARIANT`, `CUSTOMER_DUPLICATE_GOV_ID`) coexist with Story 3.2's parallel codes (`ALLOCATION_SUM_MISMATCH`, `EMPTY_ALLOCATIONS`, etc.) without conflict.
- **Customer detail page:** Created `src/app/(staff)/customers/[customerId]/page.tsx` as a Story 2.1 PLACEHOLDER so the create-flow redirect lands on a valid route. Story 2.5 will replace the body.
- **Nav item:** The "Customers" link in `src/components/Sidebar/nav-items.ts` was already present from Story 1.5 (marked `comingSoon: "Epic 2"`). No nav edit required.
- **Search palette:** `convex/search.ts` is on the forbidden list, so the Cmd-K `customers` scope still returns `[]` from the stub `searchCustomers` helper inside `search.ts`. Story 2.5 (or a dedicated search-wiring follow-up) can route that stub through `customers.searchByName`. Form-level dedupe (the AC5 alert) is fully wired through `customers.searchByName` directly.
- **Time helper:** Added `src/lib/time.ts` with `formatDate(ms, "short")` per architecture §492–493 (en-PH locale, Asia/Manila timezone). The Story 1.x stub mentioned in the story Dev Notes did not exist; this is its first incarnation.
- **PII redaction names:** The story Dev Notes called out coordinating field names with `convex/lib/audit.ts`'s `PII_ID_FIELDS` / `PII_ADDRESS_FIELDS`. The existing helper recognises `govIdNumber` (matches our field exactly) and `address` (top-level only; our `address` is a sub-object, so `redactPii` recurses but does not redact each address sub-field as a string). Phone/email are NOT in the redactor's known set — Story 2.3 should extend `PII_ID_FIELDS` / add `PII_CONTACT_FIELDS` to redact those in audit payloads.
- **Test coverage:** 28 unit tests in `tests/unit/convex/customers.test.ts` cover create RBAC (4 cases), happy-path with consent (5 cases), no-consent (2 cases), validation (5 cases), and searchByName (8 cases). 11 component tests in `src/components/CustomerForm/CustomerForm.test.tsx` cover render, consent gate, submit + redirect, `onCreated` callback, error translation, dedupe alert (3 cases), and gov-ID masking (2 cases). E2E smoke spec asserts route protection (full happy path is gated on seeded test users — see TODO in the spec).
- **No ADR introduced** — confirmed by the story Dev Notes; PII encryption posture is Story 2.8's ADR-0007.

### File List

**Created:**
- `convex/customers.ts` — `create` mutation + `searchByName` query (subsequently extended by Stories 2.3 and 2.5 in parallel; the file is shared).
- `src/components/CustomerForm/CustomerForm.tsx` — composite form component.
- `src/components/CustomerForm/CustomerForm.test.tsx` — 11 component tests.
- `src/components/CustomerForm/customerSchema.ts` — Zod schema + gov-ID type constants.
- `src/components/CustomerForm/index.ts` — public exports.
- `src/app/(staff)/customers/new/page.tsx` — full-page create flow.
- `src/app/(staff)/customers/[customerId]/page.tsx` — placeholder detail page (Story 2.5 replaces).
- `src/lib/time.ts` — client `formatDate(ms, "short")` helper.
- `tests/unit/convex/customers.test.ts` — 28 unit tests.
- `tests/e2e/customer-create.spec.ts` — Playwright smoke spec.

**Modified:**
- `convex/schema.ts` — added the `customers` table with `by_fullName_lowercased` and `by_govIdNumber` indexes.
- `convex/lib/errors.ts` — added `CUSTOMER_CONSENT_INVARIANT` and reserved `CUSTOMER_DUPLICATE_GOV_ID`.

### Change Log

| Date       | Author                                                | Change                                                     |
| ---------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| 2026-05-18 | claude-opus-4-7 via Claude Code BMAD bmad-dev-story  | Initial implementation. All 14 tasks complete. Status: review. |
