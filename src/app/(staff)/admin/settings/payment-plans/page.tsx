"use client";

/**
 * /admin/settings/payment-plans — what the cemetery offers, and for how long.
 *
 * Before this screen the terms were retyped at every sale. An operator
 * entered a price, a discount, a reason, a down payment, a term and a
 * monthly figure, freehand, per family — and the cemetery had no way to
 * say "cash is ten per cent off and there are three instalment options"
 * except by telling people and hoping.
 *
 * Admin-only. Middleware gates `/admin/*` at the edge and
 * `convex/paymentPlans.ts` re-enforces `requireRole(["admin"])` on
 * every write. Office staff read these all day to fill a sale form;
 * they must never be able to mint one on the way to closing a sale.
 *
 * The preview at the bottom of each plan is the point of the page. A
 * percentage means nothing to anyone until it is a peso figure against
 * a real lot, and a plan that cannot close a sale should be obvious
 * here rather than at a counter with a family waiting.
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso, pesosToCents } from "@/lib/money";
import { translateError } from "@/lib/errors";

// --- server surface ---------------------------------------------------

type PlanKind = "full_payment" | "installment";
type LotType = "single" | "family" | "mausoleum" | "niche";

const LOT_TYPES: LotType[] = ["single", "family", "mausoleum", "niche"];

interface PlanRow {
  _id: string;
  name: string;
  description?: string;
  kind: PlanKind;
  discountPercent?: number;
  downPaymentPercent?: number;
  termMonths?: number;
  surchargePercent?: number;
  appliesToLotTypes: LotType[];
  isDefault: boolean;
  sortOrder: number;
  isRetired: boolean;
}

interface PromoRow {
  _id: string;
  name: string;
  code?: string;
  description?: string;
  discountPercent?: number;
  discountCents?: number;
  startsAt: number;
  endsAt: number;
  appliesToLotTypes: LotType[];
  appliesToSections: string[];
  appliesToPlanKinds: PlanKind[];
  maxRedemptions?: number;
  redemptionCount: number;
  isRetired: boolean;
  isLive: boolean;
}

const listPlansRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  PlanRow[]
>("paymentPlans:listPaymentPlans");

const listPromosRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  PromoRow[]
>("paymentPlans:listPromos");

const createPlanRef = makeFunctionReference<
  "mutation",
  {
    name: string;
    description?: string;
    kind: PlanKind;
    discountPercent?: number;
    downPaymentPercent?: number;
    termMonths?: number;
    surchargePercent?: number;
    appliesToLotTypes?: LotType[];
    isDefault?: boolean;
  },
  { planId: string }
>("paymentPlans:createPaymentPlan");

const updatePlanRef = makeFunctionReference<
  "mutation",
  { planId: string; isDefault?: boolean },
  { planId: string }
>("paymentPlans:updatePaymentPlan");

const retirePlanRef = makeFunctionReference<
  "mutation",
  { planId: string; isRetired: boolean },
  { planId: string }
>("paymentPlans:setPaymentPlanRetired");

const createPromoRef = makeFunctionReference<
  "mutation",
  {
    name: string;
    code?: string;
    description?: string;
    discountPercent?: number;
    discountCents?: number;
    startsAt: number;
    endsAt: number;
    appliesToPlanKinds?: PlanKind[];
    maxRedemptions?: number;
  },
  { promoId: string }
>("paymentPlans:createPromo");

const retirePromoRef = makeFunctionReference<
  "mutation",
  { promoId: string; isRetired: boolean },
  { promoId: string }
>("paymentPlans:setPromoRetired");

// --- page -------------------------------------------------------------

export default function PaymentPlansPage(): ReactElement {
  const plans = useQuery(listPlansRef, { includeRetired: true });
  const promos = useQuery(listPromosRef, { includeRetired: true });

  return (
    <div className="space-y-10">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Payment plans
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          The ways a lot can be bought, and the offers running on top of
          them. The sale desk fills a contract from these, so a plan
          that cannot close a sale is refused here rather than at a
          counter.
        </p>
      </header>

      <PlansSection plans={plans} />
      <PromosSection promos={promos} />
    </div>
  );
}

// --- plans ------------------------------------------------------------

function PlansSection({ plans }: { plans?: PlanRow[] }): ReactElement {
  const create = useMutation(createPlanRef);
  const update = useMutation(updatePlanRef);
  const retire = useMutation(retirePlanRef);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<PlanKind>("full_payment");
  const [discount, setDiscount] = useState("");
  const [down, setDown] = useState("20");
  const [term, setTerm] = useState("12");
  const [surcharge, setSurcharge] = useState("");
  const [types, setTypes] = useState<LotType[]>([]);
  const [isDefault, setIsDefault] = useState(false);

  function reset(): void {
    setName("");
    setDescription("");
    setKind("full_payment");
    setDiscount("");
    setDown("20");
    setTerm("12");
    setSurcharge("");
    setTypes([]);
    setIsDefault(false);
    setError(null);
  }

  const active = (plans ?? []).filter((p) => !p.isRetired);
  const retired = (plans ?? []).filter((p) => p.isRetired);

  return (
    <section data-testid="plans-section" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl font-light">Plans</h2>
        <button
          type="button"
          data-testid="new-plan"
          onClick={() => {
            reset();
            setOpen((v) => !v);
          }}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {open ? "Cancel" : "New plan"}
        </button>
      </div>

      {open && (
        <form
          data-testid="plan-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            const payload: Parameters<typeof create>[0] = {
              name: name.trim(),
              kind,
              appliesToLotTypes: types,
              isDefault,
            };
            if (description.trim().length > 0) {
              payload.description = description.trim();
            }
            const d = Number.parseFloat(discount);
            if (Number.isFinite(d) && d > 0) payload.discountPercent = d;
            if (kind === "installment") {
              const dp = Number.parseFloat(down);
              if (Number.isFinite(dp)) payload.downPaymentPercent = dp;
              const t = Number.parseInt(term, 10);
              if (Number.isFinite(t)) payload.termMonths = t;
              const s = Number.parseFloat(surcharge);
              if (Number.isFinite(s) && s > 0) payload.surchargePercent = s;
            }
            void create(payload)
              .then(() => {
                reset();
                setOpen(false);
              })
              .catch((e: unknown) => setError(messageOf(e)))
              .finally(() => setBusy(false));
          }}
          className="grid grid-cols-1 gap-4 rounded-md border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Field label="Name" hint="What a family will be told">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cash — 10% off"
              data-testid="plan-name"
              className={inputClass}
            />
          </Field>

          <Field label="How it is paid">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PlanKind)}
              data-testid="plan-kind"
              className={inputClass}
            >
              <option value="full_payment">In full</option>
              <option value="installment">By instalments</option>
            </select>
          </Field>

          <Field label="Discount" hint="Per cent off the list price">
            <input
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              inputMode="decimal"
              placeholder="10"
              data-testid="plan-discount"
              className={inputClass}
            />
          </Field>

          {kind === "installment" && (
            <>
              <Field
                label="Deposit"
                hint="Per cent up front — must be above zero"
              >
                <input
                  value={down}
                  onChange={(e) => setDown(e.target.value)}
                  inputMode="decimal"
                  data-testid="plan-down"
                  className={inputClass}
                />
              </Field>
              <Field label="Term" hint="Months, 1 to 60">
                <input
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  inputMode="numeric"
                  data-testid="plan-term"
                  className={inputClass}
                />
              </Field>
              <Field
                label="Carrying charge"
                hint="Per cent added for terms. Leave blank for none"
              >
                <input
                  value={surcharge}
                  onChange={(e) => setSurcharge(e.target.value)}
                  inputMode="decimal"
                  data-testid="plan-surcharge"
                  className={inputClass}
                />
              </Field>
            </>
          )}

          <Field label="Note" hint="Optional, shown to the operator">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={inputClass}
            />
          </Field>

          <div className="sm:col-span-2 lg:col-span-3">
            <p className="mb-1 text-sm font-medium text-slate-700">
              Which lots
            </p>
            <div className="flex flex-wrap gap-3">
              {LOT_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={types.includes(t)}
                    onChange={(e) =>
                      setTypes((prev) =>
                        e.target.checked
                          ? [...prev, t]
                          : prev.filter((x) => x !== t),
                      )
                    }
                  />
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Tick nothing and it applies to every lot.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              data-testid="plan-default"
            />
            Open the sale form on this one
          </label>

          {error !== null && (
            <p
              role="alert"
              data-testid="plan-error"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 sm:col-span-2 lg:col-span-3"
            >
              {error}
            </p>
          )}

          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={busy || name.trim().length < 2}
              data-testid="plan-submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {busy ? "Saving…" : "Add plan"}
            </button>
          </div>
        </form>
      )}

      {plans === undefined ? (
        <p className="text-sm text-slate-500">Loading&hellip;</p>
      ) : active.length === 0 ? (
        <p
          data-testid="plans-empty"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          No plans yet. Until one exists the sale desk prices every lot by
          hand, which is the arrangement this page replaces.
        </p>
      ) : (
        <ul className="space-y-2">
          {active.map((p) => (
            <PlanCard
              key={p._id}
              plan={p}
              onRetire={() =>
                void retire({ planId: p._id, isRetired: true }).catch(
                  (e: unknown) => setError(messageOf(e)),
                )
              }
              onMakeDefault={() =>
                void update({ planId: p._id, isDefault: true }).catch(
                  (e: unknown) => setError(messageOf(e)),
                )
              }
            />
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <details data-testid="plans-retired">
          <summary className="cursor-pointer text-sm text-slate-600">
            {retired.length} retired plan{retired.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-2">
            {retired.map((p) => (
              <li
                key={p._id}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm"
              >
                <span className="text-slate-600">
                  {p.name} &middot; {describePlan(p)}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void retire({ planId: p._id, isRetired: false })
                  }
                  className="text-xs font-medium text-slate-700 underline"
                >
                  Offer again
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Retired plans are kept, never deleted &mdash; contracts point
            at them, and a contract has to go on saying what it was sold
            under.
          </p>
        </details>
      )}
    </section>
  );
}

function PlanCard({
  plan,
  onRetire,
  onMakeDefault,
}: {
  plan: PlanRow;
  onRetire: () => void;
  onMakeDefault: () => void;
}): ReactElement {
  return (
    <li
      data-testid="plan-row"
      className="rounded-md border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-lg text-slate-900">
              {plan.name}
            </span>
            {plan.isDefault && (
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-900">
                Default
              </span>
            )}
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
              {plan.kind === "full_payment" ? "In full" : "Instalments"}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-700">{describePlan(plan)}</p>
          {plan.description !== undefined && (
            <p className="mt-1 text-xs text-slate-500">{plan.description}</p>
          )}
          <p className="mt-1 text-xs text-slate-500">
            {plan.appliesToLotTypes.length === 0
              ? "Every lot type"
              : plan.appliesToLotTypes.join(", ")}
          </p>
          <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
            On a {formatPeso(100_000_00)} lot: {previewOf(plan)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2">
          {!plan.isDefault && (
            <button
              type="button"
              onClick={onMakeDefault}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Make default
            </button>
          )}
          <button
            type="button"
            onClick={onRetire}
            data-testid="plan-retire"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Retire
          </button>
        </div>
      </div>
    </li>
  );
}

// --- promotions -------------------------------------------------------

function PromosSection({ promos }: { promos?: PromoRow[] }): ReactElement {
  const create = useMutation(createPromoRef);
  const retire = useMutation(retirePromoRef);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"percent" | "pesos">("percent");
  const [amount, setAmount] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [kinds, setKinds] = useState<PlanKind[]>([]);
  const [limit, setLimit] = useState("");

  const live = (promos ?? []).filter((p) => !p.isRetired);

  return (
    <section data-testid="promos-section" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl font-light">Promotions</h2>
        <button
          type="button"
          data-testid="new-promo"
          onClick={() => {
            setError(null);
            setOpen((v) => !v);
          }}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {open ? "Cancel" : "New promotion"}
        </button>
      </div>

      <p className="max-w-2xl text-sm text-slate-600">
        A promotion runs for a period and comes off on top of a plan. Give
        it a code and it applies only when a family produces the code
        &mdash; leave the code blank and the sale desk gets it
        automatically, so nobody is quoted a worse price because the
        operator did not know it was running.
      </p>

      {open && (
        <form
          data-testid="promo-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            const startsMs = dayStartMs(starts);
            const endsMs = dayStartMs(ends);
            if (startsMs === null || endsMs === null) {
              setError("Both dates are needed.");
              setBusy(false);
              return;
            }
            const payload: Parameters<typeof create>[0] = {
              name: name.trim(),
              startsAt: startsMs,
              endsAt: endsMs,
              appliesToPlanKinds: kinds,
            };
            if (code.trim().length > 0) payload.code = code.trim();
            if (mode === "percent") {
              const pct = Number.parseFloat(amount);
              if (Number.isFinite(pct)) payload.discountPercent = pct;
            } else {
              const cents = pesosToCents(amount);
              if (Number.isFinite(cents)) payload.discountCents = cents;
            }
            const cap = Number.parseInt(limit, 10);
            if (Number.isFinite(cap) && cap > 0) payload.maxRedemptions = cap;

            void create(payload)
              .then(() => {
                setName("");
                setCode("");
                setAmount("");
                setStarts("");
                setEnds("");
                setKinds([]);
                setLimit("");
                setOpen(false);
              })
              .catch((e: unknown) => setError(messageOf(e)))
              .finally(() => setBusy(false));
          }}
          className="grid grid-cols-1 gap-4 rounded-md border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="All Souls"
              data-testid="promo-name"
              className={inputClass}
            />
          </Field>

          <Field label="Code" hint="Blank means it applies automatically">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="UNDAS26"
              data-testid="promo-code"
              className={inputClass}
            />
          </Field>

          <Field label="Off">
            <div className="flex gap-2">
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "percent" | "pesos")}
                className={`${inputClass} w-28`}
              >
                <option value="percent">Per cent</option>
                <option value="pesos">Pesos</option>
              </select>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder={mode === "percent" ? "5" : "5,000"}
                data-testid="promo-amount"
                className={inputClass}
              />
            </div>
          </Field>

          <Field label="Starts">
            <input
              type="date"
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
              data-testid="promo-starts"
              className={inputClass}
            />
          </Field>

          <Field label="Ends" hint="The last day is not included">
            <input
              type="date"
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
              data-testid="promo-ends"
              className={inputClass}
            />
          </Field>

          <Field label="Limit" hint="Optional — stop after this many lots">
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              inputMode="numeric"
              placeholder="50"
              className={inputClass}
            />
          </Field>

          <div className="sm:col-span-2 lg:col-span-3">
            <p className="mb-1 text-sm font-medium text-slate-700">
              Which plans
            </p>
            <div className="flex flex-wrap gap-3">
              {(["full_payment", "installment"] as PlanKind[]).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={kinds.includes(k)}
                    onChange={(e) =>
                      setKinds((prev) =>
                        e.target.checked
                          ? [...prev, k]
                          : prev.filter((x) => x !== k),
                      )
                    }
                  />
                  {k === "full_payment" ? "Paid in full" : "Instalments"}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Tick nothing and it applies to both.
            </p>
          </div>

          {error !== null && (
            <p
              role="alert"
              data-testid="promo-error"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 sm:col-span-2 lg:col-span-3"
            >
              {error}
            </p>
          )}

          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={busy || name.trim().length < 2}
              data-testid="promo-submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {busy ? "Saving…" : "Add promotion"}
            </button>
          </div>
        </form>
      )}

      {promos === undefined ? (
        <p className="text-sm text-slate-500">Loading&hellip;</p>
      ) : live.length === 0 ? (
        <p className="text-sm text-slate-600">
          No promotions. Plans still apply on their own.
        </p>
      ) : (
        <ul className="space-y-2">
          {live.map((p) => (
            <li
              key={p._id}
              data-testid="promo-row"
              className={[
                "flex flex-wrap items-start justify-between gap-3 rounded-md border p-4",
                p.isLive
                  ? "border-emerald-300 bg-emerald-50"
                  : "border-slate-200 bg-white",
              ].join(" ")}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-lg text-slate-900">
                    {p.name}
                  </span>
                  {p.code !== undefined && (
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-xs text-white">
                      {p.code}
                    </span>
                  )}
                  <span className="text-xs text-slate-600">
                    {p.isLive ? "Running now" : "Not running"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {p.discountPercent !== undefined
                    ? `${p.discountPercent}% off`
                    : `${formatPeso(p.discountCents ?? 0)} off`}
                  {" · "}
                  {formatDay(p.startsAt)} to {formatDay(p.endsAt)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {p.maxRedemptions !== undefined
                    ? `${p.redemptionCount} of ${p.maxRedemptions} taken up`
                    : `${p.redemptionCount} taken up`}
                  {p.appliesToPlanKinds.length > 0 &&
                    ` · ${p.appliesToPlanKinds
                      .map((k) => (k === "full_payment" ? "cash" : "instalments"))
                      .join(" and ")} only`}
                </p>
              </div>
              <button
                type="button"
                data-testid="promo-retire"
                onClick={() =>
                  void retire({ promoId: p._id, isRetired: true }).catch(
                    (e: unknown) => setError(messageOf(e)),
                  )
                }
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// --- bits -------------------------------------------------------------

/**
 * The server's own words, when it has any.
 *
 * `translateError` maps a code to a fixed sentence — "Please check the
 * form" for anything VALIDATION. On this page that throws away the
 * message that IS the guidance: "an instalment plan needs a down
 * payment above zero, the sale flow refuses a zero-deposit contract"
 * tells an admin exactly what to change, and the generic version tells
 * them nothing. Server message first; `translateError` for the codes
 * that carry no useful text of their own.
 */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { message?: unknown } }).data;
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
  }
  const translated = translateError(error);
  return `${translated.headline}. ${translated.detail}`;
}

