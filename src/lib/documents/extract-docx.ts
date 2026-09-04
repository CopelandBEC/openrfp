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
 *
 * Walked tag by tag with a depth counter rather than matched with regular
 * expressions, because Word allows a table inside a table cell and mammoth
 * emits it as nested `<td>`s; a non-greedy match pairs the outer cell's open
 * tag with the first inner close and the rest of the row falls apart. Here a
 * cell's contents are flattened onto its line however deep they go: nested
 * cells joined with " / ", nested rows with "; ", and the outer cells with
 * " | " as before.
 */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "div",
  "table", "tbody", "thead", "ul", "ol", "blockquote", "pre",
]);

const SEPARATORS = new Set([" | ", " / ", "; ", " "]);

export function htmlToText(html: string): string {
  const out: string[] = [];
  let cellDepth = 0;
  // A separator replaces any separators already trailing, so a nested row's
  // end reads "a / b; c / d", not "a / b / ; c / d / ;".
  const separate = (sep: string) => {
    while (out.length > 0 && SEPARATORS.has(out[out.length - 1])) out.pop();
    out.push(sep);
  };

  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+/g)) {
    if (m[2] === undefined) {
      const text = decodeEntities(m[0]);
      out.push(cellDepth > 0 ? text.replace(/\s+/g, " ") : text);
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();

    if (tag === "td" || tag === "th") {
      if (!closing) {
        cellDepth++;
      } else if (cellDepth > 0) {
        cellDepth--;
        separate(cellDepth === 0 ? " | " : " / ");
      }
    } else if (tag === "tr") {
      if (closing) separate(cellDepth > 0 ? "; " : "\n");
    } else if (tag === "br") {
      separate(cellDepth > 0 ? " " : "\n");
    } else if (tag === "li" && !closing) {
      if (cellDepth === 0) out.push("- ");
    } else if (closing && BLOCK_TAGS.has(tag)) {
      separate(cellDepth > 0 ? " " : "\n");
    }
  }

  return out
    .join("")
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s*(\||\/|;)\s*$/, "")
        .trimEnd()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
