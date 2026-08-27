"use client";

/**
 * The cemetery's offers, priced against the lot in front of you.
 *
 * The sale form's fields are still the authority — an operator can
 * always type a figure, and there are sales that need it. This sits
 * above them and fills them in, so the ordinary case stops being six
 * fields of mental arithmetic while a family waits.
 *
 * Every option shows its working. "₱90,000 — Cash, 10% off" is
 * something you can read across a desk; a number that appeared in a box
 * is not, and the operator is the one who has to explain it.
 *
 * @gated-route-only — renders inside `SaleForm` on `/sales/new`;
 * middleware keeps field workers off the `/sales` family.
 */

import { useState, type ReactElement } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";

type PlanKind = "full_payment" | "installment";

interface Adjustment {
  label: string;
  amountCents: number;
  source: "plan" | "promo" | "manual";
  percent?: number;
}

export interface QuoteOption {
  planId: string;
  planName: string;
  planDescription?: string;
  kind: PlanKind;
  isDefault: boolean;
  listPriceCents: number;
  netPriceCents: number;
  totalDiscountCents: number;
  totalSurchargeCents: number;
  downPaymentCents: number;
  termMonths: number;
  indicativeMonthlyCents: number;
  adjustments: Adjustment[];
  promoId?: string;
  promoName?: string;
  cappedNote?: string;
  warnings: string[];
}

interface LotQuote {
  lotId: string;
  lotCode: string;
  lotType: string;
  section: string;
  listPriceCents: number;
  options: QuoteOption[];
  promosNotApplied: Array<{ name: string; reason: string }>;
  noPlansConfigured: boolean;
}

const quoteLotRef = makeFunctionReference<
  "query",
  { lotId: string; promoCode?: string; manualDiscountCents?: number },
  LotQuote
>("paymentPlans:quoteLot");

export interface PlanPickerProps {
  /** Null until the operator has chosen a lot. */
  lotId: string | null;
  /** The option currently applied, so the card can show as chosen. */
  selectedPlanId?: string;
  /** Fired when an option is picked. The parent fills its own fields. */
  onApply: (option: QuoteOption) => void;
  /** Fired when the operator clears the plan to price by hand. */
  onClear: () => void;
}

export function PlanPicker({
  lotId,
  selectedPlanId,
  onApply,
  onClear,
}: PlanPickerProps): ReactElement {
  const [code, setCode] = useState("");
  const [submittedCode, setSubmittedCode] = useState("");

  // `"skip"` until a lot exists — quoting nothing is not a question the
  // server can answer, and a rejected query throws during render.
  const quote = useQuery(
    quoteLotRef,
    lotId === null
      ? "skip"
      : {
          lotId,
          ...(submittedCode.length > 0 ? { promoCode: submittedCode } : {}),
        },
  );

  if (lotId === null) {
    return (
      <p
        data-testid="plan-picker-no-lot"
        className="text-sm text-slate-500"
      >
        Choose a lot and the cemetery&rsquo;s payment plans will be priced
        against it.
      </p>
    );
  }

  // `undefined` is Convex's "still loading". `null` should not occur —
  // `quoteLot` returns a non-nullable shape — but a picker that throws
  // on an unexpected nullish takes the whole sale form down with it,
  // and "Pricing…" is a harmless thing to show if it ever does.
  if (quote === undefined || quote === null) {
    return <p className="text-sm text-slate-500">Pricing&hellip;</p>;
  }

  if (quote.noPlansConfigured) {
    return (
      <p
        data-testid="plan-picker-none"
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      >
        No payment plan covers a {quote.lotType} lot, so this sale has to
        be priced by hand below. An administrator can set the plans up
        under Payment plans.
      </p>
    );
  }

  return (
    <div data-testid="plan-picker" className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            Promotion code
          </span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="If the family has one"
            data-testid="plan-picker-code"
            className="block w-56 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>
        <button
          type="button"
          data-testid="plan-picker-apply-code"
          onClick={() => setSubmittedCode(code.trim())}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Apply
        </button>
        {submittedCode.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setCode("");
              setSubmittedCode("");
            }}
            className="text-xs font-medium text-slate-600 underline"
          >
            Clear code
          </button>
        )}
      </div>

      <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {quote.options.map((o) => {
          // A plan that cannot close a sale must not be offerable — the
          // operator would meet a raw rejection at submit with a family
          // in front of them.
          const unusable = o.warnings.length > 0;
          const chosen = o.planId === selectedPlanId;
          return (
            <li key={o.planId}>
              <button
                type="button"
                disabled={unusable}
                data-testid="plan-option"
                onClick={() => onApply(o)}
                className={[
                  "w-full rounded-md border p-4 text-left transition",
                  unusable
                    ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-70"
                    : chosen
                      ? "border-slate-900 bg-slate-50"
                      : "border-slate-200 bg-white hover:bg-slate-50",
                ].join(" ")}
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">
                    {o.planName}
                  </span>
                  {o.isDefault && (
                    <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[11px] text-slate-700">
                      Usual
                    </span>
                  )}
                  {o.promoName !== undefined && (
                    <span
                      data-testid="plan-option-promo"
                      className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-900"
                    >
                      {o.promoName}
                    </span>
                  )}
                </span>

                <span className="mt-1 block font-display text-2xl font-light text-slate-900">
                  {formatPeso(o.netPriceCents)}
                </span>

                {o.kind === "installment" && o.termMonths > 0 && (
                  <span className="block text-sm text-slate-700">
                    {formatPeso(o.downPaymentCents)} down, then{" "}
                    {formatPeso(o.indicativeMonthlyCents)} a month for{" "}
                    {o.termMonths}
                  </span>
                )}

                {/* The working. A figure nobody can explain is worse
                    than one that took longer to reach. */}
                {o.adjustments.length > 0 && (
                  <span className="mt-2 block space-y-0.5">
                    <span className="block text-xs text-slate-500">
                      From {formatPeso(o.listPriceCents)}
                    </span>
                    {o.adjustments.map((a) => (
                      <span
                        key={a.label}
                        className="block text-xs text-slate-600"
                      >
                        {a.amountCents < 0 ? "−" : "+"}
                        {formatPeso(Math.abs(a.amountCents))} {a.label}
                        {a.percent !== undefined && ` (${a.percent}%)`}
                      </span>
                    ))}
                  </span>
                )}

                {o.cappedNote !== undefined && (
                  <span
                    data-testid="plan-option-capped"
                    className="mt-2 block rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
                  >
                    {o.cappedNote}
                  </span>
                )}

                {unusable && (
                  <span
                    data-testid="plan-option-unusable"
                    className="mt-2 block rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900"
                  >
                    {o.warnings.join(" ")}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {quote.promosNotApplied.length > 0 && (
        <div
          data-testid="plan-picker-not-applied"
          className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600"
        >
          <p className="font-medium text-slate-700">Offers that did not apply</p>
          <ul className="mt-1 space-y-0.5">
            {quote.promosNotApplied.map((p) => (
              <li key={p.name}>{p.reason}</li>
            ))}
          </ul>
          <p className="mt-1 text-slate-500">
            Worth reading out &mdash; a family who heard about an offer
            would rather be told when it ended than that it &ldquo;does
            not apply&rdquo;.
          </p>
        </div>
      )}

      {selectedPlanId !== undefined && (
        <button
          type="button"
          data-testid="plan-picker-clear"
          onClick={onClear}
          className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
        >
          Price this one by hand instead
        </button>
      )}
    </div>
  );
}
