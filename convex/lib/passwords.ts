/**
 * Temporary-password generator — Story 1.3.
 *
 * Cemetery-mapping has no email service in Phase 1 (architectural
 * commitment per the brief § 7 and Story 1.3 §). Admins onboard staff
 * by clicking "New user", reading the one-time temporary password
 * displayed in the post-create dialog, and handing it to the new staff
 * member out-of-band (verbally, SMS, etc.). The new user signs in with
 * that password and is expected to change it on first sign-in.
 *
 * Security requirements (per Story 1.3 Dev Notes § Disaster prevention):
 *   - MUST use a cryptographically-secure source of randomness. `Math.random`
 *     is explicitly banned — it's predictable enough that an attacker
 *     who knows roughly when a user was provisioned could guess.
 *   - MUST run inside Convex's V8 runtime (the default for mutations).
 *     `crypto.getRandomValues` is available in V8 globally; we do NOT
 *     import `node:crypto` because that would force the mutation into
 *     the Node runtime and break atomicity with the user-table insert.
 *   - 14-character output — 80+ bits of entropy even when restricted to
 *     the alphanumeric alphabet, well above the 60-bit floor for
 *     short-lived bootstrap secrets per NIST SP 800-63B §A.3.
 *
 * Why a separate file instead of inlining in `convex/users.ts`:
 *   - Reusable from any future "issue temporary credential" mutation
 *     (e.g. a "reset password" admin action in a later story).
 *   - Unit-testable in isolation; the consumer doesn't need to mock
 *     `crypto.getRandomValues` indirectly through a Convex mutation.
 *   - Keeps `convex/users.ts`'s line count focused on user-management
 *     semantics, not crypto plumbing.
 */

/**
 * The alphabet excludes look-alike characters (`0`/`O`, `1`/`l`/`I`) so
 * an Admin reading the password aloud over the phone is less likely to
 * be misheard. Trade-off: ~6 bits of entropy versus the full
 * base62 alphabet; still safely above the 80-bit target at length 14.
 *
 * Length: 56 characters → log2(56) ≈ 5.81 bits per char → 14 chars
 * ≈ 81 bits of entropy. Above the 60-bit short-lived-secret floor.
 */
const ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ" + // 24 (excludes I, O)
  "abcdefghijkmnopqrstuvwxyz" + // 25 (excludes l)
  "23456789"; // 8 (excludes 0, 1)

/** Compile-time sanity check — keeps the entropy comment honest. */
const ALPHABET_LENGTH = ALPHABET.length;

/**
 * Default password length. 14 chars × log2(56) ≈ 81 bits of entropy.
 * Exported so callers (and tests) can reference the exact value.
 */
export const TEMPORARY_PASSWORD_LENGTH = 14;

/**
 * Generates a cryptographically-random temporary password.
 *
 * Implementation detail: we use rejection sampling on a Uint8Array to
 * avoid modulo bias. `crypto.getRandomValues(Uint8Array)` returns
 * bytes in [0, 256); the largest multiple of `ALPHABET_LENGTH` that
 * fits in a byte is `Math.floor(256 / 56) * 56 = 224`. Bytes
 * >= 224 are discarded and re-rolled. The expected number of bytes
 * consumed per character is `256 / 224 ≈ 1.14` — well under any
 * pathological case.
 *
 * @param length Password length in characters. Defaults to 14.
 * @returns A string of `length` characters drawn from the
 *          look-alike-safe alphabet.
 */
export function generateTemporaryPassword(
  length: number = TEMPORARY_PASSWORD_LENGTH,
): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(
      `generateTemporaryPassword: length must be a positive integer (got ${length})`,
    );
  }
  // `crypto` is the V8 global — provided by Convex's runtime. We assert
  // its presence loudly rather than silently falling back to
  // `Math.random` which would compromise the security claim.
  if (
    typeof crypto === "undefined" ||
    typeof crypto.getRandomValues !== "function"
  ) {
    throw new Error(
      "generateTemporaryPassword: Web Crypto (crypto.getRandomValues) is required.",
    );
  }
  const out: string[] = [];
  const maxAcceptable = Math.floor(256 / ALPHABET_LENGTH) * ALPHABET_LENGTH;
  // Allocate a generous buffer so we usually finish in a single fill.
  // The factor of 2 absorbs the ~14% rejection rate with margin.
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && out.length < length; i++) {
      const byte = buffer[i]!;
      if (byte >= maxAcceptable) continue;
      out.push(ALPHABET[byte % ALPHABET_LENGTH]!);
    }
  }
  return out.join("");
}
