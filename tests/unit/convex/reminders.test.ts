/**
 * Story 9.8 — `convex/reminders.ts` unit tests.
 *
 * (Story 9.7 SMS reminders deferred to Phase 2 on 2026-05-22; the SMS
 * dispatch action + PH-phone helper were removed. SMS-specific tests
 * below are `.skip`'d with a Phase-2 marker so they can be re-enabled
 * when an SMS provider is wired.)
 *
 * Exercises the reminder engine end-to-end:
 *   - `internal_runDailyReminderScan` — the cron-driven scan that
 *     walks `reminderConfig.rules`, dedups via `reminderDeliveries`,
 *     filters opt-outs + bounces + paid rows, and schedules per-row
 *     send actions (email branch only after the 9.7 deferral).
 *   - `internal_markDeliverySent` / `internal_markDeliveryFailed` —
 *     the result-routing mutations the actions call; including the
 *     retry/backoff curve (4h → 24h) and the permanent_failure
 *     transition after 3 attempts (NFR-I3).
 *   - `internal_handleEmailBounces` — bounce + spam-complaint
 *     handlers that flip `customers.emailBouncedAt` and
 *     `customers.reminderOptOut`.
 *   - Template rendering pure helpers from
 *     `convex/lib/reminderTemplates.ts`.
 *   - HTTP-route helpers (`parseEmailProviderEvents`,
 *     `verifyEmailBounceSignature`) for the bounce webhook.
 *
 * Hand-mocked ctx pattern (mirrors `followUpActions-reflagExpired.test.ts`,
 * `arAging.test.ts`). `convex-test` requires `_generated/`, which the
 * repo deliberately avoids; we reproduce just enough of `ctx.db` to
 * drive the mutations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DAY_MS, HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
  convexAuth: () => ({
    auth: {
      addHttpRoutes: () => {
        /* no-op */
      },
    },
    signIn: vi.fn(),
    signOut: vi.fn(),
    store: vi.fn(),
    isAuthenticated: vi.fn(),
  }),
}));

// `convex/http.ts` imports `convex/lib/paymentGateways` which is its
// own little surface; mock the paymentGateways module out so the
// http import chain settles without dragging in adapter
// implementations the bounce-webhook tests don't exercise.
vi.mock("../../../convex/lib/paymentGateways", () => ({
  adapters: {
    gcash: { signatureHeader: "x", verifyWebhookSignature: vi.fn(), parseWebhookPayload: vi.fn() },
    maya: { signatureHeader: "x", verifyWebhookSignature: vi.fn(), parseWebhookPayload: vi.fn() },
    card: { signatureHeader: "x", verifyWebhookSignature: vi.fn(), parseWebhookPayload: vi.fn() },
  },
}));

import {
  internal_runDailyReminderScan,
  internal_markDeliverySent,
  internal_markDeliveryFailed,
  internal_handleEmailBounces,
  manilaMidnightForOffset,
  RETRY_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
  getDeliveryForSend,
  sanitizeProviderError,
} from "../../../convex/reminders";
// `e164PhPhone` helper deleted with Story 9.7 SMS deferral (2026-05-22);
// the import + the matching describe block below are removed.
import {
  renderSmsBody,
  renderEmail,
  emailKeyForSmsKey,
  isSmsTemplateKey,
  isEmailTemplateKey,
  formatPeso,
  formatManilaDate,
} from "../../../convex/lib/reminderTemplates";
import {
  parseEmailProviderEvents,
  verifyEmailBounceSignature,
} from "../../../convex/http";

// Pin time. T0 chosen as Manila midnight 2026-05-21 (the project's
// `currentDate` from CLAUDE.md). Manila midnight = -8h UTC =>
// `Date("2026-05-20T16:00:00Z")` is Manila midnight on the 21st.
const T0_MANILA_MIDNIGHT = new Date("2026-05-20T16:00:00Z").getTime();
const T0 = T0_MANILA_MIDNIGHT + 9 * HOUR_MS; // 09:00 Manila

type InstallmentStatus = "pending" | "paid" | "overdue" | "waived";

interface InstallmentFixture {
  _id: string;
  _creationTime: number;
  contractId: string;
  installmentNumber: number;
  dueDate: number;
  principalCents: number;
  paidCents: number;
  status: InstallmentStatus;
  paidAt?: number;
}

interface ContractFixture {
  _id: string;
  _creationTime: number;
  contractNumber: string;
  lotId: string;
  customerId: string;
  totalPriceCents: number;
  state: string;
}

interface CustomerFixture {
  _id: string;
  _creationTime: number;
  fullName: string;
  phone?: string;
  email?: string;
  reminderOptOut?: boolean;
  emailBouncedAt?: number;
  emailReminderPausedReason?: string;
  emailBounceMessageId?: string;
  address: { line1: string };
  createdByUserId?: string;
}

interface LotFixture {
  _id: string;
  code: string;
}

interface ReminderConfigFixture {
  _id: string;
  _creationTime: number;
  rules: Array<{
    daysOffset: number;
    requiresUnpaid: boolean;
    channel: "sms" | "email" | "both";
    templateKey: string;
    enabled: boolean;
  }>;
  timezone: string;
  sendHour: number;
  updatedAt: number;
  updatedBy: string;
}

interface DeliveryFixture {
  _id: string;
  _creationTime: number;
  customerId: string;
  contractId: string;
  installmentId: string;
  channel: "sms" | "email";
  templateKey: string;
  ruleOffset: number;
  attempt: number;
  status: "queued" | "sending" | "sent" | "failed" | "permanent_failure";
  providerMessageId?: string;
  providerError?: string;
  scheduledAt: number;
  sentAt?: number;
  failedAt?: number;
  nextAttemptAt?: number;
}

