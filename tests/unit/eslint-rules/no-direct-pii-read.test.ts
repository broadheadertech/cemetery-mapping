/**
 * Story 2.3 AC4 — `local-rules/no-direct-pii-read` ESLint rule tests.
 *
 * The rule blocks direct `ctx.db.get(<customerId>)` access in any file
 * under `convex/` unless one of the documented escape hatches applies:
 *   - the file is in the allowed-basename list (piiAccess.ts, auth.ts,
 *     schema.ts);
 *   - the call is paired with an adjacent `logPiiAccess(...)` or
 *     `readPii(...)` call (the "audit beside read" pattern);
 *   - a `// pii-read-ok: <reason>` comment precedes the call (Story
 *     2.5's existing exemption convention).
 *
 * The heuristic flags identifier / member-expression names that contain
 * the substring "customer" — the canonical naming convention used
 * throughout the codebase. Reads of non-customer rows (lots, contracts,
 * payments) are not flagged.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/no-direct-pii-read.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("local-rules/no-direct-pii-read", () => {
  it("RuleTester suite", () => {
    tester.run("no-direct-pii-read", rule, {
      valid: [
        // ---------- non-convex files are ignored ---------------------
        {
          name: "non-convex files are ignored entirely",
          code: `await ctx.db.get(customerId);`,
          filename: "src/components/Foo.tsx",
        },
        // ---------- allowed-basename exemptions ----------------------
        {
          name: "ctx.db.get inside piiAccess.ts is allowed (defines readPii)",
          code: `
            async function h() {
              const customer = await ctx.db.get(customerId);
              return customer.govIdNumber;
            }
          `,
          filename: "convex/lib/piiAccess.ts",
        },
        {
          name: "ctx.db.get inside auth.ts is allowed (auth resolver)",
          code: `const user = await ctx.db.get(customerId);`,
          filename: "convex/lib/auth.ts",
        },
        {
          name: "ctx.db.get inside schema.ts is allowed",
          code: `const x = ctx.db.get(customerId);`,
          filename: "convex/schema.ts",
        },
        // ---------- field-access scoping (the new gate) --------------
        {
          name: "ownership-check-only read (no PII property access) is NOT flagged",
          code: `
            async function h() {
              const customer = await ctx.db.get(args.customerId);
              if (customer === null) return null;
              if (customer._id !== caller.customerId) return null;
              return { customerId: customer._id };
            }
          `,
          filename: "convex/contracts.ts",
        },
        {
          name: "FK navigation read (only .customerId / ._id accessed) is NOT flagged",
          code: `
            async function h() {
              const customer = await ctx.db.get(row.customerId);
              return customer.fullName;
            }
          `,
          filename: "convex/contracts.ts",
        },
        {
          name: "bare existence check without assignment is NOT flagged",
          code: `
            async function h() {
              if (await ctx.db.get(args.customerId)) {
                return true;
              }
              return false;
            }
          `,
          filename: "convex/contracts.ts",
        },
        // ---------- non-customer reads are NOT flagged ---------------
        {
          name: "ctx.db.get(lotId) is not flagged (no 'customer' in the name)",
          code: `const lot = await ctx.db.get(lotId);`,
          filename: "convex/lots.ts",
        },
        {
          name: "ctx.db.get(contract.lotId) is not flagged",
          code: `const lot = await ctx.db.get(contract.lotId);`,
          filename: "convex/contracts.ts",
        },
        {
          name: "ctx.db.get(args.id) without 'customer' is not flagged",
          code: `const row = await ctx.db.get(args.id);`,
          filename: "convex/lots.ts",
        },
        // ---------- pii-read-ok escape comment -----------------------
        {
          name: "pii-read-ok comment on previous line exempts the read",
          code: `
            // pii-read-ok: last-4 projection for non-identifying display
            const customer = await ctx.db.get(args.customerId);
          `,
          filename: "convex/customers.ts",
        },
        {
          name: "pii-read-ok comment with multi-word reason exempts the read",
          code: `
            // pii-read-ok: legacy compatibility path documented in ADR-0011
            const customer = await ctx.db.get(customerId);
          `,
          filename: "convex/customers.ts",
        },
        // ---------- adjacent logPiiAccess pattern --------------------
        {
          name: "adjacent logPiiAccess call exempts the read",
          code: `
            async function handler(ctx, args) {
              const customer = await ctx.db.get(args.customerId);
              await logPiiAccess(ctx, {
                entityType: "customer",
                entityId: args.customerId,
                fields: ["govIdNumber"],
              });
              return customer;
            }
          `,
          filename: "convex/customers.ts",
        },
        {
          name: "adjacent readPii call exempts the read (audit-then-read)",
          code: `
            async function handler(ctx, args) {
              const pii = await readPii(ctx, args.customerId, ["govIdNumber"]);
              const customer = await ctx.db.get(args.customerId);
              return { ...customer, pii };
            }
          `,
          filename: "convex/customers.ts",
        },
        // ---------- methods other than .get are ignored --------------
        {
          name: "ctx.db.query against customers is not flagged",
          code: `const rows = await ctx.db.query("customers").collect();`,
          filename: "convex/customers.ts",
        },
        {
          name: "ctx.db.patch on customerId is not flagged",
          code: `await ctx.db.patch(customerId, { phone: '...' });`,
          filename: "convex/customers.ts",
        },
      ],
      invalid: [
        {
          name: "ctx.db.get(customerId) + customer.govIdNumber read is flagged",
          code: `
            async function h() {
              const customer = await ctx.db.get(customerId);
              return { id: customer.govIdNumber };
            }
          `,
          filename: "convex/contracts.ts",
          errors: [{ messageId: "directPiiRead" }],
        },
        {
          name: "ctx.db.get(args.customerId) + .address read is flagged",
          code: `
            async function h() {
              const customer = await ctx.db.get(args.customerId);
              return { addr: customer.address };
            }
          `,
          filename: "convex/contracts.ts",
          errors: [{ messageId: "directPiiRead" }],
        },
        {
          name: "ctx.db.get(contract.customerId) + .phone read is flagged",
          code: `
            async function h() {
              const customer = await ctx.db.get(contract.customerId);
              return customer.phone;
            }
          `,
          filename: "convex/contracts.ts",
          errors: [{ messageId: "directPiiRead" }],
        },
        {
          name: "ctx.db.get with .email access is flagged",
          code: `
            async function h() {
              const c = await mutationCtx.db.get(customerId);
              const e = c.email;
              return e;
            }
          `,
          filename: "convex/customers.ts",
          errors: [{ messageId: "directPiiRead" }],
        },
        {
          name: "unrelated comment does NOT exempt a real PII read",
          code: `
            // some unrelated note
            async function h() {
              const customer = await ctx.db.get(customerId);
              return customer.govIdNumber;
            }
          `,
          filename: "convex/customers.ts",
          errors: [{ messageId: "directPiiRead" }],
        },
        {
          name: "logPiiAccess call far away (no adjacency) does not exempt",
          code: `
            async function handler(ctx, args) {
              const customer = await ctx.db.get(args.customerId);
              const a = 1;
              const b = 2;
              const c = 3;
              const d = 4;
              const e = 5;
              const f = 6;
              const g = 7;
              const h = customer.govIdNumber;
              await logPiiAccess(ctx, { entityType: "customer", entityId: args.customerId, fields: ["govIdNumber"] });
              return customer;
            }
          `,
          filename: "convex/customers.ts",
          errors: [{ messageId: "directPiiRead" }],
        },
      ],
    });
  });
});
