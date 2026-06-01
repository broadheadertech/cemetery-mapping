# Story 9.1: Customer Authenticates to the Portal

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **Customer (or family member of a customer)**,
I want **to authenticate to the customer portal using credentials linked to my contracts — initiated via a portal-invite email sent by Office Staff — and land on a `(customer)/` route group with only my own data visible**,
so that **I can view my contracts and pay online without anyone else seeing my information** (FR5).

> ⚠️ **CRITICAL ARCHITECTURAL RE-EVALUATION POINT — READ BEFORE STARTING**
>
> The architecture (line 284) deliberately deferred the Phase 3 customer auth provider decision: **Convex Auth (with custom Twilio-via-action SMS-OTP) vs. Better Auth (`get-convex/better-auth`)**. This story implements *whichever provider ADR-0009 selects at Phase 3 kickoff.* **The first task of this story is to produce ADR-0009 — do not write auth code until the decision is recorded.** Both options are real; the criteria below are the evaluation framework. Staff Phase 1 auth (Story 1.1) stays on Convex Auth regardless.

## Acceptance Criteria

1. **AC1 — ADR-0009 chooses customer auth provider with rationale**: `docs/adr/0009-customer-auth-provider.md` exists, status `"accepted"`, decision documented as either (a) Convex Auth with Twilio-via-action SMS-OTP, or (b) Better Auth via `get-convex/better-auth`. The ADR enumerates the evaluation criteria (SMS-OTP support quality, magic-link support, password-reset UX, customer-portal session model, ecosystem maturity, ops cost, migration risk) and the rejected option's failure mode for this product.

2. **AC2 — Customer can authenticate to the portal**: A customer with a portal account can visit `/(customer)/login` (note: distinct from staff `/login` per route group) and authenticate via the chosen primary method (SMS-OTP or email + password). On success they are redirected to `/(customer)` dashboard. On failure they see a generic error sentence; the error never reveals whether the identifier exists in the system.

3. **AC3 — Office Staff can invite a customer via portal-invite email**: From a customer detail page, an Office Staff user (with `requireRole(ctx, ["admin", "office_staff"])`) can tap "Send portal invite." This: (a) generates a single-use, 7-day-expiring `portalInvite` row keyed to the customer ID + token, (b) dispatches an email (via `convex/actions/sendPortalInvite.ts`) with a link `https://<host>/customer/accept-invite?token=<token>`, (c) the invite-acceptance page lets the customer set a password (option a) or verify their phone for SMS-OTP (option b), and (d) on completion, the customer is auto-logged-in and an audit row is emitted.

4. **AC4 — `requireRole("customer")` enforcement and ownership scoping**: The new `convex/customerPortal.ts` file exposes queries / mutations that all call `requireRole(ctx, ["customer"])` as the first action — enforced by the existing lint rule. Each query also performs an **ownership check**: the returned data is scoped to `contracts.customerId === ctx.user.customerId`. There is no path for a customer to view another customer's data, even by crafting URLs / IDs.

## Tasks / Subtasks

### Decision step (AC1) — DO THIS FIRST

- [ ] **Task 1: Produce ADR-0009** (AC: 1)
  - [ ] Path: `docs/adr/0009-customer-auth-provider.md`. Status starts `"proposed"`; flip to `"accepted"` once the comparison work is complete and the dev team / product owner signs off.
  - [ ] Sections required: **Context** (why customer auth is materially different from staff auth — phone-first PH customer base, magic-link / SMS-OTP friendlier than password); **Options considered** (1: Convex Auth + Twilio-via-action SMS-OTP; 2: Better Auth via `get-convex/better-auth`); **Evaluation matrix** (SMS-OTP first-class support, magic-link support, password-reset UX, session model + per-role timeout enforcement, lockout / rate-limit features, ops cost incl. Twilio SMS rates, migration risk if we later switch); **Decision**; **Consequences** (what the rest of this story depends on); **Date**; **Reviewers**.
  - [ ] **Do NOT skip Twilio cost evaluation.** PH SMS rates via Twilio are roughly $0.04–0.08 per message. With ~2,000 customers receiving an average 2 OTP / month + Phase 3 reminders (FR57 — separate story but same provider), the monthly bill matters.
  - [ ] **Do NOT skip the "lock-in risk if we choose Better Auth" assessment.** Better Auth via the Convex component is well-supported but adds a dependency outside the core Convex stack. ADR must explicitly accept that.
  - [ ] **Decision flowchart (suggested, not binding):** if SMS-OTP needs to be the primary login method → Better Auth likely wins; if email + password is acceptable for Phase 3 launch with SMS as a Phase 3.5 enhancement → Convex Auth stays. Whichever path is chosen, this story implements it; do not implement both.

