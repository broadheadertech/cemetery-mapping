/**
 * Reminder template registry — Stories 9.7 (SMS) + 9.8 (email).
 *
 * Pure rendering helpers. No database reads, no provider calls. The
 * scan stores `templateKey` on the `reminderDeliveries` row; the
 * action (`sendSmsReminder` / `sendEmailReminder`) resolves the key
 * via `renderSmsBody` / `renderEmailBody` here to produce the final
 * SMS body / email subject + body at send time.
 *
 * Why a single file for both channels: the cadence rules in
 * `reminderConfig` are channel-agnostic. A `channel: "both"` rule
 * pairs an SMS templateKey with the equivalent `_email` sibling — the
 * scan resolves both keys from the same rule entry. Keeping the
 * templates side-by-side makes drift between the two surfaces
 * obvious in code review.
 *
 * PII discipline (Stories 9.7 § 198–199, 9.8 § 197–203):
 *   - SMS bodies include ONLY name + amount + lot code. No gov ID, no
 *     address, no email. Body length stays under 160 characters where
 *     possible (single Twilio segment).
 *   - Email subjects are GENERIC — no PII (no customer name, no
 *     amount). The subject line is visible to anyone shoulder-surfing
 *     the recipient's inbox; the body is the appropriate disclosure
 *     boundary.
 *   - Email bodies include the same fields as SMS plus the portal
 *     URL and an unsubscribe footer (deliverability hygiene
 *     requirement). No gov ID, no full address.
 *
 * No new dependency: rendering is plain string concatenation. A
 * Mustache-style helper is overkill for the < 10 templates this
 * registry will ever hold.
 */

export type SmsTemplateKey =
  | "upcoming_due_3d"
  | "due_today"
  | "overdue_7d";

export type EmailTemplateKey =
  | "upcoming_due_3d_email"
  | "due_today_email"
  | "overdue_7d_email";

export type AnyTemplateKey = SmsTemplateKey | EmailTemplateKey;

/**
 * Shared substitution context. The scan derives every field from the
 * delivery row + the hydrated customer / contract / lot documents and
 * passes a frozen object to the renderer. Renderers never mutate.
 */
export interface ReminderTemplateContext {
  /** Customer's `fullName`. */
  customerName: string;
  /** Outstanding installment principal in centavos. */
  amountCents: number;
  /** Lot's `code` (e.g. "A-12-3"). */
  lotCode: string;
  /** Due-date epoch ms (Manila midnight). */
  dueDateMs: number;
  /** Portal base URL (e.g. "https://portal.cemetery.ph"). */
  portalUrl: string;
}

/**
 * SMS rendering — channel: "sms" delivery rows. Always returns a single
 * plain-text string. Targets < 160 chars where possible (single
 * Twilio-billed segment); longer messages are concatenated by the
 * carrier transparently.
 */
export function renderSmsBody(
  key: SmsTemplateKey,
  ctx: ReminderTemplateContext,
): string {
  const peso = formatPeso(ctx.amountCents);
  const date = formatManilaDate(ctx.dueDateMs);
  switch (key) {
    case "upcoming_due_3d":
      return `Dear ${ctx.customerName}, your contribution of ${peso} for lot ${ctx.lotCode} at Apostle Paul Memorial Park rests due ${date}. The Estate Office welcomes your settlement: ${ctx.portalUrl}`;
    case "due_today":
      return `Dear ${ctx.customerName}, a gentle reminder — the installment of ${peso} for lot ${ctx.lotCode} is due today. The Estate Office is at hand: ${ctx.portalUrl}`;
    case "overdue_7d":
      return `Dear ${ctx.customerName}, the installment of ${peso} for lot ${ctx.lotCode} due ${date} remains unsettled. The estate continues to hold your place. Please settle at: ${ctx.portalUrl}`;
  }
}

/**
 * Email rendering — channel: "email" delivery rows. Returns subject +
 * plain-text + HTML bodies. The subject is GENERIC (no PII per Story
 * 9.8 § 199); the body carries the personalised content.
 *
 * HTML is a simple table-based layout for email-client compatibility
 * (no MJML / react-email). The plain-text body is the fallback for
 * clients that don't render HTML.
 */
export interface RenderedEmail {
  subject: string;
  bodyPlain: string;
  bodyHtml: string;
}

