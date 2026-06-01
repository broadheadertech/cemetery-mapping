"use client";

/**
 * /admin/settings/bir-receipt-config — Admin edits the
 * BIR-registered identity printed on every Official Receipt.
 *
 * Admin-only. The middleware (`src/middleware.ts`) gates `/admin/*`
 * at the edge; `convex/cemeterySettings.ts` re-enforces every call
 * server-side via `requireRole(ctx, ["admin"])` (NFR-S4).
 *
 * Background: Story 3.11's adversarial review surfaced that every
 * receipt issued before this page landed used a hard-coded
 * `PLACEHOLDER_BIR_CONFIG` constant — placeholder TIN, placeholder
 * ATP, missing the BIR-mandated 5-year-validity footer. That was
 * BIR-non-compliant by construction. This page is the single edit
 * surface for the database-backed `birReceiptConfig` singleton row;
 * the receipt PDF action refuses to render while `isPlaceholder`
 * remains `true`, so the operator MUST visit this page and toggle
 * production-ready before the cemetery can issue valid receipts.
 *
 * UX flow:
 *   1. The seed mutation inserts a placeholder row at deployment
 *      time. The form loads with every field showing the
 *      "(PLACEHOLDER) …" markers.
 *   2. The admin replaces every value with the real BIR-issued
 *      values (registered legal name, TIN, address lines, ATP,
 *      expiry, serial range).
 *   3. The admin toggles "Mark as production-ready" — a destructive-
 *      styled affordance with confirmation that flips
 *      `isPlaceholder: false`. The mutation emits an `update` audit
 *      row capturing the before / after diff so the compliance
 *      timeline answers "when did we go production-ready?".
 *
 * Form is dumb-controlled: every state change re-renders. Submit
 * sends the full payload (the mutation is an upsert).
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

/**
 * Mirror of `BirReceiptConfigResult` in
 * `convex/cemeterySettings.ts`. The Next.js client cannot import
 * Convex server types directly (server-internal); this shape is
 * the agreed wire contract.
 */
interface BirReceiptConfigResult {
  _id: string;
  registeredName: string;
  tradeName: string | null;
  tin: string;
  registeredAddressLines: string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate: number | null;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
  updatedAt: number;
  updatedBy: string;
}

/**
 * Args shape sent to `setBirReceiptConfig`. Defined as a `type` (not
 * an `interface`) so it's structurally assignable to Convex's
 * `DefaultFunctionArgs` constraint (`{ [k: string]: Value }`) — an
 * interface would not be index-signature-compatible.
 */
type SetBirReceiptConfigArgs = {
  registeredName: string;
  tradeName?: string;
  tin: string;
  registeredAddressLines: string[];
  atpNumber: string;
  atpExpiryDate: number;
  serialRangeStart: string;
  serialRangeEnd: string;
  vatRate?: number;
  isVatRegistered: boolean;
  isPlaceholder: boolean;
};

const getBirReceiptConfigRef = makeFunctionReference<
  "query",
  Record<string, never>,
  BirReceiptConfigResult | null
>("cemeterySettings:getBirReceiptConfig");

const setBirReceiptConfigRef = makeFunctionReference<
  "mutation",
  SetBirReceiptConfigArgs,
  { configId: string }
>("cemeterySettings:setBirReceiptConfig");

/** Local form state. Date input is exposed as `YYYY-MM-DD` string;
 * we convert to/from epoch ms at the IO boundary. */
interface FormState {
  registeredName: string;
  tradeName: string;
  tin: string;
  /** Newline-separated lines. The mutation splits + trims. */
  addressLinesText: string;
  atpNumber: string;
  /** `YYYY-MM-DD` shape from `<input type="date">`. */
  atpExpiryDateIso: string;
  serialRangeStart: string;
  serialRangeEnd: string;
  isVatRegistered: boolean;
  vatRateText: string;
  isPlaceholder: boolean;
}

function epochMsToInputDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function inputDateToEpochMs(iso: string): number {
  // The `<input type="date">` value is interpreted as midnight in the
  // browser's local zone. Adding the explicit +08:00 (Asia/Manila)
  // suffix anchors it to cemetery operating-time so the at-rest
  // epoch-ms reads back as the right calendar day.
  return new Date(`${iso}T00:00:00+08:00`).getTime();
}

function configToForm(cfg: BirReceiptConfigResult): FormState {
  return {
    registeredName: cfg.registeredName,
    tradeName: cfg.tradeName ?? "",
    tin: cfg.tin,
    addressLinesText: cfg.registeredAddressLines.join("\n"),
    atpNumber: cfg.atpNumber,
    atpExpiryDateIso: epochMsToInputDate(cfg.atpExpiryDate),
    serialRangeStart: cfg.serialRangeStart,
    serialRangeEnd: cfg.serialRangeEnd,
    isVatRegistered: cfg.isVatRegistered,
    vatRateText: cfg.vatRate === null ? "" : String(cfg.vatRate),
    isPlaceholder: cfg.isPlaceholder,
  };
}

