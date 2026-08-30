"use client";

/**
 * /admin/settings/sales-agents — who sells for the park, and on what terms.
 *
 * An agent here is a record, not a login. A sale is credited to a name
 * so the park can answer "who sold this" and "what do we owe"; nobody
 * signs in as an agent and nothing on this page grants access to
 * anything.
 *
 * Admin-only. Office staff attach an agent to a sale all day; a staffer
 * who could also mint one and set its rate could route commission
 * wherever they liked and it would look like ordinary desk work.
 */

import { useState, type ReactElement } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

interface AgentRow {
  _id: string;
  fullName: string;
  code?: string;
  phone?: string;
  email?: string;
  commissionPercent?: number;
  notes?: string;
  isRetired: boolean;
}

interface AgentList {
  agents: AgentRow[];
  defaultCommissionPercent: number;
  earnedAtPercent: number;
}

const listRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  AgentList
>("salesAgents:listSalesAgents");

const createRef = makeFunctionReference<
  "mutation",
  {
    fullName: string;
    code?: string;
    phone?: string;
    email?: string;
    commissionPercent?: number;
  },
  { agentId: string }
>("salesAgents:createSalesAgent");

const retireRef = makeFunctionReference<
  "mutation",
  { agentId: string; isRetired: boolean },
  { agentId: string }
>("salesAgents:setSalesAgentRetired");

const policyRef = makeFunctionReference<
  "mutation",
  { defaultCommissionPercent?: number; earnedAtPercent?: number },
  { ok: true }
>("salesAgents:setCommissionPolicy");

export default function SalesAgentsPage(): ReactElement {
  const list = useQuery(listRef, { includeRetired: true });

  return (
    <div className="space-y-10">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Sales agents
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Who sells for the park, and what they are owed. Agents are
          records only &mdash; nobody signs in as one.
        </p>
      </header>

      <PolicyPanel list={list} />
      <RegisterPanel list={list} />
    </div>
  );
}

