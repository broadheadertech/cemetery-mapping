# Story 9.7: System Sends SMS Payment Reminders

Status: deferred-to-phase-2

> **Deferred 2026-05-22.** The cemetery client has elected not to ship SMS reminders in Phase 1. The previously shipped Twilio integration has been removed: `convex/actions/sendSmsReminder.ts` + `convex/lib/phPhone.ts` deleted; the SMS branch removed from `convex/reminders.ts`; SMS-specific tests `.skip`'d with Phase-2 markers. Email reminders (Story 9.8) remain in service.
>
> The reminders engine (cron scan, dedup, retry, opt-out, bounce handling) is preserved. Rules with `channel: "sms"` are silently skipped by the scan; rules with `channel: "both"` downgrade to email-only. The `reminderConfig.rules[].channel` union still accepts `"sms"` so the schema is forward-compatible for Phase 2 reinstatement.
>
> When this story is re-opened: re-introduce the SMS dispatch action (choose Semaphore, Movider, or another PH-local provider rather than Twilio for cost + deliverability), re-add the PH phone E.164 helper, restore the SMS scan branch in `convex/reminders.ts`, un-skip the SMS test blocks in `tests/unit/convex/reminders.test.ts`, and update this story's status back to `ready-for-dev` (or `review` if the prior implementation is largely re-usable).

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin (configuring) and Customer (receiving)**,
I want **the system to send automated SMS payment reminders to customers based on configurable cadence rules — with retry on provider failure (3 attempts over 24h per NFR-I3), per-customer opt-out, and a daily scheduled scan**,
so that **customers stay current on installments without manual nag from office staff** (FR57 — SMS portion).

This is the **first scheduled (cron) workflow** in the system. It establishes the Phase 3 reminder-engine pattern that Story 9.8 (email reminders) extends. SMS provider is **Twilio** by default (or PH-local provider if Twilio rates / deliverability prove inadequate at pilot scale). Reminder cadence is configurable from `/admin/settings/reminders` and applies per contract per due-date.

## Acceptance Criteria

1. **AC1 — Daily scheduled scan emits SMS reminders per configured cadence**: A Convex cron registered in `convex/crons.ts` runs daily at 09:00 Manila time. It loads the active `reminderConfig` row + scans `installments` for matching conditions (e.g. "3 days before due," "on due day," "7 days after due if unpaid"). For each match it calls `internal.actions.sendSmsReminder` (Node action) to dispatch the SMS.

2. **AC2 — Retry policy honors NFR-I3 (3 attempts over 24h)**: When the SMS provider returns a transient error (5xx, network timeout), the action records the failure and re-schedules itself with backoff (e.g. immediate retry → 4h → 24h). After 3 failed attempts an `Admin alert` is emitted (visible on the Admin dashboard via the Phase 1 `recent_errors` query). Permanent failures (invalid number, opt-out) are not retried.

