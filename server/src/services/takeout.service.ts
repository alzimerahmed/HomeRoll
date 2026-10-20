import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Job } from 'bullmq';
import { Insertable, Updateable } from 'kysely';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sanitize from 'sanitize-filename';
import type { JobOf, UploadFile } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { LockableProperty } from 'src/database.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { TakeoutImportResponseDto, TakeoutImportState, TakeoutImportStatusDto } from 'src/dtos/takeout.dto.js';
import {
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  QueueJobStatus,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { ArchiveFile, ArchiveFormat, detectArchiveFormat, readArchive } from 'src/utils/archive.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { getFilenameExtension } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { TakeoutMetadata, findSidecarJson, parseTakeoutJson } from 'src/utils/takeout-json.js';

/** Maximum size of a JSON sidecar that will be buffered for metadata pairing (4 MiB). */
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
/** Global cap on buffered sidecars — per-file limits alone allow 50k × 4 MiB in RAM. */
const MAX_SIDECAR_TOTAL_BYTES = 512 * 1024 * 1024;
/** How many queued/running imports one user may pile up (each stages a ≤64 GiB archive). */
const MAX_PENDING_IMPORTS = 5;
/** Staged archives older than this are swept at job start (leftovers from crashed jobs). */
const STALE_ARCHIVE_AGE_MS = 24 * 3600 * 1000;
/** How often (in archive entries) cancellation and progress are pushed to the BullMQ job. */
const PROGRESS_UPDATE_INTERVAL = 64;

type TakeoutProgress = {
  processed: number;
  imported: number;
  duplicates: number;
  skipped: number;
  errors: number;
  /** set in job progress when the import was aborted by the user */
  cancelled?: boolean;
};

/** An asset that was created during the scan phase and is waiting for sidecar metadata. */
type PendingAsset = {
  assetId: string;
  /** archive directory of the media file (used to look up the sidecar index) */
  directory: string;
  /** media file name inside the archive */
  fileName: string;
  /** absolute path of the extracted file */
  path: string;
};

enum ImportOutcome {
  Imported = 'imported',
  Duplicate = 'duplicate',
}

/**
 * Google Takeout importer (FG-05).
 *
 * Flow: a multipart archive upload is staged by `TakeoutUploadInterceptor`, then a
 * `JobName.TakeoutImport` BullMQ job streams the archive entry-by-entry. Each media
 * file lands in the user's `upload/` folder using the same nested layout, sha1
 * checksum, dedupe check, asset row creation and `AssetCreate` event as the regular
 * upload path (`AssetMediaService.uploadAsset`). JSON sidecars are buffered (they are
 * small) and applied afterwards via `assetRepository.upsertExif` with locked
 * properties, so the normal `AssetExtractMetadata` job does not overwrite the
 * Google-provided dates, geo and descriptions.
 *
 * Import state and progress live on the BullMQ job itself (data + progress) — no
 * database tables are used. Each uploaded archive is a separate import job; multi-part
 * Takeout exports therefore create multiple jobs.
 */
@Injectable()
export class TakeoutService extends BaseService {
  async uploadArchive(auth: AuthDto, file: Express.Multer.File | undefined): Promise<TakeoutImportResponseDto> {
    if (!file) {
      throw new BadRequestException('An archive file is required');
    }

    // strip control characters — the name lands in logs and API responses
    const fileName = [...Buffer.from(file.originalname, 'latin1').toString('utf8')]
      .map((char) => {
        const code = char.codePointAt(0)!;
        return code < 32 || code === 127 ? '_' : char;
      })
      .join('');

    try {
      // the queue is serial — bound each user's staged backlog so archives can't pile up on disk
      const pending = await this.jobRepository.searchJobs(QueueName.Takeout, {
        status: [QueueJobStatus.Active, QueueJobStatus.Waiting, QueueJobStatus.Delayed],
      });
      const ownedPending = pending.filter(
        (job) => (job.data as { ownerId?: string } | undefined)?.ownerId === auth.user.id,
      );
      if (ownedPending.length >= MAX_PENDING_IMPORTS) {
        throw new BadRequestException(`Too many pending takeout imports — wait for a running import to finish first`);
      }

      const format = await this.detectFormat(file.path);
      if (!format) {
        throw new BadRequestException(
          `Unsupported archive format for file '${fileName}'. Expected a .zip, .tar or .tar.gz archive.`,
        );
      }

      const importId = this.cryptoRepository.randomUUID();
      await this.jobRepository.queue({
        name: JobName.TakeoutImport,
        data: {
          importId,
          ownerId: auth.user.id,
          archivePath: file.path,
          archiveName: fileName,
        },
      });

      return { id: importId, fileName, status: TakeoutImportState.Queued };
    } catch (error: Error | any) {
      await this.storageRepository.unlink(file.path);
      throw error;
    }
  }

  async getImports(auth: AuthDto): Promise<TakeoutImportStatusDto[]> {
    const jobs = await this.jobRepository.searchJobs(QueueName.Takeout, {});
    const items = jobs.filter(
      (job) => job.id && job.data && (job.data as { ownerId?: string }).ownerId === auth.user.id,
    );

    const imports: TakeoutImportStatusDto[] = [];
    for (const item of items) {
      const job = await this.jobRepository.getJob(JobName.TakeoutImport, item.id as string);
      if (job) {
        imports.push(await this.toStatusDto(job));
      }
    }

    return imports;
  }

  async getImport(auth: AuthDto, id: string): Promise<TakeoutImportStatusDto> {
    return this.toStatusDto(await this.getImportJob(auth, id));
  }

  async cancelImport(auth: AuthDto, id: string): Promise<TakeoutImportStatusDto> {
    const job = await this.getImportJob(auth, id);

    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      throw new BadRequestException(`Takeout import ${id} has already finished`);
    }

    // flag the job — a queued job skips itself on start, a running job aborts at the next check
    try {
      await job.updateData({ ...job.data, cancelled: true });
    } catch {
      throw new BadRequestException(`Takeout import ${id} has already finished`);
    }

    return this.toStatusDto(job);
  }

  @OnJob({ name: JobName.TakeoutImport, queue: QueueName.Takeout })
  async handleTakeoutImport(job: JobOf<JobName.TakeoutImport>): Promise<JobStatus> {
    const { importId, ownerId, archivePath, archiveName } = job;
    this.logger.log(`Starting takeout import ${importId} (${archiveName}) for user ${ownerId}`);

    const progress: TakeoutProgress = { processed: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0 };
    const bullJob = await this.jobRepository.getJob(JobName.TakeoutImport, importId);
    const updateProgress = async () => {
      await bullJob?.updateProgress({ ...progress });
    };

    try {
      if (job.cancelled) {
        progress.cancelled = true;
        await updateProgress();
        return JobStatus.Skipped;
      }

      const owner = await this.userRepository.get(ownerId, {});
      if (!owner) {
        this.logger.error(`Takeout import ${importId}: owner ${ownerId} was not found`);
        return JobStatus.Failed;
      }

      const format = await this.detectFormat(archivePath);
      if (!format) {
        this.logger.error(`Takeout import ${importId}: unsupported archive format for file ${archivePath}`);
        return JobStatus.Failed;
      }

      // sweep staged archives older than a day — leftovers from crashed or removed jobs
      await this.sweepStaleArchives(dirname(archivePath), archivePath).catch((error: Error | any) => {
        this.logger.warn(`Takeout import ${importId}: staging sweep failed: ${error}`);
      });

      const quota = owner.quotaSizeInBytes;
      let usedBytes = owner.quotaUsageInBytes ?? 0;

      const sidecars = new Map<string, Map<string, Buffer>>();
      let sidecarBytes = 0;
      const pending: PendingAsset[] = [];

      for await (const entry of readArchive(archivePath, format)) {
        progress.processed++;
        if (progress.processed % PROGRESS_UPDATE_INTERVAL === 0) {
          if (await this.isCancelled(importId)) {
            progress.cancelled = true;
            break;
          }
          await updateProgress();
        }

        const directory = posix.dirname(entry.path);
        const fileName = posix.basename(entry.path);

        try {
          if (fileName.toLowerCase().endsWith('.json')) {
            if (entry.size > MAX_SIDECAR_BYTES || sidecarBytes + entry.size > MAX_SIDECAR_TOTAL_BYTES) {
              progress.skipped++;
              continue;
            }
            const buffer = await this.readEntry(entry);
            sidecarBytes += buffer.length;
            let index = sidecars.get(directory);
            if (!index) {
              index = new Map();
              sidecars.set(directory, index);
            }
            index.set(fileName, buffer);
            continue;
          }

          if (!mimeTypes.isAsset(fileName)) {
            progress.skipped++;
            continue;
          }

          if (quota !== null && usedBytes + entry.size > quota) {
            this.logger.warn(`Takeout import ${importId}: quota exceeded, skipping ${entry.path}`);
            progress.skipped++;
            continue;
          }

          const { outcome, size, asset } = await this.importMediaEntry(ownerId, entry, fileName);
          progress[outcome === ImportOutcome.Imported ? 'imported' : 'duplicates']++;
          if (outcome === ImportOutcome.Imported && asset) {
            usedBytes += size;
            pending.push(asset);
          }
        } catch (error: Error | any) {
          progress.errors++;
          this.logger.error(`Failed to import takeout entry ${entry.path}: ${error}`, error?.stack);
        }
      }

      // second pass: apply buffered sidecar metadata to the freshly created assets
      for (const item of pending) {
        try {
          await this.applySidecarMetadata(item, sidecars);
        } catch (error: Error | any) {
          progress.errors++;
          this.logger.error(`Failed to apply sidecar metadata for ${item.fileName}: ${error}`, error?.stack);
        }
      }

      // hand assets to the regular pipeline — thumbnails, metadata extraction, search, faces, ...
      if (pending.length > 0) {
        await this.jobRepository.queueAll(
          pending.map(
            (item) =>
              ({ name: JobName.AssetExtractMetadata, data: { id: item.assetId, source: 'upload' as const } }) as const,
          ),
        );
      }

      await updateProgress();
      this.logger.log(
        `Takeout import ${importId} finished: ${progress.imported} imported, ${progress.duplicates} duplicates, ` +
          `${progress.skipped} skipped, ${progress.errors} errors${progress.cancelled ? ' (cancelled)' : ''}`,
      );

      return progress.cancelled ? JobStatus.Skipped : JobStatus.Success;
    } catch (error: Error | any) {
      this.logger.error(`Takeout import ${importId} failed: ${error}`, error?.stack);
      await updateProgress();
      throw error;
    } finally {
      // the archive is single-use and stays on the media volume until this job completes
      await this.storageRepository.unlink(archivePath).catch(() => {});
      await this.storageRepository.removeEmptyDirs(dirname(archivePath), true).catch(() => {});
    }
  }

  /**
   * Streams one media entry to its final upload path while hashing, then deduplicates
   * and creates the asset — mirroring `AssetMediaService.uploadAsset`.
   */
  private async importMediaEntry(
    ownerId: string,
    entry: ArchiveFile,
    fileName: string,
  ): Promise<{ outcome: ImportOutcome; size: number; asset?: PendingAsset }> {
    const uuid = this.cryptoRepository.randomUUID();
    const extension = getFilenameExtension(entry.path);
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, ownerId, uuid);
    const path = join(folder, sanitize(`${uuid}${extension}`));

    this.storageRepository.mkdirSync(folder);

    const hash = createHash('sha1');
    const stream = await entry.open();
    stream.on('data', (chunk: Buffer) => hash.update(chunk));

    try {
      await pipeline(stream, this.storageRepository.createWriteStream(path));
    } catch (error: Error | any) {
      await this.storageRepository.unlink(path);
      throw error;
    }

    const checksum = hash.digest();
    const stats = await this.storageRepository.stat(path);

    const duplicate = await this.assetRepository.getUploadAssetIdByChecksum(ownerId, checksum);
    if (duplicate) {
      await this.storageRepository.unlink(path);
      return { outcome: ImportOutcome.Duplicate, size: stats.size };
    }

    // entry timestamps are preferred; file mtime is the fallback, exactly like an upload
    const fileModifiedAt = entry.mtime ?? stats.mtime;

    try {
      const asset = await this.assetRepository.create({
        ownerId,
        libraryId: null,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: path,
        originalFileName: fileName,
        fileCreatedAt: fileModifiedAt,
        fileModifiedAt,
        localDateTime: fileModifiedAt,
        type: mimeTypes.assetType(entry.path),
        visibility: AssetVisibility.Timeline,
        livePhotoVideoId: null,
        duration: null,
      });

      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: stats.size },
        lockedPropertiesBehavior: 'override',
      });

      await this.storageRepository.utimes(path, new Date(), fileModifiedAt);

      await this.eventRepository.emit('AssetCreate', {
        asset: { id: asset.id, ownerId },
        file: { uuid, checksum, originalPath: path, originalName: fileName, size: stats.size } as UploadFile,
      });

      return {
        outcome: ImportOutcome.Imported,
        size: stats.size,
        asset: { assetId: asset.id, directory: posix.dirname(entry.path), fileName, path },
      };
    } catch (error: Error | any) {
      await this.storageRepository.unlink(path);
      if (isAssetChecksumConstraint(error)) {
        return { outcome: ImportOutcome.Duplicate, size: stats.size };
      }
      throw error;
    }
  }

  /**
   * Finds the buffered Google JSON sidecar for an imported asset and applies its
   * metadata. `dateTimeOriginal`, `latitude`, `longitude` and `description` are locked
   * so the follow-up metadata extraction job keeps the Google-provided values when the
   * file itself lacks them (embedded EXIF still wins — that job updates the asset row,
   * but the locked EXIF columns are skipped).
   */
  private async applySidecarMetadata(item: PendingAsset, sidecars: Map<string, Map<string, Buffer>>): Promise<void> {
    const jsonFiles = sidecars.get(item.directory);
    if (!jsonFiles) {
      return;
    }

    const match = findSidecarJson(item.fileName, jsonFiles.keys());
    if (!match) {
      return;
    }

    let metadata: TakeoutMetadata | null;
    try {
      metadata = parseTakeoutJson(JSON.parse(jsonFiles.get(match)!.toString('utf8')));
    } catch {
      this.logger.warn(`Unable to parse takeout sidecar ${posix.join(item.directory, match)}`);
      return;
    }
    if (!metadata) {
      return;
    }

    const exif: Insertable<AssetExifTable> = { assetId: item.assetId };
    const update: Updateable<AssetTable> & { id: string } = { id: item.assetId };
    const lockedProperties: LockableProperty[] = [];

    if (metadata.takenAt) {
      exif.dateTimeOriginal = metadata.takenAt;
      lockedProperties.push('dateTimeOriginal');
      update.fileCreatedAt = metadata.takenAt;
      update.localDateTime = metadata.takenAt;
      update.fileModifiedAt = metadata.takenAt;
      // keep the on-disk mtime aligned so the metadata extractor's date fallback resolves to the takeout date
      await this.storageRepository.utimes(item.path, new Date(), metadata.takenAt);
    }

    if (metadata.geo) {
      exif.latitude = metadata.geo.latitude;
      exif.longitude = metadata.geo.longitude;
      lockedProperties.push('latitude', 'longitude');
    }

    if (metadata.description) {
      exif.description = metadata.description;
      lockedProperties.push('description');
    }

    if (metadata.title) {
      update.originalFileName = getFilenameExtension(metadata.title)
        ? metadata.title
        : `${metadata.title}${getFilenameExtension(item.fileName)}`;
    }

    if (lockedProperties.length > 0) {
      exif.lockedProperties = lockedProperties;
      await this.assetRepository.upsertExif({ exif, lockedPropertiesBehavior: 'append' });
    }

    if (Object.keys(update).length > 1) {
      await this.assetRepository.update(update);
    }
  }

  private async isCancelled(importId: string): Promise<boolean> {
    const job = await this.jobRepository.getJob(JobName.TakeoutImport, importId);
    return (job?.data as { cancelled?: boolean } | undefined)?.cancelled === true;
  }

  private async getImportJob(auth: AuthDto, id: string): Promise<Job> {
    const job = await this.jobRepository.getJob(JobName.TakeoutImport, id);
    const data = job?.data as { ownerId?: string } | undefined;
    if (!job || data?.ownerId !== auth.user.id) {
      throw new NotFoundException(`Takeout import ${id} was not found`);
    }
    return job;
  }

  private async toStatusDto(job: Job): Promise<TakeoutImportStatusDto> {
    const data = job.data as { archiveName?: string; cancelled?: boolean };
    const progress = (typeof job.progress === 'object' && job.progress !== null ? job.progress : {}) as TakeoutProgress;
    const cancelled = progress.cancelled === true || data.cancelled === true;

    let status: TakeoutImportState;
    switch (await job.getState()) {
      case 'waiting':
      case 'waiting-children':
      case 'delayed':
      case 'prioritized': {
        status = cancelled ? TakeoutImportState.Cancelled : TakeoutImportState.Queued;
        break;
      }
      case 'active': {
        status = cancelled ? TakeoutImportState.Cancelled : TakeoutImportState.Processing;
        break;
      }
      case 'completed': {
        status = cancelled ? TakeoutImportState.Cancelled : TakeoutImportState.Completed;
        break;
      }
      case 'failed': {
        status = TakeoutImportState.Failed;
        break;
      }
      default: {
        // transient/unknown states (paused, repeat, ...) — not a failure
        status = cancelled ? TakeoutImportState.Cancelled : TakeoutImportState.Queued;
        break;
      }
    }

    return {
      id: job.id as string,
      fileName: data.archiveName ?? '',
      status,
      createdAt: job.timestamp,
      progress: {
        processed: progress.processed ?? 0,
        imported: progress.imported ?? 0,
        duplicates: progress.duplicates ?? 0,
        skipped: progress.skipped ?? 0,
        errors: progress.errors ?? 0,
      },
      // fs/archive errors can embed absolute server paths — surface a generic message instead
      error: job.failedReason ? 'Import failed — see server logs for details' : undefined,
    };
  }

  /** Deletes staged archives older than `STALE_ARCHIVE_AGE_MS`, except the file this job needs. */
  private async sweepStaleArchives(directory: string, keep: string): Promise<void> {
    const cutoff = Date.now() - STALE_ARCHIVE_AGE_MS;
    for (const name of await this.storageRepository.readdir(directory)) {
      const path = join(directory, name);
      if (path === keep) {
        continue;
      }
      try {
        const stats = await this.storageRepository.stat(path);
        if (stats.mtime.getTime() < cutoff) {
          await this.storageRepository.unlink(path);
        }
      } catch {
        this.logger.debug(`Unable to sweep stale takeout archive ${path}`);
      }
    }
  }

  private async detectFormat(path: string): Promise<ArchiveFormat | null> {
    const header = await this.storageRepository.readFile(path, { buffer: Buffer.alloc(600), position: 0, length: 600 });
    return detectArchiveFormat(header);
  }

  private async readEntry(entry: ArchiveFile): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stream = await entry.open();
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}
