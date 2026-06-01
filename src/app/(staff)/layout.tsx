import { redirect } from "next/navigation";
import { fetchQuery } from "convex/nextjs";
import { makeFunctionReference } from "convex/server";
import { convexAuthNextjsToken } from "@convex-dev/auth/nextjs/server";
import { AppShell } from "@/components/AppShell";

/**
 * Staff route group layout.
 *
 * Story 1.1 set up the bare-minimum chrome. Story 1.2 added the
 * server-side auth resolution. Story 1.5 (this rewrite) wraps the
 * authenticated tree in `AppShell` — the canonical sidebar + mobile
 * top bar + global Cmd-K palette.
 *
 * The layout itself stays a Next.js server component:
 *   - It runs the auth check via `fetchQuery(getCurrentUserOrNull)` so
 *     `redirect("/login")` happens before any HTML is sent (no
 *     flash-of-protected-content).
 *   - It hands the resolved user payload (name/email/roles) to the
 *     client-side `<AppShell>` so the shell never refetches what the
 *     server already knows.
 *
 * Defense in depth: this layout enforces that there IS an authenticated
 * Convex user; per-route role checks live inside the queries / mutations
 * those pages call (Story 1.2's `requireRole`). The middleware (Story
 * 1.5 Task 1) also blocks unauthenticated traffic before reaching here —
 * the layout's check is the backup, not the only gate.
 *
 * `makeFunctionReference` keeps this file typecheck-clean even before
 * `npx convex dev` regenerates `convex/_generated/api.ts`. Once the
 * generated module lands the import can be swapped.
 */

interface AuthUserDoc {
  email?: string;
  name?: string;
}

interface AuthPayload {
  userId: string;
  user: AuthUserDoc;
  roles: string[];
}

const getCurrentUserOrNull = makeFunctionReference<
  "query",
  Record<string, never>,
  AuthPayload | null
>("lib/auth:getCurrentUserOrNull");

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const token = await convexAuthNextjsToken();
  if (!token) {
    redirect("/login");
  }

  const payload = await fetchQuery(getCurrentUserOrNull, {}, { token });
  if (payload === null) {
    redirect("/login");
  }

  const user = {
    // The server query returns the full user document; the auth tables
    // typically carry an email and may carry a name. We fall back to
    // the email when the display name isn't set.
    name: payload.user.name ?? "",
    email: payload.user.email ?? "",
    roles: payload.roles,
  };

  return <AppShell user={user}>{children}</AppShell>;
}
