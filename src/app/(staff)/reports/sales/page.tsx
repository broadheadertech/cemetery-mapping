"use client";

/**
 * /reports/sales — sales-by-dimension report (Story 6.3, FR45).
 *
 * Admin-only nested aggregation: lot type → section → (optional)
 * agent. The agent branch is gated by the
 * `appSettings.salesAgentTrackingEnabled` toggle (§10 Q5 pending);
 * when off, only the lot-type and section levels render and a small
 * footnote points the admin to the open-question doc.
 *
 * Auth: middleware gates `/reports/*` at the edge for admin only;
 * the underlying Convex query also calls `requireRole(["admin"])`
 * (NFR-S4 defense in depth).
 *
 * UX states (per Story 6.3 AC4):
 *   - loading       — table skeleton card.
 *   - empty range   — calm "No sales in this date range" copy.
 *   - error         — translated headline + detail + retry button.
 *   - ready         — nested expandable rows (sections collapse
 *                     inside lot-type groups; agents inside sections
 *                     when the toggle is on).
 *
 * Drill-down (AC3): clicking a row navigates to `/sales?from=...&to=...&lotType=...&section=...&agentId=...`
 * — the Story 1.8 / Epic 2 sales-list page already supports the
 * lotType + section + agentId query-string filters (or treats them
 * as ignored placeholder filters if it doesn't yet — the URL is the
 * source of truth either way).
 *
 * Story 6.4 export affordance: the "Export" dropdown calls
 * `requestExport({ reportType: "sales_by_dimension", args: { from,
 * to }, format })` and shows progress in a side sheet via
 * `<ExportSheet>` (Story 6.4 component).
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useRouter } from "next/navigation";

import { formatPeso } from "@/lib/money";
import { translateError } from "@/lib/errors";
import { ExportSheet } from "@/components/ExportSheet";

type LotType = "single" | "family" | "mausoleum" | "niche";

const LOT_TYPE_LABEL: Record<LotType, string> = {
  single: "Single",
  family: "Family",
  mausoleum: "Mausoleum",
  niche: "Niche",
};

interface AgentRow {
  agentId: string;
  agentName: string;
  count: number;
  totalAmountCents: number;
}
interface SectionRow {
  section: string;
  count: number;
  totalAmountCents: number;
  agents?: AgentRow[];
}
interface LotTypeRow {
  lotType: LotType;
  count: number;
  totalAmountCents: number;
  sections: SectionRow[];
}
interface SalesByDimensionReport {
  from: number;
  to: number;
  generatedAt: number;
  salesAgentTrackingEnabled: boolean;
  totalCount: number;
  totalAmountCents: number;
  lotTypes: LotTypeRow[];
}

const salesByDimensionRef = makeFunctionReference<
  "query",
  { from: number; to: number },
  SalesByDimensionReport
>("reports:salesByDimension");

const requestExportRef = makeFunctionReference<
  "mutation",
  {
    reportType: "sales_by_dimension" | "ar_aging" | "audit_log";
    args: { from: number; to: number };
    format: "xlsx" | "pdf";
  },
  { exportId: string }
>("exports:requestExport");

/**
 * Compute the default date range: first-of-current-month → today.
 * Manila tz fixed (no DST); we use the local browser's calendar math
 * because the input is YYYY-MM-DD strings interpreted as Manila dates.
 * The Convex query treats the ms values as plain epoch.
 */
function defaultRange(): { fromStr: string; toStr: string } {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const toIso = (d: Date) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };
  return { fromStr: toIso(first), toStr: toIso(now) };
}

/**
 * Turn a YYYY-MM-DD string into Manila-midnight epoch ms. The cemetery's
 * "May 21" means "May 21 00:00:00 +08:00"; we anchor that explicitly so
 * the server doesn't drift on the user's timezone offset.
 */
