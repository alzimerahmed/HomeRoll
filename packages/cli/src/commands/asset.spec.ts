import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, MockedFunction, vi } from 'vitest';

import {
  AssetRejectReason,
  AssetUploadAction,
  AssetVisibility,
  checkBulkUpload,
  defaults,
  getSupportedMediaTypes,
} from '@immich/sdk';
import createFetchMock from 'vitest-fetch-mock';

import {
  checkForDuplicates,
  createWatchIgnored,
  deleteFiles,
  findSidecar,
  getAlbumName,
  InFlightTracker,
  startWatch,
  uploadFiles,
  UploadOptionsDto,
} from 'src/commands/asset';

vi.mock('@immich/sdk');

describe('getAlbumName', () => {
  it('should return a non-undefined value', () => {
    if (os.platform() === 'win32') {
      // This is meaningless for Unix systems.
      expect(getAlbumName(String.raw`D:\test\Filename.txt`, {} as UploadOptionsDto)).toBe('test');
    }
    expect(getAlbumName('D:/parentfolder/test/Filename.txt', {} as UploadOptionsDto)).toBe('test');
  });

  it('has higher priority to return `albumName` in `options`', () => {
    expect(getAlbumName('/parentfolder/test/Filename.txt', { albumName: 'example' } as UploadOptionsDto)).toBe(
      'example',
    );
  });
});

describe('uploadFiles', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const testFilePath = path.join(testDir, 'test.png');
  const testFileData = 'test';
  const baseUrl = 'https://example.com';
  const apiKey = 'key';
  const retry = 3;

  const fetchMocker = createFetchMock(vi);

  beforeEach(() => {
    // Create a test file
    fs.writeFileSync(testFilePath, testFileData);

    // Defaults
    vi.mocked(defaults).baseUrl = baseUrl;
    vi.mocked(defaults).headers = { 'x-api-key': apiKey };

    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
  });

  it('returns new assets when upload file is successful', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([
      {
        filepath: testFilePath,
        id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
      },
    ]);
  });

  it('returns new assets when upload file retry is successful', async () => {
    let counter = 0;
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      counter++;
      if (counter < retry) {
        throw new Error('Network error');
      }

      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([
      {
        filepath: testFilePath,
        id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
      },
    ]);
  });

  it('returns new assets when upload file retry is failed', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      throw new Error('Network error');
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([]);
  });

  it('uploads assets with the specified visibility', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), function () {
      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await uploadFiles([testFilePath], { concurrency: 1, visibility: AssetVisibility.Hidden });

    const formData = fetchMocker.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get('visibility')).toBe('hidden');
  });
});

describe('checkForDuplicates', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const testFilePath = path.join(testDir, 'test.png');
  const testFileData = 'test';
  const testFileChecksum = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // SHA1
  const retry = 3;

  beforeEach(() => {
    // Create a test file
    fs.writeFileSync(testFilePath, testFileData);
  });

  it('checks duplicates', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: testFilePath,
        },
      ],
    });

    await checkForDuplicates([testFilePath], { concurrency: 1 });

    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: [
          {
            checksum: testFileChecksum,
            id: testFilePath,
          },
        ],
      },
    });
  });

  it('returns duplicates when check duplicates is rejected', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Reject,
          id: testFilePath,
          assetId: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
          reason: AssetRejectReason.Duplicate,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [
        {
          filepath: testFilePath,
          id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
        },
      ],
      newFiles: [],
    });
  });

  it('returns new assets when check duplicates is accepted', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: testFilePath,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [testFilePath],
    });
  });

  it('returns results when check duplicates retry is successful', async () => {
    let mocked = vi.mocked(checkBulkUpload);
    for (let i = 1; i < retry; i++) {
      mocked = mocked.mockRejectedValueOnce(new Error('Network error'));
    }
    mocked.mockResolvedValue({
      results: [
        {
          action: AssetUploadAction.Accept,
          id: testFilePath,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [testFilePath],
    });
  });

  it('returns results when check duplicates retry is failed', async () => {
    vi.mocked(checkBulkUpload).mockRejectedValue(new Error('Network error'));

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [],
    });
  });
});

