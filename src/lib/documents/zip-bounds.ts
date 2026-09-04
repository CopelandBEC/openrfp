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

export class ZipTooLargeError extends Error {
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
  for (const e of entries) {
    const actual = measureEntry(buf, e);
    actualTotal += actual;
    if (actualTotal > MAX_EXPANDED_BYTES) {
      throw new ZipTooLargeError(`entries expand to ${actualTotal}+ bytes in total`);
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
  if (cdOffset + cdSize > buf.length) {
    throw new ZipCorruptError("central directory runs past the end of the file");
  }

  const entries: Entry[] = [];
  let pos = cdOffset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new ZipCorruptError("bad central directory header");
    }
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
    entries.push({ method, compressedSize, declaredSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate one entry under the cap and return how many bytes it really is. */
function measureEntry(buf: Buffer, e: Entry): number {
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

  if (e.method === METHOD_STORED) {
    return e.compressedSize;
  }
  if (e.method !== METHOD_DEFLATE) {
    // Neither JSZip nor Word produces anything else; refuse rather than guess.
    throw new ZipCorruptError(`unsupported compression method ${e.method}`);
  }
  try {
    return inflateRawSync(buf.subarray(start, end), {
      maxOutputLength: MAX_ENTRY_BYTES,
    }).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new ZipTooLargeError(`an entry inflates past ${MAX_ENTRY_BYTES} bytes`);
    }
    throw new ZipCorruptError("entry does not inflate");
  }
}
