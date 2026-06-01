/**
 * Story 2.4 — `convex/dataSubject.ts` unit tests.
 *
 * Same hand-mocked-ctx pattern as `customers.test.ts` (Story 2.1) and
 * `piiAccess.test.ts` (Story 2.3). `convex-test` requires
 * `convex/_generated/` which isn't built in this repo; the hand-mock
 * gives us the four collaborator surfaces we need:
 *
 *   - `requireRole` chain — `auth.getUserIdentity`, `db.get(userId)`,
 *     `db.get(sessionId)`, `db.query("userRoles").withIndex(...).collect()`.
 *   - `customers` row lookup — `db.get(customerId)`.
 *   - `auditLog` table reads — `db.query("auditLog").withIndex("by_entity", ...).collect()`
 *     and `db.query("auditLog").withIndex("by_actor", ...).collect()`.
 *   - `auditLog` insert (the self-log from `logPiiAccess`) —
 *     `db.insert("auditLog", row)`.
 *
 * Coverage focus:
 *   - AC1 RBAC: non-admin → FORBIDDEN; unauthenticated → UNAUTHENTICATED.
 *   - AC5 reason validation: < 10 chars → VALIDATION (no other side
 *     effects: no audit row, no DB read).
 *   - AC7 missing customer: NOT_FOUND, NO piiAccess audit row.
 *   - AC3 aggregation: returns the full customer document, the
 *     customer-scoped audit trail, AND the piiAccess-scoped trail.
 *   - AC5 self-logging: exactly one new piiAccess audit row written
 *     per successful invocation; reason stamped on it.
 *   - Schema-version literal carried through.
 *   - Follow-up domains are flagged.
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
  produceDataSubjectReport,
  DATA_SUBJECT_REPORT_SCHEMA_VERSION,
  REPORT_REASON_MIN_LENGTH,
  type DataSubjectReport,
} from "../../../convex/dataSubject";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-06-01T08:00:00+08:00").getTime();
const ADMIN_ID = "users:admin1";
const SESSION_ID = "authSessions:s1";
const CUSTOMER_ID = "customers:cust1";

const VALID_REASON =
  "DSR ticket #2026-0042 received via email from Mrs. Cruz on 2026-05-19.";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface UserFixture {
  _id: string;
  _creationTime: number;
  name?: string;
  email?: string;
  isActive?: boolean;
}

interface UserRoleFixture {
  _id: string;
  _creationTime: number;
  userId: string;
  role: RoleName;
  grantedAt: number;
  grantedBy: string;
}

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
  fullNameLowercased: string;
  phone?: string;
  email?: string;
  address: {
    line1: string;
    barangay?: string;
    cityMunicipality?: string;
    province?: string;
    postalCode?: string;
  };
  govIdType: string;
  govIdNumber: string;
  relationshipToOccupant?: string;
  hasConsent: boolean;
  consentTimestamp?: number;
  consentCapturedByUserId?: string;
  createdAt: number;
  createdByUserId: string;
  updatedAt: number;
}

interface AuditFixture {
  _id: string;
  _creationTime: number;
  actor: string;
  timestamp: number;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

interface CtxBag {
  customers: Map<string, CustomerFixture>;
  audits: Map<string, AuditFixture>;
  inserts: AuditFixture[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

const VALID_CUSTOMER: CustomerFixture = {
  _id: CUSTOMER_ID,
  _creationTime: T0 - 10_000,
  fullName: "Maria Cruz",
  fullNameLowercased: "maria cruz",
  phone: "09171234567",
  email: "maria@example.com",
  address: {
    line1: "123 Main St",
    barangay: "Poblacion",
    cityMunicipality: "Quezon City",
    province: "Metro Manila",
    postalCode: "1100",
  },
  govIdType: "sss",
  govIdNumber: "1234-5678-9012",
  relationshipToOccupant: "spouse",
  hasConsent: true,
  consentTimestamp: T0 - 5000,
  consentCapturedByUserId: ADMIN_ID,
  createdAt: T0 - 10_000,
  createdByUserId: ADMIN_ID,
  updatedAt: T0 - 5_000,
};

function makeCtx(opts: {
  roles?: RoleName[];
  authenticated?: boolean;
  callerIsActive?: boolean;
  initialCustomers?: CustomerFixture[];
  initialAudits?: AuditFixture[];
}): CtxBag {
  const users = new Map<string, UserFixture>();
  const userRoles = new Map<string, UserRoleFixture>();
  const customers = new Map<string, CustomerFixture>(
    (opts.initialCustomers ?? [VALID_CUSTOMER]).map((c) => [c._id, c]),
  );
  const audits = new Map<string, AuditFixture>(
    (opts.initialAudits ?? []).map((a) => [a._id, a]),
  );
  const inserts: AuditFixture[] = [];

  users.set(ADMIN_ID, {
    _id: ADMIN_ID,
    _creationTime: T0 - 1000,
    name: "Maria Reyes",
    email: "maria@example.com",
    isActive: opts.callerIsActive !== false,
  });
  const roles = opts.roles ?? ["admin"];
  roles.forEach((role, idx) => {
    const rid = `userRoles:caller-${idx}`;
    userRoles.set(rid, {
      _id: rid,
      _creationTime: T0,
      userId: ADMIN_ID,
      role,
      grantedAt: T0,
      grantedBy: ADMIN_ID,
    });
  });

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(ADMIN_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: ADMIN_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };

  let nextAuditNum = 1;

  type Predicate = (r: AuditFixture) => boolean;

  function makeAuditBuilder() {
    const predicates: Predicate[] = [];
    const builder = {
      withIndex(_name: string, fn: (q: IdxQuery) => IdxQuery) {
        const q: IdxQuery = {
          eq(field: string, value: unknown) {
            predicates.push(
              (r) =>
                (r as unknown as Record<string, unknown>)[field] === value,
            );
            return this;
          },
        };
        fn(q);
        return builder;
      },
      async collect(): Promise<AuditFixture[]> {
        return Array.from(audits.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
    };
    return builder;
  }

  interface IdxQuery {
    eq(field: string, value: unknown): IdxQuery;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === ADMIN_ID) return users.get(ADMIN_ID);
        if (id === SESSION_ID) return session;
        if (users.has(id)) return users.get(id);
        if (customers.has(id)) return customers.get(id);
        if (audits.has(id)) return audits.get(id);
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: () => ({
              collect: async () => Array.from(userRoles.values()),
            }),
          };
        }
        if (table === "auditLog") {
          return makeAuditBuilder();
        }
        return {
          withIndex: () => ({
            collect: async () => [],
          }),
        };
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        if (table === "auditLog") {
          const id = `auditLog:new${nextAuditNum++}`;
          const audit: AuditFixture = {
            _id: id,
            _creationTime: T0,
            ...(row as Omit<AuditFixture, "_id" | "_creationTime">),
          };
          audits.set(id, audit);
          inserts.push(audit);
          return id;
        }
        return `${table}:?`;
      }),
    },
  };

  return { customers, audits, inserts, ctx };
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

describe("produceDataSubjectReport — auth gating (AC1)", () => {
  const run = handlerOf(produceDataSubjectReport);

  it("throws UNAUTHENTICATED when no session", async () => {
    const { ctx } = makeCtx({ authenticated: false });
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws FORBIDDEN for office_staff", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for field_worker", async () => {
    const { ctx } = makeCtx({ roles: ["field_worker"] });
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("throws FORBIDDEN for customer role", async () => {
    const { ctx } = makeCtx({ roles: ["customer"] });
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("does not write any audit row when role check fails", async () => {
    const { ctx, inserts } = makeCtx({ roles: ["office_staff"] });
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch(() => undefined);
    expect(inserts).toHaveLength(0);
  });
});

describe("produceDataSubjectReport — reason validation (AC5)", () => {
  const run = handlerOf(produceDataSubjectReport);

  it("rejects an empty reason with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: "",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a whitespace-only reason with VALIDATION", async () => {
    const { ctx } = makeCtx({});
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: "    ",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("rejects a reason shorter than the minimum length", async () => {
    const { ctx } = makeCtx({});
    const shortReason = "a".repeat(REPORT_REASON_MIN_LENGTH - 1);
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: shortReason,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("does not call db.get(customerId) when the reason is invalid", async () => {
    // AC: short reasons must reject BEFORE customer lookup so an
    // attacker can't probe existence via "junk reason" rejections.
    const { ctx } = makeCtx({});
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: "short",
    }).catch(() => undefined);
    // ctx.db.get is called by requireRole for the caller's user record
    // and session record (2 calls). It should NOT be called for the
    // customer row.
    const calls = (ctx.db.get as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(calls).not.toContain(CUSTOMER_ID);
  });

  it("does not write a self-log when the reason is invalid", async () => {
    const { ctx, inserts } = makeCtx({});
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: "nope",
    }).catch(() => undefined);
    expect(inserts).toHaveLength(0);
  });
});

describe("produceDataSubjectReport — missing customer (AC7)", () => {
  const run = handlerOf(produceDataSubjectReport);

  it("throws NOT_FOUND when the customer doesn't exist", async () => {
    const { ctx } = makeCtx({ initialCustomers: [] });
    const thrown = await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("does NOT write a piiAccess audit row on NOT_FOUND", async () => {
    // Critical AC7: logging a search for a non-existent subject leaks
    // info ("Cruz was searched for at 3PM but isn't a customer").
    const { ctx, inserts } = makeCtx({ initialCustomers: [] });
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    }).catch(() => undefined);
    expect(inserts).toHaveLength(0);
  });
});

describe("produceDataSubjectReport — happy path (AC3, AC4, AC5)", () => {
  const run = handlerOf(produceDataSubjectReport);

  it("returns a fully populated report for a real customer", async () => {
    const { ctx } = makeCtx({});
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    expect(report.schemaVersion).toBe(DATA_SUBJECT_REPORT_SCHEMA_VERSION);
    expect(report.generatedAt).toBe(T0);
    expect(report.generatedByUserId).toBe(ADMIN_ID);
    expect(report.reason).toBe(VALID_REASON);
    expect(report.customer.customerId).toBe(CUSTOMER_ID);
    expect(report.customer.fullName).toBe("Maria Cruz");
    expect(report.customer.govIdNumber).toBe("1234-5678-9012");
    expect(report.customer.phone).toBe("09171234567");
    expect(report.customer.email).toBe("maria@example.com");
    expect(report.customer.address.line1).toBe("123 Main St");
    expect(report.customer.address.barangay).toBe("Poblacion");
    expect(report.customer.hasConsent).toBe(true);
    expect(report.customer.consentTimestamp).toBe(T0 - 5000);
  });

  it("trims the reason before persisting it to the report", async () => {
    const { ctx } = makeCtx({});
    const padded = `   ${VALID_REASON}   `;
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: padded,
    })) as DataSubjectReport;
    expect(report.reason).toBe(VALID_REASON);
  });

  it("normalises optional PII fields to null when absent", async () => {
    // Sparse legacy customer: no phone / email / consentTimestamp /
    // relationshipToOccupant. The report must surface them as nullable
    // explicit nulls, not `undefined`, so downstream JSON tooling
    // (jq, custom parsers) handles the absence uniformly.
    const sparse: CustomerFixture = {
      ...VALID_CUSTOMER,
      _id: "customers:sparse",
      fullName: "Anonymous Subject",
      phone: undefined,
      email: undefined,
      relationshipToOccupant: undefined,
      consentTimestamp: undefined,
      consentCapturedByUserId: undefined,
      address: {
        line1: "Old book entry 1987",
      },
    };
    const { ctx } = makeCtx({ initialCustomers: [sparse] });
    const report = (await run(ctx, {
      customerId: sparse._id,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    expect(report.customer.phone).toBeNull();
    expect(report.customer.email).toBeNull();
    expect(report.customer.relationshipToOccupant).toBeNull();
    expect(report.customer.consentTimestamp).toBeNull();
    expect(report.customer.consentCapturedByUserId).toBeNull();
    expect(report.customer.address.barangay).toBeNull();
    expect(report.customer.address.cityMunicipality).toBeNull();
    expect(report.customer.address.province).toBeNull();
    expect(report.customer.address.postalCode).toBeNull();
  });

  it("flags every deferred follow-up domain", async () => {
    const { ctx } = makeCtx({});
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    const sources = report.followUps.map((f) => f.source);
    expect(sources).toContain("customerDocuments");
    expect(sources).toContain("ownerships");
    expect(sources).toContain("contracts");
    expect(sources).toContain("payments");
    expect(sources).toContain("receipts");
    expect(report.followUps.every((f) => f.status === "deferred")).toBe(true);
  });

  it("includes empty arrays for not-yet-implemented domains", async () => {
    const { ctx } = makeCtx({});
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    expect(report.attachments).toEqual([]);
    expect(report.ownerships).toEqual([]);
    expect(report.contracts).toEqual([]);
    expect(report.payments).toEqual([]);
    expect(report.receipts).toEqual([]);
  });
});

describe("produceDataSubjectReport — audit trail aggregation (AC3)", () => {
  const run = handlerOf(produceDataSubjectReport);

  function makeAudit(overrides: Partial<AuditFixture>): AuditFixture {
    return {
      _id: overrides._id ?? "auditLog:seed",
      _creationTime: T0,
      actor: overrides.actor ?? ADMIN_ID,
      timestamp: overrides.timestamp ?? T0 - 1000,
      action: overrides.action ?? "create",
      entityType: overrides.entityType ?? "customer",
      entityId: overrides.entityId ?? CUSTOMER_ID,
      ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    };
  }

  it("includes audit rows where entityType=customer and entityId=customerId", async () => {
    const seed = makeAudit({
      _id: "auditLog:seed1",
      timestamp: T0 - 2000,
      action: "create",
      entityType: "customer",
      entityId: CUSTOMER_ID,
      reason: "Initial customer record creation.",
    });
    const { ctx } = makeCtx({ initialAudits: [seed] });
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    const seedHit = report.customerAuditTrail.find(
      (e) => e.auditLogId === "auditLog:seed1",
    );
    expect(seedHit).toBeDefined();
    expect(seedHit?.action).toBe("create");
    expect(seedHit?.entityType).toBe("customer");
    expect(seedHit?.reason).toBe("Initial customer record creation.");
  });

  it("includes piiAccess audit rows for the canonical customer ref", async () => {
    const piiSeed = makeAudit({
      _id: "auditLog:pii1",
      timestamp: T0 - 1500,
      action: "read_pii",
      entityType: "piiAccess",
      entityId: `customer:${CUSTOMER_ID}`,
      reason: "customer detail page open",
    });
    const { ctx } = makeCtx({ initialAudits: [piiSeed] });
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    const piiHit = report.customerAuditTrail.find(
      (e) => e.auditLogId === "auditLog:pii1",
    );
    expect(piiHit).toBeDefined();
    expect(piiHit?.entityType).toBe("piiAccess");
    expect(piiHit?.entityId).toBe(`customer:${CUSTOMER_ID}`);
  });

  it("does NOT include audit rows about other customers", async () => {
    // Critical: the aggregation must strictly filter by this
    // customer's id. A row about customer X must never leak into
    // customer Y's report.
    const other = makeAudit({
      _id: "auditLog:other",
      timestamp: T0 - 500,
      action: "create",
      entityType: "customer",
      entityId: "customers:other",
      reason: "Different customer entirely.",
    });
    const { ctx } = makeCtx({ initialAudits: [other] });
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    const leak = report.customerAuditTrail.find(
      (e) => e.auditLogId === "auditLog:other",
    );
    expect(leak).toBeUndefined();
  });

  it("sorts the merged audit trail ascending by timestamp", async () => {
    const earlier = makeAudit({
      _id: "auditLog:early",
      timestamp: T0 - 5000,
      action: "create",
      entityType: "customer",
      entityId: CUSTOMER_ID,
    });
    const later = makeAudit({
      _id: "auditLog:late",
      timestamp: T0 - 1000,
      action: "update",
      entityType: "customer",
      entityId: CUSTOMER_ID,
    });
    // Insert in reverse order so we can be sure the sort runs.
    const { ctx } = makeCtx({ initialAudits: [later, earlier] });
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    const trail = report.customerAuditTrail;
    // Without the self-event, we'd have early -> late. With the
    // self-event at the tail, we have early -> late -> self.
    expect(trail[0]?.auditLogId).toBe("auditLog:early");
    expect(trail[1]?.auditLogId).toBe("auditLog:late");
    expect(trail[trail.length - 1]?.action).toBe("read_pii");
  });

  it("returns an empty actsByCustomer array (Phase 1 — no portal accounts)", async () => {
    const { ctx } = makeCtx({});
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    expect(report.actsByCustomer).toEqual([]);
  });
});

describe("produceDataSubjectReport — self-logging invariant (AC5)", () => {
  const run = handlerOf(produceDataSubjectReport);

  it("writes exactly one new piiAccess audit row per invocation", async () => {
    const { ctx, inserts } = makeCtx({});
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]!;
    expect(row.action).toBe("read_pii");
    expect(row.entityType).toBe("piiAccess");
    expect(row.entityId).toBe(`customer:${CUSTOMER_ID}`);
  });

  it("stamps the (trimmed) reason on the self-log audit row", async () => {
    const { ctx, inserts } = makeCtx({});
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: `   ${VALID_REASON}   `,
    });
    expect(inserts[0]!.reason).toBe(VALID_REASON);
  });

  it("records 'full_record' under fieldsRead on the self-log", async () => {
    const { ctx, inserts } = makeCtx({});
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    });
    const after = inserts[0]!.after as { fieldsRead: string[] };
    expect(after.fieldsRead).toEqual(["full_record"]);
  });

  it("attributes the audit row to the calling admin", async () => {
    const { ctx, inserts } = makeCtx({});
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    });
    expect(inserts[0]!.actor).toBe(ADMIN_ID);
  });

  it("uses the current timestamp on the self-log", async () => {
    const { ctx, inserts } = makeCtx({});
    vi.setSystemTime(T0 + 7777);
    await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    });
    expect(inserts[0]!.timestamp).toBe(T0 + 7777);
  });
});

describe("produceDataSubjectReport — self-event tail (AC3)", () => {
  const run = handlerOf(produceDataSubjectReport);

  it("places a synthesized self-event at the tail of the customer audit trail", async () => {
    const { ctx } = makeCtx({});
    const report = (await run(ctx, {
      customerId: CUSTOMER_ID,
      reason: VALID_REASON,
    })) as DataSubjectReport;
    const tail =
      report.customerAuditTrail[report.customerAuditTrail.length - 1];
    expect(tail).toBeDefined();
    expect(tail?.action).toBe("read_pii");
    expect(tail?.entityType).toBe("piiAccess");
    expect(tail?.entityId).toBe(`customer:${CUSTOMER_ID}`);
    expect(tail?.reason).toBe(VALID_REASON);
    expect(tail?.actorUserId).toBe(ADMIN_ID);
  });
});
