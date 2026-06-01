"use client";

import { useCallback } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type {
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";
import { readNetworkState } from "@/lib/network-state";

/**
 * Wrapper for `useMutation` that hard-blocks writes while the browser
 * reports `navigator.onLine === false` (Story 1.13, AC5).
 *
 * Why we don't queue:
 *   - Phase 1 mutations touch financial invariants (lot status,
 *     contracts, receipts). A write queue + reconciliation logic
 *     against the server's atomic-mutation invariants would create
 *     a divergent client state. Architecture's "atomic multi-document
 *     write" lock disallows this.
 *   - UX-DR: a clear "reconnect and retry" message is honest to the
 *     user and avoids the eventual-consistency confusion of a silent
 *     queue.
 *
 * Defense in depth:
 *   - The thrown `ConvexError` carries `code: "OFFLINE_WRITE_BLOCKED"`
 *     which the client `translateError` maps to "Posting requires
 *     connection. Reconnect and try again."
 *   - The wrapper is a pure decorator: it never alters the underlying
 *     `useMutation` semantics when online.
 *   - `navigator.onLine` is not 100% reliable. If a request slips
 *     through with no real connectivity, the Convex client fails fast
 *     and `translateError` surfaces a generic retry message.
 *
 * Usage:
 *   const retire = useNetworkAwareMutation(retireLotRef);
 *   await retire({ lotId });   // throws OFFLINE_WRITE_BLOCKED when offline.
 */
export function useNetworkAwareMutation<
  Mutation extends FunctionReference<"mutation">,
>(
  mutation: Mutation,
): (
  ...args: OptionalRestArgs<Mutation>
) => Promise<FunctionReturnType<Mutation>> {
  const mut = useMutation(mutation);

  return useCallback(
    async (
      ...args: OptionalRestArgs<Mutation>
    ): Promise<FunctionReturnType<Mutation>> => {
      if (readNetworkState() === "offline") {
        throw new ConvexError({
          code: "OFFLINE_WRITE_BLOCKED",
          message: "Posting requires connection. Reconnect and try again.",
        });
      }
      return mut(...args);
    },
    [mut],
  );
}
