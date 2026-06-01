/**
 * Story 1.6 — Audit log emission helper unit tests.
 *
 * Coverage target: ≥ 90% line + branch on `convex/lib/audit.ts`
 * (NFR-M2 — this is financial-touching infrastructure consumed by
 * every Phase 1 mutation).
 *
 * Why hand-mocked ctx instead of `convex-test`:
 *   Mirrors the pattern in `tests/unit/convex/lib/auth.test.ts` —
 *   `convex-test` requires `convex/_generated/` to exist, which only
 *   appears after `npx convex dev` runs. Hand-mocked ctx keeps CI green
 *   from the first commit and is sufficient to lock in the contract.
 */

import { ConvexError, type Value } from "convex/values";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ErrorCode,
  type ErrorPayload,
} from "../../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  AUDIT_ACTIONS,
  emitAudit,
  redactPii,
  type AuditAction,
  type EmitAuditParams,
} from "../../../../convex/lib/audit";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";
const HOUR_MS = 60 * 60 * 1000;

interface InsertedRow {
  actor: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

interface MutationCtxMock {
  inserts: Array<{ table: string; row: InsertedRow }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeMutationCtx(opts: {
  authenticated?: boolean;
  userExists?: boolean;
  hasRole?: boolean;
}): MutationCtxMock {
  const inserts: Array<{ table: string; row: InsertedRow }> = [];
  const fixtures = {
    user:
      opts.userExists === false
        ? null
        : { _id: USER_ID, _creationTime: T0 - 1000, email: "test@example.com" },
    session: {
      _id: SESSION_ID,
      _creationTime: T0,
      userId: USER_ID,
      expirationTime: T0 + 30 * 24 * HOUR_MS,
    },
    userRoles:
      opts.hasRole === false
        ? []
        : [
            {
              _id: "userRoles:0",
              _creationTime: T0,
              userId: USER_ID,
              role: "admin" as const,
              grantedAt: T0,
              grantedBy: USER_ID,
            },
          ],
  };

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (fixtures.user && id === fixtures.user._id) return fixtures.user;
        if (id === fixtures.session._id) return fixtures.session;
        return null;
      }),
      query: vi.fn((_table: string) => ({
        withIndex: (_indexName: string, _fn: unknown) => ({
          collect: async () => fixtures.userRoles,
        }),
      })),
      insert: vi.fn(async (table: string, row: InsertedRow) => {
        inserts.push({ table, row });
        return `${table}:row${inserts.length}`;
      }),
    },
  };

  return { inserts, ctx };
}

function makeActionCtx() {
  return {
    runMutation: vi.fn(),
    runQuery: vi.fn(),
    runAction: vi.fn(),
    auth: { getUserIdentity: vi.fn() },
    scheduler: { runAfter: vi.fn(), runAt: vi.fn() },
    storage: { generateUploadUrl: vi.fn(), getUrl: vi.fn() },
  };
}

function expectConvexErrorCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({
    data: { code },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AUDIT_ACTIONS", () => {
  it("exports the documented controlled vocabulary", () => {
    expect(AUDIT_ACTIONS).toEqual([
      "create",
      "update",
      "delete",
      "transition",
      "void",
      "deactivate",
      "reactivate",
      "transfer",
      "read_pii",
    ]);
  });
});

