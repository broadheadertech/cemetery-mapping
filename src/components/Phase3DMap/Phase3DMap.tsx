"use client";

/**
 * Phase3DMap — a rotatable 3D survey of a development parcel (Phase 1,
 * the Northwest Parcel: Gardens of Grace, Faith & Hope).
 *
 * This is the "3D survey review" step of the phase-mapping playbook
 * (Step 05 in `/phase-planning`) and the Phase-2 map renderer ADR-0008
 * slates. The heavy Three.js scene is built imperatively inside a single
 * mount effect (WebGL has no React reconciler); the surrounding chrome —
 * filter chips, view controls, legend, the selected-lot rail and the
 * per-section roll-up — is ordinary React driven by `useState`. The
 * effect bridges the two via callbacks (`onSelect`, `onRollup`) and an
 * imperative handle (`apiRef`) the chrome calls into.
 *
 * Loaded with `ssr: false` from the route — Three.js + WebGL are
 * browser-only.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { layoutLabels } from "@/lib/labelLayout";
import {
  placementBand,
  PLACEMENT_BANDS,
  uncertaintyRadiusM,
  type ColourMode,
} from "@/lib/placementPalette";
import {
  baseSize,
  hiddenMatrix,
  instanceMatrix,
  PARTS,
  planInstances,
  type Part,
} from "@/lib/lotInstancing";
import {
  bearingOf,
  decideMode,
  footprintOf,
  mayDrawIllustrativeScenery,
  projectToScene,
  type MapMode,
} from "@/lib/mapSurvey";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type LotStatus =
  | "available"
  | "reserved"
  | "sold"
  | "occupied"
  | "defaulted";

interface LotUserData {
  id: string;
  code: string;
  status: LotStatus;
  type: "single" | "family" | "mausoleum";
  section: string;
  sectionCode: string;
  price: number;
  occupant: string | null;
  block: string;
  /** Real Convex lot id when this lot came from live inventory; null in
   *  the procedural demo. Drives the rail's deep-links. */
  realLotId: string | null;
}

/** Lot row read from `lots:listForMap` — the scene's whole diet. */
interface RealLotRow {
  _id: string;
  code: string;
  section: string;
  block: string;
  type: string;
  basePriceCents: number;
  status: string;
  areaSqm: number;
  hasPhoto: boolean;
}

/**
 * The map's own read.
 *
 * `lots:listLots` returned whole lot documents — every field, including
 * the `geometry` polygon and its bounding box, for every lot in the
 * park — to draw a few hundred coloured boxes that are positioned on a
 * grid. `listForMap` returns eight scalars per lot and the garden
 * layouts, and does the area arithmetic server-side.
 */
const listForMapRef = makeFunctionReference<
  "query",
  { sectionNames?: string[] },
  MapData
>("lots:listForMap");

/**
 * The measured park.
 *
 * A grid cannot draw an irregular garden honestly — curved edges,
 * angled rows, blocks that do not line up. Every arrangement of squares
 * still puts them in straight lines, and a garden drawn in the wrong
 * shape looks exactly as confident as one drawn right.
 *
 * So when lots have been surveyed, the scene is built from where they
 * actually are. A separate read from `listForMap` on purpose: that
 * query ships no geometry, and a park still working off a grid should
 * not pay for polygons it will not draw.
 */
const listSurveyedRef = makeFunctionReference<
  "query",
  { sectionNames?: string[] },
  SurveyedMapData
>("lots:listSurveyedForMap");

interface SurveyedLotRow {
  _id: string;
  code: string;
  section: string;
  block: string;
  status: string;
  type: string;
  basePriceCents: number;
  areaSqm: number;
  hasPhoto: boolean;
  lat: number;
  lng: number;
  polygon: Array<{ lat: number; lng: number }>;
  source: string | null;
  accuracyM: number | null;
}

interface SurveyedSectionRow {
  name: string;
  displayName: string;
  sortOrder: number;
  placedCount: number;
  unplacedCount: number;
  unplacedSample: string[];
}

interface SurveyedMapData {
  lots: SurveyedLotRow[];
  sections: SurveyedSectionRow[];
  origin: { lat: number; lng: number } | null;
}

/** One lot's detail, read only when somebody clicks it. */
const lotDetailRef = makeFunctionReference<
  "query",
  { lotId: string },
  MapLotDetail | null
>("lots:getMapLotDetail");

interface MapSectionRow {
  name: string;
  displayName: string;
  sortOrder: number;
  columns: number;
  rows: number;
  tintHex: number | null;
  lotCount: number;
  layoutIsDerived: boolean;
}

interface MapData {
  sections: MapSectionRow[];
  lots: RealLotRow[];
}

export interface MapLotDetail {
  _id: string;
  code: string;
  section: string;
  block: string;
  row: string;
  status: string;
  type: string;
  basePriceCents: number;
  areaSqm: number;
  widthM: number;
  depthM: number;
  lat: number | null;
  lng: number | null;
  geometryStatus: string;
  photoUrl: string | null;
  photoUpdatedAt: number | null;
  occupants: MapLotOccupantRow[];
  geometrySource: string | null;
  geometryAccuracyM: number | null;
  geometryCapturedAt: number | null;
}

interface MapLotOccupantRow {
  _id: string;
  name: string;
  dateOfInterment: number | null;
  dateOfDeath: number | null;
  intermentKind: string | null;
}

/** Map the 7-state lot lifecycle onto the 5 the 3D scene renders. */
function to3DStatus(s: string): LotStatus {
  if (
    s === "available" ||
    s === "reserved" ||
    s === "sold" ||
    s === "occupied" ||
    s === "defaulted"
  ) {
    return s;
  }
  return "sold"; // cancelled / transferred → neutral stone marker
}

/** Niche lots render with the single-plot footprint. */
function to3DType(t: RealLotRow["type"]): LotUserData["type"] {
  return t === "family" || t === "mausoleum" ? t : "single";
}

interface SectionRollup {
  name: string;
  percent: number;
  count: number;
}

interface Rollup {
  total: number;
  available: number;
  occupiedPercent: number;
  sections: SectionRollup[];
}

interface MapApi {
  applyFilter: (filter: string) => void;
  resetView: () => void;
  setAutoRotate: (on: boolean) => void;
  focusSection: (index: number) => void;
  setColourMode: (mode: ColourMode) => void;
  /** Select and fly to a lot by code. Returns false when there is none. */
  focusLotByCode: (code: string) => boolean;
}

const STATUS: Record<LotStatus, { color: number; stone: boolean }> = {
  available: { color: 0x9bbf8f, stone: false },
  reserved: { color: 0xd9a441, stone: true },
  sold: { color: 0x94a3b8, stone: true },
  occupied: { color: 0x2f4f43, stone: true },
  defaulted: { color: 0xcf5b5b, stone: true },
};

const LEGEND: ReadonlyArray<{ label: string; color: string }> = [
  { label: "Available", color: "#9bbf8f" },
  { label: "Reserved", color: "#d9a441" },
  { label: "Sold", color: "#94a3b8" },
  { label: "Occupied", color: "#2f4f43" },
  { label: "Defaulted", color: "#cf5b5b" },
];

const FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "all", label: "All" },
  { value: "available", label: "Available" },
  { value: "reserved", label: "Reserved" },
  { value: "sold", label: "Sold" },
  { value: "occupied", label: "Occupied" },
  { value: "defaulted", label: "Defaulted" },
];

const OCC = [
  "Maria S. Reyes",
  "Ernesto Cruz",
  "Lucia Mendoza",
  "Roberto Lim",
  "Adela Santos",
  "Jose Magbanua",
  "Teresa Ramos",
  "Pedro Bautista",
  "Carmen Diaz",
  "Anita Flores",
];

const peso = (n: number) => "₱" + n.toLocaleString("en-PH");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The standing instruction under the scene.
 *
 * A constant now. It used to be state so the phase switcher could
 * briefly replace it with an invented sentence about a survey
 * schedule; with the switcher gone nothing else ever wrote to it.
 */
/** How far a selected grave rises, in metres. */
const SELECTED_LIFT = 0.5;

const HINT = "Drag to orbit · scroll to zoom · click a lot to inspect";

/**
 * What a position is worth, in words.
 *
 * `surveyed` was doing the work of four very different claims. A
 * measured outline and a phone fix beside a wall are both "surveyed"
 * and neither the map nor this panel could tell them apart.
 */
function describeSource(
  source: string | null,
  accuracyM: number | null,
): string {
  switch (source) {
    case "imported":
      return "From a survey file — measured outline and angle.";
    case "gps":
      return accuracyM === null
        ? "Captured on a phone at the lot."
        : `Captured on a phone at the lot, accurate to about ${Math.round(accuracyM)}m — roughly ${Math.max(1, Math.round(accuracyM / 2.5))} grave${Math.round(accuracyM / 2.5) === 1 ? "" : "s"} either way.`;
    case "drawn":
      return "Laid out along a row drawn on the map. The angle is real; nobody stood at this plot.";
    case "clicked":
      return "Placed by pointing at a map. The centre is real; the shape is assumed from the recorded size.";
    default:
      // Older records predate the field. Claiming a source they never
      // recorded would be worse than admitting it is unknown.
      return "Position recorded before its source was tracked.";
  }
}

