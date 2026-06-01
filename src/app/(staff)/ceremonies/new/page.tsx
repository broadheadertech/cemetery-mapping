"use client";

/**
 * /ceremonies/new -- schedule a consecration (or, forward-compat,
 * any kind) ceremony for a contract (Story 7.5 AC2).
 *
 * Reads `?contractId=...` and `?kind=...` from the query string. The
 * page renders a thin form (date / time / duration / chapel + pathway
 * toggles / consultant / notes) and dispatches
 * `api.ceremonies.scheduleCeremony` on submit. On success: redirect
 * to `/ceremonies/[ceremonyId]`.
 *
 * Auth: (staff) layout gates the route at the auth boundary;
 * `scheduleCeremony` enforces the office_staff / admin role.
 *
 * Manila tz: the form composes `${date}T${time}+08:00` and submits
 * epoch ms -- never a date string. Default time `08:00` matches the
 * brand-spec "morning of the twenty-eighth" example.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

type CeremonyKind = "consecration" | "interment" | "memorial_anniversary";

const scheduleCeremonyRef = makeFunctionReference<
  "mutation",
  {
    kind: CeremonyKind;
    contractId: string;
    lotId: string;
    scheduledAt: number;
    durationMinutes: number;
    chapelReserved: boolean;
    pathwayReserved: boolean;
    consultantUserId?: string;
    familyEstateId?: string;
    notes?: string;
  },
  { ceremonyId: string }
>("ceremonies:scheduleCeremony");

function composeManilaMs(date: string, time: string): number | null {
  if (date.length === 0 || time.length === 0) return null;
  // Manila has no DST; UTC+8 hardcoded matches convex/lib/time.ts policy.
  const iso = `${date}T${time}:00+08:00`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return ms;
}

function todayManilaYmd(): string {
  // Compute the YYYY-MM-DD that "today" maps to in Manila wall-clock.
  const now = Date.now();
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function NewCeremonyPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const kindParam = searchParams.get("kind");
  const initialKind: CeremonyKind =
    kindParam === "interment" || kindParam === "memorial_anniversary"
      ? kindParam
      : "consecration";
  const contractId = searchParams.get("contractId") ?? "";
  const lotId = searchParams.get("lotId") ?? "";

  const [kind, setKind] = useState<CeremonyKind>(initialKind);
  const [date, setDate] = useState<string>(todayManilaYmd());
  const [time, setTime] = useState<string>("08:00");
  const [durationMinutes, setDurationMinutes] = useState<number>(
    initialKind === "consecration" ? 90 : 60,
  );
  const [chapelReserved, setChapelReserved] = useState<boolean>(
    initialKind === "consecration",
  );
  const [pathwayReserved, setPathwayReserved] = useState<boolean>(
    initialKind === "consecration",
  );
  const [notes, setNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const scheduleCeremony = useMutation(scheduleCeremonyRef);

  const scheduledAt = useMemo(
    () => composeManilaMs(date, time),
    [date, time],
  );

  const canSubmit =
    contractId.length > 0 &&
    lotId.length > 0 &&
    scheduledAt !== null &&
    durationMinutes >= 30 &&
    durationMinutes <= 240 &&
    !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || scheduledAt === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmedNotes = notes.trim();
      const result = await scheduleCeremony({
        kind,
        contractId,
        lotId,
        scheduledAt,
        durationMinutes,
        chapelReserved,
        pathwayReserved,
        notes: trimmedNotes.length > 0 ? trimmedNotes : undefined,
      });
      router.push(`/ceremonies/${result.ceremonyId}`);
    } catch (err) {
      const tx = translateError(err);
      setSubmitError(`${tx.headline}. ${tx.detail}`);
      setSubmitting(false);
    }
  }

  if (contractId.length === 0 || lotId.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">Schedule ceremony</h1>
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          A contract and lot are required to schedule a ceremony. Open a
          contract detail page and use the &ldquo;Schedule
          consecration&rdquo; affordance there.
        </div>
        <Link
          href="/contracts"
          className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Go to contracts
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">
          {kind === "consecration"
            ? "Schedule consecration"
            : kind === "interment"
              ? "Schedule interment ceremony"
              : "Schedule memorial anniversary"}
        </h1>
        <p className="text-sm text-slate-600">
          Reserve the day, the chapel, and the consultant who will receive
          the family at the gate.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
      >
        <fieldset className="space-y-2">
          <label htmlFor="ceremony-kind" className="block text-sm font-medium">
            Ceremony type
          </label>
          <select
            id="ceremony-kind"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as CeremonyKind;
              setKind(next);
              setDurationMinutes(next === "consecration" ? 90 : 60);
              const reserveDefault = next === "consecration";
              setChapelReserved(reserveDefault);
              setPathwayReserved(reserveDefault);
            }}
            className="block w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="consecration">Consecration</option>
            <option value="interment">Interment ceremony</option>
            <option value="memorial_anniversary">Memorial anniversary</option>
          </select>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="ceremony-date" className="block text-sm font-medium">
              Date (Manila)
            </label>
            <input
              id="ceremony-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={todayManilaYmd()}
              className="block w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="ceremony-time" className="block text-sm font-medium">
              Start time
            </label>
            <input
              id="ceremony-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              step={1800}
              className="block w-full min-h-[44px] rounded-md border border-slate-300 px-3 py-2 text-sm"
              required
            />
          </div>
        </div>

        <div className="space-y-2">
          <label
            htmlFor="ceremony-duration"
            className="block text-sm font-medium"
          >
            Duration: {durationMinutes} minutes
          </label>
          <input
            id="ceremony-duration"
            type="range"
            min={30}
            max={180}
            step={15}
            value={durationMinutes}
            onChange={(e) => setDurationMinutes(Number(e.target.value))}
            className="block w-full"
          />
        </div>

        <fieldset className="space-y-3 rounded-md border border-slate-200 p-4">
          <legend className="px-1 text-sm font-medium text-slate-700">
            Shared resources
          </legend>
          <label className="flex items-start gap-3 text-sm min-h-[44px]">
            <input
              type="checkbox"
              checked={chapelReserved}
              onChange={(e) => setChapelReserved(e.target.checked)}
              className="mt-1 h-5 w-5"
            />
            <span>
              <strong className="block">Reserve the chapel for this family</strong>
              <span className="text-slate-600">
                Only one ceremony at a time may reserve the chapel.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm min-h-[44px]">
            <input
              type="checkbox"
              checked={pathwayReserved}
              onChange={(e) => setPathwayReserved(e.target.checked)}
              className="mt-1 h-5 w-5"
            />
            <span>
              <strong className="block">Reserve the eastern walking path</strong>
              <span className="text-slate-600">
                Keep the path clear for the family&rsquo;s procession.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="space-y-2">
          <label htmlFor="ceremony-notes" className="block text-sm font-medium">
            Notes (optional)
          </label>
          <textarea
            id="ceremony-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            rows={4}
            placeholder="Preparation requests, family preferences, consultant assignment."
            className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <p className="text-xs text-slate-500">
            {notes.length}/500
          </p>
        </div>

        {submitError !== null ? (
          <div
            role="alert"
            className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"
          >
            {submitError}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link
            href={`/contracts/${contractId}`}
            className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex min-h-[44px] items-center rounded-md bg-amber-700 px-4 py-2 text-sm font-medium text-white shadow hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {submitting
              ? "Scheduling…"
              : kind === "consecration"
                ? "Schedule consecration"
                : "Schedule ceremony"}
          </button>
        </div>
      </form>
    </div>
  );
}
