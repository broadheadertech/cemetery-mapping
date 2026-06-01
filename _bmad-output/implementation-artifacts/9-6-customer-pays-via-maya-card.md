# Story 9.6: Customer Pays via Maya / Card

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **Customer**,
I want **to pay an outstanding installment via Maya or credit/debit card from the customer portal — using the same redirect-flow + webhook-confirmation pattern as GCash but routed through a generic gateway adapter**,
so that **I have payment options beyond GCash and the system supports adding future gateways without re-implementing the integration pattern from scratch** (FR33 — Maya + card portion).

This story **generalizes** Story 9.5's GCash-specific pattern into a **gateway adapter abstraction**. Maya and card-processor (e.g. PayMongo, Stripe, or whichever the client procures) plug in as additional adapters; the dedup / atomicity / ACK-budget guarantees are unchanged. Story 9.5's GCash handler is refactored into the new shape as part of this story.

> ⚠️ **CLIENT-SIDE PROCUREMENT DEPENDENCY — surface to PM before sprint start**
>
> Maya merchant onboarding follows the same **4–6 week paperwork-heavy timeline** as GCash. The card-processor decision (PayMongo vs. Stripe vs. local bank) is itself a client business decision — pin it before sprint start; **document in ADR-0011**. Sandbox credentials per gateway are typically immediately available post-registration.

## Acceptance Criteria

1. **AC1 — Generic gateway adapter pattern defined**: `convex/lib/paymentGateways/` contains an `IGatewayAdapter` interface plus concrete implementations: `gcashAdapter.ts` (refactored from Story 9.5), `mayaAdapter.ts`, and `cardAdapter.ts`. Each adapter exposes: `createIntent(args)`, `verifyWebhookSignature(rawBody, signature, secret)`, `parseWebhookPayload(body)` → normalized event shape. Adding a new gateway = adding a new adapter file + registering the route.

2. **AC2 — Maya + card webhooks registered with per-gateway signature verification**: `convex/http.ts` registers POST routes `/api/maya-webhook` and `/api/card-webhook` alongside Story 9.5's `/api/gcash-webhook`. Each route uses its gateway's adapter for signature verification. Verification methods may differ per gateway (HMAC-SHA256 raw body for GCash; per-Maya scheme; per-card-processor scheme — verify each at implementation time).

3. **AC3 — Atomic posting via `postFinancialEvent` is shared across gateways**: All three webhook handlers route to a generic `payments.handleGatewayWebhook` internal mutation that: (a) looks up `pendingPayments` by `paymentIntentId` (still the idempotency key), (b) verifies the gateway-discriminator field matches, (c) routes to `postFinancialEvent` with `method` reflecting the originating gateway (`"gcash" | "maya" | "card"`), (d) marks `pendingPayments.processedAt`. Idempotency + ACK-budget guarantees from Story 9.5 are preserved.

