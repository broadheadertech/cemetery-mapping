"use client";

/**
 * ReminderPreferenceToggle — Story 9.8 customer self-service surface.
 *
 * Lets a signed-in customer turn payment reminders ON or OFF for their
 * own account. Calls `reminders:updateMyReminderOptOut` (which resolves
 * the caller via the email-link identity, so there is no `customerId`
 * arg to tamper with). Optimistic toggle with inline error recovery: on
 * failure we revert the switch and surface a `role="alert"` message.
 *
 * Backend contract: `updateMyReminderOptOut({ optOut }) -> { optOut }`.
 * The page seeds `initialOptOut` from `portal:getCurrentCustomerAccount`,
 * and the reactive account query re-syncs the page if the value changes
 * elsewhere.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

const updateMyReminderOptOutRef = makeFunctionReference<
  "mutation",
  { optOut: boolean },
  { optOut: boolean }
>("reminders:updateMyReminderOptOut");

export interface ReminderPreferenceToggleProps {
  /** Current opt-OUT state from the account profile. */
  initialOptOut: boolean;
}

export function ReminderPreferenceToggle({
  initialOptOut,
}: ReminderPreferenceToggleProps) {
  const updateOptOut = useMutation(updateMyReminderOptOutRef);
  // We model the UI on "reminders ON" (the inverse of opt-OUT) because
  // that's the affirmative thing the customer recognises.
  const [remindersOn, setRemindersOn] = useState(!initialOptOut);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleToggle = async (): Promise<void> => {
    if (pending) return;
    const nextRemindersOn = !remindersOn;
    setRemindersOn(nextRemindersOn); // optimistic
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      await updateOptOut({ optOut: !nextRemindersOn });
      setSaved(true);
    } catch (err) {
      setRemindersOn(!nextRemindersOn); // revert
      setError(translateError(err).detail);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="rounded-md border border-surface-border bg-surface-default p-5"
      data-testid="reminder-preference"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text-default">
            Payment reminders
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            When enabled, the estate will email you ahead of an
            installment&apos;s due date. You may turn these off at any time;
            your contracts and balances remain viewable here regardless.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={remindersOn}
          aria-label="Receive payment reminder emails"
          onClick={handleToggle}
          disabled={pending}
          data-testid="reminder-preference-switch"
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 ${
            remindersOn ? "bg-brand-primary" : "bg-surface-muted"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              remindersOn ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
      <p className="mt-3 text-xs text-text-muted" aria-live="polite">
        {remindersOn
          ? "Reminders are ON for this account."
          : "Reminders are OFF — you will not receive payment reminder emails."}
      </p>
      {saved && error === null && (
        <p
          role="status"
          className="mt-1 text-xs text-emerald-700"
          data-testid="reminder-preference-saved"
        >
          Preference saved.
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          className="mt-1 text-xs text-red-700"
          data-testid="reminder-preference-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
