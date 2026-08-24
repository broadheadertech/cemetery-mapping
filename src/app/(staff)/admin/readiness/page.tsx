"use client";

/**
 * /admin/readiness — is this deployment ready to take real money?
 *
 * `docs/go-live-checklist.md` is the same list written for a person,
 * but a document cannot tell you whether a variable is actually set on
 * the deployment. Answering that meant a developer running
 * `npx convex env list` — the exact dependency the payment-gateway
 * settings page removed for credentials. This removes it for the
 * question "what is still missing".
 *
 * Reading the page:
 *
 *   - **Blocking** — the cemetery genuinely cannot operate. Money
 *     cannot move, or a legal obligation is unmet.
 *   - **Warning** — degraded but workable.
 *   - **Cannot check** — needs a human to look somewhere this app
 *     cannot see (the Convex dashboard). Shown rather than hidden,
 *     because a checklist that quietly omits what it does not know is
 *     worse than one that admits it.
 *
 * Everything here is presence-only; no secret value is ever returned
 * by the query behind it.
 */

import { useMemo, type ReactElement } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

type Status = "ready" | "warning" | "blocking" | "unknown";

interface Check {
  id: string;
  area: "payments" | "compliance" | "communications" | "data" | "operations";
  label: string;
  status: Status;
  detail: string;
  action?: string;
  href?: string;
}

interface Report {
  checks: Check[];
  summary: { blocking: number; warning: number; unknown: number; ready: number };
}

const reportRef = makeFunctionReference<"query", Record<string, never>, Report>(
  "readiness:getReadinessReport",
);

const AREA_LABELS: Record<Check["area"], string> = {
  payments: "Payments",
  compliance: "Compliance",
  communications: "Communications",
  data: "Data",
  operations: "Operations",
};

const AREA_ORDER: ReadonlyArray<Check["area"]> = [
  "payments",
  "compliance",
  "communications",
  "data",
  "operations",
];

export default function ReadinessPage(): ReactElement {
  const report = useQuery(reportRef, {});

  const grouped = useMemo(() => {
    if (report === undefined) return null;
    const map = new Map<Check["area"], Check[]>();
    for (const area of AREA_ORDER) map.set(area, []);
    for (const check of report.checks) {
      map.get(check.area)?.push(check);
    }
    // Worst first inside each area — the thing that stops the cemetery
    // operating should not be below three green ticks.
    const rank: Record<Status, number> = {
      blocking: 0,
      unknown: 1,
      warning: 2,
      ready: 3,
    };
    for (const list of map.values()) {
      list.sort((a, b) => rank[a.status] - rank[b.status]);
    }
    return map;
  }, [report]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Go-live readiness
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          What this deployment has configured, checked live. The written
          version with owners and lead times is in{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            docs/go-live-checklist.md
          </code>
          .
        </p>
      </header>

      {report === undefined && (
        <div className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600">
          Checking…
        </div>
      )}

      {report !== undefined && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile
              label="Blocking"
              count={report.summary.blocking}
              tone={report.summary.blocking > 0 ? "bad" : "good"}
            />
            <Tile
              label="Warnings"
              count={report.summary.warning}
              tone={report.summary.warning > 0 ? "warn" : "good"}
            />
            <Tile
              label="Cannot check"
              count={report.summary.unknown}
              tone="neutral"
            />
            <Tile label="Ready" count={report.summary.ready} tone="good" />
          </div>

          {report.summary.blocking === 0 ? (
            <div className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              <p className="font-medium">Nothing blocking.</p>
              <p className="mt-1">
                Note that the items under “Cannot check” still need a human
                to confirm — backups in particular.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
              <p className="font-medium">
                {report.summary.blocking} item
                {report.summary.blocking === 1 ? "" : "s"} would stop the
                cemetery operating.
              </p>
              <p className="mt-1">
                These are not cosmetic — each one means money cannot move or
                a legal obligation is unmet.
              </p>
            </div>
          )}

          {AREA_ORDER.map((area) => {
            const checks = grouped?.get(area) ?? [];
            if (checks.length === 0) return null;
            return (
              <section key={area} className="space-y-2">
                <h2 className="font-mono text-xs uppercase tracking-[0.16em] text-slate-500">
                  {AREA_LABELS[area]}
                </h2>
                <ul className="space-y-2">
                  {checks.map((check) => (
                    <CheckRow key={check.id} check={check} />
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "good" | "warn" | "bad" | "neutral";
}): ReactElement {
  const toneClass =
    tone === "bad"
      ? "border-red-300 bg-red-50 text-red-900"
      : tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : tone === "good"
          ? "border-emerald-300 bg-emerald-50 text-emerald-900"
          : "border-slate-200 bg-white text-slate-700";
  return (
    <div className={`rounded-md border p-4 ${toneClass}`}>
      <div className="text-2xl font-semibold tabular-nums">{count}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: Check }): ReactElement {
  const badge =
    check.status === "blocking"
      ? { text: "Blocking", cls: "bg-red-100 text-red-800" }
      : check.status === "warning"
        ? { text: "Warning", cls: "bg-amber-100 text-amber-900" }
        : check.status === "unknown"
          ? { text: "Cannot check", cls: "bg-slate-200 text-slate-700" }
          : { text: "Ready", cls: "bg-emerald-100 text-emerald-900" };

  const border =
    check.status === "blocking"
      ? "border-red-300"
      : check.status === "warning"
        ? "border-amber-300"
        : "border-slate-200";

  return (
    <li
      data-testid={`readiness-${check.id}`}
      data-status={check.status}
      className={`rounded-md border bg-white p-4 ${border}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-xs font-medium ${badge.cls}`}
            >
              {badge.text}
            </span>
            <span className="text-sm font-medium text-slate-900">
              {check.label}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-slate-700">{check.detail}</p>
          {check.action !== undefined && (
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-medium">Next:</span> {check.action}
            </p>
          )}
        </div>
        {check.href !== undefined && (
          <Link
            href={check.href}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Open
          </Link>
        )}
      </div>
    </li>
  );
}