describe("redactPii", () => {
  it("passes top-level primitive strings through unchanged (not PII)", () => {
    expect(redactPii("hello")).toBe("hello");
  });

  it("passes top-level numbers through unchanged", () => {
    expect(redactPii(42)).toBe(42);
  });

  it("passes top-level booleans through unchanged", () => {
    expect(redactPii(true)).toBe(true);
  });

  it("passes null through unchanged", () => {
    expect(redactPii(null)).toBeNull();
  });

  it("passes undefined through unchanged", () => {
    expect(redactPii(undefined)).toBeUndefined();
  });

  it("redacts govIdNumber to last-4 form", () => {
    const out = redactPii({ govIdNumber: "123-456-789-012" });
    expect(out).toEqual({ govIdNumber: "***-***-9012" });
  });

  it("redacts idNumber to last-4 form", () => {
    const out = redactPii({ idNumber: "ABCDEFG1234" });
    expect(out).toEqual({ idNumber: "***-***-1234" });
  });

  it("redacts nationalId to last-4 form", () => {
    const out = redactPii({ nationalId: "XYZ-9988-7766" });
    expect(out).toEqual({ nationalId: "***-***-7766" });
  });

  it("redacts a short id (<4 chars) to ***", () => {
    expect(redactPii({ govIdNumber: "abc" })).toEqual({
      govIdNumber: "***",
    });
  });

  it("redacts an exactly-4-char id to *** (length < 4 is the cutoff)", () => {
    // length 4 is NOT < 4, so we get the last-4 path
    expect(redactPii({ govIdNumber: "1234" })).toEqual({
      govIdNumber: "***-***-1234",
    });
  });

  it("redacts address to first-letter-of-each-word", () => {
    expect(redactPii({ address: "123 Main St, Manila" })).toEqual({
      address: "1. M. S., M.",
    });
  });

  it("redacts an empty-string address to empty string", () => {
    expect(redactPii({ address: "" })).toEqual({ address: "" });
  });

  it("collapses internal whitespace when redacting address", () => {
    expect(redactPii({ address: "  Hello   World  " })).toEqual({
      address: "H. W.",
    });
  });

  it("collapses pure-punctuation tokens to '.' in address redaction", () => {
    // "Unit --- 4B" — the middle token "---" has no alphanumeric
    // character. It collapses to a bare "." sentinel so the segment
    // boundary survives.
    expect(redactPii({ address: "Unit --- 4B" })).toEqual({
      address: "U. . 4.",
    });
  });

  it("handles a token with leading punctuation before the first alphanumeric", () => {
    // "(123) Main" — "(123)" has leading "(" and trailing ")".
    // First alnum is "1", trailing punctuation is ")".
    expect(redactPii({ address: "(123) Main" })).toEqual({
      address: "1.) M.",
    });
  });

  it("passes non-PII fields through unchanged", () => {
    expect(redactPii({ name: "Maria", lotId: "L-001" })).toEqual({
      name: "Maria",
      lotId: "L-001",
    });
  });

  it("redacts inside arrays", () => {
    expect(
      redactPii([{ govIdNumber: "1234567890" }, { name: "foo" }]),
    ).toEqual([{ govIdNumber: "***-***-7890" }, { name: "foo" }]);
  });

  it("redacts inside nested objects", () => {
    const out = redactPii({
      customer: {
        name: "Maria",
        govIdNumber: "ABCDE12345",
        address: "Quezon City",
      },
      lotId: "L-001",
    });
    expect(out).toEqual({
      customer: {
        name: "Maria",
        govIdNumber: "***-***-2345",
        address: "Q. C.",
      },
      lotId: "L-001",
    });
  });

  it("does NOT redact a non-string govIdNumber (defensive — value shape is wrong)", () => {
    expect(redactPii({ govIdNumber: 123456789 })).toEqual({
      govIdNumber: 123456789,
    });
  });

  it("does NOT redact a non-string address (defensive)", () => {
    expect(redactPii({ address: null })).toEqual({ address: null });
  });

  it("redacts phone to first-3-chars + ellipsis", () => {
    // Generic contact form for phones — preserves country/area-code
    // prefix so admins can recognize the record without re-exposing
    // the full number.
    expect(redactPii({ phone: "+639170000001" })).toEqual({
      phone: "+63…",
    });
  });

  it("redacts a short phone (≤ 3 chars) to bare ellipsis", () => {
    expect(redactPii({ phone: "12" })).toEqual({ phone: "…" });
  });

  it("redacts email to domain-only form", () => {
    expect(redactPii({ email: "maria@example.com" })).toEqual({
      email: "…@example.com",
    });
  });

  it("falls back to first-3-chars form for an email without '@'", () => {
    // Malformed input — treat it as a generic contact string rather
    // than crash; defense in depth.
    expect(redactPii({ email: "malformed" })).toEqual({
      email: "mal…",
    });
  });

  it("does NOT redact a non-string email / phone (defensive)", () => {
    expect(redactPii({ email: null, phone: undefined })).toEqual({
      email: null,
      phone: undefined,
    });
  });

  it("redacts nested-object address sub-fields (line1, barangay, ...)", () => {
    // The schema's `address` is a nested OBJECT, not a string. The
    // recursion descends into it; the sub-field redaction inside the
    // object-branch is what catches the actual PII.
    const out = redactPii({
      address: {
        line1: "1 Old Street",
        barangay: "San Roque",
        cityMunicipality: "Aringay",
        province: "La Union",
        postalCode: "2503",
      },
    });
    expect(out).toEqual({
      address: {
        line1: "1 O…",
        barangay: "San…",
        cityMunicipality: "Ari…",
        province: "La …",
        postalCode: "250…",
      },
    });
  });

  it("redacts address sub-fields even when wrapped in a customer object", () => {
    const out = redactPii({
      customer: {
        name: "Maria",
        email: "maria@example.com",
        phone: "+639170000001",
        address: {
          line1: "1 Old Street",
          barangay: "San Roque",
        },
      },
    });
    expect(out).toEqual({
      customer: {
        name: "Maria",
        email: "…@example.com",
        phone: "+63…",
        address: {
          line1: "1 O…",
          barangay: "San…",
        },
      },
    });
  });

  it("coerces Date instances to ISO string (defensive — not recursed)", () => {
    // A naive recursion would call Object.entries(date) and produce
    // `{}`, silently erasing the value from the audit row. The
    // defensive branch preserves the timestamp shape instead.
    const out = redactPii({ when: new Date("2026-05-22T10:00:00.000Z") });
    expect(out).toEqual({ when: "2026-05-22T10:00:00.000Z" });
  });

  it("coerces Map / Set to the [non-plain-object] sentinel (defensive)", () => {
    const out = redactPii({
      tags: new Set(["a", "b"]),
      meta: new Map([["k", "v"]]),
    });
    expect(out).toEqual({
      tags: "[non-plain-object]",
      meta: "[non-plain-object]",
    });
  });

  it("caps recursion at REDACTION_MAX_DEPTH (5)", () => {
    // depth 0=root, 1, 2, 3, 4, 5 are all allowed; depth 6 hits the cap.
    // Build a chain: root.a (depth 1).b (depth 2).c (depth 3).d (depth 4)
    //   .e (depth 5).f (depth 6, replaced).
    const deeplyNested = {
      a: { b: { c: { d: { e: { f: { govIdNumber: "1234567890" } } } } } },
    };
    const out = redactPii(deeplyNested) as {
      a: { b: { c: { d: { e: { f: unknown } } } } };
    };
    // f is at depth 6 → replaced with the depth-cap sentinel.
    expect(out.a.b.c.d.e.f).toBe("[depth-capped]");
  });

  it("returns a fresh object, not the input reference (no aliasing)", () => {
    const input = { name: "foo", govIdNumber: "9999888877" };
    const out = redactPii(input);
    expect(out).not.toBe(input);
    expect(input.govIdNumber).toBe("9999888877"); // input untouched
  });
});

