"use client";

/**
 * LotForm — Story 1.8.
 *
 * React Hook Form + Zod. Handles both create and edit. Submits
 * directly to the parent's `onSubmit` callback; the parent owns the
 * Convex mutation call and the redirect/refresh behaviour.
 *
 * Why the parent owns the mutation:
 *   - The form is unit-testable without a Convex client mock.
 *   - The create page redirects to `/lots/<id>` on success; the edit
 *     page stays put and lets the reactive query refresh. Both
 *     behaviours live in their own page components, not in the form.
 *
 * Money input:
 *   - User types pesos in a plain text input. On submit, the parent
 *     receives `basePriceCents` (an integer) — the form's submit
 *     handler converts via `pesosToCents`. The form NEVER stores
 *     money as a float; it stores the raw string until conversion.
 *
 * Edit mode:
 *   - `mode="edit"` disables the `code` field (immutable identifier).
 *   - Submit handler omits `code` from the payload so the parent's
 *     `updateLot` call doesn't try to patch it (server would reject).
 */

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { centsToPesos, pesosToCents } from "@/lib/money";
import { lotFormSchema, LOT_TYPES, type LotFormValues, type LotType } from "./schema";

/**
 * Story 1.15 — read-side query reference for the section dropdown.
 * Returns the active (non-retired) registry rows ordered by
 * `sortOrder`. Available to all staff roles.
 */
interface ActiveSectionOption {
  _id: string;
  name: string;
  displayName: string;
  sortOrder: number;
  kind: "chapel" | "family" | "standard" | "niche" | "columbarium";
}

const listActiveSectionsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  ActiveSectionOption[]
>("sections:listActiveSections");

export interface LotFormInitialValues {
  code: string;
  section: string;
  sectionId?: string;
  block: string;
  row: string;
  type: LotType;
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
}

export interface LotFormSubmitPayload {
  code: string;
  section: string;
  sectionId?: string;
  block: string;
  row: string;
  type: LotType;
  dimensions: { widthM: number; depthM: number };
  basePriceCents: number;
}

export interface LotFormProps {
  mode: "create" | "edit";
  /**
   * Initial values for `mode="edit"`. Ignored in create mode (uses
   * empty defaults).
   */
  defaultValues?: LotFormInitialValues;
  /**
   * Parent-supplied submit handler. Receives the validated payload
   * with `basePriceCents` already in integer centavos. May throw a
   * `ConvexError` — the form translates it via `translateError` and
   * surfaces an inline alert.
   */
  onSubmit: (payload: LotFormSubmitPayload) => Promise<void>;
  /**
   * Called when the user clicks the secondary "Cancel" button.
   * Typically `router.back()` or `router.push("/lots")`.
   */
  onCancel?: () => void;
}

const EMPTY_DEFAULTS: LotFormValues = {
  code: "",
  sectionId: "",
  section: "",
  block: "",
  row: "",
  type: "single",
  widthM: 1,
  depthM: 2,
  basePrice: "",
};

function toFormValues(initial: LotFormInitialValues): LotFormValues {
  return {
    code: initial.code,
    sectionId: initial.sectionId ?? "",
    section: initial.section,
    block: initial.block,
    row: initial.row,
    type: initial.type,
    widthM: initial.dimensions.widthM,
    depthM: initial.dimensions.depthM,
    basePrice: String(centsToPesos(initial.basePriceCents)),
  };
}

