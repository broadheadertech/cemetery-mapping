/**
 * Sales agents, and what the park owes them.
 *
 * An agent is a record, not a login. A sale is credited to a name so
 * the park can answer "who sold this" and "what do we owe" — nobody
 * signs in as an agent and nothing here grants access to anything.
 *
 * Read `convex/lib/commission.ts` first; the rate arithmetic and the
 * earned-at rule live there and are tested there. This module is the
 * storage, the gate, and the payout list.
 *
 * Two rules run through it:
 *
 *   - Only an admin may create an agent or set a rate. Office staff
 *     attach an agent to a sale all day; a staffer who could also mint
 *     one and set its rate could route commission wherever they liked.
 *
 *   - A commission is DUE from collections, never from the sale. The
 *     park pays once the family has paid in far enough. That figure is
 *     derived on read rather than stored, so it cannot drift from the
 *     payments it is supposed to reflect.
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
import { ErrorCode, throwError } from "./lib/errors";
import {
  commissionStatus,
  MAX_COMMISSION_PERCENT,
  normaliseCommissionPercent,
  PLATFORM_AGENT_NAME,
  type CommissionState,
} from "./lib/commission";
import { readAppSettings } from "./reports";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type AgentId = DataModel["salesAgents"]["document"]["_id"];
type ContractId = DataModel["contracts"]["document"]["_id"];

const NAME_MIN = 2;
const NAME_MAX = 80;
const NOTES_MAX = 400;

// --- the register ------------------------------------------------------

export interface AgentRow {
  _id: AgentId;
  fullName: string;
  code?: string;
  phone?: string;
  email?: string;
  /** This agent's own rate. Absent means the park default applies. */
  commissionPercent?: number;
  notes?: string;
  /** The park itself. Earns nothing, cannot be retired or rated. */
  isSystem: boolean;
  isRetired: boolean;
}

export interface AgentList {
  agents: AgentRow[];
  /** The rate that applies when an agent has none of their own. */
  defaultCommissionPercent: number;
  /** Share of a contract that must be collected before payout. */
  earnedAtPercent: number;
}

/**
 * Every agent on the books.
 *
 * Office staff may read this — they pick an agent when recording a sale
 * — and the park's default rate comes with it so the desk can see what
 * will apply without a second call.
 */
export const listSalesAgents = queryGeneric({
  args: { includeRetired: v.optional(v.boolean()) },
  handler: async (
    ctx: QueryCtx,
    args: { includeRetired?: boolean },
  ): Promise<AgentList> => {
    await requireRole(ctx, ["admin", "office_staff"]);
    const settings = await readAppSettings(ctx);
    const rows = await ctx.db.query("salesAgents").collect();
    return {
      agents: rows
        .filter((r) => args.includeRetired === true || !r.isRetired)
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
        .map(toAgentRow),
      defaultCommissionPercent: settings.defaultCommissionPercent,
      earnedAtPercent: settings.commissionEarnedAtPercent,
    };
  },
});

export const createSalesAgent = mutationGeneric({
  args: {
    fullName: v.string(),
    code: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    commissionPercent: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      fullName: string;
      code?: string;
      phone?: string;
      email?: string;
      commissionPercent?: number;
      notes?: string;
    },
  ): Promise<{ agentId: AgentId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const fullName = args.fullName.trim();
    assertName(fullName);
    assertRate(args.commissionPercent);
    const notes = trimmedNotes(args.notes);
    const code = args.code?.trim().toUpperCase();

    if (code !== undefined && code.length > 0) {
      const clash = await ctx.db
        .query("salesAgents")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (clash !== null && !clash.isRetired) {
        throwError(
          ErrorCode.VALIDATION,
          `The code ${code} already belongs to ${clash.fullName}.`,
          { code },
        );
      }
    }

    const now = Date.now();
    const row: Record<string, unknown> = {
      fullName,
      fullNameLowercased: fullName.toLowerCase(),
      isRetired: false,
      createdAt: now,
      createdByUserId: auth.userId,
      updatedAt: now,
    };
    if (code !== undefined && code.length > 0) row.code = code;
    if (args.phone !== undefined && args.phone.trim().length > 0) {
      row.phone = args.phone.trim();
    }
    if (args.email !== undefined && args.email.trim().length > 0) {
      row.email = args.email.trim().toLowerCase();
    }
    if (args.commissionPercent !== undefined) {
      row.commissionPercent = args.commissionPercent;
    }
    if (notes !== undefined) row.notes = notes;

    const agentId = await ctx.db.insert("salesAgents", row as never);
    await emitAudit(ctx, {
      action: "create",
      entityType: "sales_agent",
      entityId: agentId,
      after: {
        fullName,
        code: code ?? null,
        commissionPercent: args.commissionPercent ?? null,
      },
      reason: `Sales agent ${fullName} added`,
    });

    return { agentId };
  },
});

