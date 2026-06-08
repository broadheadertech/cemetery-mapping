"use client";

/**
 * /ceremonies/calendar -- combined ceremony + interment calendar
 * (Story 7.5 AC5).
 *
 * Phase 1 surface: a list-style calendar over the next 90 days
 * (Manila tz), filterable by kind via `?kind=consecration|interment|all`.
 * The richer month-grid view from Story 7.3 stays at /interments/calendar
 * for the legacy interments-only view; the 308 redirect in next.config.ts
 * forwards bookmarks to this page when the user is heading here.
 *
 * Data sources:
 *   - `ceremonies:listCeremonies` -- the new table (consecrations +
 *     forward-compat memorials).
 *   - `interments:listInRange` -- the legacy interments table.
 *
 * Auth: (staff) layout's auth gate covers the route; both queries
 * enforce admin / office_staff / field_worker server-side.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

type KindFilter = "all" | "consecration" | "interment";

interface ListedCeremonyShape {
  ceremonyId: string;
  kind: "consecration" | "interment" | "memorial_anniversary";
  status: "scheduled" | "completed" | "cancelled";
  contractId: string;
  lotId: string;
  lotCode: string;
  scheduledAt: number;
  durationMinutes: number;
  chapelReserved: boolean;
  pathwayReserved: boolean;
  customerName: string;
  consultantName: string | undefined;
}

interface LegacyIntermentShape {
  intermentId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  occupantId: string;
  occupantName: string;
  lotId: string;
  lotCode: string;
  lotSection: string;
}

const listCeremoniesRef = makeFunctionReference<
  "query",
  {
    kindFilter?: "consecration" | "interment" | "memorial_anniversary";
    fromMs?: number;
    toMs?: number;
    includeCancelled?: boolean;
    limit?: number;
  },
  ListedCeremonyShape[]
>("ceremonies:listCeremonies");

const listIntermentsInRangeRef = makeFunctionReference<
  "query",
  { fromMs: number; toMs: number; includeCancelled?: boolean },
  LegacyIntermentShape[]
>("interments:listInRange");

function formatManila(ms: number): string {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  const h = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${mm}`;
}

export default function CeremonyCalendarPage() {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  // 90-day window centred on now -- 30 days back, 60 forward.
  const bounds = useMemo(() => {
    const now = Date.now();
    return {
      fromMs: now - 30 * 24 * 60 * 60 * 1000,
      toMs: now + 60 * 24 * 60 * 60 * 1000,
    };
  }, []);

  const ceremonies = useQuery(listCeremoniesRef, {
    fromMs: bounds.fromMs,
    toMs: bounds.toMs,
    kindFilter:
      kindFilter === "consecration"
        ? "consecration"
        : kindFilter === "interment"
          ? "interment"
          : undefined,
  });
  // Only fetch the legacy interments table when the filter allows it.
  const interments = useQuery(
    listIntermentsInRangeRef,
    kindFilter === "consecration"
      ? "skip"
      : { fromMs: bounds.fromMs, toMs: bounds.toMs },
  );

  type Row =
    | {
        kind: "ceremony";
        row: ListedCeremonyShape;
        sortKey: number;
      }
    | {
        kind: "interment-legacy";
        row: LegacyIntermentShape;
        sortKey: number;
      };

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (ceremonies !== undefined) {
      for (const c of ceremonies) {
        out.push({ kind: "ceremony", row: c, sortKey: c.scheduledAt });
      }
    }
    if (interments !== undefined) {
      for (const i of interments) {
        out.push({ kind: "interment-legacy", row: i, sortKey: i.scheduledAt });
      }
    }
    out.sort((a, b) => a.sortKey - b.sortKey);
    return out;
  }, [ceremonies, interments]);

  const isLoading =
    ceremonies === undefined ||
    (kindFilter !== "consecration" && interments === undefined);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-display text-4xl font-semibold tracking-tight">
            Ceremony calendar
          </h1>
          <p className="text-sm text-slate-600">
            Consecrations, interments, and memorials over the next 60 days.
          </p>
        </div>
        <Link
          href="/interments"
          className="inline-flex min-h-[44px] items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Interments list
        </Link>
      </header>

      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter by ceremony kind"
      >
        {(["all", "consecration", "interment"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kindFilter === k}
            onClick={() => setKindFilter(k)}
            className={`inline-flex min-h-[40px] items-center rounded-full px-4 py-2 text-sm font-medium ring-1 ${
              kindFilter === k
                ? "bg-amber-700 text-white ring-amber-700"
                : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
            }`}
          >
            {k === "all"
              ? "All"
              : k === "consecration"
                ? "Consecrations"
                : "Interments"}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        {isLoading ? (
          <div className="p-6 text-sm text-slate-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">
            No ceremonies scheduled in this window. The grounds are quiet.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200">
            {rows.map((entry) => {
              if (entry.kind === "ceremony") {
                const c = entry.row;
                const accent =
                  c.kind === "consecration"
                    ? "border-amber-400 bg-amber-50"
                    : c.kind === "interment"
                      ? "border-stone-400 bg-stone-50"
                      : "border-emerald-400 bg-emerald-50";
                return (
                  <li
                    key={`c-${c.ceremonyId}`}
                    className={`flex flex-wrap items-center gap-3 border-l-4 p-4 ${accent}`}
                  >
                    <div className="flex-1 space-y-1">
                      <div className="text-sm font-medium">
                        {c.kind === "consecration"
                          ? `Consecration · ${c.customerName}`
                          : c.kind === "interment"
                            ? `Interment · ${c.customerName}`
                            : `Memorial · ${c.customerName}`}
                      </div>
                      <div className="text-xs text-slate-600">
                        {formatManila(c.scheduledAt)} &middot;{" "}
                        {c.durationMinutes} min &middot; Lot {c.lotCode}
                        {c.chapelReserved ? " · Chapel" : ""}
                        {c.pathwayReserved ? " · Pathway" : ""}
                      </div>
                    </div>
                    <Link
                      href={`/ceremonies/${c.ceremonyId}`}
                      className="inline-flex min-h-[40px] items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Open
                    </Link>
                  </li>
                );
              }
              const i = entry.row;
              return (
                <li
                  key={`i-${i.intermentId}`}
                  className="flex flex-wrap items-center gap-3 border-l-4 border-stone-300 bg-stone-50 p-4"
                >
                  <div className="flex-1 space-y-1">
                    <div className="text-sm font-medium">
                      Interment · {i.occupantName}
                    </div>
                    <div className="text-xs text-slate-600">
                      {formatManila(i.scheduledAt)} &middot; Lot {i.lotCode}
                    </div>
                  </div>
                  <Link
                    href={`/interments/${i.intermentId}`}
                    className="inline-flex min-h-[40px] items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Open
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
