"use client";

/**
 * Who to credit this sale to.
 *
 * Optional, and blank is the right answer for a walk-in — most sales at
 * a small park have no agent, and a zero commission attached to nobody
 * is noise in every report that reads it.
 *
 * The rate shown is what WILL be frozen onto the contract. The server
 * resolves it again and is the authority; this is so the operator can
 * see what the park is about to owe before they commit to it, rather
 * than discovering it on the commissions screen a month later.
 *
 * @gated-route-only — renders inside `SaleForm` on `/sales/new`;
 * middleware keeps field workers off the `/sales` family.
 */

import { type ReactElement } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { formatPeso } from "@/lib/money";

interface AgentRow {
  _id: string;
  fullName: string;
  code?: string;
  commissionPercent?: number;
  isRetired: boolean;
}

interface AgentList {
  agents: AgentRow[];
  defaultCommissionPercent: number;
  earnedAtPercent: number;
}

const listAgentsRef = makeFunctionReference<
  "query",
  { includeRetired?: boolean },
  AgentList
>("salesAgents:listSalesAgents");

export interface AgentPickerProps {
  /** The chosen agent, or empty for none. */
  value: string;
  onChange: (agentId: string) => void;
  /** The contract total, so the commission can be previewed in pesos. */
  totalCents: number;
}

export function AgentPicker({
  value,
  onChange,
  totalCents,
}: AgentPickerProps): ReactElement {
  const list = useQuery(listAgentsRef, {});

  if (list === undefined || list === null) {
    return <p className="text-sm text-slate-500">Loading agents&hellip;</p>;
  }

  if (list.agents.length === 0) {
    return (
      <p data-testid="agent-picker-none" className="text-xs text-slate-500">
        No sales agents are on the books, so this sale carries no
        commission.
      </p>
    );
  }

  const chosen = list.agents.find((a) => a._id === value);
  // Mirrors `resolveCommissionPercent` on the server: the agent's own
  // rate, then the park's. A desk-agreed override is not offered here —
  // it belongs to a conversation an admin should be part of.
  const rate =
    chosen === undefined
      ? 0
      : (chosen.commissionPercent ?? list.defaultCommissionPercent);
  const commissionCents =
    rate > 0 && totalCents > 0 ? Math.round((totalCents * rate) / 100) : 0;

  return (
    <div className="space-y-1">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">
          Sold by
        </span>
        <select
          value={value}
          data-testid="agent-picker"
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="">Nobody — a walk-in</option>
          {list.agents.map((a) => (
            <option key={a._id} value={a._id}>
              {a.fullName}
              {a.code !== undefined ? ` (${a.code})` : ""}
            </option>
          ))}
        </select>
      </label>

      {chosen !== undefined && (
        <p data-testid="agent-picker-preview" className="text-xs text-slate-600">
          {rate > 0 ? (
            <>
              Commission {rate}% &mdash;{" "}
              <strong>{formatPeso(commissionCents)}</strong>, payable once
              the family has paid {list.earnedAtPercent}% of the contract.
            </>
          ) : (
            <>
              No rate is set for {chosen.fullName} or for the park, so
              this sale would carry no commission.
            </>
          )}
        </p>
      )}
    </div>
  );
}
