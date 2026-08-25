/**
 * The PDFKit constructor every generator in this app must use.
 *
 * ## Why not just `import PDFDocument from "pdfkit"`
 *
 * PDFKit's standard fonts — Helvetica, Times-Roman, Courier and their
 * variants — carry their metrics in `.afm` files that the library reads
 * from disk at render time:
 *
 *     fs.readFileSync(`${__dirname}/data/Helvetica.afm`)
 *
 * Convex bundles a Node action's JavaScript; it does not carry that
 * package's data directory along. Deployed, `__dirname` resolves inside
 * the Lambda root and the read fails:
 *
 *     ENOENT: no such file or directory, open '/var/task/data/Helvetica.afm'
 *
 * Every PDF in the product died on that line — receipts, contracts,
 * demand letters, plaques, report exports. It could not reproduce
 * locally, because a local `node_modules` has the data directory sitting
 * right where PDFKit expects it. The failure only exists once the code
 * is bundled and shipped, which is exactly the kind of bug that reaches
 * a customer.
 *
 * `pdfkit.standalone.js` is PDFKit's prebuilt bundle with those metrics
 * inlined, so it never touches the filesystem. Same API, same output,
 * no ambient file dependency.
 *
 * ## Rules
 *
 *   - Import the constructor from HERE, never from `"pdfkit"` directly.
 *     A single direct import brings the bug back for that one document
 *     type, and it will not be caught before deployment.
 *   - This module is Node-only. Never import it from a V8 query or
 *     mutation file — the same rule that governs anything reachable
 *     from a `"use node"` module.
 */

import PDFDocument from "pdfkit/js/pdfkit.standalone.js";

export default PDFDocument;
