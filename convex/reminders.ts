/**
 * Reminder engine — Story 9.8 (email reminders).
 *
 * Owns the read + write surface around `reminderConfig` +
 * `reminderDeliveries`. The daily cron entry in `convex/crons.ts`
 * invokes `internal_runDailyReminderScan`; the customer-portal opt-out
 * toggle and admin cadence-config UI consume the public mutations
 * exported here.
 *
 * The scan walks `installments.by_dueDate` for each rule and inserts
 * dedup-gated rows into `reminderDeliveries`, scheduling the per-row
 * send actions. The retry / backoff hook (`internal_markDeliveryFailed`,
 * `internal_markDeliverySent`) is consumed by
 * `convex/actions/sendEmailReminder.ts`. The action routes its result
 * back into one of these internal mutations so the database write stays
 * inside a Convex mutation (actions can only schedule mutations, not
 * write directly).
 *
 * Story 9.7 (SMS reminders) is **deferred to Phase 2**. The SMS branch
 * of the scan loop has been removed; the SMS dispatch action
 * (`sendSmsReminder.ts`) and PH-phone helper (`lib/phPhone.ts`) have
 * been deleted. Rules with `channel: "sms"` are silently skipped; rules
 * with `channel: "both"` downgrade to email-only via the email branch.
 * The `smsQueued` counter in the scan return value is retained as `0`
 * for downstream shape stability.
 *
 * Admin config mutations (`updateReminderConfig`, `getReminderConfig`),
 * the customer opt-out (`updateMyReminderOptOut`), and the email-bounce
 * webhook handler (`internal_handleEmailBounces`) all remain in service.
 *
 * Idempotency invariants:
 *   - The scan probes `reminderDeliveries.by_installment_rule` on
 *     `(installmentId, ruleOffset, channel)` BEFORE insert. Re-running
 *     the cron same-day produces zero new rows.
 *   - Retry backoff is keyed off the row's `attempt` counter +
 *     `nextAttemptAt`. The action's wrapper re-reads the row before
 *     dispatching to guard against a duplicate scheduled-action
 *     delivery.
 *
 * No PII in logs: the scan + retry mutations log `templateKey` +
 * delivery status, never the rendered body. Audit emissions on config
 * changes carry the `before` / `after` rule list (no customer data).
 *
 * Disaster prevention (Story 9.7 § Hard stops, Story 9.8 § Hard stops):
 *   - Does NOT write to `payments` / `receipts` / `paymentAllocations`
 *     / `contracts.balance` — reminder events are not financial events.
 *     The `no-direct-financial-write` lint rule continues to pass.
 *   - Never sends to customers with `reminderOptOut === true`.
 *   - Never sends email to customers with `emailBouncedAt` set.
 *   - Permanent failures (4xx / opt-out / bounce) skip retry.
 *
 * Internal mutations are exempt from `require-role-first-line` per
 * `eslint-rules/require-role-first-line.js`. Public mutations call
 * `requireRole` as the FIRST awaited statement.
 */

