import { RuleTester } from "eslint";
import { describe, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../../eslint-rules/require-role-first-line.js");

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
          name: "query with await requireRole as first statement",
          code: `
            export const list = query({
              args: {},
              handler: async (ctx) => {
                await requireRole(ctx, ["admin"]);
                return await ctx.db.query("things").collect();
              },
            });
          `,
        },
        {
          name: "mutation with const = await requireRole as first statement",
          code: `
            export const create = mutation({
              args: { name: v.string() },
              handler: async (ctx, args) => {
                const { userId } = await requireRole(ctx, ["admin", "office_staff"]);
                return await ctx.db.insert("things", { name: args.name, owner: userId });
              },
            });
          `,
        },
        {
          name: "query with await requireAuth as first statement",
          code: `
            export const me = query({
              args: {},
              handler: async (ctx) => {
                await requireAuth(ctx);
                return null;
              },
            });
          `,
        },
        {
          name: "action with await requireRole as first statement",
          code: `
            export const sendEmail = action({
              args: { to: v.string() },
              handler: async (ctx, args) => {
                await requireRole(ctx, ["admin"]);
                console.log(args);
              },
            });
          `,
        },
        {
          name: "internalQuery is exempt (not in PUBLIC_KINDS)",
          code: `
            export const cron = internalQuery({
              args: {},
              handler: async (ctx) => {
                return await ctx.db.query("things").collect();
              },
            });
          `,
        },
        {
          name: "internalMutation is exempt",
          code: `
            export const tick = internalMutation({
              handler: async (ctx) => {
                return null;
              },
            });
          `,
        },
        {
          name: "non-query call is ignored",
          code: `
            const config = someOtherFactory({ foo: "bar" });
          `,
        },
      ],
      invalid: [
        {
          name: "query missing requireRole entirely",
          code: `
            export const list = query({
              args: {},
              handler: async (ctx) => {
                return await ctx.db.query("things").collect();
              },
            });
          `,
          errors: [
            {
              messageId: "missingAuth",
              data: { kind: "query", name: "list" },
            },
          ],
        },
        {
          name: "mutation with requireRole NOT as first statement",
          code: `
            export const create = mutation({
              args: { name: v.string() },
              handler: async (ctx, args) => {
                const existing = await ctx.db.query("things").first();
                await requireRole(ctx, ["admin"]);
                return existing;
              },
            });
          `,
          errors: [
            {
              messageId: "missingAuth",
              data: { kind: "mutation", name: "create" },
            },
          ],
        },
        {
          name: "query with bare requireRole call (missing await)",
          code: `
            export const list = query({
              args: {},
              handler: async (ctx) => {
                requireRole(ctx, ["admin"]);
                return await ctx.db.query("things").collect();
              },
            });
          `,
          errors: [{ messageId: "notAwaited" }],
        },
        {
          name: "action whose handler is an arrow expression",
          code: `
            export const doIt = action({
              handler: async (ctx) => requireRole(ctx, ["admin"]),
            });
          `,
          errors: [{ messageId: "missingAuth" }],
        },
      ],
    });
  });
});
