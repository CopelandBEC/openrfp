import JSZip from "jszip";
import mammoth from "mammoth";
import { assertZipWithinBounds } from "@/lib/documents/zip-bounds";

export interface DocxExtractionResult {
  text: string;
  /**
   * Word writes the page count it last laid out into `docProps/app.xml`.
   * Other producers (Google Docs, some generators) leave it out; then this is
   * 0, and the UI omits the count rather than show a guess.
   */
  pageCount: number;
}

/**
 * Extract text from a .docx.
 *
 * Goes through mammoth's HTML rather than its raw-text mode because raw text
 * flattens every table cell onto its own line, and the tables are where a
 * proposal keeps its pricing and its schedule. The HTML is turned back into
 * plain text here with one row per line and cells separated by " | ", so the
 * model reading it can still tell which number belongs to which line item.
 *
 * Images are dropped rather than inlined: mammoth's default embeds them as
 * base64, which would balloon the intermediate string for no text.
 *
 * The archive is measured before anything inflates it in earnest; see
 * zip-bounds.ts. Its errors propagate: the route maps a too-large archive to
 * its own message and anything else to "could not be read".
 */
export async function extractDocxText(
  data: Uint8Array
): Promise<DocxExtractionResult> {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  assertZipWithinBounds(buffer);

  const [{ value: html }, pageCount] = await Promise.all([
    mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      }
    ),
    readPageCount(buffer),
  ]);

  return { text: htmlToText(html), pageCount };
}

async function readPageCount(buffer: Buffer): Promise<number> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const app = zip.file("docProps/app.xml");
    if (!app) return 0;
    const xml = await app.async("string");
    const match = /<Pages>\s*(\d+)\s*<\/Pages>/.exec(xml);
    const pages = match ? Number(match[1]) : 0;
    return Number.isFinite(pages) && pages > 0 ? pages : 0;
  } catch {
    return 0;
  }
}

/**
 * mammoth emits a small, predictable subset of HTML: block elements for
 * paragraphs, headings and list items; table/tr/td for tables; inline
 * strong/em/a/img/br; and only `&amp;`, `&lt;`, `&gt;` as entities in text.
 * That is little enough to unwind with string replacement.
 */
export function htmlToText(html: string): string {
  const cellsFlattened = html.replace(
    /<t([dh])\b[^>]*>([\s\S]*?)<\/t\1>/g,
    (_m, _tag, inner: string) =>
      inner
        .replace(/<br\s*\/?>/g, " ")
        .replace(/<\/(p|h[1-6]|li|div)>/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim() + " | "
  );

  return cellsFlattened
    .replace(/<\/tr>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<li\b[^>]*>/g, "- ")
    .replace(/<\/(p|h[1-6]|li|div|table|tbody|thead|ul|ol|blockquote|pre)>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/\s+\|\s*$/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