/** Just the year, in Manila time — the park's own clock. */
function year(ms: number): string {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
  }).format(new Date(ms));
}

/**
 * The dates under a name, saying which is which.
 *
 * Death and interment are different facts and the records hold them
 * separately, so "1947 — 2024" would be a guess dressed as a lifespan
 * whenever only one of them is known. When only the burial date exists
 * it says so rather than pretending the pair.
 */
function lifespan(o: {
  dateOfDeath: number | null;
  dateOfInterment: number | null;
}): string {
  if (o.dateOfDeath !== null && o.dateOfInterment !== null) {
    return `d. ${year(o.dateOfDeath)} · interred ${year(o.dateOfInterment)}`;
  }
  if (o.dateOfDeath !== null) return `d. ${year(o.dateOfDeath)}`;
  if (o.dateOfInterment !== null) return `Interred ${year(o.dateOfInterment)}`;
  return "Dates not recorded";
}

const PILL_TINT: Record<LotStatus, string> = {
  available: "bg-status-available-bg text-status-available-text",
  reserved: "bg-status-reserved-bg text-status-reserved-text",
  sold: "bg-status-sold-bg text-status-sold-text",
  occupied: "bg-status-occupied-bg text-status-occupied-text",
  defaulted: "bg-status-defaulted-bg text-status-defaulted-text",
};

/**
 * A garden to lay out in the parcel. The scene derives each one's world
 * size from `cols` × `rows`; `w`, `d` and `cx` are computed during the
 * build.
 */
export interface ParcelSection {
  /** Single letter; prefixes the demo lot codes. */
  id: string;
  /** Short code used for per-section roll-ups. */
  code: string;
  name: string;
  cols: number;
  rows: number;
  /** Turf tint for the section pad. */
  tint: number;
  mausoleum?: boolean;
}

/**
 * Turf greens, cycled for gardens with no colour of their own.
 *
 * Close together on purpose: a cemetery map wants to read as one park
 * seen from above, not as a chart.
 */
const DEFAULT_TINTS: ReadonlyArray<number> = [
  0x8fab7f, 0x86a276, 0x93ad84, 0x8aa77c, 0x97b189,
];

/** Phase 1's Northwest Parcel — the staff survey's default subject. */
const DEFAULT_SECTIONS: ReadonlyArray<ParcelSection> = [
  { id: "A", code: "GRACE", name: "Garden of Grace", cols: 5, rows: 5, tint: 0x8fab7f },
  { id: "B", code: "FAITH", name: "Garden of Faith", cols: 6, rows: 5, tint: 0x86a276, mausoleum: true },
  { id: "C", code: "HOPE", name: "Garden of Hope", cols: 5, rows: 5, tint: 0x93ad84 },
];

export interface Phase3DMapProps {
  /**
   * `staff` (default) is the survey tool: it reads live inventory and
   * links into the sale and lot records.
   *
   * `public` is the same scene and the same controls on the marketing
   * site. It reads no inventory — there is no session on a public page,
   * and `lots:listLots` is role-gated — so it draws the illustrative
   * parcel, and it offers an enquiry instead of staff actions.
   */
  variant?: "staff" | "public";
  /** Gardens to lay out. Defaults to Phase 1's three. */
  sections?: ReadonlyArray<ParcelSection>;
  /** Heading for the roll-up beneath the lot detail. */
  parcelLabel?: string;
}