import {
  type DataModelFromSchemaDefinition,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { ErrorCode, throwError } from "./lib/errors";
import { DAY_MS, HOUR_MS } from "./lib/time";
import { requireCurrentCustomer } from "./portal";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ReminderConfigDoc = DataModel["reminderConfig"]["document"];
type ReminderDeliveryDoc = DataModel["reminderDeliveries"]["document"];
type ReminderDeliveryId = ReminderDeliveryDoc["_id"];
type ContractDoc = DataModel["contracts"]["document"];
type CustomerDoc = DataModel["customers"]["document"];
type CustomerId = CustomerDoc["_id"];
type InstallmentDoc = DataModel["installments"]["document"];

/**
 * Backoff schedule for transient provider failures — Story 9.7 § AC2
 * + NFR-I3. The schedule is keyed off the just-completed attempt:
 *
 *   - attempt 1 → schedule retry 4h later (attempt 2)
 *   - attempt 2 → schedule retry 20h later (attempt 3); the gap puts
 *     attempt 3 at hour 24 from the first attempt, honoring "3
 *     attempts over 24h" exactly.
 *   - attempt 3 → no further retry; the row transitions to
 *     `permanent_failure`.
 *
 * Exported so the action wrapper + tests can verify the schedule
 * without re-deriving the arithmetic.
 */
export const RETRY_BACKOFF_MS: ReadonlyArray<number> = [
  4 * HOUR_MS,
  20 * HOUR_MS,
];

/**
 * Maximum number of attempts before a transient failure transitions to
 * `permanent_failure`. NFR-I3 budget.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * P1-2 — sanitizer for `providerError` strings about to be persisted on
 * `reminderDeliveries.providerError`.
 *
 * The action wraps provider 4xx / 5xx responses as
 * `http_${status}:${body.slice(0, 200)}`. Twilio's 4xx body echoes the
 * rejected `To` number; Resend's 4xx body sometimes echoes the
 * rejected sender address. Persisting that raw form would archive
 * customer PII in a column that the admin "recent failures" widget
 * surfaces in plain text.
 *
 * Strategy:
 *   - Pre-classified strings (no `:` separator OR a known sentinel)
 *     pass through unchanged — they were already constructed without
 *     PII by the action's own enum-style error builder.
 *   - Strings of the shape `http_<status>:<body>` collapse to
 *     `http_<status>:<category>` where `<category>` is a coarse
 *     classification:
 *       * `"invalid_to"` for Twilio 21211 / Resend's "invalid recipient"
 *       * `"blocked"`    for STOP / opt-out signals
 *       * `"auth_fail"`  for 401 / 403
 *       * `"rate_limit"` for 429
 *       * `"upstream"`   for any other category
 *     The full raw body is NOT retained — it can still be inspected
 *     transiently via `console.warn` in the caller.
 *   - Strings of the shape `network:<message>` or `exception:<message>`
 *     drop the message tail and collapse to the bare prefix.
 *
 * Exported for unit-test coverage; the export is purely for
 * test-visibility.
 */
export function sanitizeProviderError(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return raw;

  // `network:<message>` / `exception:<message>` — drop the tail.
  if (raw.startsWith("network:")) return "network";
  if (raw.startsWith("exception:")) return "exception";

  // `http_<status>:<body>` — keep the status, classify the body.
  const httpMatch = /^http_(\d{3})(?::(.*))?$/s.exec(raw);
  if (httpMatch !== null) {
    const status = httpMatch[1];
    const body = httpMatch[2] ?? "";
    if (body.length === 0) {
      return `http_${status}`;
    }
    const lowered = body.toLowerCase();
    let category: string;
    if (status === "401" || status === "403") {
      category = "auth_fail";
    } else if (status === "429") {
      category = "rate_limit";
    } else if (
      lowered.includes("invalid") &&
      (lowered.includes("phone") ||
        lowered.includes("number") ||
        lowered.includes("to") ||
        lowered.includes("recipient") ||
        lowered.includes("email"))
    ) {
      category = "invalid_to";
    } else if (
      lowered.includes("blocked") ||
      lowered.includes("opt") ||
      lowered.includes("stop") ||
      lowered.includes("unsubscrib")
    ) {
      category = "blocked";
    } else {
      category = "upstream";
    }
    return `http_${status}:${category}`;
  }

  // Pre-classified enum-style sentinels (no scary delimiters) pass
  // through unchanged.
  return raw;
}

/**
 * Convex's milliseconds-to-Manila-midnight helper. Reused from the
 * existing `convex/actions/sendEmailReminders.ts` Phase 1 stub so the
 * two scan paths align on date arithmetic.
 *
 * Manila is UTC+8 with no DST. The arithmetic shifts `nowMs` by +8h,
 * floors to the start of that UTC day, shifts back to recover the
 * Manila-midnight epoch ms, then offsets by `offsetDays`.
 */
export function manilaMidnightForOffset(
  nowMs: number,
  offsetDays: number,
): number {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = nowMs + MANILA_OFFSET_MS;
  const utcDayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  const manilaMidnight = utcDayStart - MANILA_OFFSET_MS;
  return manilaMidnight + offsetDays * DAY_MS;
}

/**
 * Resolves the per-channel `templateKey` for a cadence rule. A rule
 * with `channel: "both"` carries a SINGLE `templateKey` that names the
 * SMS variant; the email sibling is derived by appending `_email`
 * (matches `emailKeyForSmsKey` in `convex/lib/reminderTemplates.ts`).
 *
 * Returns `null` when no sibling exists for the channel — defensive
 * for a future templateKey that lacks an email partner.
 */
function templateKeyForChannel(
  ruleTemplateKey: string,
  channel: "sms" | "email",
): string | null {
  if (channel === "sms") {
    // SMS rules name the SMS templateKey directly; for a "both" rule
    // the same SMS key is reused for the SMS row.
    if (ruleTemplateKey.endsWith("_email")) {
      // The rule named the email key — derive the SMS sibling by
      // stripping the suffix.
      const sms = ruleTemplateKey.slice(0, -"_email".length);
      return sms.length > 0 ? sms : null;
    }
    return ruleTemplateKey;
  }
  // channel === "email"
  if (ruleTemplateKey.endsWith("_email")) {
    return ruleTemplateKey;
  }
  // Append the suffix for "both" rules whose templateKey names the
  // SMS variant.
  return `${ruleTemplateKey}_email`;
}

/**
 * The daily reminder scan body — Story 9.7 AC1 (extended by Story 9.8
 * for the email channel).
 *
 * Walks the active rules from `reminderConfig` and for each rule:
 *   1. Finds installments whose `dueDate` matches the rule's target
 *      day (via the `by_dueDate` index).
 *   2. Filters by status (`requiresUnpaid` ⇒ skip `paid` rows).
 *   3. Hydrates contract → customer → lot (lot lookup defers to the
 *      action since the action also needs it for body rendering).
 *   4. Skips customers with `reminderOptOut === true`.
 *   5. For the SMS branch: dedup-probes `reminderDeliveries` by
 *      `(installmentId, ruleOffset, channel: "sms")` then inserts a
 *      `queued` row + schedules the `sendSmsReminder` action.
 *   6. For the email branch (Story 9.8): mirrors the SMS branch but
 *      additionally skips customers with `emailBouncedAt` set or no
 *      `email` field.
 *
 * Re-running the scan on the same day is a no-op (the dedup probe
 * short-circuits). The action's success / failure is reflected back
 * into the row via the `internal_mark*` mutations below.
 *
 * Observability: returns counters mirroring
 * `arAging.internal_recomputeAllAging` + `followUpActions.internal_reflagExpired`:
 *   - `scanned`       — installment rows visited.
 *   - `smsQueued`     — `reminderDeliveries` rows inserted with
 *                       channel SMS.
 *   - `emailQueued`   — channel email.
 *   - `skippedOptOut` — customer-side opt-out skips.
 *   - `skippedBounce` — bounce-flagged email skips (Story 9.8).
 *   - `skippedNoEmail`— customer has no email on file.
 *   - `skippedDedup`  — already-scheduled / sent.
 *   - `skippedPaid`   — installment paid or rule status mismatch.
 *
 * Internal mutation: invoked by cron only; no user context to
 * authenticate. Action scheduling uses `ctx.scheduler.runAfter(0,
 * internal.actions.sendSmsReminder.send, ...)` — the `_generated/api`
 * import is dynamic to keep the unit-test suite compatible with the
 * codegen-less repo state (mirrors the pattern in `convex/crons.ts`).
 */
export const internal_runDailyReminderScan = internalMutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{
    scanned: number;
    smsQueued: number;
    emailQueued: number;
    skippedOptOut: number;
    skippedBounce: number;
    skippedNoEmail: number;
    skippedDedup: number;
    skippedPaid: number;
  }> => {
    const startMs = Date.now();
    console.log(
      "[reminders] daily scan start",
      new Date(startMs).toISOString(),
    );

    let scanned = 0;
    const smsQueued = 0;
    let emailQueued = 0;
    let skippedOptOut = 0;
    let skippedBounce = 0;
    let skippedNoEmail = 0;
    let skippedDedup = 0;
    let skippedPaid = 0;

    const cfg = (await ctx.db
      .query("reminderConfig")
      .first()) as ReminderConfigDoc | null;
    if (cfg === null) {
      console.log("[reminders] scan no-op — reminderConfig not seeded");
      return {
        scanned,
        smsQueued,
        emailQueued,
        skippedOptOut,
        skippedBounce,
        skippedNoEmail,
        skippedDedup,
        skippedPaid,
      };
    }

    // P1-5 — global kill switch. Admin can flip `paused` via
    // `setRemindersPaused` to stop the engine in a deliverability
    // incident without editing every rule's `enabled` toggle. Returns
    // zero-counter envelope so cron observability stays honest about
    // the no-op.
    if (cfg.paused === true) {
      console.log("[reminders] reminders paused, skipping scan");
      return {
        scanned,
        smsQueued,
        emailQueued,
        skippedOptOut,
        skippedBounce,
        skippedNoEmail,
        skippedDedup,
        skippedPaid,
      };
    }

    // Resolve the scheduler reference dynamically — same pattern as
    // `convex/crons.ts`. The `_generated/api` directory is produced by
    // `npx convex dev`; until it lands, the scheduler call is a typed
    // no-op so `tsc --noEmit` passes without codegen.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let internalApi: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      internalApi = require("./_generated/api").internal;
    } catch {
      internalApi = null;
    }

    for (const rule of cfg.rules) {
      if (rule.enabled === false) continue;
      // Target due-date: "today shifted by -daysOffset" because
      // daysOffset = -3 means "due 3 days from NOW," and the
      // installment row records the due day's Manila midnight.
      const targetDueDate = manilaMidnightForOffset(startMs, -rule.daysOffset);

      const matches = (await ctx.db
        .query("installments")
        .withIndex("by_dueDate", (q) => q.eq("dueDate", targetDueDate))
        .collect()) as InstallmentDoc[];
      scanned += matches.length;

      for (const inst of matches) {
        // Status gate.
        if (rule.requiresUnpaid && inst.status === "paid") {
          skippedPaid += 1;
          continue;
        }

        const contract = (await ctx.db.get(inst.contractId)) as
          | ContractDoc
          | null;
        if (contract === null) continue;
        // pii-read-ok: reminder scan uses customer.email + opt-out flag only; the rendered email body's PII (name + amount + lot code) is the audit-visible surface, not this lookup
        const customer = (await ctx.db.get(contract.customerId)) as
          | CustomerDoc
          | null;
        if (customer === null) continue;

        // Per-customer opt-out gate — Story 9.7 AC3.
        if (customer.reminderOptOut === true) {
          skippedOptOut += 1;
          continue;
        }

        // SMS branch — Story 9.7 (DEFERRED to Phase 2). Rules with
        // `channel: "sms"` are silently skipped. Rules with
        // `channel: "both"` fall through to the email branch below so
        // the email half still fires; only the SMS half is dropped.
        // `smsQueued` remains at zero for downstream shape stability.

        // Email branch — Story 9.8.
        if (rule.channel === "email" || rule.channel === "both") {
          if (
            typeof customer.email !== "string" ||
            customer.email.trim().length === 0
          ) {
            skippedNoEmail += 1;
          } else if (customer.emailBouncedAt !== undefined) {
            skippedBounce += 1;
          } else {
            const emailKey = templateKeyForChannel(rule.templateKey, "email");
            const existingEmail = await ctx.db
              .query("reminderDeliveries")
              .withIndex("by_installment_rule", (q) =>
                q
                  .eq("installmentId", inst._id)
                  .eq("ruleOffset", rule.daysOffset)
                  .eq("channel", "email"),
              )
              .first();
            if (existingEmail !== null) {
              skippedDedup += 1;
            } else if (emailKey !== null) {
              const id = await ctx.db.insert("reminderDeliveries", {
                customerId: customer._id,
                contractId: contract._id,
                installmentId: inst._id,
                channel: "email",
                templateKey: emailKey,
                ruleOffset: rule.daysOffset,
                attempt: 1,
                status: "queued",
                scheduledAt: Date.now(),
              });
              emailQueued += 1;
              if (
                internalApi !== null &&
                internalApi.actions !== undefined &&
                internalApi.actions.sendEmailReminder !== undefined
              ) {
                await ctx.scheduler.runAfter(
                  0,
                  internalApi.actions.sendEmailReminder.send,
                  { deliveryId: id },
                );
              }
            }
          }
        }
      }
    }

    const elapsedMs = Date.now() - startMs;
    console.log("[reminders] daily scan end", {
      scanned,
      smsQueued,
      emailQueued,
      skippedOptOut,
      skippedBounce,
      skippedNoEmail,
      skippedDedup,
      skippedPaid,
      elapsedMs,
    });
    return {
      scanned,
      smsQueued,
      emailQueued,
      skippedOptOut,
      skippedBounce,
      skippedNoEmail,
      skippedDedup,
      skippedPaid,
    };
  },
});

