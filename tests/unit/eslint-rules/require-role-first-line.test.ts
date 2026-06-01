/**
 * Story 1.2 (CRIT follow-up) — `require-role-first-line` custom ESLint
 * rule tests.
 *
 * The rule matches public Convex query / mutation / action constructors
 * (short form AND the `*Generic` variants used by production files that
 * import directly from `convex/server`). It must NOT match the internal
 * variants (`internalQuery*`, `internalMutation*`, `internalAction*`)
 * because internal functions are server-to-server and have no user
 * context to authenticate.
 *
 * The Epic 1 adversarial review surfaced a bypass: prior to this test
 * file the rule only matched the short forms, so every production file
 * (which uses `queryGeneric` / `mutationGeneric` / `actionGeneric`)
 * silently slipped through. These tests pin the matched identifier set
 * so the bypass cannot regress.
 *
 *   valid:
 *     - queryGeneric handler whose first awaited statement is requireRole
 *     - mutationGeneric with const-assigned `await requireAuth(ctx)`
 *     - internalQueryGeneric without requireRole (exempt — internal)
 *     - internalMutationGeneric without requireRole (exempt)
 *     - internalActionGeneric without requireRole (exempt)
 *     - non-Convex call expression named `query` is ignored
 *     - handler with a standard `// eslint-disable-next-line
 *       local-rules/require-role-first-line` directive on the first
 *       statement (the canonical exemption pattern)
 *
 *   invalid:
 *     - queryGeneric without requireRole → missingAuth
 *     - mutationGeneric without requireRole → missingAuth
 *     - actionGeneric without requireRole → missingAuth
 *     - query (short form) without requireRole → missingAuth
 *     - mutation (short form) without requireRole → missingAuth
 *     - action (short form) without requireRole → missingAuth
 *     - queryGeneric with NON-awaited requireRole call → notAwaited
 *     - handler with another await as first statement → missingAuth
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/require-role-first-line.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/require-role-first-line", () => {
  it("RuleTester suite", () => {
    tester.run("require-role-first-line", rule, {
      valid: [
        {
          name: "queryGeneric: awaited requireRole as first statement passes",
          code: `
            export const listUsers = queryGeneric({
              args: {},
              handler: async (ctx) => {
                await requireRole(ctx, ["admin"]);
                return await ctx.db.query("users").collect();
              },
            });
          `,
        },
        {
          name: "mutationGeneric: const-assigned awaited requireAuth passes",
          code: `
            export const myMutation = mutationGeneric({
              args: {},
              handler: async (ctx) => {
                const auth = await requireAuth(ctx);
                return auth.userId;
              },
            });
          `,
        },
        {
          name: "actionGeneric: awaited requireRole as first statement passes",
          code: `
            export const myAction = actionGeneric({
              args: {},
              handler: async (ctx) => {
                await requireRole(ctx, ["admin"]);
                return null;
              },
            });
          `,
        },
        {
          name: "query (short form): awaited requireRole passes",
          code: `
            export const listUsers = query({
              args: {},
              handler: async (ctx) => {
                await requireRole(ctx, ["admin"]);
              },
            });
          `,
        },
        {
          name: "internalQueryGeneric: no requireRole is OK (exempt)",
          code: `
            export const _readSomething = internalQueryGeneric({
              args: {},
              handler: async (ctx) => {
                return await ctx.db.query("things").collect();
              },
            });
          `,
        },
        {
          name: "internalMutationGeneric: no requireRole is OK (exempt)",
          code: `
            export const _writeSomething = internalMutationGeneric({
              args: {},
              handler: async (ctx) => {
                await ctx.db.insert("things", {});
              },
            });
          `,
        },
        {
          name: "internalActionGeneric: no requireRole is OK (exempt)",
          code: `
            export const _runSomething = internalActionGeneric({
              args: {},
              handler: async (ctx) => {
                await ctx.runMutation("foo", {});
              },
            });
          `,
        },
        {
          name: "internalQuery (short form): no requireRole is OK (exempt)",
          code: `
            export const _readSomething = internalQuery({
              args: {},
              handler: async (ctx) => {
                return null;
              },
            });
          `,
        },
        {
          name: "non-Convex call named `query` is ignored",
          code: `
            const result = query("select 1");
          `,
        },
        {
          name: "handler with eslint-disable directive on first statement passes",
          code: `
            export const customerOnly = queryGeneric({
              args: {},
              handler: async (ctx) => {
                // eslint-disable-next-line local-rules/require-role-first-line
                const customer = await requireCurrentCustomer(ctx);
                return customer;
              },
            });
          `,
        },
      ],
      invalid: [
        {
          name: "queryGeneric without requireRole — missingAuth",
          code: `
            export const leak = queryGeneric({
              args: {},
              handler: async (ctx) => {
                return await ctx.db.query("users").collect();
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
        {
          name: "mutationGeneric without requireRole — missingAuth",
          code: `
            export const writeIt = mutationGeneric({
              args: {},
              handler: async (ctx, args) => {
                await ctx.db.insert("things", args);
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
        {
          name: "actionGeneric without requireRole — missingAuth",
          code: `
            export const doIt = actionGeneric({
              args: {},
              handler: async (ctx) => {
                await ctx.runMutation("foo", {});
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
        {
          name: "query (short form) without requireRole — missingAuth",
          code: `
            export const leak = query({
              args: {},
              handler: async (ctx) => {
                return null;
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
        {
          name: "mutation (short form) without requireRole — missingAuth",
          code: `
            export const writeIt = mutation({
              args: {},
              handler: async (ctx) => {
                await ctx.db.insert("things", {});
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
        {
          name: "action (short form) without requireRole — missingAuth",
          code: `
            export const doIt = action({
              args: {},
              handler: async (ctx) => {
                return null;
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
        {
          name: "queryGeneric with un-awaited requireRole — notAwaited",
          code: `
            export const leak = queryGeneric({
              args: {},
              handler: async (ctx) => {
                requireRole(ctx, ["admin"]);
                return null;
              },
            });
          `,
          errors: [{ messageId: "notAwaited" }],
        },
        {
          name: "mutationGeneric with un-awaited const-assigned requireRole — notAwaited",
          code: `
            export const leak = mutationGeneric({
              args: {},
              handler: async (ctx) => {
                const auth = requireRole(ctx, ["admin"]);
                return auth;
              },
            });
          `,
          errors: [{ messageId: "notAwaited" }],
        },
        {
          name: "queryGeneric with another await as first statement — missingAuth",
          code: `
            export const leak = queryGeneric({
              args: {},
              handler: async (ctx) => {
                await ctx.db.query("things").collect();
                await requireRole(ctx, ["admin"]);
              },
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
      ],
    });
  });
});
