"use client";

/**
 * /admin/settings/perpetual-care — Story 3.8 rebuild (FR25).
 *
 * Admin-only edit surface for the perpetual-care policy singleton.
 * Mirrors the BIR receipt config page's destructive-confirm pattern:
 * the seed writes a placeholder row with the Q7 defaults; the admin
 * confirms the policy by saving with "Confirm policy" toggled on
 * (flips `isPlaceholder: false`); thereafter every sale derives its
 * perpetual-care fee from this row.
 *
 * Banner semantics:
 *   - `policy === null` (seed has not run): "Perpetual care policy
 *     has not been seeded yet" — should not happen on a live deploy.
 *   - `policy.isPlaceholder === true`: red banner "Policy pending
 *     admin confirmation — sales will be blocked until you save
 *     with 'Confirm policy' toggled on."
 *   - `policy.isPlaceholder === false`: confirmation pill "Policy
 *     active since …".
 *
 * Auth: middleware gates `/admin/*` at the edge; the Convex query +
 * mutation both call `requireRole(["admin"])`.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { cn } from "@/lib/cn";
import { translateError } from "@/lib/errors";
import { centsToPesos, formatPeso, pesosToCents } from "@/lib/money";

type PolicyType = "one_time" | "annual" | "none";

interface OneTimeFee {
  lotType: string;
  feeCents: number;
}

interface PolicyResult {
  type: PolicyType;
  oneTimeFeesByLotType?: OneTimeFee[];
  annualFeeCents?: number;
  annualBillingStartMonthsAfterSale?: number;
  isPlaceholder: boolean;
  updatedAt: number;
}

type UpdatePolicyArgs = {
  type: PolicyType;
  oneTimeFeesByLotType?: OneTimeFee[];
  annualFeeCents?: number;
  annualBillingStartMonthsAfterSale?: number;
  isPlaceholder: boolean;
};

const getPolicyRef = makeFunctionReference<
  "query",
  Record<string, never>,
  PolicyResult | null
>("perpetualCare:getPerpetualCarePolicy");

const updatePolicyRef = makeFunctionReference<
  "mutation",
  UpdatePolicyArgs,
  PolicyResult
>("perpetualCare:updatePerpetualCarePolicy");

/**
 * Q7 default fee schedule — must match
 * `convex/lib/perpetualCare.ts:Q7_DEFAULT_ONE_TIME_FEES`. Pre-fills
 * the form on first render before the singleton row is hydrated.
 */
const Q7_DEFAULT_FEES: OneTimeFee[] = [
  { lotType: "single", feeCents: 500_000 },
  { lotType: "family", feeCents: 500_000 },
  { lotType: "mausoleum", feeCents: 1_000_000 },
  { lotType: "niche", feeCents: 0 },
];

