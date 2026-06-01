import type { Obituary } from "./data";

/**
 * Recent-interments list — dove icon + name + lifespan + section +
 * service kind + date. Used on Home (4 most recent) and News (full).
 *
 * Each row is a borderless reading-rule pattern (top rule on every
 * row, last row has the bottom rule). Names use Cormorant Garamond
 * at a slight italic to read as "memorial type".
 */
export function ObituaryList({
  items,
}: {
  items: ReadonlyArray<Obituary>;
}) {
  return (
    <ul className="divide-y divide-surface-border border-y border-surface-border">
      {items.map((o) => (
        <li
          key={`${o.name}-${o.date}`}
          className="grid grid-cols-[auto_1fr_auto] items-center gap-x-5 gap-y-1 px-1 py-5"
        >
          <span
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full border border-surface-border bg-surface-base text-primary"
          >
            <DoveGlyph />
          </span>
          <div>
            <div className="font-display text-2xl font-light italic text-text-default">
              {o.name}
            </div>
            <div className="mt-0.5 font-mono text-xs uppercase tracking-[0.14em] text-text-muted">
              {o.born} — {o.died} · {o.section}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm text-text-muted">{o.service}</div>
            <div className="mt-0.5 font-mono text-xs uppercase tracking-[0.14em] text-primary">
              {o.date}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DoveGlyph() {
  return (
    <svg viewBox="0 0 48 48" fill="none" width="28" height="28" aria-hidden>
      <path
        d="M22 18 Q14 22 14 28 Q14 34 22 34 Q28 34 30 28 Q30 22 26 20 Q24 18 22 18 Z"
        fill="currentColor"
      />
      <circle cx="28" cy="20" r="2.2" fill="currentColor" />
      <path d="M30 21 L34 22 L30 23 Z" fill="#C9A96B" />
      <path
        d="M16 30 L10 36 L14 34 L11 38 L17 34 Z"
        fill="currentColor"
      />
    </svg>
  );
}