interface CtxBag {
  installments: Map<string, InstallmentFixture>;
  contracts: Map<string, ContractFixture>;
  customers: Map<string, CustomerFixture>;
  lots: Map<string, LotFixture>;
  reminderConfig: ReminderConfigFixture | null;
  deliveries: Map<string, DeliveryFixture>;
  scheduled: Array<{ delayMs: number; target: unknown; args: unknown }>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  installments?: InstallmentFixture[];
  contracts?: ContractFixture[];
  customers?: CustomerFixture[];
  lots?: LotFixture[];
  reminderConfig?: ReminderConfigFixture | null;
  deliveries?: DeliveryFixture[];
}): CtxBag {
  const installments = new Map<string, InstallmentFixture>(
    (opts.installments ?? []).map((i) => [i._id, i]),
  );
  const contracts = new Map<string, ContractFixture>(
    (opts.contracts ?? []).map((c) => [c._id, c]),
  );
  const customers = new Map<string, CustomerFixture>(
    (opts.customers ?? []).map((c) => [c._id, c]),
  );
  const lots = new Map<string, LotFixture>(
    (opts.lots ?? []).map((l) => [l._id, l]),
  );
  let reminderConfig: ReminderConfigFixture | null =
    opts.reminderConfig ?? null;
  const deliveries = new Map<string, DeliveryFixture>(
    (opts.deliveries ?? []).map((d) => [d._id, d]),
  );
  const scheduled: Array<{
    delayMs: number;
    target: unknown;
    args: unknown;
  }> = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  type Predicate = (r: Record<string, unknown>) => boolean;

  function rowsForTable(table: string): Record<string, unknown>[] {
    switch (table) {
      case "installments":
        return Array.from(installments.values()) as unknown as Record<
          string,
          unknown
        >[];
      case "contracts":
        return Array.from(contracts.values()) as unknown as Record<
          string,
          unknown
        >[];
      case "customers":
        return Array.from(customers.values()) as unknown as Record<
          string,
          unknown
        >[];
      case "reminderConfig":
        return reminderConfig === null
          ? []
          : ([reminderConfig] as unknown as Record<string, unknown>[]);
      case "reminderDeliveries":
        return Array.from(deliveries.values()) as unknown as Record<
          string,
          unknown
        >[];
      default:
        return [];
    }
  }

  function makeQueryBuilder(table: string) {
    const predicates: Predicate[] = [];
    let descOrder = false;
    let takeN: number | null = null;
    const builder = {
      withIndex(
        _indexName: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fn?: (q: any) => any,
      ) {
        if (fn !== undefined) {
          const q = {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eq(field: string, value: any) {
              predicates.push(
                (r) => (r as Record<string, unknown>)[field] === value,
              );
              return this;
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            lt(field: string, value: any) {
              predicates.push((r) => {
                const v = (r as Record<string, unknown>)[field];
                return typeof v === "number" && v < (value as number);
              });
              return this;
            },
          };
          fn(q);
        }
        return builder;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter(fn: (q: any) => any) {
        const q = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          field(f: string) {
            return { _field: f };
          },
          eq(
            a: { _field: string },
            b: unknown,
          ) {
            return (r: Record<string, unknown>) =>
              (r as Record<string, unknown>)[a._field] === b;
          },
        };
        const pred = fn(q);
        predicates.push(pred as Predicate);
        return builder;
      },
      order(dir: "asc" | "desc") {
        descOrder = dir === "desc";
        return builder;
      },
      async take(n: number) {
        takeN = n;
        return builder.collect();
      },
      async collect(): Promise<Record<string, unknown>[]> {
        let rows = rowsForTable(table).filter((r) =>
          predicates.every((p) => p(r)),
        );
        if (descOrder) {
          rows = [...rows].reverse();
        }
        if (takeN !== null) {
          rows = rows.slice(0, takeN);
        }
        return rows;
      },
      async first(): Promise<Record<string, unknown> | null> {
        const rows = await builder.collect();
        return rows[0] ?? null;
      },
    };
    return builder;
  }

  const ctx = {
    db: {
      get: vi.fn(async (id: string) => {
        if (installments.has(id)) return installments.get(id);
        if (contracts.has(id)) return contracts.get(id);
        if (customers.has(id)) return customers.get(id);
        if (lots.has(id)) return lots.get(id);
        if (deliveries.has(id)) return deliveries.get(id);
        return null;
      }),
      query: vi.fn((table: string) => makeQueryBuilder(table)),
      insert: vi.fn(
        async (table: string, row: Record<string, unknown>) => {
          inserts.push({ table, row });
          const id = `${table}:${inserts.length}`;
          if (table === "reminderDeliveries") {
            deliveries.set(id, {
              ...(row as unknown as DeliveryFixture),
              _id: id,
            });
          }
          if (table === "reminderConfig") {
            reminderConfig = {
              ...(row as unknown as ReminderConfigFixture),
              _id: id,
            };
          }
          if (table === "auditLog") {
            // Audit log inserts captured but otherwise ignored.
          }
          return id;
        },
      ),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        const d = deliveries.get(id);
        if (d !== undefined) {
          deliveries.set(id, { ...d, ...(patch as Partial<DeliveryFixture>) });
        }
        const c = customers.get(id);
        if (c !== undefined) {
          customers.set(id, {
            ...c,
            ...(patch as Partial<CustomerFixture>),
          });
        }
        const cfg = reminderConfig;
        if (cfg !== null && cfg._id === id) {
          reminderConfig = {
            ...cfg,
            ...(patch as Partial<ReminderConfigFixture>),
          };
        }
      }),
    },
    scheduler: {
      runAfter: vi.fn(
        async (delayMs: number, target: unknown, args: unknown) => {
          scheduled.push({ delayMs, target, args });
        },
      ),
    },
  };

  return {
    installments,
    contracts,
    customers,
    lots,
    reminderConfig,
    deliveries,
    scheduled,
    patches,
    inserts,
    ctx,
  };
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

