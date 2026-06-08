/**
 * Client-side GPS-import file parser — Story 8.1.
 *
 * Accepts two input shapes off the file-input widget:
 *
 *   1. **Native batch JSON** — the canonical shape this app consumes:
 *      `{ items: [{ lotCode: string, polygon: [{lat,lng}, ...], centroid?: {lat,lng} }] }`.
 *      No translation needed; pass straight to `importGpsBatch`.
 *
 *   2. **GeoJSON FeatureCollection** — what surveyors typically
 *      deliver from QGIS / ArcGIS. Each `Feature` must have:
 *        - `properties.lotCode: string` (the lot identifier)
 *        - `geometry.type === "Polygon"` (no MultiPolygon — see
 *          Story 8.1 §"Common LLM-developer mistakes": MultiPolygon
 *          indicates a survey error)
 *        - `geometry.coordinates` of GeoJSON shape
 *          `[[ [lng, lat], [lng, lat], ... ]]` (outer ring only;
 *          interior holes are not supported in Phase 2 lots).
 *      We translate `[lng, lat]` → `{ lat, lng }` (note the order
 *      flip — GeoJSON is longitude-first, our schema is `{lat, lng}`
 *      object pairs).
 *
 * Why the parser lives on the client, not the server:
 *
 *   - The Convex `importGpsBatch` mutation accepts the canonical
 *     `items[]` shape only. Keeping it format-agnostic keeps the
 *     server contract small. Format dialects (CSV, KML, Shapefile,
 *     re-projection) belong on the client where they can be
 *     translated to the canonical shape; the server stays focused
 *     on validation + audit emission.
 *
 *   - This module is also re-usable by Story 8.1's eventual upload-
 *     to-storage flow: when an `internalAction` lands, the same
 *     parser can run inside the action against the storage blob's
 *     `.text()` payload. The pure-function shape (string in,
 *     parsed-batch out) makes that swap clean.
 *
 * Error handling:
 *
 *   - Top-level JSON parse failure → `INVALID_JSON`.
 *   - Recognised shape but feature-level issues (e.g. one feature
 *     has `MultiPolygon`, one has a missing `lotCode`) collect into
 *     the result's `featureErrors[]` with the feature index — the
 *     UI can show them alongside the server's per-item errors so
 *     the surveyor sees both classes in one report. Per-feature
 *     errors do NOT abort the parse; the user can still kick off
 *     the import for the rows that did parse, then re-run with the
 *     surveyor's corrections for the failed ones.
 */

export interface ParsedLatLng {
  lat: number;
  lng: number;
}

export interface ParsedImportItem {
  lotCode: string;
  polygon: ParsedLatLng[];
  centroid?: ParsedLatLng;
}

export interface ParseFeatureError {
  featureIndex: number;
  lotCode?: string;
  reason: string;
}

export interface ParseResult {
  items: ParsedImportItem[];
  featureErrors: ParseFeatureError[];
  /** What shape we detected at the top level. */
  format: "native" | "geojson" | "csv";
}

export class GpsImportParseError extends Error {
  code: "INVALID_JSON" | "UNKNOWN_SHAPE" | "EMPTY" | "INVALID_CSV";
  constructor(
    code: "INVALID_JSON" | "UNKNOWN_SHAPE" | "EMPTY" | "INVALID_CSV",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "GpsImportParseError";
  }
}

/**
 * Story 8.1 AC1 — centroid sanity threshold.
 *
 * If the operator supplies an explicit `centroid` AND its distance
 * from the polygon's vertex-average centroid exceeds this delta in
 * EITHER latitude or longitude, the parser pushes a `featureErrors`
 * entry rather than silently accepting the disagreement.
 *
 * 0.00005° ≈ 5 metres at Manila latitudes — well under the cemetery's
 * smallest lot footprint, so a legitimate surveyor centroid lands
 * inside this tolerance. The check catches the canonical surveyor
 * "copy-paste-the-wrong-row" mistake (where the operator-supplied
 * centroid points to a completely different lot) without rejecting
 * the < 1 m wobble that comes from vertex-average vs geometric
 * centroid divergence on irregular polygons.
 */
