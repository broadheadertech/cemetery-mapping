"use client";

/**
 * /lots/suggest — help a family choose a lot.
 *
 * Built for the conversation it happens in. A family sits down with a
 * budget, a number the plot has to hold, sometimes a garden, very often
 * "somewhere near my father". Staff fill that in once and read the
 * answer back across the desk.
 *
 * Which is why every suggestion shows the REASONS it was picked rather
 * than a rank or a score. "Lot B-104, ₱45,000, in Garden of Faith as
 * you asked, forty metres from the Reyes plot, room for two" is
 * something you can say to a person. "Relevance 0.87" is not.
 *
 * Nothing here is a recommendation the system insists on: the criteria
 * are the family's, the ordering is arithmetic, and the staffer picks.
 */

import { useMemo, useState, type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso, pesosToCents } from "@/lib/money";

interface Reason {
  label: string;
  points: number;
}

interface Suggestion {
  lotId: string;
  code: string;
  section: string;
  basePriceCents: number;
  score: number;
  reasons: Reason[];
  distanceMetres?: number;
  bodiesRemaining: number;
}

interface SuggestResult {
  suggestions: Suggestion[];
  considered: number;
  truncated: boolean;
  nearLotNotFound: boolean;
}

type SuggestArgs = {
  maxPriceCents?: number;
  requiredBodies?: number;
  requiredBones?: number;
  preferredType?: string;
  preferredSection?: string;
  nearLotCode?: string;
  limit?: number;
};

const suggestRef = makeFunctionReference<"query", SuggestArgs, SuggestResult>(
  "lotSuggestions:suggestLotsForFamily",
);

/**
 * The caller's own roles — a `requireAuth` self-read every signed-in
 * user may run. `suggestLotsForFamily` is office-only, and `useQuery`
 * THROWS a rejected query during render rather than returning
 * `undefined`, so a field worker who reached this page and pressed the
 * button got a crash screen instead of an answer.
 */
const rolesRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { userId: string; roles: string[]; isActive: boolean }
>("users:getCurrentUserRoles");

const LOT_TYPES = ["single", "family", "mausoleum", "niche"] as const;

