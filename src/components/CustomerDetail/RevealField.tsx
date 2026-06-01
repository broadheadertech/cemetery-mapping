"use client";

/**
 * RevealField — Story 2.5 AC2.
 *
 * Click-to-reveal gov-ID display. Default state shows the masked form
 * `***-***-LAST4`; clicking "Reveal" calls the server `revealGovId`
 * mutation (NOT a query — see explanation in
 * `convex/customers.ts:revealGovId`) which logs the access via Story
 * 2.3's `logPiiAccess` and returns the full gov-ID number. The full
 * value is displayed for exactly 30 seconds, then re-redacted via a
 * local `setTimeout`. Each click is its own logged access; hovering /
 * focusing does not re-fetch.
 *
 * The 30-second hide is the UX-DR30 contract — the audit trail's
 * "clicked and held for 30 s" semantics depend on this duration. Do
 * NOT change without updating the spec.
 *
 * Why a mutation (not a `useQuery`):
 *   A reactive subscription on `revealGovId` would re-fire on every
 *   server tick, multiplying the logged accesses. The
 *   disaster-prevention note in Story 2.5 Task 6 explicitly forbids
 *   `useQuery`-based reveal. We use `useMutation` so the call is
 *   imperative — one click, one server call, one log entry.
 *
 * State machine:
 *   - `revealed === null` → masked. Button label "Reveal".
 *   - `revealed !== null` → full value shown. Button label "Hide".
 *     Local countdown ticks once per second; at 0 the effect cleans
 *     state via `setRevealed(null)`.
 *
 * Unmount safety:
 *   The cleanup in the `useEffect` clears the interval when the
 *   component unmounts mid-reveal, preventing a "setState on
 *   unmounted component" warning and ensuring the gov-ID isn't held
 *   in component state after navigation.
 */

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

const revealGovIdRef = makeFunctionReference<
  "mutation",
  { customerId: string },
  { govIdNumber: string }
>("customers:revealGovId");

/**
 * AC2 — auto-hide window. Visible for exactly 30 seconds per UX §1879
 * + the Story 2.5 spec. Off by one is the kind of bug that quietly
 * breaks the audit trail's "clicked + held for 30 s" semantics, so
 * keep the constant as an absolute integer.
 */
export const REVEAL_HIDE_MS = 30_000;

export interface RevealFieldProps {
  customerId: string;
  govIdLast4: string;
}

interface RevealState {
  value: string;
  expiresAt: number;
}

export function RevealField({ customerId, govIdLast4 }: RevealFieldProps) {
  const reveal = useMutation(revealGovIdRef);
  const [revealed, setRevealed] = useState<RevealState | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-hide + countdown effect. Runs only while a reveal is active.
  // The countdown is purely cosmetic ("Visible for 28 s"); the actual
  // hide trigger is the absolute `expiresAt` comparison, not the
  // counter. Storing `expiresAt` rather than a duration keeps the
  // timing correct across React re-renders.
  useEffect(() => {
    if (revealed === null) {
      setSecondsRemaining(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, revealed.expiresAt - Date.now());
      const secs = Math.ceil(remaining / 1000);
      setSecondsRemaining(secs);
      if (remaining <= 0) {
        setRevealed(null);
      }
    };
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [revealed]);

  const handleReveal = useCallback(async () => {
    if (revealed !== null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reveal({ customerId });
      setRevealed({
        value: result.govIdNumber,
        expiresAt: Date.now() + REVEAL_HIDE_MS,
      });
    } catch (err) {
      const translated = translateError(err);
      setError(translated.detail);
    } finally {
      setBusy(false);
    }
  }, [customerId, reveal, revealed]);

  const handleHide = useCallback(() => {
    setRevealed(null);
    setError(null);
  }, []);

  const isRevealed = revealed !== null;
  const buttonLabel = isRevealed ? "Hide" : busy ? "Revealing…" : "Reveal";
  const ariaLabel = isRevealed
    ? "Hide gov-ID number"
    : "Reveal full gov-ID number; access will be logged";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="font-mono text-sm tracking-wider text-slate-900"
          data-testid="reveal-value"
        >
          {isRevealed ? revealed.value : `***-***-${govIdLast4}`}
        </span>
        <button
          type="button"
          onClick={isRevealed ? handleHide : handleReveal}
          disabled={busy}
          aria-label={ariaLabel}
          data-testid="reveal-button"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      </div>
      {isRevealed && (
        <p
          className="text-xs text-slate-500"
          aria-live="polite"
          data-testid="reveal-countdown"
        >
          Visible for {secondsRemaining}s
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          data-testid="reveal-error"
        >
          {error}
        </p>
      )}
    </div>
  );
}