3. **AC3 — Per-customer opt-out is respected**: A `customers.reminderOptOut` boolean (default `false`) causes the scan to skip that customer. The customer can toggle it from `/(customer)/profile` (extending Story 9.4's profile page). The opt-out is also set automatically when an SMS provider reports a `STOP` reply (Twilio handles this carrier-side; we mirror in our schema for reporting).

4. **AC4 — Admin configures cadence in `/admin/settings/reminders`**: An Admin can edit the reminder rules — list of `{ daysOffset, requiresUnpaid, channel: "sms"|"email"|"both", templateKey }` triples — and save. The config is stored in a single `reminderConfig` document; saving emits an audit row. Schema supports both SMS (this story) and email (Story 9.8) cadence rules.

## Tasks / Subtasks

### Schema + config (AC1, AC3, AC4)

- [ ] **Task 1: Add `reminderConfig` and `reminderDeliveries` tables** (AC: 1, AC: 2, AC: 4)
  - [ ] In `convex/schema.ts`:
    ```ts
    reminderConfig: defineTable({
      rules: v.array(v.object({
        daysOffset: v.number(),           // negative = before due, 0 = on due, positive = after due
        requiresUnpaid: v.boolean(),      // only fire if installment.status !== "paid"
        channel: v.union(v.literal("sms"), v.literal("email"), v.literal("both")),
        templateKey: v.string(),          // looked up from `reminderTemplates` map
      })),
      timezone: v.string(),               // "Asia/Manila"
      sendHour: v.number(),               // 9 (i.e. 09:00 local)
      updatedAt: v.number(),
      updatedBy: v.id("users"),
    }),

    reminderDeliveries: defineTable({
      customerId: v.id("customers"),
      contractId: v.id("contracts"),
      installmentId: v.id("installments"),
      channel: v.union(v.literal("sms"), v.literal("email")),
      templateKey: v.string(),
      ruleOffset: v.number(),             // which rule fired this (for dedup)
      attempt: v.number(),                // 1, 2, 3
      status: v.union(
        v.literal("queued"),
        v.literal("sending"),
        v.literal("sent"),
        v.literal("failed"),
        v.literal("permanent_failure"),
      ),
      providerMessageId: v.optional(v.string()),
      providerError: v.optional(v.string()),
      scheduledAt: v.number(),
      sentAt: v.optional(v.number()),
      failedAt: v.optional(v.number()),
    })
      .index("by_installment_rule", ["installmentId", "ruleOffset", "channel"])  // dedup
      .index("by_customer", ["customerId"])
      .index("by_status_scheduledAt", ["status", "scheduledAt"]),
    ```
  - [ ] Also add `reminderOptOut: v.optional(v.boolean())` to the `customers` table (default treat as `false`).
  - [ ] Dedup index `by_installment_rule` ensures the same rule for the same installment cannot fire twice (even on cron re-run / restart).

- [ ] **Task 2: Seed initial `reminderConfig`** (AC: 1)
  - [ ] In `convex/seed.ts` (Phase 1's seed file), add a one-time mutation that inserts a sane default config: rules = [`{ -3, true, "sms", "upcoming_due_3d" }`, `{ 0, true, "sms", "due_today" }`, `{ 7, true, "sms", "overdue_7d" }`], timezone "Asia/Manila", sendHour 9. Document the seed step in the runbook.

### Cron + scan (AC1)

- [ ] **Task 3: Register the cron** (AC: 1)
  - [ ] Path: `convex/crons.ts` (Phase 1 may already exist; if not, create per Convex docs).
  - [ ] Add:
    ```ts
    crons.daily("send-reminders", { hourUTC: 1, minuteUTC: 0 }, internal.reminders.runDailyScan);
    // 09:00 Manila = 01:00 UTC. Verify the offset at deploy time (PH does not observe DST).
    ```
  - [ ] Document the UTC↔Manila offset in a comment + in the runbook.

- [ ] **Task 4: Implement `runDailyScan` internal mutation** (AC: 1, AC: 3)
  - [ ] Path: `convex/reminders.ts`. Internal mutation (no role check — cron-invoked).
  - [ ] Logic:
    ```ts
    export const runDailyScan = internalMutation({
      handler: async (ctx) => {
        const cfg = await ctx.db.query("reminderConfig").first();
        if (!cfg) return;  // not yet configured
        const today = nowInManila();
        for (const rule of cfg.rules) {
          // Find installments whose dueDate is `today + daysOffset` (or `today - |daysOffset|`)
          const targetDate = addDays(today, rule.daysOffset);
          const installments = await ctx.db.query("installments")
            .withIndex("by_dueDate", q => q.eq("dueDate", toEpochManila(targetDate)))
            .collect();
          for (const inst of installments) {
            if (rule.requiresUnpaid && inst.status === "paid") continue;
            const contract = await ctx.db.get(inst.contractId);
            if (!contract) continue;
            const customer = await ctx.db.get(contract.customerId);
            if (!customer || customer.reminderOptOut) continue;
            // Dedup check
            const existing = await ctx.db.query("reminderDeliveries")
              .withIndex("by_installment_rule", q => q.eq("installmentId", inst._id).eq("ruleOffset", rule.daysOffset).eq("channel", rule.channel))
              .first();
            if (existing) continue;  // already scheduled / sent
            // Schedule for SMS (this story) — email is Story 9.8
            if (rule.channel === "sms" || rule.channel === "both") {
              const id = await ctx.db.insert("reminderDeliveries", {
                customerId: customer._id, contractId: contract._id, installmentId: inst._id,
                channel: "sms", templateKey: rule.templateKey, ruleOffset: rule.daysOffset,
                attempt: 1, status: "queued", scheduledAt: Date.now(),
              });
              await ctx.scheduler.runAfter(0, internal.actions.sendSmsReminder, { deliveryId: id });
            }
          }
        }
      },
    });
    ```
  - [ ] **Dedup before scheduling**, not after. Prevents two scheduled actions from firing if the cron retries.
  - [ ] **Idempotent by design**: re-running `runDailyScan` on the same day with no new installments is a no-op.
  - [ ] **Performance:** with 2000 lots × ~36 installments each = ~72,000 installments total. The `by_dueDate` index keeps the daily scan to a small N (only that day's matching installments — typically dozens). Verify the index exists on `installments`.

### SMS provider integration (AC2)

- [ ] **Task 5: Implement `sendSmsReminder` action** (AC: 1, AC: 2)
  - [ ] Path: `convex/actions/sendSmsReminder.ts`. `"use node"`.
  - [ ] Reads the `reminderDeliveries` row + customer + contract + installment. Renders the SMS body from the template (use a simple Mustache-style replacement or a Map of `templateKey` → function).
  - [ ] Calls the SMS provider (Twilio):
    ```ts
    const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: customer.phone,
      body: rendered,
    });
    // On success: patch delivery → status: "sent", providerMessageId: msg.sid, sentAt: Date.now().
    // On 4xx (invalid number, opt-out): permanent_failure. Optionally flag the customer record.
    // On 5xx / network: failed; re-schedule per backoff (Task 6).
    ```
  - [ ] **Sender ID**: Twilio PH typically uses an Alphanumeric Sender ID (8–11 chars) for transactional. Configure `TWILIO_FROM_NUMBER` or `TWILIO_SENDER_ID` per the chosen account setup.
  - [ ] **PH compliance:** NTC may require sender registration for high-volume transactional SMS. Document in runbook; pilot can run unregistered initially.
  - [ ] **Cost note:** ~$0.04–0.08 per PH SMS via Twilio. Doc the projected monthly burn in the ADR-0009 cost section (per Story 9.1's note).

- [ ] **Task 6: Retry / backoff logic (NFR-I3)** (AC: 2)
  - [ ] If `sendSmsReminder` action sees a transient failure:
    - Patch `reminderDeliveries`: increment `attempt`, append to `providerError`, set status back to `queued`.
    - Compute backoff: `attempt 1 fail → schedule 4h later; attempt 2 fail → schedule 24h later from initial; attempt 3 fail → permanent_failure + admin alert`.
    - `ctx.scheduler.runAfter(backoffMs, internal.actions.sendSmsReminder, { deliveryId })`.
  - [ ] **Permanent failures (invalid number, opt-out)**: status `permanent_failure`; no retry. Optionally set `customers.reminderOptOut = true` on STOP-reply patterns (Twilio webhook from Story 9.8's bounce handler — defer until then).
  - [ ] **3 attempts over 24h** is the contract per NFR-I3. Don't extend retries beyond 24h; permanent_failure surfaces in the admin dashboard.

- [ ] **Task 7: Admin alert on 3rd-attempt failure** (AC: 2)
  - [ ] On the third failure transition, emit an audit row `action: "reminder.permanentFailure"` with `details: { customerId, deliveryId, lastError }`. The Phase 1 `recent_errors` query surfaces it on the Admin dashboard (Story 5.2's pattern).

### Customer opt-out (AC3)

- [ ] **Task 8: Extend `/(customer)/profile` with opt-out toggle** (AC: 3)
  - [ ] Update `src/app/(customer)/profile/page.tsx` (Story 9.4) to add a "Reminder preferences" section with a toggle: "Receive SMS / email reminders" (default ON).
  - [ ] On toggle, calls `customerPortal:updateReminderOptOut({ optOut })` mutation. Same own-record-only guard as Story 9.4 (no `customerId` arg — derived from ctx).
  - [ ] In `convex/customerPortal.ts`:
    ```ts
    export const updateReminderOptOut = mutation({
      args: { optOut: v.boolean() },
      handler: async (ctx, { optOut }) => {
        const { userId, customerId } = await requireRole(ctx, ["customer"]);
        if (!customerId) throwError(...);
        await ctx.db.patch(customerId, { reminderOptOut: optOut });
        await emitAudit(ctx, { action: "customer.reminderOptOutChanged", entityId: customerId, actorId: userId, details: { optOut } });
        return { ok: true };
      },
    });
    ```

### Admin settings UI (AC4)

- [ ] **Task 9: Build `/admin/settings/reminders`** (AC: 4)
  - [ ] Path: `src/app/(staff)/admin/settings/reminders/page.tsx`. `requireRole` server-side: admin only.
  - [ ] Renders the current `reminderConfig.rules` as a sortable list (each row: daysOffset, requiresUnpaid checkbox, channel dropdown, template selector). Add / delete rule affordances.
  - [ ] Save calls `admin:updateReminderConfig` mutation (in `convex/admin.ts` or `convex/reminders.ts`) which: `requireRole(["admin"])` → patches the single row → `emitAudit`.
  - [ ] **Preview affordance:** "Show next 14 days of reminders that would be sent" — a query that runs the same scan logic without dispatching. Helps Admin sanity-check cadence changes.

### Templates (AC1)

- [ ] **Task 10: SMS templates** (AC: 1)
  - [ ] Path: `convex/lib/reminderTemplates.ts`. Map `templateKey → (ctx) => string`. Initial templates:
    - `upcoming_due_3d`: "Hi {name}, your cemetery installment of ₱{amount} for lot {lotCode} is due {date}. Pay via the portal: {url}"
    - `due_today`: "Hi {name}, your installment of ₱{amount} for lot {lotCode} is due TODAY. Pay: {url}"
    - `overdue_7d`: "Hi {name}, your installment of ₱{amount} for lot {lotCode} was due {date} (7 days ago). Please settle: {url}"
  - [ ] **Length:** keep each template < 160 characters where possible (single SMS segment). Twilio bills per segment.
  - [ ] **No PII beyond name + amount + lot code.** No gov ID, no email, no address.

### Testing (AC1–AC4)

- [ ] **Task 11: Unit tests for the scan + retry logic** (AC: 1, AC: 2, AC: 3)
  - [ ] `tests/unit/convex/reminders.test.ts`:
    - Happy path: a contract has an installment due in 3 days → scan creates a `reminderDeliveries` row + schedules the action.
    - Dedup: re-running the scan on the same day → no new row.
    - Opt-out customer → skipped.
    - Paid installment + `requiresUnpaid` rule → skipped.
    - Retry path: action fails with 500 → row status returns to `queued`, attempt incremented, next run scheduled.
    - Third-attempt failure → `permanent_failure`, audit row emitted.
    - Invalid number (4xx) → `permanent_failure` immediately, no retry.

- [ ] **Task 12: Mock Twilio + e2e** (AC: 1)
  - [ ] In test harness, mock the Twilio SDK to return success / failure deterministically.
  - [ ] `tests/e2e/admin-reminders-config.spec.ts`: Admin signs in → opens `/admin/settings/reminders` → edits a rule → saves → audit row visible in audit log page.
  - [ ] Customer-side opt-out e2e is small — extend Story 9.4's profile spec.

### Documentation (AC1, AC2)

- [ ] **Task 13: Runbook** (AC: 1, AC: 2)
  - [ ] In `docs/runbook.md`, add "SMS reminders" section:
    - Twilio credential setup (env vars `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` / `TWILIO_SENDER_ID`).
    - Pilot rollout plan: enable reminders for 20 customers first, monitor delivery rates + complaint volume for 2 weeks before scaling.
    - How to investigate "customer says they didn't receive an SMS": query `reminderDeliveries` by customer + recent date; check status + providerError.
    - How to disable reminders globally (toggle in admin config or hard-disable the cron temporarily).
    - Cost monitoring: monthly Twilio bill projection, threshold for switching to a local PH provider (e.g. Semaphore, Movider) if Twilio costs exceed budget.

- [ ] **Task 14: ADR-0012 — SMS provider choice** (AC: 1)
  - [ ] Path: `docs/adr/0012-sms-provider.md`. Default Twilio. Document evaluation criteria (PH deliverability, per-SMS cost, alpha-sender registration friction, opt-out / STOP handling).
  - [ ] **If Story 9.1's ADR-0009 chose Better Auth with Twilio SMS-OTP**, this story shares the Twilio account. Otherwise this story provisions a new Twilio account (or alternative).

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Installments schema** (Phase 1 contracts story): must have `dueDate`, `status`, `contractId`, indexed by `by_dueDate`. If `by_dueDate` index missing, add as part of this story.
- **`recent_errors` Convex query / Admin dashboard** (Story 5.2 — dashboard pattern): used to surface permanent reminder failures.
- **Story 1.2 — `requireRole`, lint rule, `userRoles`:** the admin-side mutation uses these.
- **Story 1.6 — `emitAudit`:** invoked on config updates + permanent failures + opt-out changes.

**Phase 3 prior dependencies (must be complete):**

- **Story 9.1 — Twilio decision (if Better Auth + SMS-OTP path):** if Story 9.1 already provisioned Twilio for SMS-OTP, this story reuses the same account. Otherwise this story is the first Twilio integration.
- **Story 9.4 — `/(customer)/profile` page:** extended with the opt-out toggle.

**Phase 3 forward dependencies (this story enables):**

- **Story 9.8 — email reminders:** reuses the cadence config, `reminderDeliveries` table, scan logic, retry pattern. Email is added as another `channel`. The "both" channel option in `reminderConfig.rules` is the seam.

### Architecture compliance

- **Scheduled cron** is the entry point. Convex's cron primitive runs on a managed schedule — no external scheduler needed.
- **Dedup index** (`reminderDeliveries.by_installment_rule`) is the **idempotency anchor**. Re-running the scan never causes duplicate sends.
- **Retry budget NFR-I3** (3 attempts over 24h) — encoded in the action's backoff logic. Permanent failures surface to admin dashboard.
- **Per-customer opt-out** (FR57 implicit) — `customers.reminderOptOut`. Honored in the scan, not in the action (cheaper to filter early).
- **Provider abstraction (optional but recommended):** if a future PH-local SMS provider is preferred, wrap the Twilio call behind an `ISmsProvider` interface analogous to Story 9.6's gateway adapter pattern. For Phase 3 launch, direct Twilio call is fine.
- **No PII in SMS bodies beyond name + amount + lot code.** Gov ID, address, email never appear in reminder text.

### Library / framework versions (researched current)

- **Twilio Node SDK:** `twilio` package. Mature, ESM-friendly enough for Convex Node actions. Install in `package.json` (Node-runtime only; not in the client bundle).
- **PH-local alternatives (Phase 3.5 if Twilio is too expensive):** Semaphore (https://semaphore.co), Movider, IPRG. Document in ADR-0012 as fallback options.
- **No new client-bundle dependencies.**

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (reminderConfig, reminderDeliveries, customers.reminderOptOut)
│   ├── crons.ts                                   # NEW or UPDATE (register daily scan)
│   ├── reminders.ts                               # NEW (runDailyScan + admin config mutations)
│   ├── customerPortal.ts                          # UPDATE (updateReminderOptOut)
│   ├── lib/
│   │   └── reminderTemplates.ts                   # NEW
│   └── actions/
│       └── sendSmsReminder.ts                     # NEW
├── src/
│   └── app/
│       ├── (customer)/
│       │   └── profile/page.tsx                   # UPDATE (opt-out toggle)
│       └── (staff)/
│           └── admin/
│               └── settings/
│                   └── reminders/page.tsx         # NEW
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── reminders.test.ts                  # NEW
│   └── e2e/
│       └── admin-reminders-config.spec.ts         # NEW
├── docs/
│   ├── adr/
│   │   └── 0012-sms-provider.md                   # NEW
│   └── runbook.md                                 # UPDATE (SMS reminders section)
└── package.json                                   # UPDATE (twilio)
```

### Testing requirements

- **NFR-M2 coverage:** scan + dedup + retry logic is operational-critical. Target **≥ 90% line coverage** on `reminders.ts` and `sendSmsReminder.ts`. Permanent-failure path test is mandatory (admin-alert wire-up).
- **Time-dependent tests:** use a mockable `now()` helper rather than `Date.now()` directly to make day-arithmetic tests reliable.
- **No production-Twilio touch in tests** — mock the SDK. Document the mock contract.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT send SMS without honoring `reminderOptOut`.** Spam complaints + carrier blacklisting + regulatory exposure. Check in the scan, before scheduling.
- ❌ **Do NOT skip the dedup index check.** Cron retries are real; without dedup, customers receive duplicate SMS and the cemetery looks broken.
- ❌ **Do NOT retry permanent failures.** Invalid phone numbers / opted-out numbers stay failed. Retrying wastes Twilio credit and may trigger anti-spam flags.
- ❌ **Do NOT log SMS body content** in audit / Sentry. Body contains amount + lot code; not PII by itself, but redundant log volume. Log `templateKey` + delivery status instead.
- ❌ **Do NOT include gov ID, full address, or email** in SMS body. Templates are reviewed for content scope.
- ❌ **Do NOT enable reminders for all 2000 customers on day 1.** Pilot rollout of 20 customers, then 200, then full per the runbook plan. Sudden 2000-SMS-blast triggers carrier rate-limits and likely PH NTC scrutiny.
- ❌ **Do NOT hardcode Manila timezone math.** Use a timezone helper (`luxon` or `Intl.DateTimeFormat` with `timeZone: "Asia/Manila"`) — straightforward day arithmetic in UTC + offset bugs in the future when DST is theoretically adopted (PH currently doesn't, but the code should be timezone-honest).
- ❌ **Do NOT couple email reminders into this story.** Email is Story 9.8. The `channel: "both"` config option is allowed in the schema, but `runDailyScan` only handles `"sms"` paths here; the email path lands in 9.8.
- ❌ **Do NOT block on Twilio API in the cron mutation.** The mutation only inserts `reminderDeliveries` rows and schedules actions. Network calls are in the action.
- ❌ **Do NOT skip the per-rule dedup at the wrong layer.** Dedup is by `(installmentId, ruleOffset, channel)` — the SAME installment can correctly receive reminders for multiple rules (e.g. 3-day-before AND on-due) without dedup conflicts.
- ❌ **Do NOT silently swallow Twilio errors.** Persist `providerError` on the delivery row. Sentry captures full stack.

### Common LLM-developer mistakes to prevent

- **Computing `today + daysOffset` in JavaScript date arithmetic without timezone awareness** is a classic off-by-one. Always do the arithmetic in Manila tz.
- **Querying `installments` without an index** for the scan: with 72k rows, a full scan every cron is wasteful + slow. Verify `by_dueDate` index is present.
- **Scheduling the action from inside the cron mutation but expecting a return value:** scheduler is fire-and-forget. The scan inserts the delivery row, schedules the action, and returns. The action's success / failure is reflected in the delivery row's status updates.
- **Treating opt-out as a tri-state (`null | true | false`):** keep it binary. Default `false` (opt-in by default at the cemetery's product decision — surface in the user flow that customers can opt out from the portal; first reminder includes opt-out instructions).
- **Storing rendered SMS body in the delivery row:** rendered text bloat. Store `templateKey` + reference the template at audit-read time if needed.
- **`reminderConfig` as multiple rows (one per rule):** use a single document with an array of rules. Simpler to atomically update.
- **Forgetting to handle "the day before a long weekend":** if a due date falls on Mon and reminder is "3 days before," the SMS fires on Fri. That's correct; document the behavior in the admin settings page so it's not a surprise.

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (grace period):** if the policy is "no penalty for 5 days after due," the "overdue 7-day" reminder should reflect that. Configurable templates accommodate; the cadence config is a Product-Owner decision at sprint kickoff.
- **§10 Q10 (named user counts):** doesn't affect this story directly.
- **Phone-number validation depth:** Twilio validates on send. Pre-validation in `runDailyScan` (skip customers with obviously malformed phones) is a small optimization, not required for correctness.
- **SMS provider final choice:** Twilio is the default. If pilot reveals cost or deliverability issues, swap to a PH-local provider per the runbook fallback plan. Schema accommodates either.

### Project Structure Notes

Aligns with:

- [Architecture § Scheduled jobs / cron](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Architecture § `convex/actions/` for external integrations](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)
- [Architecture § Admin dashboard `recent_errors` visibility](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)

No detected conflicts.

### References

- [PRD § FR57 — Automated reminders](../../_bmad-output/planning-artifacts/prd.md#11-customer-self-service)
- [PRD § NFR-I3 (retry policy)](../../_bmad-output/planning-artifacts/prd.md#integration--reliability)
- [Architecture § Scheduled actions + cron](../../_bmad-output/planning-artifacts/architecture.md)
- [Epics § Story 9.7](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 9.4 — profile page (opt-out toggle target)](./9-4-customer-updates-own-contact-info.md)
- [Previous story 5.2 — dashboard pattern (admin alert surface)](./5-2-admin-dashboard.md)
- [Previous story 1.6 — emitAudit](./1-6-system-emits-audit-rows-for-every-mutation.md)
- Twilio Node SDK docs (current): https://www.twilio.com/docs/libraries/node
- Convex docs (current): [Scheduling cron jobs](https://docs.convex.dev/scheduling/cron-jobs), [Scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` clean (1 pre-existing unrelated portal-payments.test.ts duplicate-`collect` error retained).
- `npm run lint` clean (no warnings or errors).
- `npx vitest run tests/unit/convex/reminders.test.ts` — 35/35 pass.
- `npx vitest run` full suite — 2307/2319 pass (1 skipped, 11 pre-existing flaky/unrelated failures in dialog timing tests + CSV-export formatting test, no new failures introduced).
- `npm run build` — Next.js compile clean (46/46 static pages), known Windows-platform `_not-found` post-build rename artifact unchanged.

### Completion Notes List

- Established the **`reminderConfig` + `reminderDeliveries`** schema seam Story 9.7 requested (additive — pre-existing `smsReminderLog` / `emailReminderLog` Phase 1 stub tables retained for the deployment cut-over; legacy `send-email-reminders` cron entry retained alongside the new `send-reminders` cron for the same reason).
- The cron-driven scan `internal_runDailyReminderScan` in `convex/reminders.ts` walks `reminderConfig.rules` × `installments.by_dueDate`, hydrates contract → customer → lot, applies the **per-customer opt-out** + **per-installment+rule+channel dedup** gates, then inserts a `queued` `reminderDeliveries` row + schedules `sendSmsReminder.send` (and `sendEmailReminder.send` for Story 9.8's email branch).
- The action **`convex/actions/sendSmsReminder.ts`** routes through `internal_markDeliverySent` / `internal_markDeliveryFailed` for the result-routing seam. Provider integration is direct `fetch()` to Twilio's REST API (no `twilio` npm package needed; the story's "no new dep" constraint honored). Missing `TWILIO_*` env vars degrade to a `permanent_failure` row visible on the admin dashboard.
- **Retry / backoff curve (NFR-I3)** lives inside `internal_markDeliveryFailed`: transient → 4h → 24h → `permanent_failure`. Constants exported (`RETRY_BACKOFF_MS`, `MAX_RETRY_ATTEMPTS`) so the tests pin the schedule without re-deriving the arithmetic. **Permanent failures (4xx, opt-out)** never retry — the mutation flips the row directly to `permanent_failure`.
- Customer **opt-out mutation** `updateMyReminderOptOut` in `convex/reminders.ts` is own-record-only (resolved via `requireRole(["customer"])` + `customers.createdByUserId === auth.userId` lookup); audits the toggle via `emitAudit`. The /portal/account UI extension is deferred to the dedicated profile-page follow-up that owns `src/app/(customer)/profile/page.tsx`.
- Admin **cadence-config surface** lives at `getReminderConfig` + `updateReminderConfig` — both admin-only, the update mutation validates rules + sendHour range + emits audit. The admin settings page (`src/app/(staff)/admin/settings/reminders/page.tsx`) is deferred to the dedicated UI follow-up per the strict Phase 3 file-ownership brief; the Convex surface is complete.
- **SMS template helpers** (`convex/lib/reminderTemplates.ts`) cover the three canonical cadence templates (`upcoming_due_3d`, `due_today`, `overdue_7d`). PII discipline: name + amount + lot code only; no gov ID, no address, no email.
- **35-case vitest** at `tests/unit/convex/reminders.test.ts` covers the scan happy path, dedup, opt-out skip, paid skip, disabled rules, email branch, bounce skip, no-email skip, "both" channel, the three retry outcomes (4xx → permanent, 5xx with attempts left → retried, 5xx at attempt 3 → permanent), missing-row no-op, template renderers, and the `manilaMidnightForOffset` boundary.
- Cron registered at `convex/crons.ts` as the `send-reminders` entry (01:00 UTC = 09:00 Manila); the legacy `send-email-reminders` 01:30 UTC cron entry stays registered for the deployment cut-over.
- The admin /admin/settings/reminders page + dedicated runbook section + ADR-0012 SMS provider doc are deferred to dedicated follow-on stories that own `src/app/(staff)/admin/settings/**` + `docs/adr/**` + `docs/runbook.md` per the scoped Phase 3 file-ownership brief — the Convex + lib + tests surface this story owns is complete.

### File List

Created:

- `convex/reminders.ts` — scan + retry + admin config + customer opt-out + bounce-handler + helper query.
- `convex/lib/reminderTemplates.ts` — SMS + email template registry, pure renderers.
- `convex/actions/sendSmsReminder.ts` — Node-runtime SMS dispatch via Twilio REST.
- `convex/actions/sendEmailReminder.ts` — Node-runtime email dispatch via Resend REST (Story 9.8).
- `tests/unit/convex/reminders.test.ts` — 35 cases covering Stories 9.7 + 9.8.

Modified:

- `convex/schema.ts` — added `reminderConfig` + `reminderDeliveries` tables; extended `customers` with `reminderOptOut`, `emailBouncedAt`, `emailReminderPausedReason`, `emailBounceMessageId`; added `customers.by_emailBouncedAt` index.
- `convex/crons.ts` — added `send-reminders` daily cron at 01:00 UTC (09:00 Manila).
- `convex/http.ts` — added `POST /api/email-bounce-webhook` route + `verifyEmailBounceSignature` HMAC verifier + `parseEmailProviderEvents` Resend/SendGrid/Postmark normaliser (Story 9.8).
- `convex/portal.ts` — extended `updateCustomerContact` to clear `emailBouncedAt` + paused reason on email update (Story 9.8).
