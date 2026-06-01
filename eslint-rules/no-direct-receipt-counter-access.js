/**
 * Custom ESLint rule: convex/no-direct-receipt-counter-access
 *
 * The BIR receipt counter is the single most fragile invariant in the
 * codebase: any code that touches `receiptCounter` outside the cornerstone
 * helper can produce a duplicate or gap, and the failure mode is
 * unrecoverable (BIR audit findings, two years later). Lint enforces the
 * boundary that code review can miss.
 *
 * The rule flags any `ctx.db.<method>("receiptCounter", ...)` or
 * `ctx.db.query("receiptCounter")` call expression in a file outside the
 * allowed list. The allowed list:
 *
 *   - `convex/lib/receiptCounter.ts` — defines the seed + allocator.
 *   - `convex/lib/postFinancialEvent.ts` — Story 3.2's cornerstone
 *     consumer; the only sanctioned caller of `allocateNextSerial`.
 *   - `convex/schema.ts` — the table declaration itself; the literal
 *     "receiptCounter" appears as part of `defineTable` and is not a
 *     runtime DB access.
 *   - `convex/lib/receiptCounterTesting.ts` — test-only wrapper that
 *     exposes `allocateNextSerial` as an `internalMutation` so Vitest
 *     can drive the 100-concurrent-allocations stress test. Not
 *     reachable from the client (internalMutation), not exempt from
 *     code review.
 *
 * Detection:
 *   - CallExpression where callee is `<...>.db.<method>` (MemberExpression
 *     chain) AND the first argument is a string literal "receiptCounter"
 *     (or an untagged template literal containing only "receiptCounter").
 *
 * The rule fires regardless of the chain spelling (`ctx.db.query`,
 * `mutationCtx.db.patch`, `(await factory()).db.insert`); we match on
 * the `.db.<method>(...)` shape with a "receiptCounter" first argument.
 *
 * Limitation (documented in Story 3.1 Task 7): the rule cannot detect a
 * `ctx.db.patch(counterId, {...})` call where `counterId` was obtained
 * from a `receiptCounter` query in the same file. The literal-string
 * case catches the common drive-by mistake; the boundary doc + code
 * review catch the rest.
 */

"use strict";

const path = require("path");

const ALLOWED_BASENAMES = new Set([
  "receiptCounter.ts",
  "postFinancialEvent.ts",
  "receiptCounterTesting.ts",
  "schema.ts",
  // seed.ts inserts the initial receiptCounter row + reuses
  // `allocateNextSerial` for serial-consistent demo receipts. Operator-run
  // only (`npx convex run seed:*`); keep it seed-only.
  "seed.ts",
]);

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Direct access to the receiptCounter table is forbidden outside convex/lib/postFinancialEvent.ts. Use allocateNextSerial.",
    },
    schema: [],
    messages: {
      directAccess:
        "Direct access to 'receiptCounter' is forbidden — use allocateNextSerial via postFinancialEvent (Story 3.2). See docs/adr/0010-receipt-counter-pattern.md.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const basename = path.basename(filename);
    if (ALLOWED_BASENAMES.has(basename)) {
      // The file owns the boundary — let it through.
      return {};
    }

    function isDbMethodChain(callee) {
      if (!callee || callee.type !== "MemberExpression") return false;
      // Any method on .db: query, insert, patch, replace, delete, get, ...
      if (!callee.property || callee.property.type !== "Identifier") {
        return false;
      }
      const dbObj = callee.object;
      if (!dbObj || dbObj.type !== "MemberExpression") return false;
      const dbProp = dbObj.property;
      if (!dbProp || dbProp.type !== "Identifier" || dbProp.name !== "db") {
        return false;
      }
      return true;
    }

    function firstArgIsReceiptCounter(node) {
      const arg = node.arguments[0];
      if (!arg) return false;
      if (arg.type === "Literal" && arg.value === "receiptCounter") return true;
      if (
        arg.type === "TemplateLiteral" &&
        arg.expressions.length === 0 &&
        arg.quasis.length === 1 &&
        arg.quasis[0].value.cooked === "receiptCounter"
      ) {
        return true;
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isDbMethodChain(node.callee)) return;
        if (!firstArgIsReceiptCounter(node)) return;
        context.report({
          node,
          messageId: "directAccess",
        });
      },
    };
  },
};
