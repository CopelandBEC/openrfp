/**
 * What the app accepts as a document, shared by the browser (file picker,
 * validation, the content type sent to storage) and the server (the read-back
 * check, the parser dispatch). No server-only imports here.
 */
export type DocumentKind = "pdf" | "docx";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MIME_BY_KIND: Record<DocumentKind, string> = {
  pdf: PDF_MIME,
  docx: DOCX_MIME,
};

export const ACCEPTED_MIME_TYPES: readonly string[] = [PDF_MIME, DOCX_MIME];
export const ACCEPTED_EXTENSIONS: readonly string[] = [".pdf", ".docx"];

/** Value for a file input's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = [...ACCEPTED_EXTENSIONS, ...ACCEPTED_MIME_TYPES].join(",");

/** The one-line description shown under the drop target. */
export const ACCEPTED_LABEL = "PDF or Word (.docx), up to 25MB";

/**
 * The refusal shown for anything else. Legacy `.doc` is the common case
 * people will hit, so it gets a specific instruction.
 */
export const UNSUPPORTED_TYPE_MESSAGE =
  "Only PDF and Word (.docx) files are supported. Older .doc files need to be saved as .docx or exported to PDF first.";

export function kindFromMime(mime: string | null | undefined): DocumentKind | null {
  if (mime === PDF_MIME) return "pdf";
  if (mime === DOCX_MIME) return "docx";
  return null;
}

export function kindFromName(name: string | null | undefined): DocumentKind | null {
  const lower = (name ?? "").toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  return null;
}

/**
 * Decide what a file the user picked is. The browser's reported type comes
 * first, but browsers on machines without Office installed report a `.docx`
 * as `application/octet-stream` or as nothing at all, so the extension is the
 * fallback rather than a second requirement.
 */
export function kindOfFile(file: { name: string; type: string }): DocumentKind | null {
  return kindFromMime(file.type) ?? kindFromName(file.name);
}
