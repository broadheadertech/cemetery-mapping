/**
 * `convex/paymentGatewayConfig.ts` + `convex/lib/gatewayCredentials.ts`.
 *
 * This surface stores live payment credentials in the database so an
 * admin can set them up without a developer. That is a deliberate
 * reduction in how well those secrets are protected, and the whole
 * justification rests on a handful of constraints holding. These tests
 * are those constraints:
 *
 *   - no secret is ever returned to a client,
 *   - the audit trail records rotations without recording values,
 *   - environment variables still win, so the stricter posture stays
 *     available,
 *   - and a blank field in the form never silently wipes a key.
 *
 * If one of these starts failing, the feature is no longer the thing
 * that was signed off on.
 */

import { ConvexError, type Value } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ErrorPayload } from "../../../convex/lib/errors";
import { maskSecret } from "../../../convex/lib/gatewayCredentials";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  internal_getCredentials,
  listGatewayConfigs,
  updateGatewayConfig,
} from "../../../convex/paymentGatewayConfig";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-08-23T10:00:00+08:00").getTime();
const USER_ID = "users:admin1";
const SESSION_ID = "authSessions:sess1";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface ConfigRow {
  _id: string;
  _creationTime: number;
  gateway: "gcash" | "maya" | "card";
  apiBaseUrl: string;
  apiKey: string;
  webhookSecret: string;
  isEnabled: boolean;
  mode: "sandbox" | "live";
  updatedAt: number;
  updatedBy: string;
  [key: string]: unknown;
}

interface CtxBag {
  rows: Map<string, ConfigRow>;
  all: () => ConfigRow[];
  audits: () => Record<string, unknown>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(
  opts: { roles?: RoleName[]; initial?: ConfigRow[] } = {},
): CtxBag {
  const rows = new Map<string, ConfigRow>(
    (opts.initial ?? []).map((r) => [r._id, r]),
  );
  const audits: Record<string, unknown>[] = [];

  mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const user = { _id: USER_ID, _creationTime: T0 - 1000, email: "a@b.test" };
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

  function makeQueryBuilder() {
    const predicates: Array<(r: ConfigRow) => boolean> = [];
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
      async first(): Promise<ConfigRow | null> {
        for (const row of rows.values()) {
          if (predicates.every((p) => p(row))) return row;
        }
        return null;
      },
      async collect(): Promise<ConfigRow[]> {
        return Array.from(rows.values()).filter((r) =>
          predicates.every((p) => p(r)),
        );
      },
    };
    return builder;
  }

  let seq = 0;
  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        return rows.get(id) ?? null;
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return {
            withIndex: (_n: string, _f: unknown) => ({
              collect: async () => userRoles,
            }),
          };
        }
        return makeQueryBuilder();
      }),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        seq += 1;
        const id = `${table}:${seq}`;
        if (table === "auditLog") {
          audits.push(row);
          return id;
        }
        rows.set(id, { _id: id, _creationTime: T0, ...row } as ConfigRow);
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const existing = rows.get(id);
        if (existing !== undefined) {
          rows.set(id, { ...existing, ...patch } as ConfigRow);
        }
      }),
    },
  };

  return { rows, all: () => Array.from(rows.values()), audits: () => audits, ctx };
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

function configRow(overrides: Partial<ConfigRow> = {}): ConfigRow {
  return {
    _id: "paymentGatewayConfig:1",
    _creationTime: T0,
    gateway: "gcash",
    apiBaseUrl: "https://gw.example/v1",
    apiKey: "sk_live_abcd1234",
    webhookSecret: "whsec_efgh5678",
    isEnabled: true,
    mode: "live",
    updatedAt: T0,
    updatedBy: USER_ID,
    ...overrides,
  };
}

const runList = handlerOf(listGatewayConfigs);
const runUpdate = handlerOf(updateGatewayConfig);
const runResolve = handlerOf(internal_getCredentials);

