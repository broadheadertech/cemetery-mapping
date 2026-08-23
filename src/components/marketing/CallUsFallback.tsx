"use client";

/**
 * "Call us instead" — the fallback shown when an enquiry cannot be
 * submitted, and offered alongside both forms as a standing
 * alternative.
 *
 * This exists because of what the forms used to do. They accepted a
 * grieving family's details, discarded them, and displayed "a care
 * director will call within the working day." The forms now genuinely
 * submit — but a form can still fail, and on a bereavement page the
 * failure state has to leave the person with a way through rather than
 * an apology. A phone number that someone answers is that way through.
 *
 * The number itself lives in `contact-details.ts`, which carries the
 * warning that it is not yet confirmed by the cemetery.
 */

import { Phone } from "lucide-react";

import {
  CEMETERY_OFFICE_HOURS,
  CEMETERY_PHONE_DISPLAY,
  CEMETERY_PHONE_HREF,
} from "./contact-details";

export function CallUsFallback({
  lead = "You can also reach us by phone.",
}: {
  lead?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm leading-relaxed text-text-muted">{lead}</p>
      <a
        href={CEMETERY_PHONE_HREF}
        className="inline-flex items-center gap-2 font-display text-xl font-light text-text-default underline decoration-accent-gold underline-offset-4 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Phone size={16} aria-hidden />
        {CEMETERY_PHONE_DISPLAY}
      </a>
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
        {CEMETERY_OFFICE_HOURS}
      </p>
    </div>
  );
}

/**
 * Inline error panel for a failed submission. Deliberately does NOT
 * look like the thank-you state — the whole point is that the visitor
 * can tell the difference.
 */
export function EnquiryErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="enquiry-error"
      className="border-l-[3px] border-l-destructive bg-surface-muted p-5"
    >
      <h3 className="font-display text-xl font-light text-text-default">
        We could not send that.
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-text-muted">{message}</p>
      <div className="mt-4">
        <CallUsFallback lead="Please try again, or call us directly — we would rather hear from you than have you wait." />
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded border border-surface-border bg-surface-base px-4 py-2 text-sm font-medium text-text-default transition-colors hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Try again
      </button>
    </div>
  );
}