export function renderEmail(
  key: EmailTemplateKey,
  ctx: ReminderTemplateContext,
): RenderedEmail {
  const peso = formatPeso(ctx.amountCents);
  const date = formatManilaDate(ctx.dueDateMs);
  const footerPlain = renderFooterPlain(ctx.portalUrl);
  const footerHtml = renderFooterHtml(ctx.portalUrl);

  switch (key) {
    case "upcoming_due_3d_email": {
      const subject = "A gentle reminder from the Estate Office";
      const bodyPlain =
        `Dear ${ctx.customerName},\n\n` +
        `Your contribution of ${peso} for the lot at Apostle Paul Memorial Park rests due on ${date}. The estate continues to hold this ground for your loved one, and your settlement is welcomed at your convenience.\n\n` +
        `The Estate Office: ${ctx.portalUrl}\n\n` +
        footerPlain;
      const bodyHtml = renderEmailHtml({
        heading: "A gentle reminder",
        salutation: `Dear ${ctx.customerName},`,
        paragraphs: [
          `Your contribution of <strong>${peso}</strong> for the lot <strong>${escapeHtml(ctx.lotCode)}</strong> at Apostle Paul Memorial Park rests due on <strong>${escapeHtml(date)}</strong>.`,
          `The estate continues to hold this ground in remembrance. Your settlement is welcomed at your convenience.`,
        ],
        portalUrl: ctx.portalUrl,
        footerHtml,
      });
      return { subject, bodyPlain, bodyHtml };
    }
    case "due_today_email": {
      const subject = "On your installment from the Estate Office";
      const bodyPlain =
        `Dear ${ctx.customerName},\n\n` +
        `A gentle reminder — the installment of ${peso} for the lot ${ctx.lotCode} at Apostle Paul Memorial Park is due today (${date}). The Estate Office is at hand should you wish to settle.\n\n` +
        `The Estate Office: ${ctx.portalUrl}\n\n` +
        footerPlain;
      const bodyHtml = renderEmailHtml({
        heading: "A gentle reminder",
        salutation: `Dear ${ctx.customerName},`,
        paragraphs: [
          `The installment of <strong>${peso}</strong> for the lot <strong>${escapeHtml(ctx.lotCode)}</strong> at Apostle Paul Memorial Park is due today, ${escapeHtml(date)}.`,
          `The Estate Office is at hand should you wish to settle.`,
        ],
        portalUrl: ctx.portalUrl,
        footerHtml,
      });
      return { subject, bodyPlain, bodyHtml };
    }
    case "overdue_7d_email": {
      const subject = "From Apostle Paul Memorial Park · Cases Land Inc.";
      const bodyPlain =
        `Dear ${ctx.customerName},\n\n` +
        `We note the installment of ${peso} for the lot ${ctx.lotCode}, due on ${date}, remains unsettled. The estate continues to hold your place in quiet remembrance, and we welcome your settlement at your convenience.\n\n` +
        `The Estate Office: ${ctx.portalUrl}\n\n` +
        footerPlain;
      const bodyHtml = renderEmailHtml({
        heading: "From the Estate Office",
        salutation: `Dear ${ctx.customerName},`,
        paragraphs: [
          `We note the installment of <strong>${peso}</strong> for the lot <strong>${escapeHtml(ctx.lotCode)}</strong>, due on <strong>${escapeHtml(date)}</strong>, remains unsettled.`,
          `The estate continues to hold your place in quiet remembrance. Your settlement is welcomed at your convenience.`,
        ],
        portalUrl: ctx.portalUrl,
        footerHtml,
      });
      return { subject, bodyPlain, bodyHtml };
    }
  }
}

/**
 * Pair an SMS template key with its email sibling. The scan uses this
 * for `channel: "both"` rules so a single `templateKey` on the rule
 * resolves to the correct per-channel template.
 *
 * Returns `null` when no sibling exists (defensive — Phase 1 wires
 * the three canonical pairs; any future SMS-only / email-only template
 * key returns `null` and the scan logs a warning).
 */
export function emailKeyForSmsKey(
  smsKey: SmsTemplateKey,
): EmailTemplateKey | null {
  switch (smsKey) {
    case "upcoming_due_3d":
      return "upcoming_due_3d_email";
    case "due_today":
      return "due_today_email";
    case "overdue_7d":
      return "overdue_7d_email";
  }
}

/**
 * Runtime template-key validation — confirms a string is one of the
 * known SMS template keys. Used by the action when reading
 * `reminderDeliveries.templateKey` (which is `v.string()` on the
 * schema for forward compat with admin-added templates).
 */
