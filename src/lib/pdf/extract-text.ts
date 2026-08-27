import fs from "fs";

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  textPerPage: number;
  likelyScanned: boolean;
}

/**
 * Extract text from a PDF file using pdf-parse (PDFParse class).
 * Returns the extracted text, page count, and an OCR heuristic.
 */
export async function extractPdfText(
  filePath: string
): Promise<PdfExtractionResult> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const dataBuffer = fs.readFileSync(filePath);
    const data = new Uint8Array(dataBuffer);

    const parser = new PDFParse({ data });
    const result = await parser.getText();

    const text = result.text || "";
    const pageCount = result.pages?.length || 1;
    const textPerPage = text.length / pageCount;
    // Heuristic: if average text per page is < 100 chars, likely scanned
    const likelyScanned = textPerPage < 100;

    await parser.destroy();

    return {
      text,
      pageCount,
      textPerPage,
      likelyScanned,
    };
  } catch {
    return {
      text: "",
      pageCount: 0,
      textPerPage: 0,
      likelyScanned: true, // If parsing fails, assume it's scanned/image-based
    };
  }
}