export function LotForm({
  mode,
  defaultValues,
  onSubmit,
  onCancel,
}: LotFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const initialValues =
    mode === "edit" && defaultValues !== undefined
      ? toFormValues(defaultValues)
      : EMPTY_DEFAULTS;

  // Story 1.15 — reactive list of active sections for the dropdown.
  // `useQuery` returns `undefined` while loading; the dropdown renders
  // a disabled placeholder option in that state. An empty array
  // (admin hasn't seeded the registry yet) surfaces a helper note.
  const sectionOptions = useQuery(listActiveSectionsRef, {});

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LotFormValues>({
    resolver: zodResolver(lotFormSchema),
    defaultValues: initialValues,
  });

  const selectedSectionId = watch("sectionId");

  const handleValidSubmit = async (values: LotFormValues): Promise<void> => {
    setSubmitError(null);
    const cents = pesosToCents(values.basePrice);
    try {
      // Resolve the selected section's displayName so the legacy
      // `section` string column is kept in step with the FK for
      // back-compat readers (Story 1.8 by_section_block index).
      const selectedSection = (sectionOptions ?? []).find(
        (s) => s._id === values.sectionId,
      );
      const sectionLabel =
        selectedSection?.displayName ?? values.section?.trim() ?? "";
      await onSubmit({
        code: values.code.trim().toUpperCase(),
        section: sectionLabel,
        sectionId: values.sectionId,
        block: values.block.trim(),
        row: values.row.trim(),
        type: values.type,
        dimensions: { widthM: values.widthM, depthM: values.depthM },
        basePriceCents: cents,
      });
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  };

  // Avoid an unused-var lint when `setValue` is referenced only for
  // future hook-form interactions; explicit void marker mirrors how
  // adjacent forms in this repo discharge optional helpers.
  void setValue;
  void selectedSectionId;

  return (
    <form
      onSubmit={handleSubmit(handleValidSubmit)}
      className="space-y-6"
      noValidate
      aria-label={mode === "create" ? "New lot form" : "Edit lot form"}
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="lot-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      {/*
        What a lot actually is, before any of the boxes.

        Every field below is a label somebody else will read later — on
        a contract, on a receipt, on the map, or out loud to a family
        looking for a grave. The one thing that is NOT just a label is
        the code's ordering, and nothing on this form said so.
      */}
      {mode === "create" && (
        <section
          data-testid="lot-form-guide"
          className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700"
        >
          <h2 className="text-sm font-semibold text-slate-900">
            How a lot is described
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            A lot belongs to a <strong>garden</strong>, sits in a{" "}
            <strong>block</strong> within that garden, and has a{" "}
            <strong>row</strong> position inside the block. Its{" "}
            <strong>code</strong> is the name everyone uses for it
            afterwards.
          </p>
          <dl className="mt-3 space-y-1.5 text-xs leading-relaxed">
            <div>
              <dt className="inline font-semibold text-slate-900">
                Garden ·{" "}
              </dt>
              <dd className="inline text-slate-600">
                the named part of the park — Garden of Faith, Chapel of
                Grace. Created by an admin under Map → Gardens.
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold text-slate-900">
                Block ·{" "}
              </dt>
              <dd className="inline text-slate-600">
                a group of lots inside the garden, usually whatever a
                path or driveway separates. If your park does not use
                blocks, put <code className="font-mono">1</code> on
                everything.
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold text-slate-900">Row · </dt>
              <dd className="inline text-slate-600">
                where the lot sits inside its block.
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold text-slate-900">
                Code ·{" "}
              </dt>
              <dd className="inline text-slate-600">
                the unique reference. Most parks combine the three:{" "}
                <code className="font-mono">A-1-01</code> for garden A,
                block 1, lot 01.
              </dd>
            </div>
          </dl>
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs leading-relaxed text-amber-900">
            <strong className="font-semibold">
              Number the codes in the order the lots physically sit.
            </strong>{" "}
            Until a lot has a measured position, the 3D map draws each
            garden as a grid filled in code order — so the codes are the
            arrangement. Everything else here can be edited later
            without consequence; this is the one that is awkward to
            change once contracts reference it.
          </p>
        </section>
      )}

      <div className="space-y-1">
        <label
          htmlFor="lot-code"
          className="block text-sm font-medium text-slate-700"
        >
          Code
        </label>
        <p id="lot-code-hint" className="text-xs leading-snug text-slate-500">
          {mode === "edit"
            ? "Fixed once created — contracts, receipts and records already reference it."
            : "The name this lot carries on every contract, receipt and record. Must be unique across the park."}
        </p>
        <input
          id="lot-code"
          type="text"
          autoComplete="off"
          disabled={mode === "edit"}
          aria-invalid={errors.code !== undefined}
          aria-describedby={
            errors.code !== undefined
              ? "lot-code-error lot-code-hint"
              : "lot-code-hint"
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            mode === "edit" && "bg-slate-100 text-slate-500",
            errors.code !== undefined && "border-red-400",
          )}
          {...register("code")}
        />
        {errors.code !== undefined && (
          <p id="lot-code-error" className="text-xs text-red-600">
            {errors.code.message}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-1">
          <label
            htmlFor="lot-section"
            className="block text-sm font-medium text-slate-700"
          >
            Section
          </label>
          <select
            id="lot-section"
            aria-invalid={errors.sectionId !== undefined}
            aria-describedby={
              errors.sectionId !== undefined ? "lot-section-error" : undefined
            }
            disabled={sectionOptions === undefined}
            className={cn(
              "block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.sectionId !== undefined && "border-red-400",
              sectionOptions === undefined && "bg-slate-100 text-slate-500",
            )}
            {...register("sectionId")}
          >
            <option value="">
              {sectionOptions === undefined
                ? "Loading sections…"
                : "Select a section"}
            </option>
            {(sectionOptions ?? []).map((opt) => (
              <option key={opt._id} value={opt._id}>
                {opt.displayName}
              </option>
            ))}
          </select>
          {sectionOptions !== undefined && sectionOptions.length === 0 && (
            <p
              className="text-xs text-slate-500"
              data-testid="lot-section-empty-hint"
            >
              No sections defined yet. An admin can add one at{" "}
              <a
                href="/admin/sections"
                className="font-medium text-slate-700 underline"
              >
                /admin/sections
              </a>
              .
            </p>
          )}
          {errors.sectionId !== undefined && (
            <p id="lot-section-error" className="text-xs text-red-600">
              {errors.sectionId.message}
            </p>
          )}
        </div>
        <FieldText
          id="lot-block"
          label="Block"
          hint="A group of lots inside the garden — usually whatever a path or driveway separates. Any short label: 1, 2, A."
          error={errors.block?.message}
          {...register("block")}
        />
        <FieldText
          id="lot-row"
          label="Row"
          hint="Where this lot sits inside its block. A label, not a calculation — 01, 02, 03."
          error={errors.row?.message}
          {...register("row")}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">Type</legend>
        <p className="text-xs leading-snug text-slate-500">
          Decides how many interments the lot holds and how it is drawn
          on the 3D map. Single and family are ground plots; mausoleum is
          a built structure; niche is a columbarium vault.
        </p>
        <div
          className="flex flex-wrap gap-3"
          role="radiogroup"
          aria-label="Lot type"
        >
          {LOT_TYPES.map((t) => (
            <label
              key={t}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50"
            >
              <input
                type="radio"
                value={t}
                {...register("type")}
                className="h-4 w-4"
              />
              <span className="capitalize">{t}</span>
            </label>
          ))}
        </div>
        {errors.type !== undefined && (
          <p className="text-xs text-red-600">{errors.type.message}</p>
        )}
      </fieldset>

      <p className="text-xs leading-snug text-slate-500">
        <strong className="font-medium text-slate-700">
          Width and depth
        </strong>{" "}
        are the lot&rsquo;s real size on the ground, in metres. They give
        the square-metre figure shown to families, and they are the
        footprint drawn around the point when somebody sets this
        lot&rsquo;s location. A standard single grave is about 2.5m ×
        1.2m.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="lot-width"
            className="block text-sm font-medium text-slate-700"
          >
            Width (m)
          </label>
          <input
            id="lot-width"
            type="number"
            step="0.01"
            min="0"
            aria-invalid={errors.widthM !== undefined}
            aria-describedby={
              errors.widthM !== undefined ? "lot-width-error" : undefined
            }
            className={cn(
              "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.widthM !== undefined && "border-red-400",
            )}
            {...register("widthM", { valueAsNumber: true })}
          />
          {errors.widthM !== undefined && (
            <p id="lot-width-error" className="text-xs text-red-600">
              {errors.widthM.message}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label
            htmlFor="lot-depth"
            className="block text-sm font-medium text-slate-700"
          >
            Depth (m)
          </label>
          <input
            id="lot-depth"
            type="number"
            step="0.01"
            min="0"
            aria-invalid={errors.depthM !== undefined}
            aria-describedby={
              errors.depthM !== undefined ? "lot-depth-error" : undefined
            }
            className={cn(
              "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.depthM !== undefined && "border-red-400",
            )}
            {...register("depthM", { valueAsNumber: true })}
          />
          {errors.depthM !== undefined && (
            <p id="lot-depth-error" className="text-xs text-red-600">
              {errors.depthM.message}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="lot-price"
          className="block text-sm font-medium text-slate-700"
        >
          Base price (₱)
        </label>
        <p className="text-xs leading-snug text-slate-500">
          The list price before any discount, promo or payment plan.
          Those are applied on the sale, not here — so this stays the
          same number for every buyer of a comparable lot.
        </p>
        <div className="relative">
          <span
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-slate-500"
            aria-hidden="true"
          >
            ₱
          </span>
          <input
            id="lot-price"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            aria-invalid={errors.basePrice !== undefined}
            aria-describedby={
              errors.basePrice !== undefined ? "lot-price-error" : undefined
            }
            className={cn(
              "block w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.basePrice !== undefined && "border-red-400",
            )}
            {...register("basePrice")}
          />
        </div>
        {errors.basePrice !== undefined && (
          <p id="lot-price-error" className="text-xs text-red-600">
            {errors.basePrice.message}
          </p>
        )}
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting
            ? "Saving…"
            : mode === "create"
              ? "Create lot"
              : "Save changes"}
        </button>
      </div>
    </form>
  );
}

/**
 * Small inline text field — reuse for the section / block / row trio.
 * Forwards `register` props by spreading the rest.
 */
const FieldText = ({
  id,
  label,
  hint,
  error,
  name,
  onChange,
  onBlur,
  ref,
}: {
  id: string;
  label: string;
  /** What the field is for, in the words of somebody who runs a park. */
  hint?: string;
  error?: string;
  name: string;
  // The shape RHF's `register` returns:
  onChange: React.ChangeEventHandler<HTMLInputElement>;
  onBlur: React.FocusEventHandler<HTMLInputElement>;
  ref: React.Ref<HTMLInputElement>;
}) => (
  <div className="space-y-1">
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
    </label>
    {hint !== undefined && (
      <p id={`${id}-hint`} className="text-xs leading-snug text-slate-500">
        {hint}
      </p>
    )}
    <input
      id={id}
      type="text"
      autoComplete="off"
      aria-invalid={error !== undefined}
      aria-describedby={
        [
          error !== undefined ? `${id}-error` : null,
          hint !== undefined ? `${id}-hint` : null,
        ]
          .filter((x): x is string => x !== null)
          .join(" ") || undefined
      }
      className={cn(
        "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
        "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
        error !== undefined && "border-red-400",
      )}
      name={name}
      ref={ref}
      onChange={onChange}
      onBlur={onBlur}
    />
    {error !== undefined && (
      <p id={`${id}-error`} className="text-xs text-red-600">
        {error}
      </p>
    )}
  </div>
);
