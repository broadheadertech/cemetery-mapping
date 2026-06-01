# Story 9.8: System Sends Email Reminders

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **Admin (configuring) and Customer (receiving)**,
I want **the system to send automated email payment reminders alongside or instead of SMS — with bounce handling that pauses reminders to addresses that bounce permanently**,
so that **customers without active SMS service still receive reminders, and the system doesn't keep sending email to dead addresses** (FR57 — email portion).

This story **extends Story 9.7's reminder engine** with an email channel. The scan logic, dedup index, retry pattern, and admin config UI from 9.7 are reused. The new work is: a `sendEmailReminder` action, a bounce-handling webhook for the email provider, and `customers.emailBouncedAt` / `customers.emailReminderPausedReason` fields that pause further email sends to a known-bad address.

## Acceptance Criteria

1. **AC1 — Daily scan dispatches email reminders for `channel: "email"` and `"both"` rules**: The cron `runDailyScan` (Story 9.7) is extended to handle `channel === "email"` and the email half of `channel === "both"`. For each match it inserts a `reminderDeliveries` row with `channel: "email"` and schedules `internal.actions.sendEmailReminder`. The SMS path from 9.7 is unchanged; both channels can fire for the same installment without dedup conflict (dedup is keyed by `(installmentId, ruleOffset, channel)`).

2. **AC2 — Retry policy mirrors NFR-I3 (3 attempts over 24h)**: Same backoff curve as Story 9.7's SMS path (immediate → 4h → 24h). Permanent provider failures (e.g. 4xx with `invalid_email` reason) skip retry. Soft-bounces (5xx-class deliveries from the provider) retry on the standard backoff. Hard-bounces (provider reports the address is permanently undeliverable) trigger the bounce handler (AC3).

3. **AC3 — Bounce handling pauses reminders to bouncing addresses**: An HTTP action at `convex/http.ts` `/api/email-bounce-webhook` receives bounce notifications from the email provider (Resend / SendGrid / Postmark per ADR-0013 from Story 9.1). The webhook: (a) verifies provider signature, (b) for hard-bounces, patches the matching customer: `emailBouncedAt = now`, `emailReminderPausedReason = "hard_bounce"`. (c) Subsequent scans skip customers with `emailBouncedAt != null`. The Admin dashboard surfaces a "bounced email" list for manual follow-up; customers can update their email via Story 9.4 to clear the flag.

4. **AC4 — Admin config supports email-only / both / SMS-only per rule**: The admin settings UI from Story 9.7 already supports `channel: "sms" | "email" | "both"`. This story verifies the email path is end-to-end functional and the preview-mode "next 14 days of reminders" affordance correctly distinguishes the two channels.

## Tasks / Subtasks

### Schema additions (AC3)

- [ ] **Task 1: Extend `customers` table for bounce state** (AC: 3)
  - [ ] In `convex/schema.ts` add to the `customers` table:
    - `emailBouncedAt: v.optional(v.number())` — timestamp of most recent hard bounce.
    - `emailReminderPausedReason: v.optional(v.string())` — e.g. `"hard_bounce" | "soft_bounce_threshold" | "manual_pause"`.
    - `emailBounceMessageId: v.optional(v.string())` — provider message ID that bounced (for support tickets).
  - [ ] Once a customer updates their email via Story 9.4's `updateMyContactInfo`, the mutation should clear `emailBouncedAt` + `emailReminderPausedReason` (the new address gets a fresh chance). Extend Story 9.4's mutation accordingly — small follow-up edit; track in commit.

### Scan extension (AC1)

