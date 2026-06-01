"use client";

/**
 * PlaqueForm — Story 6.8 form for generating a memorial plaque PDF.
 *
 * Captures: deceased name, born / died years, date format toggle
 * (Arabic vs Roman), optional epitaph. Live preview block under the
 * form renders an HTML approximation of the engraved plaque using the
 * brand's emerald-and-gold palette; the canonical render is the
 * PDFKit action's output, NOT this preview (the preview block carries
 * an aria-label disclaiming that the final PDF may differ slightly).
 *
 * Parent-owned mutation: this component is shape-aware of
 * `convex/plaqueDrafts.ts > requestPlaqueDraft(...)` but does NOT
 * wire `useMutation` directly — the parent passes an `onSubmit`
 * callback so component tests don't need a Convex provider.
 */

import { useEffect, useId, useMemo, useState } from "react";

import {
  PLAQUE_EPITAPH_MAX_LENGTH,
  PLAQUE_MIN_YEAR,
  maxAcceptableYear,
  plaqueFormSchema,
  type PlaqueFormValues,
} from "./schema";
import { formatPlaqueDateBand } from "./toRoman";

export interface PlaqueFormProps {
  /**
   * Optional initial values used to pre-fill the form (e.g. occupant
   * name + birth year + death year derived from the joined
   * interment / occupant records, OR a "use as starting point" click
   * on a prior draft-history row).
   */
  initialValues?: Partial<PlaqueFormValues>;
  /**
   * Submit handler. Returns the resolved `{ plaqueDraftId, version }`
   * from `requestPlaqueDraft` so the parent can announce the new
   * draft / clear local state if needed.
   */
  onSubmit: (values: PlaqueFormValues) => Promise<unknown>;
  /**
   * When true (the default), the form resets back to the supplied
   * `initialValues` after a successful submit. Set false to keep the
   * operator's last input as the seed for the next revision.
   */
  resetAfterSubmit?: boolean;
}

const FALLBACK_DATE_FORMAT: "arabic" | "roman" = "arabic";

/**
 * Coerce a Partial<PlaqueFormValues> into a fully populated form
 * state, applying brand defaults for any field the parent left out.
 * `bornYear` / `diedYear` of `0` is the "empty input" sentinel — the
 * number input uses an empty string visually but the form state
 * tracks `0` until the operator types.
 */
function seedFormValues(
  initial: Partial<PlaqueFormValues> | undefined,
): PlaqueFormValues {
  return {
    deceasedName: initial?.deceasedName ?? "",
    bornYear: initial?.bornYear ?? 0,
    diedYear: initial?.diedYear ?? 0,
    dateFormat: initial?.dateFormat ?? FALLBACK_DATE_FORMAT,
    epitaph: initial?.epitaph ?? "",
  };
}