export const CENTROID_SANITY_DELTA_DEG = 0.00005;

/**
 * Vertex-average centroid. Mirrors `polygonCentroid` in
 * `convex/lib/geometry.ts` exactly (intentional duplication — the
 * server file is not importable from the client tree). Returns `null`
 * for empty polygons rather than coercing to a default so a missing
 * centroid stays distinguishable from a real one.
 */
function vertexAverageCentroid(polygon: ParsedLatLng[]): ParsedLatLng | null {
  if (polygon.length === 0) return null;
  let sumLat = 0;
  let sumLng = 0;
  for (const p of polygon) {
    sumLat += p.lat;
    sumLng += p.lng;
  }
  return {
    lat: sumLat / polygon.length,
    lng: sumLng / polygon.length,
  };
}

/**
 * Run the centroid sanity check against a successfully-parsed item.
 * Returns a feature error to push when the explicit centroid is wildly
 * off, otherwise `null`. Callers should add the returned error to the
 * `featureErrors` array AND drop the item from `items[]` — a wrong
 * centroid is a strong signal the whole row is bogus.
 */
function checkCentroidSanity(
  item: ParsedImportItem,
  featureIndex: number,
): ParseFeatureError | null {
  if (item.centroid === undefined) return null;
  const computed = vertexAverageCentroid(item.polygon);
  if (computed === null) return null;
  const dLat = Math.abs(item.centroid.lat - computed.lat);
  const dLng = Math.abs(item.centroid.lng - computed.lng);
  if (dLat <= CENTROID_SANITY_DELTA_DEG && dLng <= CENTROID_SANITY_DELTA_DEG) {
    return null;
  }
  return {
    featureIndex,
    lotCode: item.lotCode,
    reason:
      `Supplied centroid (${item.centroid.lat.toFixed(5)},${item.centroid.lng.toFixed(5)}) ` +
      `disagrees with the polygon's computed centroid (` +
      `${computed.lat.toFixed(5)},${computed.lng.toFixed(5)}) by ` +
      `${Math.max(dLat, dLng).toFixed(6)}° (> ${CENTROID_SANITY_DELTA_DEG}°). ` +
      "Likely a surveyor copy-paste error — re-export the row.",
  };
}

/**
 * Parse a payload into the canonical batch shape.
 *
 * Auto-detects:
 *   - GeoJSON FeatureCollection (JSON object with `type` / `features`)
 *   - Native batch JSON (JSON object with `items`)
 *   - CSV (text starting with a header row containing `lotcode`)
 *
 * Throws `GpsImportParseError` for top-level failures (bad JSON, bad
 * CSV, unrecognised shape, empty payload). Returns a `ParseResult`
 * with both `items[]` (parseable rows) and `featureErrors[]` (rows we
 * couldn't translate). The caller decides whether to proceed with the
 * partial set.
 */
export function parseGpsBatch(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new GpsImportParseError("EMPTY", "File is empty.");
  }

  // CSV sniff first — CSV is not valid JSON, but a malformed JSON
  // input would also fail the CSV check, so we only commit to CSV
  // when the first character is plausibly a column-header letter
  // rather than `{` / `[`.
  const firstChar = trimmed[0]!;
  if (firstChar !== "{" && firstChar !== "[") {
    return withCentroidSanity(parseCsvShape(trimmed));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : "Unknown JSON parse failure.";
    throw new GpsImportParseError("INVALID_JSON", `JSON parse failed: ${detail}`);
  }

  if (raw === null || typeof raw !== "object") {
    throw new GpsImportParseError(
      "UNKNOWN_SHAPE",
      "Top-level JSON must be an object (either { items: [...] } or a GeoJSON FeatureCollection).",
    );
  }

  if (isNativeShape(raw)) {
    return withCentroidSanity(parseNativeShape(raw));
  }
  if (isGeoJsonFeatureCollection(raw)) {
    return withCentroidSanity(parseGeoJsonShape(raw));
  }
  throw new GpsImportParseError(
    "UNKNOWN_SHAPE",
    "Unrecognised JSON shape — expected either { items: [...] } or a GeoJSON FeatureCollection.",
  );
}

