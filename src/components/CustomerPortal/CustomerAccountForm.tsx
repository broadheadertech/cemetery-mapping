"use client";

/**
 * CustomerAccountForm — Story 9.4 (FR58).
 *
 * Mobile-first form that lets a customer update their own contact info
 * (phone / email / address) from the portal. Identity fields (full name
 * + government ID) render as read-only with a helper note pointing the
 * customer to the cemetery office for any changes — those require
 * staff verification (FR58 explicit constraint).
 *
 * Composition:
 *   - Owns the `portal:updateCustomerContact` mutation directly. The
 *     mutation's args validator does NOT accept a `customerId`; the
 *     target row is derived server-side from the auth identity, so the
 *     form has no way to mis-target another customer's record (own-
 *     record-only guard at the type system layer).
 *   - Reads the current customer's profile via
 *     `portal:getCurrentCustomer` to pre-fill the editable fields and
 *     to display the read-only identity fields. The query is
 *     ownership-scoped server-side; the form never knows another
 *     customer's data even theoretically.
 *   - React Hook Form + Zod for client-side validation. The schema
 *     mirrors the server-side validators (PH phone normalisation,
 *     plausible email shape, required `addressLine1`) so the user
 *     sees inline feedback before the request fires.
 *
 * Read-only identity defense (AC1):
 *   - The `Full name` and `Government ID` inputs render with
 *     `readOnly` + `aria-readonly="true"` + a helper note. Even if a
 *     user removes the `readOnly` attribute via DevTools and types a
 *     value, the form NEVER includes those fields in the submit
 *     payload — RHF doesn't `register` them. The server's allow-list
 *     patch is the actual security gate; this is the visible UX layer.
 *
 * Reactivity (AC4):
 *   - On submit success: Convex's reactive `useQuery` on the read
 *     surface re-fires automatically (the patch updates the row);
 *     the form re-syncs its defaults via the `useEffect` that watches
 *     the profile snapshot. No manual refresh / refetch needed.
 *   - On failure: per-field inline errors via `aria-describedby` and a
 *     submit-level error via `role="alert"`.
 *
 * Accessibility:
 *   - All editable controls meet ≥ 48px touch target (NFR-A4) via
 *     `min-h-[48px]` on inputs + the submit button.
 *   - Form labels are visible (never placeholder-as-label per
 *     NFR-A1 / UX form patterns).
 *   - Read-only fields advertise their state via both `readOnly` and
 *     `aria-readonly="true"` so screen readers narrate them as such.
 */

import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";

/**
 * Convex function references — mirrored shapes match `convex/portal.ts`
 * exactly. The shapes intentionally do NOT include any client-supplied
 * customer id; cross-customer write is impossible by construction (see
 * the mutation's JSDoc).
 */
interface CustomerProfileSnapshot {
  customerId: string;
  fullName: string;
  email: string;
}

const getCurrentCustomerRef = makeFunctionReference<
  "query",
  Record<string, never>,
  CustomerProfileSnapshot
>("portal:getCurrentCustomer");

type UpdateCustomerContactArgs = {
  phone?: string;
  email?: string;
  address?: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
};

type UpdateCustomerContactResult = {
  customerId: string;
  updatedFields: Array<"phone" | "email" | "address">;
};

const updateCustomerContactRef = makeFunctionReference<
  "mutation",
  UpdateCustomerContactArgs,
  UpdateCustomerContactResult
>("portal:updateCustomerContact");

/**
 * Client-side PH-phone regex used by the Zod schema. Accepts both
 * `09XXXXXXXXX` and `+639XXXXXXXXX` shapes, ignoring internal
 * punctuation (spaces, dashes, dots) so the customer can type
 * `0917-555-1234` without seeing a validation error. The server-side
 * normaliser converts to the canonical `+63` form on write.
 */
const PH_PHONE_REGEX = /^(?:09\d{9}|\+639\d{9})$/;

/**
 * Form schema. Optional fields use empty-string as the "absent" sentinel
 * because HTML inputs always produce strings; the submit handler
 * converts empty trimmed values to `undefined` before invoking the
 * mutation so the Convex optional validators accept the payload.
 */
