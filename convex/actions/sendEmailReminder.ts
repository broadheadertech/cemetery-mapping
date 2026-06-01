"use node";

/**
 * Email reminder dispatch — Story 9.8 (FR57, NFR-I3).
 *
 * Node-runtime Convex action. Mirrors the SMS action's
 * (`sendSmsReminder.ts`) structure: picks up a queued
 * `reminderDeliveries` row, renders the email subject + body from the
 * templateKey, calls the email provider (Resend by default), routes
 * the result through the shared internal-mutation outcome surface.
 *
 * Provider choice — per ADR-0013 (Story 9.1) — Resend by default.
 * Phase 1 implementation uses plain `fetch()` to Resend's REST API
 * rather than installing the `resend` npm package; the per-request
 * surface is small enough that the dependency cost isn't worth it.
 *
 * Env vars (documented in the runbook):
 *   - `RESEND_API_KEY` — secret API key (e.g. `re_xxxx`).
 *   - `EMAIL_FROM`     — sender address. Default
 *                        `reminders@cemetery.invalid` (deliberately
 *                        invalid so a fresh deployment fails closed —
 *                        admins MUST set the real sender before
 *                        enabling the cron).
 *
 * Bounce handling: this action does NOT see bounce events at send
 * time — bounces arrive asynchronously via the
 * `/api/email-bounce-webhook` route. The action's job ends at "send
 * accepted by provider" (200 from Resend = success). The webhook
 * later patches the customer if the address turns out to be bad.
 *
 * Hard-bounced customer defense in depth: the scan filters bounced
 * customers BEFORE creating the delivery row, and the action re-reads
 * the customer at send time and refuses to dispatch if
 * `emailBouncedAt` has been set in the meantime (race-window
 * defense).
 */

import type { GenericActionCtx } from "convex/server";
import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import schema from "../schema";
import type { DataModelFromSchemaDefinition } from "convex/server";
import {
  renderEmail,
  isEmailTemplateKey,
} from "../lib/reminderTemplates";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type ReminderDeliveryId =
  DataModel["reminderDeliveries"]["document"]["_id"];
type CustomerId = DataModel["customers"]["document"]["_id"];
type ContractId = DataModel["contracts"]["document"]["_id"];
type InstallmentId = DataModel["installments"]["document"]["_id"];

/**
 * Hydration view-model — mirrors the SMS action's view shape. The
 * underlying internal query (`reminders:getDeliveryForSend`) returns
 * both branches; the action discriminates on `channel`.
 */
interface DeliveryForSend {
  deliveryId: ReminderDeliveryId;
  channel: "sms" | "email";
  templateKey: string;
  attempt: number;
  status:
    | "queued"
    | "sending"
    | "sent"
    | "failed"
    | "permanent_failure";
  customer: {
    customerId: CustomerId;
    fullName: string;
    phone: string | null;
    email: string | null;
    reminderOptOut: boolean;
    emailBouncedAt: number | null;
  };
  contract: {
    contractId: ContractId;
    contractNumber: string;
  };
  installment: {
    installmentId: InstallmentId;
    dueDate: number;
    principalCents: number;
    paidCents: number;
  };
  lotCode: string;
}

const getDeliveryForSendRef = makeFunctionReference<
  "query",
  { deliveryId: string },
  DeliveryForSend | null
>("reminders:getDeliveryForSend");

const markDeliverySentRef = makeFunctionReference<
  "mutation",
  { deliveryId: string; providerMessageId?: string },
  null
>("reminders:internal_markDeliverySent");

const markDeliveryFailedRef = makeFunctionReference<
  "mutation",
  { deliveryId: string; transient: boolean; error: string },
  { outcome: "retried" | "permanent_failure" }
>("reminders:internal_markDeliveryFailed");

/**
 * Internal action — sends one queued email reminder. Scheduled by the
 * cron-driven scan + the retry path in
 * `reminders.internal_markDeliveryFailed`.
 */