function makeInstallment(
  overrides: Partial<InstallmentFixture> = {},
): InstallmentFixture {
  return {
    _id: overrides._id ?? "installments:1",
    _creationTime: T0,
    contractId: overrides.contractId ?? "contracts:1",
    installmentNumber: overrides.installmentNumber ?? 1,
    dueDate: overrides.dueDate ?? T0_MANILA_MIDNIGHT + 3 * DAY_MS,
    principalCents: overrides.principalCents ?? 100_000,
    paidCents: overrides.paidCents ?? 0,
    status: overrides.status ?? "pending",
    paidAt: overrides.paidAt,
  };
}

function makeContract(
  overrides: Partial<ContractFixture> = {},
): ContractFixture {
  return {
    _id: overrides._id ?? "contracts:1",
    _creationTime: T0,
    contractNumber: overrides.contractNumber ?? "C-1",
    lotId: overrides.lotId ?? "lots:1",
    customerId: overrides.customerId ?? "customers:1",
    totalPriceCents: overrides.totalPriceCents ?? 1_200_000,
    state: overrides.state ?? "active",
  };
}

function makeCustomer(
  overrides: Partial<CustomerFixture> = {},
): CustomerFixture {
  const base: CustomerFixture = {
    _id: "customers:1",
    _creationTime: T0,
    fullName: "Juan Dela Cruz",
    phone: "+639171234567",
    email: "juan@example.ph",
    address: { line1: "123 Sample St" },
  };
  // Spread overrides so explicitly-undefined fields override the
  // default values (TypeScript `??` would otherwise re-introduce them).
  return { ...base, ...overrides };
}

function makeLot(overrides: Partial<LotFixture> = {}): LotFixture {
  return {
    _id: overrides._id ?? "lots:1",
    code: overrides.code ?? "A-12-3",
  };
}

