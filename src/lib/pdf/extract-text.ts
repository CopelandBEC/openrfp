import { DocumentTooLargeError, MAX_TEXT_CHARS } from "@/lib/documents/limits";

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  textPerPage: number;
  likelyScanned: boolean;
}

/**
 * Pages are extracted this many at a time. Each batch is charged against the
 * text budget before the next is parsed, so a document built to render to
 * gigabytes is refused after one batch rather than materialised whole.
 */
const PAGES_PER_BATCH = 25;

/**
 * Extract text from a PDF using pdf-parse (PDFParse class).
 * Returns the extracted text, page count, and an OCR heuristic.
 *
 * Takes the bytes directly rather than a path: writing the upload to /tmp
 * first meant an attacker-controlled filename landed in a filesystem path,
 * and the cleanup unlink was not in a finally block.
 *
 * pdf-parse's getText() parses every page and joins them before returning,
 * so a single call would build the whole string before anything of ours
 * could measure it. Pages are asked for in batches instead, and the running
 * total is charged against the budget shared with the .docx path. The batch
 * texts are joined exactly as pdf-parse joins them, so the output is the
 * same as one call would give. What one page may hold is bounded only by
 * pdf.js itself, which decodes a page's content streams whole.
 */
export async function extractPdfText(
  data: Uint8Array
): Promise<PdfExtractionResult> {
  let parser: {
    getText: (params?: { first?: number; last?: number }) => Promise<{
      text: string;
      total: number;
    }>;
    destroy: () => Promise<void>;
  } | null = null;
  try {
    const { PDFParse } = await import("pdf-parse");

    parser = new PDFParse({ data });

    const parts: string[] = [];
    let chars = 0;
    let pageCount = 0;
    for (let first = 1; ; first += PAGES_PER_BATCH) {
      const batch = await parser.getText({ first, last: first + PAGES_PER_BATCH - 1 });
      pageCount = batch.total;
      chars += batch.text.length;
      if (chars > MAX_TEXT_CHARS) {
        throw new DocumentTooLargeError(
          `PDF renders to more than ${MAX_TEXT_CHARS} characters of text`
        );
      }
      parts.push(batch.text);
      if (first + PAGES_PER_BATCH > pageCount) break;
    }

    const text = parts.join("");
    const pages = pageCount || 1;
    const textPerPage = text.length / pages;
    // Heuristic: if average text per page is < 100 chars, likely scanned
    const likelyScanned = textPerPage < 100;

    return {
      text,
      pageCount: pages,
      textPerPage,
      likelyScanned,
    };
  } catch (error) {
    // Too large is an answer, not a failure: the route tells the user so.
    if (error instanceof DocumentTooLargeError) throw error;
    // The caller reports this to the user as "may need OCR", which is the
    // right guess for a real scan but hides a broken parser completely.
    console.error(
      "PDF text extraction failed:",
      error instanceof Error ? error.message : error
    );
    return {
      text: "",
      pageCount: 0,
      textPerPage: 0,
      likelyScanned: true, // If parsing fails, assume it's scanned/image-based
    };
  } finally {
    await parser?.destroy().catch(() => {});
  }
}
