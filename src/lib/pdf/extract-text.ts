export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  textPerPage: number;
  likelyScanned: boolean;
}

/**
 * Extract text from a PDF using pdf-parse (PDFParse class).
 * Returns the extracted text, page count, and an OCR heuristic.
 *
 * Takes the bytes directly rather than a path: writing the upload to /tmp
 * first meant an attacker-controlled filename landed in a filesystem path,
 * and the cleanup unlink was not in a finally block.
 */
export async function extractPdfText(
  data: Uint8Array
): Promise<PdfExtractionResult> {
  let parser: { getText: () => Promise<{ text?: string; pages?: unknown[] }>; destroy: () => Promise<void> } | null =
    null;
  try {
    const { PDFParse } = await import("pdf-parse");

    parser = new PDFParse({ data });
    const result = await parser.getText();

    const text = result.text || "";
    const pageCount = result.pages?.length || 1;
    const textPerPage = text.length / pageCount;
    // Heuristic: if average text per page is < 100 chars, likely scanned
    const likelyScanned = textPerPage < 100;

    return {
      text,
      pageCount,
      textPerPage,
      likelyScanned,
    };
  } catch (error) {
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
