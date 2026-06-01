"use client";

/**
 * PortalInviteButton — Story 9.1 portal-invite operator surface.
 *
 * Renders a "Send portal invite" button on the customer detail page.
 * Clicking opens a dialog that:
 *   1. Calls `portalInvites:createPortalInvite` to mint a fresh
 *      single-use token (UUIDv4, 7-day expiry).
 *   2. Displays the resulting accept-invite URL the operator can
 *      paste into an SMS / email to the customer.
 *   3. Provides a one-click "Copy URL" affordance backed by the
 *      browser clipboard API.
 *
 * The mutation is admin / office_staff only; field-worker callers get
 * FORBIDDEN. The button is rendered unconditionally on the customer
 * detail page (the page itself is already role-gated). A more
 * sophisticated UI could hide the button for field-worker / customer
 * callers, but the server-side gate is the security boundary.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

const createPortalInviteRef = makeFunctionReference<
  "mutation",
  { customerId: string },
  { inviteId: string; inviteToken: string; expiresAt: number }
>("portalInvites:createPortalInvite");

export interface PortalInviteButtonProps {
  customerId: string;
}

export function PortalInviteButton({ customerId }: PortalInviteButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createInvite = useMutation(createPortalInviteRef);

  async function handleClick() {
    setOpen(true);
    setBusy(true);
    setError(null);
    setCopied(false);
    setUrl(null);
    try {
      const result = await createInvite({ customerId });
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      setUrl(`${origin}/portal/accept-invite/${result.inviteToken}`);
    } catch (err) {
      if (err instanceof ConvexError) {
        const data = (err as ConvexError<{ message?: string }>).data;
        setError(
          (data && typeof data === "object" && typeof data.message === "string"
            ? data.message
            : null) ?? "Could not create invite.",
        );
      } else {
        setError("Could not create invite.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard API may be unavailable (e.g. insecure context); the
      // URL is still visible inline for manual copy.
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        data-testid="portal-invite-button"
        className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
      >
        Send portal invite
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="portal-invite-heading"
          data-testid="portal-invite-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4"
        >
          <div className="w-full max-w-lg rounded-md border border-slate-200 bg-white p-6 shadow-xl">
            <h2
              id="portal-invite-heading"
              className="text-lg font-semibold text-slate-900"
            >
              Portal invitation
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Send the link below to the customer. The invitation expires in
              7 days and can only be used once.
            </p>

            <div className="mt-4 min-h-[5rem]">
              {busy && (
                <p className="text-sm text-slate-600">Generating invite…</p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              {url !== null && (
                <div className="space-y-2">
                  <label
                    htmlFor="portal-invite-url"
                    className="block text-xs font-medium text-slate-700"
                  >
                    Invite URL
                  </label>
                  <input
                    id="portal-invite-url"
                    readOnly
                    value={url}
                    onFocus={(e) => e.currentTarget.select()}
                    data-testid="portal-invite-url"
                    className="w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-mono text-slate-900"
                  />
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex min-h-[36px] items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-fg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
                  >
                    {copied ? "Copied" : "Copy URL"}
                  </button>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
