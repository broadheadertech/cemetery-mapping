"use client";

/**
 * `<GpsImportPanel>` — admin-only GPS-import workflow widget (Story 8.1).
 *
 * Renders three panels in sequence:
 *
 *   1. **Source picker** — file input (`accept=".json,.geojson"`) plus
 *      a textarea fallback for pasted JSON. The surveyor's deliverable
 *      is usually a `.geojson` from QGIS / ArcGIS; the textarea path
 *      exists so admins can paste a small ad-hoc correction without
 *      going through the file system.
 *
 *   2. **Preview** — once a payload parses, the component shows a
 *      one-row-per-item summary: `lotCode`, vertex count, format
 *      detected, and any per-feature parse errors. The admin chooses
 *      whether to enable `force` (overwrite already-surveyed lots) and
 *      enters an optional `reason` (propagates to each audit row).
 *
 *   3. **Result** — after the mutation runs, the component renders the
 *      server's `{ updated, skippedAlreadySurveyed, errors }` summary.
 *      Errors are grouped by reason so the surveyor sees the action
 *      they need to take (re-survey vs. correct a typo'd lot code).
 *
 * The component does NOT chunk the import across multiple mutation
 * calls in this version — the per-call cap of 500 items is plenty for
 * Phase 2's initial import sweep (the typical deliverable is one
 * section at a time, ~200 lots). When a larger sweep is needed, the
 * surveyor splits the file; chunking-on-the-client can be a follow-up
 * (Story 8.1.x) without changing the server contract.
 *
 * The component MUST be wrapped in the staff layout (which enforces
 * the `admin` role at the middleware level). The server mutation
 * additionally checks `requireRole(["admin"])`, so a non-admin who
 * somehow renders this panel still cannot submit.
 */

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

import {
  GpsImportParseError,
  parseGpsBatch,
  type ParsedImportItem,
  type ParseFeatureError,
  type ParseResult,
} from "./parser";

// NOTE: these are `type` aliases rather than `interface` declarations
// because Convex's `makeFunctionReference` constrains its `Args` and
// `Ret` generics to `Record<string, unknown>`. TypeScript implicitly
// widens object-literal `type`s to satisfy that constraint, but
// `interface`s carry their own nominal identity and require an
// explicit index signature — which would pollute every other consumer
// of these types. Keep the shapes as `type` aliases.

type ImportGpsBatchArgs = {
  items: ParsedImportItem[];
  force?: boolean;
  reason?: string;
};

type ImportItemSkipped = {
  lotCode: string;
  reason: "ALREADY_SURVEYED";
  details: string;
};

type ImportItemError = {
  lotCode: string;
  reason: "NOT_FOUND" | "INVALID_POLYGON" | "INVALID_INPUT";
  details: string;
};

export type ImportGpsBatchResult = {
  totalItems: number;
  updated: number;
  skippedAlreadySurveyed: ImportItemSkipped[];
  errors: ImportItemError[];
};

// Convex codegen is intentionally absent from this repo (the team uses
// `makeFunctionReference` everywhere) — see the same pattern in
// `src/app/(staff)/admin/users/page.tsx`.
const importGpsBatchRef = makeFunctionReference<
  "mutation",
  ImportGpsBatchArgs,
  ImportGpsBatchResult
>("gpsImport:importGpsBatch");

type Status =
  | { kind: "idle" }
  | { kind: "parsing"; sourceLabel: string }
  | { kind: "parsed"; sourceLabel: string; parsed: ParseResult }
  | { kind: "submitting"; sourceLabel: string; parsed: ParseResult }
  | {
      kind: "done";
      sourceLabel: string;
      parsed: ParseResult;
      result: ImportGpsBatchResult;
    }
  | { kind: "error"; sourceLabel: string; message: string };

