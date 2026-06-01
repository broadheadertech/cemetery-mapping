"use node";

/**
 * Account-email-change security notification — Epic 9 H1 follow-up.
 *
 * Node-runtime Convex action scheduled (fire-and-forget) by
 * `portal.updateCustomerContact` when a customer changes the email on
 * their owner-portal account. It emails the PREVIOUS address — the one
 * the real owner still controls — so that an email change made from a
 * hijacked session is visible to the legitimate owner, who can then
 * contact the office.
 *
 * Provider: Resend (per ADR-0013), reusing the shared `sendViaResend`
 * fetch helper from `sendEmailReminder.ts`. Best-effort: a send failure
 * is logged and swallowed — the email change itself already committed
 * in the mutation transaction, and a missed notification must not roll
 * it back or surface an error to the customer.
 *
 * Env vars (same as the reminder action, documented in the runbook):
 *   - `RESEND_API_KEY`
 *   - `EMAIL_FROM` (or `RESEND_FROM`)
 * When unset the action no-ops with a console warning (fail-open on the
 * notification, never on the underlying change).
 */

import type { GenericActionCtx } from "convex/server";
import { actionGeneric } from "convex/server";
import { v } from "convex/values";

import schema from "../schema";
import type { DataModelFromSchemaDefinition } from "convex/server";
import { sendViaResend } from "./sendEmailReminder";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const send = actionGeneric({
  args: {
    previousEmail: v.string(),
    newEmail: v.string(),
    customerName: v.string(),
  },
  handler: async (
    _ctx: ActionCtx,
    args: { previousEmail: string; newEmail: string; customerName: string },
  ): Promise<{ sent: boolean }> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Internal notification action scheduled from updateCustomerContact AFTER its requireRole(["customer"]) gate; no user context exists at the action layer.
    const creds = readResendCredentials();
    if (creds === null) {
      console.warn(
        "[sendAccountEmailChanged] Resend not configured — skipping notification",
      );
      return { sent: false };
    }
    const subject =
      "Your Apostle Paul Memorial Park portal email was changed";
    const name = args.customerName.trim().length > 0
      ? args.customerName
      : "there";
    const text =
      `Hi ${name},\n\n` +
      `The email address on your Apostle Paul Memorial Park owner-portal ` +
      `account was just changed to ${args.newEmail}.\n\n` +
      `If you made this change, no action is needed — you'll sign in with ` +
      `your new address from now on.\n\n` +
      `If you did NOT make this change, please contact the cemetery office ` +
      `immediately.`;
    const html =
      `<p>Hi ${escapeHtml(name)},</p>` +
      `<p>The email address on your Apostle Paul Memorial Park owner-portal ` +
      `account was just changed to <strong>${escapeHtml(args.newEmail)}</strong>.</p>` +
      `<p>If you made this change, no action is needed — you'll sign in with ` +
      `your new address from now on.</p>` +
      `<p>If you did <strong>not</strong> make this change, please contact ` +
      `the cemetery office immediately.</p>`;
    try {
      const result = await sendViaResend({
        apiKey: creds.apiKey,
        from: creds.from,
        to: args.previousEmail,
        subject,
        text,
        html,
      });
      if (result.kind !== "ok") {
        console.warn("[sendAccountEmailChanged] non-ok send outcome", {
          kind: result.kind,
        });
        return { sent: false };
      }
      return { sent: true };
    } catch (e) {
      console.warn("[sendAccountEmailChanged] exception during send", {
        message: e instanceof Error ? e.message : String(e),
      });
      return { sent: false };
    }
  },
});