export default function Phase3DMap({
  variant = "staff",
  sections: sectionsProp,
  parcelLabel = "Phase 1 · Northwest Parcel",
}: Phase3DMapProps = {}) {
  const isPublic = variant === "public";
  const stageRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<MapApi | null>(null);

  const [selected, setSelected] = useState<LotUserData | null>(null);
  // Only a lot that came from live inventory has a record to read; the
  // illustrative parcel's lots are procedural and have none.
  const selectedRealId = selected?.realLotId ?? null;
  const [rollup, setRollup] = useState<Rollup | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [autoRotate, setAutoRotate] = useState(false);
  /**
   * What the lot colours are answering.
   *
   * Status by default — it is what somebody at a desk needs. Placement
   * is the auditing view: which parts of the park stand on a measured
   * survey and which on a guess, a question nothing else in the app can
   * answer at a glance.
   */
  const [colourMode, setColourMode] = useState<ColourMode>("status");
  const [search, setSearch] = useState("");
  /**
   * True only after a search that found nothing.
   *
   * Distinct from an empty box: silence on a miss reads as the search
   * being broken, and somebody retypes the same code twice before
   * concluding the lot is not there.
   */
  const [searchMiss, setSearchMiss] = useState(false);
  const [ready, setReady] = useState(false);
  const [isDemo, setIsDemo] = useState(false);

  // Live inventory for Phase 1's gardens. While the query is loading we
  // hold the scene back; once it resolves we build from real lots, or
  // fall back to the procedural demo when no Phase 1 lots exist yet.
  // `"skip"` keeps the hook call unconditional while leaving the
  // subscription dormant — the public site has no session, and this
  // query is role-gated, so running it would only ever throw.
  const mapQuery = useQuery(listForMapRef, isPublic ? "skip" : {});
  const realLots = useMemo<RealLotRow[] | null>(() => {
    // Empty, not null: null means "still loading" and holds the scene
    // back. The public view has nothing to wait for.
    if (isPublic) return [];
    if (mapQuery === undefined) return null;
    return mapQuery.lots;
  }, [isPublic, mapQuery]);

  /**
   * The gardens to draw, and how.
   *
   * Taken from the sections registry rather than the hardcoded three,
   * so adding a garden is a record somebody creates rather than a
   * deployment. The `DEFAULT_SECTIONS` constant survives only as the
   * illustrative parcel for the public site, which has no session and
   * therefore no inventory to read.
   */
  const liveSections = useMemo<ReadonlyArray<ParcelSection> | null>(() => {
    if (isPublic) return null;
    if (mapQuery === undefined) return null;
    if (mapQuery.sections.length === 0) return null;
    return mapQuery.sections.map((sec, i) => ({
      id: String.fromCharCode(65 + (i % 26)),
      code: sec.name.replace(/[^A-Za-z]/g, "").slice(-5).toUpperCase(),
      name: sec.name,
      cols: sec.columns,
      rows: sec.rows,
      tint: sec.tintHex ?? DEFAULT_TINTS[i % DEFAULT_TINTS.length]!,
    }));
  }, [isPublic, mapQuery]);

  /**
   * The selected lot's detail, read only when something is selected.
   *
   * Deliberately a second query. A photograph URL and a coordinate pair
   * per lot, fetched for the whole park to draw boxes, would undo the
   * point of the light list above.
   */
  const detail = useQuery(
    lotDetailRef,
    selectedRealId === null ? "skip" : { lotId: selectedRealId },
  );

  /** True when at least one garden is being drawn on a guessed grid. */
  const anyDerivedLayout = useMemo(
    () =>
      mapQuery !== undefined &&
      mapQuery.sections.some((sec) => sec.layoutIsDerived),
    [mapQuery],
  );
  /**
   * The measured park, and which view it can honestly support.
   *
   * The rule is deliberately blunt: if anything at all has been
   * surveyed, that is the truth and the map opens on it. An arrangement
   * is a stand-in, and a stand-in should not beat a measurement on
   * volume. A park mid-rollout keeps the arrangement available, and the
   * gardens the survey cannot draw are named rather than quietly
   * absent.
   */
  const surveyQuery = useQuery(listSurveyedRef, isPublic ? "skip" : {});
  const [preferredMode, setPreferredMode] = useState<MapMode | undefined>(
    undefined,
  );
  const modeDecision = useMemo(
    () =>
      surveyQuery === undefined
        ? null
        : decideMode(surveyQuery.sections, preferredMode),
    [surveyQuery, preferredMode],
  );
  const surveyMode = modeDecision?.mode === "survey";

  /**
   * Every surveyed lot, already projected into scene metres.
   *
   * Done here rather than in the scene effect so the arithmetic is
   * plain React state that can be reasoned about, and so the effect
   * keeps to building meshes.
   */
  const placements = useMemo(() => {
    if (surveyQuery === undefined || surveyQuery.origin === null) return null;
    const origin = surveyQuery.origin;
    return surveyQuery.lots.map((l) => {
      const at = projectToScene({ lat: l.lat, lng: l.lng }, origin);
      const foot = footprintOf(l.polygon, origin);
      return {
        lot: l,
        x: at.x,
        z: at.z,
        // A surveyed lot is rarely square to north. Drawing it as
        // though it were is the visible half of "this is not a survey".
        rotY: foot === null ? 0 : -bearingOf(foot),
        measuredShape: foot !== null,
        source: l.source,
        accuracyM: l.accuracyM,
      };
    });
  }, [surveyQuery]);

  // Rebuild the scene only when the meaningful lot set changes (ids +
  // statuses), not on every query echo.
  const sceneSignature = useMemo(() => {
    if (realLots === null) return "loading";
    if (realLots.length === 0) return "demo";
    return realLots
      .map((l) => `${l._id}:${l.status}`)
      .sort()
      .join("|");
  }, [realLots]);
  const realDataRef = useRef<RealLotRow[] | null>(realLots);
  realDataRef.current = realLots;
  type Placement = NonNullable<typeof placements>[number];
  const placementsRef = useRef<Placement[] | null>(placements);
  placementsRef.current = placements;
  const surveyModeRef = useRef<boolean>(surveyMode);
  surveyModeRef.current = surveyMode;
  /**
   * What the scene actually draws.
   *
   * An explicit `sections` prop wins — that is how the public site asks
   * for the illustrative parcel. Otherwise the live registry, and only
   * if there is nothing there at all does it fall back to the
   * hardcoded three.
   */
  const parcelSections: ReadonlyArray<ParcelSection> =
    sectionsProp ?? liveSections ?? DEFAULT_SECTIONS;

  const sectionsRef = useRef<ReadonlyArray<ParcelSection>>(parcelSections);
  sectionsRef.current = parcelSections;
  // A different parcel is a different scene, so fold it into the
  // rebuild key alongside the lot set.
  const sectionSignature = parcelSections
    .map((x) => `${x.id}:${x.cols}x${x.rows}`)
    .join("|");

  // A survey is a different scene from an arrangement, and moving one
  // lot moves one box — so the placement set is part of the rebuild key.
  const surveySignature = useMemo(
    () =>
      surveyMode && placements !== null
        ? `survey:${placements
            .map((p) => `${p.lot._id}:${p.x.toFixed(2)}:${p.z.toFixed(2)}`)
            .join("|")}`
        : "arrangement",
    [surveyMode, placements],
  );

  // ---- Build the scene when live data resolves (rebuild on change). ----
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    // Hold for the lots query to resolve so we don't build the demo and
    // immediately rebuild from real data (a visible flash).
    if (sceneSignature === "loading") return;
    const realLotRows = realDataRef.current;
    const realMode = realLotRows !== null && realLotRows.length > 0;
    setIsDemo(!realMode);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf6f2ea);
    scene.fog = new THREE.Fog(0xf6f2ea, 110, 240);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
    // Provisional framing; replaced once the parcel's real width is
    // known, below. A three-garden parcel and a six-garden one need
    // very different distances, and the staff view's fixed 40/56 put
    // half of a six-garden park outside the frame.
    const CAM0 = new THREE.Vector3(0, 40, 56);
    camera.position.copy(CAM0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    stage.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 18;
    controls.maxDistance = 110;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.target.set(0, 1, 0);
    controls.autoRotateSpeed = 0.6;

    scene.add(new THREE.HemisphereLight(0xfbf6ea, 0x6f8f6a, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2da, 1.05);
    sun.position.set(34, 46, 24);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -66;
    sun.shadow.camera.right = 66;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 160;
    sun.shadow.bias = -0.0004;
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(240, 240),
      new THREE.MeshStandardMaterial({ color: 0x7e9a70, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(200, 100, 0xc9a96b, 0xc9a96b);
    const gridMat = grid.material as THREE.Material;
    gridMat.opacity = 0.06;
    gridMat.transparent = true;
    grid.position.y = 0.02;
    scene.add(grid);

    /*
     * The per-colour material cache that used to live here is gone.
     *
     * It existed so two thousand lots could share five materials. With
     * instancing they share ONE material per part and carry their
     * colour on the instance, so the cache had nothing left to cache.
     */
    const pathMat = new THREE.MeshStandardMaterial({
      color: 0xd2c9b2,
      roughness: 1,
    });
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0xc9a96b,
      roughness: 0.6,
      metalness: 0.1,
    });

    const rand = (i: number) => {
      const x = Math.sin(i * 43.17 + 7.3) * 10000;
      return x - Math.floor(x);
    };
    const pickStatus = (i: number): LotStatus => {
      const r = rand(i);
      if (r < 0.06) return "available";
      if (r < 0.12) return "reserved";
      if (r < 0.21) return "sold";
      if (r < 0.28) return "defaulted";
      return "occupied";
    };

    interface SectionDef {
      id: string;
      code: string;
      name: string;
      cols: number;
      rows: number;
      tint: number;
      mausoleum?: boolean;
      w: number;
      d: number;
      cx: number;
      /** Depth-wise centre. Always 0 on an arrangement; real on a survey. */
      cz: number;
    }
    const SECTIONS: SectionDef[] = sectionsRef.current.map((s) => ({
      ...s,
      w: 0,
      d: 0,
      cx: 0,
      cz: 0,
    }));
    const cellW = 3.0;
    const cellD = 3.6;
    const avenue = 6;

    /*
     * Where each garden sits.
     *
     * On an arrangement, nowhere in particular: the gardens are laid
     * out side by side with an avenue between them, because a grid has
     * no real position to draw from.
     *
     * On a survey they have one. Each garden's pad is the bounding box
     * of its own measured lots, so gardens sit at their true distance
     * and bearing from each other — which is the entire reason for
     * surveying an irregular park in the first place.
     */
    const surveying = surveyModeRef.current;
    /**
     * Whether the invented furniture may be drawn at all.
     *
     * Avenues, the promenade, the trees and the chapel are all placed
     * by arithmetic off the parcel's extent. On a survey that extent is
     * measured ground, so they would sit at true scale beside graves
     * that really are where they appear — and nothing on screen would
     * tell a reader which is which.
     */
    const illustrative = mayDrawIllustrativeScenery(
      surveying ? "survey" : "arrangement",
    );
    const placed = placementsRef.current ?? [];
    let totalW = 0;

    if (surveying) {
      SECTIONS.forEach((s) => {
        const mine = placed.filter((p) => p.lot.section === s.name);
        if (mine.length === 0) {
          s.w = 0;
          s.d = 0;
          s.cx = 0;
          return;
        }
        const xs = mine.map((p) => p.x);
        const zs = mine.map((p) => p.z);
        // Padded by a lot's own size so the pad does not slice through
        // the plots on its edges.
        const pad = 3;
        s.w = Math.max(...xs) - Math.min(...xs) + pad * 2;
        s.d = Math.max(...zs) - Math.min(...zs) + pad * 2;
        s.cx = (Math.max(...xs) + Math.min(...xs)) / 2;
        s.cz = (Math.max(...zs) + Math.min(...zs)) / 2;
      });
      const allX = placed.map((p) => p.x);
      const allZ = placed.map((p) => p.z);
      totalW =
        placed.length === 0
          ? 40
          : Math.max(
              Math.max(...allX) - Math.min(...allX),
              Math.max(...allZ) - Math.min(...allZ),
            ) + 12;
    } else {
      SECTIONS.forEach((s) => {
        s.w = s.cols * cellW;
        s.d = s.rows * cellD;
        s.cz = 0;
      });
      totalW =
        SECTIONS.reduce((a, s) => a + s.w, 0) + avenue * (SECTIONS.length - 1);
      let cursorX = -totalW / 2;
      SECTIONS.forEach((s) => {
        s.cx = cursorX + s.w / 2;
        cursorX += s.w + avenue;
      });
    }

    // Frame the whole parcel, whatever its width. Derived rather
    // than fixed so adding gardens does not crop the view.
    {
      const span = Math.max(totalW, 40);
      const dist = span * 0.92;
      CAM0.set(0, dist * 0.62, dist * 0.86);
      camera.position.copy(CAM0);
      controls.maxDistance = Math.max(110, dist * 1.9);
      camera.far = Math.max(600, dist * 6);
      camera.updateProjectionMatrix();
      scene.fog = new THREE.Fog(0xf6f2ea, dist * 1.5, dist * 3.6);
    }

    /**
     * One entry per lot, collected across every garden, drawn once.
     *
     * Replaces `THREE.Group[]`: a lot is no longer an object in the
     * scene, it is a row here plus a set of indices into the shared
     * instance buffers.
     */
    interface LotDraw {
      userData: LotUserData;
      type: string;
      stone: boolean;
      x: number;
      z: number;
      rotY: number;
      wallH: number;
      insetColor: number;
      statusColor: number;
      source: string | null;
      accuracyM: number | null;
      baseW: number;
      baseD: number;
    }
    const draws: LotDraw[] = [];
    const labelEls: { el: HTMLDivElement; sec: SectionDef }[] = [];
    let gid = 0;

    SECTIONS.forEach((sec) => {
      // On a survey, a garden with nothing placed has no position to
      // draw a pad at. It is reported in the banner instead of being
      // invented somewhere.
      if (surveying && sec.w === 0) return;

      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(sec.w + 2.4, 0.06, sec.d + 2.4),
        new THREE.MeshStandardMaterial({ color: sec.tint, roughness: 1 }),
      );
      pad.position.set(sec.cx, 0.04, sec.cz);
      pad.receiveShadow = true;
      scene.add(pad);

      const bx = sec.w / 2 + 1.4;
      const bz = sec.d / 2 + 1.4;
      (
        [
          [0, -bz, 2 * bx, 0.4],
          [0, bz, 2 * bx, 0.4],
          [-bx, 0, 0.4, 2 * bz + 0.4],
          [bx, 0, 0.4, 2 * bz + 0.4],
        ] as Array<[number, number, number, number]>
      ).forEach(([x, z, w, d]) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.4, d), curbMat);
        m.position.set(sec.cx + x, 0.2, sec.cz + z);
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
      });

      // Real lots that belong to this garden (live mode). Laid into the
      // grid in code order; cells beyond the real count stay empty.
      const secReal = realMode
        ? realLotRows!
            .filter((l) => l.section === sec.name)
            .slice()
            .sort((a, b) => a.code.localeCompare(b.code))
        : [];

      /*
       * One entry per box to draw.
       *
       * The two modes differ ONLY here. On an arrangement a cell is a
       * grid position and the lot is whichever one falls there in code
       * order; on a survey a cell is a measured position and the lot is
       * the one measured there. Everything below — the concrete, the
       * headstones, the click targets — is identical, because a lot is
       * a lot however the map worked out where to put it.
       */
      interface Cell {
        r: number;
        c: number;
        x: number;
        z: number;
        rotY: number;
        real: RealLotRow | null;
        /** How the position was obtained. Null off a survey. */
        source: string | null;
        accuracyM: number | null;
      }
      const x0 = -sec.w / 2 + cellW / 2;
      const z0 = -sec.d / 2 + cellD / 2;
      const cells: Cell[] = [];
      if (surveying) {
        placed
          .filter((p) => p.lot.section === sec.name)
          .forEach((p, i) => {
            cells.push({
              r: Math.floor(i / Math.max(1, sec.cols)),
              c: i % Math.max(1, sec.cols),
              x: p.x,
              z: p.z,
              rotY: p.rotY,
              source: p.source,
              accuracyM: p.accuracyM,
              real: {
                _id: p.lot._id,
                code: p.lot.code,
                section: p.lot.section,
                block: p.lot.block,
                status: p.lot.status,
                type: p.lot.type,
                basePriceCents: p.lot.basePriceCents,
                areaSqm: p.lot.areaSqm,
                hasPhoto: p.lot.hasPhoto,
              },
            });
          });
      } else {
        for (let r = 0; r < sec.rows; r++) {
          for (let c = 0; c < sec.cols; c++) {
            cells.push({
              r,
              c,
              x: sec.cx + x0 + c * cellW,
              z: sec.cz + z0 + r * cellD,
              rotY: 0,
              /*
               * Nothing on an arrangement. The lot is drawn where the
               * grid puts it, which has no relationship to any stored
               * position — colouring that by how well the stored one is
               * known would describe a coordinate the screen is not
               * showing.
               */
              source: null,
              accuracyM: null,
              real: realMode ? (secReal[r * sec.cols + c] ?? null) : null,
            });
          }
        }
      }

      {
        for (const cell of cells) {
          const r = cell.r;
          const c = cell.c;
          gid++;

          // Resolve the lot for this cell — real or procedural-demo.
          let st: LotStatus;
          let type: LotUserData["type"];
          let code: string;
          let realLotId: string | null;
          let price: number;
          let block: string;
          let occupant: string | null;
          if (realMode) {
            const rl = cell.real;
            if (rl === null) continue; // no real lot here — leave empty
            st = to3DStatus(rl.status);
            type = to3DType(rl.type);
            code = rl.code;
            realLotId = rl._id;
            price = Math.round(rl.basePriceCents / 100);
            block = rl.block;
            occupant = null; // occupant join is out of scope for the survey view
          } else {
            st = pickStatus(gid + sec.id.charCodeAt(0) * 13);
            type =
              Boolean(sec.mausoleum) && r === 0 && c % 3 !== 1
                ? "mausoleum"
                : c % 3 === 0
                  ? "family"
                  : "single";
            code = `${sec.id}-${100 + r * sec.cols + c + 1}`;
            realLotId = null;
            price =
              type === "mausoleum" ? 1350000 : type === "family" ? 340000 : 88000;
            block = `${sec.id}${r + 1}`;
            occupant =
              STATUS[st].stone && st === "occupied"
                ? (OCC[gid % OCC.length] ?? null)
                : null;
          }
          const cfg = STATUS[st];
          const { baseW, baseD } = baseSize(type);
          const userData: LotUserData = {
            id: realLotId ?? "lot" + gid,
            code,
            status: st,
            type,
            section: sec.name,
            sectionCode: sec.code,
            price,
            occupant,
            block,
            realLotId,
          };
          /*
           * A record, not nine meshes.
           *
           * Every lot used to become a THREE.Group of about nine
           * objects. Ninety of those is invisible; eighteen thousand —
           * two thousand lots — is a map that stops working at exactly
           * the moment the park is finally mapped. The scene is built
           * once, from these, after every garden has contributed.
           */
          draws.push({
            userData,
            type,
            stone: cfg.stone,
            x: cell.x,
            z: cell.z,
            rotY: cell.rotY,
            // Mausoleum heights vary per lot. With a unit box that is a
            // scale, not a second geometry.
            wallH: 3.0 + rand(gid) * 1.1,
            insetColor: cfg.stone ? 0xcdbfa6 : sec.tint,
            statusColor: cfg.color,
            source: cell.source,
            accuracyM: cell.accuracyM,
            baseW,
            baseD,
          });
        }
      }

      const el = document.createElement("div");
      el.className = "phase3d-seclabel";
      const cnt = draws.filter((d) => d.userData.sectionCode === sec.code);
      const avail = cnt.filter(
        (d) => d.userData.status === "available",
      ).length;
      el.innerHTML = `<span class="sn">${sec.name}</span><span class="sc">${cnt.length} LOTS · ${avail} OPEN</span>`;
      stage.appendChild(el);
      labelEls.push({ el, sec });
    });

    /*
     * ---- Build every lot in the park, at once -----------------------
     *
     * One InstancedMesh per PART rather than nine meshes per lot: about
     * nine draw calls for the whole cemetery instead of eighteen
     * thousand.
     *
     * Every geometry below is a UNIT shape. A family plot, a single and
     * a mausoleum with a randomised wall height differ only in scale,
     * so they share one box — and colour rides on the instance, so five
     * statuses do not become five more meshes.
     *
     * The bookkeeping that maps a lot to its slots, and the matrices
     * themselves, live in `@/lib/lotInstancing` where they are checked
     * against numbers. An index off by one here selects the wrong grave
     * and the map looks perfectly correct while doing it.
     */
    const plan = planInstances(
      draws.map((d) => ({
        lotId: d.userData.id,
        type: d.type,
        stone: d.stone,
      })),
    );
    const drawById = new Map(draws.map((d) => [d.userData.id, d]));

    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitCone = new THREE.ConeGeometry(1, 1, 4);
    // Baked, not applied per instance: the cap lies across the
    // headstone, and an instance matrix here carries only a Y rotation.
    const unitCap = new THREE.CylinderGeometry(
      0.5, 0.5, 1, 14, 1, false, 0, Math.PI,
    );
    unitCap.rotateZ(Math.PI / 2);
    unitCap.rotateY(Math.PI / 2);

    const partGeometry: Record<Part, THREE.BufferGeometry> = {
      base: unitBox,
      inset: unitBox,
      wall: unitBox,
      roof: unitCone,
      fin: unitBox,
      headstone: unitBox,
      cap: unitCap,
      stake: unitBox,
      flag: unitBox,
    };

    /** The colour a part takes, given the lot it belongs to. */
    const partColour = (part: Part, d: LotDraw): number => {
      switch (part) {
        case "base":
          return 0xe7dfce;
        case "inset":
          return d.insetColor;
        case "wall":
        case "headstone":
        case "cap":
          return d.statusColor;
        case "roof":
          return 0x144437;
        case "fin":
          return 0xc9a96b;
        case "stake":
          return 0x4a8270;
        case "flag":
          return 0x9bbf8f;
      }
    };

    const instanced: Partial<Record<Part, THREE.InstancedMesh>> = {};
    const _m = new THREE.Matrix4();
    const _col = new THREE.Color();

    /** Write one lot's transform into every buffer it appears in. */
    const writeLot = (id: string, lift: number, visible: boolean) => {
      const d = drawById.get(id);
      const slots = plan.slotsByLot.get(id);
      if (d === undefined || slots === undefined) return;
      for (const slot of slots) {
        const mesh = instanced[slot.part];
        if (mesh === undefined) continue;
        const elements = visible
          ? instanceMatrix(
              slot.part,
              { baseW: d.baseW, baseD: d.baseD, wallH: d.wallH },
              { x: d.x, z: d.z, rotY: d.rotY, lift },
            )
          : hiddenMatrix();
        _m.fromArray(elements);
        mesh.setMatrixAt(slot.index, _m);
        mesh.instanceMatrix.needsUpdate = true;
      }
    };

    for (const part of PARTS) {
      const count = plan.counts[part] ?? 0;
      if (count === 0) continue;
      const mesh = new THREE.InstancedMesh(
        partGeometry[part],
        new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.02 }),
        count,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Rebuilt every frame otherwise: the park does not move, so the
      // bounding sphere computed once is the one that stays true.
      mesh.frustumCulled = false;
      instanced[part] = mesh;
      scene.add(mesh);

      const ids = plan.lotIdsByPart[part] ?? [];
      ids.forEach((id, index) => {
        const d = drawById.get(id);
        if (d === undefined) return;
        _col.setHex(partColour(part, d));
        mesh.setColorAt(index, _col);
      });
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }

    /*
     * Repaint the park by placement rather than by status.
     *
     * Cheap only because the parts are instanced: this is a handful of
     * colour-buffer writes, where before it would have been reaching
     * into eighteen thousand meshes' materials — which is why the
     * previous renderer could not have offered this at all.
     *
     * The slab keeps its concrete colour in both modes. It is the
     * ground the lot sits on, not a claim about the lot.
     */
    const applyColourMode = (mode: ColourMode) => {
      for (const part of PARTS) {
        const mesh = instanced[part];
        if (mesh === undefined) continue;
        const ids = plan.lotIdsByPart[part] ?? [];
        ids.forEach((id, index) => {
          const d = drawById.get(id);
          if (d === undefined) return;
          const hex =
            mode === "placement" && part !== "base"
              ? placementBand(d.source).color
              : partColour(part, d);
          _col.setHex(hex);
          mesh.setColorAt(index, _col);
        });
        if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      }
    };

    for (const d of draws) writeLot(d.userData.id, 0, true);

    /** The mesh clicks are tested against — every lot has exactly one. */
    const pickMesh = instanced.base ?? null;

    /*
     * Avenues + promenade.
     *
     * Arrangement only. These are drawn BETWEEN the synthetic garden
     * blocks, at spacings the arrangement invented — on a survey there
     * is no such gap to fill, and laying tarmac across measured ground
     * would put a road where the park has none.
     */
    const parcelD = Math.max(...SECTIONS.map((s) => s.d)) + 5;
    for (let i = 0; illustrative && i < SECTIONS.length - 1; i++) {
      const a = SECTIONS[i];
      const b = SECTIONS[i + 1];
      if (!a || !b) continue;
      const xMid = (a.cx + a.w / 2 + b.cx - b.w / 2) / 2;
      const p = new THREE.Mesh(
        new THREE.BoxGeometry(avenue - 1.2, 0.08, parcelD),
        pathMat,
      );
      p.position.set(xMid, 0.05, 0);
      p.receiveShadow = true;
      scene.add(p);
    }
    if (illustrative) {
      const prom = new THREE.Mesh(
        new THREE.BoxGeometry(totalW + 10, 0.08, 2),
        pathMat,
      );
      prom.position.set(0, 0.05, parcelD / 2 + 2.5);
      prom.receiveShadow = true;
      scene.add(prom);
    }

    // Trees along the parcel edges.
    const tree = (x: number, z: number) => {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.26, 1.6, 7),
        new THREE.MeshStandardMaterial({ color: 0x6b5640, roughness: 1 }),
      );
      trunk.position.y = 0.8;
      trunk.castShadow = true;
      g.add(trunk);
      const fMat = new THREE.MeshStandardMaterial({ color: 0x3f7a5c, roughness: 1 });
      for (let i = 0; i < 3; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(1.1 - i * 0.18, 8, 7), fMat);
        f.position.y = 2 + i * 0.7;
        f.position.x = (rand(i + x) - 0.5) * 0.5;
        f.castShadow = true;
        g.add(f);
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(0.9 + rand(x * z + 1) * 0.5);
      scene.add(g);
    };
    const edge = parcelD / 2 + 3.5;
    for (let i = 0; illustrative && i < 7; i++) {
      const x = -totalW / 2 - 3 + (i * (totalW + 6)) / 6;
      tree(x, -edge);
      tree(x, edge);
    }

    // Gate / chapel.
    if (illustrative) {
      const g = new THREE.Group();
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(5, 3.4, 4),
        new THREE.MeshStandardMaterial({ color: 0x1d5c4d, roughness: 0.7 }),
      );
      wall.position.y = 1.7;
      wall.castShadow = true;
      wall.receiveShadow = true;
      g.add(wall);
      const roof = new THREE.Mesh(
        new THREE.ConeGeometry(3.7, 1.8, 4),
        new THREE.MeshStandardMaterial({ color: 0x144437, roughness: 0.7 }),
      );
      roof.rotation.y = Math.PI / 4;
      roof.position.y = 4.3;
      roof.castShadow = true;
      g.add(roof);
      const cv = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16), curbMat);
      cv.position.y = 6;
      g.add(cv);
      const ch = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.16), curbMat);
      ch.position.y = 6.15;
      g.add(ch);
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(1.3, 2, 0.1),
        new THREE.MeshStandardMaterial({ color: 0xc9a96b, roughness: 0.5 }),
      );
      door.position.set(0, 1, 2.01);
      g.add(door);
      g.position.set(0, 0, parcelD / 2 + 7);
      scene.add(g);
    }

    /*
     * How far a phone fix could be out, drawn to scale.
     *
     * Shown for the SELECTED lot only. One translucent disc is a fact
     * about the grave somebody is looking at; two thousand overlapping
     * discs is a fog that hides the map. Only GPS gets one — a survey
     * has an outline instead, and a drawn or clicked position has no
     * measured uncertainty at all, so a ring there would invent a
     * number nobody recorded.
     */
    const uncertainty = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({
        color: 0xd9a441,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
      }),
    );
    uncertainty.rotation.x = -Math.PI / 2;
    uncertainty.visible = false;
    scene.add(uncertainty);

    const showUncertainty = (d: LotDraw | null) => {
      const radius =
        d === null ? null : uncertaintyRadiusM(d.source, d.accuracyM);
      if (d === null || radius === null) {
        uncertainty.visible = false;
        return;
      }
      uncertainty.visible = true;
      uncertainty.position.set(d.x, 0.08, d.z);
      uncertainty.scale.setScalar(radius);
    };

    // Selection ring.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.1, 0.09, 12, 40),
      new THREE.MeshBasicMaterial({ color: 0xc9a96b }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.visible = false;
    scene.add(ring);

    // Interaction.
    const ray = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let selectedId: string | null = null;
    let currentFilter = "all";

    const isShown = (u: LotUserData) =>
      currentFilter === "all" || u.status === currentFilter;

    /*
     * Which grave was clicked.
     *
     * A lot is no longer an object with `userData` to walk up to — it
     * is a row in a shared buffer. Raycasting the slab mesh returns an
     * instance index, and the plan turns that number back into a lot.
     * Getting this wrong selects the neighbouring grave and looks
     * entirely correct doing it, which is why the mapping is tested.
     */
    const lotAtPointer = (): LotDraw | null => {
      if (pickMesh === null) return null;
      ray.setFromCamera(mouse, camera);
      const hit = ray.intersectObject(pickMesh, false)[0];
      const index = hit?.instanceId;
      if (index === undefined) return null;
      const id = plan.lotIdsByPart.base?.[index];
      if (id === undefined) return null;
      const d = drawById.get(id);
      // A filtered-out lot is scaled to nothing, but a degenerate
      // instance can still register a hit — so the filter decides here
      // too rather than relying on the geometry having vanished.
      return d !== undefined && isShown(d.userData) ? d : null;
    };

    const setPointer = (e: PointerEvent | MouseEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      mouse.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    };
    const onPointerMove = (e: PointerEvent) => {
      setPointer(e);
      renderer.domElement.style.cursor =
        lotAtPointer() !== null ? "pointer" : "grab";
    };
    const onPointerDown = () => {
      renderer.domElement.style.cursor = "grabbing";
    };
    const onClick = (e: MouseEvent) => {
      setPointer(e);
      const d = lotAtPointer();
      if (d !== null) selectLot(d);
    };
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("click", onClick);

    function selectLot(d: LotDraw) {
      // The previous selection drops back down. With groups this was a
      // property on an object; with instances it is a rewrite of every
      // slot that lot occupies.
      if (selectedId !== null && selectedId !== d.userData.id) {
        writeLot(selectedId, 0, true);
      }
      selectedId = d.userData.id;
      writeLot(selectedId, SELECTED_LIFT, true);
      ring.visible = true;
      ring.position.set(d.x, 0.1, d.z);
      showUncertainty(d);
      setSelected({ ...d.userData });
    }

    const applyFilter = (f: string) => {
      currentFilter = f;
      /*
       * A hidden instance is scaled to nothing.
       *
       * An object could be removed from the scene; an instance cannot —
       * the buffer is fixed. Dimming via materials is not an option
       * either, for the reason it never was: parts share one material
       * per kind, so a per-lot opacity write would be last-write-wins
       * across the whole park.
       */
      for (const d of draws) {
        const shown = isShown(d.userData);
        writeLot(
          d.userData.id,
          shown && d.userData.id === selectedId ? SELECTED_LIFT : 0,
          shown,
        );
      }
      const sel = selectedId === null ? null : drawById.get(selectedId);
      ring.visible = sel !== undefined && sel !== null && isShown(sel.userData);
    };

    /*
     * Camera focus / reset.
     *
     * The flight has to be INTERRUPTIBLE, and it was not. Each frame it
     * pulled the camera 8% of the way toward its destination and only
     * stopped once it got within half a metre — so a drag was undone on
     * the very next frame, and because dragging kept the camera further
     * than half a metre away, the stop condition never fired. Finding a
     * lot left somebody locked to it, with the reset button the only
     * way out.
     *
     * Two independent ways to stop now: touching the controls cancels
     * it, and it gives up regardless after a fixed number of frames. A
     * camera that will not let go is worse than one that stops early.
     */
    let camTarget: THREE.Vector3 | null = null;
    let tgtTarget: THREE.Vector3 | null = null;
    let flyFrames = 0;
    const cancelFly = () => {
      camTarget = null;
      tgtTarget = null;
      flyFrames = 0;
    };
    /** About three seconds at 60fps. */
    const MAX_FLY_FRAMES = 180;
    // Any grab, wheel or touch means the person has taken over.
    controls.addEventListener("start", cancelFly);
    const focusSection = (index: number) => {
      const sec = SECTIONS[index];
      if (!sec) return;
      camTarget = new THREE.Vector3(sec.cx, 22, sec.d / 2 + 22);
      tgtTarget = new THREE.Vector3(sec.cx, 1, 0);
      flyFrames = 0;
    };
    const resetView = () => {
      camTarget = CAM0.clone();
      tgtTarget = new THREE.Vector3(0, 1, 0);
      flyFrames = 0;
    };

    apiRef.current = {
      applyFilter,
      resetView,
      setAutoRotate: (on: boolean) => {
        controls.autoRotate = on;
      },
      focusSection,
      setColourMode: applyColourMode,
      focusLotByCode: (code: string) => {
        const wanted = code.trim().toLowerCase();
        if (wanted.length === 0) return false;
        /*
         * Exact code first, then a prefix.
         *
         * "A-1-1" must find A-1-1 rather than A-1-10, which sorts
         * earlier and would otherwise win — sending somebody to the
         * wrong grave for a search that looked like it worked.
         */
        const d =
          draws.find((x) => x.userData.code.toLowerCase() === wanted) ??
          draws.find((x) => x.userData.code.toLowerCase().startsWith(wanted));
        if (d === undefined) return false;
        selectLot(d);
        // Close enough to read the code on the marker, angled rather
        // than straight down so the headstone is visible.
        camTarget = new THREE.Vector3(d.x, 9, d.z + 11);
        tgtTarget = new THREE.Vector3(d.x, 0.5, d.z);
        flyFrames = 0;
        return true;
      },
    };

    // Roll-up stats (computed once).
    {
      const total = draws.length;
      const avail = draws.filter(
        (l) => (l.userData as LotUserData).status === "available",
      ).length;
      const occ = draws.filter(
        (l) => (l.userData as LotUserData).status === "occupied",
      ).length;
      const sections: SectionRollup[] = SECTIONS.map((sec) => {
        const c = draws.filter(
          (l) => (l.userData as LotUserData).sectionCode === sec.code,
        );
        const oc = c.filter((l) => {
          const s = (l.userData as LotUserData).status;
          return s === "occupied" || s === "sold";
        }).length;
        return {
          name: sec.name,
          percent: c.length > 0 ? Math.round((oc / c.length) * 100) : 0,
          count: c.length,
        };
      });
      setRollup({
        total,
        available: avail,
        occupiedPercent: total > 0 ? Math.round((occ / total) * 100) : 0,
        sections,
      });
    }

    // Resize (robust against 0×0 pre-layout reads).
    const resize = () => {
      const w = stage.clientWidth || stage.offsetWidth;
      const h = stage.clientHeight || stage.offsetHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", resize);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(stage);
    }
    requestAnimationFrame(resize);
    resize();

    // Project the DOM section labels each frame.
    const _v = new THREE.Vector3();
    const updateLabels = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      /*
       * Garden labels, kept off each other.
       *
       * Projecting each one and writing it straight to the DOM meant
       * that two gardens close together — or a camera flattened toward
       * the horizon — put their labels on the same few pixels, where
       * they stacked into an unreadable heap and the top one was
       * whichever the loop wrote last.
       *
       * The arithmetic is in `@/lib/labelLayout`, where overlap can be
       * checked with numbers rather than by squinting at a screenshot.
       */
      const boxes = labelEls.map(({ el, sec }) => {
        _v.set(sec.cx, 5.5, sec.cz - sec.d / 2 - 2);
        _v.project(camera);
        return {
          key: sec.id,
          x: (_v.x * 0.5 + 0.5) * w,
          y: (-_v.y * 0.5 + 0.5) * h,
          // Measured, not assumed: a garden with a long name needs more
          // room, and guessing a width would let long labels overlap
          // while short ones were pushed apart for nothing.
          width: el.offsetWidth || 160,
          height: el.offsetHeight || 24,
          depth: _v.z,
          behind: _v.z > 1,
        };
      });

      const placements = layoutLabels(boxes, { width: w, height: h });
      placements.forEach((p, i) => {
        const el = labelEls[i]?.el;
        if (el === undefined) return;
        el.style.opacity = p.visible ? "1" : "0";
        el.style.left = p.x + "px";
        el.style.top = p.y + "px";
      });
    };

    let raf = 0;
    let pulse = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      /*
       * The selected lot's lift is written once when it is selected,
       * not eased every frame across every lot.
       *
       * The old loop touched all two thousand objects on every frame to
       * animate one of them. Writing an instance matrix costs a buffer
       * upload, so the same trick here would push the whole park to the
       * GPU sixty times a second to raise one grave by half a metre.
       */
      if (camTarget !== null && tgtTarget !== null) {
        flyFrames += 1;
        camera.position.lerp(camTarget, 0.08);
        controls.target.lerp(tgtTarget, 0.08);
        /*
         * Arriving is the ordinary way to finish; running out of frames
         * is the guarantee. The old condition was the only one, and it
         * could not fire while somebody was dragging against it.
         */
        if (
          camera.position.distanceTo(camTarget) < 0.5 ||
          flyFrames >= MAX_FLY_FRAMES
        ) {
          cancelFly();
        }
      }
      if (ring.visible) {
        pulse += 0.05;
        ring.position.y = 0.1 + Math.sin(pulse) * 0.05 + SELECTED_LIFT;
        ring.scale.setScalar(1 + Math.sin(pulse) * 0.03);
      }
      if (renderer.domElement.width === 0 || renderer.domElement.height === 0)
        resize();
      controls.update();
      updateLabels();
      renderer.render(scene, camera);
    };

    // Open with the first available lot selected.
    const initial =
      draws.find((d) => d.userData.status === "available") ?? draws[0];
    if (initial !== undefined) selectLot(initial);
    setReady(true);
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      if (ro) ro.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      controls.removeEventListener("start", cancelFly);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      labelEls.forEach(({ el }) => el.remove());
      if (renderer.domElement.parentNode === stage) {
        stage.removeChild(renderer.domElement);
      }
      apiRef.current = null;
    };
  }, [sceneSignature, sectionSignature, surveySignature]);

  // Bridge filter state → scene. Also re-applied after a rebuild
  // (sceneSignature change) so the active filter survives a data refresh.
  useEffect(() => {
    apiRef.current?.applyFilter(filter);
  }, [filter, sceneSignature]);

  // Bridge colour mode → scene. Re-applied after a rebuild so the view
  // somebody chose survives a data refresh.
  useEffect(() => {
    apiRef.current?.setColourMode(colourMode);
  }, [colourMode, sceneSignature]);

  // Bridge auto-rotate toggle → controls (re-applied after a rebuild).
  useEffect(() => {
    apiRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate, sceneSignature]);

  const dims =
    selected?.type === "family"
      ? "4.0 m × 2.4 m"
      : selected?.type === "mausoleum"
        ? "6.0 m × 4.0 m"
        : "1.0 m × 2.4 m";
  const capacity =
    selected?.type === "family"
      ? "6 interments"
      : selected?.type === "mausoleum"
        ? "12 crypts"
        : "1 interment";

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-surface-border bg-surface-base shadow-[var(--shadow-card)] lg:grid-cols-[1fr_360px]">
      {/* Stage */}
      <div className="relative h-[60vh] min-h-[460px] bg-surface-emphasis lg:h-[70vh]">
        <div ref={stageRef} className="absolute inset-0 overflow-hidden" />

        {/* Filter toolbar */}
        {/*
          Find a lot without orbiting for it.

          The flat map has had find-a-grave for a long time; the 3D one
          had nothing, so locating A-1-14 among two thousand meant
          spinning the camera until you spotted it. By code, because
          that is what is written on the paperwork somebody is holding
          — a name search lives on /map, which can query occupants.
        */}
        {!isPublic && (
          <form
            className="absolute left-4 top-[62px] flex items-center gap-1.5 rounded-lg border border-surface-border bg-surface-base/95 p-1.5 shadow-[var(--shadow-card)] backdrop-blur"
            onSubmit={(e) => {
              e.preventDefault();
              const found = apiRef.current?.focusLotByCode(search) ?? false;
              setSearchMiss(!found && search.trim().length > 0);
            }}
          >
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSearchMiss(false);
              }}
              placeholder="Find lot code…"
              aria-label="Find a lot by its code"
              data-testid="lot-search"
              className="w-40 rounded-md border border-surface-border bg-surface-base px-2 py-1.5 text-xs text-text-default placeholder:text-text-muted"
            />
            <button
              type="submit"
              data-testid="lot-search-go"
              className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-white"
            >
              Find
            </button>
            {searchMiss && (
              <span
                role="status"
                data-testid="lot-search-miss"
                className="max-w-[150px] text-[11px] leading-snug text-amber-700"
              >
                No lot with that code on the map.
              </span>
            )}
          </form>
        )}

        <div className="absolute left-4 top-4 flex max-w-[560px] flex-wrap gap-1.5 rounded-lg border border-surface-border bg-surface-base/95 p-1.5 shadow-[var(--shadow-card)] backdrop-blur">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={[
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                filter === f.value
                  ? "bg-primary text-primary-fg"
                  : "text-text-muted hover:bg-surface-emphasis hover:text-primary",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/*
          View controls.

          The PHASE 1 / 2 / 3 switcher that used to sit here was
          decoration asserting things nothing had checked: Phase 1 was
          styled active unconditionally, clicking it did what the reset
          button beside it already does, and 2 and 3 popped "GPS survey
          scheduled; 3D mesh not yet captured" — a sentence written for
          a demo, about a schedule no record holds.

          The map has no notion of a phase; it draws whatever gardens
          exist. Real phase state lives on /phase-planning, which the
          page header already links to.
        */}
        <div className="absolute right-4 top-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            aria-pressed={autoRotate}
            title="Auto-rotate"
            className={[
              "flex h-10 w-10 items-center justify-center rounded-md border shadow-[var(--shadow-card)] transition-colors",
              autoRotate
                ? "border-primary bg-primary text-primary-fg"
                : "border-surface-border bg-surface-base/95 text-text-default hover:text-primary",
            ].join(" ")}
          >
            <RotateIcon />
          </button>
          <button
            type="button"
            onClick={() => apiRef.current?.resetView()}
            title="Reset view"
            className="flex h-10 w-10 items-center justify-center rounded-md border border-surface-border bg-surface-base/95 text-text-default shadow-[var(--shadow-card)] transition-colors hover:text-primary"
          >
            <ResetIcon />
          </button>
        </div>

        {/*
          Legend.

          It swaps wholesale rather than showing both palettes at once:
          status and confidence are different questions, and a reader
          must never be in doubt about which one the colours are
          answering.
        */}
        <div
          data-testid="map-legend"
          className="absolute bottom-4 left-4 max-w-[240px] rounded-lg border border-surface-border bg-surface-base/95 px-4 py-3 shadow-[var(--shadow-card)]"
        >
          <div className="mb-2 font-mono text-[9px] uppercase tracking-[0.18em] text-text-muted">
            {colourMode === "placement" ? "How it was placed" : "Lot status"}
          </div>
          {colourMode === "placement"
            ? PLACEMENT_BANDS.map((b) => (
                <div
                  key={b.kind}
                  className="my-1 flex items-start gap-2 text-xs text-text-default"
                >
                  <span
                    className="mt-0.5 h-3 w-3 shrink-0 rounded-[3px]"
                    style={{
                      background: `#${b.color.toString(16).padStart(6, "0")}`,
                    }}
                  />
                  <span>
                    {b.label}
                    <span className="block text-[10px] leading-snug text-text-muted">
                      {b.meaning}
                    </span>
                  </span>
                </div>
              ))
            : LEGEND.map((l) => (
                <div
                  key={l.label}
                  className="my-1 flex items-center gap-2 text-xs text-text-default"
                >
                  <span
                    className="h-3 w-3 rounded-[3px]"
                    style={{ background: l.color }}
                  />
                  {l.label}
                </div>
              ))}

          {/*
            Only offered on a survey. On an arrangement the lot is drawn
            where the grid put it, which has no relationship to any
            stored position — colouring that by how well the stored one
            is known would describe a coordinate the screen is not
            showing.
          */}
          {surveyMode && !isPublic && (
            <button
              type="button"
              data-testid="colour-mode-toggle"
              onClick={() =>
                setColourMode((m) =>
                  m === "status" ? "placement" : "status",
                )
              }
              className="mt-2 border-t border-surface-border pt-2 text-[11px] font-medium text-text-muted underline hover:text-primary"
            >
              {colourMode === "placement"
                ? "Colour by status"
                : "Colour by how it was placed"}
            </button>
          )}
        </div>

        {/* Hint */}
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-surface-border bg-surface-muted/90 px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-wide text-text-muted">
          {HINT}
        </div>

        {!ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-emphasis">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-surface-border border-t-primary" />
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted">
              Building 3D survey…
            </span>
          </div>
        )}
      </div>

      {/* Rail */}
      <aside className="overflow-y-auto border-t border-surface-border p-6 lg:border-l lg:border-t-0">
        {/*
          Which of the two things you are looking at.
          
          The single most important line on this screen. A survey and an
          arrangement render identically — same boxes, same colours,
          same confidence — and only one of them is where the graves
          actually are.
        */}
        {modeDecision !== null && !isDemo && !isPublic && (
          <div
            data-testid="map-mode-bar"
            className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-surface-border bg-surface-muted px-3 py-2"
          >
            <p className="text-[11px] leading-snug text-text-muted">
              {surveyMode ? (
                <>
                  <strong className="font-semibold text-text-default">
                    Surveyed positions.
                  </strong>{" "}
                  {modeDecision.placedCount} lot
                  {modeDecision.placedCount === 1 ? "" : "s"} drawn where
                  they were measured.
                  {modeDecision.unplacedCount > 0 && (
                    <>
                      {" "}
                      {modeDecision.unplacedCount} more have no measured
                      position and are not shown.
                    </>
                  )}{" "}
                  {/*
                    Otherwise the survey view reads as broken. It is
                    emptier than the arrangement on purpose: everything
                    missing from it is scenery the park never recorded.
                  */}
                  <span data-testid="map-scenery-note">
                    The paths, trees and chapel on the arrangement are
                    illustrative, so they are left off here — only
                    measured ground is drawn.
                  </span>
                </>
              ) : (
                <>
                  <strong className="font-semibold text-text-default">
                    Arrangement, not a survey.
                  </strong>{" "}
                  Lots are drawn in code order on each garden&rsquo;s
                  grid, so a lot&rsquo;s place here is its place in that
                  order — not where it stands in the ground.
                </>
              )}
              {modeDecision.missingSections.length > 0 && surveyMode && (
                <>
                  {" "}
                  Nothing is placed yet in{" "}
                  <span
                    data-testid="map-missing-sections"
                    className="text-text-default"
                  >
                    {modeDecision.missingSections.join(", ")}
                  </span>
                  , so {modeDecision.missingSections.length === 1
                    ? "it is"
                    : "they are"}{" "}
                  absent from this view.
                </>
              )}
            </p>
            {modeDecision.canSwitch && (
              <button
                type="button"
                data-testid="map-mode-toggle"
                onClick={() =>
                  setPreferredMode(surveyMode ? "arrangement" : "survey")
                }
                className="shrink-0 rounded-md border border-surface-border bg-surface-base px-3 py-1.5 text-xs font-semibold text-text-default hover:border-accent-gold hover:text-primary"
              >
                {surveyMode ? "Show the arrangement" : "Show surveyed positions"}
              </button>
            )}
          </div>
        )}

        {anyDerivedLayout && !isDemo && !isPublic && !surveyMode && (
          <div
            data-testid="derived-layout-note"
            className="mb-4 rounded-md border border-surface-border bg-surface-muted px-3 py-2 text-[11px] leading-snug text-text-muted"
          >
            <strong className="font-semibold text-text-default">
              Layout guessed.
            </strong>{" "}
            At least one garden has no arrangement set, so it is drawn on
            a square-ish grid sized to its lots. Set the columns and rows
            on the section to draw it as it actually sits.
          </div>
        )}
        {isDemo && !isPublic && (
          <div className="mb-4 rounded-md border border-status-reserved-border/40 bg-status-reserved-bg px-3 py-2 text-[11px] leading-snug text-status-reserved-text">
            <strong className="font-semibold">Demonstration layout.</strong> No
            lots are loaded yet, so this is illustrative. Create lots in a
            garden and they appear here — the map draws them in code
            order, so the codes are the arrangement.
          </div>
        )}
        {selected ? (
          <>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">
              {selected.section} · Block {selected.block}
            </div>
            <div className="mt-2.5 font-display text-4xl font-semibold leading-none text-text-default">
              Lot {selected.code}
            </div>
            <hr className="my-4 border-0 border-t border-accent-gold opacity-60" />
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize ${PILL_TINT[selected.status]}`}
            >
              {selected.status}
            </span>

            <dl className="mt-5 grid grid-cols-2">
              <Fact label="Type" value={cap(selected.type)} />
              <Fact label="Status" value={cap(selected.status)} />
              <Fact
                label="Dimensions"
                value={
                  detail
                    ? `${detail.widthM}m × ${detail.depthM}m`
                    : dims
                }
              />
              <Fact
                label="Area"
                value={detail ? `${detail.areaSqm} sqm` : "—"}
              />
              <Fact label="Capacity" value={capacity} />
              <Fact label="Base price" value={peso(selected.price)} />
            </dl>

            {/*
              Where it actually is. A placeholder centroid is a stand-in
              written at lot creation, not a position anybody measured —
              the server refuses to hand one over, and this says so
              rather than printing a number that would send somebody to
              the wrong part of the park.
            */}
            {detail && (
              <div
                data-testid="lot-location"
                className="mt-4 rounded-md border border-surface-border bg-surface-muted px-3 py-2"
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
                  Location
                </div>
                {detail.lat !== null && detail.lng !== null ? (
                  <>
                    <div className="mt-1 font-mono text-xs text-text-default">
                      {detail.lat.toFixed(6)}, {detail.lng.toFixed(6)}
                    </div>
                    {/*
                      How much to trust that pair.

                      A measured survey, a point somebody clicked, a
                      phone reading with metres of slop and a row drawn
                      on a map all render as the same confident box. The
                      coordinate says WHERE; only this says how well
                      anybody actually knows.
                    */}
                    <div
                      data-testid="lot-position-source"
                      className="mt-1 text-[11px] leading-snug text-text-muted"
                    >
                      {describeSource(
                        detail.geometrySource,
                        detail.geometryAccuracyM,
                      )}
                    </div>
                  </>
                ) : (
                  <div className="mt-1 text-xs text-text-muted">
                    Not surveyed yet — this lot has no measured position,
                    only its place in {selected.section}, block{" "}
                    {selected.block}.
                  </div>
                )}
              </div>
            )}

            {/*
              A photograph is what a family recognises and what settles
              "is this the one by the tree". It is the survey that a park
              this size actually needs.
            */}
            {detail?.photoUrl != null && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={detail.photoUrl}
                alt={`Lot ${selected.code}`}
                data-testid="lot-photo"
                className="mt-4 w-full rounded-md border border-surface-border object-cover"
              />
            )}
            {detail !== undefined && detail !== null && detail.photoUrl === null && !isPublic && (
              <p
                data-testid="lot-photo-missing"
                className="mt-4 rounded-md border border-dashed border-surface-border px-3 py-2 text-xs text-text-muted"
              >
                No photograph yet. Adding one from the lot page is the
                quickest way to make this lot findable on the ground.
              </p>
            )}

            {/*
              Who is buried here — the question a cemetery map exists to
              answer, and the one this panel could not.

              It printed the illustrative parcel's procedural name under
              a hardcoded "1947 — 2024", so the demo answered it with
              fiction and the real park answered it with nothing.
            */}
            {detail !== undefined && detail !== null && detail.occupants.length > 0 && (
              <div
                data-testid="lot-occupants"
                className="mt-5 rounded-lg border border-surface-border bg-surface-muted p-4"
              >
                <div className="text-center font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
                  {detail.occupants.length === 1
                    ? "Resting here"
                    : `Resting here · ${detail.occupants.length}`}
                </div>
                <ul className="mt-2 space-y-3">
                  {detail.occupants.map((o) => (
                    <li key={o._id} className="text-center">
                      <div className="font-display text-xl font-semibold text-text-default">
                        {o.name}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-text-muted">
                        {lifespan(o)}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/*
              An occupied lot with nobody recorded in it is a gap in the
              records, not an empty grave. Saying so beats a blank space
              that reads as "nobody is buried here".
            */}
            {detail !== undefined &&
              detail !== null &&
              detail.occupants.length === 0 &&
              selected.status === "occupied" &&
              !isPublic && (
                <p
                  data-testid="lot-occupants-missing"
                  className="mt-5 rounded-lg border border-dashed border-surface-border px-3 py-2 text-center text-xs text-text-muted"
                >
                  Marked occupied, but no interment record is attached to
                  this lot.
                </p>
              )}

            <div className="mt-5 space-y-2.5">
              {isPublic ? (
                <>
                  {selected.status === "available" && (
                    <Link
                      href="/contact"
                      className={`${btnPrimary} w-full justify-center`}
                    >
                      Enquire about this lot
                    </Link>
                  )}
                  <Link
                    href="/pricing"
                    className={`${btnOutline} w-full justify-center`}
                  >
                    See pricing
                  </Link>
                </>
              ) : (
                <>
                  {selected.status === "available" && (
                    <Link
                      href={
                        selected.realLotId
                          ? `/sales/new?lotId=${encodeURIComponent(selected.realLotId)}`
                          : "/sales/new"
                      }
                      className={`${btnPrimary} w-full justify-center`}
                    >
                      Start a sale
                    </Link>
                  )}
                  <Link
                    href={selected.realLotId ? `/lots/${selected.realLotId}` : "/lots"}
                    className={`${btnOutline} w-full justify-center`}
                  >
                    Open full record
                  </Link>
                </>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted">
            Click a lot in the 3D view to inspect it.
          </p>
        )}

        {/* Phase roll-up */}
        <div className="mt-7 border-t border-surface-emphasis pt-4.5">
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted">
            {isPublic ? "The grounds" : "Development phase"}
          </div>
          <div className="mt-1.5 font-display text-2xl font-semibold text-text-default">
            {parcelLabel}
          </div>
          <div className="mt-3.5 flex border-y border-surface-emphasis">
            <Stat value={rollup ? String(rollup.total) : "—"} label="Lots" />
            <Stat value={rollup ? String(rollup.available) : "—"} label="Available" />
            <Stat
              value={rollup ? `${rollup.occupiedPercent}%` : "—"}
              label="Occupied"
            />
            <Stat value={String(parcelSections.length)} label="Sections" last />
          </div>
          <div className="mt-4 flex flex-col gap-0.5">
            {rollup?.sections.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onClick={() => apiRef.current?.focusSection(i)}
                className="flex items-center gap-2.5 rounded-md px-1 py-2 text-left transition-colors hover:bg-surface-muted"
              >
                <span className="flex-1 text-[13.5px] font-semibold text-text-default">
                  {s.name}
                </span>
                <span className="h-1.5 w-[88px] overflow-hidden rounded-full bg-surface-emphasis">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${s.percent}%` }}
                  />
                </span>
                <span className="min-w-[62px] text-right font-mono text-[11px] text-text-muted">
                  {s.percent}% · {s.count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-t border-surface-emphasis py-3 [&:nth-child(-n+2)]:border-t-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">
        {label}
      </dt>
      <dd className="mt-1 text-[15px] font-medium text-text-default">{value}</dd>
    </div>
  );
}

function Stat({
  value,
  label,
  last = false,
}: {
  value: string;
  label: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex-1 py-3.5 text-center ${last ? "" : "border-r border-surface-emphasis"}`}
    >
      <div className="font-display text-2xl font-semibold text-primary">{value}</div>
      <div className="mt-0.5 font-mono text-[8.5px] uppercase tracking-wide text-text-muted">
        {label}
      </div>
    </div>
  );
}

function RotateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-9 9z" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const btnBase =
  "inline-flex min-h-[44px] items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2";
const btnPrimary = `${btnBase} bg-primary text-primary-fg hover:bg-primary-hover`;
const btnOutline = `${btnBase} border border-surface-border bg-surface-base text-text-default hover:border-accent-gold hover:text-primary`;