export function isSmsTemplateKey(s: string): s is SmsTemplateKey {
  return s === "upcoming_due_3d" || s === "due_today" || s === "overdue_7d";
}

/**
 * Runtime template-key validation — confirms a string is one of the
 * known email template keys.
 */
export function isEmailTemplateKey(s: string): s is EmailTemplateKey {
  return (
    s === "upcoming_due_3d_email" ||
    s === "due_today_email" ||
    s === "overdue_7d_email"
  );
}

/**
 * Formats integer centavos as a Philippine-peso display string.
 * Mirrors the convention in `convex/actions/sendEmailReminders.ts`
 * (the existing Phase 1 stub). Local — does not import
 * `convex/lib/money.ts` to keep the reminder template surface
 * self-contained.
 */
export function formatPeso(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₱${wholeStr}.${frac.toString().padStart(2, "0")}`;
}

/**
 * Formats a Manila-midnight epoch ms as `YYYY-MM-DD`. ISO-8601 keeps
 * the body locale-neutral and ordering deterministic.
 */
export function formatManilaDate(epochMs: number): string {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = new Date(epochMs + MANILA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = (shifted.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = shifted.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Plain-text email footer — deliverability hygiene + customer
 * relations expectation per Story 9.8 § 200–203.
 */
function renderFooterPlain(portalUrl: string): string {
  return (
    `With reverence,\n` +
    `The Estate Office\n` +
    `Apostle Paul Memorial Park · Cases Land Inc.\n` +
    `Zone 1, San Eugenio, Aringay, La Union 2503, Philippines\n\n` +
    `You receive this note because the estate holds a contract in your name. ` +
    `You may adjust how the estate reaches you here: ` +
    `${portalUrl}/portal/account`
  );
}

/**
 * HTML email footer. Mirrors the plain-text content with safe escaping
 * for the URL (portalUrl comes from env so we still escape for
 * defensive defense-in-depth).
 */
function renderFooterHtml(portalUrl: string): string {
  const safe = escapeHtml(portalUrl);
  return (
    `<p style="margin:24px 0 4px 0;">With reverence,<br/>The Estate Office</p>` +
    `<p style="font-size:12px;color:#666;margin:4px 0 16px 0;">` +
    `Apostle Paul Memorial Park · Cases Land Inc.<br/>` +
    `Zone 1, San Eugenio, Aringay, La Union 2503, Philippines` +
    `</p>` +
    `<p style="font-size:12px;color:#666;margin-top:8px;">` +
    `You receive this note because the estate holds a contract in your name. ` +
    `<a href="${safe}/portal/account" style="color:#666;">Adjust how the estate reaches you</a>.` +
    `</p>`
  );
}

/**
 * Renders the canonical HTML email layout — simple table-based layout
 * for email-client compatibility. No external CSS; all styles inline.
 */
function renderEmailHtml(args: {
  heading: string;
  salutation: string;
  paragraphs: string[];
  portalUrl: string;
  footerHtml: string;
}): string {
  const paragraphsHtml = args.paragraphs
    .map((p) => `<p style="margin:0 0 12px 0;">${p}</p>`)
    .join("");
  const portalSafe = escapeHtml(args.portalUrl);
  return (
    `<!DOCTYPE html>` +
    `<html><head><meta charset="utf-8" /></head>` +
    `<body style="font-family:Arial,sans-serif;color:#222;padding:16px;">` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;">` +
    `<tr><td>` +
    `<h2 style="font-size:18px;margin:0 0 16px 0;">${escapeHtml(args.heading)}</h2>` +
    `<p style="margin:0 0 12px 0;">${escapeHtml(args.salutation)}</p>` +
    paragraphsHtml +
    `<p style="margin:16px 0;"><a href="${portalSafe}" ` +
    `style="display:inline-block;background:#0a7;color:#fff;padding:10px 16px;` +
    `border-radius:4px;text-decoration:none;">Settle through the Estate Office</a></p>` +
    args.footerHtml +
    `</td></tr>` +
    `</table>` +
    `</body></html>`
  );
}

/**
 * Minimal HTML escape — sufficient for substitution into the inline
 * email template above. Email clients are notoriously tolerant of
 * malformed HTML; defensive escaping keeps content from breaking
 * layout if a customer's name or a lot code contains `<` / `>` / `&`.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
