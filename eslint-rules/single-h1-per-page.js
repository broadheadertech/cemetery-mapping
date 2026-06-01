/**
 * Custom ESLint rule: single-h1-per-page
 *
 * Story 1.5 AC5: every Next.js App Router `page.tsx` must render
 * exactly one top-level `<h1>` heading. This is the document-outline
 * contract assistive technology depends on; "missing" and "duplicate"
 * are both screen-reader failures.
 *
 * Scope:
 *   - Applies to `src/app/(public)/**\/page.tsx`,
 *     `src/app/(staff)/**\/page.tsx`,
 *     `src/app/(customer)/**\/page.tsx`,
 *     `src/app/page.tsx` (the route group is irrelevant — what matters
 *     is `page.tsx` being a route entry).
 *   - Skips storybook stories, test files, and `layout.tsx`.
 *
 * Detection (heuristic, intentionally simple):
 *   - Walks every JSXElement in the file.
 *   - Counts elements whose opening name (string-form) is `h1`.
 *   - Heading content is irrelevant — `<h1>{dynamicTitle}</h1>` counts.
 *   - 0 `<h1>` in a file that renders JSX → reports a missing heading.
 *   - 2+ `<h1>` that are siblings (would render together) → reports
 *     each duplicate after the first.
 *
 * The "alternate render branches" case (e.g. `if (loading) return …<h1>;`
 * followed by a main render with another `<h1>`) is NOT flagged.
 * Statically those look like two h1s, but at runtime exactly one
 * renders. We detect this by walking up each h1's ancestor chain: if
 * any two h1s share their first JSXElement / Fragment ancestor, they
 * are siblings; otherwise they're in alternate branches.
 *
 * The rule deliberately does NOT verify that the h1 is inside the
 * default export's return statement; in practice if a `page.tsx` has
 * an h1 anywhere, it's the page's heading. False positives are rare
 * and disabling the rule per-file is cheap (`// eslint-disable-next-line
 * local-rules/single-h1-per-page`).
 *
 * False-negative case we accept: an `<h1>` nested inside an imported
 * component (e.g. `<Hero />` where Hero internally renders `<h1>`)
 * won't be counted by this scanner. The trade-off is that scanning
 * imports would require type-aware analysis — beyond the value
 * proposition of a build-time guardrail. Code review catches that
 * case.
 */

"use strict";

/** @type {import("eslint").Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Every Next.js page must render exactly one top-level <h1>.",
    },
    schema: [],
    messages: {
      missing:
        "Page must render exactly one <h1> heading. Found 0. Add an <h1> for the page title.",
      duplicate:
        "Page must render exactly one <h1>. Found {{count}} <h1> elements.",
    },
  },

  create(context) {
    const filename = context.filename || context.getFilename();
    // Only run on App Router page files.
    if (!filename) return {};
    const normalized = filename.replace(/\\/g, "/");
    if (!/\/app\/.*\/page\.tsx$/.test(normalized) && !/\/app\/page\.tsx$/.test(normalized)) {
      return {};
    }

    const h1Openings = [];
    let hasJSX = false;

    /**
     * Walk up to the enclosing JSXElement (parent of the opening
     * element). Used to determine sibling-vs-alternate-branch.
     */
    function enclosingJSXElement(opening) {
      // opening's parent is the JSXElement that contains it.
      return opening.parent ?? null;
    }

    /**
     * Build the chain of JSXElement / JSXFragment ancestors from the
     * given element up to the function body. We use this chain to
     * decide if two h1s are siblings (some shared JSXElement ancestor
     * has both as descendants without an intervening conditional).
     *
     * For our purposes a robust "siblings" test is: do the two h1
     * elements share a *common JSXElement parent* somewhere up the
     * tree? If yes, they appear under the same render. If no — they're
     * in separate return statements / function bodies (alternate
     * branches).
     */
    function jsxAncestorChain(element) {
      const chain = [];
      let node = element ? element.parent : null;
      while (node) {
        if (
          node.type === "JSXElement" ||
          node.type === "JSXFragment"
        ) {
          chain.push(node);
        } else if (
          node.type === "ReturnStatement" ||
          node.type === "ArrowFunctionExpression" ||
          node.type === "FunctionDeclaration" ||
          node.type === "FunctionExpression" ||
          node.type === "Program"
        ) {
          // Stop climbing at the enclosing function/return. JSX
          // chains never span outside a single return body.
          break;
        }
        node = node.parent;
      }
      return chain;
    }

    return {
      JSXOpeningElement(node) {
        hasJSX = true;
        if (
          node.name &&
          node.name.type === "JSXIdentifier" &&
          node.name.name === "h1"
        ) {
          h1Openings.push(node);
        }
      },
      "Program:exit"(programNode) {
        // Redirect-only / shell pages render no JSX at all (they call
        // `redirect()` and never return an element). The h1 contract
        // doesn't apply because nothing is shown to the user; the
        // browser is bounced before paint.
        if (!hasJSX) return;

        if (h1Openings.length === 0) {
          context.report({
            node: programNode,
            messageId: "missing",
          });
          return;
        }

        if (h1Openings.length === 1) return;

        // 2+ h1s: distinguish "siblings under one render" from
        // "alternate branches".
        const enclosingElements = h1Openings.map(enclosingJSXElement);
        const ancestorChains = enclosingElements.map(jsxAncestorChain);

        // For each pair, check if their chains share any JSXElement.
        // If ANY pair shares an ancestor, that pair is siblings.
        const offending = new Set();
        for (let i = 0; i < h1Openings.length; i++) {
          for (let j = i + 1; j < h1Openings.length; j++) {
            const a = new Set(ancestorChains[i]);
            const shared = ancestorChains[j].some((n) => a.has(n));
            if (shared) {
              // h1Openings[j] is a duplicate sibling of h1Openings[i].
              offending.add(h1Openings[j]);
            }
          }
        }

        for (const node of offending) {
          context.report({
            node,
            messageId: "duplicate",
            data: { count: String(h1Openings.length) },
          });
        }
      },
    };
  },
};
