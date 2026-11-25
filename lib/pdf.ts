/**
 * PDF text extraction. Runs in the browser (so big PDFs never hit the
 * serverless request-size limit) and in Node (tests / eval script).
 * Uses unpdf, a serverless build of Mozilla pdf.js (Apache-2.0).
 */

import { pageRuns, type TextRun } from "./evidence-map";
import { LIMITS } from "./limits";
export { LIMITS };

export class PdfInputError extends Error {
  constructor(
    message: string,
    public code: "not_pdf" | "too_large" | "too_many_pages" | "no_text" | "encrypted" | "unreadable",
  ) {
    super(message);
  }
}

/** Magic-bytes check: a real PDF starts with "%PDF-" (allowing a little junk before it). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 1024));
  return head.includes("%PDF-");
}

/**
 * Remove layout noise that pdf.js produces:
 *  - circular seals / logos come out as long runs of 1-2 character lines
 *  - repeated whitespace
 */
export function cleanPageText(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length < 4) out.push(...run); // short runs are probably real (e.g. "M" in a table)
    run = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 0 && t.length <= 2) {
      run.push(t);
      continue;
    }
    flush();
    out.push(t.replace(/[ \t]+/g, " "));
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ExtractedPdf {
  pages: string[];
  pageCount: number;
  characters: number;
  /** Text runs with their positions on each page (only when asked for), used to highlight evidence. */
  runs?: TextRun[][];
}

export async function extractPdfPages(bytes: Uint8Array, opts: { positions?: boolean } = {}): Promise<ExtractedPdf> {
  if (bytes.byteLength > LIMITS.maxFileBytes) {
    throw new PdfInputError(
      `This file is ${(bytes.byteLength / 1048576).toFixed(1)} MB. The limit is ${LIMITS.maxFileBytes / 1048576} MB.`,
      "too_large",
    );
  }
  if (!looksLikePdf(bytes)) {
    throw new PdfInputError("This doesn't look like a PDF file. Please upload a .pdf RFP.", "not_pdf");
  }

  const { getDocumentProxy, extractText } = await import("unpdf");
  let pdf;
  try {
    // pdf.js may detach the buffer, so hand it a copy
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (/password/i.test(msg)) {
      throw new PdfInputError("This PDF is password-protected. Remove the password and try again.", "encrypted");
    }
    throw new PdfInputError("The PDF could not be opened. It may be damaged.", "unreadable");
  }

  if (pdf.numPages > LIMITS.maxPages) {
    throw new PdfInputError(
      `This PDF has ${pdf.numPages} pages. The agent handles up to ${LIMITS.maxPages}. Split off the attachments you don't need and try again.`,
      "too_many_pages",
    );
  }

  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map(cleanPageText);
  const characters = pages.reduce((n, p) => n + p.length, 0);

  if (characters / Math.max(pages.length, 1) < LIMITS.minCharsPerPage) {
    throw new PdfInputError(
      "Almost no text could be read from this PDF. It looks like a scanned image. Run it through OCR first (for example, Adobe Acrobat or ocrmypdf), then upload the text-based PDF.",
      "no_text",
    );
  }

  // Positions are captured in the same pass, once per document, so clicking a finding later
  // never re-reads the PDF. A failure here only disables precise highlighting.
  let runs: TextRun[][] | undefined;
  if (opts.positions) {
    try {
      runs = [];
      for (let i = 1; i <= pdf.numPages; i++) runs.push(await pageRuns(await pdf.getPage(i)));
    } catch {
      runs = undefined;
    }
  }

  return { pages, pageCount: pages.length, characters, runs };
}
