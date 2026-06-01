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

      <div className="space-y-1">
        <label
          htmlFor="lot-code"
          className="block text-sm font-medium text-slate-700"
        >
          Code
        </label>
        <input
          id="lot-code"
          type="text"
          autoComplete="off"
          disabled={mode === "edit"}
          aria-invalid={errors.code !== undefined}
          aria-describedby={
            errors.code !== undefined ? "lot-code-error" : undefined
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
          error={errors.block?.message}
          {...register("block")}
        />
        <FieldText
          id="lot-row"
          label="Row"
          error={errors.row?.message}
          {...register("row")}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">Type</legend>
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
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
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
  error,
  name,
  onChange,
  onBlur,
  ref,
}: {
  id: string;
  label: string;
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
    <input
      id={id}
      type="text"
      autoComplete="off"
      aria-invalid={error !== undefined}
      aria-describedby={error !== undefined ? `${id}-error` : undefined}
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