/**
 * Marks a delivery row as successfully sent. Called by the SMS / email
 * action wrappers on a provider-side 2xx response.
 *
 * Internal mutation — invoked from `ctx.scheduler.runAfter(0, ...)`
 * inside the action.
 */
export const internal_markDeliverySent = internalMutationGeneric({
  args: {
    deliveryId: v.id("reminderDeliveries"),
    providerMessageId: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      deliveryId: ReminderDeliveryId;
      providerMessageId?: string;
    },
  ): Promise<void> => {
    const row = await ctx.db.get(args.deliveryId);
    if (row === null) return;
    const patch: {
      status: "sent";
      sentAt: number;
      providerMessageId?: string;
    } = {
      status: "sent",
      sentAt: Date.now(),
    };
    if (args.providerMessageId !== undefined) {
      patch.providerMessageId = args.providerMessageId;
    }
    await ctx.db.patch(args.deliveryId, patch);
  },
});

/**
 * Records a failed send attempt and either re-schedules a retry or
 * transitions the row to `permanent_failure`.
 *
 * Inputs:
 *   - `transient` — true for 5xx / network errors (retry per backoff);
 *                   false for 4xx-class permanent failures (transition
 *                   immediately to `permanent_failure`, no retry).
 *   - `error`     — provider error message captured for forensics.
 *
 * Behavior:
 *   - When `transient === false`: status flips to `permanent_failure`
 *     immediately. No retry. The admin dashboard surfaces these.
 *   - When `transient === true` AND `attempt < MAX_RETRY_ATTEMPTS`:
 *     increments `attempt`, sets `status: "queued"`, computes
 *     `nextAttemptAt` from `RETRY_BACKOFF_MS[attempt - 1]`, and
 *     schedules `sendSmsReminder` / `sendEmailReminder` again at that
 *     offset. The row is re-tried at `nextAttemptAt` automatically.
 *   - When `transient === true` AND `attempt >= MAX_RETRY_ATTEMPTS`:
 *     transitions to `permanent_failure`. NFR-I3 budget exhausted.
 *
 * Internal mutation — invoked from the action.
 */
