/**
 * Story 9.1 portal-invite (Epic-9 adversarial-review HIGH fix) — tests.
 *
 * Three Convex surfaces under test:
 *
 *   - `createPortalInvite` (admin / office_staff mutation) — token
 *     generation, expiry, email-required validation, audit emission.
 *   - `acceptPortalInvite` (public mutation) — token validity,
 *     single-use, expiry, password floor, account-already-exists
 *     refusal, role grant, audit emission.
 *   - `listActiveInvitesForCustomer` (admin query) — pending-invite
 *     read for the "resend?" admin UI.
 *
 * Hand-mocked ctx mirrors `customers.test.ts` so the four tables we
 * touch — customers, portalInvites, users, userRoles, authAccounts,
 * auditLog — behave consistently.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

vi.mock("lucia", () => ({
  Scrypt: class {
    async hash(p: string) {
      return `scrypt:${p}`;
    }
  },
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  acceptPortalInvite,
  createPortalInvite,
  listActiveInvitesForCustomer,
} from "../../../convex/portalInvites";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";
const CUSTOMER_ID = "customers:c1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface InsertCapture {
  table: string;
  id: string;
  row: Record<string, unknown>;
}

interface CustomerRow {
  _id: string;
  _creationTime: number;
  fullName: string;
  email?: string;
}

interface InviteRow {
  _id: string;
  _creationTime: number;
  customerId: string;
  inviteToken: string;
  createdAt: number;
  createdByUserId: string;
  expiresAt: number;
  usedAt?: number;
  usedByUserId?: string;
}

function makeCtx(opts: {
  roles?: RoleName[];
  authenticated?: boolean;
  customers?: CustomerRow[];
  invites?: InviteRow[];
  authAccountsByEmail?: string[]; // emails that already have authAccounts
}) {
  const customers = new Map<string, CustomerRow>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const invites = new Map<string, InviteRow>(
    (opts.invites ?? []).map((i) => [i._id, i]),
  );
  const existingAccountEmails = new Set(opts.authAccountsByEmail ?? []);
  const inserts: InsertCapture[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const userRoles = (opts.roles ?? ["admin"]).map((role, idx) => ({
    _id: `userRoles:caller-${idx}`,
    _creationTime: T0,
    userId: CALLER_ID,
    role,
    grantedAt: T0,
    grantedBy: CALLER_ID,
  }));

  const callerUser = {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    email: "admin@example.com",
    isActive: true,
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: CALLER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  let nextId = 1;

  type Predicate = (r: Record<string, unknown>) => boolean;
  function makeBuilder(table: string) {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(
        _name: string,
        fn: (q: {
          eq: (f: string, v: unknown) => unknown;
        }) => unknown,
      ) {
        const eqs: Record<string, unknown> = {};
        const q = {
          eq(f: string, v: unknown) {
            eqs[f] = v;
            return this;
          },
        };
        fn(q);
        for (const [f, v] of Object.entries(eqs)) {
          predicates.push((r) => r[f] === v);
        }
        return builder;
      },
      async collect(): Promise<Record<string, unknown>[]> {
        const rows: Record<string, unknown>[] =
          table === "portalInvites"
            ? Array.from(invites.values()).map(
                (i) => i as unknown as Record<string, unknown>,
              )
            : table === "authAccounts"
              ? Array.from(existingAccountEmails).map((email) => ({
                  provider: "password",
                  providerAccountId: email,
                }))
              : [];
        return rows.filter((r) => predicates.every((p) => p(r)));
      },
      async unique(): Promise<Record<string, unknown> | null> {
        const out = await this.collect();
        if (out.length === 0) return null;
        if (out.length > 1) {
          throw new Error("unique() returned multiple rows");
        }
        return out[0] ?? null;
      },
    };
    return builder;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return callerUser;
        if (id === SESSION_ID) return session;
        if (customers.has(id)) return customers.get(id);
        if (invites.has(id)) return invites.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        return makeBuilder(table);
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        const id = `${table}:${nextId++}`;
        inserts.push({ table, id, row });
        if (table === "portalInvites") {
          invites.set(id, {
            _id: id,
            _creationTime: T0,
            ...(row as Omit<InviteRow, "_id" | "_creationTime">),
          });
        }
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        const existing = invites.get(id);
        if (existing !== undefined) {
          invites.set(id, { ...existing, ...patch } as InviteRow);
        }
      }),
    },
  };

  return { ctx, customers, invites, inserts, patches };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeMutation", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

function defaultCustomer(): CustomerRow {
  return {
    _id: CUSTOMER_ID,
    _creationTime: T0 - 1000,
    fullName: "Maria Cruz",
    email: "maria@example.com",
  };
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

describe("portalInvites.createPortalInvite — auth", () => {
  const run = handlerOf(createPortalInvite);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({
      authenticated: false,
      customers: [defaultCustomer()],
    });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for field_worker", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      customers: [defaultCustomer()],
    });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("succeeds for admin", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      customers: [defaultCustomer()],
    });
    const out = (await run(ctx, { customerId: CUSTOMER_ID })) as {
      inviteToken: string;
    };
    expect(out.inviteToken).toBeTruthy();
  });

  it("succeeds for office_staff", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      customers: [defaultCustomer()],
    });
    const out = (await run(ctx, { customerId: CUSTOMER_ID })) as {
      inviteToken: string;
    };
    expect(out.inviteToken).toBeTruthy();
  });
});

describe("portalInvites.createPortalInvite — validation + happy path", () => {
  const run = handlerOf(createPortalInvite);

  it("throws NOT_FOUND when the customerId does not exist", async () => {
    const { ctx } = makeCtx({ customers: [] });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws VALIDATION when the customer has no email", async () => {
    const { ctx } = makeCtx({
      customers: [{ ...defaultCustomer(), email: undefined }],
    });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("mints a UUID-shaped token of length >= 8", async () => {
    const { ctx } = makeCtx({ customers: [defaultCustomer()] });
    const out = (await run(ctx, { customerId: CUSTOMER_ID })) as {
      inviteToken: string;
    };
    expect(out.inviteToken.length).toBeGreaterThanOrEqual(8);
  });

  it("each call produces a unique token", async () => {
    const { ctx } = makeCtx({ customers: [defaultCustomer()] });
    const a = (await run(ctx, { customerId: CUSTOMER_ID })) as {
      inviteToken: string;
    };
    const b = (await run(ctx, { customerId: CUSTOMER_ID })) as {
      inviteToken: string;
    };
    expect(a.inviteToken).not.toBe(b.inviteToken);
  });

  it("emits one audit row per invite", async () => {
    const { ctx, inserts } = makeCtx({ customers: [defaultCustomer()] });
    await run(ctx, { customerId: CUSTOMER_ID });
    const auditRows = inserts.filter((i) => i.table === "auditLog");
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!.row;
    expect(row.action).toBe("update");
    expect(row.entityType).toBe("customer");
    expect(row.entityId).toBe(CUSTOMER_ID);
  });

  it("expiresAt is in the future (≈ 7 days)", async () => {
    const { ctx } = makeCtx({ customers: [defaultCustomer()] });
    const out = (await run(ctx, { customerId: CUSTOMER_ID })) as {
      expiresAt: number;
    };
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(out.expiresAt).toBeGreaterThanOrEqual(T0 + sevenDaysMs - 10);
  });
});

describe("portalInvites.acceptPortalInvite — validation", () => {
  const run = handlerOf(acceptPortalInvite);

  it("rejects unknown token", async () => {
    const { ctx } = makeCtx({ customers: [defaultCustomer()] });
    const thrown = await run(ctx, {
      token: "bogus-token-zzz",
      password: "longenoughpw",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects already-used token", async () => {
    const used: InviteRow = {
      _id: "portalInvites:i1",
      _creationTime: T0 - 1000,
      customerId: CUSTOMER_ID,
      inviteToken: "tok-used-1234",
      createdAt: T0 - 1000,
      createdByUserId: CALLER_ID,
      expiresAt: T0 + 10000,
      usedAt: T0 - 500,
      usedByUserId: "users:other",
    };
    const { ctx } = makeCtx({
      customers: [defaultCustomer()],
      invites: [used],
    });
    const thrown = await run(ctx, {
      token: "tok-used-1234",
      password: "longenoughpw",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects expired token", async () => {
    const expired: InviteRow = {
      _id: "portalInvites:i2",
      _creationTime: T0 - 10000,
      customerId: CUSTOMER_ID,
      inviteToken: "tok-expired-1234",
      createdAt: T0 - 10000,
      createdByUserId: CALLER_ID,
      expiresAt: T0 - 1, // already past
    };
    const { ctx } = makeCtx({
      customers: [defaultCustomer()],
      invites: [expired],
    });
    const thrown = await run(ctx, {
      token: "tok-expired-1234",
      password: "longenoughpw",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects too-short password", async () => {
    const ok: InviteRow = {
      _id: "portalInvites:i3",
      _creationTime: T0,
      customerId: CUSTOMER_ID,
      inviteToken: "tok-ok-1234",
      createdAt: T0,
      createdByUserId: CALLER_ID,
      expiresAt: T0 + 10000,
    };
    const { ctx } = makeCtx({
      customers: [defaultCustomer()],
      invites: [ok],
    });
    const thrown = await run(ctx, {
      token: "tok-ok-1234",
      password: "short",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects when an authAccount already exists for the customer's email", async () => {
    const ok: InviteRow = {
      _id: "portalInvites:i4",
      _creationTime: T0,
      customerId: CUSTOMER_ID,
      inviteToken: "tok-dup-1234",
      createdAt: T0,
      createdByUserId: CALLER_ID,
      expiresAt: T0 + 10000,
    };
    const { ctx } = makeCtx({
      customers: [defaultCustomer()],
      invites: [ok],
      authAccountsByEmail: ["maria@example.com"],
    });
    const thrown = await run(ctx, {
      token: "tok-dup-1234",
      password: "longenoughpw",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });
});

describe("portalInvites.acceptPortalInvite — happy path", () => {
  const run = handlerOf(acceptPortalInvite);

  function makeOpenInvite(token = "tok-happy-1234"): InviteRow {
    return {
      _id: "portalInvites:open",
      _creationTime: T0,
      customerId: CUSTOMER_ID,
      inviteToken: token,
      createdAt: T0,
      createdByUserId: CALLER_ID,
      expiresAt: T0 + 100_000,
    };
  }

  it("creates users + authAccounts + userRoles + audit + marks invite used", async () => {
    const invite = makeOpenInvite();
    const { ctx, inserts, patches, invites } = makeCtx({
      customers: [defaultCustomer()],
      invites: [invite],
    });
    const out = (await run(ctx, {
      token: invite.inviteToken,
      password: "longenoughpw",
    })) as { userId: string; email: string };
    expect(out.email).toBe("maria@example.com");
    expect(out.userId).toBeTruthy();

    const userInserts = inserts.filter((i) => i.table === "users");
    const authInserts = inserts.filter((i) => i.table === "authAccounts");
    const roleInserts = inserts.filter((i) => i.table === "userRoles");
    const auditInserts = inserts.filter((i) => i.table === "auditLog");
    expect(userInserts).toHaveLength(1);
    expect(authInserts).toHaveLength(1);
    expect(roleInserts).toHaveLength(1);
    expect(auditInserts).toHaveLength(1);
    expect(roleInserts[0]!.row.role).toBe("customer");
    expect(authInserts[0]!.row.provider).toBe("password");
    expect(authInserts[0]!.row.providerAccountId).toBe("maria@example.com");

    // Single-use enforcement: invite is patched with usedAt + usedByUserId.
    expect(patches).toHaveLength(1);
    expect(patches[0]!.patch.usedAt).toBe(T0);
    const updated = invites.get(invite._id)!;
    expect(updated.usedAt).toBe(T0);
  });

  it("two acceptances of the same token only succeed once (single-use)", async () => {
    const invite = makeOpenInvite("tok-singleuse-1234");
    const { ctx } = makeCtx({
      customers: [defaultCustomer()],
      invites: [invite],
    });
    await run(ctx, {
      token: invite.inviteToken,
      password: "longenoughpw",
    });
    // After the first call the invite is marked used. The mock's
    // authAccounts table still doesn't carry the new account (the
    // accept-invite inserts into authAccounts via ctx.db.insert which
    // our mock captures into `inserts` but does not surface back to
    // the query path) — but the second call would be rejected at the
    // `usedAt !== undefined` gate FIRST, before reaching the account
    // check. Confirm the second call rejects:
    const thrown = await run(ctx, {
      token: invite.inviteToken,
      password: "longenoughpw",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("does NOT log the token in the audit row", async () => {
    const invite = makeOpenInvite("tok-no-leak-1234");
    const { ctx, inserts } = makeCtx({
      customers: [defaultCustomer()],
      invites: [invite],
    });
    await run(ctx, {
      token: invite.inviteToken,
      password: "longenoughpw",
    });
    const audit = inserts.find((i) => i.table === "auditLog");
    const serialised = JSON.stringify(audit?.row ?? {});
    expect(serialised).not.toContain("tok-no-leak-1234");
  });
});

describe("portalInvites.listActiveInvitesForCustomer", () => {
  const run = handlerOf(listActiveInvitesForCustomer);

  it("returns unused invites with isExpired flag", async () => {
    const fresh: InviteRow = {
      _id: "portalInvites:fresh",
      _creationTime: T0,
      customerId: CUSTOMER_ID,
      inviteToken: "tok-fresh-1234",
      createdAt: T0,
      createdByUserId: CALLER_ID,
      expiresAt: T0 + 100_000,
    };
    const stale: InviteRow = {
      _id: "portalInvites:stale",
      _creationTime: T0 - 100_000,
      customerId: CUSTOMER_ID,
      inviteToken: "tok-stale-1234",
      createdAt: T0 - 100_000,
      createdByUserId: CALLER_ID,
      expiresAt: T0 - 1,
    };
    const { ctx } = makeCtx({
      customers: [defaultCustomer()],
      invites: [fresh, stale],
    });
    const out = (await run(ctx, { customerId: CUSTOMER_ID })) as Array<{
      inviteId: string;
      isExpired: boolean;
    }>;
    expect(out.length).toBe(2);
    const freshRow = out.find((r) => r.inviteId === "portalInvites:fresh")!;
    const staleRow = out.find((r) => r.inviteId === "portalInvites:stale")!;
    expect(freshRow.isExpired).toBe(false);
    expect(staleRow.isExpired).toBe(true);
  });

  it("FORBIDDEN for customer-role caller", async () => {
    const { ctx } = makeCtx({
      roles: ["customer"],
      customers: [defaultCustomer()],
    });
    const thrown = await run(ctx, { customerId: CUSTOMER_ID }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});
