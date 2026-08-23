"use client";

/**
 * `<LotImportPanel>` — admin-only legacy lot-inventory import.
 *
 * The workflow is deliberately three steps with a hard stop in the
 * middle, because the operator is loading the cemetery's entire
 * inventory from a spreadsheet nobody has fully read:
 *
 *   1. **Source** — pick the CSV (or paste it). Parsed in the browser
 *      so a wrong file or a missing column comes back instantly.
 *
 *   2. **Check** — runs `lotImport:previewLotBatch`, a QUERY, against
 *      the live database. It reports exactly what would be created,
 *      which rows fail and why, and which sections are unregistered.
 *      Nothing is written; a query cannot write. The operator reads
 *      this, fixes the spreadsheet, and re-checks as many times as it
 *      takes.
 *
 *   3. **Import** — only enabled after a successful check, and only
 *      while the checked file is still the loaded one. Runs
 *      `lotImport:importLotBatch` in chunks of 500.
 *
 * Chunking is transparent: a 2,000-row file is four sequential calls,
 * and the per-chunk reports are merged into one result. Sequential
 * rather than parallel on purpose — the duplicate-code check reads the
 * lots table, so two concurrent chunks carrying the same code could
 * both see "no existing lot" and both insert.
 *
 * Authorization is enforced server-side in `convex/lotImport.ts`
 * (`requireRole(["admin"])` on BOTH functions) and by middleware on
 * `/admin/*`. This component rendering is not what makes it safe.
 */

