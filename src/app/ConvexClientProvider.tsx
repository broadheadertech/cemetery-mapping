"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { convex } from "@/lib/convexClient";

/**
 * Client-side Convex Auth provider wrapper.
 *
 * Wraps the entire (client-component) tree so any descendant can call
 * useAuthActions(), useQuery, useMutation, etc. with auth context.
 *
 * The matching server-side provider lives in `layout.tsx` —
 * ConvexAuthNextjsServerProvider must wrap THIS provider so server
 * components get auth state during SSR.
 */
export function ConvexClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
