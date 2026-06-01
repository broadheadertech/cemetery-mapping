import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { makeFunctionReference } from "convex/server";
import { useNetworkAwareMutation } from "@/hooks/useNetworkAwareMutation";

/**
 * `useMutation` is mocked at the module boundary so the hook test
 * doesn't need a Convex provider. We capture the underlying fn passed
 * to the hook and assert that the offline guard short-circuits BEFORE
 * the inner mutation is invoked.
 */

const innerMutation = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: () => innerMutation,
}));

const probeRef = makeFunctionReference<
  "mutation",
  { value: string },
  { ok: true }
>("test:probe");

function Probe({ onCall }: { onCall: (fn: (a: { value: string }) => Promise<unknown>) => void }) {
  const fn = useNetworkAwareMutation(probeRef);
  onCall(fn);
  return null;
}

describe("useNetworkAwareMutation", () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "onLine",
  );

  beforeEach(() => {
    innerMutation.mockReset();
    innerMutation.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    if (originalDescriptor) {
      Object.defineProperty(navigator, "onLine", originalDescriptor);
    }
  });

  it("invokes the underlying mutation while online", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    let captured: (a: { value: string }) => Promise<unknown> = async () => undefined;
    render(<Probe onCall={(fn) => (captured = fn)} />);

    const result = await captured({ value: "x" });
    expect(innerMutation).toHaveBeenCalledWith({ value: "x" });
    expect(result).toEqual({ ok: true });
  });

  it("throws OFFLINE_WRITE_BLOCKED while offline without calling the mutation", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    let captured: (a: { value: string }) => Promise<unknown> = async () => undefined;
    render(<Probe onCall={(fn) => (captured = fn)} />);

    await expect(captured({ value: "x" })).rejects.toMatchObject({
      data: { code: "OFFLINE_WRITE_BLOCKED" },
    });
    expect(innerMutation).not.toHaveBeenCalled();
  });
});

/**
 * Source-level guard: verify that the staff lot pages consume the
 * mutations via `useNetworkAwareMutation`, not the raw `useMutation`.
 * Functional render tests of those pages would need a full Convex
 * provider + router context; this lightweight static check pins the
 * adversarial-review fix (Story 1.13) so a regression — someone
 * swapping back to `useMutation` for `createLot` / `updateLot` —
 * trips the test.
 */
describe("staff lot pages — network-aware mutation wrapping", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");

  function readSrc(relative: string): string {
    return fs.readFileSync(
      path.join(process.cwd(), "src", relative),
      "utf8",
    );
  }

  it("/lots/new wraps createLot via useNetworkAwareMutation", () => {
    const src = readSrc("app/(staff)/lots/new/page.tsx");
    expect(src).toMatch(/useNetworkAwareMutation\(createLotRef\)/);
    expect(src).not.toMatch(/useMutation\(createLotRef\)/);
  });

  it("/lots/[lotId]/edit wraps updateLot via useNetworkAwareMutation", () => {
    const src = readSrc("app/(staff)/lots/[lotId]/edit/page.tsx");
    expect(src).toMatch(/useNetworkAwareMutation\(updateLotRef\)/);
    expect(src).not.toMatch(/useMutation\(updateLotRef\)/);
  });

  it("/lots/[lotId] wraps retireLot via useNetworkAwareMutation", () => {
    const src = readSrc("app/(staff)/lots/[lotId]/page.tsx");
    expect(src).toMatch(/useNetworkAwareMutation\(retireLotRef\)/);
    expect(src).not.toMatch(/useMutation\(retireLotRef\)/);
  });

  it("/lots list view continues to wrap retireLot via useNetworkAwareMutation", () => {
    const src = readSrc("app/(staff)/lots/page.tsx");
    expect(src).toMatch(/useNetworkAwareMutation\(retireLotRef\)/);
    expect(src).not.toMatch(/useMutation\(retireLotRef\)/);
  });
});