function describePlan(p: PlanRow): string {
  const parts: string[] = [];
  if (p.discountPercent !== undefined && p.discountPercent > 0) {
    parts.push(`${p.discountPercent}% off`);
  }
  if (p.kind === "installment") {
    parts.push(`${p.downPaymentPercent ?? 0}% down`);
    parts.push(`${p.termMonths ?? 0} months`);
    if (p.surchargePercent !== undefined && p.surchargePercent > 0) {
      parts.push(`+${p.surchargePercent}% carrying charge`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "List price, paid in full";
}

/**
 * The plan against a round ₱100,000 lot.
 *
 * A percentage means nothing to anyone until it is a peso figure. This
 * mirrors `convex/lib/pricing.ts` for a single illustrative lot; the
 * real quote at the sale desk comes from the server.
 */
function previewOf(p: PlanRow): string {
  const LIST = 100_000_00;
  let net = LIST;
  if (p.discountPercent !== undefined && p.discountPercent > 0) {
    net -= Math.round((net * p.discountPercent) / 100);
  }
  if (p.kind === "full_payment") return `${formatPeso(net)}`;

  if (p.surchargePercent !== undefined && p.surchargePercent > 0) {
    net += Math.round((net * p.surchargePercent) / 100);
  }
  const term = p.termMonths ?? 0;
  if (term <= 0) return "no term set — this plan cannot close a sale";
  const down = Math.round((net * (p.downPaymentPercent ?? 0)) / 100);
  if (down <= 0) return "no deposit — the sale flow refuses this plan";
  const monthly = Math.floor((net - down) / term);
  return `${formatPeso(down)} down, then ${formatPeso(monthly)} a month for ${term}`;
}

function dayStartMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

function formatDay(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ms));
}

const inputClass =
  "block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint !== undefined && (
        <span className="text-xs text-slate-500">{hint}</span>
      )}
    </label>
  );
}
