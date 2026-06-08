"use client";

/**
 * UserForm — Story 1.3.
 *
 * React Hook Form + Zod. Used by the admin /admin/users page's "New
 * user" dialog. Submits to the parent's `onSubmit` callback; the
 * parent owns the Convex mutation call.
 *
 * Why the parent owns the mutation:
 *   - The form is unit-testable without a Convex client mock.
 *   - On success the parent shows a one-time temp-password dialog
 *     (the cleartext password lives in the response, never on the
 *     form). Keeping that flow in the parent stops the form from
 *     leaking the password into its own state or display.
 *
 * Fields:
 *   - Name (text, required)
 *   - Email (email, required)
 *   - Roles (checkbox group, at least one required)
 *
 * Story 1.3 ships only the create flow. Edit-roles uses a separate
 * compact dialog (see `EditRolesDialog`), not this form — name/email
 * edits are out of scope for the story.
 */

import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import {
  ROLE_LABELS,
  STAFF_ROLE_OPTIONS,
  userFormSchema,
  type StaffRole,
  type UserFormValues,
} from "./schema";

export interface UserFormSubmitPayload {
  name: string;
  email: string;
  roles: StaffRole[];
}

export interface UserFormProps {
  /**
   * Parent-supplied submit handler. Receives the validated payload.
   * May throw a `ConvexError` — the form translates it via
   * `translateError` and surfaces an inline alert.
   */
  onSubmit: (payload: UserFormSubmitPayload) => Promise<void>;
  /** Called when the user clicks the secondary "Cancel" button. */
  onCancel?: () => void;
}

const EMPTY_DEFAULTS: UserFormValues = {
  name: "",
  email: "",
  roles: [],
};

export function UserForm({ onSubmit, onCancel }: UserFormProps) {
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: EMPTY_DEFAULTS,
  });

  const handleValidSubmit = async (values: UserFormValues): Promise<void> => {
    setSubmitError(null);
    try {
      await onSubmit({
        name: values.name.trim(),
        email: values.email.trim().toLowerCase(),
        roles: values.roles,
      });
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
      aria-label="New user form"
    >
      {submitError !== null && (
        <div
          role="alert"
          data-testid="user-form-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {submitError}
        </div>
      )}

      <div className="space-y-1">
        <label
          htmlFor="user-name"
          className="block text-sm font-medium text-slate-700"
        >
          Name
        </label>
        <input
          id="user-name"
          type="text"
          autoComplete="off"
          aria-invalid={errors.name !== undefined}
          aria-describedby={
            errors.name !== undefined ? "user-name-error" : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.name !== undefined && "border-red-400",
          )}
          {...register("name")}
        />
        {errors.name !== undefined && (
          <p id="user-name-error" className="text-xs text-red-600">
            {errors.name.message}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label
          htmlFor="user-email"
          className="block text-sm font-medium text-slate-700"
        >
          Email
        </label>
        <input
          id="user-email"
          type="email"
          autoComplete="off"
          aria-invalid={errors.email !== undefined}
          aria-describedby={
            errors.email !== undefined ? "user-email-error" : undefined
          }
          className={cn(
            "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm",
            "focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500",
            errors.email !== undefined && "border-red-400",
          )}
          {...register("email")}
        />
        {errors.email !== undefined && (
          <p id="user-email-error" className="text-xs text-red-600">
            {errors.email.message}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">Roles</legend>
        <Controller
          control={control}
          name="roles"
          render={({ field }) => (
            <div
              role="group"
              aria-label="Assign roles"
              className="flex flex-col gap-2"
            >
              {STAFF_ROLE_OPTIONS.map((role) => {
                const checked = field.value.includes(role);
                return (
                  <label
                    key={role}
                    className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm cursor-pointer hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      value={role}
                      checked={checked}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...field.value, role]
                          : field.value.filter((r) => r !== role);
                        field.onChange(next);
                      }}
                      className="h-4 w-4"
                    />
                    <span>{ROLE_LABELS[role]}</span>
                  </label>
                );
              })}
            </div>
          )}
        />
        {errors.roles !== undefined && (
          <p className="text-xs text-red-600">
            {errors.roles.message ?? "Select at least one role."}
          </p>
        )}
      </fieldset>

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
          {isSubmitting ? "Creating…" : "Create user"}
        </button>
      </div>
    </form>
  );
}
