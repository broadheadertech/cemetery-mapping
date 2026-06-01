/**
 * Custom ESLint rule: local-rules/no-raw-status-patch
 *
 * Heuristic — fails the build when a Convex mutation patches a
 * `status` OR `state` field via
 * `ctx.db.patch(<id>, { status|state: <value>, ... })` inside a file
 * that does NOT import from `convex/lib/stateMachines`.
 *
 * Why both `status` and `state`:
 *   The Phase 1 schema uses `status` for the lot / interment / receipt
 *   state machines, but Story 3.6 introduced the contracts table which
 *   carries its discriminator as `state` (active | paid_in_full |
 *   in_default | cancelled | voided). The Epic 1 adversarial review
 *   noted that this rule originally caught only `status` patches —
 *   a `ctx.db.patch(contractId, { state: "cancelled" })` outside of
 *   `transitionContractState` slipped through silently. Covering both
 *   property names with the same rule closes the gap.
 *
 * Why: state transitions must route through `assertTransition` (Story
 * 1.7) so the move is validated against the entity's transition table
 * and a reason is captured for FR23/FR37/FR38-mandated transitions.
 * Patching `status` / `state` raw bypasses both checks.
 *
 * Scope:
 *   - Applies to files matching `convex/**\/*.ts`.
 *   - Exempts (no error fired):
 *       convex/lib/stateMachines.ts — defines the helpers themselves
 *       convex/seed.ts             — seed scripts may set initial
 *                                    statuses without going through the
 *                                    state machine (documented in ADR-0006)
 *
 *   - For non-exempt files: if the file imports from
 *     `convex/lib/stateMachines` (any relative or absolute path
 *     resolving to that file), the rule allows the patch — we trust
 *     the author. Otherwise the rule errors.
 *
 * Heuristic limits (acknowledged in ADR-0006):
 *   - A file may import stateMachines for some unrelated reason and
 *     still raw-patch status/state elsewhere. The unit test suite on
 *     the transition table catches the runtime error; the rule catches
 *     the common case.
 *   - The rule only inspects `ctx.db.patch` — `ctx.db.replace` or
 *     destructured aliases (`const { patch } = ctx.db`) escape. Those
 *     are rare enough to leave to code review.
 *
 * Detection:
 *   - For every `ctx.db.patch(<id>, <obj>)` call (also matches
 *     `someCtx.db.patch(...)` where the first member is named `db`),
 *     if `<obj>` is an ObjectExpression with a `status` OR `state`
 *     property, check whether the file imports from `stateMachines`.
 *     If not, report on the property node.
 */

"use strict";

const STATE_MACHINES_IMPORT_REGEX = /(?:^|\/)(?:lib\/)?stateMachines(?:\.ts|\.js)?$/;

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw `ctx.db.patch(..., { status|state: ... })` outside files that import from convex/lib/stateMachines.",
    },
    schema: [],
    messages: {
      rawStatusPatch:
        "Use assertTransition() from convex/lib/stateMachines.ts before patching status; or convert to a state-machine-aware helper.",
      rawStatePatch:
        "Use assertTransition() (or transitionContractState) from convex/lib/stateMachines.ts before patching state; or convert to a state-machine-aware helper.",
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const normalized = filename.replace(/\\/g, "/");

    // Exempt files — return an empty visitor.
    if (
      normalized.endsWith("/convex/lib/stateMachines.ts") ||
      normalized.endsWith("/convex/seed.ts")
    ) {
      return {};
    }

    // Only fire inside the convex/ tree. Outside it (e.g. src/) the
    // rule should never apply; eslint.config.mjs scopes it, but be
    // defensive in case the config is mis-applied.
    if (!normalized.includes("/convex/")) {
      return {};
    }

    let importsStateMachines = false;

    function looksLikeStateMachinesPath(value) {
      if (typeof value !== "string") return false;
      return STATE_MACHINES_IMPORT_REGEX.test(value);
    }

    function isDbPatchCall(node) {
      // node.callee should be a MemberExpression: <thing>.db.patch
      if (!node.callee || node.callee.type !== "MemberExpression") return false;
      const outer = node.callee;
      if (outer.computed || outer.property.type !== "Identifier") return false;
      if (outer.property.name !== "patch") return false;
      const inner = outer.object;
      if (!inner || inner.type !== "MemberExpression") return false;
      if (inner.computed || inner.property.type !== "Identifier") return false;
      return inner.property.name === "db";
    }

    // Returns an array of matched ObjectExpression Property nodes whose
    // key is `status` or `state` (string literal or identifier form,
    // non-computed). Each entry includes the matched name so the report
    // call can pick the correct message.
    function findGuardedProperties(objExpr) {
      if (!objExpr || objExpr.type !== "ObjectExpression") return [];
      const matched = [];
      for (const prop of objExpr.properties) {
        if (prop.type !== "Property" || prop.computed) continue;
        let name = null;
        if (prop.key.type === "Identifier") {
          name = prop.key.name;
        } else if (
          prop.key.type === "Literal" &&
          typeof prop.key.value === "string"
        ) {
          name = prop.key.value;
        }
        if (name === "status" || name === "state") {
          matched.push({ prop, name });
        }
      }
      return matched;
    }

    return {
      ImportDeclaration(node) {
        if (looksLikeStateMachinesPath(node.source.value)) {
          importsStateMachines = true;
        }
      },
      CallExpression(node) {
        if (!isDbPatchCall(node)) return;
        // ctx.db.patch(id, obj, ...) — obj is arg[1]
        const obj = node.arguments[1];
        const matched = findGuardedProperties(obj);
        if (matched.length === 0) return;
        if (importsStateMachines) return;
        for (const { prop, name } of matched) {
          context.report({
            node: prop,
            messageId: name === "status" ? "rawStatusPatch" : "rawStatePatch",
          });
        }
      },
    };
  },
};
