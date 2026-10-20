import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { createGunzip } from 'node:zlib';
import {
  ArchiveError,
  ArchiveFormat,
  ArchiveLimitError,
  UnsafeArchivePathError,
  detectArchiveFormat,
  readArchive,
  readTarArchive,
  readZipArchive,
  sanitizeEntryPath,
} from 'src/utils/archive.js';

const TAR_BLOCK = 512;

const tarHeader = (name: string, size: number, options?: { type?: string; mtime?: number; prefix?: string }) => {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  header.write((options?.mtime ?? 0).toString(8).padStart(11, '0') + '\0', 136);
  header.fill(32, 148, 156); // checksum is calculated with spaces
  header.write(options?.type ?? '0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  if (options?.prefix) {
    header.write(options.prefix, 345, 'utf8');
  }

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
};

const tarEntry = (name: string, data: Buffer, options?: Parameters<typeof tarHeader>[2]) =>
  Buffer.concat([
    tarHeader(name, data.length, options),
    data,
    Buffer.alloc((TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK),
  ]);

const tarEnd = Buffer.alloc(TAR_BLOCK * 2);

type ZipEntry = { name: string; data: Buffer; method?: number; declaredSize?: number; flags?: number };

const buildZip = (entries: ZipEntry[]) => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data, method = 8, declaredSize, flags = 0 } of entries) {
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const declared = declaredSize ?? data.length;
    const nameBuffer = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDirectory, eocd]);
};

