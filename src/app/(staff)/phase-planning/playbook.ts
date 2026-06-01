/**
 * "How to map a phase" — the 6-step survey playbook.
 *
 * This is editorial reference content (a method, not per-tenant data),
 * so it lives in source rather than Convex — the same call the codebase
 * makes for the sidebar `nav-items.ts`. The data-driven parts of the
 * Phase Planning screen (parcels, runway, readiness) come from
 * `convex/phasePlanning.ts`.
 */

export interface PhaseMapStep {
  /** Two-digit step number, e.g. "01". */
  n: string;
  title: string;
  /** The tool / system surface used for this step. */
  tool: string;
  owner: string;
  output: string;
  detail: string;
  /** Human-readable lead time, e.g. "1–2 weeks". */
  lead: string;
}

export const PHASE_MAP_STEPS: ReadonlyArray<PhaseMapStep> = [
  {
    n: "01",
    title: "Boundary survey",
    tool: "RTK GPS",
    owner: "A. Aquino · Grounds",
    output: "Corner coordinates (4–8 pts/section)",
    detail:
      "Walk the parcel perimeter and each section boundary with the RTK GPS unit, capturing corner points to ±2 cm. This is the spatial anchor everything else hangs on.",
    lead: "1–2 weeks",
  },
  {
    n: "02",
    title: "Section subdivision",
    tool: "Survey plan",
    owner: "Andres + civil engineer",
    output: "Approved section polygons",
    detail:
      "Divide the parcel into named gardens, set the avenue grid and drainage falls. Sign-off from the civil engineer before any lot lines are drawn.",
    lead: "1 week",
  },
  {
    n: "03",
    title: "Lot grid generation",
    tool: "Admin · Sections",
    owner: "Office staff",
    output: "Lot records (draft)",
    detail:
      "Enter section dimensions and lot type per block; the system auto-generates the lot grid and codes. Family/single/mausoleum footprints come from the pricing table.",
    lead: "2–3 days",
  },
  {
    n: "04",
    title: "GPS import & validation",
    tool: "Admin · GPS Import",
    owner: "Office staff",
    output: "Geo-located lots",
    detail:
      "Upload the surveyed coordinates as CSV. The importer snaps each lot to its polygon and flags any that fall outside their section bounds for manual review.",
    lead: "2–3 days",
  },
  {
    n: "05",
    title: "3D survey review",
    tool: "Phase 3D Map",
    owner: "Teresita + Andres",
    output: "QA sign-off",
    detail:
      "Open the parcel in the 3D survey view and walk it virtually. Catch mis-placed lots, wrong types, or drainage clashes before anything is priced or sold.",
    lead: "2 days",
  },
  {
    n: "06",
    title: "Pricing & publish",
    tool: "Admin · Pricing",
    owner: "Teresita · Admin",
    output: "Lots available for sale",
    detail:
      "Set base prices and installment terms per lot type, allocate the perpetual-care reserve, then flip the parcel live. Lots appear on the map and in find-a-lot instantly.",
    lead: "1 week",
  },
];