export default function SuggestLotPage(): ReactElement {
  const [budget, setBudget] = useState("");
  const [bodies, setBodies] = useState("1");
  const [bones, setBones] = useState("0");
  const [type, setType] = useState("");
  const [section, setSection] = useState("");
  const [nearCode, setNearCode] = useState("");
  const [submitted, setSubmitted] = useState<SuggestArgs | null>(null);

  const me = useQuery(rolesRef, {});
  const roles = me?.roles ?? [];
  const mayUse = roles.includes("admin") || roles.includes("office_staff");

  // The query runs only once the staffer asks — the form is filled in
  // while a family talks, and re-querying on every keystroke would put
  // a moving list in front of them. And only for a role that may run
  // it: a rejected query is a crash, not an empty result.
  const result = useQuery(
    suggestRef,
    mayUse && submitted !== null ? submitted : "skip",
  );
  const loading = mayUse && submitted !== null && result === undefined;

  const args = useMemo((): SuggestArgs => {
    const out: SuggestArgs = { limit: 5 };
    const cents = pesosToCents(budget);
    if (budget.trim().length > 0 && !Number.isNaN(cents) && cents > 0) {
      out.maxPriceCents = cents;
    }
    const b = Number.parseInt(bodies, 10);
    if (Number.isFinite(b) && b > 0) out.requiredBodies = b;
    const n = Number.parseInt(bones, 10);
    if (Number.isFinite(n) && n > 0) out.requiredBones = n;
    if (type.length > 0) out.preferredType = type;
    if (section.trim().length > 0) out.preferredSection = section.trim();
    if (nearCode.trim().length > 0) out.nearLotCode = nearCode.trim();
    return out;
  }, [budget, bodies, bones, type, section, nearCode]);

  if (me !== undefined && !mayUse) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Help a family choose
        </h1>
        <p
          data-testid="suggest-not-permitted"
          className="max-w-xl rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          Lot pricing and availability are an office matter, so this
          helper is limited to office staff and administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Help a family choose
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Enter what the family has told you. Anything left blank simply
          is not considered. Lots over the budget, or too small for the
          number given, are never suggested.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(args);
        }}
        className="grid grid-cols-1 gap-4 rounded-md border border-slate-200 bg-white p-5 sm:grid-cols-2 lg:grid-cols-3"
      >
        <Field label="Budget" hint="Leave blank if they have not said">
          <input
            type="text"
            inputMode="decimal"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="₱50,000"
            className={inputClass}
          />
        </Field>

        <Field label="Interments needed" hint="Bodies the plot must hold">
          <input
            type="number"
            min={0}
            value={bodies}
            onChange={(e) => setBodies(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Transferred remains"
          hint="Two sets take the space of one body"
        >
          <input
            type="number"
            min={0}
            value={bones}
            onChange={(e) => setBones(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label="Lot type" hint="A preference, not a requirement">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={inputClass}
          >
            <option value="">No preference</option>
            {LOT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Garden" hint="A preference, not a requirement">
          <input
            type="text"
            value={section}
            onChange={(e) => setSection(e.target.value)}
            placeholder="Garden of Faith"
            className={inputClass}
          />
        </Field>

        <Field label="Near which lot" hint="A plot the family already has">
          <input
            type="text"
            value={nearCode}
            onChange={(e) => setNearCode(e.target.value)}
            placeholder="A-2-01"
            className={inputClass}
          />
        </Field>

        <div className="sm:col-span-2 lg:col-span-3">
          <button
            type="submit"
            data-testid="suggest-submit"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            {loading ? "Looking…" : "Suggest lots"}
          </button>
        </div>
      </form>

      {result !== undefined && (
        <Results result={result} hadCriteria={submitted !== null} />
      )}
    </div>
  );
}

function Results({
  result,
  hadCriteria,
}: {
  result: SuggestResult;
  hadCriteria: boolean;
}): ReactElement {
  if (!hadCriteria) return <></>;

  // A code that matched nothing is worth saying out loud: without it the
  // list looks like a plain answer when one of the family's criteria was
  // silently dropped.
  const notFound = result.nearLotNotFound ? (
    <div
      role="status"
      data-testid="suggest-near-not-found"
      className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      No lot matched that code, so nearness was not considered. Check it
      against the family&rsquo;s papers &mdash; everything else below still
      applies.
    </div>
  ) : null;

  if (result.suggestions.length === 0) {
    return (
      <div className="space-y-3">
        {notFound}
        <div
          data-testid="suggest-empty"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-medium">Nothing available fits.</p>
          <p className="mt-1">
            {result.considered} available lot
            {result.considered === 1 ? "" : "s"} were considered. Something
            has to give &mdash; a larger budget, fewer interments, or a
            different garden. Better to say that than to offer a lot that
            will not do.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="suggest-results">
      {notFound}
      <p className="text-sm text-slate-600">
        {result.suggestions.length} of {result.considered} available lots,
        best fit first.
        {result.truncated &&
          " The inventory was larger than one scan; this may be partial."}
      </p>

      <ul className="space-y-3">
        {result.suggestions.map((s, i) => (
          <li
            key={s.lotId}
            data-testid="suggest-row"
            className="rounded-md border border-slate-200 bg-white p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {i === 0 && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-900">
                      Best fit
                    </span>
                  )}
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                    {s.section}
                  </span>
                </div>
                <p className="mt-1 font-display text-2xl font-light text-slate-900">
                  Lot {s.code}
                </p>
                <p className="text-sm text-slate-700">
                  {formatPeso(s.basePriceCents)} &middot; room for{" "}
                  {s.bodiesRemaining} interment
                  {s.bodiesRemaining === 1 ? "" : "s"}
                </p>

                {s.reasons.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {s.reasons.map((r) => (
                      <li
                        key={r.label}
                        className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-700"
                      >
                        {r.label}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex shrink-0 flex-col gap-2">
                <Link
                  href={`/lots/${s.lotId}`}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-center text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Open lot
                </Link>
                <Link
                  href={`/sales/new?lotId=${encodeURIComponent(s.lotId)}`}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-center text-xs font-medium text-white hover:bg-slate-800"
                >
                  Start a sale
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
