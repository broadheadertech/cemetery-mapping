"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { LOT_TYPES, type LotType } from "./data";
import { LotTypeGrid } from "./LotTypeGrid";
import { SectionHead } from "./SectionHead";
import { BrandMark } from "./BrandMark";

/**
 * Pricing page interactive shell — selectable lot grid + detail block
 * + inquiry form. Lives outside the page.tsx so the parent can stay a
 * server component for static rendering of the hero / CTA strip; only
 * this island ships JS.
 */
export function PricingPageClient() {
  const [selectedId, setSelectedId] = useState<LotType["id"]>("family");
  // `family` is guaranteed to exist in LOT_TYPES — see data.ts. The
  // non-null fallback is for the "user picked an id we no longer
  // know about" edge case (e.g. a future copy update removes an id
  // while a tab is open); we collapse to the first lot type.
  const selected: LotType =
    LOT_TYPES.find((l) => l.id === selectedId) ?? LOT_TYPES[0]!;

  return (
    <>
      <section className="bg-surface-muted">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8">
          <LotTypeGrid
            lots={LOT_TYPES}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />

          <div className="mt-12 border-t-[3px] border-accent-gold bg-surface-base p-6 sm:p-10">
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.4fr]">
              <div>
                <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
                  {selected.tag} · selected
                </div>
                <h2 className="mt-4 font-display text-3xl font-light leading-tight text-text-default sm:text-4xl">
                  {selected.name}
                </h2>
                <span
                  aria-hidden
                  className="mt-5 block h-px w-16 bg-accent-gold"
                />
                <div className="mt-6 font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                  From
                </div>
                <div className="mt-2 font-display text-5xl text-primary sm:text-6xl">
                  {selected.priceFrom}
                </div>
                <p className="mt-5 text-base leading-relaxed text-text-muted">
                  {selected.summary}
                </p>
              </div>
              <div>
                <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
                  Inclusions
                </div>
                <ul className="mt-4 flex flex-col">
                  {selected.inclusions.map((inc, i) => (
                    <li
                      key={inc}
                      className="flex items-baseline gap-4 border-t border-surface-border py-4"
                    >
                      <span className="min-w-7 font-mono text-xs uppercase tracking-[0.14em] text-accent-gold">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="text-lg leading-relaxed text-text-default">
                        {inc}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-surface-emphasis">
        <div className="mx-auto max-w-7xl gap-12 px-4 py-20 sm:px-6 sm:py-24 lg:grid lg:grid-cols-[1fr_1.4fr] lg:px-8">
          <div>
            <SectionHead
              eyebrow="Pricing inquiry"
              title="Tell us what you have in mind."
              lede="We will reply within one working day with the full inclusion list, current availability, and a recommended walking route for your first visit."
            />
          </div>
          <PricingInquiryForm defaultLotId={selected.id} />
        </div>
      </section>
    </>
  );
}

function PricingInquiryForm({
  defaultLotId,
}: {
  defaultLotId: LotType["id"];
}) {
  const [sent, setSent] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSent(true);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-10 border-t-[3px] border-accent-gold bg-surface-base p-6 shadow-sm sm:p-8 lg:mt-0"
    >
      {sent ? (
        <div className="flex flex-col items-center py-6 text-center">
          <BrandMark size={80} />
          <h3 className="mt-5 font-display text-2xl font-light leading-tight text-text-default">
            Thank you.
          </h3>
          <p className="mt-3 max-w-sm text-base leading-relaxed text-text-muted">
            We will reply by tomorrow afternoon. If today is difficult, please
            feel free to call us directly at +63 (72) 562-0187.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="Your name" name="name" required placeholder="Full name" />
            <FormField
              label="Phone or email"
              name="contact"
              required
              placeholder="So we can reach you"
            />
            <FormSelect
              label="Lot type"
              name="lotType"
              defaultValue={defaultLotId}
            >
              {LOT_TYPES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
              <option value="unsure">Not sure yet</option>
            </FormSelect>
            <FormSelect label="Timing" name="timing">
              <option>This week</option>
              <option>This month</option>
              <option>Planning ahead — no rush</option>
              <option>An immediate need</option>
            </FormSelect>
          </div>
          <FormTextarea
            label="Anything we should know?"
            name="notes"
            placeholder="Optional — a name, a date, anything that helps us prepare."
          />
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-text-muted">
              We will never share your information. DPA-compliant.
            </div>
            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded border border-primary bg-primary px-5 py-3 text-sm font-medium text-primary-fg transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base"
            >
              Send inquiry
              <ArrowRight size={16} aria-hidden />
            </button>
          </div>
        </>
      )}
    </form>
  );
}

function FormField({
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

function FormSelect({
  label,
  name,
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
        {label}
      </span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded border border-surface-border bg-surface-base px-3 py-2.5 font-sans text-base text-text-default focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus-ring"
      >
        {children}
      </select>
    </label>
  );
}

function FormTextarea({
  label,
  name,
  placeholder,
}: {
  label: string;
  name: string;
  placeholder?: string;
}) {
  return (
    <label className="mt-4 flex flex-col gap-1.5">
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