const streamToBuffer = async (stream: Readable | Promise<Readable>) => {
  const chunks: Buffer[] = [];
  for await (const chunk of await stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

describe('archive utils', () => {
  describe('detectArchiveFormat', () => {
    it('should detect zip archives', () => {
      expect(detectArchiveFormat(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(600)]))).toBe(
        ArchiveFormat.Zip,
      );
    });

    it('should detect gzip archives', () => {
      expect(detectArchiveFormat(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(600)]))).toBe(
        ArchiveFormat.TarGz,
      );
    });

    it('should detect tar archives', () => {
      const header = tarHeader('file.txt', 0);
      expect(detectArchiveFormat(header)).toBe(ArchiveFormat.Tar);
    });

    it('should return null for unknown formats', () => {
      expect(detectArchiveFormat(Buffer.alloc(600))).toBeNull();
    });
  });

  describe('sanitizeEntryPath', () => {
    it('should normalize paths', () => {
      expect(sanitizeEntryPath('Takeout/Google Photos/IMG.jpg')).toBe('Takeout/Google Photos/IMG.jpg');
      expect(sanitizeEntryPath('a\\b\\c.jpg')).toBe('a/b/c.jpg');
      expect(sanitizeEntryPath('./a/./b.jpg')).toBe('a/b.jpg');
    });

    it('should return null for directory entries', () => {
      expect(sanitizeEntryPath('Takeout/')).toBeNull();
      expect(sanitizeEntryPath('')).toBeNull();
    });

    it('should reject path traversal', () => {
      expect(() => sanitizeEntryPath('../evil.txt')).toThrow(UnsafeArchivePathError);
      expect(() => sanitizeEntryPath('a/../../evil.txt')).toThrow(UnsafeArchivePathError);
      expect(() => sanitizeEntryPath('a\\..\\evil.txt')).toThrow(UnsafeArchivePathError);
    });

    it('should reject absolute paths and drive letters', () => {
      expect(() => sanitizeEntryPath('/etc/passwd')).toThrow(UnsafeArchivePathError);
      expect(() => sanitizeEntryPath('C:/Windows/evil.exe')).toThrow(UnsafeArchivePathError);
      expect(() => sanitizeEntryPath('c:\\evil.exe')).toThrow(UnsafeArchivePathError);
    });
  });

  describe('readTarArchive', () => {
    it('should yield file entries in order', async () => {
      const tar = Buffer.concat([
        tarEntry('a/one.txt', Buffer.from('first')),
        tarEntry('a/two.txt', Buffer.from('second')),
        tarEnd,
      ]);

      const entries = [];
      for await (const entry of readTarArchive(Readable.from(tar))) {
        entries.push({ path: entry.path, data: await streamToBuffer(entry.open()) });
      }

      expect(entries).toEqual([
        { path: 'a/one.txt', data: Buffer.from('first') },
        { path: 'a/two.txt', data: Buffer.from('second') },
      ]);
    });

    it('should skip directory entries', async () => {
      const tar = Buffer.concat([
        tarEntry('folder/', 0, { type: '5' }),
        tarEntry('folder/file.txt', Buffer.from('x')),
        tarEnd,
      ]);

      const paths: string[] = [];
      for await (const entry of readTarArchive(Readable.from(tar))) {
        paths.push(entry.path);
        await streamToBuffer(entry.open());
      }

      expect(paths).toEqual(['folder/file.txt']);
    });

    it('should apply the ustar prefix to names', async () => {
      const tar = Buffer.concat([tarEntry('file.txt', Buffer.from('x'), { prefix: 'long/prefix' }), tarEnd]);

      for await (const entry of readTarArchive(Readable.from(tar))) {
        expect(entry.path).toBe('long/prefix/file.txt');
      }
    });

    it('should apply GNU long names', async () => {
      const longName = `${'a'.repeat(120)}/file.txt`;
      const nameBlock = Buffer.from(longName + '\0');
      const tar = Buffer.concat([
        tarHeader('././@LongLink', nameBlock.length, { type: 'L' }),
        nameBlock,
        Buffer.alloc((TAR_BLOCK - (nameBlock.length % TAR_BLOCK)) % TAR_BLOCK),
        tarEntry('ignored', Buffer.from('data')),
        tarEnd,
      ]);

      for await (const entry of readTarArchive(Readable.from(tar))) {
        expect(entry.path).toBe(longName);
        expect((await streamToBuffer(entry.open())).toString()).toBe('data');
      }
    });

    it('should expose entry mtimes', async () => {
      const mtime = 1_600_000_000;
      const tar = Buffer.concat([tarEntry('file.txt', Buffer.from('x'), { mtime }), tarEnd]);

      for await (const entry of readTarArchive(Readable.from(tar))) {
        expect(entry.mtime).toEqual(new Date(mtime * 1000));
      }
    });

    it('should read gzip compressed tar streams', async () => {
      const tar = Buffer.concat([tarEntry('file.txt', Buffer.from('content')), tarEnd]);
      const stream = Readable.from(gzipSync(tar)).pipe(createGunzip());

      for await (const entry of readTarArchive(stream)) {
        expect((await streamToBuffer(entry.open())).toString()).toBe('content');
      }
    });

    it('should drain unread entries before the next header', async () => {
      const tar = Buffer.concat([
        tarEntry('skipped.txt', Buffer.from('a'.repeat(1024))),
        tarEntry('kept.txt', Buffer.from('kept')),
        tarEnd,
      ]);

      const paths: string[] = [];
      for await (const entry of readTarArchive(Readable.from(tar))) {
        paths.push(entry.path);
        // deliberately not reading the first entry stream
      }

      expect(paths).toEqual(['skipped.txt', 'kept.txt']);
    });

    it('should reject unsafe paths', async () => {
      const tar = Buffer.concat([tarEntry('../evil.txt', Buffer.from('x')), tarEnd]);

      await expect(async () => {
        for await (const _entry of readTarArchive(Readable.from(tar))) {
          // no-op
        }
      }).rejects.toThrow(UnsafeArchivePathError);
    });

    it('should reject corrupted headers', async () => {
      const bad = tarHeader('file.txt', 0);
      bad[100] = 0xff; // corrupt the header after the checksum was calculated
      const tar = Buffer.concat([bad, tarEnd]);

      await expect(async () => {
        for await (const _entry of readTarArchive(Readable.from(tar))) {
          // no-op
        }
      }).rejects.toThrow('Invalid tar header checksum');
    });

    it('should reject truncated archives', async () => {
      const tar = tarHeader('file.txt', 10).subarray(0, 300);

      await expect(async () => {
        for await (const _entry of readTarArchive(Readable.from(tar))) {
          // no-op
        }
      }).rejects.toThrow('Truncated tar header');
    });

    it('should reject oversized GNU longname blocks', async () => {
      const tar = Buffer.concat([tarHeader('././@LongLink', 2 * 1024 * 1024, { type: 'L' }), tarEnd]);

      await expect(async () => {
        for await (const _entry of readTarArchive(Readable.from(tar))) {
          // no-op
        }
      }).rejects.toThrow('Oversized tar longname entry');
    });

    it('should reject oversized PAX headers', async () => {
      const tar = Buffer.concat([tarHeader('PaxHeader', 2 * 1024 * 1024, { type: 'x' }), tarEnd]);

      await expect(async () => {
        for await (const _entry of readTarArchive(Readable.from(tar))) {
          // no-op
        }
      }).rejects.toThrow('Oversized tar PAX header');
    });

    it('should skip unknown tar typeflags instead of extracting them', async () => {
      const tar = Buffer.concat([
        tarEntry('sparse.bin', Buffer.from('x'.repeat(128)), { type: 'S' }),
        tarEntry('ok.txt', Buffer.from('ok')),
        tarEnd,
      ]);

      const paths: string[] = [];
      for await (const entry of readTarArchive(Readable.from(tar))) {
        paths.push(entry.path);
        await streamToBuffer(entry.open());
      }

      expect(paths).toEqual(['ok.txt']);
    });

    it('should ignore absurd entry mtimes', async () => {
      const tar = Buffer.concat([tarEntry('file.txt', Buffer.from('x'), { mtime: Number.MAX_SAFE_INTEGER }), tarEnd]);

      for await (const entry of readTarArchive(Readable.from(tar))) {
        expect(entry.mtime).toBeUndefined();
      }
    });

    it('should enforce the entry count limit', async () => {
      const tar = Buffer.concat([tarEntry('a.txt', Buffer.from('a')), tarEntry('b.txt', Buffer.from('b')), tarEnd]);

      await expect(async () => {
        for await (const _entry of readTarArchive(Readable.from(tar), { maxEntries: 1 })) {
          // no-op
        }
      }).rejects.toThrow(ArchiveLimitError);
    });
  });

  describe('readZipArchive', () => {
    let directory: string;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'archive-spec-'));
    });

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    const writeZip = async (entries: ZipEntry[]) => {
      const path = join(directory, `test-${entries.length}-${Math.random().toString(36).slice(2)}.zip`);
      await writeFile(path, buildZip(entries));
      return path;
    };

    it('should yield stored and deflate entries', async () => {
      const path = await writeZip([
        { name: 'Takeout/photo.jpg', data: Buffer.from('photo-content'), method: 0 },
        { name: 'Takeout/video.mp4', data: Buffer.from('video-content'), method: 8 },
      ]);

      const entries = [];
      for await (const entry of readZipArchive(path)) {
        entries.push({ path: entry.path, size: entry.size, data: await streamToBuffer(entry.open()) });
      }

      expect(entries).toEqual([
        { path: 'Takeout/photo.jpg', size: 13, data: Buffer.from('photo-content') },
        { path: 'Takeout/video.mp4', size: 13, data: Buffer.from('video-content') },
      ]);
    });

    it('should skip directory entries', async () => {
      const path = await writeZip([
        { name: 'Takeout/', data: Buffer.alloc(0), method: 0 },
        { name: 'Takeout/a.txt', data: Buffer.from('a'), method: 0 },
      ]);

      const paths: string[] = [];
      for await (const entry of readZipArchive(path)) {
        paths.push(entry.path);
      }

      expect(paths).toEqual(['Takeout/a.txt']);
    });

    it('should reject unsafe paths', async () => {
      const path = await writeZip([{ name: '../evil.txt', data: Buffer.from('x'), method: 0 }]);

      await expect(async () => {
        for await (const _entry of readZipArchive(path)) {
          // no-op
        }
      }).rejects.toThrow(UnsafeArchivePathError);
    });

    it('should enforce the total size limit', async () => {
      const path = await writeZip([{ name: 'big.bin', data: Buffer.alloc(1024), method: 0 }]);

      await expect(async () => {
        for await (const _entry of readZipArchive(path, { maxTotalBytes: 10 })) {
          // no-op
        }
      }).rejects.toThrow(ArchiveLimitError);
    });

    it('should reject archives without an end of central directory', async () => {
      const path = join(directory, 'not-a-zip.zip');
      await writeFile(path, Buffer.from('this is not a zip file'));

      await expect(async () => {
        for await (const _entry of readZipArchive(path)) {
          // no-op
        }
      }).rejects.toThrow('End of central directory not found');
    });

    it('should read zip64 archives', async () => {
      const data = Buffer.from('zip64-content');
      const nameBuffer = Buffer.from('big.bin', 'utf8');

      const local = Buffer.alloc(30 + nameBuffer.length);
      local.writeUInt32LE(0x04_03_4b_50, 0);
      local.writeUInt16LE(45, 4); // zip64-capable version
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(0, 8); // stored
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(crc32(data), 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuffer.length, 26);
      nameBuffer.copy(local, 30);

      // central record carries 0xFFFFFFFF sentinels; real values live in the zip64 extra field
      const extra = Buffer.alloc(4 + 24);
      extra.writeUInt16LE(0x00_01, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4); // uncompressed size
      extra.writeBigUInt64LE(BigInt(data.length), 12); // compressed size
      extra.writeBigUInt64LE(BigInt(0), 20); // local header offset

      const central = Buffer.alloc(46 + nameBuffer.length + extra.length);
      central.writeUInt32LE(0x02_01_4b_50, 0);
      central.writeUInt16LE(45, 4);
      central.writeUInt16LE(45, 6);
      central.writeUInt16LE(0, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(crc32(data), 16);
      central.writeUInt32LE(0xff_ff_ff_ff, 20);
      central.writeUInt32LE(0xff_ff_ff_ff, 24);
      central.writeUInt16LE(nameBuffer.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt32LE(0xff_ff_ff_ff, 42);
      nameBuffer.copy(central, 46);
      extra.copy(central, 46 + nameBuffer.length);

      const centralEnd = local.length + data.length + central.length;
      const zip64Eocd = Buffer.alloc(56);
      zip64Eocd.writeUInt32LE(0x06_06_4b_50, 0);
      zip64Eocd.writeBigUInt64LE(44n, 8);
      zip64Eocd.writeUInt16LE(45, 12);
      zip64Eocd.writeUInt16LE(45, 14);
      zip64Eocd.writeBigUInt64LE(1n, 24); // entries on this disk
      zip64Eocd.writeBigUInt64LE(1n, 32); // total entries
      zip64Eocd.writeBigUInt64LE(BigInt(central.length), 40);
      zip64Eocd.writeBigUInt64LE(BigInt(local.length + data.length), 48); // central dir offset

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07_06_4b_50, 0);
      locator.writeBigUInt64LE(BigInt(centralEnd), 8); // zip64 EOCD offset

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06_05_4b_50, 0);
      eocd.writeUInt16LE(0xff_ff, 8);
      eocd.writeUInt16LE(0xff_ff, 10);
      eocd.writeUInt32LE(0xff_ff_ff_ff, 12);
      eocd.writeUInt32LE(0xff_ff_ff_ff, 16);

      const path = join(directory, 'zip64.zip');
      await writeFile(path, Buffer.concat([local, data, central, zip64Eocd, locator, eocd]));

      const entries = [];
      for await (const entry of readZipArchive(path)) {
        entries.push({ path: entry.path, size: entry.size, data: await streamToBuffer(entry.open()) });
      }
      expect(entries).toEqual([{ path: 'big.bin', size: data.length, data }]);
    });

    it('should reject entries that inflate beyond their declared size', async () => {
      // central directory lies: declares 5 bytes, deflate expands to much more
      const path = await writeZip([
        { name: 'bomb.bin', data: Buffer.from('x'.repeat(1024)), method: 8, declaredSize: 5 },
      ]);

      for await (const entry of readZipArchive(path)) {
        await expect(streamToBuffer(entry.open())).rejects.toThrow(ArchiveLimitError);
      }
    });

    it('should reject encrypted entries', async () => {
      const path = await writeZip([{ name: 'secret.txt', data: Buffer.from('x'), method: 0, flags: 0x01 }]);

      await expect(async () => {
        for await (const _entry of readZipArchive(path)) {
          // no-op
        }
      }).rejects.toThrow('Encrypted zip entry is not supported');
    });

    it('should reject unsupported compression methods', async () => {
      const path = await writeZip([{ name: 'bzip2.txt', data: Buffer.from('x'), method: 12 }]);

      await expect(async () => {
        for await (const _entry of readZipArchive(path)) {
          // no-op
        }
      }).rejects.toThrow('Unsupported zip compression method 12');
    });

    it('should yield an empty stream for zero-byte entries', async () => {
      const path = await writeZip([{ name: 'empty.txt', data: Buffer.alloc(0), method: 0 }]);

      for await (const entry of readZipArchive(path)) {
        expect(entry.size).toBe(0);
        expect(await streamToBuffer(entry.open())).toEqual(Buffer.alloc(0));
      }
    });
  });

  describe('readArchive', () => {
    let directory: string;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'archive-dispatch-'));
    });

    afterAll(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('should dispatch on the detected format', async () => {
      const path = join(directory, 'dispatch.tar');
      await writeFile(path, Buffer.concat([tarEntry('a.txt', Buffer.from('x')), tarEnd]));

      const paths: string[] = [];
      for await (const entry of readArchive(path, ArchiveFormat.Tar)) {
        paths.push(entry.path);
      }
      expect(paths).toEqual(['a.txt']);
    });
  });
});
