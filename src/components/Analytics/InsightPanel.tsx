"use client";

/**
 * Descriptive, diagnostic, predictive, prescriptive — shown as such.
 *
 * The four levels are the point, so they are the structure: you read
 * down from what happened, to why, to what happens next, to what to do.
 *
 * Each finding carries how far it can be trusted and what it was
 * computed from. The difference between a fact and an extrapolation is
 * the whole difference between this being useful and this being
 * dangerous, and a dashboard that flattens the two gets a garden
 * repriced off a coincidence.
 *
 * `observed` is a fact from the data. `indicative` is a comparison that
 * holds but has other explanations. `speculative` is arithmetic about
 * the future. Nothing here hides which it is.
 *
 * @gated-route-only — mounts on `/analytics`; middleware keeps field
 * workers off that family, and the query behind it is admin-only.
 */

import { type ReactElement } from "react";

export type InsightLevel =
  | "descriptive"
  | "diagnostic"
  | "predictive"
  | "prescriptive";

export type Confidence = "observed" | "indicative" | "speculative";

export interface Insight {
  level: InsightLevel;
  topic: "agents" | "phases";
  headline: string;
  detail: string;
  confidence: Confidence;
  basis: string;
  action?: string;
}

const LEVELS: Array<{
  key: InsightLevel;
  letter: string;
  title: string;
  blurb: string;
}> = [
  {
    key: "descriptive",
    letter: "D",
    title: "Descriptive",
    blurb: "What happened.",
  },
  {
    key: "diagnostic",
    letter: "D",
    title: "Diagnostic",
    blurb: "Why it might have. Leads, not causes.",
  },
  {
    key: "predictive",
    letter: "P",
    title: "Predictive",
    blurb: "Where it goes if nothing changes. Arithmetic, not a forecast.",
  },
  {
    key: "prescriptive",
    letter: "P",
    title: "Prescriptive",
    blurb: "What could be done about it.",
  },
];

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  observed: "Observed",
  indicative: "Indicative",
  speculative: "Speculative",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  observed: "bg-emerald-100 text-emerald-900",
  indicative: "bg-amber-100 text-amber-900",
  speculative: "bg-slate-200 text-slate-700",
};

export interface InsightPanelProps {
  title: string;
  subtitle: string;
  insights: Insight[];
}

export function InsightPanel({
  title,
  subtitle,
  insights,
}: InsightPanelProps): ReactElement {
  return (
    <section data-testid="insight-panel" className="space-y-4">
      <div>
        <h2 className="font-display text-2xl font-light">{title}</h2>
        <p className="mt-0.5 max-w-2xl text-sm text-slate-600">{subtitle}</p>
      </div>

      {LEVELS.map((level) => {
        const rows = insights.filter((i) => i.level === level.key);
        if (rows.length === 0) return null;
        return (
          <div key={level.key} data-testid={`insight-${level.key}`}>
            <h3 className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold uppercase tracking-[0.14em] text-slate-500">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-slate-900 font-mono text-xs text-white">
                {level.letter}
              </span>
              {level.title}
              <span className="font-sans text-xs font-normal normal-case tracking-normal text-slate-500">
                {level.blurb}
              </span>
            </h3>

            <ul className="space-y-2">
              {rows.map((i, idx) => (
                <li
                  key={`${level.key}-${idx}`}
                  data-testid="insight-row"
                  className="rounded-md border border-slate-200 bg-white p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-medium text-slate-900">
                      {i.headline}
                    </p>
                    <span
                      data-testid="insight-confidence"
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${CONFIDENCE_TONE[i.confidence]}`}
                    >
                      {CONFIDENCE_LABEL[i.confidence]}
                    </span>
                  </div>

                  <p className="mt-1 text-sm text-slate-700">{i.detail}</p>

                  {i.action !== undefined && (
                    <p
                      data-testid="insight-action"
                      className="mt-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-800"
                    >
                      <span className="font-medium">Try: </span>
                      {i.action}
                    </p>
                  )}

                  {/* What it was computed from, on every finding. It is
                      the only thing separating this from a dashboard
                      that simply asserts. */}
                  <p className="mt-2 text-xs text-slate-500">
                    Based on: {i.basis}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
