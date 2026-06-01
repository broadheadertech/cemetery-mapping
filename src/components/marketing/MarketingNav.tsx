"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { cn } from "@/lib/cn";

/**
 * Apostle Paul Memorial Park — public-site primary nav.
 *
 * The eight brochure links live in `NAV_ITEMS`. Active state matches
 * the current route (or `/` for the home link). The right-hand pair
 * is the cross-surface CTA: `Owner Portal` routes into the existing
 * customer-portal sign-in (Story 9.1), `Visit Us` jumps to the
 * contact page's schedule-a-visit form.
 *
 * Mobile: the link rail collapses behind a button at `md` and below.
 * The drawer renders as a vertical stack of the same items.
 */
const NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/", label: "Home" },
  { href: "/about", label: "Our Story" },
  { href: "/services", label: "Services" },
  { href: "/pricing", label: "Pricing" },
  { href: "/find-a-grave", label: "Find a Grave" },
  { href: "/plan-ahead", label: "Plan Ahead" },
  { href: "/resources", label: "Resources" },
  { href: "/news", label: "News" },
  { href: "/contact", label: "Contact" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MarketingNav() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-surface-border bg-surface-muted/95 backdrop-blur supports-[backdrop-filter]:bg-surface-muted/80">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="group flex shrink-0 items-center gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-muted"
        >
          <BrandMark size={42} />
          <span className="hidden flex-col leading-tight sm:flex">
            <span className="font-display text-lg tracking-ceremonial text-primary">
              Apostle Paul
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
              Memorial Park · Est. 1987
            </span>
          </span>
        </Link>

        <nav
          aria-label="Primary"
          className="ml-auto hidden flex-1 items-center justify-end gap-1 lg:flex"
        >
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded px-2.5 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  active
                    ? "text-primary"
                    : "text-text-default hover:text-primary",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <Link
            href="/portal/login"
            className="rounded border border-transparent px-3 py-2 text-sm text-text-default transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Owner Portal
          </Link>
          <Link
            href="/contact"
            className="rounded border border-primary px-4 py-2 text-sm text-primary transition-colors hover:bg-primary hover:text-primary-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Visit Us
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="marketing-mobile-nav"
          aria-label={open ? "Close menu" : "Open menu"}
          className="ml-auto inline-flex items-center justify-center rounded border border-surface-border p-2 text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
        >
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </div>

      {open ? (
        <div
          id="marketing-mobile-nav"
          className="border-t border-surface-border bg-surface-muted lg:hidden"
        >
          <nav
            aria-label="Primary mobile"
            className="mx-auto flex max-w-7xl flex-col px-4 py-3 sm:px-6"
          >
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "rounded px-3 py-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                    active
                      ? "bg-surface-emphasis text-primary"
                      : "text-text-default hover:bg-surface-emphasis",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-surface-border pt-3">
              <Link
                href="/portal/login"
                onClick={() => setOpen(false)}
                className="rounded border border-surface-border px-3 py-2 text-center text-sm text-text-default focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Owner Portal
              </Link>
              <Link
                href="/contact"
                onClick={() => setOpen(false)}
                className="rounded border border-primary bg-primary px-3 py-2 text-center text-sm text-primary-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Visit Us
              </Link>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