/**
 * Post-process a parse result by running the centroid-sanity check on
 * every item that carries an explicit centroid. Items that fail are
 * dropped from `items[]` and replaced with a `featureErrors[]` row.
 *
 * Threaded through the three format-specific parsers so the check
 * applies uniformly regardless of the input dialect.
 */
function withCentroidSanity(result: ParseResult): ParseResult {
  const cleanItems: ParsedImportItem[] = [];
  const extraErrors: ParseFeatureError[] = [];
  result.items.forEach((item, idx) => {
    const err = checkCentroidSanity(item, idx);
    if (err === null) {
      cleanItems.push(item);
      return;
    }
    extraErrors.push(err);
  });
  return {
    ...result,
    items: cleanItems,
    featureErrors: [...result.featureErrors, ...extraErrors],
  };
}

function isNativeShape(
  raw: object,
): raw is { items: unknown[] } {
  const obj = raw as Record<string, unknown>;
  return Array.isArray(obj.items);
}

function isGeoJsonFeatureCollection(
  raw: object,
): raw is { type: "FeatureCollection"; features: unknown[] } {
  const obj = raw as Record<string, unknown>;
  return obj.type === "FeatureCollection" && Array.isArray(obj.features);
}

function parseNativeShape(raw: { items: unknown[] }): ParseResult {
  const items: ParsedImportItem[] = [];
  const featureErrors: ParseFeatureError[] = [];

  raw.items.forEach((entry, idx) => {
    if (entry === null || typeof entry !== "object") {
      featureErrors.push({
        featureIndex: idx,
        reason: "Item is not an object.",
      });
      return;
    }
    const obj = entry as Record<string, unknown>;
    const lotCode = typeof obj.lotCode === "string" ? obj.lotCode : undefined;
    if (lotCode === undefined || lotCode.trim().length === 0) {
      featureErrors.push({
        featureIndex: idx,
        reason: "Missing or empty `lotCode`.",
      });
      return;
    }
    const polygonRaw = obj.polygon;
    if (!Array.isArray(polygonRaw)) {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: "`polygon` must be an array of {lat,lng} objects.",
      });
      return;
    }
    const polygon: ParsedLatLng[] = [];
    let polygonInvalidAt: number | null = null;
    polygonRaw.forEach((vertex, vidx) => {
      const parsed = parseLatLngObject(vertex);
      if (parsed === null) {
        if (polygonInvalidAt === null) polygonInvalidAt = vidx;
        return;
      }
      polygon.push(parsed);
    });
    if (polygonInvalidAt !== null) {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: `Polygon vertex ${polygonInvalidAt} is not a valid {lat,lng} object.`,
      });
      return;
    }

    const out: ParsedImportItem = { lotCode, polygon };
    if (obj.centroid !== undefined) {
      const centroid = parseLatLngObject(obj.centroid);
      if (centroid === null) {
        featureErrors.push({
          featureIndex: idx,
          lotCode,
          reason: "`centroid` is not a valid {lat,lng} object.",
        });
        return;
      }
      out.centroid = centroid;
    }
    items.push(out);
  });

  return { items, featureErrors, format: "native" };
}

