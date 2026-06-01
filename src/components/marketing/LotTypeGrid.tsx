import {
  LotIllFamily,
  LotIllMausoleum,
  LotIllNiche,
  LotIllSingle,
} from "./LotIllustrations";
import type { LotType } from "./data";

const ILLUSTRATIONS: Record<LotType["id"], () => React.JSX.Element> = {
  single: LotIllSingle,
  family: LotIllFamily,
  mausoleum: LotIllMausoleum,
  niche: LotIllNiche,
};

/**
 * Four-up lot type grid used on the Home page (preview) and on the
 * Pricing page (selectable). The pricing variant adds gold-rule
 * accent on the selected card; the home variant is static.
 */
export function LotTypeGrid({
  lots,
  selectedId,
  onSelect,
}: {
  lots: ReadonlyArray<LotType>;
  selectedId?: LotType["id"];
  onSelect?: (id: LotType["id"]) => void;
}) {
  const interactive = typeof onSelect === "function";
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {lots.map((lt) => {
        const Ill = ILLUSTRATIONS[lt.id];
        const selected = selectedId === lt.id;
        const Cmp = interactive ? "button" : "div";
        return (
          <Cmp
            key={lt.id}
            type={interactive ? "button" : undefined}
            onClick={interactive ? () => onSelect?.(lt.id) : undefined}
            aria-pressed={interactive ? selected : undefined}
            className={[
              "flex flex-col gap-3 rounded border bg-surface-base p-6 text-left transition-colors",
              selected
                ? "border-t-[3px] border-accent-gold border-t-accent-gold"
                : "border-surface-border",
              interactive
                ? "cursor-pointer hover:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                : "",
            ].join(" ")}
          >
            <div className="flex h-20 items-center justify-center">
              <Ill />
            </div>
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-text-muted">
              {lt.tag}
            </div>
            <h3 className="font-display text-2xl font-light leading-tight text-text-default">
              {lt.name}
            </h3>
            <p className="text-sm leading-relaxed text-text-muted">
              {lt.summary}
            </p>
            <div className="mt-auto pt-2">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">
                From
              </div>
              <div className="mt-1 font-display text-3xl text-primary">
                {lt.priceFrom}
              </div>
            </div>
          </Cmp>
        );
      })}
    </div>
  );
}