export const updateSalesAgent = mutationGeneric({
  args: {
    agentId: v.id("salesAgents"),
    fullName: v.optional(v.string()),
    code: v.optional(v.string()),
    phone: v.optional(v.string()),
    email: v.optional(v.string()),
    commissionPercent: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx: MutationCtx,
    args: {
      agentId: AgentId;
      fullName?: string;
      code?: string;
      phone?: string;
      email?: string;
      commissionPercent?: number;
      notes?: string;
    },
  ): Promise<{ agentId: AgentId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.agentId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Sales agent not found.", {
        agentId: args.agentId,
      });
    }

    assertNotSystem(existing, "changed");

    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
      updatedByUserId: auth.userId,
    };
    if (args.fullName !== undefined) {
      const fullName = args.fullName.trim();
      assertName(fullName);
      patch.fullName = fullName;
      patch.fullNameLowercased = fullName.toLowerCase();
    }
    if (args.commissionPercent !== undefined) {
      assertRate(args.commissionPercent);
      patch.commissionPercent = args.commissionPercent;
    }
    if (args.code !== undefined) patch.code = args.code.trim().toUpperCase();
    if (args.phone !== undefined) patch.phone = args.phone.trim();
    if (args.email !== undefined) patch.email = args.email.trim().toLowerCase();
    if (args.notes !== undefined) patch.notes = trimmedNotes(args.notes) ?? "";

    await ctx.db.patch(args.agentId, patch as never);
    await emitAudit(ctx, {
      action: "update",
      entityType: "sales_agent",
      entityId: args.agentId,
      before: {
        fullName: existing.fullName,
        commissionPercent: existing.commissionPercent ?? null,
      },
      after: {
        fullName: (patch.fullName as string | undefined) ?? existing.fullName,
        commissionPercent:
          (patch.commissionPercent as number | undefined) ??
          existing.commissionPercent ??
          null,
      },
      // A rate change is the interesting one: it affects every sale
      // recorded from here on, and none of the ones already recorded.
      reason: `Sales agent ${existing.fullName} updated`,
    });

    return { agentId: args.agentId };
  },
});

/**
 * Retire an agent, or bring one back.
 *
 * Never a delete. Contracts point at agents, and a contract has to go
 * on saying who sold it long after the agent left the park.
 */
export const setSalesAgentRetired = mutationGeneric({
  args: { agentId: v.id("salesAgents"), isRetired: v.boolean() },
  handler: async (
    ctx: MutationCtx,
    args: { agentId: AgentId; isRetired: boolean },
  ): Promise<{ agentId: AgentId }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const existing = await ctx.db.get(args.agentId);
    if (existing === null) {
      throwError(ErrorCode.NOT_FOUND, "Sales agent not found.", {
        agentId: args.agentId,
      });
    }

    assertNotSystem(existing, "retired");

    await ctx.db.patch(args.agentId, {
      isRetired: args.isRetired,
      updatedAt: Date.now(),
      updatedByUserId: auth.userId,
    } as never);
    await emitAudit(ctx, {
      action: "update",
      entityType: "sales_agent",
      entityId: args.agentId,
      before: { isRetired: existing.isRetired },
      after: { isRetired: args.isRetired },
      reason: `Sales agent ${existing.fullName} ${
        args.isRetired ? "retired" : "reinstated"
      }`,
    });

    return { agentId: args.agentId };
  },
});

