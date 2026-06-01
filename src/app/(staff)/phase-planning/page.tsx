"use client";

/**
 * /phase-planning — development-parcel runway, survey pipeline, and the
 * "how to map a phase" playbook (Phase Planning feature).
 *
 * Answers two operator questions in one screen:
 *   1. WHEN do we run out of inventory? — the runway readout (KPIs +
 *      warning banner), derived server-side in `phasePlanning.ts`.
 *   2. HOW do we bring the next parcel online, and are we prepared? —
 *      the 6-step playbook (static reference) + the next parcel's
 *      readiness checklist (per-phase data).
 *
 * Reactive: the overview re-renders when ops adjusts a phase's available
 * count / absorption. Server-side enforcement lives in
 * `phasePlanning.getPhasePlanningOverview` (`requireRole(["admin",
 * "office_staff"])`); this page is the back-office surface only — it is
 * absent from the field-worker nav.
 *
 * The Convex `_generated/` ambient module is not committed; we reference
 * functions via `makeFunctionReference`, matching `/admin/trends` and the
 * other admin pages.
 */

import { useQuery, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import Link from "next/link";
import {
  AlertTriangle,
  Boxes,
  Upload,
  ArrowRight,
  Check,
  Clock,
  Circle,
  type LucideIcon,
} from "lucide-react";

import { KpiCard } from "@/components/KpiCard";
import { StatusPill, type PillStatus } from "@/components/ui/StatusPill";
import { PHASE_MAP_STEPS } from "./playbook";

type PhaseStage = "live" | "surveying" | "planned";
type ReadinessStatus = "completed" | "scheduled" | "current";

interface ReadinessItem {
  label: string;
  area: string;
  status: ReadinessStatus;
}

interface PhaseOverviewRow {
  _id: string;
  number: number;
  name: string;
  sectionsLabel: string;
  stage: PhaseStage;
  plannedLotCount: number;
  availableLotCount: number;
  monthlyAbsorption: number;
  surveyLeadWeeks: number;
  projectedSelloutLabel?: string;
  readyByLabel?: string;
  readiness: ReadinessItem[];
  soldCount: number;
  sellThroughPercent: number;
  runwayMonths: number | null;
}

interface PhasePlanningOverview {
  phases: PhaseOverviewRow[];
  nextPhaseNumber: number | null;
  generatedAtMs: number;
}

const getPhasePlanningOverviewRef = makeFunctionReference<
  "query",
  Record<string, never>,
  PhasePlanningOverview
>("phasePlanning:getPhasePlanningOverview");

const seedDefaultPhasesRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  { seeded: boolean; count: number }
>("phasePlanning:seedDefaultPhases");

/** live → completed (terminal success), surveying → scheduled (awaiting),
 *  planned → current (work-in-progress). Reuses the StatusPill palette. */
const STAGE_PILL: Record<PhaseStage, PillStatus> = {
  live: "completed",
  surveying: "scheduled",
  planned: "current",
};
const STAGE_LABEL: Record<PhaseStage, string> = {
  live: "Live",
  surveying: "Surveying",
  planned: "Planned",
};

export default function PhasePlanningPage() {
  const overview = useQuery(getPhasePlanningOverviewRef, {});
  const seed = useMutation(seedDefaultPhasesRef);

  const phases = overview?.phases;
  const live = phases?.find((p) => p.stage === "live");
  const nextPhase =
    overview && overview.nextPhaseNumber !== null
      ? phases?.find((p) => p.number === overview.nextPhaseNumber)
      : undefined;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            Operations · Planning
          </p>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-text-default">
            Phase Planning
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            Inventory runway, the survey pipeline, and the playbook for
            bringing the next phase online.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/phase-3d" className={btnOutline}>
            <Boxes className="h-4 w-4" aria-hidden="true" /> Open 3D survey
          </Link>
          <Link href="/admin/gps-import" className={btnPrimary}>
            <Upload className="h-4 w-4" aria-hidden="true" /> GPS import
          </Link>
        </div>
      </header>

      {overview === undefined ? (
        <LoadingState />
      ) : phases && phases.length === 0 ? (
        <EmptyState onSeed={() => void seed({})} />
      ) : (
        <>
          {live && (
            <div
              role="status"
              className="flex items-start gap-3 rounded-md border border-status-reserved-border/40 bg-status-reserved-bg px-4 py-3 text-sm text-status-reserved-text"
            >
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-status-reserved-icon"
                aria-hidden="true"
              />
              <span>
                <strong className="font-semibold">
                  Prepare Phase {(live.number ?? 1) + 1} now.
                </strong>{" "}
                Phase {live.number} is {live.sellThroughPercent}% sold —
                about {live.runwayMonths ?? "—"} months of inventory left at
                the current pace. Survey-to-sale lead time is ~
                {live.surveyLeadWeeks} weeks, so the window to start is open
                today.
              </span>
            </div>
          )}

          {live && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label={`Phase ${live.number} sell-through`}
                value={`${live.sellThroughPercent}%`}
                delta={{
                  text: `${live.availableLotCount.toLocaleString()} lots remaining`,
                  tone: "neutral",
                }}
              />
              <KpiCard
                label="Inventory runway"
                value={live.runwayMonths === null ? "—" : `${live.runwayMonths} mo`}
                delta={{
                  text: `~${live.monthlyAbsorption} lots/mo`,
                  tone: "negative",
                }}
              />
              <KpiCard
                label="Projected sell-out"
                value={live.projectedSelloutLabel ?? "—"}
                delta={{ text: "at current pace", tone: "neutral" }}
              />
              <KpiCard
                label={`Phase ${live.number + 1} ready-by`}
                value={live.readyByLabel ?? "—"}
                delta={{
                  text: `${live.surveyLeadWeeks}-week lead time`,
                  tone: "negative",
                }}
              />
            </div>
          )}

          {/* Survey pipeline */}
          <Panel
            title="Survey pipeline"
            aside={`${phases?.length ?? 0} development parcels`}
          >
            <div className="grid grid-cols-1 gap-y-6 sm:grid-cols-3 sm:gap-y-0">
              {phases?.map((p, i) => (
                <div
                  key={p._id}
                  className={
                    i === 0
                      ? "px-0 sm:px-5"
                      : "px-0 sm:border-l sm:border-surface-emphasis sm:px-5"
                  }
                >
                  <div className="mb-3 flex items-center gap-2.5">
                    <span
                      className={[
                        "flex h-9 w-9 items-center justify-center rounded-full font-display text-lg font-semibold",
                        p.stage === "live"
                          ? "bg-primary text-primary-fg"
                          : "border border-surface-border bg-surface-emphasis text-text-muted",
                      ].join(" ")}
                    >
                      {p.number}
                    </span>
                    <span className="flex-1">
                      <span className="block text-sm font-bold text-text-default">
                        Phase {p.number}
                      </span>
                      <span className="block font-mono text-[10.5px] tracking-wide text-text-muted">
                        {p.name}
                      </span>
                    </span>
                    <StatusPill status={STAGE_PILL[p.stage]} size="sm" />
                  </div>
                  <p className="mb-2.5 text-[12.5px] text-text-muted">
                    {p.sectionsLabel}
                  </p>
                  <Progress percent={p.sellThroughPercent} live={p.stage === "live"} />
                  <div className="mt-1.5 flex justify-between font-mono text-[11.5px]">
                    <span className="text-text-muted">
                      {p.plannedLotCount.toLocaleString()} lots
                    </span>
                    <span
                      className={
                        p.stage === "live"
                          ? "font-semibold text-primary"
                          : "font-semibold text-text-muted"
                      }
                    >
                      {p.stage === "live"
                        ? `${p.sellThroughPercent}% sold`
                        : STAGE_LABEL[p.stage]}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          {/* Playbook + readiness */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
            <Panel title="How to map a phase" aside="6-step survey playbook" flush>
              <ol className="divide-y divide-surface-emphasis">
                {PHASE_MAP_STEPS.map((s) => (
                  <li
                    key={s.n}
                    className="grid grid-cols-[48px_1fr] gap-4 px-5 py-5"
                  >
                    <span className="font-display text-4xl font-semibold leading-none text-accent-gold">
                      {s.n}
                    </span>
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <h3 className="font-display text-xl font-semibold leading-tight text-text-default">
                          {s.title}
                        </h3>
                        <span className="whitespace-nowrap font-mono text-[10.5px] tracking-wide text-text-muted">
                          {s.lead}
                        </span>
                      </div>
                      <span className="mt-2 inline-block rounded-full border border-accent-gold px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-primary">
                        {s.tool}
                      </span>
                      <p className="mb-3.5 mt-3 max-w-xl text-[13.5px] leading-relaxed text-text-default">
                        {s.detail}
                      </p>
                      <div className="flex flex-wrap gap-7">
                        <MetaPair label="Owner" value={s.owner} />
                        <MetaPair label="Output" value={s.output} />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </Panel>

            <div className="space-y-6">
              <ReadinessCard nextPhase={nextPhase} />
              <Panel title="Why prepare now">
                <p className="text-[13.5px] leading-relaxed text-text-default">
                  Families buy where they can <em>see</em> a resting place.
                  The moment Phase 1 sells out, every walk-in with no
                  inventory to show is a lost sale — and a survey can&apos;t be
                  rushed without errors that surface years later as
                  ownership disputes.
                </p>
                <hr className="my-4 border-surface-border" />
                <Link
                  href="/admin/gps-import"
                  className={`${btnPrimary} w-full justify-center`}
                >
                  Start Phase {(live?.number ?? 1) + 1} survey
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Panel>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const READINESS_ICON: Record<ReadinessStatus, LucideIcon> = {
  completed: Check,
  scheduled: Clock,
  current: Circle,
};
const READINESS_TINT: Record<ReadinessStatus, string> = {
  completed: "bg-status-completed-bg text-status-completed-icon",
  scheduled: "bg-status-scheduled-bg text-status-scheduled-icon",
  current: "bg-surface-emphasis text-text-muted",
};
const READINESS_VERB: Record<ReadinessStatus, string> = {
  completed: "Done",
  scheduled: "In progress",
  current: "To do",
};

function ReadinessCard({ nextPhase }: { nextPhase?: PhaseOverviewRow }) {
  const items = nextPhase?.readiness ?? [];
  const done = items.filter((r) => r.status === "completed").length;
  const pct = items.length > 0 ? Math.round((done / items.length) * 100) : 0;
  const title = nextPhase ? `Phase ${nextPhase.number} readiness` : "Readiness";

  return (
    <Panel title={title} aside={`${done}/${items.length}`}>
      <Progress percent={pct} live className="mb-4" />
      {items.length === 0 ? (
        <p className="text-[13px] text-text-muted">
          No readiness checklist on file for the next parcel yet.
        </p>
      ) : (
        <ul className="divide-y divide-surface-emphasis">
          {items.map((r) => {
            const Icon = READINESS_ICON[r.status];
            return (
              <li key={r.label} className="flex items-center gap-3.5 py-2.5">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${READINESS_TINT[r.status]}`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <span className="flex-1">
                  <span className="block text-[13px] font-medium leading-tight text-text-default">
                    {r.label}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] tracking-wide text-text-muted">
                    {r.area} · {READINESS_VERB[r.status]}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Panel({
  title,
  aside,
  children,
  flush = false,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="rounded-lg border border-surface-border bg-surface-base shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-surface-border px-5 py-4">
        <h2 className="text-sm font-bold text-text-default">{title}</h2>
        {aside && (
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
            {aside}
          </span>
        )}
      </div>
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

function Progress({
  percent,
  live,
  className,
}: {
  percent: number;
  live: boolean;
  className?: string;
}) {
  return (
    <div
      className={`h-[7px] overflow-hidden rounded-full bg-surface-emphasis ${className ?? ""}`}
    >
      <div
        className={`h-full rounded-full ${live ? "bg-primary" : "bg-text-subtle"}`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

function MetaPair({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
        {label}
      </div>
      <div className="mt-0.5 text-[13px] font-medium text-text-default">
        {value}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-lg border border-surface-border bg-surface-muted"
          />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-lg border border-surface-border bg-surface-muted" />
    </div>
  );
}

function EmptyState({ onSeed }: { onSeed: () => void }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-base p-8 text-center shadow-[var(--shadow-card)]">
      <Boxes className="mx-auto h-10 w-10 text-text-subtle" aria-hidden="true" />
      <h2 className="mt-4 font-display text-2xl font-semibold text-text-default">
        No development phases yet
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-text-muted">
        Seed the three canonical build-out parcels (Phase 1 live, Phase 2
        surveying, Phase 3 planned) to populate the runway readout and
        readiness checklist. Admins can adjust the figures afterwards.
      </p>
      <button type="button" onClick={onSeed} className={`${btnPrimary} mx-auto mt-5`}>
        <Upload className="h-4 w-4" aria-hidden="true" /> Seed default phases
      </button>
      <p className="mt-3 font-mono text-[10.5px] uppercase tracking-wide text-text-subtle">
        Admin only · safe to run once
      </p>
    </div>
  );
}

const btnBase =
  "inline-flex min-h-[38px] items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2";
const btnPrimary = `${btnBase} bg-primary text-primary-fg hover:bg-primary-hover`;
const btnOutline = `${btnBase} border border-surface-border bg-surface-base text-text-default hover:border-accent-gold hover:text-primary`;
