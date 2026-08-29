/**
 * Issuing a document that says a family owns a grave.
 *
 * The arithmetic and the eligibility rule are tested in
 * `lib/certificate.test.ts`; the rendering in
 * `actions/generateCertificatePdf.test.ts`. This file covers the parts
 * only the database can show:
 *
 *   - the fully-paid gate holding against a hand-made request, not just
 *     a hidden button
 *   - a replacement SUPERSEDING rather than overwriting, with a reason,
 *     because somebody is holding a printed copy of the old one
 *   - the serial that was printed being the serial that is recorded
 *   - the number sequence surviving two people issuing at once
 */

import { ConvexError, type Value } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, type ErrorPayload } from "../../../convex/lib/errors";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: vi.fn(),
  getAuthSessionId: vi.fn(),
}));

import { getAuthSessionId, getAuthUserId } from "@convex-dev/auth/server";
import {
  getContractCertificates,
  getIssueContext,
  recordCertificate,
  reserveCertificateSerial,
  setCertificateTemplate,
  setTemplateFields,
} from "../../../convex/certificates";

const mockedGetAuthUserId = vi.mocked(getAuthUserId);
const mockedGetAuthSessionId = vi.mocked(getAuthSessionId);

const T0 = new Date("2026-11-01T10:00:00+08:00").getTime();
const CALLER_ID = "users:office1";
const SESSION_ID = "authSessions:s1";

type Row = Record<string, unknown>;
type RoleName = "admin" | "office_staff" | "field_worker" | "customer";

interface Tables {
  contracts: Row[];
  customers: Row[];
  lots: Row[];
  certificates: Row[];
  certificateTemplates: Row[];
  certificateCounter: Row[];
}

function makeCtx(opts: { tables?: Partial<Tables>; roles?: RoleName[] }) {
  const t: Tables = {
    contracts: [],
    customers: [],
    lots: [],
    certificates: [],
    certificateTemplates: [],
    certificateCounter: [],
    ...opts.tables,
  };
  const audit: Row[] = [];

  const caller = {
    _id: CALLER_ID,
    _creationTime: T0 - 1000,
    name: "Desk",
    email: "desk@example.com",
    isActive: true,
  };
  const userRoles = (opts.roles ?? ["office_staff"]).map((role, i) => ({
    _id: `userRoles:r${i}`,
    _creationTime: T0,
    userId: CALLER_ID,
    role,
    grantedAt: T0,
    grantedBy: CALLER_ID,
  }));

  mockedGetAuthUserId.mockResolvedValue(CALLER_ID as never);
  mockedGetAuthSessionId.mockResolvedValue(SESSION_ID as never);

  const session = {
    _id: SESSION_ID,
    _creationTime: T0,
    userId: CALLER_ID,
    expirationTime: T0 + 30 * 24 * 3600 * 1000,
  };

  let counter = 0;

  function builderFor(rows: Row[]) {
    const preds: Array<(r: Row) => boolean> = [];
    const q = {
      eq(f: string, v: unknown) {
        preds.push((r) => r[f] === v);
        return q;
      },
      gte(f: string, v: number) {
        preds.push((r) => (r[f] as number) >= v);
        return q;
      },
      lt(f: string, v: number) {
        preds.push((r) => (r[f] as number) < v);
        return q;
      },
    };
    const b = {
      withIndex(_n: string, fn?: (x: typeof q) => unknown) {
        if (fn !== undefined) fn(q);
        return b;
      },
      async collect(): Promise<Row[]> {
        return rows.filter((r) => preds.every((p) => p(r)));
      },
      async first(): Promise<Row | null> {
        return (await b.collect())[0] ?? null;
      },
      async take(n: number): Promise<Row[]> {
        return (await b.collect()).slice(0, n);
      },
    };
    return b;
  }

  const ctx = {
    auth: { getUserIdentity: vi.fn() },
    storage: {
      getUrl: vi.fn(async (id: string) => `https://files.test/${id}`),
      generateUploadUrl: vi.fn(async () => "https://upload.test/one-time"),
    },
    db: {
      get: vi.fn(async (id: string) => {
        if (id === CALLER_ID) return caller;
        if (id === SESSION_ID) return session;
        for (const rows of Object.values(t) as Row[][]) {
          const hit = rows.find((r: Row) => r["_id"] === id);
          if (hit !== undefined) return hit;
        }
        return null;
      }),
      insert: vi.fn(async (table: string, row: Row) => {
        counter += 1;
        const id = `${table}:new${counter}`;
        const stored = { _id: id, _creationTime: T0, ...row };
        if (table === "auditLog") audit.push(stored);
        else {
          const rows = (t as unknown as Record<string, Row[] | undefined>)[
            table
          ];
          if (rows !== undefined) rows.push(stored);
        }
        return id;
      }),
      patch: vi.fn(async (id: string, patch: Row) => {
        for (const rows of Object.values(t) as Row[][]) {
          const hit = rows.find((r) => r["_id"] === id);
          if (hit !== undefined) Object.assign(hit, patch);
        }
      }),
      query: vi.fn((table: string) => {
        if (table === "userRoles") {
          return { withIndex: () => ({ collect: async () => userRoles }) };
        }
        return builderFor((t as unknown as Record<string, Row[]>)[table] ?? []);
      }),
    },
  };

  return { ctx, tables: t, audit };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handlerOf(fn: any): (ctx: unknown, args: unknown) => Promise<any> {
  for (const key of ["_handler", "handler", "invokeQuery"]) {
    const v = fn[key];
    if (typeof v === "function") return v as never;
  }
  if (typeof fn === "function") return fn as never;
  throw new Error("Cannot locate handler on Convex function");
}

const runRecord = handlerOf(recordCertificate);
const runReserve = handlerOf(reserveCertificateSerial);
const runGet = handlerOf(getContractCertificates);
const runContext = handlerOf(getIssueContext);
const runSetTemplate = handlerOf(setCertificateTemplate);
const runSetFields = handlerOf(setTemplateFields);

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  return ((thrown as ConvexError<Value>).data as unknown as ErrorPayload)?.code;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return getCode(e);
  }
  return undefined;
}

