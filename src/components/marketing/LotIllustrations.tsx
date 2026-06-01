/**
 * Micro-illustrations for the four lot types in the brochure.
 *
 * Pure geometry — emerald rectangles + a gold base rule. No
 * hand-drawing, no photography (per the brand guide: "illustration-led,
 * never photographic for the lot types").
 */

const EMERALD = "#1D5C4D";
const GOLD = "#C9A96B";

export function LotIllSingle() {
  return (
    <svg viewBox="0 0 200 100" fill="none" className="h-20 w-full">
      <rect x="70" y="36" width="60" height="36" stroke={EMERALD} />
      <line
        x1="100"
        y1="36"
        x2="100"
        y2="72"
        stroke={EMERALD}
        strokeDasharray="2 4"
      />
      <line x1="50" y1="78" x2="150" y2="78" stroke={GOLD} />
    </svg>
  );
}

export function LotIllFamily() {
  return (
    <svg viewBox="0 0 200 100" fill="none" className="h-20 w-full">
      <rect x="40" y="36" width="120" height="36" stroke={EMERALD} />
      <line x1="70" y1="36" x2="70" y2="72" stroke={EMERALD} />
      <line x1="100" y1="36" x2="100" y2="72" stroke={EMERALD} />
      <line x1="130" y1="36" x2="130" y2="72" stroke={EMERALD} />
      <line x1="30" y1="78" x2="170" y2="78" stroke={GOLD} />
    </svg>
  );
}

export function LotIllMausoleum() {
  return (
    <svg viewBox="0 0 200 100" fill="none" className="h-20 w-full">
      <path d="M60 24 L100 12 L140 24" stroke={EMERALD} />
      <rect x="60" y="24" width="80" height="48" stroke={EMERALD} />
      <rect x="75" y="36" width="12" height="36" stroke={EMERALD} />
      <rect x="93" y="36" width="14" height="36" stroke={EMERALD} />
      <rect x="113" y="36" width="12" height="36" stroke={EMERALD} />
      <line x1="40" y1="78" x2="160" y2="78" stroke={GOLD} />
    </svg>
  );
}

export function LotIllNiche() {
  return (
    <svg viewBox="0 0 200 100" fill="none" className="h-20 w-full">
      <rect x="50" y="22" width="100" height="56" stroke={EMERALD} />
      {[0, 1, 2].flatMap((r) =>
        [0, 1, 2, 3].map((c) => (
          <rect
            key={`${r}-${c}`}
            x={56 + c * 22}
            y={28 + r * 18}
            width="18"
            height="14"
            stroke={EMERALD}
            strokeWidth="0.8"
          />
        )),
      )}
    </svg>
  );
}