describe('startWatch', () => {
  let testFolder: string;
  let checkBulkUploadMocked: MockedFunction<typeof checkBulkUpload>;
  const watchers: { close: () => Promise<void> }[] = [];

  beforeEach(async () => {
    vi.restoreAllMocks();

    vi.mocked(getSupportedMediaTypes).mockResolvedValue({
      image: ['.jpg'],
      sidecar: ['.xmp'],
      video: ['.mp4'],
    });

    testFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test-startWatch-'));
    checkBulkUploadMocked = vi.mocked(checkBulkUpload);
    checkBulkUploadMocked.mockResolvedValue({
      results: [],
    });
  });

  it('should start watching a directory and upload new files', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');

    watchers.push(await startWatch([testFolder], { concurrency: 1 }, { batchSize: 1, debounceTimeMs: 10 }));
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: [
              expect.objectContaining({
                id: testFilePath,
              }),
            ],
          },
        }),
      { timeout: 5000 },
    );
  });

  it('should filter out unsupported files', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');
    const unsupportedFilePath = path.join(testFolder, 'test.txt');

    watchers.push(await startWatch([testFolder], { concurrency: 1 }, { batchSize: 1, debounceTimeMs: 10 }));
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await fs.promises.writeFile(unsupportedFilePath, 'testtxt');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: expect.arrayContaining([
              expect.objectContaining({
                id: testFilePath,
              }),
            ]),
          },
        }),
      { timeout: 5000 },
    );

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: unsupportedFilePath,
          }),
        ]),
      },
    });
  });

  it('should ignore hidden files by default', async () => {
    const visibleFilePath = path.join(testFolder, 'visible.jpg');
    const hiddenFilePath = path.join(testFolder, '.hidden.jpg');

    watchers.push(
      await startWatch(
        [testFolder],
        { concurrency: 1 },
        { batchSize: 1, debounceTimeMs: 10, awaitWriteFinish: false },
      ),
    );
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(hiddenFilePath, 'hidden');
    await fs.promises.writeFile(visibleFilePath, 'visiblejpg');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: expect.arrayContaining([
              expect.objectContaining({
                id: visibleFilePath,
              }),
            ]),
          },
        }),
      { timeout: 5000 },
    );

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: hiddenFilePath,
          }),
        ]),
      },
    });
  });

  it('should re-check a file when it changes after being processed', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');

    watchers.push(
      await startWatch(
        [testFolder],
        { concurrency: 1 },
        { batchSize: 1, debounceTimeMs: 10, awaitWriteFinish: false },
      ),
    );
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');

    await vi.waitFor(() => expect(checkBulkUploadMocked).toHaveBeenCalledTimes(1), { timeout: 5000 });

    await fs.promises.writeFile(testFilePath, 'testjpg-updated');

    await vi.waitFor(() => expect(checkBulkUploadMocked).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });

  it('should filter out ignored patterns', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');
    const ignoredPattern = 'ignored';
    const ignoredFolder = path.join(testFolder, ignoredPattern);
    await fs.promises.mkdir(ignoredFolder, { recursive: true });
    const ignoredFilePath = path.join(ignoredFolder, 'ignored.jpg');

    watchers.push(
      await startWatch(
        [testFolder],
        { concurrency: 1, ignore: ignoredPattern },
        { batchSize: 1, debounceTimeMs: 10 },
      ),
    );
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await fs.promises.writeFile(ignoredFilePath, 'ignoredjpg');

    await vi.waitFor(
      () =>
        expect(checkBulkUpload).toHaveBeenCalledWith({
          assetBulkUploadCheckDto: {
            assets: expect.arrayContaining([
              expect.objectContaining({
                id: testFilePath,
              }),
            ]),
          },
        }),
      { timeout: 5000 },
    );

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: ignoredFilePath,
          }),
        ]),
      },
    });
  });

  it('should upload buffered files when closed', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');

    const watcher = await startWatch(
      [testFolder],
      { concurrency: 1 },
      { batchSize: 10, debounceTimeMs: 60_000, awaitWriteFinish: false },
    );
    watchers.push(watcher);
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await sleep(200); // let the watch event arrive and be buffered without dispatching
    await watcher.close();

    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: [
          expect.objectContaining({
            id: testFilePath,
          }),
        ],
      },
    });
  });

  afterEach(async () => {
    await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
    await fs.promises.rm(testFolder, { recursive: true, force: true });
  });
});