/** Set the park's standard rate and when a commission becomes payable. */
export const setCommissionPolicy = mutationGeneric({
  args: {
    defaultCommissionPercent: v.optional(v.number()),
    earnedAtPercent: v.optional(v.number()),
  },
  handler: async (
    ctx: MutationCtx,
    args: { defaultCommissionPercent?: number; earnedAtPercent?: number },
  ): Promise<{ ok: true }> => {
    await requireRole(ctx, ["admin"]);

    assertRate(args.defaultCommissionPercent);
    if (args.earnedAtPercent !== undefined) {
      if (
        !Number.isFinite(args.earnedAtPercent) ||
        args.earnedAtPercent < 0 ||
        args.earnedAtPercent > 100
      ) {
        throwError(
          ErrorCode.VALIDATION,
          "The collection threshold must be between 0 and 100 per cent.",
          { earnedAtPercent: args.earnedAtPercent },
        );
      }
    }

    const existing = await ctx.db
      .query("appSettings")
      .withIndex("by_key", (q) => q.eq("key", "singleton"))
      .first();

    const patch: Record<string, unknown> = {};
    if (args.defaultCommissionPercent !== undefined) {
      patch.defaultCommissionPercent = args.defaultCommissionPercent;
    }
    if (args.earnedAtPercent !== undefined) {
      patch.commissionEarnedAtPercent = args.earnedAtPercent;
    }

    if (existing === null) {
      await ctx.db.insert("appSettings", {
        key: "singleton",
        ...patch,
      } as never);
    } else {
      await ctx.db.patch(existing._id, patch as never);
    }

    await emitAudit(ctx, {
      action: "update",
      entityType: "sales_agent",
      entityId: "commission_policy",
      after: patch,
      reason: "Commission policy updated",
    });

    return { ok: true };
  },
});

// --- what the park owes ------------------------------------------------

export interface CommissionRow {
  contractId: ContractId;
  contractNumber: string;
  agentId: AgentId;
  agentName: string;
  customerName: string;
  lotCode: string;
  contractTotalCents: number;
  commissionCents: number;
  commissionPercent: number;
  state: CommissionState;
  collectedPercent: number;
  shortfallCents: number;
  message: string;
}

export interface CommissionLedger {
  rows: CommissionRow[];
  /** Payable right now, across every agent. */
  totalDueCents: number;
  /** Recorded but not yet collected far enough to pay. */
  totalNotDueCents: number;
  earnedAtPercent: number;
}

/**
 * Every commission the park has recorded, and where each one stands.
 *
 * Derived, not stored. Whether a commission is due depends on what has
 * been collected, and a stored flag would drift from the payments it is
 * meant to reflect the first time a payment was voided.
 *
 * Ordered due-first: the office is here to pay somebody.
 */
export const listCommissions = queryGeneric({
  args: {
    agentId: v.optional(v.id("salesAgents")),
    /** Only what is payable now. */
    dueOnly: v.optional(v.boolean()),
  },
  handler: async (
    ctx: QueryCtx,
    args: { agentId?: AgentId; dueOnly?: boolean },
  ): Promise<CommissionLedger> => {
    await requireRole(ctx, ["admin"]);

    const settings = await readAppSettings(ctx);
    const earnedAtPercent = settings.commissionEarnedAtPercent;

    const contracts = await ctx.db.query("contracts").collect();
    const rows: CommissionRow[] = [];
    let totalDueCents = 0;
    let totalNotDueCents = 0;

    for (const c of contracts) {
      if (c.salesAgentId === undefined) continue;
      // Every sale is attributed now, most of them to the platform. A
      // commission of nothing is not a commission, and letting those
      // through would bury the handful of real payables in a list of
      // the park's own sales.
      if ((c.commissionCents ?? 0) <= 0) continue;
      if (args.agentId !== undefined && c.salesAgentId !== args.agentId) {
        continue;
      }

      const paidCents = await sumCollected(ctx, c._id);
      const status = commissionStatus({
        contractState: c.state,
        contractTotalCents: c.totalPriceCents,
        paidCents,
        commissionCents: c.commissionCents ?? 0,
        earnedAtPercent,
        ...(c.commissionPaidOutAt !== undefined
          ? { paidOutAt: c.commissionPaidOutAt }
          : {}),
      });

      if (status.state === "due") totalDueCents += status.commissionCents;
      if (status.state === "not_due") {
        totalNotDueCents += status.commissionCents;
      }
      if (args.dueOnly === true && status.state !== "due") continue;

      const agent = await ctx.db.get(c.salesAgentId);
      const customer = await ctx.db.get(c.customerId);
      const lot = await ctx.db.get(c.lotId);

      rows.push({
        contractId: c._id,
        contractNumber: c.contractNumber,
        agentId: c.salesAgentId,
        agentName: agent?.fullName ?? "Unknown agent",
        customerName: customer?.fullName ?? "Unknown",
        lotCode: lot?.code ?? "—",
        contractTotalCents: c.totalPriceCents,
        commissionCents: status.commissionCents,
        commissionPercent: c.commissionPercent ?? 0,
        state: status.state,
        collectedPercent: status.collectedPercent,
        shortfallCents: status.shortfallCents,
        message: status.message,
      });
    }

    const order: Record<CommissionState, number> = {
      due: 0,
      not_due: 1,
      paid: 2,
      void: 3,
    };
    rows.sort(
      (a, b) =>
        order[a.state] - order[b.state] ||
        a.agentName.localeCompare(b.agentName) ||
        a.contractNumber.localeCompare(b.contractNumber),
    );

    return { rows, totalDueCents, totalNotDueCents, earnedAtPercent };
  },
});

