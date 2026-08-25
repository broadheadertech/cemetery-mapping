/**
 * Types for PDFKit's prebuilt standalone bundle.
 *
 * The package ships types for `"pdfkit"` but not for the standalone
 * build's path. It is the same class — see `./pdfDocument.ts` for why
 * the deployed code must use that build — so the declaration simply
 * points at the published type.
 */
declare module "pdfkit/js/pdfkit.standalone.js" {
  import PDFDocument from "pdfkit";
  export default PDFDocument;
}