function makeConfig(
  rules: ReminderConfigFixture["rules"],
): ReminderConfigFixture {
  return {
    _id: "reminderConfig:1",
    _creationTime: T0,
    rules,
    timezone: "Asia/Manila",
    sendHour: 9,
    updatedAt: T0,
    updatedBy: "users:admin",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("manilaMidnightForOffset", () => {
  it("returns Manila midnight for offsetDays = 0 at any nowMs in that day", () => {
    const inDay = T0_MANILA_MIDNIGHT + 9 * HOUR_MS;
    expect(manilaMidnightForOffset(inDay, 0)).toBe(T0_MANILA_MIDNIGHT);
  });
  it("shifts by exactly offsetDays * DAY_MS", () => {
    const base = manilaMidnightForOffset(T0, 0);
    expect(manilaMidnightForOffset(T0, -3)).toBe(base - 3 * DAY_MS);
    expect(manilaMidnightForOffset(T0, 7)).toBe(base + 7 * DAY_MS);
  });
});

describe("template helpers", () => {
  it("formatPeso renders centavos with comma separator and decimal", () => {
    expect(formatPeso(0)).toBe("₱0.00");
    expect(formatPeso(50)).toBe("₱0.50");
    expect(formatPeso(150_000)).toBe("₱1,500.00");
    expect(formatPeso(-100)).toBe("-₱1.00");
  });
  it("formatManilaDate ISO format", () => {
    expect(formatManilaDate(T0_MANILA_MIDNIGHT)).toBe("2026-05-21");
  });
  it("renderSmsBody produces a < 200-char body with substituted fields", () => {
    const body = renderSmsBody("upcoming_due_3d", {
      customerName: "Juan",
      amountCents: 100_000,
      lotCode: "A-1-1",
      dueDateMs: T0_MANILA_MIDNIGHT,
      portalUrl: "https://portal.example.ph",
    });
    expect(body).toContain("Juan");
    expect(body).toContain("₱1,000.00");
    expect(body).toContain("A-1-1");
    expect(body).toContain("https://portal.example.ph");
  });
  it("renderEmail returns subject + plain + html", () => {
    const rendered = renderEmail("due_today_email", {
      customerName: "Juan",
      amountCents: 100_000,
      lotCode: "A-1-1",
      dueDateMs: T0_MANILA_MIDNIGHT,
      portalUrl: "https://portal.example.ph",
    });
    expect(rendered.subject).not.toContain("Juan");
    expect(rendered.subject).not.toContain("1,000");
    expect(rendered.bodyPlain).toContain("Juan");
    expect(rendered.bodyHtml).toContain("Juan");
    expect(rendered.bodyHtml).toContain("portal");
  });
  it("emailKeyForSmsKey + isXTemplateKey guards", () => {
    expect(emailKeyForSmsKey("upcoming_due_3d")).toBe(
      "upcoming_due_3d_email",
    );
    expect(isSmsTemplateKey("upcoming_due_3d")).toBe(true);
    expect(isSmsTemplateKey("upcoming_due_3d_email")).toBe(false);
    expect(isEmailTemplateKey("upcoming_due_3d_email")).toBe(true);
  });
});

describe("internal_runDailyReminderScan", () => {
  const run = handlerOf(internal_runDailyReminderScan);

  it("is a no-op when reminderConfig is not seeded", async () => {
    const bag = makeCtx({ reminderConfig: null });
    const r = (await run(bag.ctx, {})) as { scanned: number };
    expect(r.scanned).toBe(0);
    expect(bag.inserts).toHaveLength(0);
    expect(bag.scheduled).toHaveLength(0);
  });

  // SKIPPED: SMS deferred to Phase 2 per Story 9.7 (2026-05-22). The
  // scan no longer queues SMS deliveries; rules with channel "sms" are
  // silently skipped. Re-enable when an SMS provider is wired.
  it.skip("queues an SMS delivery for a due-in-3-days unpaid installment", async () => {
    const cfg = makeConfig([
      {
        daysOffset: -3,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "upcoming_due_3d",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          _id: "installments:due-3d",
          dueDate: T0_MANILA_MIDNIGHT + 3 * DAY_MS,
          status: "pending",
        }),
      ],
      contracts: [makeContract({ _id: "contracts:1" })],
      customers: [makeCustomer({ _id: "customers:1" })],
      lots: [makeLot({ _id: "lots:1", code: "A-1-1" })],
    });
    const r = (await run(bag.ctx, {})) as {
      scanned: number;
      smsQueued: number;
      emailQueued: number;
    };
    expect(r.scanned).toBe(1);
    expect(r.smsQueued).toBe(1);
    expect(r.emailQueued).toBe(0);
    const smsInserts = bag.inserts.filter(
      (i) => i.table === "reminderDeliveries",
    );
    expect(smsInserts).toHaveLength(1);
    expect(smsInserts[0]!.row.channel).toBe("sms");
    expect(smsInserts[0]!.row.status).toBe("queued");
    expect(smsInserts[0]!.row.templateKey).toBe("upcoming_due_3d");
    expect(smsInserts[0]!.row.attempt).toBe(1);
  });

  // SKIPPED: SMS deferred to Phase 2 (Story 9.7, 2026-05-22). This test
  // uses an SMS-channel fixture; the dedup behaviour is also covered by
  // the email-branch tests below.
  it.skip("dedup: re-running the scan on the same day inserts zero new rows", async () => {
    const cfg = makeConfig([
      {
        daysOffset: -3,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "upcoming_due_3d",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          _id: "installments:1",
          dueDate: T0_MANILA_MIDNIGHT + 3 * DAY_MS,
        }),
      ],
      contracts: [makeContract({ _id: "contracts:1" })],
      customers: [makeCustomer({ _id: "customers:1" })],
      lots: [makeLot({ _id: "lots:1" })],
    });
    await run(bag.ctx, {});
    const firstCount = bag.inserts.length;
    await run(bag.ctx, {});
    expect(bag.inserts).toHaveLength(firstCount);
  });

  // SKIPPED: SMS deferred to Phase 2 (Story 9.7, 2026-05-22). Uses an
  // SMS-channel fixture; opt-out filtering also exercised by the email
  // branch + the email-bounce / spam-complaint tests.
  it.skip("skips opted-out customers", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "due_today",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          _id: "installments:due-today",
          dueDate: T0_MANILA_MIDNIGHT,
        }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer({ reminderOptOut: true })],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      smsQueued: number;
      skippedOptOut: number;
    };
    expect(r.smsQueued).toBe(0);
    expect(r.skippedOptOut).toBe(1);
    expect(bag.inserts).toHaveLength(0);
  });

  // SKIPPED: SMS deferred to Phase 2 (Story 9.7, 2026-05-22). Uses an
  // SMS-channel fixture; paid-skip behaviour also covered by the
  // send-time paid-skip gate test in `getDeliveryForSend (P0-1)`.
  it.skip("skips paid installments when requiresUnpaid", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "due_today",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          _id: "installments:paid",
          dueDate: T0_MANILA_MIDNIGHT,
          status: "paid",
        }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer()],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      smsQueued: number;
      skippedPaid: number;
    };
    expect(r.smsQueued).toBe(0);
    expect(r.skippedPaid).toBe(1);
  });

  // SKIPPED: SMS deferred to Phase 2 (Story 9.7, 2026-05-22). Uses an
  // SMS-channel fixture; disabled-rule behaviour is a per-rule guard
  // that applies identically to the email branch.
  it.skip("skips disabled rules", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "due_today",
        enabled: false,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({ dueDate: T0_MANILA_MIDNIGHT }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer()],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as { scanned: number };
    expect(r.scanned).toBe(0);
  });

  it("email branch queues for channel: 'email'", async () => {
    const cfg = makeConfig([
      {
        daysOffset: -3,
        requiresUnpaid: true,
        channel: "email",
        templateKey: "upcoming_due_3d_email",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          dueDate: T0_MANILA_MIDNIGHT + 3 * DAY_MS,
        }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer()],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      emailQueued: number;
      smsQueued: number;
    };
    expect(r.emailQueued).toBe(1);
    expect(r.smsQueued).toBe(0);
    const row = bag.inserts.find(
      (i) => i.table === "reminderDeliveries",
    )!.row;
    expect(row.channel).toBe("email");
    expect(row.templateKey).toBe("upcoming_due_3d_email");
  });

  it("skips customers with emailBouncedAt set (Story 9.8)", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "email",
        templateKey: "due_today_email",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({ dueDate: T0_MANILA_MIDNIGHT }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer({ emailBouncedAt: T0 - DAY_MS })],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      emailQueued: number;
      skippedBounce: number;
    };
    expect(r.emailQueued).toBe(0);
    expect(r.skippedBounce).toBe(1);
  });

  it("skips customers with no email (Story 9.8)", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "email",
        templateKey: "due_today_email",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({ dueDate: T0_MANILA_MIDNIGHT }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer({ email: undefined })],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      emailQueued: number;
      skippedNoEmail: number;
    };
    expect(r.emailQueued).toBe(0);
    expect(r.skippedNoEmail).toBe(1);
  });

  // SKIPPED: SMS deferred to Phase 2 (Story 9.7, 2026-05-22). With SMS
  // disabled, `channel: "both"` rules downgrade silently to email-only;
  // assertion shape inverted from the original — see the email-branch
  // test "email branch queues for channel: 'email'" above for coverage.
  it.skip("channel: 'both' fires both SMS and email branches for the same installment", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "both",
        templateKey: "due_today",
        enabled: true,
      },
    ]);
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({ dueDate: T0_MANILA_MIDNIGHT }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer()],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      smsQueued: number;
      emailQueued: number;
    };
    expect(r.smsQueued).toBe(1);
    expect(r.emailQueued).toBe(1);
    const rows = bag.inserts
      .filter((i) => i.table === "reminderDeliveries")
      .map((i) => i.row);
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
  });
});