/**
 * Mark a commission settled.
 *
 * Refuses one that is not due. The office cannot pay ahead of the
 * collections rule by clicking a button — that rule is the whole reason
 * the threshold exists, and a payout recorded early is indistinguishable
 * afterwards from one that was properly earned.
 */
export const markCommissionPaid = mutationGeneric({
  args: { contractId: v.id("contracts"), note: v.optional(v.string()) },
  handler: async (
    ctx: MutationCtx,
    args: { contractId: ContractId; note?: string },
  ): Promise<{ contractId: ContractId; commissionCents: number }> => {
    const auth = await requireRole(ctx, ["admin"]);

    const contract = await ctx.db.get(args.contractId);
    if (contract === null) {
      throwError(ErrorCode.NOT_FOUND, "Contract not found.", {
        contractId: args.contractId,
      });
    }
    if (contract.salesAgentId === undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "This sale has no agent, so there is no commission to pay.",
        { contractId: args.contractId },
      );
    }
    if (contract.commissionPaidOutAt !== undefined) {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        "This commission has already been paid out.",
        { contractId: args.contractId },
      );
    }

    const settings = await readAppSettings(ctx);
    const paidCents = await sumCollected(ctx, args.contractId);
    const status = commissionStatus({
      contractState: contract.state,
      contractTotalCents: contract.totalPriceCents,
      paidCents,
      commissionCents: contract.commissionCents ?? 0,
      earnedAtPercent: settings.commissionEarnedAtPercent,
    });

    if (status.state !== "due") {
      throwError(
        ErrorCode.INVARIANT_VIOLATION,
        status.message,
        {
          kind: "COMMISSION_NOT_DUE",
          contractId: args.contractId,
          state: status.state,
          shortfallCents: status.shortfallCents,
        },
      );
    }

    const now = Date.now();
    const patch: Record<string, unknown> = {
      commissionPaidOutAt: now,
      commissionPaidOutByUserId: auth.userId,
    };
    const note = args.note?.trim();
    if (note !== undefined && note.length > 0) patch.commissionPayoutNote = note;

    await ctx.db.patch(args.contractId, patch as never);
    await emitAudit(ctx, {
      action: "update",
      entityType: "contract",
      entityId: args.contractId as unknown as string,
      after: {
        commissionPaidOutAt: now,
        commissionCents: status.commissionCents,
        salesAgentId: contract.salesAgentId,
      },
      reason: `Commission paid out on ${contract.contractNumber}`,
    });

    return {
      contractId: args.contractId,
      commissionCents: status.commissionCents,
    };
  },
});

// --- helpers -----------------------------------------------------------

/**
 * What has actually been collected against a contract.
 *
 * Summed from `installments.paidCents`, the same source the interment
 * payment gate uses — that is where allocation lands, and allocation is
 * what decides how much of THIS contract is paid rather than how much
 * money the customer has handed over across everything they own.
 *
 * A full-payment contract has no instalment rows; it is paid in full by
 * construction, so its total counts.
 */
