"use client";

import { ConvexReactClient } from "convex/react";

/**
 * Singleton Convex React client used by the (client-side) ConvexAuthProvider.
 *
 * The URL is the public Convex Cloud endpoint set during `npx convex dev`
 * setup (writes to .env.local) or via Vercel env vars in production.
 * For this project: https://beaming-boar-935.convex.cloud
 */
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  throw new Error(
    "NEXT_PUBLIC_CONVEX_URL is not set. Run `npx convex dev` to provision a " +
    "deployment, or set the env var manually in .env.local. " +
    "Project deployment: beaming-boar-935.",
  );
}

export const convex = new ConvexReactClient(convexUrl);