function parseGeoJsonShape(raw: {
  type: "FeatureCollection";
  features: unknown[];
}): ParseResult {
  const items: ParsedImportItem[] = [];
  const featureErrors: ParseFeatureError[] = [];

  raw.features.forEach((feature, idx) => {
    if (feature === null || typeof feature !== "object") {
      featureErrors.push({
        featureIndex: idx,
        reason: "Feature is not an object.",
      });
      return;
    }
    const f = feature as Record<string, unknown>;
    const properties =
      f.properties !== null && typeof f.properties === "object"
        ? (f.properties as Record<string, unknown>)
        : undefined;
    const lotCode =
      properties && typeof properties.lotCode === "string"
        ? properties.lotCode
        : undefined;
    if (lotCode === undefined || lotCode.trim().length === 0) {
      featureErrors.push({
        featureIndex: idx,
        reason: "Feature is missing `properties.lotCode`.",
      });
      return;
    }

    const geometry =
      f.geometry !== null && typeof f.geometry === "object"
        ? (f.geometry as Record<string, unknown>)
        : undefined;
    if (geometry === undefined) {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: "Feature is missing `geometry`.",
      });
      return;
    }
    if (geometry.type !== "Polygon") {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: `Unsupported geometry type "${String(
          geometry.type,
        )}". Only "Polygon" is accepted (no MultiPolygon).`,
      });
      return;
    }
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: "Feature `geometry.coordinates` must be a non-empty array of rings.",
      });
      return;
    }
    const outerRing = coordinates[0];
    if (!Array.isArray(outerRing)) {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: "Feature outer ring must be an array of [lng, lat] pairs.",
      });
      return;
    }

    const polygon: ParsedLatLng[] = [];
    let vertexInvalidAt: number | null = null;
    outerRing.forEach((pair: unknown, vidx: number) => {
      if (
        !Array.isArray(pair) ||
        pair.length < 2 ||
        typeof pair[0] !== "number" ||
        typeof pair[1] !== "number"
      ) {
        if (vertexInvalidAt === null) vertexInvalidAt = vidx;
        return;
      }
      polygon.push({ lat: pair[1] as number, lng: pair[0] as number });
    });
    if (vertexInvalidAt !== null) {
      featureErrors.push({
        featureIndex: idx,
        lotCode,
        reason: `Outer-ring vertex ${vertexInvalidAt} is not a valid [lng, lat] pair.`,
      });
      return;
    }

    // GeoJSON polygons close on the first vertex (last == first). Our
    // schema does NOT require the closing duplicate; trim it so
    // `validatePolygon`'s consecutive-duplicate check on the server
    // doesn't reject a textbook-compliant input. If the ring is open
    // (some surveyors deliver it that way), leave it alone.
    if (polygon.length >= 2) {
      const first = polygon[0]!;
      const last = polygon[polygon.length - 1]!;
      if (first.lat === last.lat && first.lng === last.lng) {
        polygon.pop();
      }
    }

    items.push({ lotCode, polygon });
  });

  return { items, featureErrors, format: "geojson" };
}

function parseLatLngObject(raw: unknown): ParsedLatLng | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.lat !== "number" || typeof obj.lng !== "number") return null;
  if (!Number.isFinite(obj.lat) || !Number.isFinite(obj.lng)) return null;
  return { lat: obj.lat, lng: obj.lng };
}

// ──────────────────────────────────────────────────────────────────────
// Story 8.1 (HIGH-fix) — CSV parser
// ──────────────────────────────────────────────────────────────────────

/**
 * Why a hand-rolled parser instead of `papaparse`:
 *
 * The brief is explicit — "no new npm deps" — and `papaparse` is not
 * already installed (verified against `package.json`). The CSV shape
 * we accept is intentionally narrow (no embedded newlines, no
 * Excel-style escapes inside quoted fields) so a 40-line parser does
 * the job with no supply-chain risk and no bundle weight.
 *
 * Accepted column layout (case-insensitive header match):
 *
 *   lotCode , lat       , lng       , polygonWKT
 *   D-5-12  , 14.6758   , 121.0398  , POLYGON((121.0398 14.6758, ...))
 *
 * - `lotCode` is required.
 * - `lat` + `lng` together form the optional centroid. Either both are
 *   present or both are omitted; one without the other is a row error.
 * - `polygonWKT` is required and uses standard OGC WKT polygon syntax
 *   (`POLYGON((lng lat, lng lat, ...))`). WKT is longitude-first —
 *   matching GeoJSON — so we flip on parse to land on our `{lat,lng}`
 *   schema. Only the outer ring is honoured (no holes — matching the
 *   GeoJSON branch's behaviour).
 *
 * Quoting: a field may be wrapped in `"..."`. Embedded double quotes
 * use `""` (Excel convention). Embedded newlines are NOT supported —
 * a WKT polygon does not need them; if a surveyor's tool emits them
 * the surveyor must re-export.
 */