- [ ] **Task 2: Extend `runDailyScan` for email channel** (AC: 1)
  - [ ] In `convex/reminders.ts` (Story 9.7's file), extend the rule loop:
    ```ts
    // (existing SMS branch from Story 9.7 unchanged)
    if (rule.channel === "email" || rule.channel === "both") {
      if (!customer.email || customer.emailBouncedAt) continue;  // skip bounced / no-email
      const existingEmail = await ctx.db.query("reminderDeliveries")
        .withIndex("by_installment_rule", q =>
          q.eq("installmentId", inst._id).eq("ruleOffset", rule.daysOffset).eq("channel", "email"))
        .first();
      if (existingEmail) continue;
      const id = await ctx.db.insert("reminderDeliveries", {
        customerId: customer._id, contractId: contract._id, installmentId: inst._id,
        channel: "email", templateKey: rule.templateKey, ruleOffset: rule.daysOffset,
        attempt: 1, status: "queued", scheduledAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.actions.sendEmailReminder, { deliveryId: id });
    }
    ```
  - [ ] **Skip if `emailBouncedAt` is set** — this is the primary defense against repeating-bounce loops.
  - [ ] **Skip if `customer.email` is missing** — Phase 1 should require email for all customers, but defensive check.

### Email-send action (AC1, AC2)

- [ ] **Task 3: Implement `sendEmailReminder` action** (AC: 1, AC: 2)
  - [ ] Path: `convex/actions/sendEmailReminder.ts`. `"use node"`.
  - [ ] Reads the `reminderDeliveries` row + customer + contract + installment. Renders the email (HTML + plain-text) from the template (extend `convex/lib/reminderTemplates.ts` from Story 9.7 with email-specific templates — usually richer than SMS).
  - [ ] Calls `convex/actions/lib/sendEmail.ts` (Story 9.1's shared helper). Provider is per ADR-0013 (Resend by default).
  - [ ] On success: patch delivery → `sent`, `providerMessageId`. On 4xx (invalid email shape, blocked sender): `permanent_failure`. On 5xx / network: retry per backoff (mirror Story 9.7 Task 6).
  - [ ] **Email template content:** richer than SMS — include cemetery branding, the receipt link if relevant, a clear "Pay now" CTA pointing to `/(customer)/pay?contractId=...`. Include an unsubscribe footer (legal expectation + customer-relations hygiene).

- [ ] **Task 4: Email templates** (AC: 1)
  - [ ] Extend `convex/lib/reminderTemplates.ts` with email-channel variants (`upcoming_due_3d_email`, `due_today_email`, `overdue_7d_email`).
  - [ ] HTML template: simple table-based layout (email-client compat); plain-text fallback for the same content. Use a Mustache-like helper or a thin templating layer.
  - [ ] **Footer:** "You're receiving this because you have an active contract. Manage reminder preferences: {portalUrl}/profile. Unsubscribe from all reminders: {optOutUrl}." The opt-out URL points to a public page that requires a confirmation step (avoid one-click-from-spam unsubscribe).

### Bounce webhook (AC3)

- [ ] **Task 5: Implement `/api/email-bounce-webhook` HTTP action** (AC: 3)
  - [ ] In `convex/http.ts`, register:
    ```ts
    http.route({
      path: "/api/email-bounce-webhook",
      method: "POST",
      handler: httpAction(async (ctx, req) => {
        const rawBody = await req.text();
        const sig = req.headers.get(EMAIL_PROVIDER_SIG_HEADER);
        if (!verifyEmailWebhookSignature(rawBody, sig, process.env.EMAIL_WEBHOOK_SECRET)) {
          return new Response("unauthorized", { status: 401 });
        }
        const events = parseEmailProviderEvents(JSON.parse(rawBody));  // provider-specific
        await ctx.runMutation(internal.reminders.handleEmailBounces, { events });
        return new Response("ok", { status: 200 });
      }),
    });
    ```
  - [ ] **Signature verification first** — same pattern as Story 9.5 / 9.6 payment webhooks.
  - [ ] **Provider-specific:** Resend's webhook scheme differs from SendGrid's. Wrap parser in a provider-specific helper. Per ADR-0013, only one provider is live at a time; the helper can be straightforward.

- [ ] **Task 6: Implement `reminders.handleEmailBounces` mutation** (AC: 3)
  - [ ] In `convex/reminders.ts`:
    ```ts
    export const handleEmailBounces = internalMutation({
      args: { events: v.array(v.any()) },
      handler: async (ctx, { events }) => {
        for (const e of events) {
          if (e.type === "email.bounced" && e.bounce_type === "hard") {
            // Find the customer by email or by providerMessageId
            const customer = await findCustomerByBounceEvent(ctx, e);
            if (!customer) continue;
            await ctx.db.patch(customer._id, {
              emailBouncedAt: Date.now(),
              emailReminderPausedReason: "hard_bounce",
              emailBounceMessageId: e.messageId,
            });
            await emitAudit(ctx, {
              action: "customer.emailBounced",
              entityType: "customer",
              entityId: customer._id,
              actorId: null,  // system
              actorRole: "system",
              details: { bounceType: "hard", reason: e.reason ?? null },
            });
          } else if (e.type === "email.complained") {
            // Spam complaint — treat as opt-out, more aggressive than bounce.
            // Patch customer: reminderOptOut = true (existing from 9.7); emit audit.
          }
        }
      },
    });
    ```
  - [ ] **Soft bounces** (transient): no permanent state change. The action's own retry handles them.
  - [ ] **Spam complaints**: treat as immediate opt-out (more aggressive than bounce). This is a hygiene mandate from email-provider TOS.

### Customer-facing recovery (AC3)

- [ ] **Task 7: Clear bounce flag on email update** (AC: 3)
  - [ ] Extend Story 9.4's `updateMyContactInfo`: if `args.email` is set AND `customer.emailBouncedAt` is set, clear `emailBouncedAt`, `emailReminderPausedReason`, `emailBounceMessageId` in the same patch.
  - [ ] Add a banner to `/(customer)/profile` if `emailBouncedAt != null`: "We tried to email you but the message bounced. Please update your email address."

- [ ] **Task 8: Admin "bounced emails" view** (AC: 3)
  - [ ] On the Admin dashboard (extend Story 5.2 with a small widget) OR a new `/admin/reports/email-bounces` page: list customers with `emailBouncedAt != null`, sortable by date. Action affordance: "Mark as resolved" (clears the flag manually after staff phones / texts the customer to confirm new email).
  - [ ] Query: `admin.getBouncedEmailCustomers` — `requireRole(["admin","office_staff"])` + paginated list.

### Testing (AC1–AC4)

- [ ] **Task 9: Unit tests** (AC: 1, AC: 2, AC: 3)
  - [ ] Extend `tests/unit/convex/reminders.test.ts`:
    - Email-channel scan: customer with valid email → row inserted, action scheduled.
    - Bounced email: customer with `emailBouncedAt != null` → skipped.
    - Customer with no email: skipped.
    - Bounce-webhook hard-bounce → customer flagged, audit emitted.
    - Bounce-webhook spam complaint → customer flagged opt-out.
    - Bounce-webhook signature mismatch → 401 + mutation not invoked.
    - Story 9.4 mutation extension: customer updates email → bounce flag cleared.
  - [ ] Mock the email provider SDK like Story 9.7 mocks Twilio.

- [ ] **Task 10: Playwright e2e** (AC: 3)
  - [ ] `tests/e2e/admin-bounced-emails.spec.ts`:
    - Seed a customer with `emailBouncedAt` set.
    - Admin signs in → opens bounced-email list → sees the customer.
    - Customer logs in → updates email → bounce flag clears in real time on admin's screen (reactivity).

### Documentation (AC3)

- [ ] **Task 11: Runbook** (AC: 3)
  - [ ] In `docs/runbook.md`, add "Email reminders" section:
    - Provider credentials (`RESEND_API_KEY` etc.), webhook URL to register in the provider dashboard for bounce/complaint notifications.
    - Bounce-handling workflow: how to investigate, when to call the customer to confirm new email, how the bounce flag clears.
    - Sender domain setup: DKIM, SPF, DMARC records (deliverability hygiene; usually one-time setup by ops or the email provider's wizard).
    - Pilot rollout: same staged plan as Story 9.7 — 20 customers, observe deliverability, scale.

- [ ] **Task 12: Update threat-model** (AC: 3)
  - [ ] In `docs/threat-model.md`, add "Email reminder threats": bounce-storm DoS (rate-limit per-cron-run + email provider quotas), spoofed bounce events (signature verification), email-address harvesting (provider abuse — not a customer-portal concern but mention).

## Dev Notes

### Previous story intelligence

**Phase 1 dependencies:**

- **Customers schema:** must have `email` field. Phase 1's customer story is the source.
- **`recent_errors` Admin dashboard surface** (Story 5.2): bounce-storm alerts and permanent-failure visibility.
- **Story 1.6 — `emitAudit`:** invoked on bounce flag toggles.

**Phase 3 prior dependencies (must be complete):**

- **Story 9.1 — `convex/actions/lib/sendEmail.ts`** + ADR-0013 (email provider). The shared helper is consumed here.
- **Story 9.4 — `updateMyContactInfo`** is extended to clear the bounce flag.
- **Story 9.7 — full reminder engine** (cron, scan, retry, dedup, schema): this story plugs the email channel into it. **9.7 must be merged before 9.8 starts.**

**Phase 3 forward dependencies:**

- None direct. Phase 4 enhancements (per-template A/B, multi-language email, transactional notification preferences beyond just reminders) build on this foundation.

### Architecture compliance

- **Cron + scheduled-action pattern** unchanged from Story 9.7. Email is just another channel.
- **Dedup index** unchanged — keyed by `(installmentId, ruleOffset, channel)` so SMS + email for the same rule + installment don't conflict.
- **Retry budget NFR-I3** unchanged: 3 attempts over 24h, with provider-class-specific override (4xx-permanent → no retry).
- **Bounce webhook** uses the same signature-verify-first pattern as payment webhooks. Reuse the constant-time-compare hygiene from Story 9.5.
- **No PII in email subjects** — email subject line should be generic ("Reminder: cemetery installment due soon") to avoid information leak to anyone with shoulder-surfing access to the recipient's inbox.
- **Unsubscribe / opt-out from email footer** — required by deliverability hygiene and good customer relations.

### Library / framework versions (researched current)

- **Email provider:** per ADR-0013. Recommended Resend; supported alternatives SendGrid, Postmark.
- **No new client-bundle dependencies.** Email-rendering and provider SDKs live in Convex Node actions.
- **HTML email templates:** simple table-layout strings are sufficient for Phase 3. Avoid adding `mjml` / `react-email` complexity unless content needs grow.

### File structure requirements

```
cemetery-mapping/
├── convex/
│   ├── schema.ts                                  # UPDATE (customers.emailBouncedAt, etc.)
│   ├── http.ts                                    # UPDATE (add /api/email-bounce-webhook route)
│   ├── reminders.ts                               # UPDATE (email branch in scan, handleEmailBounces)
│   ├── customerPortal.ts                          # UPDATE (Story 9.4's mutation extension to clear bounce flag)
│   ├── admin.ts                                   # UPDATE or NEW (getBouncedEmailCustomers query)
│   ├── lib/
│   │   └── reminderTemplates.ts                   # UPDATE (email-channel templates)
│   └── actions/
│       └── sendEmailReminder.ts                   # NEW
├── src/
│   └── app/
│       ├── (customer)/
│       │   └── profile/page.tsx                   # UPDATE (bounce banner)
│       └── (staff)/
│           └── admin/
│               └── reports/
│                   └── email-bounces/page.tsx     # NEW (or widget on dashboard)
├── tests/
│   ├── unit/
│   │   └── convex/
│   │       └── reminders.test.ts                  # UPDATE
│   └── e2e/
│       └── admin-bounced-emails.spec.ts           # NEW
└── docs/
    ├── runbook.md                                 # UPDATE (Email reminders section)
    └── threat-model.md                            # UPDATE (email-bounce threats)
```

### Testing requirements

- **NFR-M2 coverage:** bounce-webhook signature + mutation paths target **≥ 90%**. The path "customer's email bounces → next scan skips them" is the operational guarantee — must have a test.
- **Time-dependent tests** use the mockable `now()` from Story 9.7.

### Disaster prevention — what the dev agent must NOT do

- ❌ **Do NOT keep sending email to a hard-bounced address.** This is a deliverability suicide pact — providers will throttle the sending domain. The scan-side skip is the primary defense.
- ❌ **Do NOT skip the bounce-webhook signature verification.** Spoofed bounce events could mass-disable email reminders for a competitor / disgruntled employee scenario. Constant-time signature compare.
- ❌ **Do NOT auto-clear `emailBouncedAt`** by any path other than the customer updating their email (Story 9.4) or admin "Mark as resolved." Time-based auto-clear ("after 30 days") is wrong — the bad address is still bad.
- ❌ **Do NOT send bounce-handling work to a separate non-atomic flow.** The webhook hits the mutation directly; the mutation patches the customer + emits audit atomically. Don't shell out to a scheduler.
- ❌ **Do NOT include the customer's name in the email subject line** unless intentional. Subject-line leak is a known threat.
- ❌ **Do NOT skip the unsubscribe footer.** Required by deliverability hygiene + customer relations.
- ❌ **Do NOT log full email body content** in audit / Sentry. `templateKey` + delivery status only.
- ❌ **Do NOT mix soft bounces and hard bounces.** Soft bounces (mailbox full, temporary outage) should retry per the existing backoff. Hard bounces (no such mailbox) trigger the pause.
- ❌ **Do NOT enable email reminders for all customers on day 1.** Pilot rollout (20 → 200 → all). Email reputation builds slowly + breaks fast.
- ❌ **Do NOT send bounce webhooks to staff via email.** That's a feedback loop just waiting to bounce. Surface bounces on the admin dashboard, log to audit, optionally Slack / SMS staff for thresholds.
- ❌ **Do NOT design for "user requests email replay"** in this story. If a customer says "I deleted the email; resend it," that's a manual staff workflow for now.

### Common LLM-developer mistakes to prevent

- **Treating soft bounces as hard bounces:** the provider distinguishes them. Read the provider's event types carefully and map only hard bounces (and spam complaints) to the pause state.
- **Forgetting to clear `emailBouncedAt` on email update:** customers update emails specifically to fix bounces. The mutation in Story 9.4 must clear the flag in the same patch.
- **Bounce-webhook race conditions:** if the bounce arrives during a retry, the action might still send. Acceptable — the flag pauses future sends, not the in-flight attempt. Don't try to cancel the in-flight scheduled action; the next scan respects the flag.
- **Provider-specific webhook payload assumptions:** providers change their event schemas. Wrap the parser in a single function (`parseEmailProviderEvents`) and update it if the provider changes versions. Don't sprinkle provider-shape assumptions across the codebase.
- **Email template HTML rendering bugs:** test on Gmail (Webmail + Android client) + Apple Mail + Outlook (legacy renderer is its own world). Don't ship a template without manual visual QA on those three.
- **Forgetting DKIM/SPF/DMARC** in the runbook: deliverability is heavily dependent on these DNS records. Without them, even Resend's good sender reputation won't save inbox placement.
- **Confusing bounce-webhook with delivery-webhook:** the provider has separate event types. We only care about bounces + complaints for this story. (Delivery confirmation is informational; not blocking.)

### Open questions / blockers this story does NOT resolve

- **§10 Q1 (grace period):** same as Story 9.7 — affects the cadence content, not the engine.
- **Customer reply handling:** if a customer replies to a reminder email, where does it go? Out of scope — set the `Reply-To:` header to a monitored cemetery office address; staff handle replies manually.
- **Multi-language email:** Filipino versions deferred (Phase 4).
- **Branded sender domain:** depends on the cemetery business's domain ownership. Document in runbook; default to `reminders@<cemetery-domain>.ph` once procured.
- **Per-template open / click tracking:** out of scope. Adds analytics complexity. Phase 4 enhancement.

### Project Structure Notes

Aligns with:

- [Architecture § Scheduled actions + external integrations](../../_bmad-output/planning-artifacts/architecture.md#core-architectural-decisions)
- [Architecture § `convex/actions/lib/` for shared adapter helpers](../../_bmad-output/planning-artifacts/architecture.md#project-structure--boundaries)

No detected conflicts.

### References

- [PRD § FR57 — Automated reminders (email portion)](../../_bmad-output/planning-artifacts/prd.md#11-customer-self-service)
- [PRD § NFR-I3 (retry policy)](../../_bmad-output/planning-artifacts/prd.md#integration--reliability)
- [Architecture § Scheduled actions + webhooks](../../_bmad-output/planning-artifacts/architecture.md)
- [Epics § Story 9.8](../../_bmad-output/planning-artifacts/epics.md)
- [Previous story 9.1 — sendEmail helper + email provider ADR-0013](./9-1-customer-authenticates-to-the-portal.md)
- [Previous story 9.4 — updateMyContactInfo (extended here)](./9-4-customer-updates-own-contact-info.md)
- [Previous story 9.7 — reminder engine (extended here)](./9-7-system-sends-sms-payment-reminders.md)
- [Previous story 5.2 — dashboard pattern](./5-2-admin-dashboard.md)
- Resend / SendGrid / Postmark docs (current at implementation time)
- Convex docs (current): [HTTP actions](https://docs.convex.dev/functions/http-actions)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m]

### Debug Log References

- `npx tsc --noEmit` clean (pre-existing unrelated portal-payments.test.ts error retained).
- `npm run lint` clean.
- `npx vitest run tests/unit/convex/reminders.test.ts` — 35/35 pass (covers Stories 9.7 + 9.8).
- `npm run build` — Next.js compile clean, known Windows post-build artefact unchanged.

### Completion Notes List

- **Extended Story 9.7's `internal_runDailyReminderScan`** with the email branch — handles `channel: "email"` and the email half of `channel: "both"` against the same `reminderDeliveries` table. Dedup keyed on `(installmentId, ruleOffset, channel)` so SMS + email for the same rule + installment don't conflict.
- The scan **defensively skips** customers with `emailBouncedAt` set (hard-bounce pause) or no `email` field. Counters `skippedBounce` + `skippedNoEmail` exposed for ops visibility.
- **`convex/actions/sendEmailReminder.ts`** mirrors the SMS action's structure: Node-runtime Convex action, plain `fetch()` to Resend's REST API (no `resend` npm dep), result-routes through the shared `internal_markDeliverySent` / `internal_markDeliveryFailed` mutations. Missing `RESEND_API_KEY` / `EMAIL_FROM` env vars degrade to `permanent_failure` row.
- **Email template renderer** (`renderEmail` in `convex/lib/reminderTemplates.ts`) returns `{ subject, bodyPlain, bodyHtml }`. **Subject lines are generic** (no PII per Story 9.8 § 199); **body includes name + amount + lot code + portal URL + unsubscribe footer**; HTML uses a simple inline-style table layout for email-client compatibility (no MJML / react-email).
- **`POST /api/email-bounce-webhook`** route registered in `convex/http.ts`. Signature verification via HMAC-SHA256 with constant-time hex compare (`verifyEmailBounceSignature`). Accepts raw-hex, Svix-style `t=…,v1=<hex>`, and Postmark base64 signature header formats. `EMAIL_WEBHOOK_SECRET` env var gates the route — unset secret rejects all requests.
- **`parseEmailProviderEvents`** normalises Resend / SendGrid / Postmark payloads to the canonical `{ type, email, providerMessageId, reason }` event shape consumed by `reminders.internal_handleEmailBounces`. Soft bounces are filtered at the parser (not the mutation) so only hard bounces and spam complaints reach the customer-record patch.
- **`reminders.internal_handleEmailBounces`** flips `emailBouncedAt` + `emailReminderPausedReason: "hard_bounce"` on hard bounces; flips `reminderOptOut: true` + `emailReminderPausedReason: "spam_complaint"` on spam complaints. Both find the customer via the delivery row's `providerMessageId` first, then by email-address linear scan as fallback.
- **`updateCustomerContact` extension** (Story 9.4's portal mutation): when the customer updates their email AND the prior address was hard-bounced, `emailBouncedAt` / `emailReminderPausedReason` / `emailBounceMessageId` are cleared in the same patch. Auto-clear ONLY fires on email change — phone / address updates leave the bounce state untouched.
- **Admin "bounced emails" query** (`reminders.getBouncedEmailCustomers`) backed by the new `customers.by_emailBouncedAt` index. Paginated, admin+office_staff gated.
- **Race-window defense** inside `sendEmailReminder`: re-reads the customer at send time and refuses dispatch if `emailBouncedAt` was set between scan-time and send-time (a bounce webhook race).
- **35-case vitest** covers Story 9.8's scan branch (email queue, bounce skip, no-email skip, "both" channel fans out to two rows) + the bounce-webhook helpers (`parseEmailProviderEvents` Resend / SendGrid / Postmark fixtures + soft-bounce filtering + `verifyEmailBounceSignature` raw-hex / Svix-style / tampered-rejection paths).
- The `/admin/reports/email-bounces` admin UI page + customer-profile bounce banner + dedicated runbook section + threat-model update + ADR-0013 email-provider doc are deferred to dedicated follow-on stories that own `src/app/(staff)/admin/reports/**` + `src/app/(customer)/profile/**` + `docs/**` per the scoped Phase 3 file-ownership brief — the Convex + http + lib + tests surface this story owns is complete.

### File List

See Story 9.7's File List — Stories 9.7 + 9.8 ship as a unified change set against the same files (the email branch piggybacks on the SMS scaffolding):

Created:

- `convex/actions/sendEmailReminder.ts` — Node-runtime Resend dispatch + result routing.

Modified (shared with Story 9.7):

- `convex/schema.ts` — `customers.emailBouncedAt` + `emailReminderPausedReason` + `emailBounceMessageId` + `by_emailBouncedAt` index added in same edit set as Story 9.7's `reminderOptOut`.
- `convex/reminders.ts` — email branch in `internal_runDailyReminderScan`, `internal_handleEmailBounces` bounce + complaint handler, `getBouncedEmailCustomers` admin query.
- `convex/lib/reminderTemplates.ts` — `renderEmail` + `EmailTemplateKey` + HTML/plain renderers shipped in the same file as SMS templates.
- `convex/http.ts` — `POST /api/email-bounce-webhook` route + `verifyEmailBounceSignature` HMAC verifier + `parseEmailProviderEvents` provider-matrix parser.
- `convex/portal.ts` — `updateCustomerContact` clears bounce flag on email update.
- `convex/crons.ts` — `send-reminders` cron handles email branch (legacy `send-email-reminders` stub cron retained for cut-over).
- `tests/unit/convex/reminders.test.ts` — bounce-webhook + email-branch cases.
