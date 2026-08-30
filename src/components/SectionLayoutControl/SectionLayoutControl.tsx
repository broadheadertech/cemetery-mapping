"use client";

/**
 * How a garden is arranged on the 3D map.
 *
 * Columns across, rows deep. The map is a visual representation rather
 * than a survey: lots fill the grid in code order, so a lot's place on
 * screen is its place in that order and not where it stands in the
 * ground. Saying that plainly here is the difference between a tool
 * somebody trusts correctly and one they trust too much.
 *
 * The grid does not have to match the lot count. A garden of 28 lots
 * drawn 6 × 5 shows 28 of 30 cells filled, which is what most gardens
 * actually look like; the map draws what fits and leaves the rest as
 * turf.
 *
 * @gated-route-only — mounts on `/admin/sections`; middleware keeps
 * non-admins off the `/admin` family.
 */

import { useState, type ReactElement } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

const setLayoutRef = makeFunctionReference<
  "mutation",
  { sectionId: string; gridColumns: number; gridRows: number },
  { sectionId: string }
>("sections:setSectionLayout");

export interface SectionLayoutControlProps {
  sectionId: string;
  displayName: string;
  /** Null when nobody has set a layout — the map guesses one. */
  gridColumns: number | null;
  gridRows: number | null;
  /** Lots currently in the garden, so the fit can be shown. */
  lotCount: number;
}

export function SectionLayoutControl({
  sectionId,
  displayName,
  gridColumns,
  gridRows,
  lotCount,
}: SectionLayoutControlProps): ReactElement {
  const setLayout = useMutation(setLayoutRef);

  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState(String(gridColumns ?? ""));
  const [rows, setRows] = useState(String(gridRows ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = gridColumns !== null && gridRows !== null;
  const c = Number.parseInt(cols, 10);
  const r = Number.parseInt(rows, 10);
  const valid =
    Number.isInteger(c) && c >= 1 && c <= 40 &&
    Number.isInteger(r) && r >= 1 && r <= 40;
  const cells = valid ? c * r : 0;

  return (
    <div data-testid="section-layout" className="mt-2">
      <button
        type="button"
        data-testid="section-layout-toggle"
        onClick={() => {
          setError(null);
          setOpen((v) => !v);
        }}
        className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
      >
        {configured
          ? `Shape on the map: ${gridColumns} across × ${gridRows} deep`
          : "Shape on the map: not set"}
      </button>

      {!configured && (
        <p
          data-testid="section-layout-derived"
          className="mt-1 text-[11px] text-slate-500"
        >
          The map is guessing a shape for {displayName}. Set one and it
          draws the garden as it actually sits.
        </p>
      )}

      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-[11px] leading-snug text-slate-600">
            How many lots stand side by side, and how many rows the
            garden runs back. That is the shape the 3D map draws it in —
            nothing else about the lots changes.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">
                Lots side by side
              </span>
              <input
                value={cols}
                onChange={(e) => setCols(e.target.value)}
                inputMode="numeric"
                data-testid="section-layout-columns"
                className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-700">
                Rows deep
              </span>
              <input
                value={rows}
                onChange={(e) => setRows(e.target.value)}
                inputMode="numeric"
                data-testid="section-layout-rows"
                className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <button
              type="button"
              disabled={busy || !valid}
              data-testid="section-layout-save"
              onClick={() => {
                setBusy(true);
                setError(null);
                void setLayout({ sectionId, gridColumns: c, gridRows: r })
                  .then(() => setOpen(false))
                  .catch((e: unknown) => setError(messageOf(e)))
                  .finally(() => setBusy(false));
              }}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>

          {/*
            The numbers as a picture.

            "Six columns by five rows" is a sentence somebody has to
            translate before they can tell whether it matches the garden
            they are standing in. The squares are the same information
            with nothing to translate — and getting this wrong is
            invisible on the 3D map, because a garden drawn in the wrong
            shape looks exactly as confident as one drawn right.
          */}
          {valid && (
            <div data-testid="section-layout-preview" className="space-y-1.5">
              <div
                className="grid w-fit gap-[3px]"
                style={{
                  gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))`,
                }}
                aria-hidden="true"
              >
                {Array.from({ length: cells }, (_, i) => (
                  <span
                    key={i}
                    className={
                      i < lotCount
                        ? "h-3 w-3 rounded-[2px] bg-[#1D5C4D]"
                        : "h-3 w-3 rounded-[2px] border border-dashed border-slate-300"
                    }
                  />
                ))}
              </div>
              <p className="text-[11px] text-slate-500">
                Each square is a lot, filling left to right, front to
                back, in code order. Dashed squares are empty ground.
              </p>
            </div>
          )}

          {/* What the numbers mean for this garden, before committing. */}
          {valid && (
            <p
              data-testid="section-layout-fit"
              className="text-[11px] text-slate-600"
            >
              {cells} cells for {lotCount} lot{lotCount === 1 ? "" : "s"}.{" "}
              {cells >= lotCount
                ? `${cells - lotCount} will be turf.`
                : `${lotCount - cells} lot${lotCount - cells === 1 ? "" : "s"} will not be drawn — widen the grid to show them all.`}
            </p>
          )}

          <p className="text-[11px] leading-snug text-slate-500">
            Lots fill the grid in code order, so the codes are the
            arrangement. This is a visual representation, not a survey —
            a lot&rsquo;s place here is its place in that order, not
            where it stands in the ground.
          </p>

          {error !== null && (
            <p
              role="alert"
              data-testid="section-layout-error"
              className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-900"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The server's own words — it names the bound that was exceeded. */
function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const data = (error as { data?: { message?: unknown } }).data;
    if (typeof data?.message === "string" && data.message.length > 0) {
      return data.message;
    }
  }
  return "Something went wrong. Nothing was saved.";
}
