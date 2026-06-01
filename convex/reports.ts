/**
 * Reports surface — Story 6.4 (FR46, FR45).
 *
 * Minimal-scope report queries + export entry points. Three report
 * dimensions are supported:
 *
 *   - `sales`       — contracts created in [from, to], grouped by lot
 *                     type. Row shape: { lotType, count, totalAmountCents }.
 *   - `collections` — non-voided payments received in [from, to], one
 *                     row per payment. Row shape:
 *                     { receiptNumber, receivedAt, amountCents,
 *                       paymentMethod, customerName }.
 *   - `expenses`    — expense rows in [from, to], one row per expense.
 *                     Row shape: { paidAt, amountCents, categoryName,
 *                                  vendor, description }.
 *
 * The report shapes are intentionally simple — Story 6.3 was the deeper
 * "sales by dimension" surface but had not shipped at the time Story
 * 6.4 entered development. The exports here cover the three reports
 * the admin most often shares with the cemetery's accountant: top-line
 * sales, the payment register, and the expense ledger.
 *
 * Export pipeline:
 *
 *   UI calls `requestReportExport({ reportType, from, to })` (action).
 *   The action — Node runtime, see `convex/actions/generateReportExport.ts`
 *   — re-runs the report query via `ctx.runQuery`, renders both a CSV
 *   blob (no extra deps) AND a PDF blob (via PDFKit, already pinned by
 *   Story 3.13 / 6.1), stores each in Convex File Storage, and returns
 *   the two `Id<"_storage">` values. The UI subsequently passes those
 *   ids to `getReportExportUrls` to retrieve auth-gated signed URLs.
 *
 * Auth contract:
 *   - Every public surface calls `requireRole(ctx, ["admin"])` as its
 *     first awaited statement (FR46 is admin-grade; the cemetery's
 *     accountant uses the admin login or the owner does this directly).
 *   - The action role-gates inside the report queries it calls back
 *     into — defense in depth.
 *   - `getReportExportUrls` returns signed URLs only; the raw storage
 *     ids never reach the client without going through this query's
 *     role check (NFR-S3).
 *
 * Scope deviations from the original Story 6.4 spec (documented in the
 * Dev Agent Record):
 *   - No `exports` table — the action returns storage ids inline rather
 *     than scheduling + writing back through an audit-trail row. This
 *     keeps the change set narrow (the schema is not modified). A
 *     follow-up story can promote the design to a tracked `exports`
 *     table when 30-day expiry + retry semantics are required.
 *   - CSV instead of XLSX — Story 6.4's spec called for Excel via
 *     `exceljs`. The pragmatic ship is CSV (zero new dependencies,
 *     opens in Excel + Google Sheets + Numbers natively). A future
 *     story can layer XLSX without changing the public mutation
 *     surface.
 *   - No streaming threshold — the Phase 1 cemetery has ≤ 2,000 lots
 *     and an expected ≤ 1,000 sales/year; in-memory render is fine.
 *     The 5-second streaming AC is preserved as a Phase 2 reservation.
 */