export const internal_markDeliveryFailed = internalMutationGeneric({
  args: {
    deliveryId: v.id("reminderDeliveries"),
    transient: v.boolean(),
    error: v.string(),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      deliveryId: ReminderDeliveryId;
      transient: boolean;
      error: string;
    },
  ): Promise<{ outcome: "retried" | "permanent_failure" }> => {
    const row = (await ctx.db.get(
      args.deliveryId,
    )) as ReminderDeliveryDoc | null;
    if (row === null) {
      return { outcome: "permanent_failure" };
    }

    // P1-2 — sanitize the persisted `providerError` so a Twilio 4xx
    // body (which echoes the rejected `To` phone number) is not
    // archived alongside the delivery row. The full body is still
    // emitted to `console.warn` for runtime debugging, but the
    // durable column carries only a coarse classification.
    const sanitizedError = sanitizeProviderError(args.error);
    if (sanitizedError !== args.error) {
      // Surface the raw form ONCE to the runtime log for ops triage.
      // The transient console.warn line is not durable; the audit /
      // delivery row carries the safe form only.
      console.warn(
        "[reminders] providerError sanitized",
        { deliveryId: args.deliveryId, raw: args.error },
      );
    }

    // Permanent failure (4xx provider response, invalid number/email,
    // explicit opt-out signal): transition immediately.
    if (
      !args.transient ||
      row.attempt >= MAX_RETRY_ATTEMPTS
    ) {
      await ctx.db.patch(args.deliveryId, {
        // eslint-disable-next-line local-rules/no-raw-status-patch
        status: "permanent_failure",
        providerError: sanitizedError,
        failedAt: Date.now(),
      });
      return { outcome: "permanent_failure" };
    }

    // Transient failure with retries remaining — schedule the next
    // attempt at `nextAttemptAt`.
    const nextAttempt = row.attempt + 1;
    // Index into the per-attempt backoff. `RETRY_BACKOFF_MS[0]` covers
    // the unexpected case where the index is out of range; the
    // `?? 0` defensive default keeps the type narrow for downstream
    // arithmetic.
    const backoffMs: number =
      RETRY_BACKOFF_MS[row.attempt - 1] ?? RETRY_BACKOFF_MS[0] ?? 0;
    const nextAttemptAt = Date.now() + backoffMs;

    await ctx.db.patch(args.deliveryId, {
      attempt: nextAttempt,
      // eslint-disable-next-line local-rules/no-raw-status-patch
      status: "queued",
      providerError: sanitizedError,
      nextAttemptAt,
    });

    // Schedule the next send via the dynamic scheduler reference.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let internalApi: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      internalApi = require("./_generated/api").internal;
    } catch {
      internalApi = null;
    }
    if (
      internalApi !== null &&
      internalApi.actions !== undefined
    ) {
      // SMS (Story 9.7) is deferred to Phase 2 — only email rows can
      // exist; the `row.channel === "sms"` branch is unreachable.
      const target = internalApi.actions.sendEmailReminder?.send;
      if (target !== undefined) {
        await ctx.scheduler.runAfter(backoffMs, target, {
          deliveryId: args.deliveryId,
        });
      }
    }
    return { outcome: "retried" };
  },
});

