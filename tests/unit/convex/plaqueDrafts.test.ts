/**
 * Story 6.8 — Memorial plaque draft mutation tests (FR49).
 *
 * Scope:
 *   - `requestPlaqueDraft` mutation: auth gating, validation, version
 *     increment per interment, audit emission, action scheduling,
 *     epitaph cap.
 *   - `retryPlaqueDraft` mutation: admin-only gate, state guards,
 *     retry counter bump, re-schedule.
 *   - `_recordPlaqueReady` / `_recordPlaqueFailed` internal mutations:
 *     happy path patches + retry-counter bump on failure.
 *   - `_bumpPlaqueDraftRetryCount` internal mutation: counter bump
 *     + status reset.
 *   - `listForInterment` query: auth gating, version-descending sort,
 *     joined `generatedByName`.
 *   - `getPlaqueUrl` query: auth gating, null branch (not ready),
 *     signed-URL branch.
 *   - Path-string parity: the mutation's scheduled-action function
 *     path matches the action file's exported constant.
 *
 * Strategy: hand-mocked ctx mirroring `contracts-pdf.test.ts`. We
 * intentionally avoid `convex-test` because the project does not
 * check in `convex/_generated/` (see `convex/gpsImport.ts` line 21-34).
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

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";
import { HOUR_MS } from "../../../convex/lib/time";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import { getFunctionName } from "convex/server";

import {
  __testing,
  _bumpPlaqueDraftRetryCount,
  _recordPlaqueFailed,
  _recordPlaqueReady,
  getPlaqueUrl,
  listForInterment,
  requestPlaqueDraft,
  retryPlaqueDraft,
} from "../../../convex/plaqueDrafts";
import { GENERATE_PLAQUE_DRAFT_PDF_FUNCTION_PATH } from "../../../convex/actions/generatePlaquePdf";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-05-24T08:00:00+08:00").getTime();
const USER_ID = "users:abc123";
const SESSION_ID = "authSessions:def456";

type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface IntermentFixture {
  _id: string;
  _creationTime: number;
  lotId: string;
  occupantId: string;
  scheduledAt: number;
  status: "scheduled" | "completed" | "cancelled";
  scheduledBy: string;
  scheduledAt_createdAt: number;
}

interface PlaqueDraftFixture {
  _id: string;
  _creationTime: number;
  intermentId: string;
  deceasedName: string;
  bornYear: number;
  diedYear: number;
  dateFormat: "arabic" | "roman";
  epitaph?: string;
  version: number;
  pdfStorageId?: string;
  pdfStatus: "pending" | "ready" | "failed";
  generatedBy: string;
  generatedAt: number;
  retryCount: number;
  lastError?: string;
}

interface CtxBag {
  interments: Map<string, IntermentFixture>;
  drafts: Map<string, PlaqueDraftFixture>;
  auditInserts: Array<{ row: Record<string, unknown> }>;
  scheduledRuns: Array<{
    delayMs: number;
    functionPath: string;
    args: Record<string, unknown>;
  }>;
  storageUrlsByBlob: Map<string, string>;
  patches: Array<{ id: string; patch: Record<string, unknown> }>;
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
}

function makeCtx(opts: {
  roles?: RoleName[];
  interments?: IntermentFixture[];
  drafts?: PlaqueDraftFixture[];
  authenticated?: boolean;
  userName?: string;
  storageUrlsByBlob?: Map<string, string>;
}): CtxBag {
  const interments = new Map<string, IntermentFixture>(
    (opts.interments ?? []).map((i) => [i._id, i]),
  );
  const drafts = new Map<string, PlaqueDraftFixture>(
    (opts.drafts ?? []).map((d) => [d._id, d]),
  );
  const auditInserts: Array<{ row: Record<string, unknown> }> = [];
  const scheduledRuns: Array<{
    delayMs: number;
    functionPath: string;
    args: Record<string, unknown>;
  }> = [];
  const storageUrlsByBlob =
    opts.storageUrlsByBlob ?? new Map<string, string>();
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  if (opts.authenticated === false) {
    mockedGetAuthUserId.mockResolvedValue(null);
    mockedGetAuthSessionId.mockResolvedValue(null);
  } else {
    mockedGetAuthUserId.mockResolvedValue(USER_ID as never);
    mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);
  }

  const user = {
    _id: USER_ID,
    _creationTime: T0 - 1000,
    email: "office@example.com",
    name: opts.userName ?? "Maria Cruz",
    isActive: true,
  };
  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: USER_ID,
    expirationTime: T0 + 30 * 24 * HOUR_MS,
  };
  const userRoles = (opts.roles ?? ["office_staff"]).map((role, idx) => ({
    _id: `userRoles:${idx}`,
    _creationTime: T0,
    userId: USER_ID,
    role,
    grantedAt: T0,
    grantedBy: USER_ID,
  }));

  function tableQuery(table: string) {
    if (table === "userRoles") {
      return {
        withIndex: () => ({
          collect: async () => userRoles,
        }),
      };
    }
    if (table === "plaqueDrafts") {
      const allDrafts = Array.from(drafts.values());
      const filterFns: Array<(row: PlaqueDraftFixture) => boolean> = [];
      const withIndexShape = {
        withIndex: (_idx: string, builder?: unknown) => {
          if (typeof builder === "function") {
            // Mock the builder API — we just record predicate calls.
            const fakeQ = {
              eq: (field: string, value: unknown) => {
                filterFns.push((r) => {
                  const v = (r as unknown as Record<string, unknown>)[field];
                  return v === value;
                });
                return fakeQ;
              },
            };
            (builder as (q: unknown) => unknown)(fakeQ);
          }
          return {
            collect: async () =>
              allDrafts.filter((r) => filterFns.every((f) => f(r))),
          };
        },
      };
      return withIndexShape;
    }
    return {
      withIndex: () => ({
        collect: async () => [],
        first: async () => null,
        unique: async () => null,
      }),
      collect: async () => [],
    };
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === USER_ID) return user;
        if (id === SESSION_ID) return session;
        if (interments.has(id)) return interments.get(id);
        if (drafts.has(id)) return drafts.get(id);
        return null;
      }),
      query: vi.fn((table: string) => tableQuery(table)),
      insert: vi.fn(async (table: string, row: Record<string, unknown>) => {
        inserts.push({ table, row });
        if (table === "auditLog") {
          auditInserts.push({ row });
          return `auditLog:${auditInserts.length}`;
        }
        if (table === "plaqueDrafts") {
          const id = `plaqueDrafts:${drafts.size + 1}`;
          drafts.set(id, {
            _id: id,
            _creationTime: T0,
            ...(row as object),
          } as PlaqueDraftFixture);
          return id;
        }
        return `${table}:?`;
      }),
      patch: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        patches.push({ id, patch });
        if (drafts.has(id)) {
          const existing = drafts.get(id)!;
          drafts.set(id, { ...existing, ...patch } as PlaqueDraftFixture);
        }
      }),
    },
    scheduler: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runAfter: vi.fn(async (delayMs: number, ref: any, args: any) => {
        let functionPath: string;
        try {
          functionPath = getFunctionName(ref);
        } catch {
          functionPath = typeof ref === "string" ? ref : "(unknown)";
        }
        scheduledRuns.push({ delayMs, functionPath, args });
        return "scheduledFunctions:1";
      }),
    },
    storage: {
      getUrl: vi.fn(async (blobId: string) => {
        return storageUrlsByBlob.get(blobId) ?? null;
      }),
    },
  };

  return {
    interments,
    drafts,
    auditInserts,
    scheduledRuns,
    storageUrlsByBlob,
    patches,
    inserts,
    ctx,
  };
}

function makeInterment(
  overrides: Partial<IntermentFixture> = {},
): IntermentFixture {
  return {
    _id: overrides._id ?? "interments:1",
    _creationTime: T0,
    lotId: "lots:1",
    occupantId: "occupants:1",
    scheduledAt: T0 + 7 * 24 * HOUR_MS,
    status: "scheduled",
    scheduledBy: USER_ID,
    scheduledAt_createdAt: T0,
    ...overrides,
  };
}

function makeDraft(
  overrides: Partial<PlaqueDraftFixture> = {},
): PlaqueDraftFixture {
  return {
    _id: overrides._id ?? "plaqueDrafts:1",
    _creationTime: T0,
    intermentId: "interments:1",
    deceasedName: "MATEO REYES",
    bornYear: 1942,
    diedYear: 2026,
    dateFormat: "arabic",
    version: 1,
    pdfStatus: "pending",
    generatedBy: USER_ID,
    generatedAt: T0,
    retryCount: 0,
    ...overrides,
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

describe("path-string parity (defense against cross-runtime drift)", () => {
  it("the V8 mutation's scheduled-action path matches the Node action's exported constant", () => {
    expect(__testing.GENERATE_PLAQUE_DRAFT_PDF_ACTION_PATH).toBe(
      GENERATE_PLAQUE_DRAFT_PDF_FUNCTION_PATH,
    );
    expect(__testing.GENERATE_PLAQUE_DRAFT_PDF_ACTION_PATH).toBe(
      "actions/generatePlaquePdf:runForDraft",
    );
  });
});

describe("requestPlaqueDraft", () => {
  const run = handlerOf(requestPlaqueDraft);

  it("inserts a v1 draft, schedules the action, emits an audit row (office_staff)", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
    });

    const result = (await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    })) as { plaqueDraftId: string; version: number };

    expect(result.version).toBe(1);
    expect(result.plaqueDraftId).toBeTruthy();

    // Draft row inserted with pending status.
    const draftInsert = bag.inserts.find((i) => i.table === "plaqueDrafts");
    expect(draftInsert).toBeDefined();
    expect(draftInsert!.row.pdfStatus).toBe("pending");
    expect(draftInsert!.row.version).toBe(1);
    expect(draftInsert!.row.deceasedName).toBe("Mateo Reyes");
    expect(draftInsert!.row.bornYear).toBe(1942);
    expect(draftInsert!.row.diedYear).toBe(2026);

    // Scheduler was called with the action's canonical path.
    expect(bag.scheduledRuns).toHaveLength(1);
    const scheduled = bag.scheduledRuns[0]!;
    expect(scheduled.delayMs).toBe(0);
    expect(scheduled.functionPath).toBe(
      "actions/generatePlaquePdf:runForDraft",
    );
    expect(scheduled.args).toMatchObject({
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    });

    // Audit row keyed on the lot, action: "create".
    expect(bag.auditInserts).toHaveLength(1);
    const auditRow = bag.auditInserts[0]!.row;
    expect(auditRow.action).toBe("create");
    expect(auditRow.entityType).toBe("lot");
    expect(auditRow.entityId).toBe(interment.lotId);
  });

  it("increments version for a second draft against the same interment", async () => {
    const interment = makeInterment();
    const priorDraft = makeDraft({
      _id: "plaqueDrafts:1",
      intermentId: interment._id,
      version: 1,
      pdfStatus: "ready",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [priorDraft],
    });

    const result = (await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "roman",
    })) as { version: number };

    expect(result.version).toBe(2);
    // The prior draft is preserved (we don't clear / overwrite).
    expect(bag.drafts.get("plaqueDrafts:1")?.version).toBe(1);
  });

  it("rejects field_worker callers with FORBIDDEN", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["field_worker"],
      interments: [interment],
    });
    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.scheduledRuns).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });

  it("rejects customer-role callers with FORBIDDEN", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["customer"],
      interments: [interment],
    });
    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });

  it("rejects unauthenticated callers", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      authenticated: false,
      interments: [interment],
    });
    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it("throws NOT_FOUND when the interment doesn't exist", async () => {
    const bag = makeCtx({ roles: ["office_staff"], interments: [] });
    const thrown = await run(bag.ctx, {
      intermentId: "interments:ghost",
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });

  it("throws VALIDATION when bornYear >= diedYear", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
    });
    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 2026,
      diedYear: 2026,
      dateFormat: "arabic",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("throws VALIDATION when epitaph exceeds 240 chars", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
    });
    const tooLong = "A".repeat(241);
    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
      epitaph: tooLong,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.VALIDATION);
  });

  it("trims the deceased name + epitaph before insert", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
    });
    await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "  Mateo Reyes  ",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
      epitaph: "  A devoted father  ",
    });
    const draftInsert = bag.inserts.find((i) => i.table === "plaqueDrafts");
    expect(draftInsert!.row.deceasedName).toBe("Mateo Reyes");
    expect(draftInsert!.row.epitaph).toBe("A devoted father");
  });

  it("throws INVARIANT_VIOLATION { kind: 'plaque_version_race' } when a concurrent submit produces a duplicate version", async () => {
    // Simulate the H7 race: two office_staff sessions both observe
    // maxVersion = 0 for the same interment and both attempt to insert
    // version: 1. The loser's post-insert verify must throw so Convex's
    // OCC layer retries it.
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
    });

    // Pre-seed a "racing" v1 row that represents the WINNER of the
    // race — committed in another mutation between this mutation's
    // pre-insert read and its post-insert verify. The mock's
    // `plaqueDrafts` query always reflects the current Map, so we
    // monkey-patch `ctx.db.query` to return an EMPTY slice for the
    // first read (pre-insert "compute next version") and the full
    // slice on the second read (post-insert verify).
    const winningRow: PlaqueDraftFixture = makeDraft({
      _id: "plaqueDrafts:winner",
      intermentId: interment._id,
      version: 1,
      pdfStatus: "pending",
    });
    bag.drafts.set(winningRow._id, winningRow);

    let scanCount = 0;
    const originalQuery = bag.ctx.db.query;
    bag.ctx.db.query = vi.fn((table: string) => {
      if (table === "plaqueDrafts") {
        scanCount += 1;
        const isPreInsert = scanCount === 1;
        return {
          withIndex: (_idx: string, _builder?: unknown) => ({
            collect: async () =>
              isPreInsert
                ? []
                : Array.from(bag.drafts.values()).filter(
                    (r) => r.intermentId === interment._id,
                  ),
          }),
        };
      }
      return (originalQuery as (t: string) => unknown)(table);
    });

    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
      deceasedName: "Mateo Reyes",
      bornYear: 1942,
      diedYear: 2026,
      dateFormat: "arabic",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    const details = (thrown as ConvexError<Value>).data as unknown as {
      details: { kind: string };
    };
    expect(details.details.kind).toBe("plaque_version_race");
    // The loser must not have scheduled the action or emitted the
    // audit — the throw fires BEFORE those side-effects.
    expect(bag.scheduledRuns).toHaveLength(0);
    expect(bag.auditInserts).toHaveLength(0);
  });
});

describe("retryPlaqueDraft", () => {
  const run = handlerOf(retryPlaqueDraft);

  it("admin can retry a failed draft (bumps retryCount, re-schedules action)", async () => {
    const interment = makeInterment();
    const draft = makeDraft({
      pdfStatus: "failed",
      retryCount: 1,
      lastError: "PDFKit error",
    });
    const bag = makeCtx({
      roles: ["admin"],
      interments: [interment],
      drafts: [draft],
    });
    const result = (await run(bag.ctx, {
      plaqueDraftId: draft._id,
    })) as { retryCount: number };
    expect(result.retryCount).toBe(2);
    // Status flipped back to pending + lastError cleared.
    const patched = bag.drafts.get(draft._id)!;
    expect(patched.pdfStatus).toBe("pending");
    expect(patched.retryCount).toBe(2);
    expect(patched.lastError).toBeUndefined();
    // Action re-scheduled.
    expect(bag.scheduledRuns).toHaveLength(1);
    expect(bag.scheduledRuns[0]!.functionPath).toBe(
      "actions/generatePlaquePdf:runForDraft",
    );
  });

  it("office_staff cannot retry — FORBIDDEN", async () => {
    const interment = makeInterment();
    const draft = makeDraft({ pdfStatus: "failed", retryCount: 1 });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [draft],
    });
    const thrown = await run(bag.ctx, {
      plaqueDraftId: draft._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
    expect(bag.scheduledRuns).toHaveLength(0);
  });

  it("rejects retry on a draft that is already ready", async () => {
    const interment = makeInterment();
    const draft = makeDraft({
      pdfStatus: "ready",
      pdfStorageId: "kg-blob",
    });
    const bag = makeCtx({
      roles: ["admin"],
      interments: [interment],
      drafts: [draft],
    });
    const thrown = await run(bag.ctx, {
      plaqueDraftId: draft._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("rejects retry on a draft that is currently pending (already in flight)", async () => {
    const interment = makeInterment();
    const draft = makeDraft({ pdfStatus: "pending" });
    const bag = makeCtx({
      roles: ["admin"],
      interments: [interment],
      drafts: [draft],
    });
    const thrown = await run(bag.ctx, {
      plaqueDraftId: draft._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("_recordPlaqueReady", () => {
  const run = handlerOf(_recordPlaqueReady);

  it("patches the draft to ready + clears lastError", async () => {
    const interment = makeInterment();
    const draft = makeDraft({ pdfStatus: "pending" });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [draft],
    });
    await run(bag.ctx, {
      plaqueDraftId: draft._id,
      pdfStorageId: "kg-fresh-blob",
    });
    const patched = bag.drafts.get(draft._id)!;
    expect(patched.pdfStatus).toBe("ready");
    expect(patched.pdfStorageId).toBe("kg-fresh-blob");
    expect(patched.lastError).toBeUndefined();
    // Audit row emitted with the ready transition.
    const auditRow = bag.auditInserts[bag.auditInserts.length - 1]!.row;
    expect(auditRow.action).toBe("update");
    expect(auditRow.reason).toBe("plaque_pdf_ready");
  });

  it("no-ops when the draft has been deleted between schedule and callback", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    await expect(
      run(bag.ctx, {
        plaqueDraftId: "plaqueDrafts:ghost",
        pdfStorageId: "kg-blob",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("_recordPlaqueFailed", () => {
  const run = handlerOf(_recordPlaqueFailed);

  it("patches the draft to failed and bumps retryCount", async () => {
    const interment = makeInterment();
    const draft = makeDraft({ pdfStatus: "pending", retryCount: 0 });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [draft],
    });
    await run(bag.ctx, {
      plaqueDraftId: draft._id,
      error: "PDFKit OOM",
    });
    const patched = bag.drafts.get(draft._id)!;
    expect(patched.pdfStatus).toBe("failed");
    expect(patched.lastError).toBe("PDFKit OOM");
    expect(patched.retryCount).toBe(1);
  });

  it("at retryCount == 3 the patch still flips status to failed (cap-check lives in the sweep)", async () => {
    const interment = makeInterment();
    const draft = makeDraft({ pdfStatus: "pending", retryCount: 2 });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [draft],
    });
    await run(bag.ctx, { plaqueDraftId: draft._id, error: "x" });
    const patched = bag.drafts.get(draft._id)!;
    expect(patched.pdfStatus).toBe("failed");
    expect(patched.retryCount).toBe(3);
  });
});

describe("_bumpPlaqueDraftRetryCount", () => {
  const run = handlerOf(_bumpPlaqueDraftRetryCount);

  it("bumps retryCount and flips status back to pending", async () => {
    const interment = makeInterment();
    const draft = makeDraft({ pdfStatus: "failed", retryCount: 1 });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [draft],
    });
    const result = (await run(bag.ctx, {
      plaqueDraftId: draft._id,
    })) as { retryCount: number };
    expect(result.retryCount).toBe(2);
    const patched = bag.drafts.get(draft._id)!;
    expect(patched.retryCount).toBe(2);
    expect(patched.pdfStatus).toBe("pending");
  });
});

describe("listForInterment", () => {
  const run = handlerOf(listForInterment);

  it("returns draft rows sorted by version descending with joined generatedByName", async () => {
    const interment = makeInterment();
    const v1 = makeDraft({ _id: "plaqueDrafts:1", version: 1 });
    const v2 = makeDraft({
      _id: "plaqueDrafts:2",
      version: 2,
      pdfStatus: "ready",
      pdfStorageId: "kg-v2-blob",
    });
    const v3 = makeDraft({ _id: "plaqueDrafts:3", version: 3 });
    const bag = makeCtx({
      roles: ["office_staff"],
      interments: [interment],
      drafts: [v1, v2, v3],
      userName: "Maria Cruz",
    });
    const rows = (await run(bag.ctx, {
      intermentId: interment._id,
    })) as Array<{ version: number; generatedByName: string }>;
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1]);
    for (const r of rows) {
      expect(r.generatedByName).toBe("Maria Cruz");
    }
  });

  it("rejects field_worker callers", async () => {
    const interment = makeInterment();
    const bag = makeCtx({
      roles: ["field_worker"],
      interments: [interment],
    });
    const thrown = await run(bag.ctx, {
      intermentId: interment._id,
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.FORBIDDEN);
  });
});

describe("getPlaqueUrl", () => {
  const run = handlerOf(getPlaqueUrl);

  it("returns null when draft is still pending", async () => {
    const draft = makeDraft({ pdfStatus: "pending" });
    const bag = makeCtx({
      roles: ["office_staff"],
      drafts: [draft],
    });
    const result = (await run(bag.ctx, {
      plaqueDraftId: draft._id,
    })) as { url: string | null };
    expect(result.url).toBeNull();
  });

  it("returns the signed URL when ready", async () => {
    const draft = makeDraft({
      pdfStatus: "ready",
      pdfStorageId: "kg-ready-blob",
    });
    const bag = makeCtx({
      roles: ["office_staff"],
      drafts: [draft],
      storageUrlsByBlob: new Map([["kg-ready-blob", "https://signed/url"]]),
    });
    const result = (await run(bag.ctx, {
      plaqueDraftId: draft._id,
    })) as { url: string | null };
    expect(result.url).toBe("https://signed/url");
  });

  it("throws NOT_FOUND on a bogus draft id", async () => {
    const bag = makeCtx({ roles: ["office_staff"] });
    const thrown = await run(bag.ctx, {
      plaqueDraftId: "plaqueDrafts:ghost",
    }).catch((e) => e);
    expect(getCode(thrown)).toBe(ErrorCode.NOT_FOUND);
  });
});
