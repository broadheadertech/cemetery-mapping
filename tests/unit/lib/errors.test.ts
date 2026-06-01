import { describe, it, expect } from "vitest";
import { translateError, CLIENT_ERROR_CODES } from "@/lib/errors";

/**
 * translateError covers every defined ClientErrorCode plus the
 * fallback path. The function is called on every UI error surface
 * (toast, inline error banner, form-level error sentence) so
 * regressions would silently leak Convex's raw error messages into the
 * user's view.
 */
describe("translateError", () => {
  it("returns the fallback message for an empty/unknown error", () => {
    const result = translateError(undefined);
    expect(result.headline).toBe("Something went wrong");
    expect(result.retryable).toBe(true);
  });

  it("returns the fallback for a generic Error without a code", () => {
    const result = translateError(new Error("Network timeout"));
    expect(result.headline).toBe("Something went wrong");
  });

  it.each(Object.values(CLIENT_ERROR_CODES))(
    "translates known code %s via the `data.code` field",
    (code) => {
      const result = translateError({ data: { code } });
      expect(result.headline).not.toBe("Something went wrong");
      expect(result.detail.length).toBeGreaterThan(0);
    },
  );

  it("extracts code from a message string", () => {
    const result = translateError({
      message: "ConvexError: UNAUTHENTICATED — token missing",
    });
    expect(result.headline).toBe("Sign in to continue");
  });

  it("extracts code from a string-only error", () => {
    const result = translateError("Failed: FORBIDDEN action");
    expect(result.headline).toBe("Action not permitted");
  });

  it("falls back to the default when an unknown code is supplied", () => {
    const result = translateError({ data: { code: "BIZZARO_NEW_CODE" } });
    expect(result.headline).toBe("Something went wrong");
  });

  it("returns a stable headline + detail + retryable shape", () => {
    const result = translateError({ data: { code: "UNAUTHENTICATED" } });
    expect(typeof result.headline).toBe("string");
    expect(typeof result.detail).toBe("string");
    expect(typeof result.retryable).toBe("boolean");
  });
});
