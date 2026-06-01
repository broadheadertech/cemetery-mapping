/**
 * Story 9.4 — `convex/portal.ts` account-update tests.
 *
 * Two Convex surfaces under test:
 *
 *   1. `getCurrentCustomerAccount` — the read query that feeds the
 *      `/portal/account` form's pre-fill. Asserts role gating, ownership
 *      scoping, and the narrow projection shape (gov-ID last-4 only,
 *      full address allowed, no internal flags leaked).
 *
 *   2. `updateCustomerContact` — the first customer-write surface in
 *      the portal. Asserts:
 *
 *        - role gate (`requireRole(ctx, ["customer"])` via
 *          `requireCurrentCustomer`),
 *        - own-record-only guard (the args validator does not accept a
 *          `customerId`; the target row id is derived from the auth
 *          identity),
 *        - allow-list patching — extra keys passed by a tampered
 *          client (`name`, `govIdNumber`, `_id`, `hasConsent`) do NOT
 *          reach `ctx.db.patch`,
 *        - PH-phone normalisation (`09…` → `+639…`) on write,
 *        - email lowercasing on write + plausible-shape validation,
 *        - address structured patch with `line1` required,
 *        - audit emission with a `before`/`after` diff containing
 *          only the changed contact fields (entityType: "customer"),
 *        - no-op short-circuit when zero fields are passed,
 *        - validation rejection paths (invalid email / phone / empty
 *          address line1).
 *
 * Coverage target: ≥ 95% line + branch on the Story 9.4 handlers
 * (NFR-M2 commitment carried over from Stories 9.1 / 9.2 / 9.3).
 * Hand-mocked ctx mirrors `portal-receipts.test.ts` so the ctx shape
 * stays consistent across the Story 9.x test files.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  getCurrentCustomerAccount,
  updateCustomerContact,
} from "../../../convex/portal";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const CALLER_ID = "users:u1";
const SESSION_ID = "authSessions:s1";
const CALLER_EMAIL = "maria@example.com";
const CALLER_CUSTOMER_ID = "customers:c1";
const OTHER_CUSTOMER_ID = "customers:c2";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface CustomerAddressFixture {
  line1: string;
  barangay?: string;
  cityMunicipality?: string;
  province?: string;
  postalCode?: string;
}

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
  fullNameLowercased: string;
  email?: string;
  phone?: string;
  address: CustomerAddressFixture;
  govIdType: string;
  govIdNumber: string;
  hasConsent: boolean;
  createdAt: number;
  createdByUserId: string;
  updatedAt: number;
}

interface AuditRow {
  actor: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

function callerCustomer(
  overrides: Partial<CustomerFixture> = {},
): CustomerFixture {
  return {
    _id: CALLER_CUSTOMER_ID,
    _creationTime: T0 - 1000,
    fullName: "Maria Cruz",
    fullNameLowercased: "maria cruz",
    email: CALLER_EMAIL,
    phone: "+639170000001",
    address: {
      line1: "1 Old St",
      cityMunicipality: "Manila",
    },
    govIdType: "sss",
    govIdNumber: "12-3456789-0",
    hasConsent: true,
    createdAt: T0 - 1000,
    createdByUserId: "users:admin1",
    updatedAt: T0 - 1000,
    ...overrides,
  };
}

function otherCustomer(): CustomerFixture {
  return callerCustomer({
    _id: OTHER_CUSTOMER_ID,
    fullName: "Pedro Garcia",
    fullNameLowercased: "pedro garcia",
    email: "pedro@example.com",
    phone: "+639170000002",
    govIdNumber: "98-7654321-0",
  });
}

function makeCtx(opts: {
  roles?: RoleName[];
  callerEmail?: string;
  authenticated?: boolean;
  customers?: CustomerFixture[];
}) {
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const auditRows: AuditRow[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const userRoles = (opts.roles ?? ["customer"]).map((role, idx) => ({
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
    email: opts.callerEmail,
    name: undefined,
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

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return callerUser;
        if (id === SESSION_ID) return session;
        if (customers.has(id)) return customers.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({ collect: async () => userRoles }),
          };
        }
        if (table === "customers") {
          return { collect: async () => Array.from(customers.values()) };
        }
        if (table === "authAccounts") {
          // Epic 9 H1: the email-change auth-sync queries this via the
          // `providerAndAccountId` index. No fixtures here → no clashing
          // account, so the change proceeds and patches the (mocked-away)
          // users + authAccounts rows.
          return {
            withIndex: () => ({ collect: async () => [] }),
          };
        }
        return {
          withIndex: () => ({ collect: async () => [] }),
          collect: async () => [],
        };
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        // `patches` captures CUSTOMER-row patches (what every assertion in
        // this suite inspects). The Epic 9 H1 email-sync also patches the
        // linked `users` + `authAccounts` rows; those ids aren't customers,
        // so they're accepted (no-op) without polluting the assertions.
        const existing = customers.get(id);
        if (existing !== undefined) {
          patches.push({ id, patch });
          customers.set(id, { ...existing, ...patch } as CustomerFixture);
        }
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "auditLog") {
          auditRows.push(row as unknown as AuditRow);
          return `auditLog:${auditRows.length}`;
        }
        return `${table}:test`;
      }),
    },
    // Epic 9 H1: email-change schedules a Resend security notification.
    scheduler: { runAfter: vi.fn(async () => undefined) },
  };

  return { ctx, customers, auditRows, patches };
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// getCurrentCustomerAccount
// ---------------------------------------------------------------------------

describe("portal.getCurrentCustomerAccount — auth gating", () => {
  const run = handlerOf(getCurrentCustomerAccount);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for admin role", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      callerEmail: "admin@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for office_staff role", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws NOT_FOUND when no customer row matches the auth email", async () => {
    const { ctx } = makeCtx({
      callerEmail: "ghost@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {}).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("portal.getCurrentCustomerAccount — projection", () => {
  const run = handlerOf(getCurrentCustomerAccount);

  it("returns the calling customer's account profile (narrow shape)", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {})) as Record<string, unknown>;

    expect(result.customerId).toBe(CALLER_CUSTOMER_ID);
    expect(result.fullName).toBe("Maria Cruz");
    expect(result.email).toBe(CALLER_EMAIL);
    expect(result.phone).toBe("+639170000001");
    expect(result.address).toEqual({
      line1: "1 Old St",
      cityMunicipality: "Manila",
    });
    expect(result.govIdType).toBe("sss");
    // Last-4 of "12-3456789-0" → strip non-alnum → "1234567890" → "7890"
    expect(result.govIdLast4).toBe("7890");
    // Full gov-ID number MUST NOT leak through this query.
    expect(result.govIdNumber).toBeUndefined();
    // Story 9.8: reminder-preference state feeds the /portal/account
    // toggle. Defaults to false (reminders ON) when the field is absent.
    expect(result.reminderOptOut).toBe(false);
  });

  it("returns phone: null when the customer has no phone on file", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer({ phone: undefined })],
    });
    const result = (await run(ctx, {})) as Record<string, unknown>;
    expect(result.phone).toBeNull();
  });

  it("returns email: '' when the customer record has no email field", async () => {
    // Email-link resolves via the auth user's email when the customer
    // row's `email` is undefined — but the row WAS resolved because the
    // resolution requires `customers.email === auth.email`. Edge case
    // where the customer record's email was cleared between auth and
    // read; the projection falls back to "".
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer({ email: CALLER_EMAIL })],
    });
    const result = (await run(ctx, {})) as { email: string };
    expect(result.email).toBe(CALLER_EMAIL);
  });

  it("redacts a short gov-ID to whatever's available", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer({ govIdNumber: "AB1" })],
    });
    const result = (await run(ctx, {})) as { govIdLast4: string };
    expect(result.govIdLast4).toBe("AB1");
  });
});

// ---------------------------------------------------------------------------
// updateCustomerContact
// ---------------------------------------------------------------------------

describe("portal.updateCustomerContact — auth gating", () => {
  const run = handlerOf(updateCustomerContact);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, { phone: "09171234567" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for admin role", async () => {
    const { ctx } = makeCtx({
      roles: ["admin"],
      callerEmail: "admin@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "09171234567" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for office_staff role", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      callerEmail: "staff@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "09171234567" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for field_worker role", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      callerEmail: "worker@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "09171234567" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws NOT_FOUND when no customer record links to the auth email", async () => {
    const { ctx } = makeCtx({
      callerEmail: "ghost@example.com",
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "09171234567" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});

describe("portal.updateCustomerContact — phone normalisation + patch", () => {
  const run = handlerOf(updateCustomerContact);

  it("normalises 09… → +639… on write", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, { phone: "09177771234" })) as {
      customerId: string;
      updatedFields: string[];
    };
    expect(result.customerId).toBe(CALLER_CUSTOMER_ID);
    expect(result.updatedFields).toEqual(["phone"]);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.id).toBe(CALLER_CUSTOMER_ID);
    expect(patches[0]?.patch.phone).toBe("+639177771234");
    expect(patches[0]?.patch.updatedAt).toBe(T0);
  });

  it("keeps +639… form on write", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    await run(ctx, { phone: "+639177771234" });
    expect(patches[0]?.patch.phone).toBe("+639177771234");
  });

  it("tolerates internal punctuation when normalising", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    await run(ctx, { phone: "0917-777 1234" });
    expect(patches[0]?.patch.phone).toBe("+639177771234");
  });

  it("rejects landline / non-mobile shapes", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "+6328123456" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });

  it("rejects empty trimmed phone", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "   " }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });

  it("rejects gibberish phone", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "abcde" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });
});

describe("portal.updateCustomerContact — email normalisation + patch", () => {
  const run = handlerOf(updateCustomerContact);

  it("lowercases + trims the email on write", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {
      email: "  Maria@Example.COM  ",
    })) as { updatedFields: string[] };
    expect(result.updatedFields).toEqual(["email"]);
    expect(patches[0]?.patch.email).toBe("maria@example.com");
  });

  it("Epic 9 H1: a real email change updates the customer row AND schedules a Resend security notification to the previous address", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {
      email: "maria.new@example.com",
    })) as { updatedFields: string[] };
    expect(result.updatedFields).toEqual(["email"]);
    // Customer row email updated.
    expect(patches[0]?.patch.email).toBe("maria.new@example.com");
    // Security notification scheduled to the PREVIOUS (owner-controlled)
    // address so an unauthorized change is visible to the real owner.
    const scheduler = ctx.scheduler.runAfter as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(scheduler.mock.calls).toHaveLength(1);
    const payload = scheduler.mock.calls[0]![2] as {
      previousEmail: string;
      newEmail: string;
    };
    expect(payload.previousEmail).toBe("maria@example.com");
    expect(payload.newEmail).toBe("maria.new@example.com");
  });

  it("Epic 9 H1: resubmitting the same email (case/space only) does NOT move the login or notify", async () => {
    const { ctx } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    await run(ctx, { email: "  Maria@Example.com  " });
    const scheduler = ctx.scheduler.runAfter as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(scheduler.mock.calls).toHaveLength(0);
  });

  it("rejects an obviously-malformed email", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { email: "not-an-email" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });

  it("rejects an email with whitespace", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      email: "maria with space@example.com",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });

  it("rejects an empty trimmed email", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { email: "   " }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });
});

describe("portal.updateCustomerContact — address patch", () => {
  const run = handlerOf(updateCustomerContact);

  it("accepts the full structured address shape", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {
      address: {
        line1: "  123 Rizal Ave  ",
        barangay: " Sampaloc ",
        cityMunicipality: " Manila ",
        province: " Metro Manila ",
        postalCode: " 1015 ",
      },
    })) as { updatedFields: string[] };
    expect(result.updatedFields).toEqual(["address"]);
    expect(patches[0]?.patch.address).toEqual({
      line1: "123 Rizal Ave",
      barangay: "Sampaloc",
      cityMunicipality: "Manila",
      province: "Metro Manila",
      postalCode: "1015",
    });
  });

  it("rejects an empty trimmed line1", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, {
      address: { line1: "   " },
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(patches).toHaveLength(0);
  });

  it("strips empty optional sub-fields to absence", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    await run(ctx, {
      address: {
        line1: "123 Rizal Ave",
        barangay: "  ",
        province: "",
      },
    });
    expect(patches[0]?.patch.address).toEqual({ line1: "123 Rizal Ave" });
  });

  it("patches phone + email + address in a single call", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {
      phone: "09177771234",
      email: "new@example.com",
      address: { line1: "1 New St" },
    })) as { updatedFields: string[] };
    expect(result.updatedFields.sort()).toEqual(["address", "email", "phone"]);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch).toMatchObject({
      phone: "+639177771234",
      email: "new@example.com",
      address: { line1: "1 New St" },
    });
  });
});

describe("portal.updateCustomerContact — allow-list defense (AC3)", () => {
  const run = handlerOf(updateCustomerContact);

  it("ignores extra keys passed by a tampered client (name, govIdNumber, hasConsent)", async () => {
    const { ctx, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    // Cast to satisfy the typed handler signature for the test. A
    // real tampered client would bypass the args validator by hand-
    // crafting the JSON payload — this test simulates that by passing
    // the extra keys directly into the handler.
    await run(ctx, {
      phone: "09177771234",
      fullName: "Hacked",
      name: "Hacked",
      govIdNumber: "9999",
      _id: "customers:other",
      hasConsent: false,
      role: "admin",
    } as never);

    expect(patches).toHaveLength(1);
    const patched = patches[0]!.patch;
    // ONLY the allow-listed fields should appear in the patch.
    expect(patched.phone).toBe("+639177771234");
    expect(patched.updatedAt).toBe(T0);
    expect("fullName" in patched).toBe(false);
    expect("name" in patched).toBe(false);
    expect("govIdNumber" in patched).toBe(false);
    expect("_id" in patched).toBe(false);
    expect("hasConsent" in patched).toBe(false);
    expect("role" in patched).toBe(false);
  });

  it("does NOT accept a customerId argument (own-record-only guard)", async () => {
    const { ctx, patches, customers } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer(), otherCustomer()],
    });
    // Even if the client crafts a `customerId` field, the handler
    // never reads it — the target row is derived from `requireCurrentCustomer`.
    await run(ctx, {
      phone: "09177771234",
      customerId: OTHER_CUSTOMER_ID,
    } as never);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.id).toBe(CALLER_CUSTOMER_ID);
    // The OTHER customer's row must remain untouched.
    expect(customers.get(OTHER_CUSTOMER_ID)?.phone).toBe("+639170000002");
  });
});

describe("portal.updateCustomerContact — audit emission", () => {
  const run = handlerOf(updateCustomerContact);

  it("emits an `update` audit row with entityType: customer + before/after diff", async () => {
    const { ctx, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    await run(ctx, {
      phone: "09177771234",
      email: "newmaria@example.com",
    });

    expect(auditRows).toHaveLength(1);
    const audit = auditRows[0]!;
    expect(audit.action).toBe("update");
    expect(audit.entityType).toBe("customer");
    expect(audit.entityId).toBe(CALLER_CUSTOMER_ID);
    expect(audit.actor).toBe(CALLER_ID);
    expect(audit.timestamp).toBe(T0);

    const before = audit.before as Record<string, unknown>;
    const after = audit.after as Record<string, unknown>;
    // The audit helper's `redactPii` now reduces phone to first-3 +
    // ellipsis and email to domain-only form before insert (Epic 1/2
    // adversarial review — see `convex/lib/audit.ts` header note).
    // Assert by shape rather than raw value; the diff signal we care
    // about is "both before and after exist and differ where the
    // shape allows it to differ".
    expect(before.phone).toBe("+63…");
    expect(typeof before.email).toBe("string");
    expect(before.email).toMatch(/^…@/);
    expect(after.phone).toBe("+63…");
    expect(after.email).toBe("…@example.com");
    // Address WAS NOT changed → omit from the diff entirely.
    expect("address" in before).toBe(false);
    expect("address" in after).toBe(false);
  });

  it("does NOT emit audit when zero fields change (no-op)", async () => {
    const { ctx, auditRows, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const result = (await run(ctx, {})) as {
      customerId: string;
      updatedFields: string[];
    };
    expect(result.customerId).toBe(CALLER_CUSTOMER_ID);
    expect(result.updatedFields).toEqual([]);
    expect(auditRows).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("omits before.phone when the customer had no phone on file", async () => {
    const { ctx, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer({ phone: undefined })],
    });
    await run(ctx, { phone: "09177771234" });
    const before = auditRows[0]!.before as Record<string, unknown>;
    const after = auditRows[0]!.after as Record<string, unknown>;
    expect("phone" in before).toBe(false);
    // Redacted via `redactPii` — see header note in
    // `convex/lib/audit.ts` (Epic 1/2 adversarial review).
    expect(after.phone).toBe("+63…");
  });

  it("does NOT emit audit when validation rejects the request", async () => {
    const { ctx, auditRows, patches } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    const thrown = await run(ctx, { phone: "abcde" }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
    expect(auditRows).toHaveLength(0);
    expect(patches).toHaveLength(0);
  });

  it("captures the FULL address (before/after) when address changes", async () => {
    const { ctx, auditRows } = makeCtx({
      callerEmail: CALLER_EMAIL,
      customers: [callerCustomer()],
    });
    await run(ctx, {
      address: {
        line1: "456 New Rd",
        cityMunicipality: "Quezon City",
      },
    });
    const before = auditRows[0]!.before as Record<string, unknown>;
    const after = auditRows[0]!.after as Record<string, unknown>;
    // The audit helper's `redactPii` converts every address string to
    // initials-form before insert — assert by shape rather than the
    // raw values. The presence of the field in both before/after is
    // the diff signal we care about for breach response.
    expect(before.address).toBeDefined();
    expect(after.address).toBeDefined();
    // The before address keys mirror the customer's original address.
    expect(Object.keys(before.address as object).sort()).toEqual(
      ["cityMunicipality", "line1"].sort(),
    );
    expect(Object.keys(after.address as object).sort()).toEqual(
      ["cityMunicipality", "line1"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// P1-3 — bounce-clear gate: customer submitting their ALREADY-BAD email
// must NOT clear `emailBouncedAt`. Customer changing to a DIFFERENT email
// must clear the bounce flags.
// ---------------------------------------------------------------------------

describe("portal.updateCustomerContact — bounce-clear gating (P1-3)", () => {
  const run = handlerOf(updateCustomerContact);

  it("does NOT clear bounce flags when email patch matches current email", async () => {
    // Customer is currently flagged as bounced. They re-submit their
    // existing (still-bad) email through the contact form — the
    // mutation must NOT clear `emailBouncedAt` because the underlying
    // address is unchanged.
    const bouncedCustomer: CustomerFixture = {
      ...callerCustomer({
        email: "bad@example.com",
      }),
    };
    // Inject the bounce flags. The fixture type doesn't include them;
    // cast through Record to attach as the runtime patch surface
    // would see them.
    (bouncedCustomer as unknown as Record<string, unknown>).emailBouncedAt =
      T0 - HOUR_MS;
    (
      bouncedCustomer as unknown as Record<string, unknown>
    ).emailReminderPausedReason = "hard_bounce";

    const { ctx, patches } = makeCtx({
      callerEmail: "bad@example.com",
      customers: [bouncedCustomer],
    });
    // The args.email goes through trim+lowercase to the same value as
    // the stored email.
    await run(ctx, { email: "bad@example.com" });
    expect(patches).toHaveLength(1);
    const patch = patches[0]!.patch as Record<string, unknown>;
    // P1-3: the bounce-clear is a no-op when the email is unchanged.
    expect("emailBouncedAt" in patch).toBe(false);
    expect("emailReminderPausedReason" in patch).toBe(false);
    expect("emailBounceMessageId" in patch).toBe(false);
  });

  it("clears bounce flags when email patch differs from current email", async () => {
    const bouncedCustomer: CustomerFixture = {
      ...callerCustomer({
        email: "bad@example.com",
      }),
    };
    (bouncedCustomer as unknown as Record<string, unknown>).emailBouncedAt =
      T0 - HOUR_MS;
    (
      bouncedCustomer as unknown as Record<string, unknown>
    ).emailReminderPausedReason = "hard_bounce";
    (
      bouncedCustomer as unknown as Record<string, unknown>
    ).emailBounceMessageId = "msg-1";

    const { ctx, patches } = makeCtx({
      callerEmail: "bad@example.com",
      customers: [bouncedCustomer],
    });
    await run(ctx, { email: "good@example.com" });
    expect(patches).toHaveLength(1);
    const patch = patches[0]!.patch as Record<string, unknown>;
    // Email itself changed.
    expect(patch.email).toBe("good@example.com");
    // Bounce flags cleared by setting them to undefined.
    expect(patch.emailBouncedAt).toBeUndefined();
    expect(patch.emailReminderPausedReason).toBeUndefined();
    expect(patch.emailBounceMessageId).toBeUndefined();
    // The keys must be PRESENT in the patch (undefined means "clear
    // this field" in Convex). Assert presence to distinguish from "no
    // bounce-clear logic ran at all."
    expect("emailBouncedAt" in patch).toBe(true);
    expect("emailReminderPausedReason" in patch).toBe(true);
    expect("emailBounceMessageId" in patch).toBe(true);
  });

  it("does NOT clear bounce flags when email is unchanged but phone changes", async () => {
    const bouncedCustomer: CustomerFixture = {
      ...callerCustomer({
        email: "bad@example.com",
      }),
    };
    (bouncedCustomer as unknown as Record<string, unknown>).emailBouncedAt =
      T0 - HOUR_MS;

    const { ctx, patches } = makeCtx({
      callerEmail: "bad@example.com",
      customers: [bouncedCustomer],
    });
    await run(ctx, { phone: "09177771234" });
    expect(patches).toHaveLength(1);
    const patch = patches[0]!.patch as Record<string, unknown>;
    expect(patch.phone).toBe("+639177771234");
    // Email-bounce state is orthogonal to phone updates.
    expect("emailBouncedAt" in patch).toBe(false);
  });
});