/**
 * Email-bounce webhook handler — Story 9.8 AC3.
 *
 * Called from the HTTP webhook route (`convex/http.ts` →
 * `/api/email-bounce-webhook`) after the route handler verifies the
 * provider signature. The mutation patches the matching customer with
 * `emailBouncedAt` / `emailReminderPausedReason` /
 * `emailBounceMessageId` on hard bounces, and flips `reminderOptOut`
 * on spam complaints.
 *
 * Soft bounces are intentionally ignored at this layer — the action's
 * own retry backoff handles them. Only the hardest signals (mailbox
 * doesn't exist, spam complaint) translate to permanent state.
 *
 * The mutation is idempotent: if a hard-bounce event for the same
 * email arrives twice, the second patch is a no-op (same fields,
 * same values modulo `emailBouncedAt` timestamp; the field was already
 * set on the first run, so the customer was already excluded from
 * subsequent scans).
 *
 * Internal mutation — invoked from the HTTP webhook handler.
 */
export const internal_handleEmailBounces = internalMutationGeneric({
  args: {
    events: v.array(
      v.object({
        type: v.string(),
        email: v.optional(v.string()),
        providerMessageId: v.optional(v.string()),
        reason: v.optional(v.string()),
      }),
    ),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      events: Array<{
        type: string;
        email?: string;
        providerMessageId?: string;
        reason?: string;
      }>;
    },
  ): Promise<{
    processed: number;
    hardBounces: number;
    complaints: number;
    skipped: number;
  }> => {
    let hardBounces = 0;
    let complaints = 0;
    let skipped = 0;
    for (const e of args.events) {
      // P1-4 — return ALL customers matching the bounce event, not
      // just the first. Two customers (spouse / family / shared
      // household address) commonly share a single email; flipping
      // only the first match leaves the other(s) ringing the same bad
      // mailbox on subsequent scans.
      const customers = await findCustomersByBounceEvent(ctx, e);
      if (customers.length === 0) {
        skipped += 1;
        continue;
      }
      if (e.type === "email.bounced" || e.type === "hard_bounce") {
        for (const customer of customers) {
          await ctx.db.patch(customer._id, {
            emailBouncedAt: Date.now(),
            emailReminderPausedReason: "hard_bounce",
            ...(e.providerMessageId !== undefined
              ? { emailBounceMessageId: e.providerMessageId }
              : {}),
          });
        }
        hardBounces += 1;
      } else if (e.type === "email.complained" || e.type === "spam_complaint") {
        for (const customer of customers) {
          await ctx.db.patch(customer._id, {
            reminderOptOut: true,
            emailReminderPausedReason: "spam_complaint",
            ...(e.providerMessageId !== undefined
              ? { emailBounceMessageId: e.providerMessageId }
              : {}),
          });
        }
        complaints += 1;
      } else {
        // Unknown event type — defensively skip (soft bounce,
        // delivery confirmation, etc.). The action's own retry
        // handles soft bounces.
        skipped += 1;
      }
    }
    return {
      processed: args.events.length,
      hardBounces,
      complaints,
      skipped,
    };
  },
});

