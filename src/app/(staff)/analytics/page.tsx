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

// --- page -------------------------------------------------------------

export default function AnalyticsPage(): ReactElement {
  // No role gate here: `/analytics` is in `isOfficeRoute`, so a field
  // worker never reaches this component. See the note in
  // `src/middleware.ts` — the edge decides, not the render.
  const data = useQuery(analyticsRef, {});

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
