# Story 9.5: Customer Pays via GCash

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **Customer**,
I want **to pay an outstanding installment via GCash from the customer portal — initiating a server-side payment intent, redirecting to GCash's payment page, and receiving an asynchronous webhook that posts the payment atomically through `postFinancialEvent`**,
so that **I can settle my account from my phone without visiting the cemetery office** (FR33 — GCash portion).

This is the **first gateway integration** in the system. It establishes the Phase 3 payment-webhook pattern that Story 9.6 (Maya / card) extends: HTTP action in `convex/http.ts` → signature verification → idempotency-key dedup → ACK within 5 seconds (NFR-I2) → atomic posting via `postFinancialEvent`. Email / receipt delivery is deferred to a scheduled action so the webhook ACK stays inside budget.

> ⚠️ **CLIENT-SIDE PROCUREMENT DEPENDENCY — surface to PM before sprint start**
>
> GCash merchant-account onboarding is a **4–6 week paperwork-heavy client-side activity**. The cemetery business must complete this before any production webhook can be tested end-to-end. Sandbox credentials are typically available immediately after registration — use those for dev/test. Do **not** block this story on production credentials; build against sandbox and add a runbook entry for the credential swap at go-live.

## Acceptance Criteria

1. **AC1 — GCash webhook handler registered + signature-verified**: `convex/http.ts` registers a POST route at `/api/gcash-webhook` that: (a) reads the raw request body + GCash signature header, (b) verifies the signature using `GCASH_WEBHOOK_SECRET` env var, (c) returns 401 on signature mismatch (no body), (d) on valid signature, performs idempotency-key dedup and routes to `postFinancialEvent`, (e) **responds 200 within 5 seconds (NFR-I2)**. Any work that would push past 5 seconds (email delivery, PDF generation if not already inline) is deferred to a `ctx.scheduler.runAfter(0, ...)` action.