function parseCsvShape(text: string): ParseResult {
  const lines = splitCsvLines(text);
  if (lines.length === 0) {
    throw new GpsImportParseError("INVALID_CSV", "CSV is empty.");
  }
  const headerCells = parseCsvLine(lines[0]!).map((c) =>
    c.trim().toLowerCase(),
  );
  const lotCodeIdx = headerCells.indexOf("lotcode");
  const latIdx = headerCells.indexOf("lat");
  const lngIdx = headerCells.indexOf("lng");
  const wktIdx = headerCells.indexOf("polygonwkt");
  if (lotCodeIdx === -1) {
    throw new GpsImportParseError(
      "INVALID_CSV",
      "CSV header is missing a `lotCode` column.",
    );
  }
  // `polygonWKT` is OPTIONAL. A row may instead carry just `lat`/`lng`
  // (a centre point) and we auto-generate a small footprint around it —
  // the "centre-point only" path. Only `lotCode` is a hard-required column.

  const items: ParsedImportItem[] = [];
  const featureErrors: ParseFeatureError[] = [];

  for (let row = 1; row < lines.length; row++) {
    const line = lines[row]!;
    if (line.trim().length === 0) continue;
    const cells = parseCsvLine(line);
    const lotCodeRaw =
      cells[lotCodeIdx] !== undefined ? cells[lotCodeIdx]!.trim() : "";
    if (lotCodeRaw.length === 0) {
      featureErrors.push({
        featureIndex: row - 1,
        reason: "Missing or empty `lotCode`.",
      });
      continue;
    }

    // Optional centre point (lat,lng) — supply both or neither.
    let centroid: ParsedLatLng | undefined;
    if (latIdx !== -1 || lngIdx !== -1) {
      const latStr =
        latIdx !== -1 && cells[latIdx] !== undefined
          ? cells[latIdx]!.trim()
          : "";
      const lngStr =
        lngIdx !== -1 && cells[lngIdx] !== undefined
          ? cells[lngIdx]!.trim()
          : "";
      if (latStr.length > 0 || lngStr.length > 0) {
        const lat = Number(latStr);
        const lng = Number(lngStr);
        if (
          latStr.length === 0 ||
          lngStr.length === 0 ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lng)
        ) {
          featureErrors.push({
            featureIndex: row - 1,
            lotCode: lotCodeRaw,
            reason: "Centroid `lat`/`lng` must both be present and numeric.",
          });
          continue;
        }
        centroid = { lat, lng };
      }
    }

    // Geometry: an explicit polygonWKT wins; otherwise auto-generate a
    // small footprint around the centre point.
    const wktRaw =
      wktIdx !== -1 && cells[wktIdx] !== undefined ? cells[wktIdx]!.trim() : "";
    let polygon: ParsedLatLng[];
    if (wktRaw.length > 0) {
      const parsed = parseWktPolygon(wktRaw);
      if (parsed === null) {
        featureErrors.push({
          featureIndex: row - 1,
          lotCode: lotCodeRaw,
          reason:
            "`polygonWKT` could not be parsed. Expected `POLYGON((lng lat, lng lat, ...))`.",
        });
        continue;
      }
      polygon = parsed;
    } else if (centroid !== undefined) {
      polygon = rectangleAround(centroid.lat, centroid.lng);
    } else {
      featureErrors.push({
        featureIndex: row - 1,
        lotCode: lotCodeRaw,
        reason:
          "Provide a `polygonWKT`, or `lat` & `lng` to auto-place the lot.",
      });
      continue;
    }

    const out: ParsedImportItem = { lotCode: lotCodeRaw, polygon };
    if (centroid !== undefined) {
      out.centroid = centroid;
    }
    items.push(out);
  }

  return { items, featureErrors, format: "csv" };
}

/**
 * Split a CSV body into logical lines. Strips an optional UTF-8 BOM
 * (Excel exports include one) and accepts CR / LF / CRLF separators.
 * Does NOT support newlines inside quoted fields — see the parser
 * JSDoc for the rationale.
 */
