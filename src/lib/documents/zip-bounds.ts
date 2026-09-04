import { inflateRawSync } from "node:zlib";

/**
 * Refuse a zip that would expand beyond what one request can hold.
 *
 * A .docx is a zip, and deflate will turn a few kilobytes of repetition into
 * gigabytes. The 25 MB storage ceiling bounds what arrives, not what it
 * becomes, and the hourly claim limit bounds how often — neither protects the
 * single invocation that parses a crafted file. mammoth inflates whatever it
 * is handed, and JSZip beneath it checks the declared size only after the
 * full output is in memory, so the check has to happen here, first.
 *
 * Declared sizes are read from the central directory and rejected early when
 * they exceed the limits. Because a declared size can lie, every entry is
 * then actually inflated with zlib's output cap, which aborts a stream the
 * moment it passes the limit rather than after it has been materialised. That
 * is a second decompression pass, but of at most the limit's worth of bytes
 * from an input of at most 25 MB, which is cheap next to the parse itself.
 */
export const MAX_ZIP_ENTRIES = 5_000;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
/**
 * Bytes bound bytes, not nodes: sixty megabytes of `<w:p/>` is ten million
 * elements, each a DOM object once mammoth's XML parser has built it, and
 * none of them text. The inflated XML parts are already in hand here, so
 * their tags are counted — every `<` is a start tag, an end tag or a
 * comment — and the total capped.
 *
 * The cap is set by what mammoth can parse in a serverless function, not by
 * what a document might hold. Measured: 720 k tags of text paragraphs parse
 * within a 512 MB heap; 1.2 M need a gigabyte. Six hundred thousand is
 * roughly a hundred thousand plain paragraphs, some two hundred pages; a
 * heavily formatted proposal reaches it sooner, and is told to export to PDF.
 */
export const MAX_XML_TAGS = 600_000;

/** A document that would take more than one request can hold, however so. */
export class DocumentTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentTooLargeError";
  }
}

export class ZipTooLargeError extends DocumentTooLargeError {
  constructor(detail: string) {
    super(`Zip expands beyond the limit: ${detail}`);
    this.name = "ZipTooLargeError";
  }
}

export class ZipCorruptError extends Error {
  constructor(detail: string) {
    super(`Not a readable zip: ${detail}`);
    this.name = "ZipCorruptError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** Zip64 marker; a Word document never needs it and we will not read one. */
const ZIP64 = 0xffffffff;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

export function assertZipWithinBounds(buf: Buffer): void {
  const entries = readCentralDirectory(buf);

  let declaredTotal = 0;
  for (const e of entries) {
    if (e.declaredSize > MAX_ENTRY_BYTES) {
      throw new ZipTooLargeError(`entry declares ${e.declaredSize} bytes`);
    }
    declaredTotal += e.declaredSize;
    if (declaredTotal > MAX_EXPANDED_BYTES) {
      throw new ZipTooLargeError(`entries declare ${declaredTotal}+ bytes in total`);
    }
  }

  let actualTotal = 0;
  let tags = 0;
  for (const e of entries) {
    const measured = measureEntry(buf, e);
    actualTotal += measured.bytes;
    if (actualTotal > MAX_EXPANDED_BYTES) {
      throw new ZipTooLargeError(`entries expand to ${actualTotal}+ bytes in total`);
    }
    tags += measured.tags;
    if (tags > MAX_XML_TAGS) {
      throw new ZipTooLargeError(`XML parts hold more than ${MAX_XML_TAGS} tags`);
    }
  }
}

function readCentralDirectory(buf: Buffer): Entry[] {
  // The end-of-central-directory record is the last 22 bytes unless a comment
  // (at most 65535 bytes) follows it. Scan back for its signature.
  const minEocd = 22;
  const stop = Math.max(0, buf.length - minEocd - 0xffff);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipCorruptError("no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === ZIP64 || cdOffset === ZIP64) {
    throw new ZipTooLargeError("zip64 archive");
  }
  if (count > MAX_ZIP_ENTRIES) {
    throw new ZipTooLargeError(`${count} entries`);
  }
  // The directory has to run exactly up to the end record. JSZip shifts every
  // offset when it finds bytes between the two, and would then be reading a
  // different file from the one measured here.
  if (cdOffset + cdSize !== eocd) {
    throw new ZipCorruptError("central directory does not end at the end record");
  }

  // Walk by signature to the end of the span, the way JSZip does, rather than
  // for the declared count: JSZip only warns when the two disagree, so an
  // entry hidden past an understated count would still be inflated by
  // mammoth if it were not measured here. Any disagreement is refused.
  const entries: Entry[] = [];
  let pos = cdOffset;
  while (pos + 4 <= eocd && buf.readUInt32LE(pos) === CENTRAL_SIGNATURE) {
    if (pos + 46 > eocd) throw new ZipCorruptError("truncated central directory header");
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const declaredSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    if (compressedSize === ZIP64 || declaredSize === ZIP64 || localHeaderOffset === ZIP64) {
      throw new ZipTooLargeError("zip64 entry");
    }
    if (pos + 46 + nameLen > eocd) throw new ZipCorruptError("entry name runs past the directory");
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    entries.push({ name, method, compressedSize, declaredSize, localHeaderOffset });
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new ZipTooLargeError(`more than ${MAX_ZIP_ENTRIES} entries`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== eocd) {
    throw new ZipCorruptError("unexpected bytes in the central directory");
  }
  if (entries.length !== count) {
    throw new ZipCorruptError(
      `end record declares ${count} entries, directory holds ${entries.length}`
    );
  }
  return entries;
}

/**
 * Inflate one entry under the cap and return how many bytes it really is,
 * and, for an XML part, how many tags it holds.
 */
function measureEntry(buf: Buffer, e: Entry): { bytes: number; tags: number } {
  const h = e.localHeaderOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== LOCAL_SIGNATURE) {
    throw new ZipCorruptError("bad local file header");
  }
  const nameLen = buf.readUInt16LE(h + 26);
  const extraLen = buf.readUInt16LE(h + 28);
  const start = h + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > buf.length) {
    throw new ZipCorruptError("entry data runs past the end of the file");
  }

  const isXml = /\.(xml|rels)$/i.test(e.name);
  if (e.method === METHOD_STORED) {
    const data = buf.subarray(start, end);
    return { bytes: data.length, tags: isXml ? countTags(data) : 0 };
  }
  if (e.method !== METHOD_DEFLATE) {
    // Neither JSZip nor Word produces anything else; refuse rather than guess.
    throw new ZipCorruptError(`unsupported compression method ${e.method}`);
  }
  try {
    const data = inflateRawSync(buf.subarray(start, end), {
      maxOutputLength: MAX_ENTRY_BYTES,
    });
    return { bytes: data.length, tags: isXml ? countTags(data) : 0 };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new ZipTooLargeError(`an entry inflates past ${MAX_ENTRY_BYTES} bytes`);
    }
    throw new ZipCorruptError("entry does not inflate");
  }
}

/** Every `<` opens a tag of some kind; `indexOf` keeps the scan native. */
function countTags(data: Buffer): number {
  let n = 0;
  for (let i = data.indexOf(0x3c); i !== -1; i = data.indexOf(0x3c, i + 1)) {
    if (++n > MAX_XML_TAGS) break;
  }
  return n;
}
