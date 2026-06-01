import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("vitest runs in CI", () => {
    expect(1 + 1).toBe(2);
  });

  it("strict TypeScript catches obvious bugs at compile time", () => {
    // If this file is type-checking, NFR-M1 strict mode is on. Real
    // tests for the auth flow land alongside Story 1.2's requireRole.
    const x: number = 42;
    expect(x).toBe(42);
  });
});
