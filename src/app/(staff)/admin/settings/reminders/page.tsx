"use client";

/**
 * /admin/settings/reminders — payment-reminder cadence (Story 9.8, FR57).
 *
 * Admin surface for the singleton `reminderConfig` row:
 *   - Global pause switch → `reminders:setRemindersPaused` (immediate).
 *   - Editable cadence rules (offset days, channel, template, enabled)
 *     + the daily send hour → saved via `reminders:updateReminderConfig`.
 *
 * Auth: middleware gates `/admin/*`; both Convex functions also call
 * `requireRole(["admin"])`. The customer-facing opt-out lives on
 * `/portal/account`; the bounced-email follow-up list on
 * `/admin/reports/email-bounces`.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

type Channel = "sms" | "email" | "both";

interface Rule {
  daysOffset: number;
  requiresUnpaid: boolean;
  channel: Channel;
  templateKey: string;
  enabled: boolean;
}

interface ReminderConfig {
  rules: Rule[];
  timezone: string;
  sendHour: number;
  paused?: boolean;
}

const getReminderConfigRef = makeFunctionReference<
  "query",
  Record<string, never>,
  ReminderConfig | null
>("reminders:getReminderConfig");

const updateReminderConfigRef = makeFunctionReference<
  "mutation",
  { rules: Rule[]; timezone?: string; sendHour?: number },
  { updatedAt: number }
>("reminders:updateReminderConfig");

const setRemindersPausedRef = makeFunctionReference<
  "mutation",
  { paused: boolean },
  { paused: boolean }
>("reminders:setRemindersPaused");

const CHANNELS: Channel[] = ["email", "sms", "both"];

function blankRule(): Rule {
  return {
    daysOffset: 0,
    requiresUnpaid: true,
    channel: "email",
    templateKey: "due_today_email",
    enabled: true,
  };
}

export default function ReminderSettingsPage() {
  const config = useQuery(getReminderConfigRef, {});
  const save = useMutation(updateReminderConfigRef);
  const setPaused = useMutation(setRemindersPausedRef);

  const [rules, setRules] = useState<Rule[]>([]);
  const [sendHour, setSendHour] = useState(9);
  const [busy, setBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed local form state from the server config on first resolve.
  useEffect(() => {
    if (config === undefined || config === null) return;
    setRules(config.rules);
    setSendHour(config.sendHour);
  }, [config]);

  const updateRule = (i: number, patch: Partial<Rule>): void => {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const handleSave = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await save({ rules, sendHour });
      setSaved(true);
    } catch (err) {
      setError(translateError(err).detail);
    } finally {
      setBusy(false);
    }
  };

  const handlePauseToggle = async (paused: boolean): Promise<void> => {
    setPauseBusy(true);
    setError(null);
    try {
      await setPaused({ paused });
    } catch (err) {
      setError(translateError(err).detail);
    } finally {
      setPauseBusy(false);
    }
  };

  const loading = config === undefined;
  const noConfigYet = config === null;
  const paused = config?.paused === true;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Payment reminders</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Controls the daily scan that emails customers about upcoming and
          overdue installments. Customers can opt out individually from
          their portal; hard-bounced addresses are skipped automatically.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          data-testid="reminders-error"
        >
          {error}
        </div>
      )}

      {/* Global pause switch */}
      <section className="rounded-md border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Reminder delivery
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              The deployment-wide stop switch. When paused, the daily scan
              short-circuits and sends nothing — use it during a
              deliverability incident.
            </p>
            <p className="mt-2 text-sm font-medium" aria-live="polite">
              {paused ? (
                <span className="text-rose-700">⏸ Reminders are PAUSED</span>
              ) : (
                <span className="text-emerald-700">● Reminders are active</span>
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!paused}
            aria-label="Reminder delivery active"
            disabled={loading || noConfigYet || pauseBusy}
            onClick={() => handlePauseToggle(!paused)}
            data-testid="reminders-pause-switch"
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              !paused ? "bg-emerald-600" : "bg-slate-300"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                !paused ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        {noConfigYet && (
          <p className="mt-3 text-xs text-amber-700">
            No cadence saved yet — save the rules below first; the pause
            switch activates once a config exists.
          </p>
        )}
      </section>

      {/* Cadence rules */}
      <section className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Cadence rules</h2>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Send at
            <input
              type="number"
              min={0}
              max={23}
              value={sendHour}
              onChange={(e) => {
                setSendHour(Number(e.target.value));
                setSaved(false);
              }}
              className="w-16 rounded border border-slate-300 px-2 py-1 tabular-nums"
              data-testid="reminders-send-hour"
            />
            :00 ({config?.timezone ?? "Asia/Manila"})
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            <div className="space-y-3" data-testid="reminders-rules">
              {rules.map((r, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-3 rounded border border-slate-200 p-3"
                  data-testid="reminders-rule-row"
                >
                  <label className="flex items-center gap-1 text-sm text-slate-700">
                    Offset
                    <input
                      type="number"
                      value={r.daysOffset}
                      onChange={(e) =>
                        updateRule(i, { daysOffset: Number(e.target.value) })
                      }
                      className="w-16 rounded border border-slate-300 px-2 py-1 tabular-nums"
                    />
                    <span className="text-xs text-slate-500">
                      days {r.daysOffset < 0 ? "before" : r.daysOffset > 0 ? "after" : "on"} due
                    </span>
                  </label>
                  <label className="flex items-center gap-1 text-sm text-slate-700">
                    Channel
                    <select
                      value={r.channel}
                      onChange={(e) =>
                        updateRule(i, { channel: e.target.value as Channel })
                      }
                      className="rounded border border-slate-300 px-2 py-1"
                    >
                      {CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    type="text"
                    value={r.templateKey}
                    onChange={(e) => updateRule(i, { templateKey: e.target.value })}
                    className="min-w-[12rem] flex-1 rounded border border-slate-300 px-2 py-1 font-mono text-xs"
                    aria-label="Template key"
                  />
                  <label className="flex items-center gap-1 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => updateRule(i, { enabled: e.target.checked })}
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setRules((prev) => prev.filter((_, idx) => idx !== i));
                      setSaved(false);
                    }}
                    className="ml-auto text-sm text-rose-700 hover:underline"
                    data-testid="reminders-remove-rule"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {rules.length === 0 && (
                <p className="text-sm text-slate-500">
                  No rules. Add one to start sending reminders.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setRules((prev) => [...prev, blankRule()]);
                  setSaved(false);
                }}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                data-testid="reminders-add-rule"
              >
                + Add rule
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={busy}
                className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                data-testid="reminders-save"
              >
                {busy ? "Saving…" : "Save cadence"}
              </button>
              {saved && (
                <span className="text-sm text-emerald-700" data-testid="reminders-saved">
                  Saved.
                </span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
