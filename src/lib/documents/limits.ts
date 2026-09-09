/**
 * What one request may make of a document, whatever its format.
 *
 * Both parsers turn a bounded upload into an unbounded string: a .docx
 * through mammoth's HTML, a PDF through pdf.js's text content, and either
 * can inflate a few kilobytes into gigabytes when the file is built to.
 * Each parser charges the text it produces against this budget as it goes
 * and gives up when the budget is spent, so the string is never built.
 */

/** Well above any real proposal (a thousand pages is a few million). */
export const MAX_TEXT_CHARS = 10_000_000;

/** A document that would take more than one request can hold, however so. */
export class DocumentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentTooLargeError";
  }
}
