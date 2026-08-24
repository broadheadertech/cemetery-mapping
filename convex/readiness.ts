/**
 * Go-live readiness — what is configured, reported by the system itself.
 *
 * `docs/go-live-checklist.md` is the human list of what stands between
 * this deployment and taking real money. The trouble with a document
 * is that it goes stale the moment someone sets a variable, and
 * checking the real state meant a developer at a terminal running
 * `npx convex env list`. That is precisely the dependency the rest of
 * this work has been removing.
 *
 * So this query asks the deployment the same questions the checklist
 * asks a person, and `/admin/readiness` renders the answers.
 *
 * ## Rules this file obeys
 *
 *   1. **Presence, never values.** Every environment check returns a
 *      boolean. A readiness page that printed the API key it found
 *      would be a worse problem than the one it solves.
 *   2. **Honest about what it cannot see.** Convex scheduled backups
 *      are a dashboard setting with no queryable surface, so this
 *      reports "unverifiable from here" rather than inventing a green
 *      tick. Same for anything else that needs a human to look.
 *   3. **Blocking is a claim about consequence.** An item is blocking
 *      only when the cemetery genuinely cannot operate without it —
 *      money cannot move, or a legal obligation is unmet. Everything
 *      else is a warning. Marking things blocking that are not trains
 *      people to ignore the page.
 *
 * Admin only: the shape of what is unconfigured is a map of where the
 * system is soft.
 */

import { queryGeneric } from "convex/server";

import { requireRole, type QueryCtx } from "./lib/auth";
import { resolveGatewayCredentials } from "./lib/gatewayCredentials";
import { type GatewayId } from "./lib/paymentGateways/types";

export type ReadinessStatus = "ready" | "warning" | "blocking" | "unknown";

export interface ReadinessCheck {
  id: string;
  /** Grouping for the page: what part of the system this concerns. */
  area:
    | "payments"
    | "compliance"
    | "communications"
    | "data"
    | "operations";
  label: string;
  status: ReadinessStatus;
  /** What is true right now. */
  detail: string;
  /** What to do about it, when it is not ready. */
  action?: string;
  /** Where to go — an in-app route, when there is one. */
  href?: string;
}

export interface ReadinessReport {
  checks: ReadinessCheck[];
  summary: {
    blocking: number;
    warning: number;
    unknown: number;
    ready: number;
  };
}

/** Presence of an environment variable. Never its value. */
function envSet(name: string): boolean {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (env === undefined) return false;
  const raw = env[name];
  return typeof raw === "string" && raw.trim().length > 0;
}

const GATEWAYS: readonly GatewayId[] = ["gcash", "maya", "card"];
const GATEWAY_LABELS: Record<GatewayId, string> = {
  gcash: "GCash",
  maya: "Maya",
  card: "Card processor",
};

