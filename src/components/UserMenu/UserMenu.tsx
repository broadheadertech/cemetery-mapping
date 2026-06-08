"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";
import { LogOut, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTheme } from "@/hooks/useTheme";

/**
 * UserMenu — sidebar-footer affordance for outdoor-mode toggle and
 * Sign-Out.
 *
 * The trigger renders the user's initials inside a circular avatar
 * (collapsed state shows just the avatar; expanded shows avatar + name
 * + email). Clicking opens a Popover with two actions:
 *   1. Outdoor mode toggle — flips `data-theme` on <html> via the
 *      `useTheme()` hook.
 *   2. Sign out — calls Convex Auth's `signOut()` then pushes /login.
 *
 * Per the story's "Disaster prevention" notes, sign-out is a button
 * (action), not a Link (navigation).
 */

export interface UserMenuProps {
  name: string;
  email: string;
  collapsed: boolean;
}

function initialsOf(name: string, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0] ?? "";
  if (parts.length === 1) {
    return first.slice(0, 2).toUpperCase() || "?";
  }
  const last = parts[parts.length - 1] ?? "";
  const a = first.charAt(0);
  const b = last.charAt(0);
  return `${a}${b}`.toUpperCase() || "?";
}

export function UserMenu({ name, email, collapsed }: UserMenuProps) {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const { isOutdoor, toggleOutdoor } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
      router.push("/login");
    } catch {
      // Sign-out failures are rare; the worst case is a stale token
      // that the next protected request will reject anyway. Keep the
      // UX optimistic and route to /login regardless.
      router.push("/login");
    } finally {
      setSigningOut(false);
    }
  }

  const initials = initialsOf(name, email);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Open user menu"
          className={cn(
            // Trigger lives inside the deep-emerald sidebar — dark
            // treatment (moss avatar, ivory name, gold-soft email).
            "flex w-full items-center rounded-md text-left text-sm hover:bg-[rgba(246,242,234,0.07)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A96B] focus-visible:ring-offset-1 focus-visible:ring-offset-[#144437]",
            collapsed ? "justify-center p-2" : "gap-3 p-2",
          )}
        >
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#4A8270] font-display text-sm font-semibold text-[#F6F2EA]"
          >
            {initials}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-[#F6F2EA]">
                {name || email}
              </span>
              {name && (
                <span className="block truncate text-[11px] text-[rgba(246,242,234,0.55)]">
                  {email}
                </span>
              )}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-64"
      >
        <div className="mb-3 border-b border-surface-border pb-3">
          <p className="truncate text-sm font-medium text-text-default">
            {name || email}
          </p>
          {name && (
            <p className="truncate text-xs text-text-muted">{email}</p>
          )}
        </div>

        <button
          type="button"
          onClick={toggleOutdoor}
          aria-pressed={isOutdoor}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-text-default hover:bg-surface-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <Sun className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 text-left">Outdoor mode</span>
          <span
            className={cn(
              "inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
              isOutdoor ? "bg-primary" : "bg-surface-emphasis",
            )}
            aria-hidden="true"
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-surface-base shadow-sm transition-transform",
                isOutdoor ? "translate-x-4" : "translate-x-1",
              )}
            />
          </span>
        </button>

        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-text-default hover:bg-surface-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-60"
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{signingOut ? "Signing out…" : "Sign out"}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}