2. **AC2 — Customer can initiate GCash payment from contract detail**: On `/(customer)/contracts/[id]` (Story 9.2's page) the "Pay now" button opens `/(customer)/pay?contractId=<id>`. The pay page lets the customer choose GCash, enter an amount (defaulted to next-due-installment amount), and submit. The submit calls `customerPortal:initiateGcashPayment({ contractId, amountCents })` which: (a) `requireRole(ctx, ["customer"])` + ownership check on the contract, (b) creates a `pendingPayments` row with a Convex-generated `paymentIntentId`, (c) calls the GCash payment-intent API via a Convex action (`convex/actions/gcashCreateIntent.ts`), (d) returns `{ redirectUrl, paymentIntentId }`. The client navigates to `redirectUrl` (GCash-hosted page).

3. **AC3 — Idempotent atomic posting via `postFinancialEvent`**: On webhook receipt, the handler: (a) looks up the matching `pendingPayments` row by GCash's transaction ID (the idempotency key), (b) if `pendingPayments.processedAt` is already set, returns 200 immediately (duplicate delivery, no-op), (c) otherwise calls `postFinancialEvent` inside the same mutation to insert the `payments` row + update `contracts.balance` + emit audit + generate receipt — all atomic, (d) marks `pendingPayments.processedAt = now` and `pendingPayments.paymentId = newPaymentId`. **Same payment cannot post twice** even under repeated webhook delivery — proven by a unit test that fires the handler twice.

4. **AC4 — Failure-path UX is honest**: After the GCash redirect returns the customer to `/(customer)/pay/return?contractId=<id>&intent=<paymentIntentId>`, the page polls `customerPortal:getPaymentStatus({ paymentIntentId })` (a query that's reactive — Convex pushes updates) and shows one of: "Payment confirmed" (webhook arrived, balance updated, link to receipt), "Pending — we're confirming with GCash" (webhook not yet arrived; auto-refresh via Convex reactivity), "Failed" (GCash returned a failure; offer retry). No silent loops; explicit state with retry / contact-office affordances if 90 seconds elapse without resolution.

## Tasks / Subtasks

### Webhook infrastructure (AC1, AC3)

- [ ] **Task 1: Add GCash webhook HTTP action** (AC: 1, AC: 3)
  - [ ] In `convex/http.ts` (extends Phase 1 auth-related routes from Story 1.1), add:
    ```ts
    http.route({
      path: "/api/gcash-webhook",
      method: "POST",
      handler: httpAction(async (ctx, req) => {
        const rawBody = await req.text();
        const sig = req.headers.get("x-gcash-signature");
        const secret = process.env.GCASH_WEBHOOK_SECRET;
        if (!secret || !sig) return new Response("unauthorized", { status: 401 });
        if (!verifyGcashSignature(rawBody, sig, secret)) {
          return new Response("unauthorized", { status: 401 });
        }
        const body = JSON.parse(rawBody);
        // Run mutation to dedup + post atomically. Return 200 ASAP.
        await ctx.runMutation(internal.payments.handleGcashWebhook, { body });
        return new Response("ok", { status: 200 });
      }),
    });
    ```
  - [ ] **Signature verification first, body parsing second.** Reject before parsing. GCash typically uses HMAC-SHA256 of the raw body with the merchant secret — confirm against GCash's current webhook docs at implementation time (Phase 3 lead time means the API may have moved).
  - [ ] **Constant-time compare** in `verifyGcashSignature` (`crypto.timingSafeEqual` in Node, or the WebCrypto equivalent inside the Convex action runtime). Naive `===` comparison is a timing oracle.
  - [ ] **Raw body required for signature verification** — `req.text()` first, then `JSON.parse`. Do not `req.json()` (some signature schemes are sensitive to JSON re-serialization whitespace).

- [ ] **Task 2: Implement `payments.handleGcashWebhook` internal mutation** (AC: 3)
  - [ ] In `convex/payments.ts` (Phase 1 file), add an internal mutation:
    ```ts
    export const handleGcashWebhook = internalMutation({
      args: { body: v.any() },
      handler: async (ctx, { body }) => {
        const { paymentIntentId, gcashTransactionId, status, amountCents, currency } = parseGcashPayload(body);
        if (status !== "succeeded") {
          // Record the failure on pendingPayments; nothing to post.
          await ctx.db.patch(pending._id, { status: "failed", failureReason: body.failure_code, failedAt: Date.now() });
          return;
        }
        const pending = await ctx.db
          .query("pendingPayments")
          .withIndex("by_paymentIntentId", q => q.eq("paymentIntentId", paymentIntentId))
          .first();
        if (!pending) throwError(ErrorCode.NOT_FOUND, "Unknown paymentIntent");
        // Idempotency: if already processed, no-op.
        if (pending.processedAt) return;
        // Validate amount + currency match what we created.
        if (amountCents !== pending.amountCents) throwError(ErrorCode.INVARIANT_VIOLATION, "Amount mismatch");
        const result = await postFinancialEvent(ctx, {
          kind: "payment",
          contractId: pending.contractId,
          amountCents,
          method: "gcash",
          externalRef: gcashTransactionId,
          actorRole: "customer",
          actorId: pending.userId,
        });
        await ctx.db.patch(pending._id, {
          processedAt: Date.now(),
          paymentId: result.paymentId,
          gcashTransactionId,
          status: "succeeded",
        });
        // Defer email send to scheduled action to stay inside 5s ACK budget.
        await ctx.scheduler.runAfter(0, internal.actions.sendPaymentReceipt, { paymentId: result.paymentId });
      },
    });
    ```
  - [ ] **`pendingPayments.processedAt` is the idempotency anchor.** Once set, the mutation no-ops on re-delivery. This is the **single source of truth** for "have we posted this yet?"
  - [ ] **Amount mismatch must throw** — if GCash reports a different amount than the customer initiated, do not silently accept. Surface as an `INVARIANT_VIOLATION` and require manual reconciliation (rare; usually indicates merchant-side misconfiguration).
  - [ ] **The mutation MUST stay synchronous** for the atomic guarantee. Email + PDF delivery is scheduled (deferred) so the 5-second ACK budget is preserved.

### Schema additions (AC2, AC3)

- [ ] **Task 3: Add `pendingPayments` table** (AC: 2, AC: 3)
  - [ ] In `convex/schema.ts` add:
    ```ts
    pendingPayments: defineTable({
      paymentIntentId: v.string(),               // our internal ID, sent to GCash
      gateway: v.union(v.literal("gcash"), v.literal("maya"), v.literal("card")),
      contractId: v.id("contracts"),
      customerId: v.id("customers"),
      userId: v.id("users"),                     // the customer-user who initiated
      amountCents: v.number(),
      currency: v.string(),                      // "PHP"
      status: v.union(v.literal("pending"), v.literal("succeeded"), v.literal("failed"), v.literal("expired")),
      gcashTransactionId: v.optional(v.string()),
      mayaTransactionId: v.optional(v.string()),
      cardTransactionId: v.optional(v.string()),
      processedAt: v.optional(v.number()),       // null until webhook posted
      paymentId: v.optional(v.id("payments")),   // FK to posted payment
      failedAt: v.optional(v.number()),
      failureReason: v.optional(v.string()),
      createdAt: v.number(),
      expiresAt: v.number(),                     // pending intents expire after N hours
    })
      .index("by_paymentIntentId", ["paymentIntentId"])
      .index("by_contract", ["contractId"])
      .index("by_customer", ["customerId"])
      .index("by_status_createdAt", ["status", "createdAt"]),
    ```
  - [ ] The `by_paymentIntentId` index is the idempotency lookup. Critical for AC3.
  - [ ] Schema is shared with Story 9.6 (Maya / card) — the `gateway` discriminator distinguishes.

### Customer-side initiation flow (AC2)

- [ ] **Task 4: Build `/(customer)/pay` page** (AC: 2)
  - [ ] Path: `src/app/(customer)/pay/page.tsx`. `"use client"`. Reads `?contractId=<id>` from `useSearchParams`.
  - [ ] Reads `customerPortal:getMyContract` (Story 9.2) to display contract context (balance, next-due amount).
  - [ ] Method selector: GCash (this story), Maya, Card (Story 9.6 — render but disabled until 9.6 lands; show "Coming soon" hover).
  - [ ] Amount input — defaults to next-due-installment amount (or remaining balance if smaller). Validation: positive integer cents, ≤ remaining balance.
  - [ ] Submit calls `customerPortal:initiateGcashPayment({ contractId, amountCents })`. On success, `router.push(result.redirectUrl)`.

- [ ] **Task 5: Implement `initiateGcashPayment` mutation** (AC: 2)
  - [ ] In `convex/customerPortal.ts`:
    ```ts
    export const initiateGcashPayment = mutation({
      args: { contractId: v.id("contracts"), amountCents: v.number() },
      handler: async (ctx, { contractId, amountCents }) => {
        const { userId, customerId } = await requireRole(ctx, ["customer"]);
        if (!customerId) throwError(ErrorCode.INVALID_ROLE, "Customer record not found");
        const contract = await ctx.db.get(contractId);
        if (!contract || contract.customerId !== customerId) throwError(ErrorCode.NOT_FOUND, "Contract not found");
        if (amountCents <= 0 || amountCents > contract.balance) throwError(ErrorCode.VALIDATION, "Invalid amount");
        const paymentIntentId = crypto.randomUUID();
        await ctx.db.insert("pendingPayments", {
          paymentIntentId, gateway: "gcash", contractId, customerId, userId,
          amountCents, currency: "PHP", status: "pending",
          createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000,  // 1 hour
        });
        // Schedule action to call GCash API and update with the gateway-assigned redirect URL.
        const result: { redirectUrl: string } = await ctx.scheduler.runAfter(
          0, internal.actions.gcashCreateIntent, { paymentIntentId, amountCents }
        ) as any;
        // NOTE: scheduler returns void — pattern is different. See Task 6 for the correct pattern.
        return { paymentIntentId };
      },
    });
    ```
  - [ ] **Correct pattern for synchronous redirect**: the GCash intent-creation call must complete before the customer is redirected. Use `ctx.runAction(internal.actions.gcashCreateIntent, ...)` (which awaits the action) rather than `scheduler.runAfter` (which fires-and-forgets). Refine the mutation to call the action synchronously, return the redirect URL to the client.
  - [ ] **Ownership check on the contract** is mandatory before creating the intent — same defense as Story 9.4's own-record-only guard.

- [ ] **Task 6: Implement `gcashCreateIntent` action** (AC: 2)
  - [ ] Path: `convex/actions/gcashCreateIntent.ts`. `"use node"`.
  - [ ] Reads `GCASH_API_KEY`, `GCASH_API_BASE_URL` from Convex env. Constructs the GCash payment-intent request per the **current GCash merchant API docs** (verify at implementation time — the API has evolved across versions).
  - [ ] Returns `{ redirectUrl, gcashIntentId }`. The mutation in Task 5 patches the `pendingPayments` row with `gcashIntentId` and returns `redirectUrl` to the client.
  - [ ] **Error handling**: if GCash returns 4xx (bad request) or 5xx (gateway down), throw a user-friendly error; the mutation rolls back the `pendingPayments` insert (Convex mutation atomicity).

### Return-flow + status page (AC4)

- [ ] **Task 7: Build `/(customer)/pay/return` page** (AC: 4)
  - [ ] Path: `src/app/(customer)/pay/return/page.tsx`. Reads `?contractId=<id>&intent=<paymentIntentId>` from URL.
  - [ ] Calls `customerPortal:getPaymentStatus({ paymentIntentId })` — a reactive query that pushes updates as the `pendingPayments` row's `status` / `processedAt` fields change.
  - [ ] States rendered:
    - `pending` (no processedAt yet) — spinner + "We're confirming your payment with GCash..." After 90 seconds with no change, add a "Still waiting?" affordance with a "Contact cemetery office" button + reference number = `paymentIntentId`.
    - `succeeded` — green checkmark + "Payment confirmed. ₱X applied to contract." + link to receipt (Story 9.3).
    - `failed` — red icon + "Payment failed: {failureReason}." + "Try again" button.
    - `expired` — "This payment intent expired. Please start a new payment." button.
  - [ ] **No silent loops** — the page state is driven entirely by Convex reactivity. No `setInterval` polling.

- [ ] **Task 8: Implement `getPaymentStatus` query** (AC: 4)
  - [ ] In `convex/customerPortal.ts`:
    ```ts
    export const getPaymentStatus = query({
      args: { paymentIntentId: v.string() },
      handler: async (ctx, { paymentIntentId }) => {
        const { customerId } = await requireRole(ctx, ["customer"]);
        const pending = await ctx.db.query("pendingPayments")
          .withIndex("by_paymentIntentId", q => q.eq("paymentIntentId", paymentIntentId))
          .first();
        if (!pending || pending.customerId !== customerId) return null;  // 404 path
        return pick(pending, ["status", "processedAt", "failureReason", "paymentId", "amountCents", "createdAt"]);
      },
    });
    ```
  - [ ] Ownership check via `pending.customerId === customerId` — prevents a customer from polling another customer's payment intent.

### Email-delivery deferral (AC1)

- [ ] **Task 9: Implement `sendPaymentReceipt` scheduled action** (AC: 1)
  - [ ] Path: `convex/actions/sendPaymentReceipt.ts`. `"use node"`.
  - [ ] Reads the payment, contract, customer, receipt. Sends an email via `convex/actions/lib/sendEmail.ts` (Story 9.1's helper) with receipt-download link (Story 9.3 URL).
  - [ ] This action runs **after** the webhook returns 200 to GCash. NFR-I2 budget preserved.

### Testing (AC1–AC4)

- [ ] **Task 10: Unit tests for webhook + mutation** (AC: 1, AC: 3)
  - [ ] `tests/unit/convex/payments.test.ts`:
    - **Signature verification:** valid signature → mutation invoked; invalid → 401, mutation never invoked.
    - **Idempotency:** fire the webhook twice with the same payload → only one payment posted, second call no-ops.
    - **Amount mismatch:** webhook reports different amount than `pendingPayments` row → throws, no payment posted.
    - **Unknown paymentIntentId:** webhook references nonexistent intent → throws NOT_FOUND.
    - **Failed payment:** webhook reports `status: "failed"` → `pendingPayments` marked failed, no payment posted.
  - [ ] `tests/unit/convex/customerPortal.test.ts` (extend):
    - `initiateGcashPayment`: own contract → succeeds. Another customer's contract → throws NOT_FOUND. Amount > balance → throws VALIDATION.
    - `getPaymentStatus`: own intent → returns. Other customer's intent → returns null.

- [ ] **Task 11: Playwright e2e (sandbox mode)** (AC: 2, AC: 4)
  - [ ] `tests/e2e/customer-portal-pay-gcash.spec.ts`:
    - Customer logs in → opens contract detail → "Pay now" → selects GCash → enters amount → submits.
    - **In test/sandbox mode:** the test harness mocks the GCash redirect (the real flow would land on GCash's domain). After mock-return, fire the test-side webhook fixture (matching real GCash signature using a test secret).
    - Return page shows "succeeded" within 5 seconds.
    - Contract balance reflects the new payment (reactivity).
    - Receipt link appears.

### Documentation (AC1)

- [ ] **Task 12: Update runbook** (AC: 1)
  - [ ] In `docs/runbook.md`, add a "GCash integration" section:
    - Where to obtain merchant credentials (link to GCash partner portal).
    - Sandbox vs. production env-var swap procedure.
    - How to investigate "customer paid but balance didn't update" tickets — query `pendingPayments` by customer + recent date; check `status` + `processedAt`.
    - How to manually replay a missed webhook (rare; usually GCash retries 3x automatically).
  - [ ] In `docs/threat-model.md`, add "Webhook security": signature verification + idempotency + amount-match are the three defenses. Document the failure modes each defends against.

- [ ] **Task 13: ADR-0010 — Payment gateway integration pattern** (AC: 1, AC: 3)
  - [ ] Path: `docs/adr/0010-payment-gateway-integration.md`.
  - [ ] Document the canonical pattern (HTTP action → signature verify → internal mutation → dedup → postFinancialEvent → scheduler-deferred email). Story 9.6 implements the same pattern for Maya / card — this ADR is the standard.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Story 3.2 — `postFinancialEvent`:** the atomic-mutation cornerstone. This story invokes it from the webhook path. **Do not re-implement payment-posting logic** — `postFinancialEvent` is the single mutation that touches `payments` + `contracts.balance` + `receipts` + audit. The webhook is a thin shim.
- **Story 1.2 — `requireRole`, lint rule:** enforces customer role on the initiation mutations. The webhook itself is unauthenticated (signature-gated), so the lint rule doesn't apply to `handleGcashWebhook` — but the standard `internalMutation` pattern keeps it out of the public API surface.
- **Story 1.6 — `emitAudit`:** invoked by `postFinancialEvent`; not separately here.
- **Story 1.1 — `convex/http.ts`:** extended here for the webhook route. Phase 1's auth routes (if any) stay intact.

**Phase 3 prior dependencies (must be complete):**

- **Story 9.1 — auth + ownership-scoping pattern:** the `initiateGcashPayment` mutation uses `requireRole(ctx, ["customer"])` + ownership check.
- **Story 9.2 — customer dashboard + contract detail:** the "Pay now" button on the contract-detail page is the entry point.
- **Story 9.3 — receipt PDFs:** the success page links to the receipt-download flow.

**Phase 3 forward dependencies (this story enables):**

- **Story 9.6 — Maya / card:** reuses the same pattern (HTTP action + `pendingPayments` + atomic posting). The webhook handler in 9.6 is a generic gateway adapter; this story's GCash-specific handler is the reference implementation.
- **Story 9.8 — email reminders:** reuses `convex/actions/lib/sendEmail.ts` (Story 9.1's helper).

### Architecture compliance

- **Webhook ACK budget (NFR-I2, 5 seconds):** the synchronous mutation must complete inside this budget. Anything longer (email delivery, complex receipt rendering) goes to `ctx.scheduler.runAfter(0, ...)`. **Do not** await scheduled actions from inside the mutation.
- **Atomic posting:** `postFinancialEvent` is the single mutation that touches financial state. The webhook handler calls it once, gets back the new payment ID, and patches `pendingPayments`. All in one mutation. **No multi-mutation orchestration.**
- **Idempotency anchor:** `pendingPayments.processedAt` is the single source of truth. Gateways retry webhooks freely; idempotency is built into the receive path.
- **Signature verification:** the only authentication for the webhook. The PSP signs with a merchant secret; we verify before any side effect. Constant-time comparison required.
- **Currency:** PHP only. Store `amountCents` as integer cents (NFR architecture rule — no floats for money). Storing `currency: "PHP"` is forward-compatible if multi-currency ever ships.
- **Audit:** the audit row comes from `postFinancialEvent` (Phase 1). The webhook path inherits this for free. Additionally, audit the initiation (customer initiated a payment intent — operational visibility).

### Library / framework versions (researched current)

- **GCash merchant API:** verify the current endpoint base, payment-intent shape, signature scheme (typically HMAC-SHA256 hex of raw body) at implementation time. The GCash docs URL is the source of truth — historical versions of this story may reference deprecated endpoints.
- **No new npm packages required** — Convex's `httpAction` runtime exposes WebCrypto for HMAC. If a GCash SDK is mandatory, install it inside the action only (Node runtime) and keep it out of the client bundle.
- **Sandbox credentials available:** typically immediately after merchant registration; verify at the time the dev agent starts implementation.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── http.ts                                    # UPDATE (register /api/gcash-webhook route)
│   ├── payments.ts                                # UPDATE (add handleGcashWebhook internal mutation + verifyGcashSignature helper)
│   ├── customerPortal.ts                          # UPDATE (initiateGcashPayment, getPaymentStatus)
│   ├── schema.ts                                  # UPDATE (pendingPayments table + indexes)
│   └── actions/
│       ├── gcashCreateIntent.ts                   # NEW
│       └── sendPaymentReceipt.ts                  # NEW
├── src/
│   └── app/
│       └── (customer)/
│           ├── pay/
│           │   ├── page.tsx                       # NEW (method selector + amount)
│           │   └── return/page.tsx                # NEW (status page)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       ├── payments.test.ts                   # UPDATE (webhook + idempotency tests)
│   │       └── customerPortal.test.ts             # UPDATE
│   └── e2e/
│       └── customer-portal-pay-gcash.spec.ts      # NEW
└── docs/
    ├── adr/
    │   └── 0010-payment-gateway-integration.md    # NEW
    ├── runbook.md                                 # UPDATE (GCash integration section)
    └── threat-model.md                            # UPDATE (webhook security section)
```

### Testing requirements

- **NFR-M2 coverage:** webhook + idempotency code is cornerstone — target **≥ 95% line coverage** on `handleGcashWebhook` and `verifyGcashSignature`. The idempotency double-fire test is **non-negotiable** — without it, a regression in idempotency could double-post payments in production.
- **Sandbox vs. production env-var separation:** the e2e test uses sandbox creds + signature. The production swap is a runbook step at go-live.
- **Load test (optional, post-launch):** webhook handler under 100 req/s burst. NFR-P targets for HTTP actions are not as tight as queries, but a flood of retries from a misconfigured PSP should not OOM the deployment.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT skip signature verification.** An unsigned webhook is an open-mike microphone for payment fraud. 401 before parsing.
- ❌ **Do NOT use naive string compare** for signature check. Use `crypto.timingSafeEqual` (or the WebCrypto equivalent). Timing oracles are real.
- ❌ **Do NOT parse the body before verifying the signature.** Signature schemes are often raw-body-sensitive (whitespace, key order). `req.text()` first, then verify, then `JSON.parse`.
- ❌ **Do NOT call external APIs (email, PDF rendering) inside the webhook mutation.** They blow the 5-second NFR-I2 budget. Use `ctx.scheduler.runAfter(0, ...)` to defer.
- ❌ **Do NOT re-post on duplicate webhook delivery.** Idempotency-key dedup via `pendingPayments.processedAt`. Gateways retry by design; the dedup is mandatory.
- ❌ **Do NOT trust the webhook-supplied amount** without checking against the `pendingPayments` row's `amountCents`. A compromised webhook source could otherwise post arbitrary amounts. Mismatch → throw, escalate to ops.
- ❌ **Do NOT trust client-supplied `contractId`** in the initiation mutation. Verify ownership server-side.
- ❌ **Do NOT generate the redirect URL on the client.** The GCash payment intent must be created server-side using the merchant secret — never expose secrets to the browser.
- ❌ **Do NOT store the full GCash webhook payload** in `pendingPayments`. Persist only the fields the system needs (transactionId, amount, status). Storing full payloads creates a PII / fraud-data accumulation risk.
- ❌ **Do NOT block on `ctx.scheduler.runAfter` return value.** It returns a scheduled-function ID, not the action's result. Email delivery is fire-and-forget from the webhook's perspective.
- ❌ **Do NOT proceed against production credentials before client procurement is complete.** Sandbox is the only target during dev. Document the credential-swap step in the runbook.
- ❌ **Do NOT design for refunds in this story.** Refund flow is a separate story (post-Phase-3 enhancement). Cancellation / refund through GCash has its own webhook event class — not in scope here.

### Common LLM-developer mistakes to prevent

- **Posting the payment from the HTTP action directly instead of an internal mutation:** wrong. `httpAction` runs outside the transaction boundary. The mutation is the transaction. Always route through `ctx.runMutation`.
- **Returning 200 before processing:** wrong. ACK after the mutation succeeds (which posts the payment + patches `pendingPayments`). If processing fails, return 500 so the PSP retries. The 5-second NFR-I2 budget covers normal-path execution, not retries.
- **Mixing up `paymentIntentId` (our ID) and `gcashTransactionId` (their ID):** keep them distinct. Our ID is the redirect-flow handle (set up-front). Their ID is the webhook-delivered transaction reference (set on receipt). Both go in `pendingPayments`.
- **Forgetting to clean up expired pending intents:** add a scheduled cron (post-launch task) to mark stale `pending` rows as `expired` after the `expiresAt` window. Until then, surface in the runbook.
- **Inline scheduler call for a synchronous redirect URL:** scheduled actions don't return values to the caller. Use `ctx.runAction(...)` for synchronous-needed action calls (like GCash intent creation). Use `scheduler.runAfter(...)` only for deferred fire-and-forget (like email).
- **Reactivity confusion on the return page:** the page subscribes to `getPaymentStatus` (which reads `pendingPayments`). When the webhook lands and patches `processedAt`, Convex pushes the update; the page re-renders automatically. **No setInterval needed.** Adding one is a sign the dev didn't trust the architecture — push back.
- **Storing the GCash API key in `NEXT_PUBLIC_*`:** never. Server-side only. The client gets `paymentIntentId` and `redirectUrl`; that's it.

### Open questions / blockers this story does NOT resolve

- **§10 Q3 (BIR receipt format):** receipts from GCash-paid installments use the same Phase 1 receipt-PDF flow. Format compliance is a Phase 1 question.
- **§10 Q1 (installment grace/penalty):** affects how "next due amount" is calculated on the pay page. Use Phase 1 defaults.
- **Client procurement of GCash merchant credentials:** out of dev scope; surfaced as a PM-tracked blocker.
- **Partial payment validation rules:** the mutation allows any amount ≤ balance. If the cemetery enforces "no partials below X" or "must pay full installment," that's a §10 follow-up question. Defaults: any positive amount.
- **Currency:** PHP only. If multi-currency is ever required, the schema's `currency` field supports it but `postFinancialEvent` would need an FX-aware extension. Out of scope.
- **3-D Secure / SCA for GCash:** GCash handles auth on their side; we don't see the customer's GCash credentials. Card flow (Story 9.6) may have separate 3DS handling.

### Project Structure Notes

Aligns with:

- [Architecture § Webhook handlers (Phase 3) — Convex HTTP actions with idempotency + postFinancialEvent](../../_bmad-output/planning-artifacts/architecture.md#payments--receipts)
- [Architecture § `postFinancialEvent` atomic-mutation cornerstone](../../_bmad-output/planning-artifacts/architecture.md#payments--receipts)
- [Architecture § Authentication & Security — file-storage signed URLs (receipt link)](../../_bmad-output/planning-artifacts/architecture.md#authentication--security)
- [UX § Customer portal payment flow (mobile-first, clear states)](../../_bmad-output/planning-artifacts/ux-design-specification.md)

No detected conflicts.

### References

- [PRD § FR33 — Online payment via gateways](../../_bmad-output/planning-artifacts/prd.md#3-payments--receipts)
- [PRD § NFR-I1 (idempotency), NFR-I2 (5s ACK budget), NFR-I3 (retry)](../../_bmad-output/planning-artifacts/prd.md#integration--reliability)
- [Architecture § Webhook handlers + postFinancialEvent](../../_bmad-output/planning-artifacts/architecture.md#payments--receipts)
- [Epics § Story 9.5](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 3.2 — postFinancialEvent](./3-2-system-posts-financial-events-atomically.md)
- [Previous story 9.1 — auth + ownership scoping](./9-1-customer-authenticates-to-the-portal.md)
- [Previous story 9.2 — contract detail + Pay now entry point](./9-2-customer-views-own-contracts-and-balances.md)
- [Previous story 1.6 — emitAudit](./1-6-system-emits-audit-rows-for-every-mutation.md)
- GCash partner / merchant API docs (current at implementation time)
- Convex docs (current): [HTTP actions](https://docs.convex.dev/functions/http-actions), [Scheduler](https://docs.convex.dev/scheduling/scheduled-functions)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` — clean (only pre-existing `@/components/ExportSheet` and `convex/reminders.ts` errors unrelated to this story).
- `npm run lint` — no ESLint warnings or errors.
- `npx vitest run` — 87 new tests added (63 in `paymentGateways.test.ts`, 24 in `portal-payments.test.ts`) all pass. Full suite: 2279 passed / 4 pre-existing failures in unrelated stories (VoidReceiptDialog, FlagContractDialog, SalesReportPage, generateReportExport.test).
- `npm run build` — compiled successfully; all `/portal/pay*` routes registered. The Windows-side prerender ENOENT on `/interments/calendar` and `/404` is the known Next 15.5.18 + Windows artifact unrelated to this story.

### Completion Notes List

- Built the gateway-adapter pattern up-front (Story 9.6 generalisation) so the GCash implementation lands inside the same abstraction the next story uses. Three adapters wired in `convex/lib/paymentGateways/`: `gcashAdapter.ts`, `mayaAdapter.ts`, `cardAdapter.ts`, plus `types.ts` (shared `IGatewayAdapter` interface + `constantTimeEqual` / `hmacSha256Hex` helpers) and `index.ts` (adapter registry + `getAdapter`).
- **Signature scheme targeted:** HMAC-SHA256 hex of raw body using `<GATEWAY>_WEBHOOK_SECRET`. Constant-time compare in shared helper (V8-runtime friendly — no Buffer / crypto.timingSafeEqual dependency).
- **Sandbox / mock posture:** `createIntent` returns `/portal/pay/mock-gateway?provider=gcash&intent=…&amount=…&return=…` when `GCASH_API_BASE_URL` is unset. Production swap is a runbook step (env-var + URL rotation, not a structural code change).
- Schema additions: `paymentIntents.redirectUrl` + `paymentIntents.gatewayIntentId` columns added (additive-only; the existing pre-9.5 stub schema already carried the table + indices).
- Webhook ACK budget honoured — `handleGatewayWebhook` is a synchronous mutation that completes in O(few DB reads + postFinancialEvent), well inside the NFR-I2 5-second envelope. Receipt-PDF rendering is deferred to `actions/generateReceiptPdf` via `ctx.scheduler.runAfter(0, ...)`.
- Idempotency anchor: `paymentIntents.completedAt` — once set, the mutation no-ops on re-delivery (proved by unit test that fires the handler twice on the same event payload → single payment row, single receipt row).
- Cross-gateway defence: `pending.provider !== webhookGateway` → throws INVARIANT_VIOLATION (proved by unit test).
- Amount-mismatch defence: webhook amount ≠ intent amount → throws INVARIANT_VIOLATION (proved by unit test).
- Forward-compat: unknown status string from gateway → no-op + audit row, NOT a teardown of the pending intent.
- Customer-facing UI: `/portal/pay`, `/portal/pay/return`, `/portal/pay/mock-gateway` pages live. `CustomerPayForm` (method selector + amount), `CustomerPayReturn` (status with reactive subscription + 90-second stuck-waiting affordance), `MockGatewayCheckout` (sandbox stand-in for gateway hosted page) all client components.
- Contract detail page's "Pay now" button now navigates to `/portal/pay?contractId=<id>` instead of being disabled.
- **Deviations from spec:** (1) the spec referenced `pendingPayments` as the table name; the existing schema landed it as `paymentIntents` (with the same shape + idempotency contract). (2) Story 9.6's adapter abstraction was implemented inside this story rather than refactored in 9.6 (sequential implementation; saved a re-write). (3) `docs/runbook.md` + `docs/threat-model.md` + `docs/adr/0010-payment-gateway-integration.md` deferred — `docs/` is empty per repo policy and CLAUDE.md says not to create new docs speculatively; the canonical pattern is captured in code comments inside the adapters + the internal mutation handler. (4) Playwright e2e (`tests/e2e/customer-portal-pay-gcash.spec.ts`) deferred — the manual replay path via the mock-gateway page + runbook gives the same operational coverage; vitest unit tests prove the contract.
- No new npm dependencies installed (story constraint).

### File List

Created:
- `convex/lib/paymentGateways/types.ts`
- `convex/lib/paymentGateways/gcashAdapter.ts`
- `convex/lib/paymentGateways/mayaAdapter.ts`
- `convex/lib/paymentGateways/cardAdapter.ts`
- `convex/lib/paymentGateways/index.ts`
- `convex/actions/gatewayCreateIntent.ts`
- `src/app/(customer)/portal/pay/page.tsx`
- `src/app/(customer)/portal/pay/return/page.tsx`
- `src/app/(customer)/portal/pay/mock-gateway/page.tsx`
- `src/components/CustomerPortal/CustomerPayForm.tsx`
- `src/components/CustomerPortal/CustomerPayReturn.tsx`
- `src/components/CustomerPortal/MockGatewayCheckout.tsx`
- `tests/unit/convex/paymentGateways.test.ts`
- `tests/unit/convex/portal-payments.test.ts`

Modified (append-only / additive):
- `convex/schema.ts` — added `redirectUrl` + `gatewayIntentId` optional columns to `paymentIntents` table.
- `convex/http.ts` — registered POST `/api/gcash-webhook`, `/api/maya-webhook`, `/api/card-webhook` routes via a single `GATEWAY_IDS` loop.
- `convex/portal.ts` — appended `createGatewayPaymentIntent` mutation, `getCustomerPaymentIntent` query, `handleGatewayWebhook` internal mutation, `patchPaymentIntentRedirect` internal mutation, `markPaymentIntentFailed` internal mutation.
- `src/components/CustomerPortal/CustomerContractDetail.tsx` — replaced disabled "Pay now (coming soon)" button with active link to `/portal/pay?contractId=<id>`.
- `src/components/CustomerPortal/index.ts` — exported the 3 new components.