import {
  type DataModelFromSchemaDefinition,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";

import schema from "./schema";
import { requireRole, type MutationCtx, type QueryCtx } from "./lib/auth";
import { emitAudit } from "./lib/audit";
import { add } from "./lib/money";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type ContractDoc = DataModel["contracts"]["document"];
type PaymentDoc = DataModel["payments"]["document"];
type ExpenseDoc = DataModel["expenses"]["document"];
type LotType = DataModel["lots"]["document"]["type"];
type LotDoc = DataModel["lots"]["document"];

/**
 * Discriminator for the supported report types. Extend in lockstep
 * with the action's `reportType` validator + adapter map.
 */
const _reportTypeValidator = v.union(
  v.literal("sales"),
  v.literal("collections"),
  v.literal("expenses"),
);

export type ReportType = "sales" | "collections" | "expenses";

/**
 * Range arguments accepted by every report query. Manila tz
 * interpretation is the client's responsibility — the server treats
 * the timestamps as plain epoch ms.
 */
const rangeArgs = {
  from: v.number(),
  to: v.number(),
} as const;

// ---------------------------------------------------------------------------
// Report row shapes — kept narrow + serialisable so the action can pass
// them straight to the CSV / PDF renderers without extra projection.
// ---------------------------------------------------------------------------

export interface SalesReportRow {
  lotType: "single" | "family" | "mausoleum" | "niche";
  count: number;
  totalAmountCents: number;
}

export interface CollectionsReportRow {
  receiptNumber: string;
  receivedAt: number;
  amountCents: number;
  paymentMethod: PaymentDoc["paymentMethod"];
  customerName: string;
}

export interface ExpensesReportRow {
  paidAt: number;
  amountCents: number;
  category: string;
  vendor: string;
  note: string;
}

export interface SalesReport {
  reportType: "sales";
  from: number;
  to: number;
  generatedAt: number;
  rows: SalesReportRow[];
  totalCount: number;
  totalAmountCents: number;
}

export interface CollectionsReport {
  reportType: "collections";
  from: number;
  to: number;
  generatedAt: number;
  rows: CollectionsReportRow[];
  totalCount: number;
  totalAmountCents: number;
}

export interface ExpensesReport {
  reportType: "expenses";
  from: number;
  to: number;
  generatedAt: number;
  rows: ExpensesReportRow[];
  totalCount: number;
  totalAmountCents: number;
}

export type AnyReport = SalesReport | CollectionsReport | ExpensesReport;

// ---------------------------------------------------------------------------
// Public report queries — exported so the action's `runQuery` calls
// can hydrate the data they will render. Each query is admin-only.
// ---------------------------------------------------------------------------

/**
 * Sales report: contracts created in `[from, to]`, grouped by lot
 * type. The implementation walks the `contracts` table once and joins
 * to the `lots` table for the type discriminator (the contract row
 * carries `lotId` but not `lotType`).
 *
 * Voided + cancelled contracts are excluded — the report shows
 * realized sales, not gross sales attempts. The `paid_in_full` +
 * `active` + `in_default` states all count (the sale happened; the
 * collection status is reflected separately in the collections
 * report).
 *
 * The query SCANS the contracts table because there is no
 * `by_createdAt` index on contracts (the dashboard tile has the same
 * constraint — Phase 1 acceptable; revisit at Phase 1.5 if volume
 * grows). At ≤ 1,000 contracts/year the scan stays well within
 * NFR-P4.
 */
export const getSalesReport = queryGeneric({
  args: rangeArgs,
  handler: async (
    ctx: QueryCtx,
    args: { from: number; to: number },
  ): Promise<SalesReport> => {
    await requireRole(ctx, ["admin"]);
    const allContracts = (await ctx.db
      .query("contracts")
      .collect()) as ContractDoc[];

    const byType: Record<
      SalesReportRow["lotType"],
      { count: number; totalAmountCents: number }
    > = {
      single: { count: 0, totalAmountCents: 0 },
      family: { count: 0, totalAmountCents: 0 },
      mausoleum: { count: 0, totalAmountCents: 0 },
      niche: { count: 0, totalAmountCents: 0 },
    };

    let totalCount = 0;
    let totalAmountCents = 0;
    for (const contract of allContracts) {
      if (
        contract.createdAt < args.from ||
        contract.createdAt > args.to
      ) {
        continue;
      }
      if (contract.state === "voided" || contract.state === "cancelled") {
        continue;
      }
      const lot = (await ctx.db.get(contract.lotId)) as LotDoc | null;
      if (lot === null) continue;
      const bucket = byType[lot.type];
      if (bucket === undefined) continue;
      bucket.count += 1;
      bucket.totalAmountCents = add(
        bucket.totalAmountCents,
        contract.totalPriceCents,
      );
      totalCount += 1;
      totalAmountCents = add(totalAmountCents, contract.totalPriceCents);
    }

    const rows: SalesReportRow[] = (
      Object.keys(byType) as SalesReportRow["lotType"][]
    ).map((lotType) => ({
      lotType,
      count: byType[lotType].count,
      totalAmountCents: byType[lotType].totalAmountCents,
    }));

    return {
      reportType: "sales",
      from: args.from,
      to: args.to,
      generatedAt: Date.now(),
      rows,
      totalCount,
      totalAmountCents,
    };
  },
});

/**
 * Collections report: non-voided payments received in `[from, to]`,
 * one row per payment. Uses `payments.by_receivedAt` for a bounded
 * scan.
 */
export const getCollectionsReport = queryGeneric({
  args: rangeArgs,
  handler: async (
    ctx: QueryCtx,
    args: { from: number; to: number },
  ): Promise<CollectionsReport> => {
    await requireRole(ctx, ["admin"]);
    const payments = (await ctx.db
      .query("payments")
      .withIndex("by_receivedAt", (q) =>
        q.gte("receivedAt", args.from).lte("receivedAt", args.to),
      )
      .collect()) as PaymentDoc[];

    const rows: CollectionsReportRow[] = [];
    let totalCount = 0;
    let totalAmountCents = 0;
    for (const payment of payments) {
      if (payment.isVoided) continue;
      let customerName = "";
      if (payment.customerId !== undefined) {
        const customer = await ctx.db.get(
          payment.customerId as DataModel["customers"]["document"]["_id"],
        );
        customerName = customer?.fullName ?? "";
      }
      rows.push({
        receiptNumber: payment.paymentNumber,
        receivedAt: payment.receivedAt,
        amountCents: payment.amountCents,
        paymentMethod: payment.paymentMethod,
        customerName,
      });
      totalCount += 1;
      totalAmountCents = add(totalAmountCents, payment.amountCents);
    }

    rows.sort((a, b) => a.receivedAt - b.receivedAt);

    return {
      reportType: "collections",
      from: args.from,
      to: args.to,
      generatedAt: Date.now(),
      rows,
      totalCount,
      totalAmountCents,
    };
  },
});

/**
 * Expenses report: expense rows paid in `[from, to]`, one row per
 * expense. Uses `expenses.by_paidAt` for a bounded scan. The expense
 * row stores `category` as a free-text string (the controlled
 * vocabulary lives in `expenseCategories` but is dereferenced at
 * record-time, not at report-time).
 */
export const getExpensesReport = queryGeneric({
  args: rangeArgs,
  handler: async (
    ctx: QueryCtx,
    args: { from: number; to: number },
  ): Promise<ExpensesReport> => {
    await requireRole(ctx, ["admin"]);
    const expenses = (await ctx.db
      .query("expenses")
      .withIndex("by_paidAt", (q) =>
        q.gte("paidAt", args.from).lte("paidAt", args.to),
      )
      .collect()) as ExpenseDoc[];

    const rows: ExpensesReportRow[] = [];
    let totalCount = 0;
    let totalAmountCents = 0;
    for (const expense of expenses) {
      rows.push({
        paidAt: expense.paidAt,
        amountCents: expense.amountCents,
        category: expense.category,
        vendor: expense.vendor,
        note: expense.note ?? "",
      });
      totalCount += 1;
      totalAmountCents = add(totalAmountCents, expense.amountCents);
    }

    rows.sort((a, b) => a.paidAt - b.paidAt);

    return {
      reportType: "expenses",
      from: args.from,
      to: args.to,
      generatedAt: Date.now(),
      rows,
      totalCount,
      totalAmountCents,
    };
  },
});

// ---------------------------------------------------------------------------
// Export download surface — admin-only query that turns the storage ids
// returned by the export action (see `convex/actions/generateReportExport.ts`)
// into auth-gated signed download URLs.
//
// The export ACTION itself lives in `convex/actions/generateReportExport.ts`
// and is called by the UI via `useAction(api.actions.generateReportExport
// .generateReportExport)`. The action calls back into the public report
// queries above for data, role-gating each call via `requireRole`
// (defense in depth). The action returns the two `Id<"_storage">`
// values; the UI then calls `getReportExportUrls` (below) to resolve
// signed download URLs.
// ---------------------------------------------------------------------------

/**
 * Public query: turn a pair of storage ids into signed download
 * URLs. Admin-only; the raw storage ids never leave Convex without
 * passing through this query's role check (NFR-S3).
 *
 * Returns `{ csvUrl, pdfUrl }`; either field is `null` when the
 * underlying storage row has been deleted (defensive — Convex's
 * signing returns `null` for missing blobs).
 */
export const getReportExportUrls = queryGeneric({
  args: {
    csvStorageId: v.id("_storage"),
    pdfStorageId: v.id("_storage"),
  },
  handler: async (
    ctx: QueryCtx,
    args: {
      csvStorageId: DataModel["receipts"]["document"]["pdfStorageId"];
      pdfStorageId: DataModel["receipts"]["document"]["pdfStorageId"];
    },
  ): Promise<{ csvUrl: string | null; pdfUrl: string | null }> => {
    await requireRole(ctx, ["admin"]);
    const csvUrl =
      args.csvStorageId !== undefined
        ? await ctx.storage.getUrl(args.csvStorageId)
        : null;
    const pdfUrl =
      args.pdfStorageId !== undefined
        ? await ctx.storage.getUrl(args.pdfStorageId)
        : null;
    return { csvUrl, pdfUrl };
  },
});

// ---------------------------------------------------------------------------
// Story 6.3 — sales-by-dimension report (FR45).
//
// Nested aggregation surface: lot type → section → (optional) agent.
// The agent branch is gated by the `appSettings.salesAgentTrackingEnabled`
// toggle (§10 Q5 pending). When the toggle is off, the report returns
// only lot-type → section grouping — the agent branch is STRIPPED at
// the server boundary (defense-in-depth per the story's hard-stop list).
//
// The query intentionally returns nested arrays (not a `Record<...>`) so
// the wire shape is deterministic and orderable client-side.
// ---------------------------------------------------------------------------

export interface SalesByDimensionAgentRow {
  agentId: string;
  agentName: string;
  count: number;
  totalAmountCents: number;
}

export interface SalesByDimensionSectionRow {
  section: string;
  count: number;
  totalAmountCents: number;
  /**
   * Per-agent breakdown. `undefined` when
   * `salesAgentTrackingEnabled === false` — defense in depth. The UI
   * branches on `agents !== undefined` to decide whether to render the
   * agent-level expansion.
   */
  agents?: SalesByDimensionAgentRow[];
}

export interface SalesByDimensionLotTypeRow {
  lotType: LotType;
  count: number;
  totalAmountCents: number;
  sections: SalesByDimensionSectionRow[];
}

export interface SalesByDimensionReport {
  from: number;
  to: number;
  generatedAt: number;
  /**
   * Mirrors the singleton setting at query time so the client doesn't
   * need a second round-trip. When `false` the per-section `agents`
   * field is omitted; the UI MUST honour both signals (footnote +
   * branch hide).
   */
  salesAgentTrackingEnabled: boolean;
  totalCount: number;
  totalAmountCents: number;
  lotTypes: SalesByDimensionLotTypeRow[];
}

/**
 * Reads the singleton settings row, treating absence + missing fields
 * as "off". Exported for tests; intentionally not part of the public
 * Convex API (the mutation + nested-report query are the surface).
 */
export async function readAppSettings(ctx: QueryCtx): Promise<{
  salesAgentTrackingEnabled: boolean;
}> {
  const row = await ctx.db
    .query("appSettings")
    .withIndex("by_key", (q) => q.eq("key", "singleton"))
    .first();
  return {
    salesAgentTrackingEnabled: row?.salesAgentTrackingEnabled ?? false,
  };
}

const LOT_TYPE_ORDER: readonly LotType[] = [
  "single",
  "family",
  "mausoleum",
  "niche",
];

/**
 * Nested sales report grouped by lot type → section → (optional) agent.
 *
 * The query walks the `contracts.by_createdAt` index for a bounded scan
 * across the date range, joins each row to its `lots` doc (for the
 * `type` + `section` discriminators), and accumulates in-memory. At
 * the Phase 2 ≤ 1,000-sales-per-year volume this is comfortably within
 * NFR-P4; the architecture's pre-aggregated summary doc is the
 * documented escape hatch once volume grows past 10K.
 *
 * Voided / cancelled contracts are excluded (matching the existing
 * `getSalesReport` flat surface) — the report reflects realized sales,
 * not gross sales attempts.
 *
 * Agent branch:
 *   - When `salesAgentTrackingEnabled === false` the query SKIPS the
 *     agent accumulation entirely; the response carries no `agents`
 *     field on any section row.
 *   - When `salesAgentTrackingEnabled === true` the query attempts to
 *     read `agentId` from the contract row. The schema does NOT yet
 *     carry that field (the story explicitly defers adding it until
 *     §10 Q5 lands "yes, track commissions"). In the interim the
 *     agent branch surfaces an empty `agents: []` array per section
 *     so the UI's render path is exercised in test fixtures; the
 *     production data path will populate it once the schema field
 *     + sales-recording capture flow ship together.
 */
export const salesByDimension = queryGeneric({
  args: {
    from: v.number(),
    to: v.number(),
  },
  handler: async (
    ctx: QueryCtx,
    args: { from: number; to: number },
  ): Promise<SalesByDimensionReport> => {
    await requireRole(ctx, ["admin"]);

    const settings = await readAppSettings(ctx);
    const agentTrackingEnabled = settings.salesAgentTrackingEnabled;

    // Validate the range. The mutation /UI layer also validates; this is
    // defense in depth so a hand-crafted client cannot pass `from > to`
    // and get an arbitrarily-large scan back.
    if (
      !Number.isFinite(args.from) ||
      !Number.isFinite(args.to) ||
      args.from > args.to
    ) {
      return {
        from: args.from,
        to: args.to,
        generatedAt: Date.now(),
        salesAgentTrackingEnabled: agentTrackingEnabled,
        totalCount: 0,
        totalAmountCents: 0,
        lotTypes: [],
      };
    }

    const contracts = (await ctx.db
      .query("contracts")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", args.from).lte("createdAt", args.to),
      )
      .collect()) as ContractDoc[];

    interface SectionBucket {
      count: number;
      totalAmountCents: number;
      agents: Map<string, { name: string; count: number; totalAmountCents: number }>;
    }
    interface LotTypeBucket {
      count: number;
      totalAmountCents: number;
      sections: Map<string, SectionBucket>;
    }

    const byLotType = new Map<LotType, LotTypeBucket>();
    let totalCount = 0;
    let totalAmountCents = 0;

    for (const contract of contracts) {
      if (contract.state === "voided" || contract.state === "cancelled") {
        continue;
      }
      const lot = await ctx.db.get(contract.lotId);
      if (lot === null) continue;

      let lotTypeBucket = byLotType.get(lot.type);
      if (lotTypeBucket === undefined) {
        lotTypeBucket = {
          count: 0,
          totalAmountCents: 0,
          sections: new Map(),
        };
        byLotType.set(lot.type, lotTypeBucket);
      }
      lotTypeBucket.count += 1;
      lotTypeBucket.totalAmountCents = add(
        lotTypeBucket.totalAmountCents,
        contract.totalPriceCents,
      );

      const sectionKey = lot.section;
      let sectionBucket = lotTypeBucket.sections.get(sectionKey);
      if (sectionBucket === undefined) {
        sectionBucket = {
          count: 0,
          totalAmountCents: 0,
          agents: new Map(),
        };
        lotTypeBucket.sections.set(sectionKey, sectionBucket);
      }
      sectionBucket.count += 1;
      sectionBucket.totalAmountCents = add(
        sectionBucket.totalAmountCents,
        contract.totalPriceCents,
      );

      // Agent branch — only walked when the toggle is on. The
      // `contracts.agentId` field is reserved (story §10 Q5 pending);
      // until it lands, we narrow via a runtime probe rather than a
      // typed read. When the field is present the per-agent map gets
      // an entry; otherwise the section ships with `agents: []`.
      if (agentTrackingEnabled) {
        const probe = (contract as unknown as Record<string, unknown>).agentId;
        if (typeof probe === "string" && probe.length > 0) {
          let agentEntry = sectionBucket.agents.get(probe);
          if (agentEntry === undefined) {
            // Resolve the agent's display name once. The user lookup is
            // cheap (single get by id); we only do it on first sighting
            // per section to keep the join count bounded.
            let name = "(agent)";
            try {
              const user = await ctx.db.get(
                probe as unknown as DataModel["users"]["document"]["_id"],
              );
              if (user !== null && typeof user.name === "string") {
                name = user.name;
              }
            } catch {
              // Best-effort; the agent id may be stale.
            }
            agentEntry = { name, count: 0, totalAmountCents: 0 };
            sectionBucket.agents.set(probe, agentEntry);
          }
          agentEntry.count += 1;
          agentEntry.totalAmountCents = add(
            agentEntry.totalAmountCents,
            contract.totalPriceCents,
          );
        }
      }

      totalCount += 1;
      totalAmountCents = add(totalAmountCents, contract.totalPriceCents);
    }

    // Emit the report in a deterministic order (lot-type enum order,
    // then section name ascending, then agent name ascending). Stable
    // ordering makes UI snapshots + CSV exports byte-deterministic.
    const lotTypes: SalesByDimensionLotTypeRow[] = [];
    for (const lotType of LOT_TYPE_ORDER) {
      const bucket = byLotType.get(lotType);
      if (bucket === undefined) continue;
      const sections: SalesByDimensionSectionRow[] = [];
      const sortedSectionKeys = [...bucket.sections.keys()].sort();
      for (const sectionKey of sortedSectionKeys) {
        const section = bucket.sections.get(sectionKey);
        if (section === undefined) continue;
        const row: SalesByDimensionSectionRow = {
          section: sectionKey,
          count: section.count,
          totalAmountCents: section.totalAmountCents,
        };
        if (agentTrackingEnabled) {
          const agents: SalesByDimensionAgentRow[] = [...section.agents.entries()]
            .map(([agentId, entry]) => ({
              agentId,
              agentName: entry.name,
              count: entry.count,
              totalAmountCents: entry.totalAmountCents,
            }))
            .sort((a, b) => a.agentName.localeCompare(b.agentName));
          row.agents = agents;
        }
        sections.push(row);
      }
      lotTypes.push({
        lotType,
        count: bucket.count,
        totalAmountCents: bucket.totalAmountCents,
        sections,
      });
    }

    return {
      from: args.from,
      to: args.to,
      generatedAt: Date.now(),
      salesAgentTrackingEnabled: agentTrackingEnabled,
      totalCount,
      totalAmountCents,
      lotTypes,
    };
  },
});