describe('createWatchIgnored', () => {
  const isIgnored = (filepath: string, options: UploadOptionsDto) =>
    createWatchIgnored(options).some((matcher) => typeof matcher === 'function' && matcher(filepath));

  it('should ignore hidden files and folders by default', () => {
    expect(isIgnored('/photos/.hidden.jpg', {} as UploadOptionsDto)).toBe(true);
    expect(isIgnored('/photos/.config/photo.jpg', {} as UploadOptionsDto)).toBe(true);
    expect(isIgnored('/photos/photo.jpg', {} as UploadOptionsDto)).toBe(false);
  });

  it('should include hidden files when includeHidden is set', () => {
    const options = { includeHidden: true } as UploadOptionsDto;
    expect(isIgnored('/photos/.hidden.jpg', options)).toBe(false);
    expect(isIgnored('/photos/.config/photo.jpg', options)).toBe(false);
  });

  it('should ignore partial-download files', () => {
    const options = {} as UploadOptionsDto;
    expect(isIgnored('/photos/photo.jpg.tmp', options)).toBe(true);
    expect(isIgnored('/photos/photo.jpg.crdownload', options)).toBe(true);
    expect(isIgnored('/photos/photo.jpg.part', options)).toBe(true);
    expect(isIgnored('/photos/photo.jpg.partial', options)).toBe(true);
    expect(isIgnored('/photos/photo.jpg', options)).toBe(false);
  });

  it('should ignore the user-provided pattern', () => {
    const options = { ignore: 'raw' } as UploadOptionsDto;
    expect(isIgnored('/photos/raw/photo.jpg', options)).toBe(true);
    expect(isIgnored('/photos/photo.jpg', options)).toBe(false);
  });
});

describe('InFlightTracker', () => {
  it('should queue a path that is not in flight', () => {
    const tracker = new InFlightTracker();
    expect(tracker.tryQueue('/photos/a.jpg')).toBe(true);
  });

  it('should not re-queue unchanged paths on finish', () => {
    const tracker = new InFlightTracker();
    tracker.start(['/photos/a.jpg', '/photos/b.jpg']);
    expect(tracker.finish(['/photos/a.jpg', '/photos/b.jpg'])).toEqual([]);
  });

  it('should defer a change on an in-flight path and re-queue it on finish', () => {
    const tracker = new InFlightTracker();
    tracker.start(['/photos/a.jpg']);

    expect(tracker.tryQueue('/photos/a.jpg')).toBe(false);
    expect(tracker.tryQueue('/photos/b.jpg')).toBe(true);

    expect(tracker.finish(['/photos/a.jpg'])).toEqual(['/photos/a.jpg']);
    // a subsequent finish without new changes re-queues nothing
    expect(tracker.finish(['/photos/a.jpg'])).toEqual([]);
  });

  it('should re-queue a dirty path only once even if it changed multiple times', () => {
    const tracker = new InFlightTracker();
    tracker.start(['/photos/a.jpg']);

    expect(tracker.tryQueue('/photos/a.jpg')).toBe(false);
    expect(tracker.tryQueue('/photos/a.jpg')).toBe(false);

    expect(tracker.finish(['/photos/a.jpg'])).toEqual(['/photos/a.jpg']);
  });
});

describe('findSidecar', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sidecar-'));
    testFilePath = path.join(testDir, 'test.jpg');
    fs.writeFileSync(testFilePath, 'test');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should find sidecar file with photo.xmp naming convention', () => {
    const sidecarPath = path.join(testDir, 'test.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    const result = findSidecar(testFilePath);
    expect(result).toBe(sidecarPath);
  });

  it('should find sidecar file with photo.ext.xmp naming convention', () => {
    const sidecarPath = path.join(testDir, 'test.jpg.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    const result = findSidecar(testFilePath);
    expect(result).toBe(sidecarPath);
  });

  it('should prefer photo.ext.xmp over photo.xmp when both exist', () => {
    const sidecarPath1 = path.join(testDir, 'test.xmp');
    const sidecarPath2 = path.join(testDir, 'test.jpg.xmp');
    fs.writeFileSync(sidecarPath1, 'xmp data 1');
    fs.writeFileSync(sidecarPath2, 'xmp data 2');

    const result = findSidecar(testFilePath);
    expect(result).toBe(sidecarPath2);
  });

  it('should return undefined when no sidecar file exists', () => {
    const result = findSidecar(testFilePath);
    expect(result).toBeUndefined();
  });
});

describe('deleteFiles', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-delete-'));
    testFilePath = path.join(testDir, 'test.jpg');
    fs.writeFileSync(testFilePath, 'test');
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should delete asset and sidecar file when main file is deleted', async () => {
    const sidecarPath = path.join(testDir, 'test.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    await deleteFiles([{ id: 'test-id', filepath: testFilePath }], [], { delete: true, concurrency: 1 });

    expect(fs.existsSync(testFilePath)).toBe(false);
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it('should not delete sidecar file when delete option is false', async () => {
    const sidecarPath = path.join(testDir, 'test.xmp');
    fs.writeFileSync(sidecarPath, 'xmp data');

    await deleteFiles([{ id: 'test-id', filepath: testFilePath }], [], { delete: false, concurrency: 1 });

    expect(fs.existsSync(testFilePath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
  });
});
