/**
 * Verifies the Tracker lint rules actually fire, using ESLint's own
 * RuleTester. Run from the cemetery-mapping dir so `eslint` resolves.
 */
"use strict";

const { RuleTester } = require("eslint");
const tsParser = require("@typescript-eslint/parser");

const R = "c:/Users/JENZEN/Documents/Broadheader/Tracker/eslint-rules";
const financial = require(`${R}/no-direct-financial-write.js`);
const auditRule = require(`${R}/no-audit-log-write.js`);
const floatMoney = require(`${R}/no-float-money.js`);
const requireAuth = require(`${R}/require-auth-first-line.js`);

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

const CONVEX = "c:/proj/convex";
let failures = 0;
function run(name, rule, cases) {
  try {
    tester.run(name, rule, cases);
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n")[0]}`);
  }
}

console.log("\n=== no-direct-financial-write ===");
run("ownership", financial, {
  valid: [
    // The owner may insert its own table.
    {
      code: `await ctx.db.insert("moneyMovements", row);`,
      filename: `${CONVEX}/lib/postMovement.ts`,
    },
    {
      code: `await ctx.db.insert("advances", row);`,
      filename: `${CONVEX}/lib/advances.ts`,
    },
    // schema.ts names tables in defineTable, not as DB access.
    {
      code: `const s = { moneyMovements: defineTable({}) };`,
      filename: `${CONVEX}/schema.ts`,
    },
    // Reads are unrestricted.
    {
      code: `await ctx.db.query("moneyMovements").withIndex("by_tenant_occurred").take(10);`,
      filename: `${CONVEX}/reports.ts`,
    },
    // Non-financial table, anyone may write.
    {
      code: `await ctx.db.insert("categories", row);`,
      filename: `${CONVEX}/categories.ts`,
    },
  ],
  invalid: [
    // A random module inserting money.
    {
      code: `await ctx.db.insert("moneyMovements", row);`,
      filename: `${CONVEX}/income.ts`,
      errors: [{ messageId: "notOwner" }],
    },
    // THE key case: advances.ts owns advances but must still route
    // money movements through postMovement.
    {
      code: `await ctx.db.insert("moneyMovements", row);`,
      filename: `${CONVEX}/lib/advances.ts`,
      errors: [{ messageId: "notOwner" }],
    },
    // Append-only: even the owner cannot patch.
    {
      code: `await ctx.db.patch(movement._id, { amountCents: 1 });`,
      filename: `${CONVEX}/lib/postMovement.ts`,
      errors: [{ messageId: "appendOnly" }],
    },
    {
      code: `await ctx.db.delete(moneyMovementsId);`,
      filename: `${CONVEX}/cleanup.ts`,
      errors: [{ messageId: "appendOnly" }],
    },
    // Uninterpolated template literal is still a table name.
    {
      code: "await ctx.db.insert(`obligations`, row);",
      filename: `${CONVEX}/bills.ts`,
      errors: [{ messageId: "notOwner" }],
    },
  ],
});

console.log("\n=== no-audit-log-write ===");
run("audit", auditRule, {
  valid: [
    {
      code: `await ctx.db.insert("auditLog", entry);`,
      filename: `${CONVEX}/lib/audit.ts`,
    },
    {
      code: `await ctx.db.query("auditLog").withIndex("by_tenant_at").take(5);`,
      filename: `${CONVEX}/reports.ts`,
    },
  ],
  invalid: [
    {
      code: `await ctx.db.insert("auditLog", entry);`,
      filename: `${CONVEX}/advances.ts`,
      errors: [{ messageId: "directWrite" }],
    },
    // Even audit.ts itself may not mutate.
    {
      code: `await ctx.db.patch(auditLogRow._id, { summary: "x" });`,
      filename: `${CONVEX}/lib/audit.ts`,
      errors: [{ messageId: "mutation" }],
    },
    {
      code: `await ctx.db.delete(auditLogId);`,
      filename: `${CONVEX}/admin.ts`,
      errors: [{ messageId: "mutation" }],
    },
  ],
});

console.log("\n=== no-float-money ===");
run("float", floatMoney, {
  valid: [
    // money.ts implements the safe ops.
    { code: `const x = amountCents / 100;`, filename: `${CONVEX}/lib/money.ts` },
    // Addition and subtraction stay integer — deliberately allowed.
    { code: `const t = liquidatedCents + returnedCents;`, filename: `${CONVEX}/lib/advances.ts` },
    { code: `const r = releasedCents - accountedFor;`, filename: `${CONVEX}/lib/advances.ts` },
    // Not a money value.
    { code: `const half = itemCount / 2;`, filename: `${CONVEX}/reports.ts` },
  ],
  invalid: [
    {
      code: `const pesos = amountCents / 100;`,
      filename: `${CONVEX}/reports.ts`,
      errors: [{ messageId: "floatRisk" }],
    },
    {
      code: `const vat = row.totalCents * 0.12;`,
      filename: `${CONVEX}/reports.ts`,
      errors: [{ messageId: "floatLiteral" }],
    },
    {
      code: `const share = obligation.amountCents * ratio;`,
      filename: `${CONVEX}/bills.ts`,
      errors: [{ messageId: "floatRisk" }],
    },
  ],
});

console.log("\n=== require-auth-first-line ===");
run("auth", requireAuth, {
  valid: [
    {
      code: `export const list = query({ args: {}, handler: async (ctx) => { const t = await requireTenant(ctx); return ctx.db.query("x").withIndex("i", q => q.eq("tenantId", t)).take(10); } });`,
      filename: `${CONVEX}/orders.ts`,
    },
    {
      code: `export const list = query({ args: {}, handler: async (ctx) => { const { roles } = await requireRole(ctx, ["admin"]); return roles; } });`,
      filename: `${CONVEX}/admin.ts`,
    },
    // internal* carries no user context.
    {
      code: `export const roll = internalMutation({ args: {}, handler: async (ctx) => { await ctx.db.insert("x", {}); } });`,
      filename: `${CONVEX}/crons.ts`,
    },
  ],
  invalid: [
    {
      code: `export const list = query({ args: {}, handler: async (ctx) => { return ctx.db.query("moneyMovements").take(10); } });`,
      filename: `${CONVEX}/leak.ts`,
      errors: [{ messageId: "missing" }],
    },
    // The dangerous one: check present, but after the read.
    {
      code: `export const list = query({ args: {}, handler: async (ctx) => { const rows = await ctx.db.query("moneyMovements").take(10); await requireRole(ctx, ["admin"]); return rows; } });`,
      filename: `${CONVEX}/late.ts`,
      errors: [{ messageId: "notFirst" }],
    },
    {
      code: `export const wipe = mutation({ args: {}, handler: async (ctx) => { await ctx.db.delete(id); } });`,
      filename: `${CONVEX}/danger.ts`,
      errors: [{ messageId: "missing" }],
    },
  ],
});

console.log(
  failures === 0
    ? "\nALL RULE TESTS PASSED\n"
    : `\n${failures} RULE GROUP(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