function splitCsvLines(text: string): string[] {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) {
    body = body.slice(1);
  }
  return body.split(/\r\n|\r|\n/);
}

/**
 * Parse a single CSV line into its cells. Handles double-quoted
 * fields (with `""` as an embedded literal quote). Bare commas inside
 * a quoted field are preserved; bare commas outside open new cells.
 */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      cells.push("");
      break;
    }
    const ch = line[i]!;
    if (ch === '"') {
      // Quoted field.
      let buf = "";
      i++;
      while (i < line.length) {
        const c = line[i]!;
        if (c === '"') {
          if (line[i + 1] === '"') {
            buf += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        buf += c;
        i++;
      }
      cells.push(buf);
      if (i < line.length && line[i] === ",") {
        i++;
        if (i === line.length) cells.push("");
      }
      continue;
    }
    // Unquoted field — read to next comma.
    let buf = "";
    while (i < line.length && line[i] !== ",") {
      buf += line[i]!;
      i++;
    }
    cells.push(buf);
    if (i < line.length && line[i] === ",") {
      i++;
      if (i === line.length) cells.push("");
    }
  }
  return cells;
}

/**
 * Parse a WKT `POLYGON((lng lat, lng lat, ...))` string into the
 * canonical `{lat,lng}` outer-ring shape. WKT is longitude-first
 * (matching GeoJSON); we flip to our schema's `{lat,lng}` here.
 *
 * Returns `null` on any parse failure. Only the outer ring is read —
 * holes (a second `(...)` group inside the polygon) are silently
 * ignored, matching the GeoJSON branch's policy.
 */
function parseWktPolygon(raw: string): ParsedLatLng[] | null {
  // Accept "POLYGON((...))" with optional whitespace; capture the
  // FIRST inner ring. Case-insensitive on the leading keyword.
  const match = raw.match(/^\s*polygon\s*\(\s*\(([^)]*)\)/i);
  if (match === null) return null;
  const inner = match[1]!.trim();
  if (inner.length === 0) return null;
  const pairs = inner.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  const polygon: ParsedLatLng[] = [];
  for (const pair of pairs) {
    const parts = pair.split(/\s+/);
    if (parts.length < 2) return null;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    polygon.push({ lat, lng });
  }
  // Strip the closing duplicate vertex that WKT requires — same
  // logic as the GeoJSON branch.
  if (polygon.length >= 2) {
    const first = polygon[0]!;
    const last = polygon[polygon.length - 1]!;
    if (first.lat === last.lat && first.lng === last.lng) {
      polygon.pop();
    }
  }
  if (polygon.length === 0) return null;
  return polygon;
}

/**
 * Default footprint (metres) used by the "centre-point only" import path.
 * A single-grave-sized rectangle — the centroid is the meaningful datum;
 * the footprint is just a sensible default box so the lot has a shape on
 * the map without surveying every corner. Replace later via a real
 * polygon import once corners are surveyed.
 */
const AUTO_FOOTPRINT_WIDTH_M = 1.0;
const AUTO_FOOTPRINT_DEPTH_M = 2.4;

/**
 * Build a small north-aligned rectangle centred on (lat, lng). The four
 * corners are symmetric about the centre, so the polygon's vertex-average
 * centroid equals the supplied point exactly — it sails through the
 * centroid-sanity check. Returns 4 distinct corners (no closing
 * duplicate; the schema doesn't require one).
 */
function rectangleAround(lat: number, lng: number): ParsedLatLng[] {
  const metersPerDegLat = 111320;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const metersPerDegLng = 111320 * (cosLat === 0 ? 1 : cosLat);
  const dLat = AUTO_FOOTPRINT_DEPTH_M / 2 / metersPerDegLat;
  const dLng = AUTO_FOOTPRINT_WIDTH_M / 2 / metersPerDegLng;
  return [
    { lat: lat - dLat, lng: lng - dLng },
    { lat: lat - dLat, lng: lng + dLng },
    { lat: lat + dLat, lng: lng + dLng },
    { lat: lat + dLat, lng: lng - dLng },
  ];
}
