import Image from "next/image";
import { cn } from "@/lib/cn";

/**
 * Dove-within-laurel mark — the registered Apostle Paul figure.
 *
 * The canonical asset is `public/brand/mark.svg` (viewBox 0 0 600 535).
 * This wrapper sizes the mark, applies brand-correct framing and a
 * default `aria-label`, and keeps the mark in line with the type next
 * to it via `inline-flex`. The mark is decorative-by-default — set
 * `decorative={false}` (or pass an `aria-label`) when it stands alone
 * as the only thing announcing the institution.
 */
export function BrandMark({
  size = 56,
  className,
  decorative = true,
  label,
}: {
  size?: number;
  className?: string;
  decorative?: boolean;
  label?: string;
}) {
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <Image
        src="/brand/mark.svg"
        width={size}
        height={size}
        alt={
          decorative && !label
            ? ""
            : (label ?? "Apostle Paul Memorial Park")
        }
        aria-hidden={decorative && !label ? true : undefined}
        priority={size >= 80}
      />
    </span>
  );
}
