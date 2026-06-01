/**
 * Story 1.7 — State-machine transition guards.
 *
 * Coverage targets ≥ 95% line + branch on
 * `convex/lib/stateMachines.ts`. Strategy:
 *   1. Iterate the TRANSITIONS table — every cell becomes a `success`
 *      test, every absent edge becomes an `illegal` test.
 *   2. Iterate REASON_REQUIRED_TRANSITIONS — assert with-reason succeeds
 *      and without-reason throws INVARIANT_VIOLATION; cover the
 *      whitespace-only edge case once.
 *   3. Sync test: assert LOT_STATUSES on server matches client mirror.
 *   4. transitionLotStatus stub: assert NOT_IMPLEMENTED throw.
 */

import { ConvexError, type Value } from "convex/values";
import { describe, expect, it } from "vitest";

import {
  TRANSITIONS,
  REASON_REQUIRED_TRANSITIONS,
  assertTransition,
  assertLotTransition,
  assertContractTransition,
  assertReceiptTransition,
  transitionLotStatus,
  type EntityWithState,
} from "../../../../convex/lib/stateMachines";
import { ErrorCode, type ErrorPayload } from "../../../../convex/lib/errors";
import {
  LOT_STATUSES,
  CONTRACT_STATES,
  RECEIPT_STATES,
  INTERMENT_STATES,
} from "../../../../convex/lib/states";
import { LOT_STATUSES as CLIENT_LOT_STATUSES } from "../../../../src/types/lot-status";

const ENTITY_TYPES: readonly EntityWithState[] = [
  "lot",
  "contract",
  "receipt",
  // Story 7.4 — interment state machine joins the entity-wide table.
  "interment",
];

function getCode(thrown: unknown): string | undefined {
  if (!(thrown instanceof ConvexError)) return undefined;
  const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
  return data?.code;
}

