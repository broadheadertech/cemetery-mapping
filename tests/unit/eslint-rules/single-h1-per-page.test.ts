/**
 * Story 1.5 Task 10 — `single-h1-per-page` custom ESLint rule tests.
 *
 * Uses ESLint's RuleTester to enumerate valid / invalid samples. The
 * rule fires only on Next.js App Router page files; the test filename
 * mimics that path via the `filename` option.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rule = require("../../../eslint-rules/single-h1-per-page.js");

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

const PAGE_FILE = "src/app/(staff)/foo/page.tsx";
const NON_PAGE_FILE = "src/components/Foo.tsx";

describe("local-rules/single-h1-per-page", () => {
  it("passes the RuleTester matrix", () => {
    tester.run("single-h1-per-page", rule, {
      valid: [
        // Single h1 — happy path.
        {
          filename: PAGE_FILE,
          code: `
            export default function Page() {
              return <div><h1>Hello</h1></div>;
            }
          `,
        },
        // Two h1s in alternate branches (early-return).
        {
          filename: PAGE_FILE,
          code: `
            export default function Page({ loading }) {
              if (loading) {
                return <div><h1>Loading</h1></div>;
              }
              return <div><h1>Loaded</h1></div>;
            }
          `,
        },
        // Redirect-only / no JSX → rule skips.
        {
          filename: PAGE_FILE,
          code: `
            export default function Page() {
              return null;
            }
          `,
        },
        // Non-page file is exempt regardless of h1 count.
        {
          filename: NON_PAGE_FILE,
          code: `
            export function Foo() {
              return <div><h1>One</h1><h1>Two</h1></div>;
            }
          `,
        },
      ],
      invalid: [
        // 0 h1s on a JSX-rendering page.
        {
          filename: PAGE_FILE,
          code: `
            export default function Page() {
              return <div><p>No heading</p></div>;
            }
          `,
          errors: [{ messageId: "missing" }],
        },
        // 2 sibling h1s — flagged.
        {
          filename: PAGE_FILE,
          code: `
            export default function Page() {
              return <div><h1>First</h1><h1>Second</h1></div>;
            }
          `,
          errors: [{ messageId: "duplicate" }],
        },
      ],
    });
  });
});
