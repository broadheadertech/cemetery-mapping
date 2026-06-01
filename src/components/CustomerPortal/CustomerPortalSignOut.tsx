"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthActions } from "@convex-dev/auth/react";

/**
 * Customer portal sign-out affordance (Story 9.1, FR5).
 *
 * Renders the customer's display name (if available) alongside a
 * "Sign out" button. The button calls Convex Auth's `signOut()` then
 * pushes `/portal/login` — never `/login`, because customers should
 * never see the staff sign-in chrome.
 *
 * Per the architecture's "min chrome" rule for the customer portal,
 * this is the ONLY action available in the header. Future stories
 * (9.2 contracts list, 9.3 receipts, 9.4 contact-info edit) may add
 * a small in-page nav inside the main content area, but they DO NOT
 * extend the header.
 */
export interface CustomerPortalSignOutProps {
  displayName: string;
}

export function CustomerPortalSignOut({
  displayName,
}: CustomerPortalSignOutProps) {
  const router = useRouter();
  const { signOut } = useAuthActions();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOut();
      router.push("/portal/login");
    } catch {
      // Sign-out failures are rare; the worst case is a stale token
      // that the next protected request will reject. Route to the
      // login page regardless so the user is not stranded on a stale
      // session UI.
      router.push("/portal/login");
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="flex items-center gap-3 text-sm">
      {displayName && (
        <span
          className="hidden sm:inline truncate max-w-[12rem] text-text-muted"
          title={displayName}
        >
          {displayName}
        </span>
      )}
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="rounded-md border border-surface-border px-3 py-2 text-sm font-medium text-text-default hover:bg-surface-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed min-h-[40px]"
      >
        {signingOut ? "Taking your leave…" : "Take your leave"}
      </button>
    </div>
  );
}
