import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { createGunzip, createInflateRaw } from 'node:zlib';

/**
 * Streaming archive readers for Google Takeout imports.
 *
 * Supports `.tar`, `.tar.gz` (any gzip-wrapped tar) and `.zip` archives using only Node builtins.
 * Tar entries are read sequentially and must be consumed before the next entry is requested.
 * Zip entries are indexed via the central directory and each `open()` call creates an
 * independent read stream over the file's byte range.
 */

export enum ArchiveFormat {
  Zip = 'zip',
  Tar = 'tar',
  TarGz = 'tgz',
}

export type ArchiveLimits = {
  /** maximum number of file entries in an archive */
  maxEntries?: number;
  /** maximum total uncompressed size in bytes across all entries */
  maxTotalBytes?: number;
};

export type ArchiveEntry = {
  /** slash-separated path relative to the archive root (zip-slip safe) */
  path: string;
  /** uncompressed size in bytes */
  size: number;
  /** entry modification time, when the archive format provides one */
  mtime?: Date;
};

export type ArchiveFile = ArchiveEntry & {
  /**
   * Opens a readable stream for the entry contents.
   * For tar/tar.gz archives the returned stream must be fully consumed (or abandoned) before
   * iterating to the next entry, and `open()` may only be called once per entry.
   */
  open: () => Readable | Promise<Readable>;
};

export class ArchiveError extends Error {}
export class UnsafeArchivePathError extends ArchiveError {}
export class ArchiveLimitError extends ArchiveError {}

export const ARCHIVE_MAX_ENTRIES = 50_000;
export const ARCHIVE_MAX_TOTAL_BYTES = 200 * 1024 * 1024 * 1024; // 200 GiB

const TAR_BLOCK_SIZE = 512;
const ENTRY_CHUNK_SIZE = 256 * 1024;
/** Tar longname/PAX metadata blocks are tiny in practice — anything larger is hostile. */
const TAR_MAX_METADATA_BYTES = 1024 * 1024;
const ZERO_BLOCK = Buffer.alloc(TAR_BLOCK_SIZE);