async function sumCollected(
  ctx: QueryCtx | MutationCtx,
  contractId: ContractId,
): Promise<number> {
  const installments = await ctx.db
    .query("installments")
    .withIndex("by_contract", (q) => q.eq("contractId", contractId))
    .collect();

  if (installments.length > 0) {
    return installments.reduce((t, i) => t + i.paidCents, 0);
  }

  const contract = await ctx.db.get(contractId);
  if (contract === null) return 0;
  return contract.state === "paid_in_full" ? contract.totalPriceCents : 0;
}

/**
 * The park's own agent row, made if it is not there yet.
 *
 * Created on demand rather than seeded, so a deployment that never
 * records a sale never grows a row it does not need, and an existing
 * park gets one the first time it sells something.
 *
 * Callers must be inside a mutation — a query cannot insert, which is
 * why attribution happens in the sale path and not in the list.
 */
export async function ensurePlatformAgent(
  ctx: MutationCtx,
  createdByUserId: DataModel["users"]["document"]["_id"],
): Promise<AgentId> {
  const existing = await ctx.db
    .query("salesAgents")
    .withIndex("by_isSystem", (q) => q.eq("isSystem", true))
    .first();
  if (existing !== null) return existing._id;

  const now = Date.now();
  return await ctx.db.insert("salesAgents", {
    fullName: PLATFORM_AGENT_NAME,
    fullNameLowercased: PLATFORM_AGENT_NAME.toLowerCase(),
    // Explicitly zero, not absent. Absent would fall through to the
    // park's default rate and have the park owing itself money.
    commissionPercent: 0,
    isSystem: true,
    isRetired: false,
    createdAt: now,
    createdByUserId,
    updatedAt: now,
  } as never);
}

/**
 * Refuse to change the park's own agent row.
 *
 * Clamping would be quieter and worse: a house agent silently carrying
 * a rate would have the park reporting money it owes to nobody, and
 * retiring it would leave every online sale unattributed.
 */
function assertNotSystem(
  agent: { isSystem?: boolean; fullName: string },
  verb: string,
): void {
  if (agent.isSystem !== true) return;
  throwError(
    ErrorCode.INVARIANT_VIOLATION,
    `"${agent.fullName}" is the park itself, not a person. It cannot be ${verb} — it is what a sale with no agent is credited to, and it never earns a commission.`,
    { kind: "SYSTEM_AGENT_IMMUTABLE" },
  );
}

function toAgentRow(row: DataModel["salesAgents"]["document"]): AgentRow {
  const out: AgentRow = {
    _id: row._id,
    fullName: row.fullName,
    isSystem: row.isSystem === true,
    isRetired: row.isRetired,
  };
  if (row.code !== undefined) out.code = row.code;
  if (row.phone !== undefined) out.phone = row.phone;
  if (row.email !== undefined) out.email = row.email;
  if (row.commissionPercent !== undefined) {
    out.commissionPercent = row.commissionPercent;
  }
  if (row.notes !== undefined) out.notes = row.notes;
  return out;
}

function assertName(name: string): void {
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    throwError(
      ErrorCode.VALIDATION,
      `Name must be between ${NAME_MIN} and ${NAME_MAX} characters.`,
    );
  }
}

/**
 * Refuse a rate that cannot be a policy.
 *
 * The pure module CLAMPS a wild rate so a bad stored value cannot
 * produce a wild payout; this REFUSES it at the boundary so nobody
 * types 500 and finds they quietly configured 50.
 */
function assertRate(value: number | undefined): void {
  if (value === undefined) return;
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_COMMISSION_PERCENT
  ) {
    throwError(
      ErrorCode.VALIDATION,
      `A commission rate must be between 0 and ${MAX_COMMISSION_PERCENT} per cent.`,
      { commissionPercent: value },
    );
  }
  if (normaliseCommissionPercent(value) !== value && value !== 0) {
    throwError(
      ErrorCode.VALIDATION,
      `A commission rate must be between 0 and ${MAX_COMMISSION_PERCENT} per cent.`,
      { commissionPercent: value },
    );
  }
}

function trimmedNotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > NOTES_MAX) {
    throwError(
      ErrorCode.VALIDATION,
      `Notes must be ${NOTES_MAX} characters or fewer.`,
    );
  }
  return trimmed;
}