export function PlaqueForm({
  initialValues,
  onSubmit,
  resetAfterSubmit = true,
}: PlaqueFormProps) {
  const nameId = useId();
  const bornId = useId();
  const diedId = useId();
  const formatId = useId();
  const epitaphId = useId();
  const epitaphCounterId = useId();

  const [values, setValues] = useState<PlaqueFormValues>(() =>
    seedFormValues(initialValues),
  );
  const [errors, setErrors] = useState<Partial<Record<keyof PlaqueFormValues, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Re-seed when initialValues identity changes (e.g. "Use as starting
  // point" on a draft-history row swaps the props).
  useEffect(() => {
    setValues(seedFormValues(initialValues));
    setErrors({});
    setSubmitError(null);
  }, [initialValues]);

  const yearMax = useMemo(() => maxAcceptableYear(), []);

  const remainingEpitaphChars =
    PLAQUE_EPITAPH_MAX_LENGTH - (values.epitaph?.length ?? 0);

  const previewDateBand = useMemo(
    () =>
      formatPlaqueDateBand(
        values.bornYear > 0 ? values.bornYear : undefined,
        values.diedYear > 0 ? values.diedYear : undefined,
        values.dateFormat,
      ),
    [values.bornYear, values.diedYear, values.dateFormat],
  );

  // Validation gate for the submit button — runs the Zod schema each
  // render. Cheap (the schema is a handful of field checks); avoids
  // a complex dirty-tracking state machine.
  const validation = useMemo(() => {
    const schema = plaqueFormSchema();
    return schema.safeParse({
      ...values,
      epitaph:
        values.epitaph !== undefined && values.epitaph.length > 0
          ? values.epitaph
          : undefined,
    });
  }, [values]);

  const isValid = validation.success;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    setErrors({});
    const result = plaqueFormSchema().safeParse({
      ...values,
      epitaph:
        values.epitaph !== undefined && values.epitaph.length > 0
          ? values.epitaph
          : undefined,
    });
    if (!result.success) {
      const fieldErrors: Partial<Record<keyof PlaqueFormValues, string>> = {};
      for (const issue of result.error.issues) {
        const path = issue.path[0];
        if (typeof path === "string" && fieldErrors[path as keyof PlaqueFormValues] === undefined) {
          fieldErrors[path as keyof PlaqueFormValues] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(result.data);
      if (resetAfterSubmit) {
        setValues(seedFormValues(initialValues));
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to submit plaque draft.";
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6"
      data-testid="plaque-form"
      noValidate
    >
      <div>
        <label
          htmlFor={nameId}
          className="block text-sm font-medium text-slate-900"
        >
          Deceased name
        </label>
        <input
          id={nameId}
          type="text"
          value={values.deceasedName}
          onChange={(e) =>
            setValues((v) => ({ ...v, deceasedName: e.target.value }))
          }
          maxLength={200}
          className="mt-1 block w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm uppercase tracking-wide text-slate-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
          data-testid="plaque-form-name"
          aria-invalid={errors.deceasedName !== undefined}
          aria-describedby={
            errors.deceasedName !== undefined ? `${nameId}-error` : undefined
          }
          autoComplete="name"
        />
        {errors.deceasedName !== undefined && (
          <p
            id={`${nameId}-error`}
            role="alert"
            className="mt-1 text-xs text-red-700"
          >
            {errors.deceasedName}
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label
            htmlFor={bornId}
            className="block text-sm font-medium text-slate-900"
          >
            Born year
          </label>
          <input
            id={bornId}
            type="number"
            min={PLAQUE_MIN_YEAR}
            max={yearMax}
            value={values.bornYear === 0 ? "" : values.bornYear}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                bornYear: e.target.value === "" ? 0 : Number(e.target.value),
              }))
            }
            className="mt-1 block w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums text-slate-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
            data-testid="plaque-form-born-year"
            aria-invalid={errors.bornYear !== undefined}
            aria-describedby={
              errors.bornYear !== undefined ? `${bornId}-error` : undefined
            }
          />
          {errors.bornYear !== undefined && (
            <p
              id={`${bornId}-error`}
              role="alert"
              className="mt-1 text-xs text-red-700"
            >
              {errors.bornYear}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor={diedId}
            className="block text-sm font-medium text-slate-900"
          >
            Died year
          </label>
          <input
            id={diedId}
            type="number"
            min={PLAQUE_MIN_YEAR}
            max={yearMax}
            value={values.diedYear === 0 ? "" : values.diedYear}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                diedYear: e.target.value === "" ? 0 : Number(e.target.value),
              }))
            }
            className="mt-1 block w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums text-slate-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
            data-testid="plaque-form-died-year"
            aria-invalid={errors.diedYear !== undefined}
            aria-describedby={
              errors.diedYear !== undefined ? `${diedId}-error` : undefined
            }
          />
          {errors.diedYear !== undefined && (
            <p
              id={`${diedId}-error`}
              role="alert"
              className="mt-1 text-xs text-red-700"
            >
              {errors.diedYear}
            </p>
          )}
        </div>
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-900">
          Date format
        </legend>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:gap-4" id={formatId}>
          <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 has-[:checked]:border-emerald-700 has-[:checked]:bg-emerald-50">
            <input
              type="radio"
              name="dateFormat"
              value="arabic"
              checked={values.dateFormat === "arabic"}
              onChange={() =>
                setValues((v) => ({ ...v, dateFormat: "arabic" }))
              }
              data-testid="plaque-form-format-arabic"
            />
            Arabic <span className="font-mono text-slate-700">(1942 — 2026)</span>
          </label>
          <label className="flex min-h-[44px] items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 has-[:checked]:border-emerald-700 has-[:checked]:bg-emerald-50">
            <input
              type="radio"
              name="dateFormat"
              value="roman"
              checked={values.dateFormat === "roman"}
              onChange={() => setValues((v) => ({ ...v, dateFormat: "roman" }))}
              data-testid="plaque-form-format-roman"
            />
            Roman <span className="font-mono text-slate-700">(MCMXLII — MMXXVI)</span>
          </label>
        </div>
      </fieldset>

      <div>
        <label
          htmlFor={epitaphId}
          className="block text-sm font-medium text-slate-900"
        >
          Epitaph <span className="text-slate-500">(optional)</span>
        </label>
        <textarea
          id={epitaphId}
          value={values.epitaph ?? ""}
          onChange={(e) =>
            setValues((v) => ({ ...v, epitaph: e.target.value }))
          }
          maxLength={PLAQUE_EPITAPH_MAX_LENGTH}
          rows={3}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm italic text-slate-900 shadow-sm focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
          data-testid="plaque-form-epitaph"
          aria-describedby={epitaphCounterId}
          placeholder="A devoted father, a kind soul…"
        />
        <p
          id={epitaphCounterId}
          className="mt-1 text-xs text-slate-500"
          data-testid="plaque-form-epitaph-counter"
        >
          {remainingEpitaphChars} of {PLAQUE_EPITAPH_MAX_LENGTH} characters remaining
        </p>
        {errors.epitaph !== undefined && (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {errors.epitaph}
          </p>
        )}
      </div>

      {/* Live preview block — HTML approximation of the engraved
          plaque. The PDFKit action's output is the canonical render;
          this preview helps the operator catch obvious mistakes
          (wrong year, swapped name, garbled epitaph) before
          submitting. */}
      <div
        aria-label="Plaque visual preview — final PDF may differ slightly"
        className="rounded-md border border-emerald-900 bg-emerald-900 p-6 text-center"
        data-testid="plaque-form-preview"
        style={{ backgroundColor: "#1D5C4D" }}
      >
        <div
          className="mx-auto max-w-md rounded-sm border px-6 py-8"
          style={{ borderColor: "#C9A96B" }}
        >
          <p
            className="font-serif text-lg uppercase tracking-[0.3em]"
            style={{ color: "#F6F2EA" }}
            data-testid="plaque-form-preview-name"
          >
            {values.deceasedName.length > 0 ? values.deceasedName : "—"}
          </p>
          <p
            className="mt-3 font-mono text-sm tracking-widest"
            style={{ color: "#C9A96B" }}
            data-testid="plaque-form-preview-dates"
          >
            {previewDateBand.length > 0 ? previewDateBand : "—"}
          </p>
          {values.epitaph !== undefined && values.epitaph.trim().length > 0 && (
            <p
              className="mt-4 font-serif text-xs italic"
              style={{ color: "#F6F2EA", opacity: 0.85 }}
              data-testid="plaque-form-preview-epitaph"
            >
              {values.epitaph.trim()}
            </p>
          )}
        </div>
      </div>

      {submitError !== null && (
        <p role="alert" className="text-sm text-red-700">
          {submitError}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || !isValid}
        className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-emerald-800 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="plaque-form-submit"
      >
        {submitting ? "Generating…" : "Generate plaque PDF"}
      </button>
    </form>
  );
}
