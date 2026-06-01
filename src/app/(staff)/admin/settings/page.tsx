"use client";

/**
 * /admin/settings — admin-toggle home (Story 6.3).
 *
 * Surfaces runtime config flags that the cemetery admin can flip
 * without a redeploy. Each toggle binds to a field on the singleton
 * `appSettings` row in Convex.
 *
 * Phase 2 surface:
 *   - `salesAgentTrackingEnabled` (§10 Q5 pending). Off by default.
 *     When on, the /reports/sales report renders the per-agent
 *     breakdown branch. The server query also strips agent data when
 *     the toggle is off — defense in depth.
 *
 * Future settings (deactivate-not-delete, expensesRequireApproval,
 * etc.) land here as additional toggle rows.
 *
 * Auth: middleware gates `/admin/*` at the edge; the Convex query +
 * mutation both call `requireRole(["admin"])`.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

interface AppSettings {
  salesAgentTrackingEnabled: boolean;
}

const getAppSettingsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AppSettings
>("reports:getAppSettings");

const setSalesAgentTrackingRef = makeFunctionReference<
  "mutation",
  { enabled: boolean },
  AppSettings
>("reports:setSalesAgentTracking");

export default function AdminSettingsPage(): React.ReactElement {
  const settings = useQuery(getAppSettingsRef, {});
  const setTracking = useMutation(setSalesAgentTrackingRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await setTracking({ enabled });
    } catch (err) {
      const t = translateError(err);
      setError(`${t.headline}: ${t.detail}`);
    } finally {
      setBusy(false);
    }
  };

  const isLoading = settings === undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          Admin settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Runtime toggles for cemetery operations. Changes take effect
          immediately for everyone signed in.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          data-testid="settings-error"
        >
          {error}
        </div>
      )}

      <section className="rounded-md border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-900">
              Sales agent tracking
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              When enabled, the sales-by-dimension report shows a
              per-agent breakdown under each section. Requires
              recording agent attribution on sales — §10 Q5 pending.
              Leave off until the commission tracking policy is
              decided.
            </p>
          </div>
          <label className="inline-flex items-center gap-3">
            <span className="text-sm text-slate-700" id="agent-toggle-label">
              {settings?.salesAgentTrackingEnabled ? "Enabled" : "Disabled"}
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings?.salesAgentTrackingEnabled ?? false}
              disabled={isLoading || busy}
              aria-labelledby="agent-toggle-label"
              onChange={(e) => handleToggle(e.target.checked)}
              className="h-5 w-9 cursor-pointer appearance-none rounded-full bg-slate-300 transition-colors checked:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="settings-sales-agent-tracking"
            />
          </label>
        </div>
      </section>
    </div>
  );
}