const accountFormSchema = z.object({
  phone: z
    .string()
    .trim()
    .refine(
      (value) => {
        if (value.length === 0) return true; // empty = no change requested
        const compact = value.replace(/[\s\-.()]/g, "");
        return PH_PHONE_REGEX.test(compact);
      },
      {
        message:
          "Enter a Philippine mobile number (e.g. 09171234567 or +639171234567).",
      },
    ),
  email: z
    .string()
    .trim()
    .refine(
      (value) => {
        if (value.length === 0) return true;
        // Conservative client-side check — server has the same gate.
        const at = value.indexOf("@");
        if (at <= 0 || at === value.length - 1) return false;
        if (value.includes(" ")) return false;
        return value.lastIndexOf(".") > at;
      },
      { message: "Enter a valid email address." },
    ),
  addressLine1: z.string().trim().min(1, "Address line 1 is required."),
  barangay: z.string().trim(),
  cityMunicipality: z.string().trim(),
  province: z.string().trim(),
  postalCode: z.string().trim(),
});

type AccountFormValues = z.infer<typeof accountFormSchema>;

export interface CustomerAccountFormProps {
  /** Initial values for the read-only identity fields and editable
   *  contact fields. Typically derived from the server-rendered
   *  greeting + a portal-side read query. Omitting falls back to the
   *  reactive query inside the component. */
  initialFullName?: string;
  initialPhone?: string;
  initialEmail?: string;
  initialAddress?: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
  /** Last-4 of the customer's government ID, formatted as `1234`.
   *  Rendered with the canonical `***-***-{last4}` prefix per UX
   *  §1879. Omitting renders a placeholder. */
  govIdLast4?: string;
  /** Localised label for the government-ID type (e.g. "SSS",
   *  "Driver's License"). Omitting renders "Government ID". */
  govIdTypeLabel?: string;
  /** Optional callback fired on successful save. Defaults to a
   *  visible toast; the parent page may override to integrate with a
   *  global toast system. */
  onSaved?: (result: UpdateCustomerContactResult) => void;
}

/**
 * Helper: shallow string-trim equality check for the dirty-state
 * guard. Two strings are equivalent when their trimmed values match —
 * this lets the form distinguish "user typed exactly the existing
 * value with leading whitespace" (still clean) from "user changed a
 * single character" (dirty).
 */
function trimmedEqual(
  a: string | undefined,
  b: string | undefined,
): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

