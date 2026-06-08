/**
 * Phase planning domain — development-parcel runway + survey pipeline.
 *
 * Backs the `/phase-planning` staff screen. A "phase" is a development
 * parcel (ADR-0008) containing several sections/gardens; the screen
 * answers two operator questions:
 *
 *   1. "When do we run out of inventory?" — the runway readout, computed
 *      from each phase's `availableLotCount / monthlyAbsorption`.
 *   2. "Are we prepared for the next phase?" — the embedded `readiness`
 *      checklist on the not-yet-live parcel.
 *
 * Conventions (mirrors `convex/sections.ts`):
 *   1. FIRST awaited statement is `await requireRole(ctx, [...])` — the
 *      `local-rules/require-role-first-line` rule enforces this.
 *   2. Reads are admin / office_staff (planning is a back-office surface;
 *      field workers do not see it — it is absent from their nav).
 *   3. `seedDefaultPhases` is an idempotent bootstrap so the screen has
 *      content on a fresh deployment. It writes reference planning rows,
 *      not financial or PII state, so it deliberately does NOT emit an
 *      audit event (the audit trail is reserved for lot / contract /
 *      payment / section lifecycle — see `convex/lib/audit.ts`).
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type PhaseDoc = DataModel["phases"]["document"];
type PhaseId = PhaseDoc["_id"];

type PhaseStage = "live" | "surveying" | "planned";
type ReadinessStatus = "completed" | "scheduled" | "current";

interface ReadinessItem {
  label: string;
  area: string;
  status: ReadinessStatus;
}

/**
 * One phase, plus the derived fields the screen renders. Kept here (not
 * recomputed in the client) so the runway maths has a single home.
 */
export interface PhaseOverviewRow {
  _id: PhaseId;
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
  /** plannedLotCount − availableLotCount, floored at 0. */
  soldCount: number;
  /** Sell-through as a 0–100 integer percent (0 when plannedLotCount is 0). */
  sellThroughPercent: number;
  /** availableLotCount ÷ monthlyAbsorption, or null when absorption is 0. */
  runwayMonths: number | null;
  /**
   * "live" when the lot counts were computed from real inventory in this
   * phase's sections; "seeded" when they fell back to the stored figures
   * (no `sectionNames`, or no matching lots loaded yet). Lets the UI flag
   * illustrative vs. live numbers.
   */
  dataSource: "live" | "seeded";
}

export interface PhasePlanningOverview {
  phases: PhaseOverviewRow[];
  /** First non-live phase, surfaced so the screen can render the
   *  "next phase readiness" card without re-deriving it. Null when every
   *  phase is live (nothing left to prepare). */
  nextPhaseNumber: number | null;
  generatedAtMs: number;
}

/** Minimal lot shape this query reads for the live roll-up. */
interface LotForPhase {
  section: string;
  status: string;
  isRetired: boolean;
}

function deriveRow(row: PhaseDoc, lots: LotForPhase[]): PhaseOverviewRow {
  // Prefer live inventory when this phase declares its sections AND those
  // sections actually contain lots; otherwise fall back to the stored
  // (seeded) figures so a fresh deployment still shows a populated screen.
  let plannedLotCount = row.plannedLotCount;
  let availableLotCount = row.availableLotCount;
  let dataSource: "live" | "seeded" = "seeded";
  const names = row.sectionNames;
  if (names !== undefined && names.length > 0) {
    const sectionSet = new Set(names);
    const matched = lots.filter(
      (l) => !l.isRetired && sectionSet.has(l.section),
    );
    if (matched.length > 0) {
      plannedLotCount = matched.length;
      availableLotCount = matched.filter((l) => l.status === "available").length;
      dataSource = "live";
    }
  }

  const soldCount = Math.max(0, plannedLotCount - availableLotCount);
  const sellThroughPercent =
    plannedLotCount > 0
      ? Math.round((soldCount / plannedLotCount) * 100)
      : 0;
  const runwayMonths =
    row.monthlyAbsorption > 0
      ? Math.round((availableLotCount / row.monthlyAbsorption) * 10) / 10
      : null;

  const out: PhaseOverviewRow = {
    _id: row._id,
    number: row.number,
    name: row.name,
    sectionsLabel: row.sectionsLabel,
    stage: row.stage,
    plannedLotCount,
    availableLotCount,
    monthlyAbsorption: row.monthlyAbsorption,
    surveyLeadWeeks: row.surveyLeadWeeks,
    readiness: row.readiness,
    soldCount,
    sellThroughPercent,
    runwayMonths,
    dataSource,
  };
  if (row.projectedSelloutLabel !== undefined) {
    out.projectedSelloutLabel = row.projectedSelloutLabel;
  }
  if (row.readyByLabel !== undefined) {
    out.readyByLabel = row.readyByLabel;
  }
  return out;
}

/**
 * Read the full planning overview — every non-retired phase ordered by
 * number, with derived runway / sell-through. Reactive: as ops adjusts
 * `availableLotCount` or `monthlyAbsorption` the screen re-renders.
 */