const ENV_KEYS = [
  "GCASH_API_BASE_URL",
  "GCASH_API_KEY",
  "GCASH_WEBHOOK_SECRET",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  mockedGetAuthUserId.mockReset();
  mockedGetAuthSessionId.mockReset();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("maskSecret", () => {
  it("shows only the last four characters", () => {
    expect(maskSecret("sk_live_abcd1234")).toBe("••••1234");
  });

  it("reveals nothing from a short secret", () => {
    // A short secret is a configuration mistake; showing half of it
    // would be worse than showing none.
    expect(maskSecret("abc")).toBe("••••");
  });

  it("renders an unset secret as empty, not as dots", () => {
    expect(maskSecret("")).toBe("");
  });
});

describe("listGatewayConfigs — nothing secret reaches the client", () => {
  it("never returns the API key or webhook secret", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    const result = await runList(bag.ctx, {});
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("sk_live_abcd1234");
    expect(serialised).not.toContain("whsec_efgh5678");
  });

  it("returns masked previews and presence flags instead", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    const result = (await runList(bag.ctx, {})) as Array<{
      gateway: string;
      apiKeyMasked: string;
      hasApiKey: boolean;
      hasWebhookSecret: boolean;
    }>;
    const gcash = result.find((r) => r.gateway === "gcash")!;
    expect(gcash.apiKeyMasked).toBe("••••1234");
    expect(gcash.hasApiKey).toBe(true);
    expect(gcash.hasWebhookSecret).toBe(true);
  });

  it("lists every gateway, including unconfigured ones", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    const result = (await runList(bag.ctx, {})) as Array<{
      gateway: string;
      source: string;
    }>;
    expect(result.map((r) => r.gateway).sort()).toEqual([
      "card",
      "gcash",
      "maya",
    ]);
    expect(result.find((r) => r.gateway === "maya")!.source).toBe("unset");
  });

  it("is admin-only", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await runList(bag.ctx, {});
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });
});

