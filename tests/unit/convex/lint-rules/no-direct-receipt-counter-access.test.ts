import { RuleTester } from "eslint";
import { describe, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../../eslint-rules/no-direct-receipt-counter-access.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/no-direct-receipt-counter-access", () => {
  it("RuleTester suite", () => {
    tester.run("no-direct-receipt-counter-access", rule, {
      valid: [
        {
          name: "ctx.db.query('receiptCounter') inside receiptCounter.ts (allowed)",
          filename: "convex/lib/receiptCounter.ts",
          code: `
            export async function allocateNextSerial(ctx) {
              const c = await ctx.db.query("receiptCounter").first();
              await ctx.db.patch(c._id, { currentSerial: c.currentSerial + 1 });
              return c.currentSerial + 1;
            }
          `,
        },
        {
          name: "ctx.db.query('receiptCounter') inside postFinancialEvent.ts (allowed)",
          filename: "convex/lib/postFinancialEvent.ts",
          code: `
            export async function postFinancialEvent(ctx, args) {
              const c = await ctx.db.query("receiptCounter").first();
              return c;
            }
          `,
        },
        {
          name: "ctx.db.query('receiptCounter') inside receiptCounterTesting.ts (allowed)",
          filename: "convex/lib/receiptCounterTesting.ts",
          code: `
            export const _testAllocate = internalMutationGeneric({
              handler: async (ctx) => {
                const c = await ctx.db.query("receiptCounter").first();
                return c;
              },
            });
          `,
        },
        {
          name: "schema.ts table declaration is exempt (defineTable usage, not runtime access)",
          filename: "convex/schema.ts",
          code: `
            export default defineSchema({
              receiptCounter: defineTable({ currentSerial: v.number() }),
            });
          `,
        },
        {
          name: "ctx.db.insert on a different table in a non-exempt file is allowed",
          filename: "convex/payments.ts",
          code: `
            export const create = mutation({
              handler: async (ctx, args) => {
                await ctx.db.insert("payments", { amountCents: args.amountCents });
              },
            });
          `,
        },
        {
          name: "string 'receiptCounter' in a comment / unrelated context is not flagged",
          filename: "convex/payments.ts",
          code: `
            // The receiptCounter table holds a single row; see Story 3.1.
            const TABLE_NAME = "payments";
            export const x = mutation({
              handler: async (ctx) => {
                await ctx.db.insert(TABLE_NAME, {});
              },
            });
          `,
        },
      ],
      invalid: [
        {
          name: "ctx.db.query('receiptCounter') inside a non-exempt convex/*.ts file is forbidden",
          filename: "convex/payments.ts",
          code: `
            export const peek = query({
              handler: async (ctx) => {
                return await ctx.db.query("receiptCounter").first();
              },
            });
          `,
          errors: [{ messageId: "directAccess" }],
        },
        {
          name: "ctx.db.insert('receiptCounter', ...) outside allowed files is forbidden",
          filename: "convex/receipts.ts",
          code: `
            export const seed = mutation({
              handler: async (ctx) => {
                await ctx.db.insert("receiptCounter", {
                  currentSerial: 0,
                  startingSerial: 0,
                  prefix: "OR-",
                  seededAt: Date.now(),
                });
              },
            });
          `,
          errors: [{ messageId: "directAccess" }],
        },
        {
          name: "ctx.db.patch on a receiptCounter row from a non-exempt file is forbidden when keyed by literal string (caught via the query)",
          filename: "convex/receipts.ts",
          code: `
            export const burn = mutation({
              handler: async (ctx) => {
                const c = await ctx.db.query("receiptCounter").first();
                await ctx.db.patch(c._id, { currentSerial: 999 });
              },
            });
          `,
          // Only the query call is flagged — the patch carries no
          // literal "receiptCounter" argument, so the rule's
          // literal-string detector skips it. Documented limitation.
          errors: [{ messageId: "directAccess" }],
        },
        {
          name: "template literal 'receiptCounter' (no interpolation) is flagged",
          filename: "convex/receipts.ts",
          code: `
            export const peek = query({
              handler: async (ctx) => {
                return await ctx.db.query(\`receiptCounter\`).first();
              },
            });
          `,
          errors: [{ messageId: "directAccess" }],
        },
        {
          name: "ctx.db.delete('receiptCounter', id) outside allowed files is forbidden",
          filename: "convex/admin.ts",
          code: `
            export const wipe = mutation({
              handler: async (ctx, args) => {
                await ctx.db.delete("receiptCounter", args.id);
              },
            });
          `,
          errors: [{ messageId: "directAccess" }],
        },
      ],
    });
  });
});