/** Fails the stream once more than `limit` bytes flow through — guards against a lying declared size. */
const byteLimitStream = (limit: number): Transform => {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(new ArchiveLimitError(`Archive entry produced more than its declared size of ${limit} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
};

/** Returns `undefined` for absurd/absent epoch seconds so downstream `utimes` never gets an Invalid Date. */
const saneDate = (epochSeconds: number): Date | undefined => {
  const ms = epochSeconds * 1000;
  if (!Number.isFinite(ms) || ms < 0 || ms > 4_102_444_800_000) {
    return undefined;
  }
  return new Date(ms);
};

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04_03_4b_50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02_01_4b_50;
const ZIP_EOCD_SIGNATURE = 0x06_05_4b_50;
const ZIP64_EOCD_SIGNATURE = 0x06_06_4b_50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07_06_4b_50;
const ZIP64_EXTRA_TAG = 0x00_01;
const ZIP_EOCD_SIZE = 22;
const ZIP64_EOCD_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_LOCAL_HEADER_SIZE = 30;
const ZIP_EOCD_SCAN_LENGTH = 65_557; // EOCD + max comment length
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

/**
 * Detects the archive format from the first bytes of a file.
 * Requires at least 262 bytes to reliably detect uncompressed tar archives.
 */
export const detectArchiveFormat = (header: Buffer): ArchiveFormat | null => {
  if (
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(header[2]) &&
    [0x04, 0x06, 0x08].includes(header[3])
  ) {
    return ArchiveFormat.Zip;
  }

  if (header.length >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
    return ArchiveFormat.TarGz;
  }

  if (header.length >= 262 && header.toString('latin1', 257, 262) === 'ustar') {
    return ArchiveFormat.Tar;
  }

  return null;
};

/**
 * Normalizes an archive entry name and guards against zip-slip.
 * Returns `null` for directory entries and names that normalize to nothing.
 * Throws `UnsafeArchivePathError` for absolute paths, drive letters and `..` traversal.
 */
export const sanitizeEntryPath = (name: string): string | null => {
  const normalized = name.replaceAll('\\', '/').replaceAll('\0', '');
  if (!normalized || normalized.endsWith('/')) {
    return null;
  }

  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new UnsafeArchivePathError(`Unsafe archive entry path (absolute path): ${name}`);
  }

  const segments = normalized.split('/').filter((segment) => segment !== '.' && segment !== '');
  if (segments.includes('..')) {
    throw new UnsafeArchivePathError(`Unsafe archive entry path (path traversal): ${name}`);
  }

  if (segments.length === 0) {
    return null;
  }

  return segments.join('/');
};

/**
 * Opens a file as an archive of the given format and yields its entries.
 */
export const readArchive = (
  filePath: string,
  format: ArchiveFormat,
  limits: ArchiveLimits = {},
): AsyncGenerator<ArchiveFile> => {
  switch (format) {
    case ArchiveFormat.Zip: {
      return readZipArchive(filePath, limits);
    }
    case ArchiveFormat.TarGz: {
      return readTarArchive(createReadStream(filePath).pipe(createGunzip()), limits);
    }
    case ArchiveFormat.Tar: {
      return readTarArchive(createReadStream(filePath), limits);
    }
  }
};

// ---------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------

/** Pull-based buffered reader over an async stream, so entry streams can read lazily. */
class TarStreamReader {
  private iterator: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private done = false;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Reads up to `count` bytes. May return fewer (or zero) bytes at end of stream. */
  async readBytes(count: number): Promise<Buffer> {
    while (!this.done && this.buffered < count) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      if (value === undefined) {
        continue;
      }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }

    return this.take(Math.min(count, this.buffered));
  }

  private take(count: number): Buffer {
    if (count === 0) {
      return Buffer.alloc(0);
    }

    const head = this.chunks[0];
    if (head.length === count) {
      this.chunks.shift();
      this.buffered -= count;
      return head;
    }

    if (count < head.length) {
      this.chunks[0] = head.subarray(count);
      this.buffered -= count;
      return head.subarray(0, count);
    }

    const parts: Buffer[] = [];
    let remaining = count;
    while (remaining > 0 && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= remaining) {
        this.chunks.shift();
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, remaining));
        this.chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }

    this.buffered -= count;
    return Buffer.concat(parts);
  }

  /** Consumes exactly `count` bytes. Throws if the stream ends early. Drains in bounded chunks. */
  async skipBytes(count: number): Promise<void> {
    let remaining = count;
    while (remaining > 0) {
      const chunk = await this.readBytes(Math.min(remaining, ENTRY_CHUNK_SIZE));
      if (chunk.length === 0) {
        throw new ArchiveError('Unexpected end of archive');
      }
      remaining -= chunk.length;
    }
  }
}

const isZeroBlock = (block: Buffer) => block.equals(ZERO_BLOCK);

/** Tar numeric fields are octal ASCII, or base-256 binary when the high bit is set. */
const parseTarNumber = (header: Buffer, offset: number, length: number): number => {
  if (header[offset] & 0x80) {
    let value = 0n;
    for (let index = offset + 1; index < offset + length; index++) {
      value = (value << 8n) | BigInt(header[index]);
    }
    return Number(value);
  }

  const text = header
    .toString('latin1', offset, offset + length)
    .replaceAll('\0', ' ')
    .trim();
  return text ? Number.parseInt(text, 8) : 0;
};

const verifyTarChecksum = (header: Buffer): boolean => {
  const expected = parseTarNumber(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index++) {
    // the checksum field itself counts as spaces
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  return actual === expected;
};

/** Extracts the `path` keyword from a PAX extended header block (`len key=value\n` records). */
const parsePaxPath = (data: Buffer): string | null => {
  const text = data.toString('utf8');
  const match = /(?:^|\n)\d+ path=(.+)\n/.exec(text);
  return match ? match[1] : null;
};

const readTarString = (header: Buffer, offset: number, length: number) =>
  header.toString('utf8', offset, offset + length).split('\0', 1)[0];

/**
 * Iterates the entries of a tar stream. Each entry must be consumed before moving on;
 * unread data is drained automatically when the next entry is requested.
 */
export async function* readTarArchive(stream: Readable, limits: ArchiveLimits = {}): AsyncGenerator<ArchiveFile> {
  try {
    yield* readTarArchiveEntries(stream, limits);
  } finally {
    // destroy the source stream on abandonment (consumer break/cancel) or generator
    // error — otherwise the file descriptor leaks in the long-lived worker
    stream.destroy();
  }
}

async function* readTarArchiveEntries(stream: Readable, limits: ArchiveLimits): AsyncGenerator<ArchiveFile> {
  const reader = new TarStreamReader(stream);
  const maxEntries = limits.maxEntries ?? ARCHIVE_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? ARCHIVE_MAX_TOTAL_BYTES;
  let entries = 0;
  let totalBytes = 0;
  let longName: string | null = null;

  while (true) {
    const header = await reader.readBytes(TAR_BLOCK_SIZE);
    if (header.length === 0) {
      return;
    }
    if (header.length < TAR_BLOCK_SIZE) {
      throw new ArchiveError('Truncated tar header');
    }
    if (isZeroBlock(header)) {
      return;
    }
    if (!verifyTarChecksum(header)) {
      throw new ArchiveError('Invalid tar header checksum');
    }

    const size = parseTarNumber(header, 124, 12);
    const mtimeSeconds = parseTarNumber(header, 136, 12);
    const typeFlag = String.fromCodePoint(header[156]);
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    switch (typeFlag) {
      // GNU long name — actual filename follows in the data block
      case 'L': {
        if (size > TAR_MAX_METADATA_BYTES) {
          throw new ArchiveError('Oversized tar longname entry');
        }
        const nameData = await reader.readBytes(size);
        longName = nameData.toString('utf8').split('\0', 1)[0];
        await reader.skipBytes(paddedSize - size);
        continue;
      }
      // PAX extended header (x) and global header (g)
      case 'x':
      case 'g': {
        if (size > TAR_MAX_METADATA_BYTES) {
          throw new ArchiveError('Oversized tar PAX header');
        }
        const paxData = await reader.readBytes(size);
        await reader.skipBytes(paddedSize - size);
        if (typeFlag === 'x') {
          longName = parsePaxPath(paxData) ?? longName;
        }
        continue;
      }
      // regular files only ('0' / '\0' / '7' contiguous); everything else is skipped —
      // links, fifos, devices, sparse ('S'), volume ('V'), GNU extensions, unknown flags
      case '0':
      case '\0':
      case '7': {
        break;
      }
      default: {
        await reader.skipBytes(paddedSize);
        continue;
      }
    }

    const nameField = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = sanitizeEntryPath(longName ?? (prefix ? `${prefix}/${nameField}` : nameField));
    longName = null;

    if (path === null) {
      await reader.skipBytes(paddedSize);
      continue;
    }

    entries++;
    if (entries > maxEntries) {
      throw new ArchiveLimitError(`Archive contains more than ${maxEntries} files`);
    }
    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      throw new ArchiveLimitError(`Archive exceeds the maximum extracted size of ${maxTotalBytes} bytes`);
    }

    const mtime = saneDate(mtimeSeconds);

    let consumed = 0;
    const entryStream = Readable.from(
      (async function* () {
        while (consumed < size) {
          const chunk = await reader.readBytes(Math.min(size - consumed, ENTRY_CHUNK_SIZE));
          if (chunk.length === 0) {
            throw new ArchiveError('Unexpected end of archive entry');
          }
          consumed += chunk.length;
          yield chunk;
        }
      })(),
    );

    let opened = false;
    const open = () => {
      if (opened) {
        throw new ArchiveError(`Entry stream for ${path} has already been opened`);
      }
      opened = true;
      return entryStream;
    };

    yield { path, size, mtime, open };

    // drain any bytes the consumer left unread so the next header starts at the right offset
    while (consumed < size) {
      const chunk = await reader.readBytes(Math.min(size - consumed, ENTRY_CHUNK_SIZE));
      if (chunk.length === 0) {
        throw new ArchiveError('Unexpected end of archive');
      }
      consumed += chunk.length;
    }
    await reader.skipBytes(paddedSize - size);
  }
}

// ---------------------------------------------------------------------------
// zip
// ---------------------------------------------------------------------------

const readAt = async (handle: Awaited<ReturnType<typeof open>>, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new ArchiveError('Truncated zip archive');
  }
  return buffer;
};

const dosToDate = (dosDate: number, dosTime: number): Date =>
  new Date(
    ((dosDate >> 9) & 0x7f) + 1980,
    ((dosDate >> 5) & 0x0f) - 1,
    dosDate & 0x1f,
    (dosTime >> 11) & 0x1f,
    (dosTime >> 5) & 0x3f,
    (dosTime & 0x1f) * 2,
  );

type ZipDirectory = {
  entryCount: number;
  offset: number;
};

const findEndOfCentralDirectory = async (
  handle: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<ZipDirectory & { eocdOffset: number }> => {
  const scanLength = Math.min(fileSize, ZIP_EOCD_SCAN_LENGTH);
  const scan = await readAt(handle, fileSize - scanLength, scanLength);

  for (let index = scanLength - ZIP_EOCD_SIZE; index >= 0; index--) {
    if (scan.readUInt32LE(index) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }

    let entryCount = scan.readUInt16LE(index + 10);
    const size = scan.readUInt32LE(index + 12);
    let offset = scan.readUInt32LE(index + 16);
    const eocdOffset = fileSize - scanLength + index;

    // zip64: sizes/counts are stored in a separate end of central directory record
    if (entryCount === 0xff_ff || size === 0xff_ff_ff_ff || offset === 0xff_ff_ff_ff) {
      const locator = await readAt(handle, eocdOffset - ZIP64_EOCD_LOCATOR_SIZE, ZIP64_EOCD_LOCATOR_SIZE);
      if (locator.readUInt32LE(0) !== ZIP64_EOCD_LOCATOR_SIGNATURE) {
        throw new ArchiveError('Zip64 end of central directory locator not found');
      }
      const zip64Offset = Number(locator.readBigUInt64LE(8));
      const zip64 = await readAt(handle, zip64Offset, ZIP64_EOCD_SIZE);
      if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
        throw new ArchiveError('Invalid zip64 end of central directory');
      }
      entryCount = Number(zip64.readBigUInt64LE(32));
      offset = Number(zip64.readBigUInt64LE(48));
    }

    return { entryCount, offset, eocdOffset };
  }

  throw new ArchiveError('End of central directory not found');
};

/** Reads zip64 extra field values for any field stored as 0xFFFFFFFF in the fixed record. */
const parseZip64Extra = (
  extra: Buffer,
  current: { compressedSize: number; size: number; localHeaderOffset: number },
) => {
  const values = { ...current };
  let position = 0;
  while (position + 4 <= extra.length) {
    const tag = extra.readUInt16LE(position);
    const length = extra.readUInt16LE(position + 2);
    const body = extra.subarray(position + 4, position + 4 + length);
    if (tag === ZIP64_EXTRA_TAG) {
      let offset = 0;
      if (values.size === 0xff_ff_ff_ff && offset + 8 <= body.length) {
        values.size = Number(body.readBigUInt64LE(offset));
        offset += 8;
      }
      if (values.compressedSize === 0xff_ff_ff_ff && offset + 8 <= body.length) {
        values.compressedSize = Number(body.readBigUInt64LE(offset));
        offset += 8;
      }
      if (values.localHeaderOffset === 0xff_ff_ff_ff && offset + 8 <= body.length) {
        values.localHeaderOffset = Number(body.readBigUInt64LE(offset));
      }
      break;
    }
    position += 4 + length;
  }
  return values;
};

/** Opens a readable stream for a zip entry's compressed data, inflated when needed. */
const openZipEntry = async (
  filePath: string,
  localHeaderOffset: number,
  compressedSize: number,
  declaredSize: number,
  method: number,
): Promise<Readable> => {
  const handle = await open(filePath, 'r');
  try {
    const header = await readAt(handle, localHeaderOffset, ZIP_LOCAL_HEADER_SIZE);
    if (header.readUInt32LE(0) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw new ArchiveError('Invalid zip local file header');
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = localHeaderOffset + ZIP_LOCAL_HEADER_SIZE + nameLength + extraLength;
    // zero-length entries would give end = start - 1, which createReadStream rejects
    if (compressedSize === 0) {
      return Readable.from([]);
    }
    const stream = createReadStream(filePath, { start, end: start + compressedSize - 1 });
    // the central directory's declared size is attacker-controlled — enforce it on actual output
    return (method === ZIP_METHOD_DEFLATE ? stream.pipe(createInflateRaw()) : stream).pipe(
      byteLimitStream(declaredSize),
    );
  } finally {
    await handle.close();
  }
};

/**
 * Iterates the entries of a zip archive via the central directory.
 * Each entry's `open()` creates an independent stream and can be called lazily.
 */
export async function* readZipArchive(filePath: string, limits: ArchiveLimits = {}): AsyncGenerator<ArchiveFile> {
  const maxEntries = limits.maxEntries ?? ARCHIVE_MAX_ENTRIES;
  const maxTotalBytes = limits.maxTotalBytes ?? ARCHIVE_MAX_TOTAL_BYTES;

  const handle = await open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const { entryCount, offset } = await findEndOfCentralDirectory(handle, fileSize);

    let position = offset;
    let entries = 0;
    let totalBytes = 0;

    for (let index = 0; index < entryCount; index++) {
      const header = await readAt(handle, position, ZIP_CENTRAL_HEADER_SIZE);
      if (header.readUInt32LE(0) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
        throw new ArchiveError('Invalid zip central directory header');
      }

      const flags = header.readUInt16LE(8);
      const method = header.readUInt16LE(10);
      const dosTime = header.readUInt16LE(12);
      const dosDate = header.readUInt16LE(14);
      const nameLength = header.readUInt16LE(28);
      const extraLength = header.readUInt16LE(30);
      const commentLength = header.readUInt16LE(32);

      const nameBuffer = await readAt(handle, position + ZIP_CENTRAL_HEADER_SIZE, nameLength);
      const name = nameBuffer.toString('utf8');
      const extra =
        extraLength > 0 ? await readAt(handle, position + ZIP_CENTRAL_HEADER_SIZE + nameLength, extraLength) : null;
      position += ZIP_CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

      const fields = parseZip64Extra(extra ?? Buffer.alloc(0), {
        compressedSize: header.readUInt32LE(20),
        size: header.readUInt32LE(24),
        localHeaderOffset: header.readUInt32LE(42),
      });

      entries++;
      if (entries > maxEntries) {
        throw new ArchiveLimitError(`Archive contains more than ${maxEntries} files`);
      }
      totalBytes += fields.size;
      if (totalBytes > maxTotalBytes) {
        throw new ArchiveLimitError(`Archive exceeds the maximum extracted size of ${maxTotalBytes} bytes`);
      }

      const path = sanitizeEntryPath(name);
      if (path === null) {
        continue;
      }

      if (flags & 0x01) {
        throw new ArchiveError(`Encrypted zip entry is not supported: ${path}`);
      }
      if (method !== ZIP_METHOD_STORED && method !== ZIP_METHOD_DEFLATE) {
        throw new ArchiveError(`Unsupported zip compression method ${method} for entry: ${path}`);
      }

      const date = dosDate ? dosToDate(dosDate, dosTime) : undefined;
      const mtime = date && !Number.isNaN(date.getTime()) ? date : undefined;
      const { compressedSize, localHeaderOffset } = fields;

      yield {
        path,
        size: fields.size,
        mtime,
        open: () => openZipEntry(filePath, localHeaderOffset, compressedSize, fields.size, method),
      };
    }
  } finally {
    await handle.close();
  }
}
