/**
 * `convex/readiness.ts` unit tests.
 *
 * This page will be read by someone deciding whether it is safe to
 * start taking money, so the properties worth pinning are the ones
 * that make it trustworthy rather than decorative:
 *
 *   - it never leaks a secret value while reporting on secrets,
 *   - "blocking" means something — it is reserved for cases where the
 *     cemetery genuinely cannot operate,
 *   - and it admits what it cannot see instead of showing a green tick
 *     it has not earned.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ErrorPayload } from "../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { getReadinessReport } from "../../../convex/readiness";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-08-23T12:00:00+08:00").getTime();
const DAY = 24 * 60 * 60 * 1000;
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:sess1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface Tables {
  paymentGatewayConfig?: Record<string, unknown>[];
  birReceiptConfig?: Record<string, unknown>[];
  perpetualCarePolicy?: Record<string, unknown>[];
  lots?: Record<string, unknown>[];
  errorLog?: Record<string, unknown>[];
  enquiries?: Record<string, unknown>[];
}

function makeCtx(opts: { roles?: RoleName[]; tables?: Tables } = {}) {
  const tables = opts.tables ?? {};

  mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const user = { _id: USER_ID, _creationTime: T0, email: "a@b.test" };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 3_600_000,
  };
  const userRoles = (opts.roles ?? ["admin"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  interface IndexQuery {
    eqs: Record<string, unknown>;
    eq(field: string, value: unknown): IndexQuery;
  }

  function builderFor(table: keyof Tables) {
    const predicates: Array<(r: Record<string, unknown>) => boolean> = [];
    const rows = (): Record<string, unknown>[] => tables[table] ?? [];
    const builder = {
      withIndex(_n: string, fn?: (q: IndexQuery) => IndexQuery) {
        if (fn !== undefined) {
          const q: IndexQuery = {
            eqs: {},
            eq(field, value) {
              this.eqs[field] = value;
              return this;
            },
          };
          fn(q);
          for (const [field, value] of Object.entries(q.eqs)) {
            predicates.push((r) => r[field] === value);
          }
        }
        return builder;
      },
      order() {
        return builder;
      },
      async first() {
        return (
          rows().find((r) => predicates.every((p) => p(r))) ?? null
        );
      },
      async take(n: number) {
        return rows()
          .filter((r) => predicates.every((p) => p(r)))
          .slice(0, n);
      },
      async collect() {
        return rows().filter((r) => predicates.every((p) => p(r)));
      },
    };
    return builder;
  }

  return {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        return null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        return builderFor(table as keyof Tables);
      }),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<unknown> {
  for (const key of ["_handler", "handler", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler");
}

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

interface Check {
  id: string;
  status: "ready" | "warning" | "blocking" | "unknown";
  detail: string;
  action?: string;
}
interface Report {
  checks: Check[];
  summary: Record<string, number>;
}

const run = handlerOf(getReadinessReport);

const ENV_KEYS = [
  "GCASH_API_BASE_URL",
  "GCASH_API_KEY",
  "GCASH_WEBHOOK_SECRET",
  "MAYA_API_BASE_URL",
  "CARD_API_BASE_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "RESEND_FROM",
  "PORTAL_URL",
  "ENQUIRY_NOTIFY_TO",
  "EMAIL_WEBHOOK_SECRET",
  "ARCHIVE_S3_BUCKET",
  "ARCHIVE_S3_REGION",
  "ARCHIVE_S3_ACCESS_KEY",
  "ARCHIVE_S3_SECRET_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

function check(report: Report, id: string): Check {
  const found = report.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check with id ${id}`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getReadinessReport — access", () => {
  it("is admin-only", async () => {
    const ctx = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await run(ctx, {});
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });
});

describe("getReadinessReport — never leaks a value", () => {
  it("reports on secrets without including any of them", async () => {
    // The page reports on API keys and signing secrets. If it ever
    // returned one, it would be a worse problem than the gap it exists
    // to surface.
    process.env.GCASH_API_BASE_URL = "https://gw.example/v1";
    process.env.GCASH_API_KEY = "sk_live_SUPERSECRET";
    process.env.GCASH_WEBHOOK_SECRET = "whsec_ALSOSECRET";
    process.env.RESEND_API_KEY = "re_SECRETKEY";
    process.env.ARCHIVE_S3_SECRET_KEY = "s3_SECRETKEY";

    const report = (await run(makeCtx(), {})) as Report;
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("SUPERSECRET");
    expect(serialised).not.toContain("ALSOSECRET");
    expect(serialised).not.toContain("re_SECRETKEY");
    expect(serialised).not.toContain("s3_SECRETKEY");
  });
});

describe("getReadinessReport — blocking means blocking", () => {
  it("flags an unconfigured deployment's real blockers", async () => {
    const report = (await run(makeCtx(), {})) as Report;
    expect(check(report, "gateway-any").status).toBe("blocking");
    expect(check(report, "bir-config").status).toBe("blocking");
    expect(check(report, "perpetual-care").status).toBe("blocking");
    expect(check(report, "archival-export").status).toBe("blocking");
    expect(check(report, "email-provider").status).toBe("blocking");
  });

  it("treats a live gateway with no webhook secret as blocking", async () => {
    // The most expensive misconfiguration in the system: customers can
    // pay and nothing is recorded, silently.
    const ctx = makeCtx({
      tables: {
        paymentGatewayConfig: [
          {
            gateway: "gcash",
            apiBaseUrl: "https://gw.example/v1",
            apiKey: "sk",
            webhookSecret: "",
            isEnabled: true,
            mode: "live",
          },
        ],
      },
    });
    const report = (await run(ctx, {})) as Report;
    const webhook = check(report, "gateway-gcash-webhook");
    expect(webhook.status).toBe("blocking");
    expect(webhook.detail).toMatch(/will not be recorded/i);
  });

  it("does not raise the webhook check for a gateway that is switched off", async () => {
    const ctx = makeCtx({
      tables: {
        paymentGatewayConfig: [
          {
            gateway: "gcash",
            apiBaseUrl: "https://gw.example/v1",
            apiKey: "sk",
            webhookSecret: "",
            isEnabled: false,
            mode: "live",
          },
        ],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(
      report.checks.find((c) => c.id === "gateway-gcash-webhook"),
    ).toBeUndefined();
  });

  it("clears the payment blocker once one gateway is live", async () => {
    const ctx = makeCtx({
      tables: {
        paymentGatewayConfig: [
          {
            gateway: "maya",
            apiBaseUrl: "https://maya.example/v1",
            apiKey: "sk",
            webhookSecret: "whsec",
            isEnabled: true,
            mode: "live",
          },
        ],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "gateway-any").status).toBe("ready");
    // A single unconfigured gateway is a warning, not a blocker — a
    // cemetery may deliberately offer only one online method.
    expect(check(report, "gateway-gcash").status).toBe("warning");
  });

  it("clears the compliance blockers when the configs leave placeholder mode", async () => {
    const ctx = makeCtx({
      tables: {
        birReceiptConfig: [
          {
            isPlaceholder: false,
            atpNumber: "ATP-123",
            atpExpiryDate: T0 + 365 * DAY,
          },
        ],
        perpetualCarePolicy: [{ isPlaceholder: false, type: "one_time" }],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "bir-config").status).toBe("ready");
    expect(check(report, "perpetual-care").status).toBe("ready");
  });
});

describe("getReadinessReport — the ATP clock", () => {
  it("warns as the Authority to Print approaches expiry", async () => {
    const ctx = makeCtx({
      tables: {
        birReceiptConfig: [
          {
            isPlaceholder: false,
            atpNumber: "ATP-123",
            atpExpiryDate: T0 + 30 * DAY,
          },
        ],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "bir-atp-expiry").status).toBe("warning");
  });

  it("blocks once it has expired — receipts issued under it are invalid", async () => {
    const ctx = makeCtx({
      tables: {
        birReceiptConfig: [
          {
            isPlaceholder: false,
            atpNumber: "ATP-123",
            atpExpiryDate: T0 - 5 * DAY,
          },
        ],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "bir-atp-expiry").status).toBe("blocking");
  });

  it("stays quiet when expiry is comfortably away", async () => {
    const ctx = makeCtx({
      tables: {
        birReceiptConfig: [
          {
            isPlaceholder: false,
            atpNumber: "ATP-123",
            atpExpiryDate: T0 + 365 * DAY,
          },
        ],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(
      report.checks.find((c) => c.id === "bir-atp-expiry"),
    ).toBeUndefined();
  });
});

describe("getReadinessReport — communications", () => {
  it("clears the email blocker once Resend is configured", async () => {
    process.env.RESEND_API_KEY = "re_x";
    process.env.EMAIL_FROM = "office@example.ph";
    const report = (await run(makeCtx(), {})) as Report;
    expect(check(report, "email-provider").status).toBe("ready");
  });

  it("accepts RESEND_FROM as an alternative sender variable", async () => {
    process.env.RESEND_API_KEY = "re_x";
    process.env.RESEND_FROM = "office@example.ph";
    const report = (await run(makeCtx(), {})) as Report;
    expect(check(report, "email-provider").status).toBe("ready");
  });

  it("warns that reminder links are dead without PORTAL_URL", async () => {
    const report = (await run(makeCtx(), {})) as Report;
    const portal = check(report, "portal-url");
    expect(portal.status).toBe("warning");
    expect(portal.detail).toMatch(/portal\.example\.ph/);
  });

  it("warns that enquiries reach nobody without a notify address", async () => {
    const report = (await run(makeCtx(), {})) as Report;
    expect(check(report, "enquiry-notify").status).toBe("warning");
  });
});

describe("getReadinessReport — data and operations", () => {
  it("treats a handful of lots as demo data, not an inventory", async () => {
    const ctx = makeCtx({
      tables: { lots: Array.from({ length: 8 }, (_, i) => ({ code: `L${i}` })) },
    });
    const report = (await run(ctx, {})) as Report;
    const lots = check(report, "lot-inventory");
    expect(lots.status).toBe("warning");
    expect(lots.detail).toMatch(/demo or pilot/i);
  });

  it("accepts a real-sized inventory", async () => {
    const ctx = makeCtx({
      tables: {
        lots: Array.from({ length: 250 }, (_, i) => ({ code: `L${i}` })),
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "lot-inventory").status).toBe("ready");
  });

  it("surfaces unresolved errors and waiting enquiries", async () => {
    const ctx = makeCtx({
      tables: {
        errorLog: [{ isResolved: false }, { isResolved: false }],
        enquiries: [{ status: "new" }],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "error-log").status).toBe("warning");
    expect(check(report, "enquiry-queue").status).toBe("warning");
    expect(check(report, "enquiry-queue").detail).toMatch(/told we would/i);
  });

  it("does not count resolved errors or handled enquiries", async () => {
    const ctx = makeCtx({
      tables: {
        errorLog: [{ isResolved: true }],
        enquiries: [{ status: "closed" }],
      },
    });
    const report = (await run(ctx, {})) as Report;
    expect(check(report, "error-log").status).toBe("ready");
    expect(check(report, "enquiry-queue").status).toBe("ready");
  });
});

describe("getReadinessReport — honesty about what it cannot see", () => {
  it("reports backups as uncheckable rather than green", async () => {
    // Convex scheduled backups are a dashboard setting with no
    // queryable surface. A green tick here would be a lie, and backups
    // are exactly the thing nobody finds out is broken until the day
    // it matters.
    const report = (await run(makeCtx(), {})) as Report;
    const backups = check(report, "backups");
    expect(backups.status).toBe("unknown");
    expect(backups.action).toMatch(/dashboard/i);
    expect(backups.action).toMatch(/restore drill/i);
  });

  it("counts every check in exactly one summary bucket", async () => {
    const report = (await run(makeCtx(), {})) as Report;
    const total =
      report.summary.blocking! +
      report.summary.warning! +
      report.summary.unknown! +
      report.summary.ready!;
    expect(total).toBe(report.checks.length);
  });
});