export const getPhasePlanningOverview = queryGeneric({
  args: {},
  handler: async (ctx: QueryCtx): Promise<PhasePlanningOverview> => {
    await requireRole(ctx, ["admin", "office_staff"]);

    const rows = await ctx.db
      .query("phases")
      .withIndex("by_number")
      .collect();
    const active = rows.filter((r) => !r.isRetired);
    active.sort((a, b) => a.number - b.number);

    // One scan of the lots table feeds every phase's live roll-up. Phase 1
    // scale (~2k lots) keeps this comfortably within the query budget.
    const lots = await ctx.db.query("lots").collect();
    const lotsForPhase: LotForPhase[] = lots.map((l) => ({
      section: l.section,
      status: l.status,
      isRetired: l.isRetired,
    }));

    const phases = active.map((row) => deriveRow(row, lotsForPhase));
    const nextPhase = phases.find((p) => p.stage !== "live");

    return {
      phases,
      nextPhaseNumber: nextPhase ? nextPhase.number : null,
      generatedAtMs: Date.now(),
    };
  },
});

/**
 * The three build-out parcels seeded on first run. Mirrors the canonical
 * planning model: Phase 1 live, Phase 2 surveying (carries the readiness
 * checklist — it is the parcel being prepared), Phase 3 planned.
 */
const DEFAULT_PHASES: ReadonlyArray<{
  number: number;
  name: string;
  sectionsLabel: string;
  sectionNames: string[];
  stage: PhaseStage;
  plannedLotCount: number;
  availableLotCount: number;
  monthlyAbsorption: number;
  surveyLeadWeeks: number;
  projectedSelloutLabel?: string;
  readyByLabel?: string;
  readiness: ReadinessItem[];
}> = [
  {
    number: 1,
    name: "Northwest Parcel",
    sectionsLabel: "Grace · Faith · Hope",
    sectionNames: ["Garden of Grace", "Garden of Faith", "Garden of Hope"],
    stage: "live",
    plannedLotCount: 1016,
    availableLotCount: 51,
    monthlyAbsorption: 14,
    surveyLeadWeeks: 10,
    projectedSelloutLabel: "Apr 2025",
    readyByLabel: "Feb 2025",
    readiness: [],
  },
  {
    number: 2,
    name: "East Parcel",
    sectionsLabel: "Peace · Columbarium East",
    sectionNames: ["Garden of Peace", "Columbarium East"],
    stage: "surveying",
    plannedLotCount: 904,
    availableLotCount: 904,
    monthlyAbsorption: 0,
    surveyLeadWeeks: 10,
    readiness: [
      { label: "Boundary GPS survey complete", area: "Step 01", status: "completed" },
      { label: "Section subdivision approved (civil engineer)", area: "Step 02", status: "completed" },
      { label: "DENR / LGU development permits", area: "Compliance", status: "completed" },
      { label: "Lot grid generated & coded", area: "Step 03", status: "scheduled" },
      { label: "Civil works — drainage & access paths", area: "Grounds", status: "scheduled" },
      { label: "GPS coordinates imported & validated", area: "Step 04", status: "current" },
      { label: "3D survey QA sign-off", area: "Step 05", status: "current" },
      { label: "Pricing & installment terms set", area: "Step 06", status: "current" },
      { label: "Perpetual-care fund allocation", area: "Finance", status: "current" },
    ],
  },
  {
    number: 3,
    name: "South Parcel",
    sectionsLabel: "Mausoleum II · New Garden",
    // Future sections — no lots exist yet, so this always uses the
    // seeded figures until the parcel is surveyed and lots are created.
    sectionNames: [],
    stage: "planned",
    plannedLotCount: 640,
    availableLotCount: 640,
    monthlyAbsorption: 0,
    surveyLeadWeeks: 10,
    readiness: [],
  },
];

/**
 * Idempotent bootstrap. Inserts the three default parcels only when the
 * `phases` table is empty, so a fresh deployment shows a populated
 * planning screen and re-running is a safe no-op. Admin-only.
 */
export const seedDefaultPhases = mutationGeneric({
  args: {},
  handler: async (
    ctx: MutationCtx,
  ): Promise<{ seeded: boolean; count: number }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.query("phases").first();
    if (existing !== null) {
      return { seeded: false, count: 0 };
    }

    const now = Date.now();
    for (const phase of DEFAULT_PHASES) {
      const row: {
        number: number;
        name: string;
        sectionsLabel: string;
        sectionNames: string[];
        stage: PhaseStage;
        plannedLotCount: number;
        availableLotCount: number;
        monthlyAbsorption: number;
        surveyLeadWeeks: number;
        projectedSelloutLabel?: string;
        readyByLabel?: string;
        readiness: ReadinessItem[];
        isRetired: boolean;
        createdAt: number;
        createdBy: typeof auth.userId;
      } = {
        number: phase.number,
        name: phase.name,
        sectionsLabel: phase.sectionsLabel,
        sectionNames: phase.sectionNames,
        stage: phase.stage,
        plannedLotCount: phase.plannedLotCount,
        availableLotCount: phase.availableLotCount,
        monthlyAbsorption: phase.monthlyAbsorption,
        surveyLeadWeeks: phase.surveyLeadWeeks,
        readiness: phase.readiness,
        isRetired: false,
        createdAt: now,
        createdBy: auth.userId,
      };
      if (phase.projectedSelloutLabel !== undefined) {
        row.projectedSelloutLabel = phase.projectedSelloutLabel;
      }
      if (phase.readyByLabel !== undefined) {
        row.readyByLabel = phase.readyByLabel;
      }
      await ctx.db.insert("phases", row);
    }

    return { seeded: true, count: DEFAULT_PHASES.length };
  },
});