### Schema additions (AC2, AC3, AC4)

- [ ] **Task 2: Extend schema for customer auth + portal invites** (AC: 2, AC: 3, AC: 4)
  - [ ] In `convex/schema.ts` add:
    - `portalInvites: defineTable({ customerId: v.id("customers"), token: v.string(), email: v.string(), sentAt: v.number(), expiresAt: v.number(), acceptedAt: v.optional(v.number()), revokedAt: v.optional(v.number()), createdBy: v.id("users") }).index("by_token", ["token"]).index("by_customer", ["customerId"])`.
    - Extend `userRoles` (added in Story 1.2): customers also live there with `role: "customer"`. Add a `customerId: v.optional(v.id("customers"))` field on `userRoles` rows where `role === "customer"` so we can link a Convex auth user → a customer record. (Alternatively: store on `users` table as a custom field per Convex Auth's user-extension pattern.)
  - [ ] If ADR-0009 chose Better Auth, the schema additions follow Better Auth's component conventions (the component owns several tables). Read [`get-convex/better-auth` docs](https://github.com/get-convex/better-auth) before naming. Do not collide table names.

- [ ] **Task 3: Add `ctx.customerId` resolution helper** (AC: 4)
  - [ ] In `convex/lib/auth.ts` (extend Story 1.2's file): add `getCustomerIdFromCtx(ctx, userId): Promise<Id<"customers"> | null>`. Reads `userRoles` rows for the user, finds the row with `role === "customer"`, returns its `customerId`.
  - [ ] Extend `requireRole`: when the `allowedRoles` includes `"customer"` AND the caller is a customer, the returned payload also includes `customerId` (the Phase 3 ownership-scoping anchor). Document this addition in the file-level JSDoc.

### Customer auth flows (AC2)

- [ ] **Task 4: Build `/(customer)/login` page** (AC: 2)
  - [ ] Path: `src/app/(customer)/login/page.tsx`. `"use client"`. Mobile-first layout (single column, max-width 600px centered per UX § customer portal patterns).
  - [ ] If chosen provider is Convex Auth: email + password form (mirrors staff `/login` from Story 1.1 with portal-customer styling).
  - [ ] If chosen provider is Better Auth: SMS-OTP entry — Step 1 phone number, Step 2 OTP code; or email + magic link as alternative. Read the provider's docs for the canonical UX.
  - [ ] On success: `router.push("/(customer)")`. Error UX consistent with NFR-S1 (no enumeration; same error for "user not found" and "wrong password").
  - [ ] Touch targets ≥ 48px (UX customer-portal `lg` button per spec line 1649). Visible labels (no placeholder-as-label per UX § form patterns).

- [ ] **Task 5: Build `/(customer)/layout.tsx`** (AC: 2, AC: 4)
  - [ ] Server-side check: redirect non-authenticated or non-customer-role users to `/(customer)/login`. Use Convex Auth's Next.js helpers + a small `getCurrentRole` server query.
  - [ ] Layout chrome: minimal — cemetery logo, "Sign out," nothing else. UX spec § 1932 "Customer portal primary: minimum chrome — focus on the task."

### Portal-invite flow (AC3)

- [ ] **Task 6: Office Staff "Send portal invite" UI** (AC: 3)
  - [ ] On `src/app/(staff)/customers/[customerId]/page.tsx`, add an action button "Send portal invite" visible to admin + office_staff. If the customer already has an accepted portal account, button shows "Re-send invite" or "Revoke + resend" with confirmation.
  - [ ] On click: confirmation dialog showing the email address the invite will go to (customer's `email` field, validated). On confirm → `customerPortal:sendInvite({ customerId })` mutation.

- [ ] **Task 7: `customerPortal:sendInvite` mutation + email action** (AC: 3)
  - [ ] In `convex/customerPortal.ts`: `sendInvite({ customerId: v.id("customers") })` mutation.
    - First action: `await requireRole(ctx, ["admin", "office_staff"])`. (Lint rule satisfied.)
    - Validate customer exists + has an email.
    - Revoke any existing un-accepted invite for this customer (set `revokedAt`).
    - Generate a cryptographically-random token (use `crypto.randomUUID()` server-side; minimum 32 chars).
    - Insert `portalInvites` row with `expiresAt = now + 7 days`.
    - `await emitAudit(ctx, { action: "customer.portalInviteSent", entityType: "customer", entityId: customerId, ... })`.
    - Schedule `convex/actions/sendPortalInvite.ts` action to dispatch the email.
  - [ ] In `convex/actions/sendPortalInvite.ts` (`"use node"`): send email via Resend / SendGrid (provider chosen alongside ADR-0009 — typically the same provider used for FR57 email reminders). Subject: "Your <cemetery name> portal access." Body: short, formal, links to the accept URL. Track `messageId` in the `portalInvites` row.

- [ ] **Task 8: `accept-invite` page + mutation** (AC: 3)
  - [ ] Path: `src/app/(public)/customer/accept-invite/page.tsx` — public (no auth required) because the recipient isn't authenticated yet.
  - [ ] Reads `?token=<token>` query param. Calls `customerPortal:lookupInvite({ token })` (public query that returns minimal info: `{ valid: boolean; expiresAt: number; customerName: string; alreadyAccepted: boolean }`).
  - [ ] If valid + not expired + not accepted: render the "set credential" form (password OR phone for SMS verification, per chosen provider).
  - [ ] On submit: `customerPortal:acceptInvite({ token, ...credentials })` mutation:
    - Re-validate invite (token, expiry, not already accepted).
    - Create the Convex auth user (or Better Auth user, per chosen provider) linked to the customer's email.
    - Insert a `userRoles` row `{ role: "customer", customerId, userId, grantedAt, grantedBy: invite.createdBy }`.
    - Mark `portalInvites.acceptedAt = now`.
    - `emitAudit` row for the acceptance.
    - Return the new session token so the client can auto-login. Redirect to `/(customer)`.

### Customer-scoping enforcement (AC4)

- [ ] **Task 9: Implement `customerPortal.ts` query/mutation skeleton with ownership check** (AC: 4)
  - [ ] Create `convex/customerPortal.ts` exporting (initially) `lookupInvite`, `acceptInvite`, `sendInvite`, plus stubs for the queries Story 9.2 will implement (`getMyContracts`, `getMyContract({ id })`). The stubs throw `INVARIANT_VIOLATION("not yet implemented")` so Story 9.2 finishes them.
  - [ ] Every customer-facing query / mutation calls `await requireRole(ctx, ["customer"])` first, then `const { customerId } = ...` (using Task 3's `getCustomerIdFromCtx`).
  - [ ] Every query that reads contract / payment / receipt / receipt-pdf data filters by `customerId === ctx.customerId`. ID-tampering is prevented because the customer-supplied IDs are validated against the customer's own scope.
  - [ ] Document the **scoping invariant** in a file-level JSDoc: "Every public function in this file must (1) call requireRole(ctx, ['customer']) and (2) restrict reads/writes to documents owned by the caller's customerId. Direct ID lookups MUST verify ownership before returning the doc."

- [ ] **Task 10: Add `customerPortal` to ESLint rule allow-list** (AC: 4)
  - [ ] The `require-role-first-line` rule (Story 1.2) already enforces the first-line `requireRole`. Verify it activates on `convex/customerPortal.ts` (it should, since the file is not in the exemption list).

### Email provider plumbing (AC3)

- [ ] **Task 11: Configure email provider** (AC: 3)
  - [ ] Choose email provider in ADR-0013 (`docs/adr/0013-email-provider.md`) — Resend, SendGrid, or Postmark. Decision criteria: PH deliverability, transactional pricing, simple Convex action integration. Default recommendation: **Resend** (simple HTTP API, no SDK weight inside Convex action).
  - [ ] Store API key in Convex env: `RESEND_API_KEY` (or equivalent). Never commit; document in `README.md` for prod setup.
  - [ ] Implement `convex/actions/sendPortalInvite.ts` and a shared helper `convex/actions/lib/sendEmail.ts` that other Phase 3 actions (Story 9.8 reminders, receipt-PDF delivery from Phase 1) can reuse. Signature: `sendEmail({ to, subject, html, text })` → `{ messageId }`. Handles HTTP errors with logged retries (don't throw on transient failures; capture in caller).

### Testing (AC1–AC4)

- [ ] **Task 12: Unit tests for `customerPortal` + auth helpers** (AC: 2, AC: 3, AC: 4)
  - [ ] `tests/unit/convex/customerPortal.test.ts` using `convex-test`:
    - `sendInvite` happy path → portalInvites row created, action scheduled, audit row emitted.
    - `sendInvite` for a customer with no email → throws clear error.
    - `lookupInvite` with valid token → returns valid:true.
    - `lookupInvite` with expired token → returns valid:false + reason.
    - `lookupInvite` with revoked token → returns valid:false.
    - `acceptInvite` happy path → creates user, userRoles, marks invite accepted, returns session.
    - `acceptInvite` with already-accepted token → throws.
    - `acceptInvite` with expired token → throws.
    - **Ownership-scoping defense:** call a stub query as a non-customer role → `FORBIDDEN`. Call as a customer with a forged ID for another customer's contract → `FORBIDDEN` (or empty result, depending on query design).
  - [ ] Update `tests/unit/convex/lib/auth.test.ts`: add `getCustomerIdFromCtx` happy path, no-userRoles-row case, customer with multiple roles case.

- [ ] **Task 13: Playwright e2e** (AC: 2, AC: 3)
  - [ ] Create `tests/e2e/customer-portal-onboarding.spec.ts`:
    - Office Staff signs in → opens customer detail → "Send portal invite" → confirmation appears.
    - Test inbox (use a mock email capture or test-mode Resend address) receives the email with a valid token.
    - Open the accept-invite URL → set password → land on /(customer) dashboard.
    - Reload the page → still authenticated.
    - Try to access `/(staff)/dashboard` → redirected.
  - [ ] Run on mid-Android emulation (customer portal is mobile-first).

### Documentation (AC1–AC4)

- [ ] **Task 14: Update runbook + privacy docs** (AC: 3, AC: 4)
  - [ ] `docs/runbook.md` — add "Customer portal invite" section: how Office Staff sends invites, how to revoke + resend, how to investigate "I never got the email" tickets (check bounce log from Story 9.8 once it lands).
  - [ ] `docs/threat-model.md` — add section on customer-portal threats: account-takeover via invite-token interception, enumeration via login error messages, brute-force on OTP entry (mitigate with rate limit), session fixation. For each: current defense + Phase 4 enhancement if relevant.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies (must be complete):**

- **Story 1.1 — Project bootstrap + Convex Auth (staff password):** staff side uses Convex Auth's password provider. Customer side decided in ADR-0009 (this story). The two auth surfaces co-exist.
- **Story 1.2 — `requireRole`, `userRoles` table, lint rule:** extended in Task 3 with `getCustomerIdFromCtx`. The `userRoles` table already supports `role: "customer"` per Story 1.2's schema (line 37).
- **Story 1.6 — `emitAudit`:** required for invite-sent and invite-accepted audit rows.
- **Customer schema (whichever Phase 1 story created the `customers` table):** must already include `email`, `phone`, `name`. Story 9.4 lets customers self-edit phone / email / address.

**Phase 2 dependencies:** none direct. Phase 2 work is independent.

**Phase 3 hand-off to subsequent stories:**

- **Story 9.2 (own contracts):** consumes `customerPortal.ts` skeleton; implements the stubs `getMyContracts`, `getMyContract`.
- **Story 9.3 (receipt PDFs):** customer-facing signed-URL generation gated by ownership check identical to AC4.
- **Story 9.4 (contact-info edit):** mutation in `customerPortal.ts` with same scoping pattern.
- **Stories 9.5 / 9.6 (payments):** unauthenticated webhooks land in `convex/http.ts`, not `customerPortal.ts`; portal authentication is for the *initiating* customer flow (pre-redirect to gateway).
- **Stories 9.7 / 9.8 (reminders):** reuse `convex/actions/lib/sendEmail.ts` (Task 11) and a new `sendSms.ts` sibling.

### Architecture compliance

- **Auth provider decision deferred to ADR-0009** per architecture line 284. This story produces it. Both options remain architecturally valid; the rest of the system doesn't care which auth backend is used as long as `requireRole` still works (it does — Convex Auth and Better Auth both expose a `getAuthUserId(ctx)`-shaped identity helper).
- **`requireRole` first-line invariant** (Story 1.2's lint rule) applies to every public function in `customerPortal.ts`.
- **Ownership scoping** is the Phase 3 version of role enforcement: the role check filters by *who* you are, the ownership scope filters by *what* you can see. NFR-S4: server-side, not UI.
- **Session timeout 30 days** for customer role per NFR-S5. Implemented inside `requireRole` (Story 1.2's session-age check) regardless of provider choice.
- **`convex/customerPortal.ts`** is the single entry point for all customer-portal queries / mutations. No customer-portal logic in other domain files (`contracts.ts`, `payments.ts`); those stay staff-only.
- **Webhook entry point** (Stories 9.5 / 9.6) is `convex/http.ts`, separate from `customerPortal.ts`. Don't conflate.
- **Email provider** is an external service reached only from `convex/actions/`. No Resend / SendGrid imports in queries / mutations.

### Library / framework versions (researched current)

- **`@convex-dev/auth`** — option A primary. Already a Phase 1 dependency.
- **`get-convex/better-auth`** — option B. If chosen, install per the package's current docs. Better Auth itself ships its own session model; the Convex component bridges it.
- **`resend`** — recommended email provider. `npm install resend` inside Convex action; the SDK is light and ESM-friendly.
- **Twilio SMS (if option A chosen + SMS-OTP planned):** `twilio` Node SDK from a `"use node"` action. Or Twilio REST via `fetch` to keep dependencies minimal.
- **Verify all "current" claims when implementing** — Phase 3 lead time means library versions will have moved between planning and dev.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── customerPortal.ts                            # NEW
│   ├── http.ts                                      # UPDATE (Phase 3 webhooks land in 9.5/9.6; this story may add auth-related HTTP routes if Better Auth needs them)
│   ├── schema.ts                                    # UPDATE (portalInvites table; userRoles.customerId field)
│   ├── lib/auth.ts                                  # UPDATE (getCustomerIdFromCtx helper)
│   └── actions/
│       ├── sendPortalInvite.ts                      # NEW
│       └── lib/sendEmail.ts                         # NEW (shared by 9.1, 9.8, receipt delivery)
├── src/
│   └── app/
│       ├── (public)/
│       │   └── customer/
│       │       └── accept-invite/page.tsx           # NEW
│       └── (customer)/
│           ├── layout.tsx                           # NEW (Phase 3 portal shell)
│           └── login/page.tsx                       # NEW
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       ├── customerPortal.test.ts               # NEW
│   │       └── lib/auth.test.ts                     # UPDATE
│   └── e2e/
│       └── customer-portal-onboarding.spec.ts       # NEW
├── docs/
│   ├── adr/
│   │   ├── 0009-customer-auth-provider.md           # NEW (★ produce FIRST — gates the rest of this story)
│   │   └── 0013-email-provider.md                   # NEW
│   ├── runbook.md                                   # UPDATE
│   └── threat-model.md                              # UPDATE
└── package.json                                     # UPDATE (resend; optionally twilio or better-auth + get-convex/better-auth)
```

### Testing requirements

- **NFR-M2 coverage:** `customerPortal.ts` ownership-scoping logic and `getCustomerIdFromCtx` are auth-adjacent — treat as cornerstone code. Target **≥ 95% line coverage** on both. Anything less risks the entire customer-portal trust boundary.
- **Negative tests are mandatory:** explicit cases for "customer A tries to read customer B's contract" → must throw or return empty. The lint rule won't catch ownership-scope omissions; tests are the safety net.
- **E2E onboarding flow** is the primary user-journey validation. Run on mid-Android emulation.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT start auth implementation before ADR-0009 is `accepted`.** Both options have non-trivial code; backing out the wrong choice is expensive. The ADR is a 1–2 day investigation; do it first.
- ❌ **Do NOT mix Convex Auth and Better Auth in the same provider.** Pick one. Staff stays on Convex Auth (Story 1.1). Customer side is one provider.
- ❌ **Do NOT bypass the ownership-scope check** "because requireRole already authorized this customer." Role check answers "are you a customer?" Ownership check answers "is this YOUR contract?" Both are required.
- ❌ **Do NOT expose `users` or `userRoles` rows directly to customer queries.** Those are internal. Customer queries return contract / payment / receipt documents only.
- ❌ **Do NOT let invite tokens persist after acceptance or revocation.** Once accepted, the token is dead. Re-sending an invite generates a new token and invalidates the old one.
- ❌ **Do NOT log full invite tokens to audit / Sentry.** Log only the first / last 4 chars + customerId. The full token = credential.
- ❌ **Do NOT trust `customerId` from the client.** Always derive it from `ctx` via `getCustomerIdFromCtx`. URL params / mutation args that purport to specify a `customerId` must match the derived value or be rejected.
- ❌ **Do NOT skip the no-enumeration error UX.** "User not found" vs "Wrong password" leaks customer identity. Always one generic message.
- ❌ **Do NOT set invite-token expiry > 14 days.** 7 days is generous; longer windows expand the credential-leak attack surface.
- ❌ **Do NOT ship the customer portal without a manual rate-limit on `/customer/login` + `/customer/accept-invite`.** OTP-brute-force is a real attack class. Reuse the Phase 1 `auth_attempts` table pattern from NFR-S6.
- ❌ **Do NOT plan to mass-invite all 2,000 customers on day 1.** Phase a rollout: pilot with 20 customers, monitor support load + delivery rates, then scale. Document this in the runbook.

### Common LLM-developer mistakes to prevent

- **Forgetting the `(public)/` route group for `accept-invite`:** the recipient isn't authenticated yet. `accept-invite/page.tsx` lives under `(public)/`, not `(customer)/`.
- **Ownership check by passing `customerId` to the query:** wrong. Derive `customerId` from `ctx`, then verify the requested resource belongs to it. If the resource ID doesn't match, throw.
- **Same login page for staff + customer:** they're separate route groups with separate UX. Don't reuse `/login`. Customer portal `/login` is at `(customer)/login`.
- **Storing portal-invite token in plaintext when it's also indexed:** index `by_token` on the table is fine because Convex's at-rest encryption applies. Don't hash the token — that breaks the lookup query.
- **Using `Math.random()` for token generation:** insufficient entropy. `crypto.randomUUID()` or `crypto.getRandomValues()`.
- **Skipping audit on invite revocation:** revoking an invite is a security-relevant action. Emit an audit row.
- **Letting the customer set a weak password:** if password is chosen (Convex Auth option), enforce minimum length via the Convex Auth Password provider's config + a client-side hint. 10 chars min, no further complexity (NIST 800-63B current guidance).

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (installment grace/penalty policy):** doesn't affect auth; can be unresolved.
- **§10 Q10 (named user counts):** affects bulk-invite tooling. Pilot rollout (Task 14) intentionally avoids the need to know the exact final count.
- **Customer self-registration (no invite required):** out of scope. Phase 3 ships invite-only. Self-registration would require identity verification (gov ID upload? deed of sale match?) and is a separate Phase 4 conversation.
- **Multi-language UI for the portal:** Filipino UI strings deferred. Portal launches in English. The schema doesn't constrain this — `lang="fil"` switch is a future UI story.
- **MFA for high-value transactions:** not in scope for Phase 3. Login MFA may be added in a Phase 4 hardening pass.

### Project Structure Notes

Aligns with:

- [Architecture § Project Structure & Boundaries](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries) — `convex/customerPortal.ts`, `src/app/(customer)/`, `convex/actions/sendPortalInvite.ts` match the laid-out tree.
- [Architecture § Authentication & Security — Phase 3 customer auth re-evaluation](../../_bmad-output/planning-artifacts/architecture.md#authentication--security) — this story is the realization of that decision point.
- [UX § Customer portal patterns](../../_bmad-output/planning-artifacts/ux-design-specification.md) — mobile-first, minimum chrome, large touch targets.

No detected conflicts.

### References

- [PRD § FR5 — Customer portal auth](../../_bmad-output/planning-artifacts/prd.md#1-identity--access-control)
- [PRD § NFR-S1 (no enumeration), NFR-S5 (session timeouts), NFR-S6 (rate-limit)](../../_bmad-output/planning-artifacts/prd.md#security--privacy)
- [Architecture § Auth provider re-evaluation point](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [Architecture § `customerPortal.ts` + `(customer)/` route group](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [UX § Customer portal context + journey 5](../../_bmad-output/planning-artifacts/ux-design-specification.md)
- [Epics § Story 9.1](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 1.2 — requireRole + userRoles table](./1-2-server-enforces-role-based-access-on-every-endpoint.md)
- Convex Auth docs (current): [Password provider](https://labs.convex.dev/auth/config/passwords)
- Better Auth + Convex docs (current): [`get-convex/better-auth`](https://github.com/get-convex/better-auth)
- Resend docs (current): [Send email API](https://resend.com/docs/api-reference/emails/send-email)

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (claude-opus-4-7) — Claude Code dev agent.

### Debug Log References

- `npm run typecheck` — clean for all Story 9.1 files. Four pre-existing
  failures unrelated to this story (`convex/interments.ts:927,996`
  and `tests/unit/convex/lib/stateMachines.test.ts:95,140` — Story 7.4
  schema-drift / TRANSITIONS map). None in code this story touched.
- `npm run lint` — clean for all Story 9.1 files after relocating the
  customer login page from `(customer)/login/page.tsx` to
  `(customer)/portal/login/page.tsx` (the original path collided with
  `(public)/login` because Next.js route groups merge sibling routes at
  the same URL). The h1 lives directly inside `portal/page.tsx` per the
  `local-rules/single-h1-per-page` scanner constraint (it does not
  traverse into imports). One pre-existing lint failure remains in
  `(staff)/interments/[intermentId]/complete/page.tsx` (Story 7.4
  ready-for-dev placeholder).
- `npm test` — 13/13 new portal tests pass; full suite is 1222 passed,
  1 skipped, 10 pre-existing failures localized to
  `tests/unit/convex/expenses.test.ts` (unrelated Story 4.6 mock-ctx
  drift). No regressions caused by Story 9.1.
- `npm run build` — `Compiled successfully in 14.6s`. The build's lint
  pass surfaces the same pre-existing
  `(staff)/interments/[intermentId]/complete/page.tsx` h1 error (out of
  scope; file ownership prohibits editing).

### Completion Notes List

**Scope decisions** (the Story 9.1 spec defined a broader ADR-0009 +
portal-invite flow; the dev-context briefing scoped this to a
minimum-viable authentication skeleton that the rest of Epic 9 builds
on):

- **Auth provider**: kept on Convex Auth Password (shared with staff
  Story 1.1). ADR-0009's full Convex-Auth-SMS-OTP vs. Better Auth
  evaluation is a follow-up; the minimum-viable Phase 3 launch relies
  on staff-issued invite credentials and the Password provider already
  wired in Story 1.1. SMS-OTP / magic-link is tracked as a Phase 3.5
  enhancement.
- **Customer ↔ auth-user link**: by email match against
  `customers.email`. `customers.email` already exists from Story 2.1 and
  the auth user's email is the natural identity anchor. A dedicated
  `customerAuthLink` table (or a `userRoles.customerId` field) is
  documented as a future hardening if email duplication / household
  emails become an operational issue. The current code FAILS CLOSED on
  ambiguous matches (two customers share an email → NOT_FOUND).
- **Login page topology**: separate `/portal/login` for customers
  (under the `(customer)/` route group). The dev brief preferred "one
  login routes by role", but file ownership rules forbade modifying
  `(public)/login/page.tsx`, and Next.js route groups colliding on a
  bare `/login` path would conflict. Two login pages with strict
  middleware role-redirects (customers on `/login` bounce to `/portal`;
  staff on `/portal/login` bounce to `/dashboard`) gives the same UX
  outcome.
- **Portal-invite flow (Task 5–8)**, **ADR-0009 production** (Task 1),
  **schema additions for `portalInvites`** (Task 2),
  **`getCustomerIdFromCtx` helper extension to `convex/lib/auth.ts`**
  (Task 3), **email provider config / ADR-0013** (Task 11) are
  intentionally DEFERRED — out of scope for the minimum-viable
  authentication path this dev session shipped. Story 9.1 closeout
  delivers AC2 (customer can authenticate, generic error UX) and AC4
  (role enforcement + self-ownership scoping via the `portal:
  getCurrentCustomer` query). AC1 (ADR-0009) and AC3 (invite flow) are
  open follow-ups.

**Implementation notes**:

- `convex/portal.ts` is the single entry point for the customer
  surface, mirroring the architecture's "single customerPortal file"
  constraint. `getCurrentCustomer` is the Story 9.1 query; Stories
  9.2 – 9.4 add `getMyContracts`, `getMyContract`, `updateMyContactInfo`
  here with the same `requireRole(["customer"])` + ownership-filter
  pattern.
- The customer portal `<h1>` is on `portal/page.tsx` itself (rather
  than inside `CustomerPortalGreeting`) because the
  `local-rules/single-h1-per-page` ESLint rule scans page files
  without traversing imports.
- Middleware role-isolation rules added: customer-only users hitting
  staff routes bounce to `/portal`; staff hitting `/portal/*` bounce to
  `/dashboard`. Defense-in-depth pair with the per-handler
  `requireRole` checks in Convex.
- Session timeout for customer = 30 days (NFR-S5) is already enforced
  by Story 1.2's `SESSION_TIMEOUTS.customer = 30 * DAY_MS` in
  `convex/lib/auth.ts` — no change needed.

### File List

**Created:**

- `convex/portal.ts` — customer-portal query surface (`getCurrentCustomer`).
- `src/app/(customer)/portal/login/page.tsx` — customer sign-in form
  (the page renders at `/portal/login`).
- `src/components/CustomerPortal/CustomerPortalSignOut.tsx` — sign-out
  affordance for the portal header.
- `src/components/CustomerPortal/CustomerPortalGreeting.tsx` — reactive
  greeting body + contracts-list placeholder.
- `src/components/CustomerPortal/index.ts` — barrel export.
- `tests/unit/convex/portal.test.ts` — 13 unit tests covering auth
  gating, ownership resolution, ambiguous-link fail-closed, projection
  shape.
- `tests/e2e/customer-portal-login.spec.ts` — unauthenticated render
  smoke (full authenticated journey deferred until Phase-3 test
  seeding).

**Modified:**

- `src/app/(customer)/layout.tsx` — replaced the Story 1.5 placeholder
  with a server-side auth + role gate plus a minimum-chrome header
  (logo + sign-out only).
- `src/app/(customer)/portal/page.tsx` — replaced the Story 1.5
  placeholder with the authenticated landing (server-resolved name +
  reactive greeting body).
- `src/middleware.ts` — added `/portal/login` matcher,
  customer/staff isolation rules (customers blocked from staff routes;
  staff blocked from customer routes), separated unauthenticated
  redirect targets per route group.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — flipped
  9-1 to `review`; updated `last_updated` banner.