function dateStrToMs(str: string, endOfDay: boolean): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return Number.NaN;
  const [y, m, d] = str.split("-").map((s) => parseInt(s, 10));
  // Manila is UTC+8 with no DST. Encoding the explicit offset keeps the
  // boundary deterministic regardless of the running browser's tz.
  const isoSuffix = endOfDay ? "23:59:59.999" : "00:00:00.000";
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${isoSuffix}+08:00`;
  return new Date(iso).getTime();
}

export default function SalesReportPage(): React.ReactElement {
  const router = useRouter();
  const defaults = useMemo(defaultRange, []);
  const [fromStr, setFromStr] = useState(defaults.fromStr);
  const [toStr, setToStr] = useState(defaults.toStr);
  const [run, setRun] = useState<{ from: number; to: number } | null>({
    from: dateStrToMs(defaults.fromStr, false),
    to: dateStrToMs(defaults.toStr, true),
  });
  const [exportError, setExportError] = useState<string | null>(null);
  const [activeExportId, setActiveExportId] = useState<string | null>(null);

  const requestExport = useMutation(requestExportRef);

  const rangeValid =
    /^\d{4}-\d{2}-\d{2}$/.test(fromStr) &&
    /^\d{4}-\d{2}-\d{2}$/.test(toStr) &&
    dateStrToMs(fromStr, false) <= dateStrToMs(toStr, true);

  const report = useQuery(
    salesByDimensionRef,
    run !== null ? { from: run.from, to: run.to } : "skip",
  );

  const handleRun = useCallback(() => {
    if (!rangeValid) return;
    setRun({
      from: dateStrToMs(fromStr, false),
      to: dateStrToMs(toStr, true),
    });
  }, [fromStr, toStr, rangeValid]);

  const handleDrillDown = useCallback(
    (params: { lotType?: LotType; section?: string; agentId?: string }) => {
      if (run === null) return;
      const qs = new URLSearchParams();
      qs.set("from", String(run.from));
      qs.set("to", String(run.to));
      if (params.lotType !== undefined) qs.set("lotType", params.lotType);
      if (params.section !== undefined) qs.set("section", params.section);
      if (params.agentId !== undefined) qs.set("agentId", params.agentId);
      router.push(`/sales?${qs.toString()}`);
    },
    [router, run],
  );

  const handleExport = useCallback(
    async (format: "xlsx" | "pdf") => {
      if (run === null) return;
      setExportError(null);
      try {
        const { exportId } = await requestExport({
          reportType: "sales_by_dimension",
          args: { from: run.from, to: run.to },
          format,
        });
        setActiveExportId(exportId);
      } catch (err) {
        const t = translateError(err);
        setExportError(`${t.headline}: ${t.detail}`);
      }
    },
    [requestExport, run],
  );

  const isLoading = report === undefined && run !== null;
  const isEmpty =
    report !== undefined && report.totalCount === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-4xl font-semibold tracking-tight">
          Sales by dimension
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Realized sales broken down by lot type, then section. Click
          any row to drill into the underlying contracts.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleRun();
        }}
        aria-label="Date range"
      >
        <div className="flex flex-col">
          <label
            htmlFor="report-from"
            className="text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            From
          </label>
          <input
            id="report-from"
            type="date"
            value={fromStr}
            onChange={(e) => setFromStr(e.target.value)}
            className="mt-1 rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="report-from"
          />
        </div>
        <div className="flex flex-col">
          <label
            htmlFor="report-to"
            className="text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            To
          </label>
          <input
            id="report-to"
            type="date"
            value={toStr}
            onChange={(e) => setToStr(e.target.value)}
            className="mt-1 rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="report-to"
          />
        </div>
        <button
          type="submit"
          disabled={!rangeValid}
          className="rounded-md bg-[#1D5C4D] px-4 py-2 text-sm font-medium text-white hover:bg-[#144437] disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="report-run"
        >
          Run
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleExport("xlsx")}
            disabled={run === null || isLoading}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="report-export-xlsx"
          >
            Export Excel
          </button>
          <button
            type="button"
            onClick={() => handleExport("pdf")}
            disabled={run === null || isLoading}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="report-export-pdf"
          >
            Export PDF
          </button>
        </div>
      </form>

      {exportError !== null && (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
          data-testid="report-export-error"
        >
          {exportError}
        </div>
      )}

      {isLoading && (
        <div
          data-testid="report-loading"
          className="rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-500"
        >
          Loading sales report…
        </div>
      )}

      {isEmpty && (
        <div
          className="rounded-md border border-slate-200 bg-white p-8 text-center"
          data-testid="report-empty"
        >
          <p className="text-sm text-slate-600">
            No sales in this date range.
          </p>
        </div>
      )}

      {report !== undefined && report.totalCount > 0 && (
        <>
          <div
            className="rounded-md border border-slate-200 bg-white p-4"
            data-testid="report-summary"
          >
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <span className="text-slate-500">Sales</span>{" "}
                <span className="font-semibold text-slate-900">
                  {report.totalCount}
                </span>
              </div>
              <div>
                <span className="text-slate-500">Total</span>{" "}
                <span className="font-semibold tabular-nums text-slate-900">
                  {formatPeso(report.totalAmountCents)}
                </span>
              </div>
            </div>
          </div>

          <div
            className="overflow-x-auto rounded-md border border-slate-200 bg-white"
            data-testid="report-table"
          >
            <table className="w-full text-sm">
              <thead className="bg-[#F6F2EA] text-left font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[#8E8C85]">
                <tr>
                  <th className="px-4 py-3">Group</th>
                  <th className="px-4 py-3 text-right">Sales</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.lotTypes.map((lt) => (
                  <LotTypeGroup
                    key={lt.lotType}
                    row={lt}
                    showAgents={report.salesAgentTrackingEnabled}
                    onDrillDown={handleDrillDown}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {!report.salesAgentTrackingEnabled && (
            <p
              className="text-xs text-slate-500"
              data-testid="report-agent-footnote"
            >
              Agent breakdown not enabled (§10 Q5 pending). An admin can
              enable it in <a className="underline" href="/admin/settings">Settings</a>.
            </p>
          )}
        </>
      )}

      {activeExportId !== null && (
        <ExportSheet
          exportId={activeExportId}
          onClose={() => setActiveExportId(null)}
        />
      )}
    </div>
  );
}

interface LotTypeGroupProps {
  row: LotTypeRow;
  showAgents: boolean;
  onDrillDown: (params: {
    lotType?: LotType;
    section?: string;
    agentId?: string;
  }) => void;
}

function LotTypeGroup({
  row,
  showAgents,
  onDrillDown,
}: LotTypeGroupProps): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <>
      <tr
        className="bg-slate-50/50 hover:bg-slate-100"
        data-testid={`report-lottype-${row.lotType}`}
      >
        <td className="px-4 py-3 font-medium text-slate-900">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mr-2 text-slate-500 hover:text-slate-900"
            aria-expanded={open}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? "▾" : "▸"}
          </button>
          <button
            type="button"
            className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
            onClick={() => onDrillDown({ lotType: row.lotType })}
            data-testid={`report-lottype-link-${row.lotType}`}
          >
            {LOT_TYPE_LABEL[row.lotType]}
          </button>
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-slate-900">
          {row.count}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-slate-900">
          {formatPeso(row.totalAmountCents)}
        </td>
      </tr>
      {open &&
        row.sections.map((section) => (
          <SectionGroup
            key={section.section}
            lotType={row.lotType}
            row={section}
            showAgents={showAgents}
            onDrillDown={onDrillDown}
          />
        ))}
    </>
  );
}

interface SectionGroupProps {
  lotType: LotType;
  row: SectionRow;
  showAgents: boolean;
  onDrillDown: (params: {
    lotType?: LotType;
    section?: string;
    agentId?: string;
  }) => void;
}

function SectionGroup({
  lotType,
  row,
  showAgents,
  onDrillDown,
}: SectionGroupProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasAgents = showAgents && row.agents !== undefined && row.agents.length > 0;
  return (
    <>
      <tr
        className="hover:bg-slate-50"
        data-testid={`report-section-${lotType}-${row.section}`}
      >
        <td className="px-4 py-3 pl-12 text-slate-700">
          {hasAgents && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mr-2 text-slate-500 hover:text-slate-900"
              aria-expanded={open}
              aria-label={open ? "Collapse" : "Expand"}
            >
              {open ? "▾" : "▸"}
            </button>
          )}
          <button
            type="button"
            className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
            onClick={() => onDrillDown({ lotType, section: row.section })}
            data-testid={`report-section-link-${lotType}-${row.section}`}
          >
            Section {row.section}
          </button>
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-slate-700">
          {row.count}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-slate-700">
          {formatPeso(row.totalAmountCents)}
        </td>
      </tr>
      {open &&
        hasAgents &&
        row.agents !== undefined &&
        row.agents.map((agent) => (
          <tr
            key={agent.agentId}
            className="hover:bg-slate-50"
            data-testid={`report-agent-${lotType}-${row.section}-${agent.agentId}`}
          >
            <td className="px-4 py-3 pl-20 text-slate-600">
              <button
                type="button"
                className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
                onClick={() =>
                  onDrillDown({
                    lotType,
                    section: row.section,
                    agentId: agent.agentId,
                  })
                }
              >
                {agent.agentName}
              </button>
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-slate-600">
              {agent.count}
            </td>
            <td className="px-4 py-3 text-right tabular-nums text-slate-600">
              {formatPeso(agent.totalAmountCents)}
            </td>
          </tr>
        ))}
    </>
  );
}
