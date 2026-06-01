"use client";

import { useEffect, useState } from "react";
import {
  readNetworkState,
  subscribeToNetworkState,
  type NetworkState,
} from "@/lib/network-state";

/**
 * React hook wrapping `navigator.onLine` + the `online` / `offline`
 * window events. Used by the offline indicator pill and the
 * `useNetworkAwareMutation` short-circuit.
 *
 * SSR safety: returns "online" during the server render to avoid a
 * hydration mismatch. The client effect immediately corrects to the
 * real value on mount.
 */
export function useNetworkState(): NetworkState {
  const [state, setState] = useState<NetworkState>("online");

  useEffect(() => {
    setState(readNetworkState());
    return subscribeToNetworkState(setState);
  }, []);

  return state;
}