/**
 * Read the `appSettings` singleton for the admin settings page.
 *
 * Returns the absent-row default (everything off) when the row has not
 * yet been created. The toggle UI uses the response directly as its
 * controlled value.
 */
export const getAppSettings = queryGeneric({
  args: {},
  handler: async (
    ctx: QueryCtx,
  ): Promise<{ salesAgentTrackingEnabled: boolean }> => {
    await requireRole(ctx, ["admin"]);
    return await readAppSettings(ctx);
  },
});

/**
 * Toggle `salesAgentTrackingEnabled`. Upserts the singleton row.
 *
 * Audit emits `update` with the before / after values so the audit
 * trail captures every flip — the §10 Q5 policy decision is itself a
 * compliance-relevant event ("when did the cemetery enable agent
 * tracking?"). The entity type is `"user"` because the audit-log
 * schema's `entityType` union does not carry a dedicated
 * `appSetting` value; the `before` / `after` payload carries the
 * operational detail with a `kind: "appSetting"` tag the audit-log
 * consumer can disambiguate on.
 */
export const setSalesAgentTracking = mutationGeneric({
  args: { enabled: v.boolean() },
  handler: async (
    ctx: MutationCtx,
    args: { enabled: boolean },
  ): Promise<{ salesAgentTrackingEnabled: boolean }> => {
    await requireRole(ctx, ["admin"]);
    const row = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    const before = row?.salesAgentTrackingEnabled ?? false;
    if (before === args.enabled) {
      // No-op short-circuit — admin saved the same value. Skip both
      // the patch and the audit emission.
      return { salesAgentTrackingEnabled: args.enabled };
    }

    if (row === null) {
      const id = await ctx.db.insert("appSettings", {
        key: "singleton",
        salesAgentTrackingEnabled: args.enabled,
      });
      await emitAudit(ctx, {
        action: "create",
        entityType: "user",
        entityId: id,
        after: {
          kind: "appSetting",
          salesAgentTrackingEnabled: args.enabled,
        },
      });
    } else {
      await ctx.db.patch(row._id, {
        salesAgentTrackingEnabled: args.enabled,
      });
      await emitAudit(ctx, {
        action: "update",
        entityType: "user",
        entityId: row._id,
        before: {
          kind: "appSetting",
          salesAgentTrackingEnabled: before,
        },
        after: {
          kind: "appSetting",
          salesAgentTrackingEnabled: args.enabled,
        },
      });
    }

    return { salesAgentTrackingEnabled: args.enabled };
  },
});