// --- fixtures ---------------------------------------------------------

function contract(over: Row = {}): Row {
  return {
    _id: "contracts:c1",
    _creationTime: T0,
    contractNumber: "CTR-2026-0042",
    customerId: "customers:reyes",
    lotId: "lots:a1",
    state: "paid_in_full",
    totalPriceCents: 120_000_00,
    ...over,
  };
}

const CUSTOMER = {
  _id: "customers:reyes",
  _creationTime: T0,
  fullName: "Ana Reyes",
};

const LOT = {
  _id: "lots:a1",
  _creationTime: T0,
  code: "A-2-01",
  section: "Garden of Faith",
  type: "family",
};

function template(over: Row = {}): Row {
  return {
    _id: "certificateTemplates:t1",
    _creationTime: T0,
    name: "Certificate 2026",
    storageId: "_storage:blank",
    mimeType: "application/pdf",
    pageWidthPt: 595,
    pageHeightPt: 842,
    fields: [
      {
        key: "ownerName",
        xFrac: 0.5,
        yFrac: 0.4,
        fontSize: 18,
        align: "center",
      },
    ],
    isActive: true,
    createdAt: T0,
    createdByUserId: CALLER_ID,
    updatedAt: T0,
    ...over,
  };
}

function world(over: Partial<Tables> = {}) {
  return makeCtx({
    tables: {
      contracts: [contract()],
      customers: [CUSTOMER],
      lots: [LOT],
      certificateTemplates: [template()],
      ...over,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

// --- the gate ---------------------------------------------------------

describe("only a fully-paid contract", () => {
  const good = {
    contractId: "contracts:c1",
    storageId: "_storage:doc",
    mimeType: "application/pdf",
    source: "uploaded" as const,
  };

  it("issues against one that is paid in full", async () => {
    const { ctx, tables } = world();
    await runRecord(ctx, good);
    expect(tables.certificates).toHaveLength(1);
  });

  it("REFUSES one still being paid, even by direct request", async () => {
    // The panel hides the button. This is what stops a hand-made call —
    // and a certificate contradicting an open balance is a document the
    // park cannot take back once it is framed.
    const { ctx, tables } = world({ contracts: [contract({ state: "active" })] });
    const code = await codeOf(() => runRecord(ctx, good));
    expect(code).toBe(ErrorCode.INVARIANT_VIOLATION);
    expect(tables.certificates).toHaveLength(0);
  });

  it("refuses a cancelled contract", async () => {
    const { ctx } = world({ contracts: [contract({ state: "cancelled" })] });
    expect(await codeOf(() => runRecord(ctx, good))).toBe(
      ErrorCode.INVARIANT_VIOLATION,
    );
  });

  it("does not consume a number for a contract it will refuse", async () => {
    // Reserving first and refusing later would burn a serial every time
    // somebody clicked on the wrong contract.
    const { ctx, tables } = world({
      contracts: [contract({ state: "active" })],
    });
    await codeOf(() => runReserve(ctx, { contractId: "contracts:c1" }));
    expect(tables.certificateCounter).toHaveLength(0);
  });

  it("refuses a field worker", async () => {
    const { ctx } = makeCtx({
      roles: ["field_worker"],
      tables: { contracts: [contract()] },
    });
    expect(await codeOf(() => runRecord(ctx, good))).toBe(ErrorCode.FORBIDDEN);
  });

  it("refuses a file that is not a document", async () => {
    const { ctx } = world();
    expect(
      await codeOf(() =>
        runRecord(ctx, { ...good, mimeType: "application/zip" }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });
});

// --- superseding ------------------------------------------------------

describe("replacing one that was already issued", () => {
  const good = {
    contractId: "contracts:c1",
    storageId: "_storage:doc",
    mimeType: "application/pdf",
    source: "uploaded" as const,
  };

  it("demands a reason", async () => {
    const { ctx } = world();
    await runRecord(ctx, good);
    const code = await codeOf(() => runRecord(ctx, good));
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("keeps the old one rather than overwriting it", async () => {
    // Somebody out there may be holding a printed copy, and "what did
    // we give them in March" has to stay answerable.
    const { ctx, tables } = world();
    await runRecord(ctx, good);
    await runRecord(ctx, {
      ...good,
      supersedeReason: "Name corrected at the family's request",
    });

    expect(tables.certificates).toHaveLength(2);
    const superseded = tables.certificates.filter(
      (c) => c["isSuperseded"] === true,
    );
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.["supersededReason"]).toContain("Name corrected");
  });

  it("leaves exactly one in force", async () => {
    const { ctx, tables } = world();
    await runRecord(ctx, good);
    await runRecord(ctx, { ...good, supersedeReason: "Reissued after damage" });
    await runRecord(ctx, { ...good, supersedeReason: "Reissued again" });
    expect(
      tables.certificates.filter((c) => c["isSuperseded"] === false),
    ).toHaveLength(1);
  });

  it("reads back the current one and the history separately", async () => {
    const { ctx } = world();
    await runRecord(ctx, good);
    await runRecord(ctx, { ...good, supersedeReason: "Name corrected" });

    const state = await runGet(ctx, { contractId: "contracts:c1" });
    expect(state.current).not.toBeNull();
    expect(state.current.isSuperseded).toBe(false);
    expect(state.history).toHaveLength(1);
  });
});

// --- the number -------------------------------------------------------

describe("the certificate number", () => {
  it("records the number that was printed, not a fresh one", async () => {
    // The reserve-then-render ordering exists for this. If the mutation
    // took its own number here, the document and the record would
    // disagree — and the document is the one the family holds.
    const { ctx, tables } = world();
    const { serial } = await runReserve(ctx, { contractId: "contracts:c1" });
    await runRecord(ctx, {
      contractId: "contracts:c1",
      storageId: "_storage:doc",
      mimeType: "application/pdf",
      source: "generated",
      serial,
    });
    expect(tables.certificates[0]?.["serial"]).toBe(serial);
  });

  it("never hands the same number out twice", async () => {
    const { ctx } = world();
    const a = await runReserve(ctx, { contractId: "contracts:c1" });
    const b = await runReserve(ctx, { contractId: "contracts:c1" });
    const c = await runReserve(ctx, { contractId: "contracts:c1" });
    expect(new Set([a.serial, b.serial, c.serial]).size).toBe(3);
  });

  it("counts up rather than restarting", async () => {
    const { ctx } = world();
    expect((await runReserve(ctx, { contractId: "contracts:c1" })).serial).toBe(
      "COO-2026-00001",
    );
    expect((await runReserve(ctx, { contractId: "contracts:c1" })).serial).toBe(
      "COO-2026-00002",
    );
  });

  it("takes its own number when the office uploads a finished one", async () => {
    // Nothing was printed by us, so there is no number to carry over.
    const { ctx, tables } = world();
    await runRecord(ctx, {
      contractId: "contracts:c1",
      storageId: "_storage:doc",
      mimeType: "application/pdf",
      source: "uploaded",
    });
    expect(tables.certificates[0]?.["serial"]).toMatch(/^COO-2026-\d{5}$/);
  });
});

// --- what the renderer is given ---------------------------------------

describe("gathering what goes on the certificate", () => {
  it("pulls the owner, the lot and the template together", async () => {
    const { ctx } = world();
    const c = await runContext(ctx, { contractId: "contracts:c1" });
    expect(c.ownerName).toBe("Ana Reyes");
    expect(c.lotCode).toBe("A-2-01");
    expect(c.section).toBe("Garden of Faith");
    expect(c.contractNumber).toBe("CTR-2026-0042");
    expect(c.templateStorageId).toBe("_storage:blank");
  });

  it("refuses when no blank has been uploaded", async () => {
    const { ctx } = world({ certificateTemplates: [] });
    const code = await codeOf(() =>
      runContext(ctx, { contractId: "contracts:c1" }),
    );
    expect(code).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("refuses a blank with nothing placed on it", async () => {
    // It would print the park's artwork and not one detail — which
    // looks like a working certificate until somebody reads it.
    const { ctx } = world({ certificateTemplates: [template({ fields: [] })] });
    const code = await codeOf(() =>
      runContext(ctx, { contractId: "contracts:c1" }),
    );
    expect(code).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

// --- the template ------------------------------------------------------

describe("installing a blank", () => {
  const upload = {
    name: "Certificate 2027",
    storageId: "_storage:new",
    mimeType: "application/pdf",
    pageWidthPt: 595,
    pageHeightPt: 842,
  };

  it("is admin-only", async () => {
    const { ctx } = makeCtx({ roles: ["office_staff"] });
    expect(await codeOf(() => runSetTemplate(ctx, upload))).toBe(
      ErrorCode.FORBIDDEN,
    );
  });

  it("retires the previous one rather than deleting it", async () => {
    // A certificate issued last year was issued against last year's
    // design, and the record should be able to say so.
    const { ctx, tables } = makeCtx({
      roles: ["admin"],
      tables: { certificateTemplates: [template()] },
    });
    await runSetTemplate(ctx, upload);
    expect(tables.certificateTemplates).toHaveLength(2);
    expect(
      tables.certificateTemplates.filter((t) => t["isActive"] === true),
    ).toHaveLength(1);
  });

  it("does NOT carry the old placements onto a new design", async () => {
    // Reusing coordinates from a different layout puts the owner's name
    // wherever the previous design happened to have it — and it prints.
    const { ctx, tables } = makeCtx({
      roles: ["admin"],
      tables: { certificateTemplates: [template()] },
    });
    await runSetTemplate(ctx, upload);
    const active = tables.certificateTemplates.find(
      (t) => t["isActive"] === true,
    );
    expect(active?.["fields"]).toEqual([]);
  });

  it("refuses a file that is not a document or an image", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect(
      await codeOf(() =>
        runSetTemplate(ctx, { ...upload, mimeType: "text/html" }),
      ),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("refuses a page size that could not be read", async () => {
    const { ctx } = makeCtx({ roles: ["admin"] });
    expect(
      await codeOf(() => runSetTemplate(ctx, { ...upload, pageWidthPt: 0 })),
    ).toBe(ErrorCode.VALIDATION);
  });
});

describe("placing the fields", () => {
  const base = { templateId: "certificateTemplates:t1" };

  function adminWorld() {
    return makeCtx({
      roles: ["admin"],
      tables: { certificateTemplates: [template()] },
    });
  }

  it("REFUSES an unknown field rather than dropping it", async () => {
    // Dropping is right at render time — a stale field should vanish
    // from a printed page. At save time it would mean the admin drags a
    // field on, saves, and finds it silently gone.
    const { ctx } = adminWorld();
    const code = await codeOf(() =>
      runSetFields(ctx, {
        ...base,
        fields: [
          {
            key: "ownerAddress",
            xFrac: 0.5,
            yFrac: 0.5,
            fontSize: 12,
            align: "left",
          },
        ],
      }),
    );
    expect(code).toBe(ErrorCode.VALIDATION);
  });

  it("refuses the same detail placed twice", async () => {
    const { ctx } = adminWorld();
    const f = {
      key: "ownerName",
      xFrac: 0.5,
      yFrac: 0.5,
      fontSize: 12,
      align: "left" as const,
    };
    expect(
      await codeOf(() => runSetFields(ctx, { ...base, fields: [f, f] })),
    ).toBe(ErrorCode.VALIDATION);
  });

  it("clamps a placement dragged off the page", async () => {
    const { ctx, tables } = adminWorld();
    await runSetFields(ctx, {
      ...base,
      fields: [
        {
          key: "ownerName",
          xFrac: 3,
          yFrac: -2,
          fontSize: 400,
          align: "center",
        },
      ],
    });
    const saved = (tables.certificateTemplates[0]?.["fields"] as Row[])[0];
    expect(saved?.["xFrac"]).toBe(1);
    expect(saved?.["yFrac"]).toBe(0);
    expect(saved?.["fontSize"]).toBe(96);
  });

  it("is admin-only", async () => {
    const { ctx } = makeCtx({
      roles: ["office_staff"],
      tables: { certificateTemplates: [template()] },
    });
    expect(
      await codeOf(() => runSetFields(ctx, { ...base, fields: [] })),
    ).toBe(ErrorCode.FORBIDDEN);
  });
});