export function GpsImportPanel() {
  const importGpsBatch = useMutation(importGpsBatchRef);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState("");
  const [pasted, setPasted] = useState("");

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus({ kind: "parsing", sourceLabel: file.name });
    try {
      const text = await file.text();
      const parsed = parseGpsBatch(text);
      setStatus({ kind: "parsed", sourceLabel: file.name, parsed });
    } catch (err) {
      const message =
        err instanceof GpsImportParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown parse failure.";
      setStatus({ kind: "error", sourceLabel: file.name, message });
    } finally {
      // Allow re-selecting the same file.
      e.target.value = "";
    }
  };

  const handlePastedSubmit = (): void => {
    if (pasted.trim().length === 0) return;
    setStatus({ kind: "parsing", sourceLabel: "Pasted JSON" });
    try {
      const parsed = parseGpsBatch(pasted);
      setStatus({ kind: "parsed", sourceLabel: "Pasted JSON", parsed });
    } catch (err) {
      const message =
        err instanceof GpsImportParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown parse failure.";
      setStatus({ kind: "error", sourceLabel: "Pasted JSON", message });
    }
  };

  const handleRun = async (): Promise<void> => {
    if (status.kind !== "parsed") return;
    if (status.parsed.items.length === 0) return;
    setStatus({
      kind: "submitting",
      sourceLabel: status.sourceLabel,
      parsed: status.parsed,
    });
    try {
      const result = await importGpsBatch({
        items: status.parsed.items,
        force: force || undefined,
        reason: reason.trim().length > 0 ? reason.trim() : undefined,
      });
      setStatus({
        kind: "done",
        sourceLabel: status.sourceLabel,
        parsed: status.parsed,
        result,
      });
    } catch (err) {
      const translated = translateError(err);
      setStatus({
        kind: "error",
        sourceLabel: status.sourceLabel,
        message: translated.detail,
      });
    }
  };

  const handleReset = (): void => {
    setStatus({ kind: "idle" });
    setForce(false);
    setReason("");
    setPasted("");
  };

  return (
    <div className="space-y-6">
      <SourcePanel
        onFileChange={handleFileChange}
        pasted={pasted}
        setPasted={setPasted}
        onPastedSubmit={handlePastedSubmit}
        disabled={
          status.kind === "parsing" || status.kind === "submitting"
        }
      />

      {status.kind === "parsing" && (
        <div className="rounded-md border border-slate-200 bg-white p-4 text-sm text-slate-600">
          Parsing {status.sourceLabel}…
        </div>
      )}

      {status.kind === "error" && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
          data-testid="gps-import-error"
        >
          <div className="font-medium">
            Could not process {status.sourceLabel}
          </div>
          <div className="mt-1">{status.message}</div>
          <button
            type="button"
            onClick={handleReset}
            className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Start over
          </button>
        </div>
      )}

      {(status.kind === "parsed" || status.kind === "submitting") && (
        <PreviewPanel
          parsed={status.parsed}
          sourceLabel={status.sourceLabel}
          force={force}
          setForce={setForce}
          reason={reason}
          setReason={setReason}
          onRun={handleRun}
          onReset={handleReset}
          submitting={status.kind === "submitting"}
        />
      )}

      {status.kind === "done" && (
        <ResultPanel
          parsed={status.parsed}
          result={status.result}
          onReset={handleReset}
        />
      )}
    </div>
  );
}