/**
 * Helper: resolves the customer records for a bounce event. P1-4 —
 * returns ALL matches (not just the first), so a hard bounce against a
 * shared family / household email correctly flips every customer using
 * that address. A first-match-wins lookup would leave the other family
 * members ringing the same bad mailbox on the next scan.
 *
 * Resolution order:
 *   1. `providerMessageId` (most reliable — the messageId is on the
 *      delivery row we wrote at send time, so it points at exactly the
 *      customer we tried to email). Returns the single matched
 *      customer wrapped in a 1-element array. Skips the email
 *      fallback so an event with a known message-id never accidentally
 *      flips an unrelated household member.
 *   2. `email` (case-insensitive, full-table scan — Phase 1 scale of
 *      ~2000 customers keeps this tractable). Returns EVERY matching
 *      customer.
 *
 * Returns an empty array when no customer matches.
 *
 * The fallback `email` lookup is a linear scan of customers — Phase 1
 * scale (~2000 customers) keeps this tractable. A future index on
 * `customers.email` would speed this up if email-bounce volume grows.
 */
async function findCustomersByBounceEvent(
  ctx: MutationCtx,
  event: { email?: string; providerMessageId?: string },
): Promise<CustomerDoc[]> {
  if (
    typeof event.providerMessageId === "string" &&
    event.providerMessageId.length > 0
  ) {
    const messageId: string = event.providerMessageId;
    // Find the matching reminderDeliveries row → resolve customer.
    const deliveries = await ctx.db
      .query("reminderDeliveries")
      .filter((q) => q.eq(q.field("providerMessageId"), messageId))
      .collect();
    const first = deliveries[0];
    if (first !== undefined) {
      // pii-read-ok: bounce-event resolver — returns customer for the caller to flip emailBouncedAt; no PII surfaced to provider
      const customer = (await ctx.db.get(
        first.customerId,
      )) as CustomerDoc | null;
      if (customer !== null) return [customer];
    }
  }
  if (typeof event.email === "string" && event.email.length > 0) {
    const lowered = event.email.trim().toLowerCase();
    // Linear scan — Phase 1 scale.
    const all = (await ctx.db.query("customers").collect()) as CustomerDoc[];
    const matches: CustomerDoc[] = [];
    for (const c of all) {
      if (
        typeof c.email === "string" &&
        c.email.trim().toLowerCase() === lowered
      ) {
        matches.push(c);
      }
    }
    return matches;
  }
  return [];
}

/**
 * Public admin query — returns the singleton `reminderConfig` row, or
 * `null` if the cadence has never been configured. The Admin
 * settings UI consumes this; office_staff are NOT permitted (cadence
 * is an admin-only configuration concern).
 */
export const getReminderConfig = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<ReminderConfigDoc | null> => {
    await requireRole(ctx, ["admin"]);
    return (await ctx.db
      .query("reminderConfig")
      .first()) as ReminderConfigDoc | null;
  },
});

/**
 * Public admin mutation — replaces the cadence config row. Story 9.7
 * AC4. Validates inputs server-side (rules array structure, sane
 * `sendHour` range) and emits an audit row.
 */
export const updateReminderConfig = mutationGeneric({
  args: {
    rules: v.array(
      v.object({
        daysOffset: v.number(),
        requiresUnpaid: v.boolean(),
        channel: v.union(
          v.literal("sms"),
          v.literal("email"),
          v.literal("both"),
        ),
        templateKey: v.string(),
        enabled: v.boolean(),
      }),
    ),
    timezone: v.optional(v.string()),
    sendHour: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      rules: ReminderConfigDoc["rules"];
      timezone?: string;
      sendHour?: number;
    },
  ): Promise<{ updatedAt: number }> => {
    const auth = await requireRole(ctx, ["admin"]);

    // Validate rules.
    for (const rule of args.rules) {
      if (!Number.isFinite(rule.daysOffset)) {
        throwError(
          ErrorCode.VALIDATION,
          "Each rule must have a finite daysOffset.",
          { field: "rules.daysOffset" },
        );
      }
      if (rule.templateKey.trim().length === 0) {
        throwError(
          ErrorCode.VALIDATION,
          "Each rule must name a template.",
          { field: "rules.templateKey" },
        );
      }
    }

    const timezone = args.timezone ?? "Asia/Manila";
    const sendHour = args.sendHour ?? 9;
    if (sendHour < 0 || sendHour > 23 || !Number.isInteger(sendHour)) {
      throwError(
        ErrorCode.VALIDATION,
        "sendHour must be an integer between 0 and 23.",
        { field: "sendHour" },
      );
    }

    const now = Date.now();
    const existing = (await ctx.db
      .query("reminderConfig")
      .first()) as ReminderConfigDoc | null;

    const newRow = {
      rules: args.rules,
      timezone,
      sendHour,
      updatedAt: now,
      updatedBy: auth.userId,
    };

    if (existing === null) {
      const id = await ctx.db.insert("reminderConfig", newRow);
      await emitAudit(ctx, {
        action: "create",
        entityType: "user",
        entityId: id,
        after: { rules: args.rules, timezone, sendHour },
      });
    } else {
      const before = {
        rules: existing.rules,
        timezone: existing.timezone,
        sendHour: existing.sendHour,
      };
      await ctx.db.patch(existing._id, newRow);
      await emitAudit(ctx, {
        action: "update",
        entityType: "user",
        entityId: existing._id,
        before,
        after: { rules: args.rules, timezone, sendHour },
      });
    }

    return { updatedAt: now };
  },
});