export const send = actionGeneric({
  args: { deliveryId: v.id("reminderDeliveries") },
  handler: async (
    ctx: ActionCtx,
    args: { deliveryId: ReminderDeliveryId },
  ): Promise<{ outcome: "sent" | "retried" | "permanent_failure" }> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Cron-scheduled internal action: invoked by the reminder sweep + retry path; no user context exists at the action layer.
    const view = (await ctx.runQuery(getDeliveryForSendRef, {
      deliveryId: args.deliveryId,
    })) as DeliveryForSend | null;

    if (view === null) {
      return { outcome: "permanent_failure" };
    }

    if (view.channel !== "email") {
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: "wrong_channel",
      });
      return { outcome: "permanent_failure" };
    }

    // Race-window defense: the scan filtered bounced customers, but
    // a bounce webhook could land between scan-time and send-time.
    if (view.customer.emailBouncedAt !== null) {
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: "email_bounced",
      });
      return { outcome: "permanent_failure" };
    }

    if (view.customer.reminderOptOut) {
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: "customer_opted_out",
      });
      return { outcome: "permanent_failure" };
    }

    if (
      view.customer.email === null ||
      view.customer.email.trim().length === 0
    ) {
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: "no_email",
      });
      return { outcome: "permanent_failure" };
    }

    if (!isEmailTemplateKey(view.templateKey)) {
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: `unknown_template:${view.templateKey}`,
      });
      return { outcome: "permanent_failure" };
    }

    // P0-1 (non-positive amount guard) — if the installment has been
    // paid down to zero (or overpaid) between scan time and send time,
    // do NOT dispatch an "amount due ₱0.00" email to the customer.
    // Mark the delivery as `permanent_failure` with `stale_paid` so
    // the admin dashboard can distinguish this from provider errors.
    // The getDeliveryForSend gate already short-circuits the `status:
    // "paid"` case; this is the defense-in-depth check for
    // partially-paid rows whose remaining balance happens to be <= 0.
    const amountCents =
      view.installment.principalCents - view.installment.paidCents;
    if (amountCents <= 0) {
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: "stale_paid",
      });
      return { outcome: "permanent_failure" };
    }

    const rendered = renderEmail(view.templateKey, {
      customerName: view.customer.fullName,
      amountCents,
      lotCode: view.lotCode,
      dueDateMs: view.installment.dueDate,
      portalUrl: resolvePortalUrl(),
    });

    const credentials = readResendCredentials();
    if (credentials === null) {
      console.warn(
        "[sendEmailReminder] Resend not configured — marking permanent_failure",
        { deliveryId: args.deliveryId, templateKey: view.templateKey },
      );
      await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: false,
        error: "resend_not_configured",
      });
      return { outcome: "permanent_failure" };
    }

    try {
      const result = await sendViaResend({
        apiKey: credentials.apiKey,
        from: credentials.from,
        to: view.customer.email,
        subject: rendered.subject,
        text: rendered.bodyPlain,
        html: rendered.bodyHtml,
      });
      if (result.kind === "ok") {
        await ctx.runMutation(markDeliverySentRef, {
          deliveryId: args.deliveryId,
          providerMessageId: result.messageId,
        });
        console.log("[sendEmailReminder] sent", {
          deliveryId: args.deliveryId,
          templateKey: view.templateKey,
          attempt: view.attempt,
          providerMessageId: result.messageId,
        });
        return { outcome: "sent" };
      }
      if (result.kind === "permanent") {
        await ctx.runMutation(markDeliveryFailedRef, {
          deliveryId: args.deliveryId,
          transient: false,
          error: result.error,
        });
        return { outcome: "permanent_failure" };
      }
      const { outcome } = (await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: true,
        error: result.error,
      })) as { outcome: "retried" | "permanent_failure" };
      return { outcome };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const { outcome } = (await ctx.runMutation(markDeliveryFailedRef, {
        deliveryId: args.deliveryId,
        transient: true,
        error: `exception:${message}`,
      })) as { outcome: "retried" | "permanent_failure" };
      return { outcome };
    }
  },
});

function readResendCredentials(): { apiKey: string; from: string } | null {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (env === undefined) return null;
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM ?? env.RESEND_FROM;
  if (
    typeof apiKey !== "string" ||
    apiKey.trim().length === 0 ||
    typeof from !== "string" ||
    from.trim().length === 0
  ) {
    return null;
  }
  return { apiKey: apiKey.trim(), from: from.trim() };
}

function resolvePortalUrl(): string {
  const fromEnv =
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    process.env !== null
      ? process.env.PORTAL_URL
      : undefined;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return "https://portal.example.ph";
}

type ResendResult =
  | { kind: "ok"; messageId: string }
  | { kind: "permanent"; error: string }
  | { kind: "transient"; error: string };

/**
 * Issues a POST to Resend's `/emails` endpoint via `fetch()`.
 * Returns a discriminated result so the action can route to the
 * matching internal-mutation outcome.
 *
 * Exported for unit-test injection of a fetch mock.
 */
export async function sendViaResend(args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  fetchImpl?: typeof fetch;
}): Promise<ResendResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: args.from,
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html,
      }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "transient", error: `network:${message}` };
  }
  if (res.status >= 200 && res.status < 300) {
    let json: { id?: string } = {};
    try {
      json = (await res.json()) as { id?: string };
    } catch {
      // empty
    }
    return {
      kind: "ok",
      messageId: typeof json.id === "string" ? json.id : "",
    };
  }
  if (res.status >= 400 && res.status < 500) {
    let detail = `http_${res.status}`;
    try {
      const body = await res.text();
      detail = `http_${res.status}:${body.slice(0, 200)}`;
    } catch {
      // empty
    }
    return { kind: "permanent", error: detail };
  }
  let detail = `http_${res.status}`;
  try {
    const body = await res.text();
    detail = `http_${res.status}:${body.slice(0, 200)}`;
  } catch {
    // empty
  }
  return { kind: "transient", error: detail };
}
