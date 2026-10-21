import {
  AssetBulkUploadCheckItem,
  AssetBulkUploadCheckResult,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  Permission,
  addAssetsToAlbum,
  checkBulkUpload,
  createAlbum,
  defaults,
  getAllAlbums,
  getSupportedMediaTypes,
} from '@immich/sdk';
import byteSize from 'byte-size';
import { ChokidarOptions, Matcher, watch as watchFs } from 'chokidar';
import { MultiBar, Presets, SingleBar } from 'cli-progress';
import { chunk } from 'lodash-es';
import micromatch from 'micromatch';
import { Stats, createReadStream, existsSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path, { basename } from 'node:path';
import { Queue } from 'src/queue.js';
import { BaseOptions, Batcher, authenticate, crawl, requirePermissions, s, sha1 } from 'src/utils.js';

const UPLOAD_WATCH_BATCH_SIZE = 100;
const UPLOAD_WATCH_DEBOUNCE_TIME_MS = 10_000;
const UPLOAD_WATCH_AWAIT_WRITE_FINISH: ChokidarOptions['awaitWriteFinish'] = { stabilityThreshold: 2000 };
// Matches any path segment starting with a dot (hidden files and folders).
const HIDDEN_PATH_PATTERN = /(^|[\\/])\.[^\\/]+/;
// Partial-download extensions written by browsers and sync tools; never finished media.
const PARTIAL_DOWNLOAD_EXTENSIONS = new Set(['.tmp', '.crdownload', '.part', '.partial']);

// TODO figure out why `id` is missing
type AssetBulkUploadCheckResults = Array<AssetBulkUploadCheckResult & { id: string }>;
type Asset = { id: string; filepath: string; status?: AssetMediaStatus };

export interface UploadOptionsDto {
  recursive?: boolean;
  ignore?: string;
  dryRun?: boolean;
  skipHash?: boolean;
  delete?: boolean;
  deleteDuplicates?: boolean;
  album?: boolean;
  albumName?: string;
  visibility?: AssetVisibility;
  includeHidden?: boolean;
  concurrency: number;
  progress?: boolean;
  watch?: boolean;
  jsonOutput?: boolean;
}

class UploadFile extends File {
  constructor(
    private filepath: string,
    private _size: number,
  ) {
    super([], basename(filepath));
  }

  // @ts-expect-error size is already a property on the new File interface
  get size() {
    return this._size;
  }

  stream() {
    return createReadStream(this.filepath) as any;
  }
}

const uploadBatch = async (files: string[], options: UploadOptionsDto) => {
  const { newFiles, duplicates } = await checkForDuplicates(files, options);
  const newAssets = await uploadFiles(newFiles, options);
  if (options.jsonOutput) {
    console.log(JSON.stringify({ newFiles, duplicates, newAssets }, undefined, 4));
  }
  await updateAlbums([...newAssets, ...duplicates], options);

  await deleteFiles(newAssets, duplicates, options);

  return { newFiles, duplicates, newAssets };
};

/**
 * Tracks paths currently being uploaded so a watch event for a file that is
 * mid-upload does not queue a second, concurrent upload of the same file.
 * Such events are marked dirty instead and re-queued once the upload finishes.
 */
export class InFlightTracker {
  private readonly inFlight = new Set<string>();
  private readonly dirty = new Set<string>();

  /**
   * Whether the path may be queued for upload right now. Returns false and
   * marks the path dirty when it is already in flight, so the change is not lost.
   */
  tryQueue(filepath: string): boolean {
    if (this.inFlight.has(filepath)) {
      this.dirty.add(filepath);
      return false;
    }
    return true;
  }

  start(filepaths: string[]): void {
    for (const filepath of filepaths) {
      this.inFlight.add(filepath);
    }
  }

  /**
   * Clears paths from the in-flight set and returns the ones that changed
   * while they were uploading, so the caller can re-queue them.
   */
  finish(filepaths: string[]): string[] {
    const requeue: string[] = [];
    for (const filepath of filepaths) {
      this.inFlight.delete(filepath);
      if (this.dirty.delete(filepath)) {
        requeue.push(filepath);
      }
    }
    return requeue;
  }
}

/**
 * Builds the chokidar `ignored` matchers for watch mode:
 * - the user-provided `--ignore` pattern
 * - hidden files and folders (unless `--include-hidden`), matching the initial scan
 * - partial-download files still being written by browsers or sync tools
 */
export const createWatchIgnored = (options: UploadOptionsDto): Matcher[] => {
  const ignored: Matcher[] = [];

  if (options.ignore) {
    ignored.push((filepath) => micromatch.contains(filepath, `**/${options.ignore}`));
  }

  if (!options.includeHidden) {
    ignored.push((filepath) => HIDDEN_PATH_PATTERN.test(filepath));
  }

  ignored.push((filepath) => PARTIAL_DOWNLOAD_EXTENSIONS.has(path.extname(filepath).toLowerCase()));

  return ignored;
};

export const startWatch = async (
  paths: string[],
  options: UploadOptionsDto,
  {
    batchSize = UPLOAD_WATCH_BATCH_SIZE,
    debounceTimeMs = UPLOAD_WATCH_DEBOUNCE_TIME_MS,
    awaitWriteFinish = UPLOAD_WATCH_AWAIT_WRITE_FINISH,
  }: {
    batchSize?: number;
    debounceTimeMs?: number;
    awaitWriteFinish?: ChokidarOptions['awaitWriteFinish'];
  } = {},
) => {
  const { image, video } = await getSupportedMediaTypes();
  const extensions = new Set([...image, ...video]);
  const inFlight = new InFlightTracker();
  const pendingUploads = new Set<Promise<unknown>>();
  let uploadedCount = 0;
  let duplicateCount = 0;

  const uploadWatchedPaths = async (filepaths: string[]) => {
    // files deleted between the watch event and the batch dispatch are skipped,
    // so a short-lived file cannot fail the whole batch
    const existing = filepaths.filter((filepath) => existsSync(filepath));
    inFlight.start(existing);
    try {
      const { newAssets, duplicates } = await uploadBatch(existing, options);
      const uploaded = newAssets.filter((asset) => asset.status !== AssetMediaStatus.Duplicate);
      uploadedCount += uploaded.length;
      duplicateCount += newAssets.length - uploaded.length + duplicates.length;

      if (!options.jsonOutput) {
        for (const { filepath } of uploaded) {
          console.log(`Uploaded: ${filepath}`);
        }
        for (const { filepath } of duplicates) {
          console.log(`Skipped duplicate: ${filepath}`);
        }
        console.log(`Total: ${uploadedCount} uploaded, ${duplicateCount} duplicate${s(duplicateCount)}`);
      }
    } finally {
      for (const filepath of inFlight.finish(existing)) {
        queueFile(filepath);
      }
    }
  };

  const pathsBatcher = new Batcher<string>({
    batchSize,
    debounceTimeMs,
    onBatch: (paths: string[]) => {
      const task = uploadWatchedPaths([...new Set(paths)]);
      pendingUploads.add(task);
      void task
        .catch((error) => console.error(`Watch upload failed: ${error}`))
        .finally(() => pendingUploads.delete(task));
      return task;
    },
  });

  const queueFile = (filepath: string) => {
    if (inFlight.tryQueue(filepath)) {
      pathsBatcher.add(filepath);
    }
  };

  const onFile = async (filepath: string, stats?: Stats) => {
    if (stats?.isDirectory()) {
      return;
    }
    const extension = path.extname(filepath).toLowerCase();
    if (!extensions.has(extension)) {
      return;
    }

    if (!options.progress) {
      // logging when progress is disabled as it can cause issues with the progress bar rendering
      console.log(`Change detected: ${filepath}`);
    }
    queueFile(filepath);
  };

  const fsWatcher = watchFs(paths, {
    ignoreInitial: true,
    ignored: createWatchIgnored(options),
    alwaysStat: true,
    awaitWriteFinish,
    depth: options.recursive ? undefined : 1,
    followSymlinks: false,
    persistent: true,
  })
    .on('add', onFile)
    .on('change', onFile)
    .on('error', (error) => console.error(`Watcher error: ${error}`));

  return {
    /**
     * Stops watching and drains the queue: pending paths are flushed and all
     * in-flight uploads are awaited. A path re-queued by finishing uploads
     * (changed while in flight) is processed too, looping until idle.
     */
    close: async () => {
      await fsWatcher.close();
      while (pathsBatcher.size > 0 || pendingUploads.size > 0) {
        pathsBatcher.flush();
        await Promise.allSettled(pendingUploads);
      }
    },
  };
};

export const upload = async (paths: string[], baseOptions: BaseOptions, options: UploadOptionsDto) => {
  await authenticate(baseOptions);
  await requirePermissions([Permission.AssetUpload]);

  if (options.watch && paths.length === 0) {
    console.log('The --watch option requires at least one path to watch');
    process.exit(1);
  }

  const scanFiles = await scan(paths, options);

  if (scanFiles.length === 0) {
    if (options.watch) {
      console.log('No files found initially.');
    } else {
      console.log('No files found, exiting');
      return;
    }
  }

  if (options.watch) {
    console.log('Watching for changes...');
    const watcher = await startWatch(paths, options);
    // watcher does not handle the initial scan
    // as the scan() is a more efficient quick start with batched results

    let isShuttingDown = false;
    const initialUpload: Promise<unknown> = uploadBatch(scanFiles, options);
    const shutdown = async () => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;
      console.log('Shutting down, waiting for in-flight uploads to finish...');
      await Promise.allSettled([watcher.close(), initialUpload]);
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    await initialUpload;
    return;
  }

  await uploadBatch(scanFiles, options);
};

const scan = async (pathsToCrawl: string[], options: UploadOptionsDto) => {
  const { image, video } = await getSupportedMediaTypes();

  console.log('Crawling for assets...');
  const files = await crawl({
    pathsToCrawl,
    recursive: options.recursive,
    exclusionPattern: options.ignore,
    includeHidden: options.includeHidden,
    extensions: [...image, ...video],
  });

  return files;
};

export const checkForDuplicates = async (files: string[], { concurrency, skipHash, progress }: UploadOptionsDto) => {
  if (skipHash) {
    console.log('Skipping hash check, assuming all files are new');
    return { newFiles: files, duplicates: [] };
  }

  let multiBar: MultiBar | undefined;
  let totalSize = 0;
  const statsMap = new Map<string, Stats>();

  // Calculate total size first
  for (const filepath of files) {
    const stats = await stat(filepath);
    statsMap.set(filepath, stats);
    totalSize += stats.size;
  }

  if (progress) {
    multiBar = new MultiBar(
      {
        format: '{message} | {bar} | {percentage}% | ETA: {eta_formatted} | {value}/{total}',
        formatValue: (v: number, options, type) => {
          // Don't format percentage
          return type === 'percentage' ? v.toString() : byteSize(v).toString();
        },
        etaBuffer: 100, // Increase samples for ETA calculation
      },
      Presets.shades_classic,
    );

    // Ensure we restore cursor on interrupt
    process.on('SIGINT', () => {
      if (multiBar) {
        multiBar.stop();
      }
      process.exit(0);
    });
  } else {
    console.log(`Received ${files.length} files (${byteSize(totalSize)}), hashing...`);
  }

  const hashProgressBar = multiBar?.create(totalSize, 0, {
    message: 'Hashing files          ',
  });
  const checkProgressBar = multiBar?.create(totalSize, 0, {
    message: 'Checking for duplicates',
  });

  const newFiles: string[] = [];
  const duplicates: Asset[] = [];

  const checkBulkUploadQueue = new Queue<AssetBulkUploadCheckItem[], void>(
    async (assets: AssetBulkUploadCheckItem[]) => {
      const response = await checkBulkUpload({ assetBulkUploadCheckDto: { assets } });

      const results = response.results as AssetBulkUploadCheckResults;

      for (const { id: filepath, assetId, action } of results) {
        if (action === AssetUploadAction.Accept) {
          newFiles.push(filepath);
        } else {
          // rejects are always duplicates
          duplicates.push({ id: assetId as string, filepath });
        }
      }

      // Update progress based on total size of processed files
      let processedSize = 0;
      for (const asset of assets) {
        const stats = statsMap.get(asset.id);
        processedSize += stats?.size || 0;
      }
      checkProgressBar?.increment(processedSize);
    },
    { concurrency, retry: 3 },
  );

  const results: { id: string; checksum: string }[] = [];
  let checkBulkUploadRequests: AssetBulkUploadCheckItem[] = [];

  const queue = new Queue<string, AssetBulkUploadCheckItem[]>(
    async (filepath: string): Promise<AssetBulkUploadCheckItem[]> => {
      const stats = statsMap.get(filepath);
      if (!stats) {
        throw new Error(`Stats not found for ${filepath}`);
      }
      const dto = { id: filepath, checksum: await sha1(filepath) };

      results.push(dto);
      checkBulkUploadRequests.push(dto);
      if (checkBulkUploadRequests.length === 5000) {
        const batch = checkBulkUploadRequests;
        checkBulkUploadRequests = [];
        void checkBulkUploadQueue.push(batch);
      }

      hashProgressBar?.increment(stats.size);
      return results;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  if (checkBulkUploadRequests.length > 0) {
    void checkBulkUploadQueue.push(checkBulkUploadRequests);
  }

  await checkBulkUploadQueue.drained();

  multiBar?.stop();

  console.log(`Found ${newFiles.length} new files and ${duplicates.length} duplicate${s(duplicates.length)}`);

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to verify ${failedTasks.length} file${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return { newFiles, duplicates };
};

export const uploadFiles = async (files: string[], options: UploadOptionsDto): Promise<Asset[]> => {
  const { dryRun, concurrency, progress } = options;
  if (files.length === 0) {
    console.log('All assets were already uploaded, nothing to do.');
    return [];
  }

  // Compute total size first
  let totalSize = 0;
  const statsMap = new Map<string, Stats>();
  for (const filepath of files) {
    const stats = await stat(filepath);
    statsMap.set(filepath, stats);
    totalSize += stats.size;
  }

  if (dryRun) {
    console.log(`Would have uploaded ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
    return files.map((filepath) => ({ id: '', filepath }));
  }

  let uploadProgress: SingleBar | undefined;

  if (progress) {
    uploadProgress = new SingleBar(
      {
        format: 'Uploading assets | {bar} | {percentage}% | ETA: {eta_formatted} | {value_formatted}/{total_formatted}',
      },
      Presets.shades_classic,
    );
  } else {
    console.log(`Uploading ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
  }
  uploadProgress?.start(totalSize, 0);
  uploadProgress?.update({ value_formatted: 0, total_formatted: byteSize(totalSize) });

  let duplicateCount = 0;
  let duplicateSize = 0;
  let successCount = 0;
  let successSize = 0;

  const newAssets: Asset[] = [];

  const queue = new Queue<string, AssetMediaResponseDto>(
    async (filepath: string) => {
      const stats = statsMap.get(filepath);
      if (!stats) {
        throw new Error(`Stats not found for ${filepath}`);
      }

      const response = await uploadFile(filepath, stats, options);
      newAssets.push({ id: response.id, filepath, status: response.status });
      if (response.status === AssetMediaStatus.Duplicate) {
        duplicateCount++;
        duplicateSize += stats.size ?? 0;
      } else {
        successCount++;
        successSize += stats.size ?? 0;
      }

      uploadProgress?.update(successSize, { value_formatted: byteSize(successSize + duplicateSize) });

      return response;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  uploadProgress?.stop();

  console.log(`Successfully uploaded ${successCount} new asset${s(successCount)} (${byteSize(successSize)})`);
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate asset${s(duplicateCount)} (${byteSize(duplicateSize)})`);
  }

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to upload ${failedTasks.length} asset${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return newAssets;
};

const uploadFile = async (
  input: string,
  stats: Stats,
  { visibility }: UploadOptionsDto,
): Promise<AssetMediaResponseDto> => {
  const { baseUrl, headers } = defaults;

  const formData = new FormData();
  formData.append('fileCreatedAt', stats.mtime.toISOString());
  formData.append('fileModifiedAt', stats.mtime.toISOString());
  formData.append('fileSize', String(stats.size));
  formData.append('isFavorite', 'false');
  formData.append('assetData', new UploadFile(input, stats.size));
  if (visibility) {
    formData.append('visibility', visibility);
  }

  const sidecarPath = findSidecar(input);
  if (sidecarPath) {
    try {
      const stats = await stat(sidecarPath);
      const sidecarData = new UploadFile(sidecarPath, stats.size);
      formData.append('sidecarData', sidecarData);
    } catch {
      // noop
    }
  }

  const response = await fetch(`${baseUrl}/assets`, {
    method: 'post',
    redirect: 'error',
    headers: headers as Record<string, string>,
    body: formData,
    // eslint-disable-next-line unicorn/no-null
    window: null,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<AssetMediaResponseDto>;
};

export const findSidecar = (filepath: string): string | undefined => {
  const assetPath = path.parse(filepath);
  const noExtension = path.join(assetPath.dir, assetPath.name);

  // Prefer photo.ext.xmp over photo.xmp, matching the server's sidecar precedence.
  for (const sidecarPath of [`${filepath}.xmp`, `${noExtension}.xmp`]) {
    if (existsSync(sidecarPath)) {
      return sidecarPath;
    }
  }
};

export const deleteFiles = async (uploaded: Asset[], duplicates: Asset[], options: UploadOptionsDto): Promise<void> => {
  let fileCount = 0;
  if (options.delete) {
    fileCount += uploaded.length;
  }

  if (options.deleteDuplicates) {
    fileCount += duplicates.length;
  }

  if (options.dryRun) {
    console.log(`Would have deleted ${fileCount} local asset${s(fileCount)}`);
    return;
  }

  if (fileCount === 0) {
    return;
  }

  console.log('Deleting assets that have been uploaded...');
  const deletionProgress = new SingleBar(
    { format: 'Deleting local assets | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  deletionProgress.start(fileCount, 0);

  const chunkDelete = async (files: Asset[]) => {
    for (const assetBatch of chunk(files, options.concurrency)) {
      await Promise.all(
        assetBatch.map(async (input: Asset) => {
          await unlink(input.filepath);
          const sidecarPath = findSidecar(input.filepath);
          if (sidecarPath) {
            await unlink(sidecarPath);
          }
        }),
      );
      deletionProgress.update(assetBatch.length);
    }
  };

  try {
    if (options.delete) {
      await chunkDelete(uploaded);
    }

    if (options.deleteDuplicates) {
      await chunkDelete(duplicates);
    }
  } finally {
    deletionProgress.stop();
  }
};

const updateAlbums = async (assets: Asset[], options: UploadOptionsDto) => {
  if (!options.album && !options.albumName) {
    return;
  }
  const { dryRun, concurrency } = options;

  const albums = await getAllAlbums({});
  const existingAlbums = new Map(albums.map((album) => [album.albumName, album.id]));
  const newAlbums: Set<string> = new Set();
  for (const { filepath } of assets) {
    const albumName = getAlbumName(filepath, options);
    if (albumName && !existingAlbums.has(albumName)) {
      newAlbums.add(albumName);
    }
  }

  if (dryRun) {
    // TODO print asset counts for new albums
    console.log(`Would have created ${newAlbums.size} new album${s(newAlbums.size)}`);
    console.log(`Would have updated albums of ${assets.length} asset${s(assets.length)}`);
    return;
  }

  const progressBar = new SingleBar(
    { format: 'Creating albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} albums' },
    Presets.shades_classic,
  );
  progressBar.start(newAlbums.size, 0);

  try {
    for (const albumNames of chunk([...newAlbums], concurrency)) {
      const items = await Promise.all(
        albumNames.map((albumName: string) => createAlbum({ createAlbumDto: { albumName } })),
      );
      for (const { id, albumName } of items) {
        existingAlbums.set(albumName, id);
      }
      progressBar.increment(albumNames.length);
    }
  } finally {
    progressBar.stop();
  }

  console.log(`Successfully created ${newAlbums.size} new album${s(newAlbums.size)}`);
  console.log(`Successfully updated ${assets.length} asset${s(assets.length)}`);

  const albumToAssets = new Map<string, string[]>();
  for (const asset of assets) {
    const albumName = getAlbumName(asset.filepath, options);
    if (!albumName) {
      continue;
    }
    const albumId = existingAlbums.get(albumName);

    if (!albumId) {
      continue;
    }

    if (!albumToAssets.has(albumId)) {
      albumToAssets.set(albumId, []);
    }
    albumToAssets.get(albumId)?.push(asset.id);
  }

  const albumUpdateProgress = new SingleBar(
    { format: 'Adding assets to albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  albumUpdateProgress.start(assets.length, 0);

  try {
    for (const [albumId, assets] of albumToAssets) {
      for (const assetBatch of chunk(assets, Math.min(1000 * concurrency, 65_000))) {
        await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: assetBatch } });
        albumUpdateProgress.increment(assetBatch.length);
      }
    }
  } finally {
    albumUpdateProgress.stop();
  }
};

// `filepath` valid format:
// - Windows: `D:\\test\\Filename.txt` or `D:/test/Filename.txt`
// - Unix: `/test/Filename.txt`
export const getAlbumName = (filepath: string, options: UploadOptionsDto) => {
  return options.albumName ?? path.basename(path.dirname(filepath));
};