function callAndCatch(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

/**
 * Parses a `"entityType:from→to"` REASON_REQUIRED key into its parts.
 * Throws if the key isn't well-formed — these are hand-written
 * constants, so a malformed entry is a bug in `REASON_REQUIRED_TRANSITIONS`
 * that this helper surfaces immediately.
 */
function parseTransitionKey(key: string): {
  entityType: EntityWithState;
  from: string;
  to: string;
} {
  const match = key.match(/^(\w+):(\w+)→(\w+)$/);
  if (!match) throw new Error(`Malformed transition key: ${key}`);
  const entityType = match[1] as EntityWithState;
  const from = match[2] as string;
  const to = match[3] as string;
  return { entityType, from, to };
}

describe("TRANSITIONS table — shape + exhaustiveness", () => {
  it("declares every entity type in EntityWithState", () => {
    for (const entityType of ENTITY_TYPES) {
      expect(TRANSITIONS[entityType]).toBeDefined();
    }
  });

  it("contains the seven lot statuses as keys", () => {
    const keys = Object.keys(TRANSITIONS.lot).sort();
    expect(keys).toEqual([...LOT_STATUSES].sort());
  });

  it("contains the five contract states as keys", () => {
    const keys = Object.keys(TRANSITIONS.contract).sort();
    expect(keys).toEqual([...CONTRACT_STATES].sort());
  });

  it("contains the two receipt states as keys", () => {
    const keys = Object.keys(TRANSITIONS.receipt).sort();
    expect(keys).toEqual([...RECEIPT_STATES].sort());
  });

  it("contains the three interment states as keys (Story 7.4)", () => {
    const keys = Object.keys(TRANSITIONS.interment).sort();
    expect(keys).toEqual([...INTERMENT_STATES].sort());
  });

  it("interment scheduled state allows completed + cancelled (Story 7.4)", () => {
    expect(TRANSITIONS.interment.scheduled).toEqual(
      expect.arrayContaining(["completed", "cancelled"]),
    );
  });

  it("interment terminal states are completed + cancelled (Story 7.4)", () => {
    expect(TRANSITIONS.interment.completed).toEqual([]);
    expect(TRANSITIONS.interment.cancelled).toEqual([]);
  });

  it("lot.sold allows the void-contract / reclaim path to available (Epic 3/4 void-chain fix)", () => {
    // Pre-fix, `LOT_TRANSITIONS.sold` was `["occupied", "defaulted"]` —
    // missing `"available"` — which crashed every voidContract /
    // reclaimLot mutation with ILLEGAL_STATE_TRANSITION when the lot's
    // status was `sold`. The fix adds the explicit edge.
    expect(TRANSITIONS.lot.sold).toEqual(
      expect.arrayContaining(["occupied", "defaulted", "available"]),
    );
  });

  it("lot:sold→available requires a reason (forensic audit trail)", () => {
    // The new edge is reason-required so the audit trail records why
    // the lot was reverted out of `sold` (matches the
    // `defaulted → available` and `sold → defaulted` policy).
    expect(REASON_REQUIRED_TRANSITIONS.has("lot:sold→available")).toBe(true);
    const thrown = callAndCatch(() =>
      assertTransition({ entityType: "lot", from: "sold", to: "available" }),
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    // With reason — passes.
    const ok = assertTransition({
      entityType: "lot",
      from: "sold",
      to: "available",
      reason: "Contract voided",
    });
    expect(ok.to).toBe("available");
  });

  it("references only declared states as transition targets", () => {
    const STATES: Record<EntityWithState, readonly string[]> = {
      lot: LOT_STATUSES,
      contract: CONTRACT_STATES,
      receipt: RECEIPT_STATES,
      interment: INTERMENT_STATES,
    };
    for (const entityType of ENTITY_TYPES) {
      const table = TRANSITIONS[entityType] as Record<
        string,
        readonly string[]
      >;
      for (const [from, targets] of Object.entries(table)) {
        for (const to of targets) {
          expect(STATES[entityType]).toContain(to);
        }
        // `from` must be in the state set too.
        expect(STATES[entityType]).toContain(from);
      }
    }
  });
});

describe("assertTransition — exhaustive legal transitions", () => {
  // For each entity / from / to in the table → success.
  for (const entityType of ENTITY_TYPES) {
    const table = TRANSITIONS[entityType] as Record<string, readonly string[]>;
    for (const [from, targets] of Object.entries(table)) {
      for (const to of targets) {
        const key = `${entityType}:${from}→${to}`;
        const needsReason = REASON_REQUIRED_TRANSITIONS.has(key);
        it(`allows ${key}${needsReason ? " (with reason)" : ""}`, () => {
          const params = needsReason
            ? { entityType, from, to, reason: "test reason" }
            : { entityType, from, to };
          const result = assertTransition(params);
          expect(result).toEqual(params);
        });
      }
    }
  }
});

describe("assertTransition — exhaustive illegal transitions", () => {
  // For each entity, for every (from, to) where `to` is NOT in
  // allowed[from] AND `to` IS a valid state for the entity, expect
  // ILLEGAL_STATE_TRANSITION.
  const STATES: Record<EntityWithState, readonly string[]> = {
    lot: LOT_STATUSES,
    contract: CONTRACT_STATES,
    receipt: RECEIPT_STATES,
    interment: INTERMENT_STATES,
  };
  for (const entityType of ENTITY_TYPES) {
    const table = TRANSITIONS[entityType] as Record<string, readonly string[]>;
    const states = STATES[entityType];
    for (const from of Object.keys(table)) {
      const allowed = table[from] ?? [];
      for (const to of states) {
        if (allowed.includes(to)) continue;
        it(`rejects ${entityType}:${from}→${to}`, () => {
          const thrown = callAndCatch(() =>
            assertTransition({ entityType, from, to, reason: "x" }),
          );
          expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
          const data = (thrown as ConvexError<Value>)
            .data as unknown as ErrorPayload;
          expect(data.details).toMatchObject({
            entityType,
            from,
            to,
            allowed: [...allowed],
          });
        });
      }
    }
  }

  it("rejects a from-state that does not exist in the table", () => {
    const thrown = callAndCatch(() =>
      assertTransition({
        entityType: "lot",
        from: "imaginary",
        to: "available",
      }),
    );
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
    const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
    // unknown `from` → allowed[] is empty
    expect(data.details).toMatchObject({ allowed: [] });
  });

  it("error message includes from, to, and allowed list", () => {
    const thrown = callAndCatch(() =>
      assertTransition({
        entityType: "lot",
        from: "available",
        to: "occupied",
      }),
    );
    expect(thrown).toBeInstanceOf(ConvexError);
    const data = (thrown as ConvexError<Value>).data as unknown as ErrorPayload;
    expect(data.message).toContain("lot");
    expect(data.message).toContain("available");
    expect(data.message).toContain("occupied");
    expect(data.message).toContain("reserved");
    expect(data.message).toContain("sold");
  });
});

describe("REASON_REQUIRED_TRANSITIONS", () => {
  // Each entry must be reachable from the TRANSITIONS table.
  for (const key of REASON_REQUIRED_TRANSITIONS) {
    it(`${key} is a legal transition in TRANSITIONS`, () => {
      const { entityType, from, to } = parseTransitionKey(key);
      const table = TRANSITIONS[entityType] as Record<
        string,
        readonly string[]
      >;
      expect(table[from]).toContain(to);
    });
  }

  for (const key of REASON_REQUIRED_TRANSITIONS) {
    it(`${key} throws INVARIANT_VIOLATION when reason is omitted`, () => {
      const { entityType, from, to } = parseTransitionKey(key);
      const thrown = callAndCatch(() =>
        assertTransition({ entityType, from, to }),
      );
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    });

    it(`${key} throws INVARIANT_VIOLATION when reason is whitespace-only`, () => {
      const { entityType, from, to } = parseTransitionKey(key);
      const thrown = callAndCatch(() =>
        assertTransition({
          entityType,
          from,
          to,
          reason: "   \t  ",
        }),
      );
      expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
    });

    it(`${key} accepts a non-empty trimmed reason`, () => {
      const { entityType, from, to } = parseTransitionKey(key);
      const result = assertTransition({
        entityType,
        from,
        to,
        reason: "valid reason",
      });
      expect(result.reason).toBe("valid reason");
    });
  }

  it("does NOT require a reason for transitions outside the set", () => {
    // lot:available→reserved is legal and not in the set
    const params = {
      entityType: "lot" as const,
      from: "available",
      to: "reserved",
    };
    expect(assertTransition(params)).toEqual(params);
  });
});

describe("typed convenience wrappers", () => {
  it("assertLotTransition delegates to assertTransition", () => {
    const result = assertLotTransition({ from: "available", to: "reserved" });
    expect(result).toEqual({
      entityType: "lot",
      from: "available",
      to: "reserved",
    });
  });

  it("assertLotTransition throws on illegal moves", () => {
    const thrown = callAndCatch(() =>
      assertLotTransition({ from: "available", to: "occupied" }),
    );
    expect(getCode(thrown)).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION);
  });

  it("assertContractTransition delegates correctly", () => {
    // Story 3.6 alignment: the contract state machine uses the
    // schema-aligned vocabulary `paid_in_full` (formerly `fully_paid`
    // in Story 1.7's cornerstone stub). `active → paid_in_full` is the
    // happy-path auto-fire edge driven by `postFinancialEvent`.
    const result = assertContractTransition({
      from: "active",
      to: "paid_in_full",
    });
    expect(result.entityType).toBe("contract");
  });

  it("assertContractTransition enforces reason on active→cancelled", () => {
    const thrown = callAndCatch(() =>
      assertContractTransition({ from: "active", to: "cancelled" }),
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });

  it("assertReceiptTransition delegates correctly", () => {
    const result = assertReceiptTransition({
      from: "issued",
      to: "voided",
      reason: "duplicate entry",
    });
    expect(result.entityType).toBe("receipt");
    expect(result.reason).toBe("duplicate entry");
  });

  it("assertReceiptTransition enforces reason on issued→voided", () => {
    const thrown = callAndCatch(() =>
      assertReceiptTransition({ from: "issued", to: "voided" }),
    );
    expect(getCode(thrown)).toBe(ErrorCode.INVARIANT_VIOLATION);
  });
});

describe("transitionLotStatus — implemented in Story 1.8", () => {
  it("is exported as an async function (body landed in Story 1.8)", () => {
    // Story 1.8 replaced the NOT_IMPLEMENTED stub with a real
    // implementation. Deep behavioural coverage lives in
    // `stateMachines-transitionLotStatus.test.ts`; this assertion
    // exists so this file's "is the API still wired" sanity check
    // continues to fire on every commit.
    expect(typeof transitionLotStatus).toBe("function");
  });
});

describe("LotStatus client/server mirror", () => {
  it("LOT_STATUSES on server matches src/types/lot-status.ts", () => {
    // Order-sensitive equality — drift detection is the whole point.
    expect([...CLIENT_LOT_STATUSES]).toEqual([...LOT_STATUSES]);
  });
});
