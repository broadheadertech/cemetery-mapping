/**
 * Story 1.7 — `no-raw-status-patch` custom ESLint rule tests.
 *
 * Updated 2026-05-24 per Epic 1 review (HIGH-D): the rule now covers
 * both `status` and `state` property patches. `status` is the
 * lot/interment/receipt discriminator; `state` is the contract
 * discriminator (Story 3.6).
 *
 * Uses ESLint's RuleTester to enumerate valid / invalid samples. The
 * rule branches on filename + import detection + AST shape; tests
 * cover each branch:
 *
 *   valid:
 *     - patch with no status/state field
 *     - patch with status, file imports stateMachines
 *     - patch with state, file imports stateMachines
 *     - file in convex/lib/stateMachines.ts (exempt)
 *     - file in convex/seed.ts (exempt)
 *     - file outside convex/ entirely (defensive: should not fire)
 *     - non-patch call (ctx.db.insert with status field) is allowed
 *     - ctx.db.patch where second arg is not an object literal
 *
 *   invalid:
 *     - convex/lots.ts patches status without importing stateMachines
 *     - convex/contracts.ts patches state without importing stateMachines
 *     - convex/receipts.ts patches status with reason but no import
 *     - file containing BOTH status and state patches reports both
 *     - import from an unrelated module does not satisfy the rule
 *
 * The RuleTester invokes the rule against synthetic source files and
 * compares the reported error count + messageId to the expected list.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-raw-status-patch.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/no-raw-status-patch", () => {
  it("passes the RuleTester matrix", () => {
    tester.run("no-raw-status-patch", rule, {
      valid: [
        {
          name: "patch without a status field is fine",
          filename: "convex/lots.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { name: "Lot A" });
            }
          `,
        },
        {
          name: "patch with status is fine when file imports stateMachines",
          filename: "convex/lots.ts",
          code: `
            import { assertTransition } from "./lib/stateMachines";
            export async function f(ctx) {
              assertTransition({ entityType: "lot", from: "available", to: "reserved" });
              await ctx.db.patch(id, { status: "reserved" });
            }
          `,
        },
        {
          name: "convex/lib/stateMachines.ts itself is exempt",
          filename: "convex/lib/stateMachines.ts",
          code: `
            export async function transitionLotStatus(ctx, params) {
              await ctx.db.patch(params.lotId, { status: params.to });
            }
          `,
        },
        {
          name: "convex/seed.ts is exempt",
          filename: "convex/seed.ts",
          code: `
            export async function seed(ctx) {
              await ctx.db.patch(id, { status: "available" });
            }
          `,
        },
        {
          name: "files outside convex/ never fire (defensive)",
          filename: "src/components/Foo.tsx",
          code: `
            async function f(ctx) {
              await ctx.db.patch(id, { status: "x" });
            }
          `,
        },
        {
          name: "ctx.db.insert with status is not a patch — allowed",
          filename: "convex/lots.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.insert("lots", { status: "available", name: "L" });
            }
          `,
        },
        {
          name: "ctx.db.patch with a variable second argument cannot be inspected",
          filename: "convex/lots.ts",
          code: `
            export async function f(ctx, patch) {
              await ctx.db.patch(id, patch);
            }
          `,
        },
        {
          name: "patch with status:true on a non-status-path import still allowed if stateMachines imported via absolute path",
          filename: "convex/contracts.ts",
          code: `
            import { assertTransition } from "convex/lib/stateMachines";
            export async function f(ctx) {
              assertTransition({ entityType: "contract", from: "active", to: "cancelled", reason: "x" });
              await ctx.db.patch(id, { status: "cancelled" });
            }
          `,
        },
        {
          name: "patch with state is fine when file imports stateMachines",
          filename: "convex/contracts.ts",
          code: `
            import { transitionContractState } from "./lib/stateMachines";
            export async function f(ctx) {
              await ctx.db.patch(id, { state: "paid_in_full" });
            }
          `,
        },
        {
          name: "convex/lib/stateMachines.ts itself can patch state (exempt)",
          filename: "convex/lib/stateMachines.ts",
          code: `
            export async function transitionContractState(ctx, params) {
              await ctx.db.patch(params.contractId, { state: params.to });
            }
          `,
        },
        {
          name: "ctx.db.insert with state is not a patch — allowed",
          filename: "convex/contracts.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.insert("contracts", { state: "active", total: 0 });
            }
          `,
        },
      ],
      invalid: [
        {
          name: "convex/lots.ts patches status without importing stateMachines",
          filename: "convex/lots.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { status: "reserved" });
            }
          `,
          errors: [{ messageId: "rawStatusPatch" }],
        },
        {
          name: "convex/contracts.ts patches status without import",
          filename: "convex/contracts.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { status: "fully_paid", paidAt: Date.now() });
            }
          `,
          errors: [{ messageId: "rawStatusPatch" }],
        },
        {
          name: "import from an unrelated module does not satisfy the rule",
          filename: "convex/lots.ts",
          code: `
            import { something } from "./lib/audit";
            export async function f(ctx) {
              await ctx.db.patch(id, { status: "occupied" });
            }
          `,
          errors: [{ messageId: "rawStatusPatch" }],
        },
        {
          name: "shadowed variable named ctx still triggers (heuristic is name-based)",
          filename: "convex/receipts.ts",
          code: `
            export async function f(myCtx) {
              await myCtx.db.patch(id, { status: "voided", reason: "dup" });
            }
          `,
          errors: [{ messageId: "rawStatusPatch" }],
        },
        {
          name: "convex/contracts.ts patches state without importing stateMachines",
          filename: "convex/contracts.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { state: "cancelled" });
            }
          `,
          errors: [{ messageId: "rawStatePatch" }],
        },
        {
          name: "convex/contracts.ts patches state with extra fields without import",
          filename: "convex/contracts.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { state: "paid_in_full", paidAt: Date.now() });
            }
          `,
          errors: [{ messageId: "rawStatePatch" }],
        },
        {
          name: "import from an unrelated module does not satisfy the state rule",
          filename: "convex/contracts.ts",
          code: `
            import { something } from "./lib/audit";
            export async function f(ctx) {
              await ctx.db.patch(id, { state: "voided" });
            }
          `,
          errors: [{ messageId: "rawStatePatch" }],
        },
        {
          name: "a patch with BOTH status and state reports both violations",
          filename: "convex/contracts.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { status: "x", state: "y" });
            }
          `,
          errors: [
            { messageId: "rawStatusPatch" },
            { messageId: "rawStatePatch" },
          ],
        },
        {
          name: "state property declared as a string-literal key still fires",
          filename: "convex/contracts.ts",
          code: `
            export async function f(ctx) {
              await ctx.db.patch(id, { "state": "cancelled" });
            }
          `,
          errors: [{ messageId: "rawStatePatch" }],
        },
      ],
    });
  });
});
