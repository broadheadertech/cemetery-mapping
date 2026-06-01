import { RuleTester } from "eslint";
import { describe, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-direct-financial-write.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/no-direct-financial-write", () => {
  it("RuleTester suite", () => {
    tester.run("no-direct-financial-write", rule, {
      valid: [
        {
          name: "insert into a non-financial table is allowed",
          code: `ctx.db.insert("users", { email: "a@b.c" });`,
        },
        {
          name: "insert into lots is allowed",
          code: `await ctx.db.insert("lots", { code: "A-1" });`,
        },
        {
          name: "query against payments is allowed (read-only)",
          code: `const rows = await ctx.db.query("payments").collect();`,
        },
        {
          name: "query against receipts is allowed (read-only)",
          code: `const rows = await ctx.db.query("receipts").collect();`,
        },
        {
          name: "query against paymentAllocations is allowed (read-only)",
          code: `const rows = await ctx.db.query("paymentAllocations").collect();`,
        },
        {
          name: "get from a financial table by id is allowed (read)",
          code: `const row = await ctx.db.get(receiptId);`,
        },
        {
          name: "non-Convex insert chain is ignored",
          code: `someService.insert("payments", payload);`,
        },
        {
          name: "method other than insert/replace/delete is ignored",
          code: `ctx.db.foo("payments", payload);`,
        },
        // File-level exemptions: postFinancialEvent.ts (cornerstone)
        // and schema.ts (table declarations).
        {
          name: "ctx.db.insert into payments is allowed inside postFinancialEvent.ts",
          code: `ctx.db.insert("payments", payload);`,
          filename: "convex/lib/postFinancialEvent.ts",
        },
        {
          name: "ctx.db.insert into receipts is allowed inside postFinancialEvent.ts",
          code: `ctx.db.insert("receipts", payload);`,
          filename: "convex/lib/postFinancialEvent.ts",
        },
        {
          name: "ctx.db.insert into paymentAllocations is allowed inside postFinancialEvent.ts",
          code: `ctx.db.insert("paymentAllocations", payload);`,
          filename: "convex/lib/postFinancialEvent.ts",
        },
        {
          name: "ctx.db.replace inside postFinancialEvent.ts is allowed (still discouraged by ADR)",
          code: `ctx.db.replace("payments", id, payload);`,
          filename: "convex/lib/postFinancialEvent.ts",
        },
        {
          name: "literal 'payments' inside schema.ts is allowed (defineTable, not runtime DB)",
          code: `payments: defineTable({ amountCents: v.number() });`,
          filename: "convex/schema.ts",
        },
      ],
      invalid: [
        {
          name: "direct insert into payments via ctx.db.insert with string literal",
          code: `ctx.db.insert("payments", { amountCents: 100_00 });`,
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct insert into receipts via ctx.db.insert with string literal",
          code: `ctx.db.insert("receipts", payload);`,
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct insert into paymentAllocations via ctx.db.insert with string literal",
          code: `ctx.db.insert("paymentAllocations", payload);`,
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct insert via mutationCtx.db.insert",
          code: `await mutationCtx.db.insert("payments", payload);`,
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct insert via template-literal table name",
          code: "ctx.db.insert(`payments`, payload);",
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct replace on payments",
          code: `ctx.db.replace("payments", id, payload);`,
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct delete with table-name string (forbidden if pattern emerges)",
          code: `ctx.db.delete("paymentAllocations", id);`,
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct insert into receipts is forbidden in convex/customers.ts",
          code: `ctx.db.insert("receipts", payload);`,
          filename: "convex/customers.ts",
          errors: [{ messageId: "directWrite" }],
        },
        {
          name: "direct insert into payments is forbidden in convex/lib/audit.ts",
          code: `ctx.db.insert("payments", payload);`,
          filename: "convex/lib/audit.ts",
          errors: [{ messageId: "directWrite" }],
        },
      ],
    });
  });
});