/**
 * Admin kill-switch mutation — P1-5.
 *
 * Flips the singleton `reminderConfig.paused` flag. When `paused ===
 * true`, the daily scan short-circuits at the top and logs the no-op;
 * existing in-flight retries continue to fire through the scheduled
 * actions (the kill switch stops NEW deliveries; it doesn't drain the
 * scheduler).
 *
 * Authorization: admin only. office_staff can pause via the admin
 * cadence-config UI by toggling each rule's `enabled: false`, but the
 * deployment-wide stop button is reserved for admin.
 *
 * Idempotency: setting `paused` to its current value is a no-op
 * (still emits the audit row so the operator action is traceable).
 *
 * Failure mode: if no `reminderConfig` row exists yet, the mutation
 * throws NOT_FOUND. A "pause" before any rules are seeded is
 * semantically meaningless — the scan already short-circuits on a
 * missing config.
 */
export const setRemindersPaused = mutationGeneric({
  args: { paused: v.boolean() },
  handler: async (
    ctx: MutationCtx,
    args: { paused: boolean },
  ): Promise<{ paused: boolean }> => {
    const auth = await requireRole(ctx, ["admin"]);
    const existing = (await ctx.db
      .query("reminderConfig")
      .first()) as ReminderConfigDoc | null;
    if (existing === null) {
      throwError(
        ErrorCode.NOT_FOUND,
        "reminderConfig is not seeded; configure the cadence before pausing.",
      );
    }
    const before = { paused: existing.paused === true };
    const after = { paused: args.paused };
    await ctx.db.patch(existing._id, {
      paused: args.paused,
      updatedAt: Date.now(),
      updatedBy: auth.userId,
    });
    await emitAudit(ctx, {
      action: "update",
      entityType: "user",
      entityId: existing._id,
      before,
      after,
    });
    return { paused: args.paused };
  },
});

/**
 * Customer-facing opt-out toggle — Story 9.7 AC3.
 *
 * Customer flips their `reminderOptOut` flag from the portal profile
 * page. Own-record-only — derived from the authenticated session, not
 * from a customerId arg (mirrors `portal.updateCustomerContact`'s
 * tamper-proof allow-list pattern).
 *
 * Emits an audit row with the before/after value for traceability.
 */
export const updateMyReminderOptOut = mutationGeneric({
  args: { optOut: v.boolean() },
  handler: async (
    ctx: MutationCtx,
    args: { optOut: boolean },
  ): Promise<{ optOut: boolean }> => {
    // P1-1 — use the canonical email-link resolver from
    // `convex/portal.ts` instead of an unindexed
    // `createdByUserId === auth.userId` filter. The previous local
    // lookup was fragile in two ways:
    //   1. `.filter()` without `.withIndex()` is a full-table scan; OK
    //      at 2k customers but a foot-gun as the dataset grows.
    //   2. The `createdByUserId` link is the STAFF user who created
    //      the customer record, NOT the authenticated portal user's
    //      session — for any customer onboarded by office_staff (the
    //      common case) the link would never match, so the mutation
    //      would always return NOT_FOUND.
    // `requireCurrentCustomer` resolves via the email-link policy that
    // Stories 9.2+ rely on; sharing it means the opt-out flow gets the
    // same identity binding as every other customer-self-service
    // surface for free.
    // eslint-disable-next-line local-rules/require-role-first-line -- `requireCurrentCustomer` wraps `requireRole(ctx, ["customer"])`; see `convex/portal.ts`.
    const customer = await requireCurrentCustomer(ctx);
    const before = { reminderOptOut: customer.reminderOptOut ?? false };
    const after = { reminderOptOut: args.optOut };
    await ctx.db.patch(customer._id, { reminderOptOut: args.optOut });
    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: customer._id,
      before,
      after,
    });
    return { optOut: args.optOut };
  },
});

/**
 * Admin query — paginated listing of customers with a hard-bounced
 * email (Story 9.8 AC3). Surfaces in the admin "bounced emails" view.
 */