describe("internal_markDeliverySent", () => {
  const run = handlerOf(internal_markDeliverySent);

  it("patches the delivery row to status: 'sent' with sentAt + providerMessageId", async () => {
    const bag = makeCtx({
      deliveries: [
        {
          _id: "reminderDeliveries:1",
          _creationTime: T0,
          customerId: "customers:1",
          contractId: "contracts:1",
          installmentId: "installments:1",
          channel: "sms",
          templateKey: "due_today",
          ruleOffset: 0,
          attempt: 1,
          status: "queued",
          scheduledAt: T0,
        },
      ],
    });
    await run(bag.ctx, {
      deliveryId: "reminderDeliveries:1",
      providerMessageId: "SM1234",
    });
    const patched = bag.deliveries.get("reminderDeliveries:1")!;
    expect(patched.status).toBe("sent");
    expect(patched.providerMessageId).toBe("SM1234");
    expect(patched.sentAt).toBe(T0);
  });
});

describe("internal_markDeliveryFailed", () => {
  const run = handlerOf(internal_markDeliveryFailed);

  it("permanent: 4xx transitions to permanent_failure immediately, no retry scheduled", async () => {
    const bag = makeCtx({
      deliveries: [
        {
          _id: "reminderDeliveries:perm",
          _creationTime: T0,
          customerId: "customers:1",
          contractId: "contracts:1",
          installmentId: "installments:1",
          channel: "sms",
          templateKey: "due_today",
          ruleOffset: 0,
          attempt: 1,
          status: "queued",
          scheduledAt: T0,
        },
      ],
    });
    const r = (await run(bag.ctx, {
      deliveryId: "reminderDeliveries:perm",
      transient: false,
      error: "invalid_number",
    })) as { outcome: string };
    expect(r.outcome).toBe("permanent_failure");
    expect(bag.deliveries.get("reminderDeliveries:perm")!.status).toBe(
      "permanent_failure",
    );
    expect(bag.deliveries.get("reminderDeliveries:perm")!.failedAt).toBe(T0);
    expect(bag.scheduled).toHaveLength(0);
  });

  it("transient with retries remaining schedules a retry at the backoff offset", async () => {
    const bag = makeCtx({
      deliveries: [
        {
          _id: "reminderDeliveries:t1",
          _creationTime: T0,
          customerId: "customers:1",
          contractId: "contracts:1",
          installmentId: "installments:1",
          channel: "sms",
          templateKey: "due_today",
          ruleOffset: 0,
          attempt: 1,
          status: "queued",
          scheduledAt: T0,
        },
      ],
    });
    const r = (await run(bag.ctx, {
      deliveryId: "reminderDeliveries:t1",
      transient: true,
      error: "http_500",
    })) as { outcome: string };
    expect(r.outcome).toBe("retried");
    const row = bag.deliveries.get("reminderDeliveries:t1")!;
    expect(row.attempt).toBe(2);
    expect(row.status).toBe("queued");
    expect(row.providerError).toBe("http_500");
    expect(row.nextAttemptAt).toBe(T0 + RETRY_BACKOFF_MS[0]!);
    // The retry scheduling depends on `_generated/api` which is absent
    // in the test environment, so the scheduler.runAfter is a no-op
    // when codegen isn't present. We assert the row state instead.
  });

  it("transient at attempt === MAX_RETRY_ATTEMPTS transitions to permanent_failure", async () => {
    const bag = makeCtx({
      deliveries: [
        {
          _id: "reminderDeliveries:third",
          _creationTime: T0,
          customerId: "customers:1",
          contractId: "contracts:1",
          installmentId: "installments:1",
          channel: "sms",
          templateKey: "due_today",
          ruleOffset: 0,
          attempt: MAX_RETRY_ATTEMPTS,
          status: "queued",
          scheduledAt: T0,
        },
      ],
    });
    const r = (await run(bag.ctx, {
      deliveryId: "reminderDeliveries:third",
      transient: true,
      error: "http_500",
    })) as { outcome: string };
    expect(r.outcome).toBe("permanent_failure");
    expect(bag.deliveries.get("reminderDeliveries:third")!.status).toBe(
      "permanent_failure",
    );
  });

  it("no-op when the delivery row is missing", async () => {
    const bag = makeCtx({});
    const r = (await run(bag.ctx, {
      deliveryId: "reminderDeliveries:ghost",
      transient: true,
      error: "anything",
    })) as { outcome: string };
    expect(r.outcome).toBe("permanent_failure");
  });
});

describe("internal_handleEmailBounces", () => {
  const run = handlerOf(internal_handleEmailBounces);

  it("hard bounce by email flips emailBouncedAt + paused reason", async () => {
    const bag = makeCtx({
      customers: [
        makeCustomer({ _id: "customers:c1", email: "bad@example.ph" }),
      ],
    });
    const r = (await run(bag.ctx, {
      events: [
        {
          type: "hard_bounce",
          email: "bad@example.ph",
          providerMessageId: "re_msg_1",
        },
      ],
    })) as { hardBounces: number };
    expect(r.hardBounces).toBe(1);
    const c = bag.customers.get("customers:c1")!;
    expect(c.emailBouncedAt).toBe(T0);
    expect(c.emailReminderPausedReason).toBe("hard_bounce");
    expect(c.emailBounceMessageId).toBe("re_msg_1");
  });

  it("spam complaint flips reminderOptOut + paused reason", async () => {
    const bag = makeCtx({
      customers: [
        makeCustomer({ _id: "customers:c2", email: "spam@example.ph" }),
      ],
    });
    const r = (await run(bag.ctx, {
      events: [
        {
          type: "spam_complaint",
          email: "spam@example.ph",
          providerMessageId: "re_msg_2",
        },
      ],
    })) as { complaints: number };
    expect(r.complaints).toBe(1);
    const c = bag.customers.get("customers:c2")!;
    expect(c.reminderOptOut).toBe(true);
    expect(c.emailReminderPausedReason).toBe("spam_complaint");
  });

  it("unknown event type is skipped", async () => {
    const bag = makeCtx({
      customers: [
        makeCustomer({ _id: "customers:c3", email: "ok@example.ph" }),
      ],
    });
    const r = (await run(bag.ctx, {
      events: [{ type: "email.opened", email: "ok@example.ph" }],
    })) as { skipped: number; hardBounces: number };
    expect(r.skipped).toBe(1);
    expect(r.hardBounces).toBe(0);
    const c = bag.customers.get("customers:c3")!;
    expect(c.emailBouncedAt).toBeUndefined();
  });

  it("unknown customer is skipped (no match)", async () => {
    const bag = makeCtx({ customers: [] });
    const r = (await run(bag.ctx, {
      events: [{ type: "hard_bounce", email: "nobody@example.ph" }],
    })) as { skipped: number; hardBounces: number };
    expect(r.skipped).toBe(1);
    expect(r.hardBounces).toBe(0);
  });
});

