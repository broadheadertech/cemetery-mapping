"use client";

/**
 * CustomerForm — Story 2.1.
 *
 * React Hook Form + Zod. Handles the customer-creation flow per
 * AC3 (full-page `/customers/new`) and AC5 (fuzzy-match dedupe
 * alert). Designed to be embeddable inline in Story 3.x's sale
 * flow via the `onCreated` callback — when supplied, the form
 * skips its default redirect and lets the parent decide what to
 * do next (Journey 1 §1086–1089).
 *
 * Composition:
 *   - Owns the `customers.create` mutation call directly (unlike
 *     `LotForm` / `UserForm` whose parents own the mutation). The
 *     create flow is uniform across full-page and inline modes —
 *     same args, same RBAC, same audit trail — so collapsing the
 *     mutation into the form removes ceremony at every call site.
 *   - `onCreated(customerId, fullName)` — optional callback. When
 *     provided, the form invokes it after success and does NOT
 *     redirect. When `undefined`, the form redirects to
 *     `/customers/<customerId>` (the Story 2.5 detail page).
 *   - `onCancel` — optional. Renders a Cancel button when supplied.
 *
 * AC4 consent gate (NFR-C5):
 *   - The Submit button is disabled while the consent checkbox is
 *     unchecked. Inline note explains: "Required by Data Privacy
 *     Act. Without consent, ID scans cannot be attached."
 *   - The label includes today's date via `formatDate` (Asia/Manila
 *     timezone) so the staff sees what they're certifying.
 *
 * AC5 fuzzy-match dedupe:
 *   - The `fullName` field is `watch()`ed and debounced 300ms.
 *   - Once the trimmed value is ≥ 3 chars, `useQuery` fires
 *     `customers.searchByName`. Up to 5 results render in an Alert
 *     below the field with `***-***-LAST4` formatting (UX
 *     §1879–1884) and a "[View] [Continue with new]" pair.
 *   - The alert is non-blocking — the user can still submit the
 *     form while it's visible (AC5 explicit choice).
 *
 * Gov-ID masking:
 *   - On blur, the visible value becomes `"•••• •••• " + last4`.
 *     On focus, the full value re-renders. The RHF form state
 *     stays the full value the whole time — this is purely visual
 *     (UX §1875–1886 click-to-reveal pattern adapted to an input).
 */