describe("emitAudit — MutationCtx happy path", () => {
  it("inserts a row with actor, timestamp, action, entityType, entityId", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    const id = await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: "lots:001",
    });
    expect(id).toBe("auditLog:row1");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual({
      table: "auditLog",
      row: {
        actor: USER_ID,
        timestamp: T0,
        action: "create",
        entityType: "lot",
        entityId: "lots:001",
      },
    });
  });

  it("includes redacted `before` and `after` when provided", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: "customers:42",
      before: { name: "Maria", govIdNumber: "1234567890" },
      after: { name: "Maria Cruz", govIdNumber: "1234567890" },
    });
    expect(inserts[0]!.row.before).toEqual({
      name: "Maria",
      govIdNumber: "***-***-7890",
    });
    expect(inserts[0]!.row.after).toEqual({
      name: "Maria Cruz",
      govIdNumber: "***-***-7890",
    });
  });

  it("includes `reason` as-typed (free text, never redacted)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "void",
      entityType: "receipt",
      entityId: "receipts:OR-2026-0001",
      reason: "Customer requested cancellation",
    });
    expect(inserts[0]!.row.reason).toBe("Customer requested cancellation");
  });

  it("omits before / after / reason from the inserted row when not provided", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "delete",
      entityType: "user",
      entityId: "users:zzz",
    });
    const row = inserts[0]!.row;
    expect("before" in row).toBe(false);
    expect("after" in row).toBe(false);
    expect("reason" in row).toBe(false);
  });

  it("uses `Date.now()` for the timestamp (caller can't override)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    vi.setSystemTime(T0 + 5 * HOUR_MS);
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: "lots:001",
    });
    expect(inserts[0]!.row.timestamp).toBe(T0 + 5 * HOUR_MS);
  });

  it("accepts every documented AuditAction value", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    for (const action of AUDIT_ACTIONS) {
      await emitAudit(ctx, {
        action,
        entityType: "lot",
        entityId: "lots:001",
      });
    }
    expect(inserts.map((i) => i.row.action)).toEqual([...AUDIT_ACTIONS]);
  });

  it("redacts address in `before`/`after` payloads", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: "customers:42",
      before: { address: "123 Main St, Manila" },
      after: { address: "456 Side Rd, Quezon City" },
    });
    expect(inserts[0]!.row.before).toEqual({ address: "1. M. S., M." });
    expect(inserts[0]!.row.after).toEqual({ address: "4. S. R., Q. C." });
  });

  it("redacts phone in persisted audit payload (Epic 1/2 review)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: "customers:42",
      before: { phone: "+639170000001" },
      after: { phone: "+639170000002" },
    });
    expect(inserts[0]!.row.before).toEqual({ phone: "+63…" });
    expect(inserts[0]!.row.after).toEqual({ phone: "+63…" });
  });

  it("redacts email in persisted audit payload (Epic 1/2 review)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: "customers:42",
      before: { email: "maria@example.com" },
      after: { email: "maria.cruz@example.com" },
    });
    expect(inserts[0]!.row.before).toEqual({ email: "…@example.com" });
    expect(inserts[0]!.row.after).toEqual({ email: "…@example.com" });
  });

  it("redacts nested address sub-fields in persisted audit payload (Epic 1/2 review)", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "update",
      entityType: "customer",
      entityId: "customers:42",
      before: {
        address: {
          line1: "1 Old Street",
          barangay: "San Roque",
        },
      },
      after: {
        address: {
          line1: "2 New Street",
          barangay: "Santo Niño",
        },
      },
    });
    expect(inserts[0]!.row.before).toEqual({
      address: { line1: "1 O…", barangay: "San…" },
    });
    expect(inserts[0]!.row.after).toEqual({
      address: { line1: "2 N…", barangay: "San…" },
    });
  });
});

