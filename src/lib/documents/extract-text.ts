import { extractPdfText } from "@/lib/pdf/extract-text";
import { extractDocxText } from "@/lib/documents/extract-docx";
import { kindFromName, type DocumentKind } from "@/lib/documents/types";

export { ZipTooLargeError } from "@/lib/documents/zip-bounds";

export interface DocumentExtractionResult {
  kind: DocumentKind;
  text: string;
  /** 0 when the format does not record one; the UI hides the count then. */
  pageCount: number;
  /**
   * True when there is too little text to evaluate. For a PDF that almost
   * always means a scan without an OCR layer; for a Word file it means the
   * content is pictures (a scanned letter pasted in, say) rather than text.
   */
  likelyScanned: boolean;
}

export class UnsupportedDocumentError extends Error {
  constructor() {
    super("Unsupported document type");
    this.name = "UnsupportedDocumentError";
  }
}

/** Below this many characters per page, treat the document as unreadable. */
const MIN_TEXT_PER_PAGE = 100;

/**
 * Work out what the bytes are and extract their text.
 *
 * The bytes decide, not the name: a PDF saved with a .docx extension is still
 * a PDF, and the parsers fail confusingly when handed the wrong format. The
 * name is consulted only when the bytes start with neither signature.
 */
export async function extractDocumentText(
  data: Uint8Array,
  fileName: string
): Promise<DocumentExtractionResult> {
  const kind = sniffKind(data) ?? kindFromName(fileName);
  if (!kind) throw new UnsupportedDocumentError();

  if (kind === "pdf") {
    const pdf = await extractPdfText(data);
    return {
      kind,
      text: pdf.text,
      pageCount: pdf.pageCount,
      likelyScanned: pdf.likelyScanned,
    };
  }

  const docx = await extractDocxText(data);
  // With no recorded page count, judge the document as a whole: a proposal
  // with fewer than a hundred characters in it is unreadable either way.
  const textPerPage = docx.text.length / Math.max(docx.pageCount, 1);
  return {
    kind,
    text: docx.text,
    pageCount: docx.pageCount,
    likelyScanned: textPerPage < MIN_TEXT_PER_PAGE,
  };
}

/**
 * `%PDF-` for a PDF; `PK\x03\x04` for a zip, which for our purposes is a
 * .docx — mammoth rejects any other zip with a clear message.
 */
function sniffKind(data: Uint8Array): DocumentKind | null {
  if (data.length < 4) return null;
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return "pdf";
  }
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) {
    return "docx";
  }
  return null;
}