function PolicyPanel({ list }: { list?: AgentList }): ReactElement {
  const save = useMutation(policyRef);
  const [rate, setRate] = useState("");
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  return (
    <section
      data-testid="commission-policy"
      className="space-y-4 rounded-md border border-slate-200 bg-white p-5"
    >
      <h2 className="font-display text-2xl font-light">The terms</h2>

      {list !== undefined && (
        <p className="text-sm text-slate-700">
          Standard rate:{" "}
          <span className="font-medium">
            {list.defaultCommissionPercent > 0
              ? `${list.defaultCommissionPercent}%`
              : "not set"}
          </span>
          {" · "}
          Payable once{" "}
          <span className="font-medium">{list.earnedAtPercent}%</span> of a
          contract has been collected
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            Standard rate
          </span>
          <input
            value={rate}
            onChange={(e) => {
              setRate(e.target.value);
              setSaved(false);
            }}
            inputMode="decimal"
            placeholder={String(list?.defaultCommissionPercent ?? "")}
            data-testid="commission-rate"
            className={inputClass}
          />
          <span className="text-xs text-slate-500">
            Per cent of the contract. An agent&rsquo;s own rate overrides
            it; a rate agreed at the desk overrides both.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">
            Payable once collected
          </span>
          <input
            value={threshold}
            onChange={(e) => {
              setThreshold(e.target.value);
              setSaved(false);
            }}
            inputMode="decimal"
            placeholder={String(list?.earnedAtPercent ?? 20)}
            data-testid="commission-threshold"
            className={inputClass}
          />
          <span className="text-xs text-slate-500">
            Per cent of the price the family must have paid before the
            park owes anything. Zero pays at signing &mdash; which means
            paying commission on money that may never arrive.
          </span>
        </label>
      </div>

      {error !== null && (
        <p
          role="alert"
          data-testid="policy-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}
      {saved && (
        <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Saved. This applies to sales recorded from now on; contracts
          already written keep the rate they were sold under.
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        data-testid="policy-save"
        onClick={() => {
          setBusy(true);
          setError(null);
          const payload: Parameters<typeof save>[0] = {};
          const r = Number.parseFloat(rate);
          if (Number.isFinite(r)) payload.defaultCommissionPercent = r;
          const t = Number.parseFloat(threshold);
          if (Number.isFinite(t)) payload.earnedAtPercent = t;
          void save(payload)
            .then(() => {
              setSaved(true);
              setRate("");
              setThreshold("");
            })
            .catch((e: unknown) => setError(messageOf(e)))
            .finally(() => setBusy(false));
        }}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
      >
        {busy ? "Saving…" : "Save the terms"}
      </button>
    </section>
  );
}

function RegisterPanel({ list }: { list?: AgentList }): ReactElement {
  const create = useMutation(createRef);
  const retire = useMutation(retireRef);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [rate, setRate] = useState("");

  const active = (list?.agents ?? []).filter((a) => !a.isRetired);
  const retired = (list?.agents ?? []).filter((a) => a.isRetired);

  return (
    <section data-testid="agents-register" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl font-light">The agents</h2>
        <button
          type="button"
          data-testid="new-agent"
          onClick={() => {
            setError(null);
            setOpen((v) => !v);
          }}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          {open ? "Cancel" : "Add an agent"}
        </button>
      </div>

      {open && (
        <form
          data-testid="agent-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            const payload: Parameters<typeof create>[0] = {
              fullName: fullName.trim(),
            };
            if (code.trim().length > 0) payload.code = code.trim();
            if (phone.trim().length > 0) payload.phone = phone.trim();
            if (email.trim().length > 0) payload.email = email.trim();
            const r = Number.parseFloat(rate);
            if (Number.isFinite(r)) payload.commissionPercent = r;

            void create(payload)
              .then(() => {
                setFullName("");
                setCode("");
                setPhone("");
                setEmail("");
                setRate("");
                setOpen(false);
              })
              .catch((e: unknown) => setError(messageOf(e)))
              .finally(() => setBusy(false));
          }}
          className="grid grid-cols-1 gap-4 rounded-md border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          <Field label="Full name">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              data-testid="agent-name"
              className={inputClass}
            />
          </Field>
          <Field label="Code" hint="Optional, for the paperwork">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="MC01"
              className={inputClass}
            />
          </Field>
          <Field
            label="Their rate"
            hint={
              list !== undefined && list.defaultCommissionPercent > 0
                ? `Blank uses the park's ${list.defaultCommissionPercent}%`
                : "Blank uses the park's standard rate"
            }
          >
            <input
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              inputMode="decimal"
              data-testid="agent-rate"
              className={inputClass}
            />
          </Field>
          <Field label="Phone">
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Email">
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </Field>

          {error !== null && (
            <p
              role="alert"
              data-testid="agent-error"
              className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 sm:col-span-2 lg:col-span-3"
            >
              {error}
            </p>
          )}

          <div className="sm:col-span-2 lg:col-span-3">
            <button
              type="submit"
              disabled={busy || fullName.trim().length < 2}
              data-testid="agent-submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {busy ? "Saving…" : "Add"}
            </button>
          </div>
        </form>
      )}

      {list === undefined ? (
        <p className="text-sm text-slate-500">Loading&hellip;</p>
      ) : active.length === 0 ? (
        <p
          data-testid="agents-empty"
          className="rounded-md border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700"
        >
          No agents yet. Sales recorded without one simply carry no
          commission, which is the right answer for a walk-in.
        </p>
      ) : (
        <ul className="space-y-2">
          {active.map((a) => (
            <li
              key={a._id}
              data-testid="agent-row"
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-slate-200 bg-white p-4"
            >
              <div>
                <p className="font-medium text-slate-900">
                  {a.fullName}
                  {a.code !== undefined && (
                    <span className="ml-2 font-mono text-xs text-slate-500">
                      {a.code}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-sm text-slate-700">
                  {a.commissionPercent !== undefined
                    ? `${a.commissionPercent}%`
                    : `${list.defaultCommissionPercent > 0 ? `${list.defaultCommissionPercent}% (park standard)` : "no rate set"}`}
                </p>
                {(a.phone !== undefined || a.email !== undefined) && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {[a.phone, a.email].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>
              <button
                type="button"
                data-testid="agent-retire"
                onClick={() =>
                  void retire({ agentId: a._id, isRetired: true }).catch(
                    (e: unknown) => setError(messageOf(e)),
                  )
                }
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Retire
              </button>
            </li>
          ))}
        </ul>
      )}

      {retired.length > 0 && (
        <details data-testid="agents-retired">
          <summary className="cursor-pointer text-sm text-slate-600">
            {retired.length} retired
          </summary>
          <ul className="mt-2 space-y-2">
            {retired.map((a) => (
              <li
                key={a._id}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-4 py-2 text-sm"
              >
                <span className="text-slate-600">{a.fullName}</span>
                <button
                  type="button"
                  onClick={() =>
                    void retire({ agentId: a._id, isRetired: false })
                  }
                  className="text-xs font-medium text-slate-700 underline"
                >
                  Reinstate
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Retired agents are kept, never deleted &mdash; a contract has
            to go on saying who sold it.
          </p>
        </details>
      )}
    </section>
  );
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

/** The server's own words — its messages name the actual problem. */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { message?: unknown } }).data;
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
  }
  return "Something went wrong. Nothing was saved.";
}
