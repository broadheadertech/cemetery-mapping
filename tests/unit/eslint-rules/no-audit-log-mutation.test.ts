import { RuleTester } from "eslint";
import { describe, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-audit-log-mutation.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/no-audit-log-mutation", () => {
  it("RuleTester suite", () => {
    tester.run("no-audit-log-mutation", rule, {
      valid: [
        {
          name: "patch on a non-audit row is allowed",
          code: `await ctx.db.patch(userId, { isActive: false });`,
        },
        {
          name: "delete on a non-audit row is allowed",
          code: `await ctx.db.delete(staleSessionId);`,
        },
        {
          name: "replace on a non-audit row is allowed",
          code: `await ctx.db.replace(lotId, fullDoc);`,
        },
        {
          name: "reading auditLog is allowed",
          code: `const rows = await ctx.db.query("auditLog").collect();`,
        },
      ],
      invalid: [
        {
          name: "patch with a variable named auditLogRowId",
          code: `await ctx.db.patch(auditLogRowId, { action: "tampered" });`,
          errors: [{ messageId: "mutation", data: { op: "patch" } }],
        },
        {
          name: "delete with auditLog id in the argument expression",
          code: `await ctx.db.delete(auditLogRow._id);`,
          errors: [{ messageId: "mutation", data: { op: "delete" } }],
        },
        {
          name: "replace with auditLog in the argument expression",
          code: `await ctx.db.replace(auditLogId, newRow);`,
          errors: [{ messageId: "mutation", data: { op: "replace" } }],
        },
      ],
    });
  });
});
