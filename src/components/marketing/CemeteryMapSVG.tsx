"use client";

/**
 * Stylized cemetery map preview — used on the Home page (decorative)
 * and the Find-a-Grave page (interactive).
 *
 * The plan itself — which gardens exist, where they sit, which lots
 * they hold and each lot's status — lives in `./cemetery-model`, shared
 * with the 3D view so the two cannot disagree. This file is only the
 * flat rendering of it.
 *
 * Real lot geometry lives in Convex (every lot doc carries a lat/lng
 * centroid + polygon vertices per ADR-0008). This brochure-side preview
 * is a hand-tuned wayfinding sketch only — see the model's header for
 * why, and what wiring it to live data would take.
 *
 * This SVG is the accessible view: every lot is a real element with a
 * label, reachable by keyboard. The 3D view is an enhancement on top,
 * not a replacement.
 */

import {
  type CemeterySectionPick,
  lotsOf,
  PLAN_COLORS,
  PLAN_HEIGHT,
  PLAN_WIDTH,
  SECTIONS,
  STATUS_COLOR,
} from "./cemetery-model";

export type { CemeterySectionPick };

const { emerald, gold, stone, moss, paper, ivoryDeep } = PLAN_COLORS;

export function CemeteryMapSVG({
  interactive = false,
  onSelect,
  selectedId,
}: {
  interactive?: boolean;
  onSelect?: (pick: CemeterySectionPick) => void;
  /** Lot code to mark as current, so the two views stay in step. */
  selectedId?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${PLAN_WIDTH} ${PLAN_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      role={interactive ? "img" : "presentation"}
      aria-label={
        interactive ? "Cemetery map — sections and lot grid" : undefined
      }
      className="block h-auto w-full"
    >
      <rect x="0" y="0" width={PLAN_WIDTH} height={PLAN_HEIGHT} fill={ivoryDeep} />
      <rect
        x="30"
        y="40"
        width="740"
        height="420"
        fill="none"
        stroke={gold}
        strokeWidth="1"
        strokeDasharray="3 5"
      />
      <line x1="30" y1="240" x2="770" y2="240" stroke={stone} strokeWidth="6" />
      <line x1="400" y1="40" x2="400" y2="460" stroke={stone} strokeWidth="4" />
      {[100, 200, 300, 500, 600, 700].map((x) => (
        <circle key={`t-${x}`} cx={x} cy="38" r="3" fill={moss} opacity="0.6" />
      ))}
      {[100, 200, 300, 500, 600, 700].map((x) => (
        <circle key={`b-${x}`} cx={x} cy="462" r="3" fill={moss} opacity="0.6" />
      ))}
      {SECTIONS.map((s) => (
        <g key={s.id}>
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            fill={paper}
            stroke={emerald}
            strokeWidth="0.8"
          />
          {lotsOf(s).map((lot) => {
            const isSelected = selectedId === lot.id;
            const fill =
              lot.status === "available" ? "transparent" : STATUS_COLOR[lot.status];
            const stroke =
              isSelected || lot.status === "available" ? emerald : "transparent";
            return (
              <rect
                key={lot.id}
                x={lot.x}
                y={lot.y}
                width={lot.w}
                height={lot.h}
                fill={fill}
                stroke={stroke}
                strokeWidth={isSelected ? "2.4" : "0.6"}
                style={interactive ? { cursor: "pointer" } : undefined}
                onClick={
                  interactive && onSelect
                    ? () =>
                        onSelect({
                          section: s.label,
                          id: lot.id,
                          status: lot.status,
                        })
                    : undefined
                }
                aria-label={
                  interactive
                    ? `Lot ${lot.id} in ${s.label}, ${lot.status}`
                    : undefined
                }
              />
            );
          })}
          <text
            x={s.x + s.w / 2}
            y={s.y - 6}
            textAnchor="middle"
            fontSize="9"
            fontFamily="var(--font-jetbrains-mono)"
            letterSpacing="0.16em"
            fill={emerald}
          >
            {s.label}
          </text>
        </g>
      ))}
      <g transform="translate(395, 470)">
        <circle r="6" fill={gold} />
        <text
          y="-14"
          textAnchor="middle"
          fontSize="9"
          fontFamily="var(--font-jetbrains-mono)"
          letterSpacing="0.16em"
          fill={emerald}
        >
          ENTRANCE
        </text>
      </g>
    </svg>
  );
}