export default function AdminPerpetualCarePage(): React.ReactElement {
  const policy = useQuery(getPolicyRef, {});
  const updatePolicy = useMutation(updatePolicyRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  const [policyType, setPolicyType] = useState<PolicyType>("one_time");
  const [feeRows, setFeeRows] = useState<
    Array<{ lotType: string; feeInput: string }>
  >(
    Q7_DEFAULT_FEES.map((row) => ({
      lotType: row.lotType,
      feeInput: centsToPesos(row.feeCents).toFixed(2),
    })),
  );
  const [annualFeeInput, setAnnualFeeInput] = useState<string>("0.00");
  const [annualOffsetInput, setAnnualOffsetInput] = useState<string>("12");
  const [confirmPolicy, setConfirmPolicy] = useState(false);

  // Hydrate form state when the query resolves with an existing row.
  useEffect(() => {
    if (policy === undefined || policy === null) return;
    setPolicyType(policy.type);
    if (policy.oneTimeFeesByLotType !== undefined) {
      const merged = mergeFeesWithDefaults(policy.oneTimeFeesByLotType);
      setFeeRows(
        merged.map((row) => ({
          lotType: row.lotType,
          feeInput: centsToPesos(row.feeCents).toFixed(2),
        })),
      );
    }
    if (policy.annualFeeCents !== undefined) {
      setAnnualFeeInput(centsToPesos(policy.annualFeeCents).toFixed(2));
    }
    if (policy.annualBillingStartMonthsAfterSale !== undefined) {
      setAnnualOffsetInput(
        String(policy.annualBillingStartMonthsAfterSale),
      );
    }
    setConfirmPolicy(!policy.isPlaceholder);
  }, [policy]);

  const isLoading = policy === undefined;

  async function handleSave(): Promise<void> {
    setBusy(true);
    setError(null);
    setOkMessage(null);
    try {
      const args: UpdatePolicyArgs = {
        type: policyType,
        isPlaceholder: !confirmPolicy,
      };
      if (policyType === "one_time") {
        const cleaned: OneTimeFee[] = [];
        for (const row of feeRows) {
          const trimmedType = row.lotType.trim();
          if (trimmedType.length === 0) continue;
          const cents = pesosToCents(row.feeInput);
          if (
            !Number.isFinite(cents) ||
            !Number.isInteger(cents) ||
            cents < 0
          ) {
            setError(
              `Fee for "${trimmedType}" must be a non-negative amount.`,
            );
            setBusy(false);
            return;
          }
          cleaned.push({ lotType: trimmedType, feeCents: cents });
        }
        if (cleaned.length === 0) {
          setError(
            "One-time policy requires at least one lot-type fee row.",
          );
          setBusy(false);
          return;
        }
        args.oneTimeFeesByLotType = cleaned;
      }
      if (policyType === "annual") {
        const cents = pesosToCents(annualFeeInput);
        if (!Number.isFinite(cents) || !Number.isInteger(cents) || cents < 0) {
          setError("Annual fee must be a non-negative amount.");
          setBusy(false);
          return;
        }
        args.annualFeeCents = cents;
        const offset = Number.parseInt(annualOffsetInput, 10);
        if (Number.isInteger(offset) && offset >= 0) {
          args.annualBillingStartMonthsAfterSale = offset;
        }
      }
      await updatePolicy(args);
      setOkMessage("Perpetual care policy saved.");
    } catch (err) {
      const t = translateError(err);
      setError(`${t.headline}: ${t.detail}`);
    } finally {
      setBusy(false);
    }
  }

  function updateFeeRow(index: number, patch: Partial<{ lotType: string; feeInput: string }>): void {
    setFeeRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function addFeeRow(): void {
    setFeeRows((prev) => [...prev, { lotType: "", feeInput: "0.00" }]);
  }

  function removeFeeRow(index: number): void {
    setFeeRows((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Perpetual care policy
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Sets the cemetery-wide perpetual-care fee derivation for new
          sales. Operators no longer enter a fee on the sale form — the
          server derives the amount from this policy + the lot&apos;s
          type.
        </p>
      </div>

      {!isLoading && (policy === null || policy.isPlaceholder) && (
        <div
          role="alert"
          className="rounded-md border-2 border-red-400 bg-red-50 p-4 text-sm text-red-900"
          data-testid="perpetual-care-placeholder-banner"
        >
          <p className="font-semibold">
            Perpetual care policy is pending admin confirmation.
          </p>
          <p className="mt-1">
            Sales are <strong>blocked</strong> until you review the
            policy below and save with &ldquo;Confirm policy&rdquo;
            toggled on. The default values shown are the §10 Q7
            recommendations from the project brief.
          </p>
        </div>
      )}

      {!isLoading && policy !== null && !policy.isPlaceholder && (
        <div
          className="inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800"
          data-testid="perpetual-care-active-pill"
        >
          Policy active · last updated{" "}
          {new Date(policy.updatedAt).toLocaleString("en-PH", {
            timeZone: "Asia/Manila",
          })}
        </div>
      )}

      {error !== null && (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          data-testid="perpetual-care-error"
        >
          {error}
        </div>
      )}

      {okMessage !== null && (
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
          data-testid="perpetual-care-success"
        >
          {okMessage}
        </div>
      )}

      <section className="space-y-4 rounded-md border border-slate-200 bg-white p-5">
        <div>
          <label
            htmlFor="policy-type"
            className="block text-sm font-medium text-slate-700"
          >
            Policy type
          </label>
          <select
            id="policy-type"
            value={policyType}
            disabled={busy || isLoading}
            onChange={(e) => setPolicyType(e.target.value as PolicyType)}
            data-testid="policy-type-select"
            className="mt-1 block w-full max-w-xs rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="one_time">One-time fee (per lot type)</option>
            <option value="annual">Annual fee</option>
            <option value="none">None (no perpetual care collected)</option>
          </select>
        </div>

        {policyType === "one_time" && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-800">
              Per-lot-type fees
            </h2>
            <p className="text-xs text-slate-500">
              Each row binds a lot type (matching the lot&apos;s
              `type` field) to a centavo fee. Unmatched lot types
              fall back to ₱0 in the sale-path derivation.
            </p>
            <div className="space-y-2">
              {feeRows.map((row, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2"
                  data-testid={`fee-row-${index}`}
                >
                  <input
                    type="text"
                    value={row.lotType}
                    placeholder="Lot type"
                    disabled={busy || isLoading}
                    onChange={(e) =>
                      updateFeeRow(index, { lotType: e.target.value })
                    }
                    data-testid={`fee-row-type-${index}`}
                    className="block w-40 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  />
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                      ₱
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.feeInput}
                      disabled={busy || isLoading}
                      onChange={(e) =>
                        updateFeeRow(index, { feeInput: e.target.value })
                      }
                      data-testid={`fee-row-amount-${index}`}
                      className="block w-40 rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeFeeRow(index)}
                    disabled={busy || isLoading}
                    data-testid={`fee-row-remove-${index}`}
                    className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addFeeRow}
              disabled={busy || isLoading}
              data-testid="fee-row-add"
              className="rounded-md border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              Add lot type
            </button>
          </div>
        )}

        {policyType === "annual" && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-800">
              Annual fee
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="annual-fee"
                  className="block text-xs font-medium text-slate-700"
                >
                  Annual fee (PHP)
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">
                    ₱
                  </span>
                  <input
                    id="annual-fee"
                    type="text"
                    inputMode="decimal"
                    value={annualFeeInput}
                    disabled={busy || isLoading}
                    onChange={(e) => setAnnualFeeInput(e.target.value)}
                    data-testid="annual-fee-input"
                    className="mt-1 block w-full rounded-md border border-slate-300 pl-7 pr-3 py-2 text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  />
                </div>
              </div>
              <div>
                <label
                  htmlFor="annual-offset"
                  className="block text-xs font-medium text-slate-700"
                >
                  First bill, months after sale
                </label>
                <input
                  id="annual-offset"
                  type="number"
                  min={0}
                  value={annualOffsetInput}
                  disabled={busy || isLoading}
                  onChange={(e) => setAnnualOffsetInput(e.target.value)}
                  data-testid="annual-offset-input"
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
              </div>
            </div>
            <p className="text-xs text-amber-700">
              Annual billing scheduler is out of scope for this release;
              saving an annual policy stamps the contract row with
              `perpetualCareCents: 0` and records the billing type for
              audit. Recurring billing lands in a follow-on story.
            </p>
          </div>
        )}

        {policyType === "none" && (
          <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            Sales will write <code>perpetualCareCents: 0</code> on every
            new contract.
          </p>
        )}

        <div className="border-t border-slate-200 pt-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={confirmPolicy}
              disabled={busy || isLoading}
              onChange={(e) => setConfirmPolicy(e.target.checked)}
              data-testid="confirm-policy-toggle"
              className="mt-1 h-4 w-4"
            />
            <span className="text-sm text-slate-700">
              <strong>Confirm policy.</strong> When checked, the
              policy leaves placeholder state and the sale form
              unblocks. Uncheck to re-block sales (e.g. while the
              cemetery is renegotiating fees).
            </span>
          </label>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || isLoading}
            data-testid="perpetual-care-save"
            className={cn(
              "min-h-[44px] rounded-md px-4 py-2 text-sm font-medium text-white",
              confirmPolicy
                ? "bg-red-700 hover:bg-red-800"
                : "bg-[#1D5C4D] hover:bg-[#144437]",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
          >
            {busy
              ? "Saving…"
              : confirmPolicy
                ? "Save & confirm policy"
                : "Save (keep as placeholder)"}
          </button>
        </div>
      </section>

      {policyType === "one_time" && (
        <section className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-800">
            Live preview
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            What the sale form will show for each lot type once the
            policy is confirmed.
          </p>
          <dl
            className="mt-2 text-sm tabular-nums"
            data-testid="fee-preview"
          >
            {feeRows.map((row, index) => {
              const cents = pesosToCents(row.feeInput);
              const safeCents =
                Number.isFinite(cents) && cents >= 0 ? cents : 0;
              return (
                <div
                  key={index}
                  className="flex justify-between border-t border-slate-200 py-1 first:border-t-0"
                >
                  <dt className="text-slate-600">
                    {row.lotType || "(unnamed)"}
                  </dt>
                  <dd className="text-slate-900">
                    {formatPeso(safeCents)}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
    </div>
  );
}

function mergeFeesWithDefaults(rows: OneTimeFee[]): OneTimeFee[] {
  const map = new Map<string, OneTimeFee>(
    rows.map((row) => [row.lotType, row]),
  );
  const merged: OneTimeFee[] = [];
  for (const defaultRow of Q7_DEFAULT_FEES) {
    const existing = map.get(defaultRow.lotType);
    if (existing !== undefined) {
      merged.push(existing);
      map.delete(defaultRow.lotType);
    } else {
      merged.push(defaultRow);
    }
  }
  for (const remaining of map.values()) {
    merged.push(remaining);
  }
  return merged;
}
