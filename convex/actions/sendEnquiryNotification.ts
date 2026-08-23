"use node";

/**
 * Staff notification for a public enquiry.
 *
 * Scheduled fire-and-forget by `enquiries.submitEnquiry` after the row
 * commits. The visitor's form never waits on Resend, and a provider
 * outage delays the email rather than losing the enquiry — the row is
 * the system of record and sits in the staff queue regardless.
 *
 * Failure posture, which is the interesting part:
 *
 *   The old behaviour this replaces was a form that silently threw the
 *   visitor's details away. Replacing it with a notification that can
 *   also fail silently would be the same defect wearing a better
 *   costume. So every failure path here does two things: marks the
 *   enquiry `notifyFailedAt` (so the queue shows "nobody was emailed
 *   about this") and records an entry in the error log (so
 *   /admin/errors says enquiries are arriving and notifications are
 *   not going out).
 *
 *   That includes the not-configured case. A missing
 *   `ENQUIRY_NOTIFY_TO` or `RESEND_API_KEY` is not a benign no-op when
 *   the consequence is a bereaved family waiting for a call — it is
 *   the exact production misconfiguration the error log exists to
 *   surface.
 *
 * Env vars (documented in the runbook):
 *   - `ENQUIRY_NOTIFY_TO` — the office inbox that should hear about
 *     new enquiries. No default: guessing an address means guessing
 *     wrong silently.
 *   - `RESEND_API_KEY`, `EMAIL_FROM` (or `RESEND_FROM`) — as for every
 *     other outbound mail.
 */

import type { GenericActionCtx } from "convex/server";
import { actionGeneric, makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import schema from "../schema";
import type { DataModelFromSchemaDefinition } from "convex/server";
import { sendViaResend } from "./sendEmailReminder";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ActionCtx = GenericActionCtx<DataModel>;
type EnquiryId = DataModel["enquiries"]["document"]["_id"];

interface EnquiryView {
  id: EnquiryId;
  kind: "visit" | "pricing";
  name: string;
  contact: string;
  preferredDate: string | null;
  preferredTime: string | null;
  purpose: string | null;
  lotTypeInterest: string | null;
  timing: string | null;
  notes: string | null;
  createdAt: number;
}

const getEnquiryRef = makeFunctionReference<
  "query",
  { enquiryId: EnquiryId },
  EnquiryView | null
>("enquiries:internal_getEnquiryForNotify");

const markNotifyFailedRef = makeFunctionReference<
  "mutation",
  { enquiryId: EnquiryId },
  null
>("enquiries:internal_markNotifyFailed");

const captureErrorRef = makeFunctionReference<
  "mutation",
  {
    source: string;
    message: string;
    severity?: "error" | "warning";
    context?: Record<string, unknown>;
  },
  null
>("errorLog:internal_captureError");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readEnv(name: string): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (env === undefined) return undefined;
  const raw = env[name];
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

/** Label lines that are present; skip the ones the visitor left blank. */
function detailLines(e: EnquiryView): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ["Name", e.name],
    ["Reach them at", e.contact],
  ];
  if (e.preferredDate !== null) out.push(["Preferred day", e.preferredDate]);
  if (e.preferredTime !== null) out.push(["Preferred time", e.preferredTime]);
  if (e.purpose !== null) out.push(["Purpose", e.purpose]);
  if (e.lotTypeInterest !== null) {
    out.push(["Lot type", e.lotTypeInterest]);
  }
  if (e.timing !== null) out.push(["Timing", e.timing]);
  if (e.notes !== null) out.push(["Notes", e.notes]);
  return out;
}

export default actionGeneric({
  args: { enquiryId: v.id("enquiries") },
  handler: async (
    ctx: ActionCtx,
    args: { enquiryId: EnquiryId },
  ): Promise<{ sent: boolean }> => {
    // eslint-disable-next-line local-rules/require-role-first-line -- Scheduled internal action; no user context exists at the action layer. The enquiry it notifies about was written by a deliberately public mutation whose bound is documented in convex/enquiries.ts.
    const enquiry = await ctx.runQuery(getEnquiryRef, {
      enquiryId: args.enquiryId,
    });

    const fail = async (
      message: string,
      context?: Record<string, unknown>,
    ): Promise<{ sent: boolean }> => {
      try {
        await ctx.runMutation(markNotifyFailedRef, {
          enquiryId: args.enquiryId,
        });
      } catch {
        // The error-log entry below is the remaining signal.
      }
      try {
        await ctx.runMutation(captureErrorRef, {
          source: "action:sendEnquiryNotification",
          message,
          severity: "error",
          ...(context === undefined ? {} : { context }),
        });
      } catch {
        console.error("[sendEnquiryNotification]", message);
      }
      return { sent: false };
    };

    if (enquiry === null) {
      // Nothing to mark — the row is gone. Log only.
      try {
        await ctx.runMutation(captureErrorRef, {
          source: "action:sendEnquiryNotification",
          message:
            "Scheduled a notification for an enquiry that no longer exists.",
          severity: "warning",
        });
      } catch {
        /* nothing left to do */
      }
      return { sent: false };
    }

    const to = readEnv("ENQUIRY_NOTIFY_TO");
    if (to === undefined) {
      return await fail(
        "ENQUIRY_NOTIFY_TO is not set — enquiries from the website are arriving but nobody is being emailed about them. They are still queued at /enquiries.",
      );
    }

    const apiKey = readEnv("RESEND_API_KEY");
    const from = readEnv("EMAIL_FROM") ?? readEnv("RESEND_FROM");
    if (apiKey === undefined || from === undefined) {
      return await fail(
        "Resend is not configured (RESEND_API_KEY / EMAIL_FROM) — website enquiries are queued but no notification email can be sent.",
      );
    }

    const kindLabel =
      enquiry.kind === "visit" ? "visit request" : "pricing enquiry";
    const subject = `New ${kindLabel} — ${enquiry.name}`;
    const rows = detailLines(enquiry);

    const text = [
      `A new ${kindLabel} came in through the website.`,
      "",
      ...rows.map(([label, value]) => `${label}: ${value}`),
      "",
      "Open the queue to mark it contacted: /enquiries",
    ].join("\n");

    const html = [
      `<p>A new ${escapeHtml(kindLabel)} came in through the website.</p>`,
      "<table cellpadding=\"6\" style=\"border-collapse:collapse\">",
      ...rows.map(
        ([label, value]) =>
          `<tr><td style="vertical-align:top"><strong>${escapeHtml(
            label,
          )}</strong></td><td style="vertical-align:top">${escapeHtml(
            value,
          )}</td></tr>`,
      ),
      "</table>",
      "<p>Open the queue to mark it contacted: /enquiries</p>",
    ].join("");

    const result = await sendViaResend({
      apiKey,
      from,
      to,
      subject,
      text,
      html,
    });

    if (result.kind !== "ok") {
      // `transient` vs `permanent` both land here. There is no retry
      // schedule for this notification — the enquiry is already in the
      // queue and a duplicate email hours later helps nobody — so the
      // distinction only shapes the message an operator reads.
      return await fail(
        `Could not email the office about a website ${kindLabel} (${result.kind}): ${result.error}`,
        { enquiryKind: enquiry.kind, failureKind: result.kind },
      );
    }

    return { sent: true };
  },
});
