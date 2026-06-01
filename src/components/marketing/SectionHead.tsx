import { cn } from "@/lib/cn";

/**
 * Section header pattern — eyebrow → headline → gold hairline → lede.
 *
 * Reused across every brochure page so the typographic rhythm stays
 * identical from Home to Contact. Centered variant pulls the gold
 * hairline to a centered short rule; the default leans left with a
 * 64px left-justified rule.
 */
export function SectionHead({
  eyebrow,
  title,
  lede,
  center,
  as = "h2",
  className,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  center?: boolean;
  as?: "h1" | "h2";
  className?: string;
}) {
  const Heading = as;
  return (
    <div
      className={cn(
        center ? "mx-auto max-w-2xl text-center" : "max-w-2xl",
        className,
      )}
    >
      {eyebrow ? (
        <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-text-muted">
          {eyebrow}
        </div>
      ) : null}
      <Heading
        className={cn(
          "mt-4 font-display font-light tracking-tight text-text-default",
          as === "h1"
            ? "text-4xl leading-tight sm:text-5xl lg:text-6xl"
            : "text-3xl leading-tight sm:text-4xl",
        )}
      >
        {title}
      </Heading>
      <span
        aria-hidden
        className={cn(
          "mt-5 block h-px w-16 bg-accent-gold",
          center && "mx-auto",
        )}
      />
      {lede ? (
        <p
          className={cn(
            "mt-5 max-w-prose text-base leading-relaxed text-text-muted sm:text-lg",
            center && "mx-auto",
          )}
        >
          {lede}
        </p>
      ) : null}
    </div>
  );
}
