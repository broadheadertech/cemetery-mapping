/**
 * Custom ESLint rule: convex/require-role-first-line
 *
 * Fails the build if any *public* Convex function (query/mutation/action)
 * in `convex/**` does not call `requireRole(ctx, ...)` or
 * `requireAuth(ctx)` as the first statement of its handler.
 *
 * Why: NFR-S4 says UI-only authorization is a non-compliance defect.
 * The rule makes server-side auth enforcement mechanical instead of
 * memorisable.
 *
 * Scope:
 *   - Applies to files matching `convex/**\/*.ts`
 *   - Excludes (configured in eslint.config.mjs, not here):
 *       convex/_generated/, convex/lib/, convex/http.ts,
 *       convex/auth.ts, convex/auth.config.ts, convex/schema.ts
 *   - Within an included file, the rule fires only on calls to
 *     `query()`, `mutation()`, `action()` and their generic-context
 *     variants `queryGeneric()`, `mutationGeneric()`, `actionGeneric()`
 *     (production Convex files import the `*Generic` constructors from
 *     `convex/server` so they can type the handler ctx against the
 *     schema directly without depending on `_generated/server`).
 *
 *     NOT matched: `internalQuery`, `internalMutation`, `internalAction`
 *     and their `internal*Generic` variants. Internal functions are
 *     server-to-server and have no user context.
 *
 * Detection:
 *   For each call expression whose callee Identifier is `query` /
 *   `mutation` / `action` (or the `*Generic` variants), the rule reads
 *   the first argument (the function definition object), finds the
 *   `handler:` property, and inspects its body. The handler must be an
 *   async function whose FIRST top-level statement is:
 *     - `await requireRole(ctx, [...])` (any args after ctx accepted)
 *     - `await requireAuth(ctx)`
 *     - `const ... = await requireRole(...)` / `const ... = await requireAuth(...)`
 *
 * Anything else — even `await someOtherCheck(); await requireRole(...)` —
 * fails the rule. The first DB-touching statement must be the auth
 * check.
 */

"use strict";

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Every public Convex query/mutation/action must call requireRole or requireAuth as its first action.",
    },
    schema: [],
    messages: {
      missingAuth:
        "Public Convex {{kind}} '{{name}}' must call requireRole or requireAuth as its first action. See convex/lib/auth.ts.",
      notAwaited:
        "Public Convex {{kind}} '{{name}}' must AWAIT requireRole/requireAuth as its first action. Missing `await`.",
    },
  },

  create(context) {
    // Both the short and `*Generic` forms must match. Production Convex
    // files in this repo import `queryGeneric`, `mutationGeneric`, and
    // `actionGeneric` from `convex/server` so the handler ctx can be
    // typed against the schema directly. The internal variants
    // (`internalQuery`, `internalQueryGeneric`, …) are intentionally
    // excluded — internal functions are server-to-server and have no
    // user context to authenticate.
    const PUBLIC_KINDS = new Set([
      "query",
      "mutation",
      "action",
      "queryGeneric",
      "mutationGeneric",
      "actionGeneric",
    ]);

    function isRequireCall(callExpr) {
      if (!callExpr || callExpr.type !== "CallExpression") return false;
      const callee = callExpr.callee;
      if (!callee || callee.type !== "Identifier") return false;
      return callee.name === "requireRole" || callee.name === "requireAuth";
    }

    function isAwaitedRequireCall(node) {
      // Direct: `await requireRole(...)`
      if (
        node.type === "ExpressionStatement" &&
        node.expression.type === "AwaitExpression" &&
        isRequireCall(node.expression.argument)
      ) {
        return { ok: true };
      }
      // Assigned: `const x = await requireRole(...)`
      if (
        node.type === "VariableDeclaration" &&
        node.declarations.length > 0
      ) {
        const decl = node.declarations[0];
        if (
          decl.init &&
          decl.init.type === "AwaitExpression" &&
          isRequireCall(decl.init.argument)
        ) {
          return { ok: true };
        }
        if (decl.init && isRequireCall(decl.init)) {
          return { ok: false, reason: "notAwaited" };
        }
      }
      // Unawaited bare call: `requireRole(...)`
      if (
        node.type === "ExpressionStatement" &&
        isRequireCall(node.expression)
      ) {
        return { ok: false, reason: "notAwaited" };
      }
      return { ok: false, reason: "missing" };
    }

    function extractHandlerBody(funcDefObject) {
      if (!funcDefObject || funcDefObject.type !== "ObjectExpression") {
        return null;
      }
      for (const prop of funcDefObject.properties) {
        if (
          prop.type === "Property" &&
          prop.key.type === "Identifier" &&
          prop.key.name === "handler" &&
          (prop.value.type === "FunctionExpression" ||
            prop.value.type === "ArrowFunctionExpression")
        ) {
          return prop.value;
        }
      }
      return null;
    }

    function inferName(node) {
      // For `export const foo = query({...})`, climb to the VariableDeclarator.
      let current = node.parent;
      while (current) {
        if (current.type === "VariableDeclarator" && current.id.type === "Identifier") {
          return current.id.name;
        }
        current = current.parent;
      }
      return "<anonymous>";
    }

    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        const kind = node.callee.name;
        if (!PUBLIC_KINDS.has(kind)) return;

        const arg = node.arguments[0];
        const handler = extractHandlerBody(arg);
        if (!handler) return;

        if (handler.body.type !== "BlockStatement") {
          // Arrow with expression body: `handler: async (ctx) => requireRole(...)`
          // Not a pattern we use; treat as missing.
          context.report({
            node: handler,
            messageId: "missingAuth",
            data: { kind, name: inferName(node) },
          });
          return;
        }

        const first = handler.body.body[0];
        if (!first) {
          context.report({
            node: handler,
            messageId: "missingAuth",
            data: { kind, name: inferName(node) },
          });
          return;
        }

        const check = isAwaitedRequireCall(first);
        if (!check.ok) {
          context.report({
            node: first,
            messageId: check.reason === "notAwaited" ? "notAwaited" : "missingAuth",
            data: { kind, name: inferName(node) },
          });
        }
      },
    };
  },
};