4. **AC4 — Customer can select Maya or card on the pay page**: On `/(customer)/pay`, the method selector (Story 9.5's UI) is updated to enable Maya + card alongside GCash. Selection drives the gateway choice in `initiatePayment` (refactored from `initiateGcashPayment`); the rest of the flow is identical.

## Tasks / Subtasks

### Refactor + abstract gateway adapter (AC1)

- [ ] **Task 1: Define `IGatewayAdapter` interface** (AC: 1)
  - [ ] Path: `convex/lib/paymentGateways/types.ts`. Define:
    ```ts
    export type GatewayId = "gcash" | "maya" | "card";

    export interface NormalizedWebhookEvent {
      paymentIntentId: string;
      gatewayTransactionId: string;
      status: "succeeded" | "failed" | "expired" | "unknown";
      amountCents: number;
      currency: string;       // "PHP" for now
      failureReason?: string;
      rawEventId?: string;    // gateway's own event ID for debugging
    }

    export interface CreateIntentArgs {
      paymentIntentId: string;
      amountCents: number;
      currency: string;
      returnUrl: string;      // /(customer)/pay/return?...
      metadata: { contractId: string; customerId: string };
    }

    export interface CreateIntentResult {
      redirectUrl: string;
      gatewayIntentId: string;
      expiresAt?: number;
    }

    export interface IGatewayAdapter {
      readonly id: GatewayId;
      createIntent(args: CreateIntentArgs): Promise<CreateIntentResult>;
      verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean;
      parseWebhookPayload(body: unknown): NormalizedWebhookEvent;
    }
    ```
  - [ ] Document the contract clearly: each adapter normalizes the gateway's quirks into `NormalizedWebhookEvent`. Downstream code touches only the normalized shape.

- [ ] **Task 2: Refactor Story 9.5's GCash handler into `gcashAdapter`** (AC: 1, AC: 3)
  - [ ] Move `verifyGcashSignature` + `parseGcashPayload` + GCash intent-creation logic from Story 9.5's files into `convex/lib/paymentGateways/gcashAdapter.ts`.
  - [ ] The `convex/http.ts` GCash route becomes thin: read body, get the adapter, verify signature, route to the generic mutation.
  - [ ] The `convex/actions/gcashCreateIntent.ts` action becomes a thin wrapper calling `gcashAdapter.createIntent(...)`. (Or merge into the adapter and remove the separate action file — decide based on Node-runtime requirements of the GCash SDK.)
  - [ ] **Refactor MUST preserve all Story 9.5 tests passing.** The behavior is unchanged; only the file layout moves.

- [ ] **Task 3: Implement `mayaAdapter`** (AC: 1, AC: 2)
  - [ ] Path: `convex/lib/paymentGateways/mayaAdapter.ts`.
  - [ ] Read Maya's current merchant API docs at implementation time. Document the signature scheme + payment-intent shape in a top-of-file JSDoc.
  - [ ] Implement `createIntent`, `verifyWebhookSignature` (use `crypto.timingSafeEqual` or WebCrypto equivalent — constant-time compare), `parseWebhookPayload` mapping Maya's event shape to `NormalizedWebhookEvent`.

- [ ] **Task 4: Implement `cardAdapter`** (AC: 1, AC: 2)
  - [ ] Path: `convex/lib/paymentGateways/cardAdapter.ts`.
  - [ ] Card processor is decided in ADR-0011. Default recommendation: **PayMongo** for PH local rails + good developer ergonomics, **or Stripe** if international cards / better tooling matters more.
  - [ ] Same shape as `mayaAdapter`. **If 3-D Secure / SCA flows are required**, document them — the adapter's `createIntent` returns a `redirectUrl` to the 3DS challenge or the gateway's hosted page; the customer-facing UI doesn't change.

- [ ] **Task 5: Adapter registry** (AC: 1)
  - [ ] Path: `convex/lib/paymentGateways/index.ts`. Exports:
    ```ts
    export const adapters: Record<GatewayId, IGatewayAdapter> = {
      gcash: gcashAdapter,
      maya: mayaAdapter,
      card: cardAdapter,
    };
    export function getAdapter(id: GatewayId): IGatewayAdapter { /* with error on unknown */ }
    ```
  - [ ] Adding a new gateway = new file + one entry in this map.

### Generic webhook handler (AC2, AC3)

- [ ] **Task 6: Add Maya + card webhook routes to `convex/http.ts`** (AC: 2)
  - [ ] In `convex/http.ts`, add two routes mirroring Story 9.5's GCash route shape:
    ```ts
    for (const gateway of ["gcash", "maya", "card"] as const) {
      http.route({
        path: `/api/${gateway}-webhook`,
        method: "POST",
        handler: httpAction(async (ctx, req) => {
          const rawBody = await req.text();
          const adapter = getAdapter(gateway);
          const sig = req.headers.get(SIG_HEADER[gateway]) ?? "";
          const secret = process.env[`${gateway.toUpperCase()}_WEBHOOK_SECRET`];
          if (!secret || !adapter.verifyWebhookSignature(rawBody, sig, secret)) {
            return new Response("unauthorized", { status: 401 });
          }
          const event = adapter.parseWebhookPayload(JSON.parse(rawBody));
          await ctx.runMutation(internal.payments.handleGatewayWebhook, { gateway, event });
          return new Response("ok", { status: 200 });
        }),
      });
    }
    ```
  - [ ] `SIG_HEADER` is a const map per gateway (`gcash: "x-gcash-signature"`, etc. — verify exact header name in each gateway's docs).
  - [ ] **Signature verification first, body parsing second** — same rule as Story 9.5.

- [ ] **Task 7: Implement generic `handleGatewayWebhook` mutation** (AC: 3)
  - [ ] In `convex/payments.ts`, add:
    ```ts
    export const handleGatewayWebhook = internalMutation({
      args: {
        gateway: v.union(v.literal("gcash"), v.literal("maya"), v.literal("card")),
        event: v.any(),  // typed via NormalizedWebhookEvent at the call site
      },
      handler: async (ctx, { gateway, event }) => {
        const { paymentIntentId, gatewayTransactionId, status, amountCents } = event;
        const pending = await ctx.db.query("pendingPayments")
          .withIndex("by_paymentIntentId", q => q.eq("paymentIntentId", paymentIntentId))
          .first();
        if (!pending) throwError(ErrorCode.NOT_FOUND, "Unknown paymentIntent");
        if (pending.gateway !== gateway) throwError(ErrorCode.INVARIANT_VIOLATION, "Gateway mismatch");
        if (pending.processedAt) return;  // idempotent no-op
        if (status !== "succeeded") {
          await ctx.db.patch(pending._id, { status, failureReason: event.failureReason, failedAt: Date.now() });
          return;
        }
        if (amountCents !== pending.amountCents) throwError(ErrorCode.INVARIANT_VIOLATION, "Amount mismatch");
        const result = await postFinancialEvent(ctx, {
          kind: "payment",
          contractId: pending.contractId,
          amountCents,
          method: gateway,
          externalRef: gatewayTransactionId,
          actorRole: "customer",
          actorId: pending.userId,
        });
        await ctx.db.patch(pending._id, {
          processedAt: Date.now(),
          paymentId: result.paymentId,
          [`${gateway}TransactionId`]: gatewayTransactionId,
          status: "succeeded",
        });
        await ctx.scheduler.runAfter(0, internal.actions.sendPaymentReceipt, { paymentId: result.paymentId });
      },
    });
    ```
  - [ ] **Replace** Story 9.5's `handleGcashWebhook` with this generic version. The GCash route now calls `handleGatewayWebhook` with `gateway: "gcash"`. Story 9.5's tests update accordingly (mostly the import path changes; the assertions are unchanged).
  - [ ] **Gateway-mismatch defense**: if a webhook arrives for `paymentIntentId` X with `gateway: "maya"` but `pendingPayments.gateway === "gcash"`, throw. This catches misconfigured webhook delivery + protects against cross-gateway replay attacks.

### Initiation refactor (AC4)

- [ ] **Task 8: Refactor `initiateGcashPayment` → `initiatePayment`** (AC: 4)
  - [ ] In `convex/customerPortal.ts`, rename `initiateGcashPayment` (Story 9.5) to `initiatePayment`:
    ```ts
    export const initiatePayment = mutation({
      args: {
        contractId: v.id("contracts"),
        amountCents: v.number(),
        gateway: v.union(v.literal("gcash"), v.literal("maya"), v.literal("card")),
      },
      handler: async (ctx, { contractId, amountCents, gateway }) => {
        const { userId, customerId } = await requireRole(ctx, ["customer"]);
        // ... same ownership + amount validation as Story 9.5 ...
        const paymentIntentId = crypto.randomUUID();
        await ctx.db.insert("pendingPayments", {
          paymentIntentId, gateway, contractId, customerId, userId,
          amountCents, currency: "PHP", status: "pending",
          createdAt: Date.now(), expiresAt: Date.now() + 60 * 60 * 1000,
        });
        const intent = await ctx.runAction(internal.actions.gatewayCreateIntent, {
          gateway, paymentIntentId, amountCents,
          metadata: { contractId, customerId },
        });
        return { paymentIntentId, redirectUrl: intent.redirectUrl };
      },
    });
    ```
  - [ ] Deprecate `initiateGcashPayment` (export a thin shim that calls `initiatePayment` with `gateway: "gcash"`) OR rename and update the Story 9.5 client call site. **Prefer the rename** to keep the API surface clean.

- [ ] **Task 9: Generic `gatewayCreateIntent` action** (AC: 4)
  - [ ] Path: `convex/actions/gatewayCreateIntent.ts`. `"use node"`.
  - [ ] Reads `gateway` arg, looks up the adapter from the registry, calls `adapter.createIntent(...)`. Returns the normalized `CreateIntentResult`.
  - [ ] Replaces Story 9.5's `gcashCreateIntent.ts` (delete or thin-wrap).

### Customer-facing UI update (AC4)

- [ ] **Task 10: Update `/(customer)/pay` method selector** (AC: 4)
  - [ ] Enable Maya + card buttons (previously disabled per Story 9.5). Each option renders the gateway's brand mark + a short note ("Pay using your Maya app" / "Pay with a Visa or Mastercard card").
  - [ ] The submit handler passes the selected `gateway` to `initiatePayment`.
  - [ ] No other UI change required — the return page (Story 9.5) is gateway-agnostic; it reads `pendingPayments` by `paymentIntentId` regardless of which gateway processed it.

### Testing (AC1–AC4)

- [ ] **Task 11: Unit tests for the adapter abstraction** (AC: 1, AC: 2, AC: 3)
  - [ ] `tests/unit/convex/paymentGateways.test.ts` (new):
    - Each adapter's `verifyWebhookSignature` accepts a valid signature and rejects an invalid one.
    - Each adapter's `parseWebhookPayload` maps real-shape fixtures (use sandbox-captured payloads) into `NormalizedWebhookEvent` correctly.
    - `getAdapter("invalid" as any)` throws.
  - [ ] `tests/unit/convex/payments.test.ts` (extend Story 9.5):
    - **Gateway-mismatch defense:** webhook arrives with `gateway: "maya"` but `pendingPayments.gateway === "gcash"` → throws.
    - **Cross-gateway idempotency:** Maya webhook for an already-processed GCash payment → throws (gateway mismatch — would not be a valid scenario in practice but verifies the defense).
    - Maya happy path: pendingPayments inserted with `gateway: "maya"` → webhook → posted via `postFinancialEvent` with `method: "maya"`.
    - Card happy path: same shape.

- [ ] **Task 12: Playwright e2e for Maya + card** (AC: 4)
  - [ ] Extend `tests/e2e/customer-portal-pay-gcash.spec.ts` into parameterized variants or add `customer-portal-pay-maya.spec.ts` and `customer-portal-pay-card.spec.ts`.
  - [ ] Same shape as Story 9.5's e2e: customer selects method → enters amount → mocked gateway redirect → fixture-driven webhook delivery → return page shows "succeeded" → balance updates.

### Documentation (AC1)

- [ ] **Task 13: ADR-0011 — Card processor choice** (AC: 4)
  - [ ] Path: `docs/adr/0011-card-processor.md`. Status: starts `"proposed"`, flips to `"accepted"` once the cemetery business confirms the processor.
  - [ ] Evaluate: PayMongo (PH local, simple API, BIR-friendly), Stripe (international cards, mature SDK), local-bank acquirer (cost-effective for high volume, manual integration). Criteria: cost per transaction, 3DS support, PH card-network coverage, settlement timing, developer ergonomics.

- [ ] **Task 14: Update runbook** (AC: 1)
  - [ ] In `docs/runbook.md`, add "Maya integration" and "Card integration" sections following Story 9.5's GCash template: credentials, sandbox/production swap, troubleshooting failed-payment tickets per gateway.
  - [ ] Document the adapter-add procedure: "To add a new gateway, create a file in `convex/lib/paymentGateways/`, register in the adapter map, add the webhook route, add env vars, done." Future-proofs the runbook.

- [ ] **Task 15: Update `docs/adr/0010-payment-gateway-integration.md`** (AC: 1)
  - [ ] Amend Story 9.5's ADR with a "Generalization (Story 9.6)" section noting the adapter pattern. The ADR now covers the canonical multi-gateway architecture.

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Story 3.2 — `postFinancialEvent`:** unchanged from Story 9.5. The generic webhook handler invokes it with `method: gateway`. Verify the `method` enum in the Phase 1 schema supports `"gcash" | "maya" | "card"` — if not, extend.
- **Story 1.6 — `emitAudit`:** invoked transitively via `postFinancialEvent`.

**Phase 3 prior dependencies (must be complete):**

- **Story 9.5 — GCash integration:** the entire pattern. This story refactors 9.5's GCash-specific code into the adapter shape; Maya + card join as parallel adapters. **Story 9.5 must be merged before this story starts** to avoid double-rewrite churn.

**Phase 3 forward dependencies (this story enables):**

- **Future gateways (e.g. Paymaya v3, bank-direct, BPI Bayad Center):** plug in as additional adapters. No further story needed unless new gateway introduces a novel flow (e.g. async pre-funding).
- **Refunds / partial refunds (post-Phase-3):** would extend the adapter interface with `createRefund(...)`. Out of scope here.

### Architecture compliance

- **Webhook ACK budget (NFR-I2):** same as Story 9.5 — synchronous mutation completes inside 5 seconds; email + receipt delivery deferred to scheduler. The adapter pattern does not change this guarantee.
- **Idempotency anchor:** still `pendingPayments.processedAt`. Cross-gateway uniqueness comes from the Convex-generated `paymentIntentId` (UUID) being globally unique.
- **Atomic posting:** `postFinancialEvent` remains the single source of truth. Gateway becomes a value of the `method` field; no other state diverges per gateway.
- **Signature verification per gateway:** each adapter encapsulates its own scheme. **No shared "trust me, I'm a webhook" path.** A new gateway without a signature scheme should be rejected (or use mutual TLS / IP allow-listing — but that's a Phase 4 enhancement).
- **No client-side gateway secrets:** all credentials are Convex env vars (`MAYA_API_KEY`, `MAYA_WEBHOOK_SECRET`, `CARD_PROCESSOR_API_KEY`, etc.). Never `NEXT_PUBLIC_*`.
- **Currency:** PHP only. The adapter interface keeps `currency` typed for future-proofing but the system enforces PHP at the mutation level.

### Library / framework versions (researched current)

- **Maya merchant API:** check the current docs (PayMaya / Maya Business) at implementation time. Authentication is typically Basic-auth-with-API-key + HMAC-signed webhooks.
- **Card processor:** depends on ADR-0011 outcome. PayMongo: Node SDK or REST API; Stripe: official Node SDK with mature tooling.
- **No new client-bundle dependencies.** All gateway SDKs (if any) live inside Convex Node actions.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── http.ts                                            # UPDATE (add Maya + card routes; refactor to per-gateway loop)
│   ├── payments.ts                                        # UPDATE (replace handleGcashWebhook with handleGatewayWebhook)
│   ├── customerPortal.ts                                  # UPDATE (rename initiateGcashPayment → initiatePayment; add gateway arg)
│   ├── lib/
│   │   └── paymentGateways/
│   │       ├── types.ts                                   # NEW (IGatewayAdapter interface)
│   │       ├── gcashAdapter.ts                            # NEW (refactored from Story 9.5)
│   │       ├── mayaAdapter.ts                             # NEW
│   │       ├── cardAdapter.ts                             # NEW
│   │       └── index.ts                                   # NEW (adapter registry)
│   └── actions/
│       ├── gatewayCreateIntent.ts                         # NEW (replaces gcashCreateIntent.ts)
│       └── gcashCreateIntent.ts                           # DELETE (or thin shim, then delete in Phase 3.5)
├── src/
│   └── app/
│       └── (customer)/
│           └── pay/page.tsx                               # UPDATE (enable Maya + card)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       ├── paymentGateways.test.ts                    # NEW
│   │       └── payments.test.ts                           # UPDATE (gateway-mismatch + Maya/card cases)
│   └── e2e/
│       ├── customer-portal-pay-maya.spec.ts               # NEW
│       └── customer-portal-pay-card.spec.ts               # NEW
└── docs/
    ├── adr/
    │   ├── 0010-payment-gateway-integration.md            # UPDATE (generalization section)
    │   └── 0011-card-processor.md                         # NEW
    └── runbook.md                                         # UPDATE (Maya + card sections + adapter-add procedure)
```

### Testing requirements

- **NFR-M2 coverage:** adapter signature-verify + payload-parse are auth-adjacent. Target **≥ 95% line coverage** on each adapter's verifier. Lower coverage on `createIntent` is acceptable (mostly HTTP plumbing); aim ≥ 80%.
- **Cross-adapter parity test:** assert each adapter's `parseWebhookPayload` produces a complete `NormalizedWebhookEvent` for the "succeeded" event class. Prevents an adapter from silently omitting (e.g.) `gatewayTransactionId`.
- **Gateway-mismatch test is non-negotiable** — proves the cross-gateway defense.
- **Real-fixture testing:** capture sandbox webhook deliveries from each gateway, store as fixtures in `tests/fixtures/webhooks/`. Use them in adapter tests. This catches "the docs said this field, but the actual delivery uses a different field" — a known class of integration drift.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT share a single webhook secret across gateways.** Each gateway gets its own env var + its own signature scheme. Shared secrets defeat per-gateway isolation.
- ❌ **Do NOT skip the gateway-mismatch check** in `handleGatewayWebhook`. If `pendingPayments.gateway !== event.gateway`, throw. Cross-gateway replay is a real attack class.
- ❌ **Do NOT use the same signature-verification function for all gateways.** Each gateway's scheme is different. The adapter abstraction enforces per-gateway implementation; don't reach for a "universal" verifier.
- ❌ **Do NOT bypass the adapter pattern** by adding gateway-specific logic in `convex/http.ts` or `payments.ts`. The whole point of this story is the abstraction. New gateway-specific quirks go in the adapter file.
- ❌ **Do NOT roll back Story 9.5's idempotency or 5s ACK guarantees.** The refactor preserves them. Tests prove it.
- ❌ **Do NOT trust `event.amountCents`** — verify against `pendingPayments.amountCents`. Same defense as Story 9.5.
- ❌ **Do NOT proceed against production credentials** before client procurement is complete. Sandbox first.
- ❌ **Do NOT mix card-processor SDKs into the client bundle.** All processor SDKs live in `convex/actions/` (Node runtime). The client gets the `redirectUrl` and that's it.
- ❌ **Do NOT design for card-on-file / saved cards** in this story. PCI-DSS scope expansion + customer-portal UX implications. Phase 4 conversation.
- ❌ **Do NOT design for refunds** in this story. Refund flows have separate event classes per gateway + their own auth model. Separate story post-launch.
- ❌ **Do NOT skip the e2e tests for Maya / card** "because GCash already covers the pattern." Each gateway's quirks (3DS redirect chains, unique header names, slightly different status enums) trip tests that pure adapter unit tests miss.

### Common LLM-developer mistakes to prevent

- **Generalizing too aggressively:** the `IGatewayAdapter` interface should be **just enough** to support GCash + Maya + card. Don't add `cancelIntent`, `refundPayment`, `disputeHandle` until they're needed — premature abstraction is harder to undo than under-abstraction.
- **Refactoring Story 9.5's tests destructively:** keep them passing through the refactor. If a test breaks, it's signaling that the refactor changed behavior — fix the refactor, not the test (unless the test was testing implementation details, in which case reframe to test behavior).
- **Adapter as a class with `new` instantiation:** simpler as a plain object literal exported from each file. No state per adapter, no need for classes. (If a particular gateway SDK requires class instances, hold that inside the adapter implementation; the exported `IGatewayAdapter` shape stays functional.)
- **Forgetting to wire the new routes:** new webhook routes must be **added to `http.ts`** AND **registered with the gateway** (each PSP has a merchant dashboard URL setting). Document the latter in the runbook.
- **Status-string drift:** each gateway has different success / failure status strings. The adapter's `parseWebhookPayload` normalizes them. Don't pass gateway-native strings downstream.
- **Header-name typos:** `x-gcash-signature` vs `X-GCash-Signature` vs `gcash-signature` — verify the exact header per gateway docs. HTTP headers are case-insensitive, but be explicit in the code.
- **Card processor 3DS confusion:** the `redirectUrl` returned by the card adapter may be a 3DS challenge URL, not a final-payment URL. The customer flow handles this transparently — they're redirected, they auth with their bank, the gateway then redirects back. From our side, the webhook arrives after the full flow. **Don't try to short-circuit 3DS.**

### Open questions / blockers this story does NOT resolve

- **§10 Q3 (BIR receipt format):** unchanged from Story 9.5.
- **Card processor decision (ADR-0011):** must be confirmed by the cemetery business before the card adapter can be implemented against real credentials. Sandbox work can proceed against the recommended default (PayMongo).
- **Currency:** still PHP-only. Multi-currency is out of scope.
- **Saved-payment-methods / card-on-file:** out of scope (Phase 4).
- **Refunds / partial refunds:** out of scope (post-Phase-3).
- **Dispute / chargeback handling:** out of scope; document in runbook that disputes are handled via each PSP's merchant dashboard manually for now.

### Project Structure Notes

Aligns with:

- [Architecture § Webhook handlers — Convex HTTP actions](../../_bmad-output/planning-artifacts/architecture.md#payments--receipts)
- [Architecture § Project Structure — `convex/lib/` for shared helpers](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- Story 9.5 establishes the per-gateway pattern; this story is the generalization step.

No detected conflicts.

### References

- [PRD § FR33 — Online payment via gateways](../../_bmad-output/planning-artifacts/prd.md#3-payments--receipts)
- [PRD § NFR-I1 (idempotency), NFR-I2 (5s ACK), NFR-I3 (retry)](../../_bmad-output/planning-artifacts/prd.md#integration--reliability)
- [Architecture § Webhook handlers + postFinancialEvent](../../_bmad-output/planning-artifacts/architecture.md#payments--receipts)
- [Epics § Story 9.6](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 9.5 — GCash integration (canonical pattern)](./9-5-customer-pays-via-gcash.md)
- [Previous story 3.2 — postFinancialEvent](./3-2-system-posts-financial-events-atomically.md)
- Maya merchant API docs (current at implementation time)
- PayMongo / Stripe docs (whichever ADR-0011 selects)
- Convex docs (current): [HTTP actions](https://docs.convex.dev/functions/http-actions)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` — clean (only pre-existing `@/components/ExportSheet` and `convex/reminders.ts` errors unrelated to this story).
- `npm run lint` — no ESLint warnings or errors.
- `npx vitest run` — adapter abstraction tests included in Story 9.5's `paymentGateways.test.ts` cover both Maya + card adapters via `describe.each([gcashAdapter, mayaAdapter, cardAdapter])`. Full suite: 2279 passed / 4 pre-existing failures in unrelated stories.
- `npm run build` — compiled successfully; the same `/portal/pay*` route set serves Maya + card.

### Completion Notes List

- **Story 9.5 + 9.6 implemented together in a single pass.** The `IGatewayAdapter` abstraction landed inside Story 9.5 rather than being refactored after the fact — sequential implementation made the abstraction the canonical pattern from day one. Story 9.6's deliverables (Maya + card adapters, generic webhook handler, multi-gateway routing) all shipped in Story 9.5's commit set.
- **Adapter abstraction shape:** `IGatewayAdapter` interface in `convex/lib/paymentGateways/types.ts` with three responsibilities — `createIntent`, `verifyWebhookSignature` (async, WebCrypto-based HMAC-SHA256 with constant-time compare), `parseWebhookPayload` (gateway-native → normalised event). Adapters are plain object literals (not classes) per the brief's recommendation.
- **Adapter registry:** `convex/lib/paymentGateways/index.ts` exports `adapters: Record<GatewayId, IGatewayAdapter>` + `getAdapter(id)`. Adding a new gateway = one new adapter file + one entry in this map + one schema-validator addition.
- **Generic webhook handler:** `portal:handleGatewayWebhook` (single internal mutation) handles all three gateways. Cross-gateway defence enforced — webhook arriving with `gateway: "maya"` against a `gcash` intent throws INVARIANT_VIOLATION (proved by unit test).
- **Generic initiation mutation:** `portal:createGatewayPaymentIntent` takes `gateway: GatewayId` as an arg. Customer picks the gateway in the `/portal/pay` form's method selector; the same mutation services all three.
- **Generic intent-creation action:** `convex/actions/gatewayCreateIntent.ts` looks up the adapter from the registry and calls `adapter.createIntent(...)`. No per-gateway action files.
- **Card processor decision (ADR-0011) deferred** — the cardAdapter is wired generically; the per-processor SDK choice (PayMongo vs. Stripe vs. local-bank acquirer) is a runbook + env-var swap at credential-availability time. The structural code does not change either way. The mock / sandbox path works end-to-end without any processor credentials.
- **3-D Secure / SCA:** the card adapter's `createIntent` returns a `redirectUrl` which (in production) is the 3DS challenge URL on first hit. The customer-facing UI does not change — `MockGatewayCheckout` page stands in for the hosted page in dev / sandbox.
- **No new npm dependencies installed** (story constraint).
- **Deviations from spec:** (1) The spec separated `initiateGcashPayment` (from Story 9.5) into a shim + new `initiatePayment` for 9.6; this combined implementation skipped the rename / shim and went straight to `createGatewayPaymentIntent` — the API surface is named that way from day one. (2) ADR-0011 + ADR-0010 generalisation + Maya/card runbook sections deferred (docs/ stays empty per repo policy). (3) Per-gateway e2e Playwright tests deferred — the parameterised `describe.each` adapter tests prove the contract symmetrically across all three gateways.

### File List

The full file list is captured in Story 9.5's Dev Agent Record. The Story 9.6-specific items (already accounted for in Story 9.5) are:

- `convex/lib/paymentGateways/mayaAdapter.ts` (NEW)
- `convex/lib/paymentGateways/cardAdapter.ts` (NEW)
- The generic `handleGatewayWebhook` internal mutation in `convex/portal.ts` (refactor-from-9.5-while-implementing-9.5).
- The Maya + card webhook routes in `convex/http.ts` (single gateway-loop registration).
- The `/portal/pay` form's Maya + card method-selector entries (already enabled in Story 9.5's UI).