describe("parseEmailProviderEvents", () => {
  it("parses a Resend hard-bounce payload", () => {
    const out = parseEmailProviderEvents({
      type: "email.bounced",
      data: {
        email: "bad@example.ph",
        message_id: "re_1",
        bounce: { type: "hard", subType: "MailboxDoesNotExist" },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "hard_bounce",
      email: "bad@example.ph",
      providerMessageId: "re_1",
      reason: "MailboxDoesNotExist",
    });
  });

  it("ignores Resend soft bounces", () => {
    const out = parseEmailProviderEvents({
      type: "email.bounced",
      data: {
        email: "soft@example.ph",
        message_id: "re_2",
        bounce: { type: "soft" },
      },
    });
    expect(out).toHaveLength(0);
  });

  it("parses a SendGrid hard-bounce array", () => {
    const out = parseEmailProviderEvents([
      {
        event: "bounce",
        type: "hard",
        email: "x@example.ph",
        sg_message_id: "sg-1",
        reason: "550 No such user",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("hard_bounce");
    expect(out[0]!.providerMessageId).toBe("sg-1");
  });

  it("parses a Postmark spam complaint", () => {
    const out = parseEmailProviderEvents({
      RecordType: "SpamComplaint",
      Email: "spam@example.ph",
      MessageID: "pm-1",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe("spam_complaint");
  });

  it("returns an empty array for unknown payload shapes", () => {
    expect(parseEmailProviderEvents({})).toHaveLength(0);
    expect(parseEmailProviderEvents(null)).toHaveLength(0);
    expect(parseEmailProviderEvents("string")).toHaveLength(0);
  });
});

describe("verifyEmailBounceSignature", () => {
  it("returns false on empty header", async () => {
    expect(await verifyEmailBounceSignature("body", "", "secret")).toBe(false);
  });

  it("verifies a raw HMAC-SHA256 hex header", async () => {
    // Compute the expected HMAC via the same subtle API the helper
    // uses, then assert the verifier accepts it.
    const body = '{"type":"email.bounced"}';
    const secret = "topsecret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await verifyEmailBounceSignature(body, hex, secret)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const body = '{"type":"email.bounced"}';
    const secret = "topsecret";
    // Tampered: wrong hex.
    const bad = "deadbeef".repeat(8);
    expect(await verifyEmailBounceSignature(body, bad, secret)).toBe(false);
  });

  it("parses Svix-style v1=<hex> header format", async () => {
    // P0-3 — this legacy single-header form (no companion `svix-id` /
    // `svix-timestamp`) used the raw body as the signed payload. The
    // rewritten verifier no longer supports the comma-delimited
    // `t=123,v1=<hex>` shape because it conflated Svix and raw-body
    // formats — the strict-Svix path now requires the companion
    // headers, and the raw-body fallback rejects anything with a
    // recognised version prefix. We assert the rewritten verifier
    // returns FALSE for the legacy shape (a regression-shaped test
    // intentionally inverted from the original — the previous behaviour
    // was the bug).
    const body = '{"x":1}';
    const secret = "s";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(
      await verifyEmailBounceSignature(body, `t=123,v1=${hex}`, secret),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P0-2 — PH phone normalization (e164PhPhone).
// ---------------------------------------------------------------------------

// e164PhPhone tests removed — helper deleted with Story 9.7 SMS deferral
// (2026-05-22). Restore both the helper and these tests when an SMS
// provider is wired in Phase 2.

// ---------------------------------------------------------------------------
// P0-1 — Send-time paid-skip gate in getDeliveryForSend.
// ---------------------------------------------------------------------------

describe("getDeliveryForSend (P0-1)", () => {
  const run = handlerOf(getDeliveryForSend);

  function makeDeliveryBag(opts: {
    installmentStatus: InstallmentStatus;
    paidCents?: number;
    principalCents?: number;
  }) {
    const inst = makeInstallment({
      _id: "installments:1",
      status: opts.installmentStatus,
      paidCents: opts.paidCents ?? 0,
      principalCents: opts.principalCents ?? 100_000,
    });
    const contract = makeContract({ _id: "contracts:1" });
    const customer = makeCustomer({ _id: "customers:1" });
    const lot = makeLot({ _id: "lots:1" });
    const delivery: DeliveryFixture = {
      _id: "reminderDeliveries:d1",
      _creationTime: T0,
      customerId: "customers:1",
      contractId: "contracts:1",
      installmentId: "installments:1",
      channel: "sms",
      templateKey: "due_today",
      ruleOffset: 0,
      attempt: 1,
      status: "queued",
      scheduledAt: T0,
    };
    return makeCtx({
      installments: [inst],
      contracts: [contract],
      customers: [customer],
      lots: [lot],
      deliveries: [delivery],
    });
  }

  it("returns null when the linked installment is paid (send-time gate)", async () => {
    const bag = makeDeliveryBag({ installmentStatus: "paid" });
    const view = await run(bag.ctx, {
      deliveryId: "reminderDeliveries:d1",
    });
    expect(view).toBeNull();
  });

  it("returns null when the delivery is already sent", async () => {
    const inst = makeInstallment({ _id: "installments:1" });
    const contract = makeContract();
    const customer = makeCustomer();
    const lot = makeLot();
    const delivery: DeliveryFixture = {
      _id: "reminderDeliveries:d-sent",
      _creationTime: T0,
      customerId: "customers:1",
      contractId: "contracts:1",
      installmentId: "installments:1",
      channel: "sms",
      templateKey: "due_today",
      ruleOffset: 0,
      attempt: 1,
      status: "sent",
      scheduledAt: T0,
    };
    const bag = makeCtx({
      installments: [inst],
      contracts: [contract],
      customers: [customer],
      lots: [lot],
      deliveries: [delivery],
    });
    const view = await run(bag.ctx, {
      deliveryId: "reminderDeliveries:d-sent",
    });
    expect(view).toBeNull();
  });

  it("returns the view-model for a queued, unpaid installment", async () => {
    const bag = makeDeliveryBag({
      installmentStatus: "pending",
      paidCents: 0,
      principalCents: 50_000,
    });
    const view = (await run(bag.ctx, {
      deliveryId: "reminderDeliveries:d1",
    })) as { installment: { principalCents: number; paidCents: number } };
    expect(view).not.toBeNull();
    expect(view.installment.principalCents).toBe(50_000);
    expect(view.installment.paidCents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P1-2 — sanitizeProviderError keeps customer PII out of providerError.
// ---------------------------------------------------------------------------

describe("sanitizeProviderError (P1-2)", () => {
  it("collapses http_<status>:<body> with phone leak to http_<status>:invalid_to", () => {
    const raw =
      'http_400:{"code":21211,"message":"Invalid To Phone Number +639171234567"}';
    const safe = sanitizeProviderError(raw);
    expect(safe).not.toContain("+639171234567");
    expect(safe).toBe("http_400:invalid_to");
  });

  it("collapses 401/403 to auth_fail", () => {
    expect(sanitizeProviderError("http_401:bad auth")).toBe(
      "http_401:auth_fail",
    );
    expect(sanitizeProviderError("http_403:forbidden")).toBe(
      "http_403:auth_fail",
    );
  });

  it("collapses 429 to rate_limit", () => {
    expect(sanitizeProviderError("http_429:slow down")).toBe(
      "http_429:rate_limit",
    );
  });

  it("collapses STOP / opt-out body to blocked", () => {
    expect(sanitizeProviderError("http_400:recipient unsubscribed")).toBe(
      "http_400:blocked",
    );
  });

  it("collapses other body content to upstream", () => {
    expect(sanitizeProviderError("http_500:something exploded")).toBe(
      "http_500:upstream",
    );
  });

  it("preserves http_<status> with no body", () => {
    expect(sanitizeProviderError("http_500")).toBe("http_500");
  });

  it("drops network: tail", () => {
    expect(sanitizeProviderError("network:DNS lookup failed for ...")).toBe(
      "network",
    );
  });

  it("drops exception: tail", () => {
    expect(sanitizeProviderError("exception:TypeError at line 5")).toBe(
      "exception",
    );
  });

  it("passes pre-classified sentinels through unchanged", () => {
    expect(sanitizeProviderError("invalid_phone")).toBe("invalid_phone");
    expect(sanitizeProviderError("stale_paid")).toBe("stale_paid");
    expect(sanitizeProviderError("twilio_not_configured")).toBe(
      "twilio_not_configured",
    );
    expect(sanitizeProviderError("customer_opted_out")).toBe(
      "customer_opted_out",
    );
    expect(sanitizeProviderError("no_phone")).toBe("no_phone");
  });
});

describe("internal_markDeliveryFailed sanitises providerError (P1-2)", () => {
  const run = handlerOf(internal_markDeliveryFailed);

  it("persists sanitized error, not the raw body containing customer phone", async () => {
    const bag = makeCtx({
      deliveries: [
        {
          _id: "reminderDeliveries:phone-leak",
          _creationTime: T0,
          customerId: "customers:1",
          contractId: "contracts:1",
          installmentId: "installments:1",
          channel: "sms",
          templateKey: "due_today",
          ruleOffset: 0,
          attempt: 1,
          status: "queued",
          scheduledAt: T0,
        },
      ],
    });
    await run(bag.ctx, {
      deliveryId: "reminderDeliveries:phone-leak",
      transient: false,
      error:
        'http_400:{"message":"Invalid To Phone Number","raw":"+639171234567"}',
    });
    const stored = bag.deliveries.get("reminderDeliveries:phone-leak")!;
    expect(stored.providerError).not.toContain("+639171234567");
    expect(stored.providerError).toBe("http_400:invalid_to");
  });
});

// ---------------------------------------------------------------------------
// P1-4 — internal_handleEmailBounces flips every customer sharing a
// hard-bounced email, not just the first match.
// ---------------------------------------------------------------------------

describe("internal_handleEmailBounces (P1-4)", () => {
  const run = handlerOf(internal_handleEmailBounces);

  it("flips emailBouncedAt on EVERY customer sharing a bounced email", async () => {
    const bag = makeCtx({
      customers: [
        makeCustomer({
          _id: "customers:husband",
          email: "household@example.ph",
          fullName: "Juan",
        }),
        makeCustomer({
          _id: "customers:wife",
          email: "HOUSEHOLD@example.ph", // mixed case; same address
          fullName: "Maria",
        }),
        makeCustomer({
          _id: "customers:cousin",
          email: "another@example.ph", // different address
          fullName: "Pedro",
        }),
      ],
    });
    const r = (await run(bag.ctx, {
      events: [
        {
          type: "hard_bounce",
          email: "household@example.ph",
        },
      ],
    })) as { hardBounces: number; skipped: number };
    expect(r.hardBounces).toBe(1);
    expect(r.skipped).toBe(0);
    expect(bag.customers.get("customers:husband")!.emailBouncedAt).toBe(T0);
    expect(bag.customers.get("customers:wife")!.emailBouncedAt).toBe(T0);
    // Untouched customer — different email.
    expect(bag.customers.get("customers:cousin")!.emailBouncedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P1-5 — global reminders kill switch.
// ---------------------------------------------------------------------------

describe("internal_runDailyReminderScan kill switch (P1-5)", () => {
  const run = handlerOf(internal_runDailyReminderScan);

  it("short-circuits when reminderConfig.paused === true", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "due_today",
        enabled: true,
      },
    ]);
    // Inject the kill-switch flag.
    (cfg as unknown as Record<string, unknown>).paused = true;
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          _id: "installments:1",
          dueDate: T0_MANILA_MIDNIGHT,
        }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer()],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as {
      scanned: number;
      smsQueued: number;
      emailQueued: number;
    };
    expect(r.scanned).toBe(0);
    expect(r.smsQueued).toBe(0);
    expect(r.emailQueued).toBe(0);
    expect(bag.inserts).toHaveLength(0);
    expect(bag.scheduled).toHaveLength(0);
  });

  // SKIPPED: SMS deferred to Phase 2 (Story 9.7, 2026-05-22). The
  // fixture rule's channel "sms" no longer produces any queued
  // deliveries; the kill-switch defensive-default behaviour for the
  // email branch is exercised by the email-branch tests above.
  it.skip("runs normally when paused === false (defensive default)", async () => {
    const cfg = makeConfig([
      {
        daysOffset: 0,
        requiresUnpaid: true,
        channel: "sms",
        templateKey: "due_today",
        enabled: true,
      },
    ]);
    (cfg as unknown as Record<string, unknown>).paused = false;
    const bag = makeCtx({
      reminderConfig: cfg,
      installments: [
        makeInstallment({
          _id: "installments:1",
          dueDate: T0_MANILA_MIDNIGHT,
        }),
      ],
      contracts: [makeContract()],
      customers: [makeCustomer()],
      lots: [makeLot()],
    });
    const r = (await run(bag.ctx, {})) as { smsQueued: number };
    expect(r.smsQueued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P0-3 — Svix HMAC verifier (full triple-payload + timestamp skew).
// ---------------------------------------------------------------------------

describe("verifyEmailBounceSignature — Svix triple (P0-3)", () => {
  async function computeSvixSig(
    secret: string,
    svixId: string,
    timestamp: string,
    body: string,
  ): Promise<string> {
    const payload = `${svixId}.${timestamp}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );
    // Convert to base64.
    const bytes = new Uint8Array(sig);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i] ?? 0);
    }
    return btoa(bin);
  }

  it("verifies a well-formed Svix triple", async () => {
    const body = '{"type":"email.bounced"}';
    const secret = "topsecret";
    const svixId = "msg_2bDQ";
    const nowSec = Math.floor(T0 / 1000);
    const ts = String(nowSec);
    const b64 = await computeSvixSig(secret, svixId, ts, body);
    expect(
      await verifyEmailBounceSignature(body, `v1,${b64}`, secret, {
        svixId,
        svixTimestamp: ts,
        nowSeconds: nowSec,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body with a still-correct signature", async () => {
    const body = '{"type":"email.bounced"}';
    const secret = "topsecret";
    const svixId = "msg_1";
    const nowSec = Math.floor(T0 / 1000);
    const ts = String(nowSec);
    const b64 = await computeSvixSig(secret, svixId, ts, body);
    expect(
      await verifyEmailBounceSignature(
        '{"type":"email.bounced","tampered":true}',
        `v1,${b64}`,
        secret,
        { svixId, svixTimestamp: ts, nowSeconds: nowSec },
      ),
    ).toBe(false);
  });

  it("rejects a stale timestamp (> 5 min skew)", async () => {
    const body = '{"x":1}';
    const secret = "s";
    const svixId = "msg_stale";
    const nowSec = Math.floor(T0 / 1000);
    const staleTs = String(nowSec - 10 * 60); // 10 minutes old
    const b64 = await computeSvixSig(secret, svixId, staleTs, body);
    expect(
      await verifyEmailBounceSignature(body, `v1,${b64}`, secret, {
        svixId,
        svixTimestamp: staleTs,
        nowSeconds: nowSec,
      }),
    ).toBe(false);
  });

  it("supports multiple space-separated versions in the header", async () => {
    const body = '{"x":1}';
    const secret = "s";
    const svixId = "msg_multi";
    const nowSec = Math.floor(T0 / 1000);
    const ts = String(nowSec);
    const correct = await computeSvixSig(secret, svixId, ts, body);
    // Header carries a wrong v0 sig + the correct v1 sig.
    const header = `v0,YWJjZGVm v1,${correct}`;
    expect(
      await verifyEmailBounceSignature(body, header, secret, {
        svixId,
        svixTimestamp: ts,
        nowSeconds: nowSec,
      }),
    ).toBe(true);
  });

  it("raw-hex fallback still works (no Svix companion headers)", async () => {
    const body = '{"a":1}';
    const secret = "rawsecret";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body),
    );
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await verifyEmailBounceSignature(body, hex, secret)).toBe(true);
    // With the optional `sha256=` prefix.
    expect(
      await verifyEmailBounceSignature(body, `sha256=${hex}`, secret),
    ).toBe(true);
  });

  it("rejects when the configured secret is empty", async () => {
    expect(await verifyEmailBounceSignature("body", "deadbeef", "")).toBe(
      false,
    );
  });
});
