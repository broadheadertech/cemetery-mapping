// Global Vitest setup. Story 1.1 just registers jest-dom matchers
// so component tests can use them. Future stories may add MSW for
// network mocking, fake-timers configuration, etc.
import "@testing-library/jest-dom/vitest";

// Story 1.5: cmdk + Radix Popover use ResizeObserver internally, and
// the jsdom environment doesn't ship one. A no-op polyfill is enough
// for our tests — we don't measure layout in unit specs.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = NoopResizeObserver;
}

// jsdom doesn't implement pointer-capture APIs that Radix references.
// Patch them as no-ops on Element.prototype so Radix's internal calls
// don't blow up when our tests render Dialog / Popover / Sheet.
const E = globalThis.Element?.prototype as
  | (Element & {
      hasPointerCapture?: (id: number) => boolean;
      setPointerCapture?: (id: number) => void;
      releasePointerCapture?: (id: number) => void;
      scrollIntoView?: () => void;
    })
  | undefined;
if (E) {
  if (typeof E.hasPointerCapture !== "function") {
    E.hasPointerCapture = () => false;
  }
  if (typeof E.setPointerCapture !== "function") {
    E.setPointerCapture = () => {};
  }
  if (typeof E.releasePointerCapture !== "function") {
    E.releasePointerCapture = () => {};
  }
  if (typeof E.scrollIntoView !== "function") {
    E.scrollIntoView = () => {};
  }
}