export function CustomerAccountForm({
  initialFullName,
  initialPhone,
  initialEmail,
  initialAddress,
  govIdLast4,
  govIdTypeLabel,
  onSaved,
}: CustomerAccountFormProps) {
  // Reactive snapshot — the form re-syncs its read-only identity
  // fields if the server-side record changes (e.g. staff updates the
  // customer's name from the office; the portal reflects it on the
  // next subscription tick).
  const liveProfile = useQuery(getCurrentCustomerRef, {});

  const updateCustomerContact = useMutation(updateCustomerContactRef);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Build the form's default values from the initial props (server-
  // rendered fallback) AND the reactive snapshot (live). The live
  // snapshot wins once it resolves so the form always reflects the
  // latest server state.
  const defaultValues = useMemo<AccountFormValues>(
    () => ({
      phone: initialPhone ?? "",
      email: liveProfile?.email ?? initialEmail ?? "",
      addressLine1: initialAddress?.line1 ?? "",
      barangay: initialAddress?.barangay ?? "",
      cityMunicipality: initialAddress?.cityMunicipality ?? "",
      province: initialAddress?.province ?? "",
      postalCode: initialAddress?.postalCode ?? "",
    }),
    [initialPhone, initialEmail, initialAddress, liveProfile?.email],
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    control,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormValues>({
    resolver: zodResolver(accountFormSchema),
    defaultValues,
    mode: "onBlur",
  });

  // When the live profile resolves AFTER the form mounts, reset the
  // defaults so the editable email field reflects the live value. We
  // do this once per change to avoid clobbering in-flight edits.
  const liveEmail = liveProfile?.email;
  useEffect(() => {
    if (liveEmail !== undefined && liveEmail !== defaultValues.email) {
      reset({ ...defaultValues, email: liveEmail });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveEmail]);

  // Watch the editable fields so the Save button can be disabled until
  // the user makes a meaningful change.
  const watchedPhone = watch("phone");
  const watchedEmail = watch("email");
  const watchedAddressLine1 = watch("addressLine1");
  const watchedBarangay = watch("barangay");
  const watchedCity = watch("cityMunicipality");
  const watchedProvince = watch("province");
  const watchedPostal = watch("postalCode");

  const isDirty =
    !trimmedEqual(watchedPhone, initialPhone) ||
    !trimmedEqual(watchedEmail, liveProfile?.email ?? initialEmail) ||
    !trimmedEqual(watchedAddressLine1, initialAddress?.line1) ||
    !trimmedEqual(watchedBarangay, initialAddress?.barangay) ||
    !trimmedEqual(watchedCity, initialAddress?.cityMunicipality) ||
    !trimmedEqual(watchedProvince, initialAddress?.province) ||
    !trimmedEqual(watchedPostal, initialAddress?.postalCode);

  const handleValidSubmit = async (
    values: AccountFormValues,
  ): Promise<void> => {
    setSubmitError(null);
    setSuccessMessage(null);
    try {
      // Build the mutation payload from ONLY the fields the user
      // changed. The server's allow-list patch ignores anything
      // outside `phone` / `email` / `address` even if a malicious
      // client smuggled extra keys, but building a clean payload here
      // keeps the audit row's before/after diff tight.
      const payload: UpdateCustomerContactArgs = {};

      const phoneTrimmed = values.phone.trim();
      if (!trimmedEqual(phoneTrimmed, initialPhone)) {
        if (phoneTrimmed.length > 0) {
          payload.phone = phoneTrimmed;
        }
        // Empty trimmed phone means "clear my phone" — Phase 3 doesn't
        // support clearing optional fields through the customer
        // portal (FR58 reads as "update", not "delete"). Treat empty
        // as no-op rather than send an empty string to the server.
      }

      const emailTrimmed = values.email.trim();
      const emailBaseline = liveProfile?.email ?? initialEmail;
      if (!trimmedEqual(emailTrimmed, emailBaseline)) {
        if (emailTrimmed.length > 0) {
          payload.email = emailTrimmed;
        }
      }

      const addressDirty =
        !trimmedEqual(values.addressLine1, initialAddress?.line1) ||
        !trimmedEqual(values.barangay, initialAddress?.barangay) ||
        !trimmedEqual(values.cityMunicipality, initialAddress?.cityMunicipality) ||
        !trimmedEqual(values.province, initialAddress?.province) ||
        !trimmedEqual(values.postalCode, initialAddress?.postalCode);
      if (addressDirty) {
        const nextAddress: NonNullable<UpdateCustomerContactArgs["address"]> = {
          line1: values.addressLine1.trim(),
        };
        if (values.barangay.trim().length > 0) {
          nextAddress.barangay = values.barangay.trim();
        }
        if (values.cityMunicipality.trim().length > 0) {
          nextAddress.cityMunicipality = values.cityMunicipality.trim();
        }
        if (values.province.trim().length > 0) {
          nextAddress.province = values.province.trim();
        }
        if (values.postalCode.trim().length > 0) {
          nextAddress.postalCode = values.postalCode.trim();
        }
        payload.address = nextAddress;
      }

      // No-op short-circuit (defense in depth — the Save button is
      // disabled when isDirty is false). If nothing changed, surface
      // a friendly message rather than fire a noop mutation.
      if (
        payload.phone === undefined &&
        payload.email === undefined &&
        payload.address === undefined
      ) {
        setSuccessMessage("Your record stands as it was. Nothing to commit.");
        return;
      }

      const result = await updateCustomerContact(payload);
      setSuccessMessage("Your details have been updated in the estate record.");
      reset(values, { keepValues: true, keepDirty: false });
      if (onSaved) {
        onSaved(result);
      }
    } catch (err) {
      const translated = translateError(err);
      setSubmitError(translated.detail);
    }
  };

  const displayName = liveProfile?.fullName ?? initialFullName ?? "";
  const govIdLabel = govIdTypeLabel ?? "Government ID";
  const govIdDisplay =
    govIdLast4 !== undefined && govIdLast4.length > 0
      ? `***-***-${govIdLast4}`
      : "•••• •••• ••••";

  return (
    <form
      onSubmit={handleSubmit(handleValidSubmit)}
      noValidate
      aria-label="Customer account contact info form"
      className="space-y-6"
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="customer-account-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}
      {successMessage !== null && (
        <div
          role="status"
          data-testid="customer-account-success"
          aria-live="polite"
          className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-800"
        >
          {successMessage}
        </div>
      )}

      {/* Read-only identity fieldset (AC1) */}
      <fieldset className="space-y-3 rounded-md border border-surface-border bg-surface-muted p-4">
        <legend className="px-2 text-sm font-medium text-text-default">
          Identity (held by the estate)
        </legend>
        <p className="px-2 text-xs text-text-muted">
          Amendments to these fields are made through the Estate Office,
          in person and with due verification.
        </p>

        <ReadOnlyField
          id="customer-account-fullname"
          label="Full name"
          value={displayName}
        />
        <ReadOnlyField
          id="customer-account-govid"
          label={govIdLabel}
          value={govIdDisplay}
        />
      </fieldset>

      {/* Editable contact fieldset */}
      <fieldset className="space-y-4 rounded-md border border-surface-border p-4">
        <legend className="px-2 text-sm font-medium text-text-default">
          By what means the estate may reach you
        </legend>

        <Field
          id="customer-account-phone"
          label="Phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="+63 9XX XXX XXXX"
          error={errors.phone?.message}
          register={register("phone")}
        />

        <Field
          id="customer-account-email"
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email?.message}
          register={register("email")}
        />

        <Controller
          control={control}
          name="addressLine1"
          render={({ field }) => (
            <div className="space-y-1">
              <label
                htmlFor="customer-account-address-line1"
                className="block text-sm font-medium text-text-default"
              >
                Address line 1
                <span className="ml-1 text-red-600">*</span>
              </label>
              <textarea
                id="customer-account-address-line1"
                rows={2}
                autoComplete="street-address"
                aria-invalid={errors.addressLine1 !== undefined}
                aria-describedby={
                  errors.addressLine1 !== undefined
                    ? "customer-account-address-line1-error"
                    : undefined
                }
                value={field.value}
                onChange={field.onChange}
                onBlur={field.onBlur}
                className={cn(
                  "block w-full rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm min-h-[48px]",
                  "focus:border-text-default focus:outline-none focus:ring-2 focus:ring-focus-ring focus:ring-offset-1",
                  errors.addressLine1 !== undefined && "border-red-400",
                )}
              />
              {errors.addressLine1 !== undefined && (
                <p
                  id="customer-account-address-line1-error"
                  className="text-xs text-red-600"
                >
                  {errors.addressLine1.message}
                </p>
              )}
            </div>
          )}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            id="customer-account-barangay"
            label="Barangay"
            autoComplete="address-level3"
            error={errors.barangay?.message}
            register={register("barangay")}
          />
          <Field
            id="customer-account-city"
            label="City / Municipality"
            autoComplete="address-level2"
            error={errors.cityMunicipality?.message}
            register={register("cityMunicipality")}
          />
          <Field
            id="customer-account-province"
            label="Province"
            autoComplete="address-level1"
            error={errors.province?.message}
            register={register("province")}
          />
          <Field
            id="customer-account-postal"
            label="Postal code"
            autoComplete="postal-code"
            error={errors.postalCode?.message}
            register={register("postalCode")}
          />
        </div>
      </fieldset>

      <div className="flex items-center justify-end pt-2">
        <button
          type="submit"
          disabled={isSubmitting || !isDirty}
          aria-busy={isSubmitting}
          className={cn(
            "min-h-[48px] rounded-md px-5 py-2 text-sm font-medium",
            "bg-text-default text-white",
            "disabled:cursor-not-allowed disabled:opacity-60",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2",
          )}
        >
          {isSubmitting ? "Committing to the record…" : "Commit to the record"}
        </button>
      </div>
    </form>
  );
}

/**
 * Read-only field — labelled input with `readOnly` + `aria-readonly`.
 * The visible state matches the screen-reader state (NFR-A1 / NFR-A2).
 * The value is rendered into the input rather than a `<p>` so the
 * styling stays consistent with editable fields, but the input is
 * never registered with RHF so its value never reaches the submit
 * payload.
 */
function ReadOnlyField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-text-default"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        readOnly
        aria-readonly="true"
        value={value}
        tabIndex={-1}
        className={cn(
          "block w-full rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm min-h-[48px]",
          "text-text-muted",
        )}
      />
    </div>
  );
}

/**
 * Editable field — labelled input wired to a RHF register payload.
 * Mirrors `CustomerForm`'s `FieldText` shape but uses the portal's
 * mobile-first 48px touch target (NFR-A4) and the portal's
 * design-token classes (`text-text-default`, `border-surface-border`).
 */
function Field({
  id,
  label,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  error,
  register,
}: {
  id: string;
  label: string;
  type?: "text" | "tel" | "email";
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "tel" | "email" | "text";
  error?: string;
  register: {
    name: string;
    onChange: React.ChangeEventHandler<HTMLInputElement>;
    onBlur: React.FocusEventHandler<HTMLInputElement>;
    ref: React.Ref<HTMLInputElement>;
  };
}) {
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="block text-sm font-medium text-text-default"
      >
        {label}
      </label>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${id}-error` : undefined}
        name={register.name}
        onChange={register.onChange}
        onBlur={register.onBlur}
        ref={register.ref}
        className={cn(
          "block w-full rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm min-h-[48px]",
          "focus:border-text-default focus:outline-none focus:ring-2 focus:ring-focus-ring focus:ring-offset-1",
          error !== undefined && "border-red-400",
        )}
      />
      {error !== undefined && (
        <p id={`${id}-error`} className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
