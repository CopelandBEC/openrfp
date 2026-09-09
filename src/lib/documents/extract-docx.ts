import JSZip from "jszip";
import mammoth from "mammoth";
import { DocumentTooLargeError, assertZipWithinBounds } from "@/lib/documents/zip-bounds";

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
 *
 * mammoth's parsed tree is measured too, before it is serialised. The tree
 * is cheap — a thousand hyperlinks to one relationship share one string —
 * but the HTML is not: the target is written out once per link, so a
 * kilobyte of markup pointing a thousand links at a megabyte-long target
 * asks for a gigabyte of HTML before `htmlToText` and its budget get a look.
 * The transform hook runs between the two, and refuses first.
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
        transformDocument: (document) => {
          assertTreeWithinBudget(document);
          return document;
        },
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
 * paragraphs, headings and list items; ul/ol/li for lists, with a sub-list
 * nested inside its parent item; table/tr/td for tables, with colspan and
 * rowspan for merged cells; inline strong/em/a/img/br; and only `&amp;`,
 * `&lt;`, `&gt;` as entities in text.
 *
 * Walked tag by tag rather than matched with regular expressions, because
 * Word allows a table inside a table cell and mammoth emits it as nested
 * `<td>`s; a non-greedy match pairs the outer cell's open tag with the first
 * inner close and the rest of the row falls apart.
 *
 * Tables are rendered a row at a time from buffered cells so that merged
 * cells keep their place: a cell spanning columns is followed by as many
 * empty columns, and a cell spanning rows is repeated into each row it
 * covers, so a line item that Word shows once beside three priced phases is
 * beside each of them here. Cells are joined with " | ", rows with newlines;
 * inside a nested table, " / " and "; ". An empty cell keeps its delimiters
 * ("Item | | $100") so later values stay in their columns.
 *
 * Ordered list items are numbered by their nesting path ("2.1.") rather
 * than bulleted, so a clause referred to elsewhere by number can be found.
 * Word's own numbering is not in the HTML, so every list counts from one.
 *
 * A link's destination follows its text in parentheses when it is a web or
 * mail address the text does not already show: an RFP that says "submit via
 * the portal" has told the reader nothing without the address behind it.
 *
 * Repeating a spanning cell into every row it covers is an amplifier: a cell
 * spanning a hundred rows is written a hundred times, and a nested table
 * inside it is written a hundred times over again, so a few kilobytes of
 * markup can ask for gigabytes of text. The zip caps bound the archive, not
 * this, so every character written here is counted against a budget and the
 * walk gives up — as "too large", the same answer a zip bomb gets — when it
 * is spent. Nesting is capped too; nothing legitimate nests tables eight
 * deep.
 */
/** Well above any real proposal (a thousand pages is a few million). */
export const MAX_TEXT_CHARS = 10_000_000;
const MAX_TABLE_DEPTH = 8;

const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "div", "blockquote", "pre",
]);

interface CellBuffer {
  parts: string[];
  colspan: number;
  rowspan: number;
}

interface TableContext {
  rows: string[][];
  /** Column → text of a cell above still spanning into the coming rows. */
  carry: Map<number, { text: string; remaining: number }>;
  row: CellBuffer[] | null;
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  /** Where text goes: the document, or the innermost open cell. */
  const sinks: string[][] = [out];
  const tables: TableContext[] = [];
  const lists: { ordered: boolean; count: number }[] = [];
  /** Open anchors: the destination and where its text began in the sink. */
  const anchors: { href: string; sink: string[]; start: number }[] = [];

  let written = 0;
  const charge = (chars: number) => {
    written += chars;
    if (written > MAX_TEXT_CHARS) {
      throw new DocumentTooLargeError(
        `Document renders to more than ${MAX_TEXT_CHARS} characters of text`
      );
    }
  };
  const emit = (target: string[], text: string) => {
    charge(text.length);
    target.push(text);
  };