function SourcePanel({
  onFileChange,
  pasted,
  setPasted,
  onPastedSubmit,
  disabled,
}: {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  pasted: string;
  setPasted: (v: string) => void;
  onPastedSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-900">Source</h2>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        Pick the surveyor&apos;s deliverable. The importer accepts GeoJSON
        FeatureCollection files (from QGIS or ArcGIS), native batch JSON
        of the shape{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          {`{ items: [{ lotCode, polygon }] }`}
        </code>
        , and CSV with columns{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          lotCode,lat,lng,polygonWKT
        </code>
        . Lots already marked surveyed are skipped by default.
      </p>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="space-y-1">
          <label
            htmlFor="gps-import-file"
            className="block text-sm font-medium text-slate-700"
          >
            Upload file
          </label>
          <input
            id="gps-import-file"
            type="file"
            accept=".json,.geojson,.csv,application/json,application/geo+json,text/csv"
            onChange={onFileChange}
            disabled={disabled}
            data-testid="gps-import-file-input"
            className="block text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 file:hover:bg-slate-50"
          />
          <p className="text-xs text-slate-500">
            .json, .geojson, or .csv, max ~10 MB.
          </p>
        </div>

        <div className="flex-1 space-y-1">
          <label
            htmlFor="gps-import-paste"
            className="block text-sm font-medium text-slate-700"
          >
            …or paste JSON
          </label>
          <textarea
            id="gps-import-paste"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={4}
            disabled={disabled}
            placeholder='{ "items": [{ "lotCode": "D-5-12", "polygon": [{"lat":14.6758,"lng":121.0398}, ...] }] }'
            className="block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onPastedSubmit}
              disabled={disabled || pasted.trim().length === 0}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Parse pasted JSON
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function PreviewPanel({
  parsed,
  sourceLabel,
  force,
  setForce,
  reason,
  setReason,
  onRun,
  onReset,
  submitting,
}: {
  parsed: ParseResult;
  sourceLabel: string;
  force: boolean;
  setForce: (v: boolean) => void;
  reason: string;
  setReason: (v: string) => void;
  onRun: () => void;
  onReset: () => void;
  submitting: boolean;
}) {
  const itemCount = parsed.items.length;
  const errorCount = parsed.featureErrors.length;
  const canRun = itemCount > 0 && !submitting;

  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Preview</h2>
          <p className="text-sm text-slate-600">
            Parsed {sourceLabel} as {parsed.format === "geojson"
              ? "GeoJSON FeatureCollection"
              : parsed.format === "csv"
                ? "CSV"
                : "native batch JSON"}
            . Ready to import: <strong>{itemCount}</strong> lot
            {itemCount === 1 ? "" : "s"}.
            {errorCount > 0 && (
              <>
                {" "}
                Skipped in parse:{" "}
                <strong data-testid="gps-import-parse-error-count">
                  {errorCount}
                </strong>
                .
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={submitting}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Start over
        </button>
      </header>

      {errorCount > 0 && (
        <FeatureErrorsList errors={parsed.featureErrors} />
      )}

      {itemCount > 0 && (
        <div
          className="mt-4 max-h-72 overflow-y-auto rounded-md border border-slate-200"
          data-testid="gps-import-preview-table"
        >
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Lot code</th>
                <th className="px-3 py-2">Vertices</th>
                <th className="px-3 py-2">Centroid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {parsed.items.map((item) => (
                <tr key={item.lotCode} className="hover:bg-slate-50">
                  <td className="px-3 py-2 font-medium text-slate-900">
                    {item.lotCode}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {item.polygon.length}
                  </td>
                  <td className="px-3 py-2 text-slate-500">
                    {item.centroid !== undefined
                      ? `${item.centroid.lat.toFixed(5)}, ${item.centroid.lng.toFixed(5)}`
                      : "(computed)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            disabled={submitting}
            data-testid="gps-import-force-checkbox"
            className="mt-0.5 h-4 w-4"
          />
          <span>
            <span className="font-medium">Overwrite surveyed lots</span>
            <span className="block text-xs text-slate-500">
              Re-applies geometry even when a lot is already marked
              surveyed. Use only for surveyor corrections.
            </span>
          </span>
        </label>
        <div className="space-y-1">
          <label
            htmlFor="gps-import-reason"
            className="block text-sm font-medium text-slate-700"
          >
            Reason (optional)
          </label>
          <input
            id="gps-import-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={submitting}
            placeholder="e.g. Initial GPS import 2026-05-19"
            className="block w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <p className="text-xs text-slate-500">
            Stored in the audit log for every lot this batch touches.
          </p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun}
          data-testid="gps-import-run-button"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Importing…" : `Import ${itemCount} lot${itemCount === 1 ? "" : "s"}`}
        </button>
      </div>
    </section>
  );
}

function FeatureErrorsList({ errors }: { errors: ParseFeatureError[] }) {
  return (
    <details className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
      <summary className="cursor-pointer font-medium text-amber-900">
        {errors.length} row{errors.length === 1 ? "" : "s"} failed to parse
      </summary>
      <ul className="mt-2 space-y-1 text-xs text-amber-900">
        {errors.map((err, idx) => (
          <li key={`${err.featureIndex}-${idx}`}>
            <span className="font-mono">
              #{err.featureIndex}
              {err.lotCode !== undefined ? ` (${err.lotCode})` : ""}
            </span>
            : {err.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ResultPanel({
  parsed,
  result,
  onReset,
}: {
  parsed: ParseResult;
  result: ImportGpsBatchResult;
  onReset: () => void;
}) {
  const errorsByReason = useMemo(() => {
    const map: Record<string, ImportItemError[]> = {};
    for (const err of result.errors) {
      if (!(err.reason in map)) map[err.reason] = [];
      map[err.reason]!.push(err);
    }
    return map;
  }, [result.errors]);

  return (
    <section
      className="rounded-md border border-emerald-200 bg-white p-5"
      data-testid="gps-import-result"
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Import complete
          </h2>
          <p className="text-sm text-slate-600">
            Submitted {result.totalItems} item
            {result.totalItems === 1 ? "" : "s"} from {parsed.format === "geojson"
              ? "the GeoJSON file"
              : parsed.format === "csv"
                ? "the CSV file"
                : "the native batch"}
            .
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Run another import
        </button>
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <ResultStat label="Updated" value={result.updated} tone="success" />
        <ResultStat
          label="Skipped (already surveyed)"
          value={result.skippedAlreadySurveyed.length}
          tone="neutral"
        />
        <ResultStat
          label="Errors"
          value={result.errors.length}
          tone={result.errors.length > 0 ? "warn" : "neutral"}
        />
        <ResultStat
          label="Total submitted"
          value={result.totalItems}
          tone="neutral"
        />
      </dl>

      {result.skippedAlreadySurveyed.length > 0 && (
        <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700">
            Skipped — already surveyed (
            {result.skippedAlreadySurveyed.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-700">
            {result.skippedAlreadySurveyed.map((s) => (
              <li key={`skip-${s.lotCode}`}>
                <span className="font-mono">{s.lotCode}</span> — {s.details}
              </li>
            ))}
          </ul>
        </details>
      )}

      {Object.entries(errorsByReason).map(([reason, errs]) => (
        <details
          key={reason}
          className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm"
          data-testid={`gps-import-errors-${reason}`}
        >
          <summary className="cursor-pointer font-medium text-red-900">
            {humanReason(reason)} ({errs.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs text-red-900">
            {errs.map((err, idx) => (
              <li key={`${err.lotCode}-${idx}`}>
                <span className="font-mono">{err.lotCode}</span> —{" "}
                {err.details}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function humanReason(reason: string): string {
  switch (reason) {
    case "NOT_FOUND":
      return "Unmatched lot codes";
    case "INVALID_POLYGON":
      return "Invalid polygon shape";
    case "INVALID_INPUT":
      return "Invalid input";
    default:
      return reason;
  }
}

function ResultStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "neutral" | "warn";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-red-700"
        : "text-slate-900";
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 text-2xl font-semibold ${toneClass}`}>
        {value}
      </dd>
    </div>
  );
}
