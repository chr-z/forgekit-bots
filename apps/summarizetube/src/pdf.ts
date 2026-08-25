/**
 * SummarizeTube PDF rendering — implementation lives in @forgekit/app-shared/pdf
 * so DocuMind and future bots can export real PDFs without duplicating the
 * binary plumbing. This module keeps the app-local import path stable.
 */
export { makeContentStream, renderPdf, wrapLine, type PdfDoc } from "@forgekit/app-shared/pdf";
