"use client";

import { useEffect, useState } from "react";

/**
 * Generic debounce hook (Story 1.10).
 *
 * Returns `value` only after it has held still for `delayMs` ms.
 * Used by the Cmd-K palette to throttle Convex queries to 80ms
 * (UX-DR12). Intentionally tiny so we avoid pulling in
 * `lodash.debounce` / `use-debounce` for an 18-line primitive.
 *
 * The `setTimeout` is cleared on every re-render so a fast typist's
 * keystrokes coalesce into a single debounced update — without the
 * cleanup, stale timeouts would fire after unmount and produce the
 * "setState on unmounted component" React warning.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
