"use client";

/**
 * /admin/settings/payment-gateways — GCash, Maya, and card credentials.
 *
 * The reason this page exists: the adapters have always had live fetch
 * paths, but their credentials came from environment variables, which
 * means `npx convex env set` from a developer's terminal. The cemetery
 * has no developer on staff. Go-live and every later key rotation
 * would have meant calling one, and a webhook secret nobody on site
 * can rotate is a secret that never gets rotated.
 *
 * Secrets are write-only here. The page shows a masked preview
 * (`••••1234`) and never the value — leaving a secret field blank
 * keeps whatever is stored, so editing the base URL cannot silently
 * wipe the key. Clearing one is deliberate: tick "clear".
 *
 * Where a gateway reads `From environment`, these fields are ignored.
 * That precedence is intentional — an operator who keeps credentials
 * in the Convex environment (the stronger posture) must not have them
 * overridden by a later edit here.
 */

import { useCallback, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
import { formatDate } from "@/lib/time";

type GatewayId = "gcash" | "maya" | "card";
type Mode = "sandbox" | "live";

interface GatewaySummary {
  gateway: GatewayId;
  apiBaseUrl: string;
  apiKeyMasked: string;
  webhookSecretMasked: string;
  hasApiKey: boolean;
  hasWebhookSecret: boolean;
  isEnabled: boolean;
  mode: Mode;
  source: "env" | "database" | "unset";
  updatedAt: number | null;
}

const listRef = makeFunctionReference<
  "query",
  Record<string, never>,
  GatewaySummary[]
>("paymentGatewayConfig:listGatewayConfigs");

const updateRef = makeFunctionReference<
  "mutation",
  {
    gateway: GatewayId;
    apiBaseUrl: string;
    apiKey?: string;
    webhookSecret?: string;
    isEnabled: boolean;
    mode: Mode;
  },
  { saved: true }
>("paymentGatewayConfig:updateGatewayConfig");

const LABELS: Record<GatewayId, string> = {
  gcash: "GCash",
  maya: "Maya",
  card: "Card processor",
};

export default function PaymentGatewaysPage(): ReactElement {
  const configs = useQuery(listRef, {});

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Payment gateways
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Credentials for the online payment routes in the customer portal.
          Until a gateway has a base URL and an API key and is switched on,
          portal payments through it will not reach the provider.
        </p>
      </header>

      <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">These are live credentials.</p>
        <p className="mt-1">
          Anything saved here is stored in the database rather than the
          deployment environment, which is a weaker place to keep a secret.
          It is the trade-off for being able to set up and rotate keys
          without a developer. If your operator prefers the stronger
          arrangement, set the environment variables instead — a gateway
          reading{" "}
          <span className="font-medium">From environment</span> ignores this
          page entirely.
        </p>
      </div>

      {configs === undefined && (
        <div className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600">
          Loading…
        </div>
      )}

      {configs !== undefined &&
        configs.map((config) => (
          <GatewayCard key={config.gateway} config={config} />
        ))}
    </div>
  );
}

