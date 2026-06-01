"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { BrandMark } from "./BrandMark";

/**
 * Schedule-a-visit form. Submits to /dev/null for now and shows a
 * thank-you state — the Convex action that fans this out to email
 * + the staff inbox lands in a follow-up story. Once it's live the
 * form will POST to that endpoint instead of stashing in local state.
 */
export function ScheduleVisitForm() {
  const [sent, setSent] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSent(true);
  }

  if (sent) {
    return (
      <div className="border-t-[3px] border-accent-gold bg-surface-base p-8 text-center sm:p-10">
        <div className="mx-auto flex flex-col items-center">
          <BrandMark size={80} />
          <h3 className="mt-5 font-display text-2xl font-light leading-tight text-text-default">
            We’ll be in touch.
          </h3>
          <p className="mt-3 max-w-sm text-base leading-relaxed text-text-muted">
            A care director will call within the working day to confirm. There
            is no preparation needed for your first visit — come as you are.
          </p>
        </div>
      </div>
    );
  }

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
          className="inline-flex items-center gap-2 rounded border border-primary bg-primary px-5 py-3 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
        >
          Send request
          <ArrowRight size={16} aria-hidden />
        </button>
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
