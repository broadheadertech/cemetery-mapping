"use client";

import { ArrowRight } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { CallUsFallback, EnquiryErrorPanel } from "./CallUsFallback";
import { useEnquirySubmit } from "./useEnquirySubmit";

/**
 * Schedule-a-visit form.
 *
 * This used to call `setSent(true)` and throw the visitor's details
 * away while telling them "a care director will call within the
 * working day" — a promise nothing in the system could keep. It now
 * writes an `enquiries` row through `enquiries:submitEnquiry` and
 * schedules a staff notification.
 *
 * Two rules the old version broke, worth keeping in view for anyone
 * editing this:
 *
 *   1. The thank-you renders ONLY after the mutation resolves. A
 *      failure shows the failure and the phone number, never a
 *      thank-you.
 *   2. The success copy promises only what the system delivers. Staff
 *      get an email and a queue entry; that supports "we have your
 *      request and will call to confirm". It does not support a
 *      guaranteed time window, so the copy no longer states one.
 */
export function ScheduleVisitForm() {
  const { state, onSubmit, reset } = useEnquirySubmit("visit");

  if (state.kind === "sent") {
    return (
      <div className="border-t-[3px] border-accent-gold bg-surface-base p-8 text-center sm:p-10">
        <div className="mx-auto flex flex-col items-center">
          <BrandMark size={80} />
          <h3 className="mt-5 font-display text-2xl font-light leading-tight text-text-default">
            We have your request.
          </h3>
          <p className="mt-3 max-w-sm text-base leading-relaxed text-text-muted">
            A care director will call to confirm your visit. There is no
            preparation needed — come as you are.
          </p>
          <div className="mt-6">
            <CallUsFallback lead="If you would rather not wait:" />
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return <EnquiryErrorPanel message={state.message} onRetry={reset} />;
  }

  const sending = state.kind === "sending";

  return (
    <form
      onSubmit={onSubmit}
      className="border-t-[3px] border-accent-gold bg-surface-base p-7 sm:p-8"
    >
      <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
        Schedule a visit
      </div>
      <h3 className="mt-4 font-display text-2xl font-light leading-tight text-text-default sm:text-3xl">
        Tell us when works for you.
      </h3>
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Your name" name="name" required placeholder="Full name" />
        <Field
          label="Phone number"
          name="phone"
          required
          placeholder="+63 9..."
          type="tel"
        />
        <Field label="Preferred day" name="day" type="date" />
        <Select label="Preferred time" name="time">
          <option>Morning · 9am</option>
          <option>Late morning · 11am</option>
          <option>Afternoon · 2pm</option>
          <option>Late afternoon · 4pm</option>
          <option>Any time you have</option>
        </Select>
        <Select
          label="Purpose of the visit"
          name="purpose"
          className="sm:col-span-2"
        >
          <option>Pre-need planning — no rush</option>
          <option>An immediate need has arisen</option>
          <option>Looking for a specific grave</option>
          <option>Pricing questions</option>
          <option>Just looking around</option>
        </Select>
        <Textarea
          label="Anything we should know?"
          name="notes"
          placeholder="Optional — a name, a date, who you’re coming with."
          className="sm:col-span-2"
        />
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
          No deposit. No obligation. Tea or coffee provided.
        </div>
        <button
          type="submit"
          disabled={sending}
          className="inline-flex items-center gap-2 rounded border border-primary bg-primary px-5 py-3 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send request"}
          {!sending && <ArrowRight size={16} aria-hidden />}
        </button>
      </div>
      <div className="mt-6 border-t border-surface-border pt-5">
        <CallUsFallback />
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  required,
  placeholder,
  type = "text",
}: {
  label: string;
  name: string;
  required?: boolean;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
        {label}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        placeholder={placeholder}
        className="rounded border border-surface-border bg-surface-base px-3 py-2.5 font-sans text-base text-text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      />
    </label>
  );
}

function Select({
  label,
  name,
  children,
  className,
}: {
  label: string;
  name: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
        {label}
      </span>
      <select
        name={name}
        className="rounded border border-surface-border bg-surface-base px-3 py-2.5 font-sans text-base text-text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      >
        {children}
      </select>
    </label>
  );
}

function Textarea({
  label,
  name,
  placeholder,
  className,
}: {
  label: string;
  name: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
        {label}
      </span>
      <textarea
        name={name}
        placeholder={placeholder}
        rows={4}
        className="rounded border border-surface-border bg-surface-base px-3 py-2.5 font-sans text-base text-text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      />
    </label>
  );
}
