import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import sanitize from 'sanitize-filename';
import type { JobOf, UploadFile } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { VideoTrimDto, VideoTrimResponseDto } from 'src/dtos/video-trim.dto.js';
import {
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { trimVideoFile } from 'src/utils/video-trim.js';

/** Slack allowed between the requested trim end and the asset duration (keyframe snapping). */
const DURATION_SLACK_SECONDS = 1;

/**
 * FG-15 (HomeRoll): server-side video trim (ADR-021).
 *
 * `POST /videos/:id/trim` validates the request against the source asset, then
 * queues a `VideoTrim` job that stream-copies the requested window with ffmpeg
 * into a new archived asset — same upload-folder layout, checksum dedupe,
 * `AssetCreate` event and metadata hand-off as the takeout/auto-creation paths.
 * The response carries the pre-generated target asset id so clients can look
 * the trimmed copy up in the archive once the job finishes.
 */
@Injectable()
export class VideoTrimService extends BaseService {
  async trim(auth: AuthDto, assetId: string, dto: VideoTrimDto): Promise<VideoTrimResponseDto> {
    const asset = await this.assetRepository.getById(assetId, {});
    if (!asset || asset.deletedAt !== null || asset.ownerId !== auth.user.id) {
      throw new BadRequestException('Video not found');
    }
    if (asset.type !== AssetType.Video) {
      throw new BadRequestException('Only videos can be trimmed');
    }
    if (asset.duration !== null && dto.endSeconds > asset.duration + DURATION_SLACK_SECONDS) {
      throw new BadRequestException('Trim range extends past the end of the video');
    }

    const targetAssetId = this.cryptoRepository.randomUUID();
    await this.jobRepository.queue({
      name: JobName.VideoTrim,
      data: {
        id: asset.id,
        ownerId: auth.user.id,
        startSeconds: dto.startSeconds,
        endSeconds: dto.endSeconds,
        targetAssetId,
      },
    });

    return { assetId: targetAssetId };
  }

  @OnJob({ name: JobName.VideoTrim, queue: QueueName.BackgroundTask })
  async handleVideoTrim(job: JobOf<JobName.VideoTrim>): Promise<JobStatus> {
    const { id, ownerId, startSeconds, endSeconds, targetAssetId } = job;
    this.logger.log(`Video trim started for asset ${id} (user ${ownerId}, ${startSeconds}s–${endSeconds}s)`);

    const source = await this.assetRepository.getById(id, {});
    if (!source || source.deletedAt !== null || !source.originalPath) {
      this.logger.warn(`Video trim ${targetAssetId}: source asset ${id} is gone — skipping`);
      return JobStatus.Skipped;
    }

    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, ownerId, targetAssetId);
    const path = join(folder, sanitize(`${targetAssetId}.mp4`));
    this.storageRepository.mkdirSync(folder);

    try {
      await trimVideoFile(source.originalPath, path, { startSeconds, endSeconds });

      const stats = await this.storageRepository.stat(path);
      const checksum = await this.streamChecksum(path);

      // identical trim already exists — keep it instead of duplicating storage
      const existing = await this.assetRepository.getUploadAssetIdByChecksum(ownerId, checksum);
      if (existing) {
        this.logger.log(`Video trim ${targetAssetId}: identical trimmed copy already exists (${existing}) — skipping`);
        await this.storageRepository.unlink(path);
        return JobStatus.Skipped;
      }

      const asset = await this.assetRepository.create({
        id: targetAssetId,
        ownerId,
        libraryId: null,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: path,
        originalFileName: sanitize(`${source.originalFileName.replace(/\.[^.]+$/, '')} (trimmed).mp4`),
        fileCreatedAt: source.fileCreatedAt,
        fileModifiedAt: new Date(),
        localDateTime: source.localDateTime,
        type: AssetType.Video,
        visibility: AssetVisibility.Archive,
        livePhotoVideoId: null,
        duration: endSeconds - startSeconds,
      } satisfies Insertable<AssetTable>);

      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: stats.size, description: 'Trimmed copy' },
        lockedPropertiesBehavior: 'override',
      });

      await this.eventRepository.emit('AssetCreate', {
        asset: { id: asset.id, ownerId },
        file: {
          uuid: targetAssetId,
          checksum,
          originalPath: path,
          originalName: asset.originalFileName,
          size: stats.size,
        } as UploadFile,
      });

      await this.jobRepository.queue({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload' as const },
      });

      this.logger.log(`Video trim ${targetAssetId} finished for asset ${id}`);
      return JobStatus.Success;
    } catch (error) {
      // don't orphan a partial trim in the user's upload tree
      await this.storageRepository.unlink(path).catch(() => {});
      throw error;
    }
  }

  /** sha1 checksum computed while streaming — mirrors the takeout importer's pattern. */
  private async streamChecksum(path: string): Promise<Buffer> {
    const hash = createHash('sha1');
    await pipeline(createReadStream(path), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
        yield chunk;
      }
    });
    return hash.digest();
  }
}