  const inCell = () => sinks.length > 1;
  const sink = () => sinks[sinks.length - 1];
  const newline = () => {
    const s = sink();
    if (inCell()) {
      s.push(" ");
    } else if (s.length > 0 && !s[s.length - 1].endsWith("\n")) {
      s.push("\n");
    }
  };

  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|[^<]+/g)) {
    if (m[2] === undefined) {
      const text = decodeEntities(m[0]);
      emit(sink(), inCell() ? text.replace(/\s+/g, " ") : text);
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    const attrs = m[3];

    if (tag === "table") {
      if (!closing) {
        newline();
        if (tables.length >= MAX_TABLE_DEPTH) {
          throw new DocumentTooLargeError(
            `Tables nested more than ${MAX_TABLE_DEPTH} deep`
          );
        }
        tables.push({ rows: [], carry: new Map(), row: null });
      } else {
        const table = tables.pop();
        if (table) {
          const nested = inCell();
          // Cell text and column delimiters were charged as the rows were
          // rendered; the row separators are new.
          charge(table.rows.length * 2 + 2);
          const text = table.rows
            .map((cols) => cols.join(nested ? " / " : " | "))
            .join(nested ? "; " : "\n");
          sink().push(nested ? ` ${text} ` : `${text}\n\n`);
        }
      }
    } else if (tag === "tr") {
      const table = tables[tables.length - 1];
      if (!table) continue;
      if (!closing) {
        table.row = [];
      } else if (table.row) {
        table.rows.push(renderRow(table, table.row, charge));
        table.row = null;
      }
    } else if (tag === "td" || tag === "th") {
      const table = tables[tables.length - 1];
      if (!closing) {
        const cell: CellBuffer = {
          parts: [],
          colspan: spanAttribute(attrs, "colspan"),
          rowspan: spanAttribute(attrs, "rowspan"),
        };
        table?.row?.push(cell);
        sinks.push(cell.parts);
      } else if (inCell()) {
        sinks.pop();
      }
    } else if (tag === "ol" || tag === "ul") {
      if (!closing) {
        newline();
        lists.push({ ordered: tag === "ol", count: 0 });
      } else {
        lists.pop();
        newline();
      }
    } else if (tag === "li" && !closing) {
      const list = lists[lists.length - 1];
      if (list) list.count++;
      emit(sink(), list?.ordered ? `${listNumber(lists)} ` : "- ");
    } else if (tag === "a") {
      if (!closing) {
        const href = decodeEntities(/\bhref="([^"]*)"/i.exec(attrs)?.[1] ?? "");
        anchors.push({ href, sink: sink(), start: sink().length });
      } else {
        const a = anchors.pop();
        if (a && /^(https?:\/\/|mailto:)/i.test(a.href)) {
          const label = a.sink.slice(a.start).join("");
          const shown = a.href.replace(/^mailto:/i, "");
          if (!label.includes(shown)) emit(a.sink, ` (${shown})`);
        }
      }
    } else if (tag === "br") {
      newline();
    } else if (closing && BLOCK_TAGS.has(tag)) {
      newline();
    }
  }

  return out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sum what the HTML serialiser will write for the tree — text, and the
 * destination of every link, once per link — and refuse past the budget.
 * Notes and comments are included because mammoth appends them to the
 * document. Iterative, so a deep tree cannot overflow the stack.
 */
function assertTreeWithinBudget(document: unknown): void {
  interface Node {
    type?: string;
    children?: Node[];
    body?: Node[];
    value?: string;
    href?: string;
    anchor?: string;
    notes?: { _notes?: Record<string, Node> };
    comments?: Node[];
  }
  const root = document as Node;
  const stack: Node[] = [root];
  for (const note of Object.values(root.notes?._notes ?? {})) stack.push(note);
  for (const comment of root.comments ?? []) stack.push(comment);

  let chars = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (typeof node.value === "string") chars += node.value.length;
    if (typeof node.href === "string") chars += node.href.length;
    if (typeof node.anchor === "string") chars += node.anchor.length;
    if (chars > MAX_TEXT_CHARS) {
      throw new DocumentTooLargeError(
        `Document holds more than ${MAX_TEXT_CHARS} characters of text and link targets`
      );
    }
    // Pushed one at a time: spreading a million children into one call is
    // itself a stack overflow.
    for (const child of node.children ?? []) stack.push(child);
    for (const child of node.body ?? []) stack.push(child);
  }
}

/** "2.1." for the second top-level item's first sub-item. */
function listNumber(lists: { ordered: boolean; count: number }[]): string {
  return (
    lists
      .filter((l) => l.ordered)
      .map((l) => l.count)
      .join(".") + "."
  );
}

function spanAttribute(attrs: string, name: string): number {
  const m = new RegExp(`\\b${name}="(\\d+)"`, "i").exec(attrs);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 1 ? Math.min(n, 100) : 1;
}

/**
 * Lay the row's cells onto grid columns, filling any column still covered by
 * a cell above with that cell's text, and padding a spanning cell with empty
 * columns so that everything after it stays aligned. Every repeat of a
 * carried cell is new text, and every column its delimiter, and both are
 * charged to the budget: a table of sixty thousand empty hundred-column
 * cells is nothing but delimiters, and would otherwise cost nothing.
 */
const DELIMITER_CHARS = 3;
function renderRow(
  table: TableContext,
  cells: CellBuffer[],
  charge: (chars: number) => void
): string[] {
  const cols: string[] = [];
  let col = 0;
  const takeCarry = () => {
    const c = table.carry.get(col);
    if (!c) return false;
    charge(c.text.length + DELIMITER_CHARS);
    cols.push(c.text);
    if (--c.remaining <= 0) table.carry.delete(col);
    col++;
    return true;
  };

  for (const cell of cells) {
    while (takeCarry()) {
      // fill every covered column before this cell
    }
    const text = cell.parts.join("").replace(/\s+/g, " ").trim();
    charge(DELIMITER_CHARS);
    cols.push(text);
    if (cell.rowspan > 1) {
      table.carry.set(col, { text, remaining: cell.rowspan - 1 });
    }
    col++;
    // The extra columns of a spanning cell are covered too: carry an empty
    // column into the rows below so nothing shifts into the merged region.
    for (let i = 1; i < cell.colspan; i++) {
      charge(DELIMITER_CHARS);
      cols.push("");
      if (cell.rowspan > 1) {
        table.carry.set(col, { text: "", remaining: cell.rowspan - 1 });
      }
      col++;
    }
  }
  const trailing = [...table.carry.keys()].filter((k) => k >= col).sort((a, b) => a - b);
  for (const k of trailing) {
    col = k;
    takeCarry();
  }
  return cols;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