export const getBouncedEmailCustomers = queryGeneric({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { limit?: number },
  ): Promise<
    Array<{
      _id: CustomerId;
      fullName: string;
      email: string | undefined;
      emailBouncedAt: number | undefined;
      emailReminderPausedReason: string | undefined;
      emailBounceMessageId: string | undefined;
    }>
  > => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const limit =
      typeof args.limit === "number" && args.limit > 0 ? args.limit : 50;
    const bounced = (await ctx.db
      .query("customers")
      .withIndex("by_emailBouncedAt")
      .order("desc")
      .take(limit * 2)) as CustomerDoc[];
    // The index includes rows where `emailBouncedAt` is `undefined`
    // (Convex indexes treat undefined as a sentinel). Filter the
    // sentinel rows out client-side; the take() above over-fetches to
    // compensate.
    const rows = bounced
      .filter((c) => c.emailBouncedAt !== undefined)
      .slice(0, limit)
      .map((c) => ({
        _id: c._id,
        fullName: c.fullName,
        email: c.email,
        emailBouncedAt: c.emailBouncedAt,
        emailReminderPausedReason: c.emailReminderPausedReason,
        emailBounceMessageId: c.emailBounceMessageId,
      }));
    return rows;
  },
});

/**
 * Internal query — hydrates the joined view-model the SMS / email
 * action needs to render and dispatch a reminder.
 *
 * Returns `null` when the row no longer exists, has already been sent,
 * or is in a terminal failure state. The action treats `null` as a
 * "nothing to do" no-op.
 *
 * Internal query: invoked by the scheduled action only; no user
 * context to authenticate.
 */
export const getDeliveryForSend = internalQueryGeneric({
  args: { deliveryId: v.id("reminderDeliveries") },
  handler: async (
    ctx: QueryCtx,
    args: { deliveryId: ReminderDeliveryId },
  ): Promise<{
    deliveryId: ReminderDeliveryId;
    channel: "sms" | "email";
    templateKey: string;
    attempt: number;
    status: ReminderDeliveryDoc["status"];
    customer: {
      customerId: CustomerId;
      fullName: string;
      phone: string | null;
      email: string | null;
      reminderOptOut: boolean;
      emailBouncedAt: number | null;
    };
    contract: {
      contractId: ContractDoc["_id"];
      contractNumber: string;
    };
    installment: {
      installmentId: InstallmentDoc["_id"];
      dueDate: number;
      principalCents: number;
      paidCents: number;
    };
    lotCode: string;
  } | null> => {
    const row = (await ctx.db.get(
      args.deliveryId,
    )) as ReminderDeliveryDoc | null;
    if (row === null) return null;
    if (row.status === "sent" || row.status === "permanent_failure") {
      return null;
    }
    // pii-read-ok: send-time hydration for reminder dispatch — customer fields (name + email + phone) are consumed inside the dispatch action's body rendering, not returned to clients
    const customer = (await ctx.db.get(row.customerId)) as CustomerDoc | null;
    if (customer === null) return null;
    const contract = (await ctx.db.get(row.contractId)) as ContractDoc | null;
    if (contract === null) return null;
    const inst = (await ctx.db.get(
      row.installmentId,
    )) as InstallmentDoc | null;
    if (inst === null) return null;
    // P0-1 — send-time paid-skip gate. The scan filtered paid rows at
    // scan time, but a payment can land between scan and best-effort
    // `runAfter(0, ...)` action firing (or any of the 4h / 24h
    // retries). Treat a paid installment as "nothing to do" so the
    // action wrapper short-circuits without dispatching to the
    // provider. The wrapper interprets `null` from this query as a
    // no-op and does NOT mark the row as permanent_failure — the row
    // can be left in `queued`; subsequent retries will also no-op.
    if (inst.status === "paid") {
      return null;
    }
    const lot = await ctx.db.get(contract.lotId);
    const lotCode =
      lot !== null && typeof (lot as { code?: string }).code === "string"
        ? (lot as { code: string }).code
        : "[unknown]";
    return {
      deliveryId: row._id,
      channel: row.channel,
      templateKey: row.templateKey,
      attempt: row.attempt,
      status: row.status,
      customer: {
        customerId: customer._id,
        fullName: customer.fullName,
        phone:
          typeof customer.phone === "string" && customer.phone.length > 0
            ? customer.phone
            : null,
        email:
          typeof customer.email === "string" && customer.email.length > 0
            ? customer.email
            : null,
        reminderOptOut: customer.reminderOptOut === true,
        emailBouncedAt:
          typeof customer.emailBouncedAt === "number"
            ? customer.emailBouncedAt
            : null,
      },
      contract: {
        contractId: contract._id,
        contractNumber: contract.contractNumber,
      },
      installment: {
        installmentId: inst._id,
        dueDate: inst.dueDate,
        principalCents: inst.principalCents,
        paidCents: inst.paidCents,
      },
      lotCode,
    };
  },
});
