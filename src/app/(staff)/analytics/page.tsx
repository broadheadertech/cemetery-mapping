"use client";

/**
 * /analytics — how much ground is left, and how long it lasts.
 *
 * The money reports answer "what did we take last month". This answers
 * the question underneath it: at the rate we are actually selling, when
 * does the park run out of lots — and does the phase plan agree?
 *
 * Written to be read top-down by someone deciding whether to spend on
 * the next parcel. The runway comes first because it is the answer;
 * everything below it is the working. Where the numbers cannot support
 * a conclusion the page says so in a sentence rather than showing a
 * confident-looking figure measured from two months of data.
 *
 * No pesos anywhere. Inventory and money are different questions and
 * the reports that answer the second are better than anything here.
 */

import { type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";
import { InsightPanel, type Insight } from "@/components/Analytics";

// --- server surface ---------------------------------------------------

interface MonthPoint {
  month: string;
  lotsSold: number;
  interments: number;
}

interface SectionRow {
  section: string;
  total: number;
  available: number;
  reserved: number;
  sold: number;
  occupied: number;
  sellThroughPercent: number;
}

interface Variance {
  plannedPerMonth: number;
  measuredPerMonth: number;
  percentOfPlan: number;
  verdict: "agrees" | "sales_below_plan" | "sales_above_plan" | "unknown";
  message: string;
  isRisk: boolean;
}

interface PhaseCheck {
  phaseId: string;
  number: number;
  name: string;
  stage: string;
  plannedPerMonth: number;
  variance: Variance;
}

interface Analytics {
  windowMonths: number;
  series: MonthPoint[];
  totalLots: number;
  availableLots: number;
  reservedLots: number;
  soldLots: number;
  occupiedLots: number;
  retiredLots: number;
  absorption: {
    perMonth: number;
    recentPerMonth: number;
    totalSold: number;
    monthsObserved: number;
    confidence: "good" | "thin" | "insufficient";
    trend: "accelerating" | "slowing" | "steady";
    caveat?: string;
  };
  runway: {
    months: number | null;
    years: number | null;
    label: string;
    isUrgent: boolean;
  };
  sellThroughPercent: number;
  sections: SectionRow[];
  phaseChecks: PhaseCheck[];
  intermentsInWindow: number;
  generatedAtMs: number;
}

const analyticsRef = makeFunctionReference<
  "query",
  Record<string, never>,
  Analytics
>("analytics:getInventoryAnalytics");

interface AgentFacts {
  agentId: string;
  name: string;
  isSystem: boolean;
  salesCount: number;
  soldValueCents: number;
  commissionCents: number;
  commissionDueCents: number;
  commissionNotDueCents: number;
  activeMonths: number;
}

interface PhaseFacts {
  phaseId: string;
  number: number;
  name: string;
  stage: string;
  totalLots: number;
  availableLots: number;
  soldLots: number;
  soldInWindow: number;
  windowMonths: number;
  averagePriceCents: number;
}

interface DiscountLine {
  key: string;
  label: string;
  contracts: number;
  discountedContracts: number;
  listCents: number;
  discountCents: number;
}

interface DiscountFacts {
  windowMonths: number;
  totalContracts: number;
  discountedContracts: number;
  totalDiscountCents: number;
  discountedListCents: number;
  byAgent: DiscountLine[];
  bySection: DiscountLine[];
  reasons: Array<{ reason: string; count: number; discountCents: number }>;
  policyContracts: number;
}

interface AnalysisResult {
  agents: Insight[];
  phases: Insight[];
  discounts: Insight[];
  discountFacts: DiscountFacts;
  agentFacts: AgentFacts[];
  phaseFacts: PhaseFacts[];
  windowMonths: number;
  generatedAtMs: number;
}

/**
 * The caller's own roles — a `requireAuth` self-read every signed-in
 * user may run, so the page can decide what to ask for before asking.
 */
const rolesRef = makeFunctionReference<
  "query",
  Record<string, never>,
  { userId: string; roles: string[]; isActive: boolean }
>("users:getCurrentUserRoles");

const analysisRef = makeFunctionReference<
  "query",
  Record<string, never>,
  AnalysisResult
>("analytics:getAnalysis");

// --- page -------------------------------------------------------------

export default function AnalyticsPage(): ReactElement {
  // No role gate on the inventory query: `/analytics` is in
  // `isOfficeRoute`, so a field worker never reaches this component.
  const data = useQuery(analyticsRef, {});

  // The analysis IS admin-only — it names individual agents beside what
  // they earn. Office staff reach this page, so it is gated with
  // `"skip"`: a rejected `useQuery` throws during render rather than
  // resolving to `undefined`, and would take the whole page down.
  const me = useQuery(rolesRef, {});
  const isAdmin = (me?.roles ?? []).includes("admin");
  const analysis = useQuery(analysisRef, isAdmin ? {} : "skip");

  if (data === undefined) {
    return (
      <div className="space-y-6">
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Inventory
        </h1>
        <p className="text-sm text-slate-600">Counting the ground&hellip;</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Inventory
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          How fast the park is selling, measured from contracts over the
          last {data.windowMonths} months &mdash; and how long the
          remaining ground lasts at that rate.
        </p>
      </header>

      <Runway data={data} />
      <Snapshot data={data} />
      <PlanChecks checks={data.phaseChecks} />
      <Series data={data} />
      <Gardens sections={data.sections} />

      {isAdmin && analysis !== undefined && (
        <>
          <hr className="border-slate-200" />
          <InsightPanel
            title="Agents"
            subtitle={`Who is earning most and least, and what separates them. Read over the last ${analysis.windowMonths} months.`}
            insights={analysis.agents}
          />
          <AgentTable facts={analysis.agentFacts} />

          <hr className="border-slate-200" />
          <InsightPanel
            title="Phases"
            subtitle="Which parcels are being bought and which are sitting."
            insights={analysis.phases}
          />
          <PhaseTable facts={analysis.phaseFacts} />

          <hr className="border-slate-200" />
          <InsightPanel
            title="Discounts"
            subtitle="Money given away at the counter — not what a plan or a promotion takes off, which is policy."
            insights={analysis.discounts}
          />
          <DiscountTable facts={analysis.discountFacts} />
        </>
      )}

      <p className="text-xs text-slate-500">
        Counts exclude retired lots ({data.retiredLots}), voided and
        cancelled contracts, and cancelled interments. A lot with two
        contracts in one month counts once.
      </p>
    </div>
  );
}

// --- the answer -------------------------------------------------------

function Runway({ data }: { data: Analytics }): ReactElement {
  const { runway, absorption } = data;
  const unmeasurable = runway.months === null;

  return (
    <section
      data-testid="analytics-runway"
      className={[
        "rounded-md border p-6",
        unmeasurable
          ? "border-slate-300 bg-white"
          : runway.isUrgent
            ? "border-amber-400 bg-amber-50"
            : "border-emerald-300 bg-emerald-50",
      ].join(" ")}
    >
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
        Runway
      </p>
      <p
        data-testid="analytics-runway-label"
        className="mt-2 font-display text-3xl font-light text-slate-900"
      >
        {runway.label}
      </p>

      {!unmeasurable && (
        <p className="mt-2 text-sm text-slate-700">
          {data.availableLots} lots available, selling{" "}
          <strong>{absorption.perMonth} a month</strong> over the last{" "}
          {absorption.monthsObserved} month
          {absorption.monthsObserved === 1 ? "" : "s"}.
        </p>
      )}

      {absorption.caveat !== undefined && (
        <p
          data-testid="analytics-caveat"
          className="mt-3 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
        >
          {absorption.caveat}
        </p>
      )}

      {runway.isUrgent && !unmeasurable && (
        <p className="mt-3 text-sm font-medium text-amber-900">
          Survey, permits and development do not fit comfortably inside
          two years.{" "}
          <Link href="/phase-planning" className="underline">
            Check the phase plan
          </Link>
          .
        </p>
      )}
    </section>
  );
}

// --- the working ------------------------------------------------------

function Snapshot({ data }: { data: Analytics }): ReactElement {
  const tiles: Array<{ label: string; value: string; note?: string }> = [
    { label: "Lots in service", value: String(data.totalLots) },
    {
      label: "Available",
      value: String(data.availableLots),
      note: `${data.sellThroughPercent}% of the park is sold or spoken for`,
    },
    { label: "Reserved", value: String(data.reservedLots) },
    {
      label: "Sold, still empty",
      value: String(data.soldLots),
      note: "interments still ahead of the crew",
    },
    { label: "Occupied", value: String(data.occupiedLots) },
    {
      label: `Interments, ${data.windowMonths} months`,
      value: String(data.intermentsInWindow),
    },
  ];

  return (
    <section data-testid="analytics-snapshot">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
        Where the ground is
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="rounded-md border border-slate-200 bg-white p-4"
          >
            <dt className="text-xs text-slate-500">{t.label}</dt>
            <dd className="mt-1 font-display text-2xl font-light text-slate-900">
              {t.value}
            </dd>
            {t.note !== undefined && (
              <p className="mt-1 text-[11px] leading-snug text-slate-500">
                {t.note}
              </p>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

function PlanChecks({ checks }: { checks: PhaseCheck[] }): ReactElement {
  if (checks.length === 0) return <></>;

  return (
    <section data-testid="analytics-plan-checks">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
        The phase plan, checked against this
      </h2>
      <ul className="space-y-2">
        {checks.map((c) => (
          <li
            key={c.phaseId}
            data-testid="analytics-plan-check"
            className={[
              "rounded-md border p-4",
              c.variance.isRisk
                ? "border-amber-400 bg-amber-50"
                : "border-slate-200 bg-white",
            ].join(" ")}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-display text-lg text-slate-900">
                Phase {c.number} &mdash; {c.name}
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                {c.stage}
              </span>
              {c.variance.isRisk && (
                <span className="rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                  Worth acting on
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-700">{c.variance.message}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        The plan&rsquo;s rate is entered by hand on{" "}
        <Link href="/phase-planning" className="underline">
          phase planning
        </Link>
        . These figures are measured from contracts.
      </p>
    </section>
  );
}

function Series({ data }: { data: Analytics }): ReactElement {
  const peak = Math.max(
    1,
    ...data.series.map((p) => Math.max(p.lotsSold, p.interments)),
  );

  return (
    <section data-testid="analytics-series">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
        Month by month
      </h2>
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white p-4">
        <div className="flex min-w-[560px] items-end gap-3">
          {data.series.map((p) => (
            <div key={p.month} className="flex flex-1 flex-col items-center">
              <div className="flex h-32 w-full items-end justify-center gap-1">
                <Bar
                  value={p.lotsSold}
                  peak={peak}
                  className="bg-[#1D5C4D]"
                  title={`${p.lotsSold} lots sold`}
                />
                <Bar
                  value={p.interments}
                  peak={peak}
                  className="bg-slate-400"
                  title={`${p.interments} interments`}
                />
              </div>
              <span className="mt-2 font-mono text-[10px] text-slate-500">
                {p.month.slice(5)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 flex flex-wrap gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#1D5C4D]" />
          Lots sold
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-slate-400" />
          Interments
        </span>
      </p>
    </section>
  );
}

function Bar({
  value,
  peak,
  className,
  title,
}: {
  value: number;
  peak: number;
  className: string;
  title: string;
}): ReactElement {
  // A zero month must still read as a month, not as absent — a bar of
  // no height and a missing bar look the same and mean opposite things.
  const pct = value === 0 ? 0 : Math.max(6, (value / peak) * 100);
  return (
    <span
      title={title}
      className={`w-3 rounded-t ${value === 0 ? "bg-slate-200" : className}`}
      style={{ height: value === 0 ? "2px" : `${pct}%` }}
    />
  );
}

function Gardens({ sections }: { sections: SectionRow[] }): ReactElement {
  if (sections.length === 0) return <></>;

  return (
    <section data-testid="analytics-sections">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
        By garden
      </h2>
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2 font-medium">Garden</th>
              <th className="px-4 py-2 text-right font-medium">Lots</th>
              <th className="px-4 py-2 text-right font-medium">Available</th>
              <th className="px-4 py-2 text-right font-medium">Occupied</th>
              <th className="px-4 py-2 text-right font-medium">Sold</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sections.map((s) => (
              <tr key={s.section} data-testid="analytics-section-row">
                <td className="px-4 py-2.5">
                  <span className="text-slate-900">{s.section}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {s.sellThroughPercent}% sold through
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {s.total}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {s.available}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {s.occupied}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {s.sold}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Best-selling gardens first. The ones at the bottom are where
        stock is sitting &mdash; worth a look at pricing or at what the
        office is showing families first.
      </p>
    </section>
  );
}

/**
 * The numbers the agent findings were computed from.
 *
 * Shown beside the findings rather than instead of them. A reader who
 * disagrees with a conclusion should be able to see what produced it
 * without leaving the page — that is the difference between analysis
 * and assertion.
 *
 * The park's own row is included here, greyed, because it is a real and
 * usually large share of sales. It is excluded from the FINDINGS, where
 * it would be the biggest seller and the worst earner at once.
 */
function AgentTable({ facts }: { facts: AgentFacts[] }): ReactElement {
  if (facts.length === 0) return <></>;

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2 font-medium">Agent</th>
            <th className="px-4 py-2 text-right font-medium">Sales</th>
            <th className="px-4 py-2 text-right font-medium">Value sold</th>
            <th className="px-4 py-2 text-right font-medium">Commission</th>
            <th className="px-4 py-2 text-right font-medium">Payable</th>
            <th className="px-4 py-2 text-right font-medium">Waiting</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {facts.map((a) => (
            <tr
              key={a.agentId}
              data-testid="analytics-agent-row"
              className={a.isSystem ? "text-slate-500" : "text-slate-800"}
            >
              <td className="px-4 py-2.5">
                {a.name}
                {a.isSystem && (
                  <span className="ml-2 text-xs text-slate-400">
                    the park &mdash; not ranked
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {a.salesCount}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatPeso(a.soldValueCents)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatPeso(a.commissionCents)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatPeso(a.commissionDueCents)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatPeso(a.commissionNotDueCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The numbers the phase findings were computed from. */
function PhaseTable({ facts }: { facts: PhaseFacts[] }): ReactElement {
  if (facts.length === 0) return <></>;

  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
            <th className="px-4 py-2 font-medium">Phase</th>
            <th className="px-4 py-2 font-medium">Stage</th>
            <th className="px-4 py-2 text-right font-medium">Lots</th>
            <th className="px-4 py-2 text-right font-medium">Taken</th>
            <th className="px-4 py-2 text-right font-medium">
              Sold in window
            </th>
            <th className="px-4 py-2 text-right font-medium">Avg price</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {facts.map((p) => (
            <tr
              key={p.phaseId}
              data-testid="analytics-phase-row"
              className="text-slate-800"
            >
              <td className="px-4 py-2.5">{p.name}</td>
              <td className="px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-slate-500">
                {p.stage}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {p.totalLots}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {p.totalLots > 0
                  ? `${Math.round((p.soldLots / p.totalLots) * 100)}%`
                  : "—"}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {p.soldInWindow}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {p.averagePriceCents > 0
                  ? formatPeso(p.averagePriceCents)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The discounts behind the findings.
 *
 * Split by garden rather than by seller in the table, because the
 * per-seller comparison is already in the findings above and repeating
 * a name beside a peso figure twice reads as an accusation rather than
 * as data. The reasons list is the useful half: it is where a policy
 * nobody wrote down becomes visible.
 */
function DiscountTable({ facts }: { facts: DiscountFacts }): ReactElement {
  if (facts.discountedContracts === 0) return <></>;

  const rate = (row: { listCents: number; discountCents: number }): string =>
    row.listCents > 0
      ? `${(Math.round((row.discountCents / row.listCents) * 1000) / 10).toFixed(1)}%`
      : "—";

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2 font-medium">Garden</th>
              <th className="px-4 py-2 text-right font-medium">Discounted</th>
              <th className="px-4 py-2 text-right font-medium">Given</th>
              <th className="px-4 py-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {facts.bySection
              .filter((row) => row.discountedContracts > 0)
              .map((row) => (
                <tr key={row.key} data-testid="discount-section-row">
                  <td className="px-4 py-2.5 text-slate-800">{row.label}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                    {row.discountedContracts} of {row.contracts}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                    {formatPeso(row.discountCents)}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                    {rate(row)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wider text-slate-500">
              <th className="px-4 py-2 font-medium">Reason given</th>
              <th className="px-4 py-2 text-right font-medium">Times</th>
              <th className="px-4 py-2 text-right font-medium">Worth</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {facts.reasons.slice(0, 12).map((r) => (
              <tr key={r.reason} data-testid="discount-reason-row">
                <td className="px-4 py-2.5 text-slate-800">{r.reason}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {r.count}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">
                  {formatPeso(r.discountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          Grouped on the exact words typed. A reason appearing again and
          again is usually a policy that belongs in the price book.
        </p>
      </div>
    </div>
  );
}