const EMPTY_FORM: FormState = {
  registeredName: "",
  tradeName: "",
  tin: "",
  addressLinesText: "",
  atpNumber: "",
  atpExpiryDateIso: "",
  serialRangeStart: "",
  serialRangeEnd: "",
  isVatRegistered: false,
  vatRateText: "",
  isPlaceholder: true,
};

export default function BirReceiptConfigPage(): React.ReactElement {
  const config = useQuery(getBirReceiptConfigRef, {});
  const setConfig = useMutation(setBirReceiptConfigRef);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmProductionReady, setConfirmProductionReady] = useState(false);

  // Hydrate the form from the loaded config on first arrival /
  // refresh. `config === undefined` while loading; `null` when the
  // row has not been seeded yet.
  useEffect(() => {
    if (config !== undefined && config !== null) {
      setForm(configToForm(config));
    }
  }, [config]);

  const isLoading = config === undefined;
  const isSeeded = config !== null && config !== undefined;
  const currentlyPlaceholder = config?.isPlaceholder ?? true;

  const handleSubmit = async (
    e: React.FormEvent,
    options: { markProductionReady?: boolean } = {},
  ): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const lines = form.addressLinesText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let atpExpiry: number;
    try {
      atpExpiry = inputDateToEpochMs(form.atpExpiryDateIso);
      if (!Number.isFinite(atpExpiry)) throw new Error("invalid date");
    } catch {
      setError("ATP expiry date is required.");
      return;
    }

    const args: SetBirReceiptConfigArgs = {
      registeredName: form.registeredName,
      tin: form.tin,
      registeredAddressLines: lines,
      atpNumber: form.atpNumber,
      atpExpiryDate: atpExpiry,
      serialRangeStart: form.serialRangeStart,
      serialRangeEnd: form.serialRangeEnd,
      isVatRegistered: form.isVatRegistered,
      // When "Mark production-ready" is the intent, override the
      // form's placeholder toggle.
      isPlaceholder:
        options.markProductionReady === true ? false : form.isPlaceholder,
    };
    if (form.tradeName.trim().length > 0) {
      args.tradeName = form.tradeName.trim();
    }
    if (form.vatRateText.trim().length > 0) {
      const parsed = Number(form.vatRateText);
      if (Number.isFinite(parsed)) {
        args.vatRate = parsed;
      }
    }

    setBusy(true);
    try {
      await setConfig(args);
      setSuccess(
        options.markProductionReady === true
          ? "Configuration marked as production-ready. Receipts can now be issued."
          : "Configuration saved.",
      );
      setConfirmProductionReady(false);
      setForm((f) => ({
        ...f,
        isPlaceholder:
          options.markProductionReady === true ? false : f.isPlaceholder,
      }));
    } catch (err) {
      const t = translateError(err);
      setError(`${t.headline}: ${t.detail}`);
    } finally {
      setBusy(false);
    }
  };

  const lastUpdated = useMemo(() => {
    if (config === null || config === undefined) return null;
    return new Intl.DateTimeFormat("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(config.updatedAt));
  }, [config]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">
          BIR Receipt Configuration
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Legally-registered BIR identity printed on every Official
          Receipt issued by the cemetery. Verify every field against
          the actual BIR documents before marking as production-ready.
        </p>
      </div>

      {currentlyPlaceholder && (
        <div
          role="alert"
          data-testid="bir-config-placeholder-banner"
          className="rounded-md border-2 border-red-400 bg-red-50 p-4 text-sm text-red-900"
        >
          <strong className="font-semibold">
            Receipts cannot be issued while this is in placeholder mode.
          </strong>{" "}
          Enter all required BIR values, verify with your accountant,
          then mark as production-ready.
        </div>
      )}

      {error !== null && (
        <div
          role="alert"
          data-testid="bir-config-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      {success !== null && (
        <div
          role="status"
          data-testid="bir-config-success"
          className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          {success}
        </div>
      )}

      {isLoading && (
        <div className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Loading BIR configuration…
        </div>
      )}

      {!isLoading && !isSeeded && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
          The BIR receipt configuration has not been initialised. Run
          the <code className="font-mono">seedBirReceiptConfig</code>{" "}
          internal mutation from the Convex dashboard, then reload this
          page.
        </div>
      )}

      {!isLoading && isSeeded && (
        <form
          onSubmit={(e) => handleSubmit(e)}
          className="space-y-5 rounded-md border border-slate-200 bg-white p-6"
        >
          <FormField
            label="BIR-registered legal name"
            id="registeredName"
            helper="The exact legal entity registered with the BIR (e.g. Cases Land Inc.). NOT the cemetery's customer-facing brand name."
          >
            <input
              id="registeredName"
              type="text"
              required
              value={form.registeredName}
              onChange={(e) =>
                setForm({ ...form, registeredName: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </FormField>

          <FormField
            label="Trade name (optional)"
            id="tradeName"
            helper="Doing-business-as name customers recognise (e.g. Apostle Paul Memorial Park)."
          >
            <input
              id="tradeName"
              type="text"
              value={form.tradeName}
              onChange={(e) =>
                setForm({ ...form, tradeName: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </FormField>

          <FormField
            label="TIN (12 digits, no separators)"
            id="tin"
            helper="The BIR Tax Identification Number — 12 digits including the 3-digit branch code."
          >
            <input
              id="tin"
              type="text"
              required
              pattern="[0-9-]+"
              value={form.tin}
              onChange={(e) => setForm({ ...form, tin: e.target.value })}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm"
            />
          </FormField>

          <FormField
            label="BIR-registered address (one line per row)"
            id="addressLines"
            helper="The legally-registered postal address. This is what prints on the receipt — distinct from any brand/marketing address."
          >
            <textarea
              id="addressLines"
              required
              rows={4}
              value={form.addressLinesText}
              onChange={(e) =>
                setForm({ ...form, addressLinesText: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </FormField>

          <FormField
            label="Authority to Print (ATP) / Permit to Use number"
            id="atpNumber"
            helper="The BIR-issued reference for the receipt booklet/series."
          >
            <input
              id="atpNumber"
              type="text"
              required
              value={form.atpNumber}
              onChange={(e) =>
                setForm({ ...form, atpNumber: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </FormField>

          <FormField
            label="ATP / Permit expiry date"
            id="atpExpiryDate"
            helper="Surfaces on the mandatory 'valid for 5 years' footer. Cashiers cross-check this before issuing receipts near expiry."
          >
            <input
              id="atpExpiryDate"
              type="date"
              required
              value={form.atpExpiryDateIso}
              onChange={(e) =>
                setForm({ ...form, atpExpiryDateIso: e.target.value })
              }
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Serial range start" id="serialRangeStart">
              <input
                id="serialRangeStart"
                type="text"
                required
                value={form.serialRangeStart}
                onChange={(e) =>
                  setForm({ ...form, serialRangeStart: e.target.value })
                }
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm"
              />
            </FormField>
            <FormField label="Serial range end" id="serialRangeEnd">
              <input
                id="serialRangeEnd"
                type="text"
                required
                value={form.serialRangeEnd}
                onChange={(e) =>
                  setForm({ ...form, serialRangeEnd: e.target.value })
                }
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm"
              />
            </FormField>
          </div>

          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.isVatRegistered}
                onChange={(e) =>
                  setForm({ ...form, isVatRegistered: e.target.checked })
                }
              />
              <span className="text-sm font-medium text-slate-900">
                Cemetery is VAT-registered
              </span>
            </label>
            {form.isVatRegistered && (
              <div className="mt-3">
                <FormField
                  label="VAT rate (%)"
                  id="vatRate"
                  helper="Philippine standard rate is 12. Leave blank for VAT-exempt."
                >
                  <input
                    id="vatRate"
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={form.vatRateText}
                    onChange={(e) =>
                      setForm({ ...form, vatRateText: e.target.value })
                    }
                    className="w-32 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  />
                </FormField>
              </div>
            )}
          </div>

          {lastUpdated !== null && (
            <p className="text-xs text-slate-500">
              Last updated: {lastUpdated}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="bir-config-save"
            >
              {busy ? "Saving…" : "Save changes"}
            </button>

            {currentlyPlaceholder && !confirmProductionReady && (
              <button
                type="button"
                onClick={() => setConfirmProductionReady(true)}
                className="rounded-md border-2 border-red-500 bg-red-50 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-100"
                data-testid="bir-config-mark-production-ready"
              >
                Mark as production-ready…
              </button>
            )}

            {currentlyPlaceholder && confirmProductionReady && (
              <div
                className="flex items-center gap-2 rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm"
                data-testid="bir-config-confirm-production-ready"
              >
                <span className="font-semibold text-red-900">
                  Confirm BIR values are correct?
                </span>
                <button
                  type="button"
                  onClick={(e) =>
                    handleSubmit(e, { markProductionReady: true })
                  }
                  disabled={busy}
                  className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-50"
                  data-testid="bir-config-confirm-yes"
                >
                  Yes, mark production-ready
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmProductionReady(false)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            )}

            {!currentlyPlaceholder && (
              <span
                className="text-sm font-medium text-emerald-700"
                data-testid="bir-config-production-ready-badge"
              >
                ✓ Production-ready
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function FormField({
  label,
  id,
  helper,
  children,
}: {
  label: string;
  id: string;
  helper?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
      </label>
      {helper !== undefined && (
        <p className="text-xs text-slate-500">{helper}</p>
      )}
      {children}
    </div>
  );
}