describe("updateGatewayConfig", () => {
  it("creates a configuration", async () => {
    const bag = makeCtx();
    await runUpdate(bag.ctx, {
      gateway: "maya",
      apiBaseUrl: "https://maya.example/v1",
      apiKey: "sk_maya_0001",
      webhookSecret: "whsec_maya",
      isEnabled: true,
      mode: "sandbox",
    });
    const row = bag.all()[0]!;
    expect(row.gateway).toBe("maya");
    expect(row.apiKey).toBe("sk_maya_0001");
    expect(row.updatedBy).toBe(USER_ID);
  });

  it("keeps the stored key when the field is omitted", async () => {
    // The form cannot display the current secret, so a blank field has
    // to mean "unchanged". If it meant "clear", editing the base URL
    // would silently break the gateway.
    const bag = makeCtx({ initial: [configRow()] });
    await runUpdate(bag.ctx, {
      gateway: "gcash",
      apiBaseUrl: "https://gw.example/v2",
      isEnabled: true,
      mode: "live",
    });
    const row = bag.rows.get("paymentGatewayConfig:1")!;
    expect(row.apiKey).toBe("sk_live_abcd1234");
    expect(row.apiBaseUrl).toBe("https://gw.example/v2");
  });

  it("clears a secret only when an empty string is passed explicitly", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    await runUpdate(bag.ctx, {
      gateway: "gcash",
      apiBaseUrl: "https://gw.example/v1",
      apiKey: "",
      isEnabled: false,
      mode: "live",
    });
    expect(bag.rows.get("paymentGatewayConfig:1")!.apiKey).toBe("");
  });

  it("refuses a non-https base URL", async () => {
    // Plain http would put the API key on the wire in clear.
    const bag = makeCtx();
    let thrown: unknown;
    try {
      await runUpdate(bag.ctx, {
        gateway: "gcash",
        apiBaseUrl: "http://gw.example/v1",
        apiKey: "k",
        isEnabled: false,
        mode: "sandbox",
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
  });

  it("refuses to enable a gateway with no base URL", async () => {
    const bag = makeCtx();
    let thrown: unknown;
    try {
      await runUpdate(bag.ctx, {
        gateway: "gcash",
        apiBaseUrl: "",
        apiKey: "k",
        isEnabled: true,
        mode: "sandbox",
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
  });

  it("refuses to enable a gateway with no API key", async () => {
    const bag = makeCtx();
    let thrown: unknown;
    try {
      await runUpdate(bag.ctx, {
        gateway: "gcash",
        apiBaseUrl: "https://gw.example/v1",
        apiKey: "",
        isEnabled: true,
        mode: "live",
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("VALIDATION");
  });

  it("is admin-only", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    let thrown: unknown;
    try {
      await runUpdate(bag.ctx, {
        gateway: "gcash",
        apiBaseUrl: "https://gw.example/v1",
        isEnabled: false,
        mode: "sandbox",
      });
    } catch (e) {
      thrown = e;
    }
    expect(getCode(thrown)).toBe("FORBIDDEN");
  });
});

describe("updateGatewayConfig — the audit trail", () => {
  it("records that a key was rotated without recording the key", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    await runUpdate(bag.ctx, {
      gateway: "gcash",
      apiBaseUrl: "https://gw.example/v1",
      apiKey: "sk_live_NEWKEY999",
      isEnabled: true,
      mode: "live",
    });
    const serialised = JSON.stringify(bag.audits()[0]);
    expect(serialised).not.toContain("sk_live_NEWKEY999");
    expect(serialised).not.toContain("sk_live_abcd1234");
    expect(serialised).toContain("apiKeyRotated");
  });

  it("records the actor and the non-secret settings", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    await runUpdate(bag.ctx, {
      gateway: "gcash",
      apiBaseUrl: "https://gw.example/v9",
      isEnabled: false,
      mode: "sandbox",
    });
    const audit = bag.audits()[0]!;
    const after = audit.after as Record<string, unknown>;
    expect(after.apiBaseUrl).toBe("https://gw.example/v9");
    expect(after.isEnabled).toBe(false);
    expect(after.hasApiKey).toBe(true);
  });
});

describe("resolveGatewayCredentials — precedence", () => {
  it("prefers environment variables over the database", async () => {
    // The stricter posture has to stay reachable: an operator who keeps
    // secrets in the Convex environment must not have them silently
    // overridden by a later edit in the admin UI.
    process.env.GCASH_API_BASE_URL = "https://env.example/v1";
    process.env.GCASH_API_KEY = "sk_from_env";
    const bag = makeCtx({ initial: [configRow()] });
    const result = (await runResolve(bag.ctx, { gateway: "gcash" })) as {
      apiBaseUrl: string;
      apiKey: string;
      source: string;
    };
    expect(result.source).toBe("env");
    expect(result.apiBaseUrl).toBe("https://env.example/v1");
    expect(result.apiKey).toBe("sk_from_env");
  });

  it("falls back to the database when no env base URL is set", async () => {
    const bag = makeCtx({ initial: [configRow()] });
    const result = (await runResolve(bag.ctx, { gateway: "gcash" })) as {
      apiKey: string;
      source: string;
    };
    expect(result.source).toBe("database");
    expect(result.apiKey).toBe("sk_live_abcd1234");
  });

  it("reports unset when neither source has a base URL", async () => {
    const bag = makeCtx();
    const result = (await runResolve(bag.ctx, { gateway: "card" })) as {
      source: string;
      isEnabled: boolean;
    };
    expect(result.source).toBe("unset");
    expect(result.isEnabled).toBe(false);
  });

  it("still finds a webhook secret in the env when nothing else is configured", async () => {
    // Receiving webhooks and creating intents are separate
    // capabilities; a deployment may verify callbacks while intents
    // originate elsewhere.
    process.env.GCASH_WEBHOOK_SECRET = "whsec_env_only";
    const bag = makeCtx();
    const result = (await runResolve(bag.ctx, { gateway: "gcash" })) as {
      webhookSecret: string;
      source: string;
    };
    expect(result.webhookSecret).toBe("whsec_env_only");
    expect(result.source).toBe("unset");
  });

  it("carries the admin's off switch through", async () => {
    const bag = makeCtx({ initial: [configRow({ isEnabled: false })] });
    const result = (await runResolve(bag.ctx, { gateway: "gcash" })) as {
      isEnabled: boolean;
      apiKey: string;
    };
    expect(result.isEnabled).toBe(false);
    // Disabling must not destroy the credentials — turning a gateway
    // off mid-incident should not mean retyping its key afterwards.
    expect(result.apiKey).toBe("sk_live_abcd1234");
  });
});
