"use client";

/**
 * Stylized cemetery map preview — used on the Home page (decorative)
 * and the Find-a-Grave page (interactive).
 *
 * Real lot geometry lives in Convex (every lot doc carries lat/lng
 * centroid + polygon vertices per the architecture brief). This
 * brochure-side preview is a hand-tuned wayfinding sketch only —
 * not a live map. When the Phase 2 Leaflet migration ships, the
 * Find-a-Grave page will swap the SVG for the same Leaflet surface
 * the staff app uses, with the same geometry it reads today.
 */

const EMERALD = "#1D5C4D";
const GOLD = "#C9A96B";
const STONE = "#B8B6AF";
const MOSS = "#4A8270";
const PAPER = "#FFFFFF";
const IVORY_DEEP = "#EDE7DA";

export type CemeterySectionPick = {
  section: string;
  id: string;
  status: "available" | "reserved" | "occupied";
};

type Section = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  lots: number;
};

const SECTIONS: ReadonlyArray<Section> = [
  { id: "A", x: 60, y: 80, w: 200, h: 140, label: "GARDEN OF GRACE", lots: 8 },
  { id: "B", x: 280, y: 80, w: 240, h: 140, label: "GARDEN OF FAITH", lots: 10 },
  { id: "C", x: 540, y: 80, w: 180, h: 140, label: "GARDEN OF HOPE", lots: 8 },
  {
    id: "D",
    x: 60,
    y: 260,
    w: 220,
    h: 160,
    label: "COLUMBARIUM EAST",
    lots: 12,
  },
  { id: "E", x: 300, y: 260, w: 240, h: 160, label: "GARDEN OF PEACE", lots: 10 },
  { id: "F", x: 560, y: 260, w: 160, h: 160, label: "MAUSOLEUM ROW", lots: 6 },
];

export function CemeteryMapSVG({
  interactive = false,
  onSelect,
}: {
  interactive?: boolean;
  onSelect?: (pick: CemeterySectionPick) => void;
}) {
  return (
    <svg
      viewBox="0 0 800 500"
      preserveAspectRatio="xMidYMid meet"
      role={interactive ? "img" : "presentation"}
      aria-label={
        interactive ? "Cemetery map — sections and lot grid" : undefined
      }
      className="block h-auto w-full"
    >
      <rect x="0" y="0" width="800" height="500" fill={IVORY_DEEP} />
      <rect
        x="30"
        y="40"
        width="740"
        height="420"
        fill="none"
        stroke={GOLD}
        strokeWidth="1"
        strokeDasharray="3 5"
      />
      <line x1="30" y1="240" x2="770" y2="240" stroke={STONE} strokeWidth="6" />
      <line x1="400" y1="40" x2="400" y2="460" stroke={STONE} strokeWidth="4" />
      {[100, 200, 300, 500, 600, 700].map((x) => (
        <circle key={`t-${x}`} cx={x} cy="38" r="3" fill={MOSS} opacity="0.6" />
      ))}
      {[100, 200, 300, 500, 600, 700].map((x) => (
        <circle key={`b-${x}`} cx={x} cy="462" r="3" fill={MOSS} opacity="0.6" />
      ))}
      {SECTIONS.map((s) => (
        <g key={s.id}>
          <rect
            x={s.x}
            y={s.y}
            width={s.w}
            height={s.h}
            fill={PAPER}
            stroke={EMERALD}
            strokeWidth="0.8"
          />
          {Array.from({ length: s.lots }).map((_, i) => {
            const cols = 4;
            const cw = (s.w - 20) / cols;
            const rh = 16;
            const cx = s.x + 10 + (i % cols) * cw;
            const cy = s.y + 18 + Math.floor(i / cols) * (rh + 4);
            const status: CemeterySectionPick["status"] =
              i % 5 === 0
                ? "occupied"
                : i % 7 === 0
                  ? "reserved"
                  : "available";
            const fill =
              status === "occupied"
                ? EMERALD
                : status === "reserved"
                  ? GOLD
                  : "transparent";
            const stroke = status === "available" ? EMERALD : "transparent";
            const lotId = `${s.id}-${100 + i}`;
            return (
              <rect
                key={i}
                x={cx}
                y={cy}
                width={cw - 4}
                height={rh}
                fill={fill}
                stroke={stroke}
                strokeWidth="0.6"
                style={interactive ? { cursor: "pointer" } : undefined}
                onClick={
                  interactive && onSelect
                    ? () =>
                        onSelect({ section: s.label, id: lotId, status })
                    : undefined
                }
                aria-label={
                  interactive
                    ? `Lot ${lotId} in ${s.label}, ${status}`
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
            fill={EMERALD}
          >
            {s.label}
          </text>
        </g>
      ))}
      <g transform="translate(395, 470)">
        <circle r="6" fill={GOLD} />
        <text
          y="-14"
          textAnchor="middle"
          fontSize="9"
          fontFamily="var(--font-jetbrains-mono)"
          letterSpacing="0.16em"
          fill={EMERALD}
        >
          ENTRANCE
        </text>
      </g>
    </svg>
  );
}