function GatewayCard({
  config,
}: {
  config: GatewaySummary;
}): ReactElement {
  const update = useMutation(updateRef);

  const [apiBaseUrl, setApiBaseUrl] = useState(config.apiBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearWebhookSecret, setClearWebhookSecret] = useState(false);
  const [isEnabled, setIsEnabled] = useState(config.isEnabled);
  const [mode, setMode] = useState<Mode>(config.mode);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const fromEnv = config.source === "env";

  const onSave = useCallback(async (): Promise<void> => {
    setStatus({ kind: "saving" });
    try {
      const args: {
        gateway: GatewayId;
        apiBaseUrl: string;
        apiKey?: string;
        webhookSecret?: string;
        isEnabled: boolean;
        mode: Mode;
      } = { gateway: config.gateway, apiBaseUrl, isEnabled, mode };
      // Omit to keep, "" to clear, a value to rotate.
      if (clearApiKey) args.apiKey = "";
      else if (apiKey.length > 0) args.apiKey = apiKey;
      if (clearWebhookSecret) args.webhookSecret = "";
      else if (webhookSecret.length > 0) args.webhookSecret = webhookSecret;

      await update(args);
      setApiKey("");
      setWebhookSecret("");
      setClearApiKey(false);
      setClearWebhookSecret(false);
      setStatus({ kind: "saved" });
    } catch (err) {
      setStatus({ kind: "error", message: translateError(err).detail });
    }
  }, [
    apiBaseUrl,
    apiKey,
    clearApiKey,
    clearWebhookSecret,
    config.gateway,
    isEnabled,
    mode,
    update,
    webhookSecret,
  ]);

  return (
    <section
      data-testid={`gateway-card-${config.gateway}`}
      className="rounded-md border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {LABELS[config.gateway]}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <SourceBadge source={config.source} />
            {config.source !== "unset" && (
              <span
                className={`rounded px-1.5 py-0.5 font-medium ${
                  config.isEnabled
                    ? "bg-emerald-100 text-emerald-900"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                {config.isEnabled ? "On" : "Off"}
              </span>
            )}
            {config.source !== "unset" && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                {config.mode === "live" ? "Live" : "Sandbox"}
              </span>
            )}
            {config.updatedAt !== null && (
              <span className="text-slate-500">
                updated {formatDate(config.updatedAt, "datetime")}
              </span>
            )}
          </div>
        </div>
      </div>

      {fromEnv ? (
        <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Configured by environment variables (
          <code className="text-xs">
            {config.gateway.toUpperCase()}_API_BASE_URL
          </code>
          ). Changes here would be ignored, so the form is hidden. Unset the
          environment variables to manage this gateway from the UI.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <Labelled label="API base URL" hint="Must start with https://">
            <input
              type="url"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="https://api.provider.example/v1"
              className="block w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </Labelled>

          <SecretField
            label="API key"
            stored={config.apiKeyMasked}
            hasStored={config.hasApiKey}
            value={apiKey}
            onChange={setApiKey}
            clear={clearApiKey}
            onClearChange={setClearApiKey}
            testId={`${config.gateway}-api-key`}
          />

          <SecretField
            label="Webhook signing secret"
            stored={config.webhookSecretMasked}
            hasStored={config.hasWebhookSecret}
            value={webhookSecret}
            onChange={setWebhookSecret}
            clear={clearWebhookSecret}
            onClearChange={setClearWebhookSecret}
            testId={`${config.gateway}-webhook-secret`}
          />

          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => setIsEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Accept payments through {LABELS[config.gateway]}
            </label>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              Mode
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              >
                <option value="sandbox">Sandbox</option>
                <option value="live">Live</option>
              </select>
            </label>
          </div>

          {status.kind === "error" && (
            <div
              role="alert"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
            >
              {status.message}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={status.kind === "saving"}
              data-testid={`save-${config.gateway}`}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {status.kind === "saving" ? "Saving…" : "Save"}
            </button>
            {status.kind === "saved" && (
              <span className="text-sm text-emerald-700">Saved.</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SourceBadge({
  source,
}: {
  source: GatewaySummary["source"];
}): ReactElement {
  if (source === "env") {
    return (
      <span className="rounded bg-slate-900 px-1.5 py-0.5 font-medium text-white">
        From environment
      </span>
    );
  }
  if (source === "database") {
    return (
      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
        Configured here
      </span>
    );
  }
  return (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900">
      Not configured
    </span>
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <div className="space-y-1">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint !== undefined && (
        <p className="text-xs text-slate-500">{hint}</p>
      )}
    </div>
  );
}

/**
 * Write-only secret input. The stored value is never rendered — only
 * its masked tail — so a blank field has to mean "leave it alone".
 * Clearing is a separate, explicit tick.
 */
function SecretField({
  label,
  stored,
  hasStored,
  value,
  onChange,
  clear,
  onClearChange,
  testId,
}: {
  label: string;
  stored: string;
  hasStored: boolean;
  value: string;
  onChange: (v: string) => void;
  clear: boolean;
  onClearChange: (v: boolean) => void;
  testId: string;
}): ReactElement {
  return (
    <div className="space-y-1">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={clear}
        autoComplete="new-password"
        data-testid={testId}
        placeholder={
          hasStored ? `Stored (${stored}) — leave blank to keep` : "Not set"
        }
        className="block w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50"
      />
      {hasStored && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={clear}
            onChange={(e) => onClearChange(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-slate-300"
          />
          Clear the stored value
        </label>
      )}
    </div>
  );
}