describe("emitAudit — MutationCtx error paths", () => {
  it("throws UNAUTHENTICATED when no auth identity", async () => {
    const { ctx } = makeMutationCtx({ authenticated: false });
    await expectConvexErrorCode(
      emitAudit(ctx, {
        action: "create",
        entityType: "lot",
        entityId: "lots:001",
      }),
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it("throws UNAUTHENTICATED when the user record is missing", async () => {
    const { ctx } = makeMutationCtx({ userExists: false });
    await expectConvexErrorCode(
      emitAudit(ctx, {
        action: "create",
        entityType: "lot",
        entityId: "lots:001",
      }),
      ErrorCode.UNAUTHENTICATED,
    );
  });

  it("throws INVARIANT_VIOLATION when action is not in the controlled vocabulary", async () => {
    const { ctx } = makeMutationCtx({});
    const params = {
      action: "frobnicate" as unknown as AuditAction,
      entityType: "lot",
      entityId: "lots:001",
    } satisfies EmitAuditParams;
    const err = await emitAudit(ctx, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(data.details).toMatchObject({ action: "frobnicate" });
  });

  it("does NOT write a row when the action validation fails", async () => {
    const { ctx, inserts } = makeMutationCtx({});
    await emitAudit(ctx, {
      action: "not-a-real-action" as unknown as AuditAction,
      entityType: "lot",
      entityId: "lots:001",
    }).catch(() => undefined);
    expect(inserts).toHaveLength(0);
  });

  it("does NOT write a row when auth fails", async () => {
    const { ctx, inserts } = makeMutationCtx({ authenticated: false });
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: "lots:001",
    }).catch(() => undefined);
    expect(inserts).toHaveLength(0);
  });
});

describe("emitAudit — MutationCtx actorOverride (Story 1.15 H5)", () => {
  it("uses actorOverride when no auth context is present (CLI-invoked internal mutation)", async () => {
    // Unauthenticated mutation ctx — simulates an `npx convex run`
    // internal mutation that has no end-user auth context.
    const { ctx, inserts } = makeMutationCtx({ authenticated: false });
    await emitAudit(ctx, {
      action: "create",
      entityType: "section",
      entityId: "sections:s-backfill",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actorOverride: USER_ID as any,
      after: { kind: "migration_backfill", rowsTouched: 5 },
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.row).toMatchObject({
      actor: USER_ID,
      action: "create",
      entityType: "section",
      entityId: "sections:s-backfill",
      after: { kind: "migration_backfill", rowsTouched: 5 },
    });
  });

  it("prefers the authenticated caller over actorOverride (defense in depth)", async () => {
    // Authenticated mutation ctx — even if a caller passes
    // `actorOverride`, the resolved auth payload wins. Prevents a
    // client-callable mutation from forging the actor.
    const { ctx, inserts } = makeMutationCtx({});
    const otherUser = "users:imposter" as unknown as typeof USER_ID;
    await emitAudit(ctx, {
      action: "create",
      entityType: "lot",
      entityId: "lots:001",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actorOverride: otherUser as any,
    });
    expect(inserts[0]!.row.actor).toBe(USER_ID);
  });

  it("still throws UNAUTHENTICATED when neither auth nor actorOverride is present", async () => {
    const { ctx } = makeMutationCtx({ authenticated: false });
    await expectConvexErrorCode(
      emitAudit(ctx, {
        action: "create",
        entityType: "section",
        entityId: "sections:s1",
      }),
      ErrorCode.UNAUTHENTICATED,
    );
  });
});

describe("emitAudit — ActionCtx transport", () => {
  it("delegates to the internal recordActionAudit mutation when actorOverride is supplied", async () => {
    const actionCtx = makeActionCtx();
    actionCtx.runMutation.mockResolvedValue("auditLog:from-action");

    const result = await emitAudit(
      // Cast: the helper's ActionCtx branch only inspects `runMutation`
      // (no `db`). The mock above is structurally sufficient.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actionCtx as any,
      {
        action: "create",
        entityType: "lot",
        entityId: "lots:001",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actorOverride: USER_ID as any,
        after: { name: "Lot A" },
      },
    );

    expect(result).toBe("auditLog:from-action");
    expect(actionCtx.runMutation).toHaveBeenCalledTimes(1);
    const firstCall = actionCtx.runMutation.mock.calls[0];
    expect(firstCall).toBeDefined();
    const payload = (firstCall as unknown as [unknown, Record<string, unknown>])[1];
    // Caller passes redaction-input shape; the internal mutation
    // redacts at write time. The action helper just forwards.
    expect(payload).toMatchObject({
      actor: USER_ID,
      action: "create",
      entityType: "lot",
      entityId: "lots:001",
      after: { name: "Lot A" },
    });
  });

  it("throws INVARIANT_VIOLATION when actorOverride is missing (actions have no auth context)", async () => {
    const actionCtx = makeActionCtx();
    const err = await emitAudit(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actionCtx as any,
      {
        action: "create",
        entityType: "lot",
        entityId: "lots:001",
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(data.message).toMatch(/actorOverride/i);
    expect(actionCtx.runMutation).not.toHaveBeenCalled();
  });

  it("throws INVARIANT_VIOLATION for unknown actions before calling the internal mutation", async () => {
    const actionCtx = makeActionCtx();
    const err = await emitAudit(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      actionCtx as any,
      {
        // Bypass the type system on purpose — the helper is the guard.
        action: "definitely-not-real" as AuditAction,
        entityType: "lot",
        entityId: "lots:001",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        actorOverride: USER_ID as any,
      } as EmitAuditParams,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    const data = (err as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(actionCtx.runMutation).not.toHaveBeenCalled();
  });
});