export const getReadinessReport = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<ReadinessReport> => {
    await requireRole(ctx, ["admin"]);
    const checks: ReadinessCheck[] = [];

    // ---- Payments ---------------------------------------------------
    let anyGatewayLive = false;
    for (const gateway of GATEWAYS) {
      const credentials = await resolveGatewayCredentials(ctx, gateway);
      const configured =
        credentials.apiBaseUrl.length > 0 && credentials.apiKey.length > 0;
      const live = configured && credentials.isEnabled;
      if (live) anyGatewayLive = true;

      checks.push({
        id: `gateway-${gateway}`,
        area: "payments",
        label: `${GATEWAY_LABELS[gateway]} credentials`,
        // Not blocking individually — a cemetery may deliberately offer
        // only one online method. The aggregate check below is the one
        // that speaks to "can we take an online payment at all".
        status: live ? "ready" : "warning",
        detail: live
          ? `Configured (${credentials.source === "env" ? "environment" : "admin page"}, ${credentials.mode}) and switched on.`
          : configured
            ? "Credentials are set but the gateway is switched off."
            : "No API base URL or key.",
        action: live
          ? undefined
          : "Set the merchant credentials and switch it on.",
        href: "/admin/settings/payment-gateways",
      });

      // A gateway that can create intents but cannot verify callbacks
      // is the worst configuration in the system: customers pay and
      // nothing lands, silently, until someone asks about a receipt.
      if (live && credentials.webhookSecret.length === 0) {
        checks.push({
          id: `gateway-${gateway}-webhook`,
          area: "payments",
          label: `${GATEWAY_LABELS[gateway]} webhook secret`,
          status: "blocking",
          detail:
            "The gateway is switched on but has no webhook signing secret, so every payment confirmation is being rejected. Customers can pay and the payment will not be recorded.",
          action:
            "Add the signing secret from the provider's dashboard, then ask them to replay any missed events.",
          href: "/admin/settings/payment-gateways",
        });
      }
    }

    checks.push({
      id: "gateway-any",
      area: "payments",
      label: "Online payments",
      status: anyGatewayLive ? "ready" : "blocking",
      detail: anyGatewayLive
        ? "At least one gateway is configured and switched on."
        : "No payment gateway is live, so the customer portal cannot take a payment.",
      action: anyGatewayLive
        ? undefined
        : "Configure at least one gateway, or accept that Phase 1 is cash and manual payments only.",
      href: "/admin/settings/payment-gateways",
    });

    // ---- Compliance -------------------------------------------------
    const bir = await ctx.db.query("birReceiptConfig").first();
    checks.push({
      id: "bir-config",
      area: "compliance",
      label: "BIR receipt details",
      status: bir === null || bir.isPlaceholder ? "blocking" : "ready",
      detail:
        bir === null
          ? "No receipt configuration exists."
          : bir.isPlaceholder
            ? "Still in placeholder mode. The receipt PDF action refuses to render, so no receipt can be issued."
            : `Production-ready — TIN and ATP ${bir.atpNumber} recorded.`,
      action:
        bir === null || bir.isPlaceholder
          ? "Enter the cemetery's registered name, TIN, address, and ATP reference, and have the accountant sign off the PDF."
          : undefined,
      href: "/admin/settings/bir-receipt-config",
    });

    if (bir !== null && !bir.isPlaceholder) {
      // An expired ATP invalidates the receipts issued under it.
      const daysToExpiry = Math.floor(
        (bir.atpExpiryDate - Date.now()) / (24 * 60 * 60 * 1000),
      );
      if (daysToExpiry < 60) {
        checks.push({
          id: "bir-atp-expiry",
          area: "compliance",
          label: "ATP expiry",
          status: daysToExpiry < 0 ? "blocking" : "warning",
          detail:
            daysToExpiry < 0
              ? `The Authority to Print expired ${Math.abs(daysToExpiry)} days ago.`
              : `The Authority to Print expires in ${daysToExpiry} days.`,
          action: "Renew the ATP with the BIR and update the configuration.",
          href: "/admin/settings/bir-receipt-config",
        });
      }
    }

    const care = await ctx.db.query("perpetualCarePolicy").first();
    checks.push({
      id: "perpetual-care",
      area: "compliance",
      label: "Perpetual care policy",
      status: care === null || care.isPlaceholder ? "blocking" : "ready",
      detail:
        care === null
          ? "No policy exists."
          : care.isPlaceholder
            ? "Still in placeholder mode, which blocks new sales."
            : `Confirmed — ${care.type.replace("_", " ")}.`,
      action:
        care === null || care.isPlaceholder
          ? "Confirm the fee structure with the cemetery and clear the placeholder flag."
          : undefined,
      href: "/admin/settings/perpetual-care",
    });

    const archiveVars = [
      "ARCHIVE_S3_BUCKET",
      "ARCHIVE_S3_REGION",
      "ARCHIVE_S3_ACCESS_KEY",
      "ARCHIVE_S3_SECRET_KEY",
    ];
    const archiveMissing = archiveVars.filter((n) => !envSet(n));
    checks.push({
      id: "archival-export",
      area: "compliance",
      label: "BIR archival export (10-year retention)",
      status: archiveMissing.length === 0 ? "ready" : "blocking",
      detail:
        archiveMissing.length === 0
          ? "S3 destination configured."
          : `Not configured — missing ${archiveMissing.join(", ")}. The monthly export cannot run, and the 10-year retention obligation is unmet.`,
      action:
        archiveMissing.length === 0
          ? undefined
          : "Create the bucket with the 10-year lifecycle policy and set the variables (runbook § Archival exports).",
    });

    // ---- Communications ---------------------------------------------
    const emailReady = envSet("RESEND_API_KEY") &&
      (envSet("EMAIL_FROM") || envSet("RESEND_FROM"));
    checks.push({
      id: "email-provider",
      area: "communications",
      label: "Email provider",
      status: emailReady ? "ready" : "blocking",
      detail: emailReady
        ? "Resend credentials are set."
        : "No Resend credentials. Nothing sends: no payment reminders, no emailed receipts, no enquiry notifications.",
      action: emailReady
        ? undefined
        : "Set RESEND_API_KEY and EMAIL_FROM on the deployment.",
    });

    checks.push({
      id: "portal-url",
      area: "communications",
      label: "Portal URL",
      status: envSet("PORTAL_URL") ? "ready" : "warning",
      detail: envSet("PORTAL_URL")
        ? "Set — reminder emails link to the real portal."
        : "Not set. Reminder emails fall back to https://portal.example.ph, so every link in them is dead.",
      action: envSet("PORTAL_URL")
        ? undefined
        : "Set PORTAL_URL to the customer portal's public address.",
    });

    checks.push({
      id: "enquiry-notify",
      area: "communications",
      label: "Enquiry notifications",
      status: envSet("ENQUIRY_NOTIFY_TO") ? "ready" : "warning",
      detail: envSet("ENQUIRY_NOTIFY_TO")
        ? "The office inbox is set."
        : "Not set. Website enquiries are saved and visible in the queue, but nobody is emailed about them.",
      action: envSet("ENQUIRY_NOTIFY_TO")
        ? undefined
        : "Set ENQUIRY_NOTIFY_TO to the office inbox.",
      href: "/enquiries",
    });

    checks.push({
      id: "email-bounce-secret",
      area: "communications",
      label: "Email bounce webhook",
      status: envSet("EMAIL_WEBHOOK_SECRET") ? "ready" : "warning",
      detail: envSet("EMAIL_WEBHOOK_SECRET")
        ? "Bounce events are accepted."
        : "Not set, so all bounce events are rejected and hard-bounced addresses keep being emailed.",
      action: envSet("EMAIL_WEBHOOK_SECRET")
        ? undefined
        : "Set EMAIL_WEBHOOK_SECRET and register the endpoint with the provider.",
    });

    // ---- Data --------------------------------------------------------
    // Bounded read: we only need to know whether the inventory looks
    // like a demo or a real cemetery, not the exact count.
    const lotSample = await ctx.db.query("lots").take(201);
    checks.push({
      id: "lot-inventory",
      area: "data",
      label: "Lot inventory",
      status: lotSample.length >= 200 ? "ready" : "warning",
      detail:
        lotSample.length === 0
          ? "No lots exist."
          : lotSample.length >= 200
            ? "200+ lots loaded."
            : `Only ${lotSample.length} lots. The cemetery has roughly 2,000, so this looks like demo or pilot data.`,
      action:
        lotSample.length >= 200
          ? undefined
          : "Import the inventory in section-sized batches and verify each with the office.",
      href: "/admin/lot-import",
    });

    // ---- Operations ---------------------------------------------------
    const unresolvedErrors = await ctx.db
      .query("errorLog")
      .withIndex("by_resolved_lastSeen", (q) => q.eq("isResolved", false))
      .take(50);
    checks.push({
      id: "error-log",
      area: "operations",
      label: "Unresolved errors",
      status: unresolvedErrors.length === 0 ? "ready" : "warning",
      detail:
        unresolvedErrors.length === 0
          ? "Nothing unresolved."
          : `${unresolvedErrors.length}${unresolvedErrors.length === 50 ? "+" : ""} unresolved.`,
      action:
        unresolvedErrors.length === 0 ? undefined : "Review the error log.",
      href: "/admin/errors",
    });

    const waitingEnquiries = await ctx.db
      .query("enquiries")
      .withIndex("by_status_createdAt", (q) => q.eq("status", "new"))
      .take(50);
    checks.push({
      id: "enquiry-queue",
      area: "operations",
      label: "Enquiries awaiting a call",
      status: waitingEnquiries.length === 0 ? "ready" : "warning",
      detail:
        waitingEnquiries.length === 0
          ? "Nobody is waiting."
          : `${waitingEnquiries.length}${waitingEnquiries.length === 50 ? "+" : ""} people were told we would contact them.`,
      action:
        waitingEnquiries.length === 0 ? undefined : "Work the enquiry queue.",
      href: "/enquiries",
    });

    // Deliberately "unknown": Convex scheduled backups are a dashboard
    // setting with no queryable surface. Reporting a green tick we
    // cannot substantiate would make this whole page untrustworthy —
    // and backups are exactly the thing nobody discovers is broken
    // until the day it matters.
    checks.push({
      id: "backups",
      area: "operations",
      label: "Database backups",
      status: "unknown",
      detail:
        "Cannot be checked from inside the app — Convex scheduled backups are a dashboard setting. There is also no restore drill on record, so the documented recovery procedure is specification rather than practice.",
      action:
        "Confirm scheduled backups are enabled in the Convex dashboard, then run one restore drill and record it in docs/restore-drill-log.md.",
    });

    const summary = checks.reduce(
      (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
      { blocking: 0, warning: 0, unknown: 0, ready: 0 },
    );

    return { checks, summary };
  },
});
