import { RuleTester } from "eslint";
import { describe, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-audit-log-direct-write.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/no-audit-log-direct-write", () => {
  it("RuleTester suite", () => {
    tester.run("no-audit-log-direct-write", rule, {
      valid: [
        {
          name: "insert into a different table is allowed",
          code: `ctx.db.insert("users", { email: "a@b.c" });`,
        },
        {
          name: "insert into lots is allowed",
          code: `await ctx.db.insert("lots", { code: "A-1" });`,
        },
        {
          name: "emitAudit call is allowed (it's the helper)",
          code: `await emitAudit(ctx, { action: "create_lot", entityType: "lot", entityId: id });`,
        },
        {
          name: "query against auditLog is allowed (read-only)",
          code: `const rows = await ctx.db.query("auditLog").collect();`,
        },
        {
          name: "non-Convex insert chain is ignored",
          code: `someService.insert("auditLog", payload);`,
        },
      ],
      invalid: [
        {
          name: "direct insert via ctx.db.insert with string literal",
          code: `ctx.db.insert("auditLog", { action: "create" });`,
          errors: [{ messageId: "directInsert" }],
        },
        {
          name: "direct insert via mutationCtx.db.insert",
          code: `await mutationCtx.db.insert("auditLog", payload);`,
          errors: [{ messageId: "directInsert" }],
        },
        {
          name: "direct insert via template-literal table name",
          code: "ctx.db.insert(`auditLog`, payload);",
          errors: [{ messageId: "directInsert" }],
        },
      ],
    });
  });
});