import { useMemo, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";
import { formatPeso } from "@/lib/money";
import {
  chunkRows,
  LotCsvParseError,
  LOT_CSV_TEMPLATE,
  type LotParseResult,
  parseLotCsv,
  type ParsedLotImportRow,
} from "@/lib/lotImportParse";

/** Mirrors `MAX_IMPORT_BATCH_SIZE` in the Convex module. */
const CHUNK_SIZE = 500;

// `type` rather than `interface` — `makeFunctionReference` constrains
// its generics to `Record<string, unknown>`, which interfaces do not
// satisfy without an index signature. Same note as `<GpsImportPanel>`.
type LotImportArgs = {
  rows: ParsedLotImportRow[];
  reason?: string;
};

type PreviewArgs = {
  rows: ParsedLotImportRow[];
};

type PlanEntry = {
  rowNumber: number;
  code: string;
  section: string;
  sectionLinked: boolean;
  status: string;
};

type ServerRowError = {
  rowNumber: number;
  code: string;
  reason:
    | "INVALID_INPUT"
    | "INVALID_TYPE"
    | "INVALID_STATUS"
    | "DUPLICATE_IN_FILE"
    | "DUPLICATE_IN_DB";
  details: string;
};

type ServerRowWarning = {
  rowNumber: number;
  code: string;
  reason: "SECTION_NOT_REGISTERED";
  details: string;
};

export type LotImportReport = {
  totalRows: number;
  created: number;
  plan: PlanEntry[];
  errors: ServerRowError[];
  warnings: ServerRowWarning[];
};

const previewLotBatchRef = makeFunctionReference<
  "query",
  PreviewArgs,
  LotImportReport
>("lotImport:previewLotBatch");

const importLotBatchRef = makeFunctionReference<
  "mutation",
  LotImportArgs,
  LotImportReport
>("lotImport:importLotBatch");

type Phase =
  | { kind: "idle" }
  | { kind: "parsed"; sourceLabel: string; parsed: LotParseResult }
  | { kind: "checking"; sourceLabel: string; parsed: LotParseResult }
  | {
      kind: "checked";
      sourceLabel: string;
      parsed: LotParseResult;
      report: LotImportReport;
    }
  | {
      kind: "importing";
      sourceLabel: string;
      parsed: LotParseResult;
      progress: { done: number; total: number };
    }
  | {
      kind: "done";
      sourceLabel: string;
      parsed: LotParseResult;
      report: LotImportReport;
    }
  | { kind: "error"; sourceLabel: string; message: string };

/** Merge per-chunk reports into the single report the operator reads. */
function mergeReports(reports: LotImportReport[]): LotImportReport {
  return reports.reduce<LotImportReport>(
    (acc, r) => ({
      totalRows: acc.totalRows + r.totalRows,
      created: acc.created + r.created,
      plan: [...acc.plan, ...r.plan],
      errors: [...acc.errors, ...r.errors],
      warnings: [...acc.warnings, ...r.warnings],
    }),
    { totalRows: 0, created: 0, plan: [], errors: [], warnings: [] },
  );
}

export function LotImportPanel() {
  const convex = useConvex();
  const importLotBatch = useMutation(importLotBatchRef);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const [pasted, setPasted] = useState("");

  const busy = phase.kind === "checking" || phase.kind === "importing";

  const loadText = (text: string, sourceLabel: string): void => {
    try {
      const parsed = parseLotCsv(text);
      setPhase({ kind: "parsed", sourceLabel, parsed });
    } catch (err) {
      const message =
        err instanceof LotCsvParseError || err instanceof Error
          ? err.message
          : "Could not read that file.";
      setPhase({ kind: "error", sourceLabel, message });
    }
  };

  const handleFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      loadText(await file.text(), file.name);
    } finally {
      e.target.value = ""; // allow re-selecting the same file
    }
  };

  const rowsToSend = (parsed: LotParseResult): ParsedLotImportRow[] =>
    parsed.rows;

  const handleCheck = async (): Promise<void> => {
    if (phase.kind !== "parsed" && phase.kind !== "checked") return;
    const { sourceLabel, parsed } = phase;
    const rows = rowsToSend(parsed);
    if (rows.length === 0) {
      setPhase({
        kind: "error",
        sourceLabel,
        message: "No readable rows in this file.",
      });
      return;
    }
    setPhase({ kind: "checking", sourceLabel, parsed });
    try {
      const reports: LotImportReport[] = [];
      for (const chunk of chunkRows(rows, CHUNK_SIZE)) {
        reports.push(await convex.query(previewLotBatchRef, { rows: chunk }));
      }
      setPhase({
        kind: "checked",
        sourceLabel,
        parsed,
        report: mergeReports(reports),
      });
    } catch (err) {
      setPhase({
        kind: "error",
        sourceLabel,
        message: translateError(err).detail,
      });
    }
  };

  const handleImport = async (): Promise<void> => {
    if (phase.kind !== "checked") return;
    const { sourceLabel, parsed } = phase;
    const chunks = chunkRows(rowsToSend(parsed), CHUNK_SIZE);
    setPhase({
      kind: "importing",
      sourceLabel,
      parsed,
      progress: { done: 0, total: chunks.length },
    });
    try {
      const reports: LotImportReport[] = [];
      let done = 0;
      for (const chunk of chunks) {
        // Sequential: the duplicate check reads the lots table, so
        // concurrent chunks could both miss the same new code.
        reports.push(
          await importLotBatch({
            rows: chunk,
            reason: reason.trim().length > 0 ? reason.trim() : undefined,
          }),
        );
        done += 1;
        setPhase({
          kind: "importing",
          sourceLabel,
          parsed,
          progress: { done, total: chunks.length },
        });
      }
      setPhase({
        kind: "done",
        sourceLabel,
        parsed,
        report: mergeReports(reports),
      });
    } catch (err) {
      setPhase({
        kind: "error",
        sourceLabel,
        message: translateError(err).detail,
      });
    }
  };

  const handleReset = (): void => {
    setPhase({ kind: "idle" });
    setReason("");
    setPasted("");
  };

  return (
    <div className="space-y-6">
      <SourcePanel
        onFileChange={handleFileChange}
        pasted={pasted}
        setPasted={setPasted}
        onPastedSubmit={() => loadText(pasted, "Pasted CSV")}
        disabled={busy}
      />

      {phase.kind === "error" && (
        <div
          role="alert"
          data-testid="lot-import-error"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <div className="font-medium">
            Could not process {phase.sourceLabel}
          </div>
          <div className="mt-1">{phase.message}</div>
          <button
            type="button"
            onClick={handleReset}
            className="mt-3 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
          >
            Start over
          </button>
        </div>
      )}

      {(phase.kind === "parsed" ||
        phase.kind === "checking" ||
        phase.kind === "checked" ||
        phase.kind === "importing") && (
        <FilePanel
          sourceLabel={phase.sourceLabel}
          parsed={phase.parsed}
          onCheck={handleCheck}
          checking={phase.kind === "checking"}
          disabled={busy}
        />
      )}

      {(phase.kind === "checked" || phase.kind === "importing") && (
        <ReviewPanel
          report={phase.kind === "checked" ? phase.report : null}
          reason={reason}
          setReason={setReason}
          onImport={handleImport}
          onReset={handleReset}
          progress={phase.kind === "importing" ? phase.progress : null}
        />
      )}

      {phase.kind === "done" && (
        <ResultPanel report={phase.report} onReset={handleReset} />
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
  // A blob URL rather than an <a href="data:…"> so the filename is
  // controlled and the CSV is not re-encoded.
  const templateUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return URL.createObjectURL(
      new Blob([LOT_CSV_TEMPLATE], { type: "text/csv" }),
    );
  }, []);

  return (
    <section className="rounded-md border border-slate-200 bg-white p-5">
      <h2 className="text-lg font-semibold text-slate-900">Source</h2>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        A CSV with one lot per row. Required columns:{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          code, section, block, row, type, width (m), depth (m), base price
        </code>
        . Header spelling is flexible — <em>Lot_Code</em>, <em>lot code</em>,
        and <em>code</em> all work. Prices are read as pesos.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">status</code>{" "}
        is optional and accepts{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          available
        </code>
        ,{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          reserved
        </code>
        , or{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
          occupied
        </code>
        . Blank means available. A lot recorded as <em>sold</em> in the old
        records imports as available — re-record the sale through the sale
        form so the contract and receipt exist.
      </p>

      {templateUrl.length > 0 && (
        <a
          href={templateUrl}
          download="lot-import-template.csv"
          className="mt-3 inline-block text-sm font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900"
        >
          Download a template CSV
        </a>
      )}

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="space-y-1">
          <label
            htmlFor="lot-import-file"
            className="block text-sm font-medium text-slate-700"
          >
            Upload file
          </label>
          <input
            id="lot-import-file"
            type="file"
            accept=".csv,text/csv"
            onChange={onFileChange}
            disabled={disabled}
            data-testid="lot-import-file-input"
            className="block text-sm text-slate-700 file:mr-3 file:rounded-md file:border file:border-slate-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 file:hover:bg-slate-50"
          />
          <p className="text-xs text-slate-500">.csv, exported from Excel.</p>
        </div>

        <div className="flex-1 space-y-1">
          <label
            htmlFor="lot-import-paste"
            className="block text-sm font-medium text-slate-700"
          >
            …or paste CSV
          </label>
          <textarea
            id="lot-import-paste"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={4}
            disabled={disabled}
            placeholder="code,section,block,row,type,widthM,depthM,basePricePhp&#10;A-01-01,Section A,1,1,single,2.5,1.2,45000"
            className="block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onPastedSubmit}
              disabled={disabled || pasted.trim().length === 0}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Read pasted CSV
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function FilePanel({
  sourceLabel,
  parsed,
  onCheck,
  checking,
  disabled,
}: {
  sourceLabel: string;
  parsed: LotParseResult;
  onCheck: () => void;
  checking: boolean;
  disabled: boolean;
}) {
  const totalValue = parsed.rows.reduce((sum, r) => sum + r.basePriceCents, 0);
  return (
    <section
      className="rounded-md border border-slate-200 bg-white p-5"
      data-testid="lot-import-file-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{sourceLabel}</h2>
        <span className="text-sm text-slate-600">
          {parsed.rows.length} readable row
          {parsed.rows.length === 1 ? "" : "s"} · {formatPeso(totalValue)} of
          base price
        </span>
      </div>

      {parsed.ignoredColumns.length > 0 && (
        <p className="mt-2 text-sm text-slate-600">
          Ignored column{parsed.ignoredColumns.length === 1 ? "" : "s"}:{" "}
          {parsed.ignoredColumns.join(", ")}. Owner and payment history are
          not imported — those are re-recorded through the sale form.
        </p>
      )}

      {parsed.errors.length > 0 && (
        <div
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="lot-import-parse-errors"
        >
          <div className="font-medium">
            {parsed.errors.length} row
            {parsed.errors.length === 1 ? "" : "s"} could not be read and will
            be skipped
          </div>
          <ul className="mt-1 space-y-0.5">
            {parsed.errors.slice(0, 10).map((e) => (
              <li key={`${e.lineNumber}-${e.code}`}>
                Line {e.lineNumber}
                {e.code.length > 0 ? ` (${e.code})` : ""}: {e.details}
              </li>
            ))}
          </ul>
          {parsed.errors.length > 10 && (
            <p className="mt-1">…and {parsed.errors.length - 10} more.</p>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onCheck}
        disabled={disabled || parsed.rows.length === 0}
        data-testid="lot-import-check"
        className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {checking ? "Checking…" : "Check against the database"}
      </button>
      <p className="mt-2 text-xs text-slate-500">
        The check writes nothing. It reports what would be created.
      </p>
    </section>
  );
}

function ReviewPanel({
  report,
  reason,
  setReason,
  onImport,
  onReset,
  progress,
}: {
  report: LotImportReport | null;
  reason: string;
  setReason: (v: string) => void;
  onImport: () => void;
  onReset: () => void;
  progress: { done: number; total: number } | null;
}) {
  if (report === null) {
    return (
      <section className="rounded-md border border-slate-200 bg-white p-5 text-sm text-slate-600">
        Importing… chunk {progress?.done ?? 0} of {progress?.total ?? 0}.
      </section>
    );
  }
  return (
    <section
      className="rounded-md border border-slate-200 bg-white p-5"
      data-testid="lot-import-review"
    >
      <h2 className="text-lg font-semibold text-slate-900">Check result</h2>
      <p className="mt-1 text-sm text-slate-600">
        <strong>{report.created}</strong> lot
        {report.created === 1 ? "" : "s"} would be created from{" "}
        {report.totalRows} row{report.totalRows === 1 ? "" : "s"}.
      </p>

      <ReportIssues report={report} />

      <div className="mt-4 space-y-1">
        <label
          htmlFor="lot-import-reason"
          className="block text-sm font-medium text-slate-700"
        >
          Batch label (recorded on every lot&rsquo;s audit entry)
        </label>
        <input
          id="lot-import-reason"
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Section A legacy migration, batch 1/4"
          className="block w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onImport}
          disabled={report.created === 0 || progress !== null}
          data-testid="lot-import-apply"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {progress !== null
            ? `Importing… ${progress.done}/${progress.total}`
            : `Import ${report.created} lot${report.created === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={progress !== null}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Start over
        </button>
      </div>
    </section>
  );
}

function ResultPanel({
  report,
  onReset,
}: {
  report: LotImportReport;
  onReset: () => void;
}) {
  return (
    <section
      className="rounded-md border border-emerald-300 bg-emerald-50 p-5"
      data-testid="lot-import-result"
    >
      <h2 className="text-lg font-semibold text-emerald-900">
        Imported {report.created} lot{report.created === 1 ? "" : "s"}
      </h2>
      <p className="mt-1 text-sm text-emerald-900">
        Each one carries an audit entry with the batch label. Geometry is
        placeholder until the GPS import runs.
      </p>

      <ReportIssues report={report} />

      <button
        type="button"
        onClick={onReset}
        className="mt-4 rounded-md border border-emerald-300 bg-white px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
      >
        Import another file
      </button>
    </section>
  );
}

/** Shared errors + warnings rendering for the review and result panels. */
function ReportIssues({ report }: { report: LotImportReport }) {
  if (report.errors.length === 0 && report.warnings.length === 0) return null;
  return (
    <div className="mt-3 space-y-3">
      {report.errors.length > 0 && (
        <div
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
          data-testid="lot-import-row-errors"
        >
          <div className="font-medium">
            {report.errors.length} row
            {report.errors.length === 1 ? "" : "s"} skipped
          </div>
          <ul className="mt-1 space-y-0.5">
            {report.errors.slice(0, 20).map((e) => (
              <li key={`${e.rowNumber}-${e.code}-${e.reason}`}>
                Line {e.rowNumber}
                {e.code.length > 0 ? ` (${e.code})` : ""}: {e.details}
              </li>
            ))}
          </ul>
          {report.errors.length > 20 && (
            <p className="mt-1">…and {report.errors.length - 20} more.</p>
          )}
        </div>
      )}

      {report.warnings.length > 0 && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          data-testid="lot-import-row-warnings"
        >
          <div className="font-medium">
            {report.warnings.length} row
            {report.warnings.length === 1 ? "" : "s"} with an unregistered
            section
          </div>
          <p className="mt-1">
            These import with the section name as free text. Register the
            section, then run the section backfill to attach the reference.
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.warnings.slice(0, 10).map((w) => (
              <li key={`${w.rowNumber}-${w.code}`}>
                Line {w.rowNumber} ({w.code}): {w.details}
              </li>
            ))}
          </ul>
          {report.warnings.length > 10 && (
            <p className="mt-1">…and {report.warnings.length - 10} more.</p>
          )}
        </div>
      )}
    </div>
  );
}