import {
  useEffect,
  useState,
  type ChangeEventHandler,
  type FocusEventHandler,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { formatDate } from "@/lib/time";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

import {
  CUSTOMER_FORM_EMPTY_DEFAULTS,
  GOV_ID_TYPE_LABELS,
  GOV_ID_TYPE_OPTIONS,
  customerFormSchema,
  type CustomerFormValues,
  type GovIdType,
} from "./customerSchema";

/**
 * Convex function reference shapes. Mirrored inline (rather than via
 * a named `interface`) because `makeFunctionReference` requires
 * `DefaultFunctionArgs` (an index-signature-friendly shape) and
 * interfaces with optional properties don't auto-satisfy that
 * constraint. The shapes must stay in sync with
 * `convex/customers.ts`.
 */
type SearchByNameHit = {
  customerId: string;
  fullName: string;
  govIdLast4: string;
};

const createCustomerRef = makeFunctionReference<
  "mutation",
  {
    fullName: string;
    phone?: string;
    email?: string;
    address: {
      line1: string;
      barangay?: string;
      cityMunicipality?: string;
      province?: string;
      postalCode?: string;
    };
    govIdType: GovIdType;
    govIdNumber: string;
    relationshipToOccupant?: string;
    hasConsent: boolean;
  },
  { customerId: string; fullName: string }
>("customers:create");

const searchByNameRef = makeFunctionReference<
  "query",
  { q: string },
  SearchByNameHit[]
>("customers:searchByName");

/** Internal shape used to build the create-mutation args inline. */
type CreateCustomerArgs = {
  fullName: string;
  phone?: string;
  email?: string;
  address: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
  govIdType: GovIdType;
  govIdNumber: string;
  relationshipToOccupant?: string;
  hasConsent: boolean;
};

export interface CustomerFormProps {
  /**
   * Optional callback fired AFTER `customers.create` succeeds.
   * When provided, the form does NOT redirect — the parent owns
   * what happens next (e.g. embedding inside Story 3.x's sale
   * flow, where the new customerId should be attached to the
   * in-progress contract draft instead of redirected to a detail
   * page).
   *
   * When `undefined` the form redirects to
   * `/customers/<customerId>` — the default standalone flow used
   * by `/customers/new`.
   */
  onCreated?: (customerId: string, fullName: string) => void;
  /**
   * Optional Cancel handler. Renders a Cancel button when
   * supplied. Typically `router.back()` or
   * `router.push("/dashboard")`.
   */
  onCancel?: () => void;
  /**
   * Form heading visible to assistive tech. Default
   * `"Create customer form"`.
   */
  ariaLabel?: string;
}

/** AC5 debounce — 300ms. Mirrors the story's explicit spec. */
const DEDUPE_DEBOUNCE_MS = 300;

/** AC5 — minimum trimmed-name length before the dedupe query fires. */
const DEDUPE_MIN_CHARS = 3;

export function CustomerForm({
  onCreated,
  onCancel,
  ariaLabel = "Create customer form",
}: CustomerFormProps) {
  const router = useRouter();
  const createCustomer = useMutation(createCustomerRef);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [dismissedDedupe, setDismissedDedupe] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: CUSTOMER_FORM_EMPTY_DEFAULTS,
    mode: "onBlur",
  });

  const watchedFullName = watch("fullName");
  const watchedConsent = watch("hasConsent");

  // AC5 — fuzzy-match dedupe query. Debounce keystrokes 300ms; skip
  // the query (Convex's "skip" sentinel) until the trimmed value
  // crosses the threshold.
  const debouncedFullName = useDebouncedValue(
    watchedFullName,
    DEDUPE_DEBOUNCE_MS,
  );
  const trimmedDebounced = (debouncedFullName ?? "").trim();
  const dedupeResults = useQuery(
    searchByNameRef,
    trimmedDebounced.length >= DEDUPE_MIN_CHARS
      ? { q: trimmedDebounced }
      : "skip",
  );

  // Reset the "dismissed" flag when the name changes meaningfully —
  // a fresh prefix is a fresh decision.
  useEffect(() => {
    setDismissedDedupe(false);
  }, [trimmedDebounced]);

  // AC3 consent label — captured-date renders today's Manila date.
  // Computed once per render (a 50ms re-format on every keystroke
  // is fine; the Intl formatter is cached in `src/lib/time.ts`).
  const todayLabel = formatDate(Date.now(), "short");

  const handleValidSubmit = async (
    values: CustomerFormValues,
  ): Promise<void> => {
    setSubmitError(null);
    try {
      // Coerce optional empty strings → undefined so the Convex
      // optional validators are happy (they reject `""` but
      // accept absence).
      const payload: CreateCustomerArgs = {
        fullName: values.fullName.trim(),
        address: {
          line1: values.addressLine1.trim(),
          ...(values.barangay && values.barangay.trim().length > 0
            ? { barangay: values.barangay.trim() }
            : {}),
          ...(values.cityMunicipality &&
          values.cityMunicipality.trim().length > 0
            ? { cityMunicipality: values.cityMunicipality.trim() }
            : {}),
          ...(values.province && values.province.trim().length > 0
            ? { province: values.province.trim() }
            : {}),
          ...(values.postalCode && values.postalCode.trim().length > 0
            ? { postalCode: values.postalCode.trim() }
            : {}),
        },
        govIdType: values.govIdType,
        govIdNumber: values.govIdNumber.trim(),
        hasConsent: values.hasConsent,
      };
      if (values.phone && values.phone.trim().length > 0) {
        payload.phone = values.phone.trim();
      }
      if (values.email && values.email.trim().length > 0) {
        payload.email = values.email.trim().toLowerCase();
      }
      if (
        values.relationshipToOccupant &&
        values.relationshipToOccupant.trim().length > 0
      ) {
        payload.relationshipToOccupant = values.relationshipToOccupant.trim();
      }
      const result = await createCustomer(payload);
      if (onCreated) {
        onCreated(result.customerId, result.fullName);
      } else {
        router.push(`/customers/${result.customerId}`);
      }
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(handleValidSubmit)}
      className="space-y-6"
      noValidate
      aria-label={ariaLabel}
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="customer-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      {/* Full name + dedupe alert */}
      <div className="space-y-2">
        <FieldText
          id="customer-fullname"
          label="Full name"
          required
          error={errors.fullName?.message}
          register={register("fullName")}
        />
        {!dismissedDedupe &&
          Array.isArray(dedupeResults) &&
          dedupeResults.length > 0 && (
            <div
              role="status"
              data-testid="customer-dedupe-alert"
              className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            >
              <p className="font-medium">
                Similar {dedupeResults.length === 1 ? "customer" : "customers"}{" "}
                already exists:
              </p>
              <ul className="mt-2 space-y-1">
                {dedupeResults.slice(0, 3).map((hit) => (
                  <li
                    key={hit.customerId}
                    className="flex items-center justify-between gap-3"
                  >
                    <span>
                      <span className="font-medium">{hit.fullName}</span>{" "}
                      <span className="text-xs text-amber-800">
                        (gov ID ***-***-{hit.govIdLast4})
                      </span>
                    </span>
                    <Link
                      href={`/customers/${hit.customerId}`}
                      className="text-xs font-medium underline"
                    >
                      View
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-right">
                <button
                  type="button"
                  onClick={() => setDismissedDedupe(true)}
                  className="text-xs font-medium underline"
                >
                  Continue with new
                </button>
              </div>
            </div>
          )}
      </div>

      {/* Phone + email */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FieldText
          id="customer-phone"
          label="Phone"
          placeholder="09XX-XXX-XXXX or +639…"
          error={errors.phone?.message}
          register={register("phone")}
        />
        <FieldText
          id="customer-email"
          label="Email"
          type="email"
          error={errors.email?.message}
          register={register("email")}
        />
      </div>

      {/* Address */}
      <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
        <legend className="px-2 text-sm font-medium text-slate-700">
          Address
        </legend>
        <FieldText
          id="customer-address-line1"
          label="Line 1"
          required
          error={errors.addressLine1?.message}
          register={register("addressLine1")}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FieldText
            id="customer-address-barangay"
            label="Barangay"
            error={errors.barangay?.message}
            register={register("barangay")}
          />
          <FieldText
            id="customer-address-city"
            label="City / Municipality"
            error={errors.cityMunicipality?.message}
            register={register("cityMunicipality")}
          />
          <FieldText
            id="customer-address-province"
            label="Province"
            error={errors.province?.message}
            register={register("province")}
          />
          <FieldText
            id="customer-address-postal"
            label="Postal code"
            error={errors.postalCode?.message}
            register={register("postalCode")}
          />
        </div>
      </fieldset>

      {/* Gov ID type + number */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            htmlFor="customer-govid-type"
            className="block text-sm font-medium text-slate-700"
          >
            Government ID type
          </label>
          <select
            id="customer-govid-type"
            className={cn(
              "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm min-h-[44px]",
              "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
              errors.govIdType !== undefined && "border-red-400",
            )}
            {...register("govIdType")}
          >
            {GOV_ID_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {GOV_ID_TYPE_LABELS[opt]}
              </option>
            ))}
          </select>
          {errors.govIdType !== undefined && (
            <p className="text-xs text-red-600">{errors.govIdType.message}</p>
          )}
        </div>

        <Controller
          control={control}
          name="govIdNumber"
          render={({ field }) => (
            <MaskedGovIdInput
              id="customer-govid-number"
              label="Government ID number"
              required
              value={field.value}
              onChange={(next) => {
                field.onChange(next);
                // RHF's `register` would handle this, but the
                // Controller path requires manual setValue so the
                // schema validation is triggered consistently.
                setValue("govIdNumber", next, { shouldValidate: false });
              }}
              error={errors.govIdNumber?.message}
            />
          )}
        />
      </div>

      {/* Relationship to occupant */}
      <FieldText
        id="customer-relationship"
        label="Relationship to occupant (optional)"
        placeholder="e.g. spouse, child, self"
        error={errors.relationshipToOccupant?.message}
        register={register("relationshipToOccupant")}
      />

      {/* Consent gate (AC4) */}
      <fieldset className="space-y-2 rounded-md border border-slate-200 p-4">
        <legend className="px-2 text-sm font-medium text-slate-700">
          Data Privacy Act consent
        </legend>
        <label className="flex items-start gap-3 text-sm">
          <Controller
            control={control}
            name="hasConsent"
            render={({ field }) => (
              <input
                type="checkbox"
                id="customer-consent"
                aria-describedby="customer-consent-note"
                checked={field.value}
                onChange={(e) => field.onChange(e.target.checked)}
                className="mt-1 h-5 w-5"
              />
            )}
          />
          <span>
            Customer has given consent for retention of their identification
            documents per the Data Privacy Act of 2012 (RA 10173). Captured:{" "}
            <span className="font-medium">{todayLabel}</span>.
          </span>
        </label>
        <p
          id="customer-consent-note"
          className="pl-8 text-xs text-slate-500"
        >
          Required by Data Privacy Act. Without consent, ID scans cannot be
          attached.
        </p>
      </fieldset>

      <div className="flex items-center justify-end gap-3 pt-2">
        {onCancel !== undefined && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 min-h-[44px]"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isSubmitting || !watchedConsent}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 min-h-[44px]"
        >
          {isSubmitting ? "Creating…" : "Create customer"}
        </button>
      </div>
    </form>
  );
}

/**
 * Lightweight text field — mirrors the inline `FieldText` from
 * `LotForm.tsx` but accepts a pre-built `register` payload rather
 * than spreading at the call site. Keeps the parent's JSX flat.
 */
function FieldText({
  id,
  label,
  type = "text",
  placeholder,
  required,
  error,
  register,
}: {
  id: string;
  label: string;
  type?: "text" | "email";
  placeholder?: string;
  required?: boolean;
  error?: string;
  register: {
    name: string;
    onChange: ChangeEventHandler<HTMLInputElement>;
    onBlur: FocusEventHandler<HTMLInputElement>;
    ref: React.Ref<HTMLInputElement>;
  };
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </label>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        autoComplete="off"
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${id}-error` : undefined}
        className={cn(
          "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm min-h-[44px]",
          "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          error !== undefined && "border-red-400",
        )}
        name={register.name}
        onChange={register.onChange}
        onBlur={register.onBlur}
        ref={register.ref}
      />
      {error !== undefined && (
        <p id={`${id}-error`} className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Gov-ID input with the click-to-reveal masking pattern from UX
 * §1875–1886 — adapted for an editable field.
 *
 * Behaviour:
 *   - While focused: shows the full value the user typed; edits are
 *     applied directly to `value`.
 *   - On blur: re-renders the visible value as
 *     `"•••• •••• " + last4`. The underlying form state never sees
 *     the masked display string — only the real value.
 *   - On focus: re-renders the full value so the user can edit it.
 *
 * The implementation uses a local `isFocused` boolean rather than a
 * shadow display-string state, which keeps the source of truth in
 * one place (the parent's RHF value) and avoids the
 * "stale-display-after-external-update" failure mode.
 */
function MaskedGovIdInput({
  id,
  label,
  required,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (next: string) => void;
  error?: string;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const compact = value.replace(/[^a-zA-Z0-9]/g, "");
  const last4 = compact.length >= 4 ? compact.slice(-4) : compact;
  const display =
    isFocused || value.length === 0
      ? value
      : `•••• •••• ${last4}`;

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="ml-1 text-red-600">*</span> : null}
      </label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${id}-error` : undefined}
        data-masked={!isFocused && value.length > 0 ? "true" : "false"}
        className={cn(
          "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm min-h-[44px]",
          "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
          error !== undefined && "border-red-400",
        )}
        value={display}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onChange={(e) => {
          // When focused (and therefore editable), the displayed
          // value IS the real value — no demasking needed. We still
          // guard against the impossible case of an onChange firing
          // while masked by ignoring updates that contain the bullet
          // character.
          if (e.target.value.includes("•")) return;
          onChange(e.target.value);
        }}
      />
      {error !== undefined && (
        <p id={`${id}-error`} className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
