import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import sanitize from 'sanitize-filename';
import type { JobOf, UploadFile } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AutoCreationRunDto, AutoCreationStatusDto, AutoCreationType } from 'src/dtos/auto-creation.dto.js';
import {
  AlbumType,
  AlbumUserRole,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AutoCreationRepository } from 'src/repositories/auto-creation.repository.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { createAnimation } from 'src/utils/animation.js';
import { createCollage } from 'src/utils/collage.js';

const COLLAGE_SOURCE_ASSETS = 4;
const ANIMATION_SOURCE_ASSETS = 8;
const TRIP_MIN_DAY_ASSETS = 5;
const TRIP_ALBUM_ASSET_LIMIT = 200;
/** Upper bound on trip albums created per run. */
const MAX_TRIPS_PER_RUN = 3;

/**
 * FG-14 (HomeRoll): auto-creations — collages, animations and trip highlights.
 *
 * User-triggered via `POST /auto-creations/run` (no silent background churn);
 * work runs as BullMQ jobs on the background-task queue. Results follow the
 * existing domain conventions: collages/animations become real assets
 * (archived visibility, full thumbnail/search pipeline via AssetCreate) and
 * trip highlights become albums.
 */
@Injectable()
export class AutoCreationService extends BaseService {
  @Inject(AutoCreationRepository)
  private readonly autoCreationRepository!: AutoCreationRepository;

  async run(auth: AuthDto, dto: AutoCreationRunDto): Promise<AutoCreationStatusDto> {
    // BullMQ dedupes on (ownerId, type) — see JobRepository.getJobOptions — so
    // spamming this endpoint cannot stack heavyweight ffmpeg/sharp jobs; a
    // duplicate add is silently dropped and the pending job still runs.
    const jobId = this.cryptoRepository.randomUUID();
    await this.jobRepository.queue({
      name: JobName.AutoCreationGenerate,
      data: { id: jobId, ownerId: auth.user.id, type: dto.type },
    });

    return { type: dto.type };
  }

  @OnJob({ name: JobName.AutoCreationGenerate, queue: QueueName.BackgroundTask })
  async handleAutoCreationGenerate(job: JobOf<JobName.AutoCreationGenerate>): Promise<JobStatus> {
    const { ownerId, type } = job;
    this.logger.log(`Auto-creation (${type}) started for user ${ownerId}`);

    switch (type) {
      case AutoCreationType.Collage: {
        return this.createCollageAsset(ownerId);
      }
      case AutoCreationType.Animation: {
        return this.createAnimationAsset(ownerId);
      }
      case AutoCreationType.TripHighlights: {
        return this.createTripHighlights(ownerId);
      }
      default: {
        throw new BadRequestException(`Unknown auto-creation type: ${type as string}`);
      }
    }
  }

  private async createCollageAsset(ownerId: string): Promise<JobStatus> {
    const highlights = await this.autoCreationRepository.getRecentHighlights(ownerId, COLLAGE_SOURCE_ASSETS);
    if (highlights.length === 0) {
      return JobStatus.Skipped;
    }

    const previews = await this.autoCreationRepository.getPreviewPaths(highlights.map(({ id }) => id));
    const sources = highlights.map(({ id, originalPath }) => previews.get(id) ?? originalPath);

    const assetId = await this.storeGeneratedImage(
      ownerId,
      'collage',
      (output) =>
        createCollage(
          sources.map((path) => ({ path })),
          output,
        ),
      highlights[0]!.fileCreatedAt,
    );

    this.logger.log(`Auto-created collage ${assetId} for user ${ownerId}`);
    return JobStatus.Success;
  }

  private async createAnimationAsset(ownerId: string): Promise<JobStatus> {
    const highlights = await this.autoCreationRepository.getRecentHighlights(ownerId, ANIMATION_SOURCE_ASSETS);
    if (highlights.length < 2) {
      return JobStatus.Skipped;
    }

    const previews = await this.autoCreationRepository.getPreviewPaths(highlights.map(({ id }) => id));
    const sources = highlights.map(({ id, originalPath }) => previews.get(id) ?? originalPath);

    const assetId = await this.storeGeneratedImage(
      ownerId,
      'animation',
      (output) => createAnimation(sources, output),
      highlights[0]!.fileCreatedAt,
      AssetType.Video,
    );

    this.logger.log(`Auto-created animation ${assetId} for user ${ownerId}`);
    return JobStatus.Success;
  }

  private async createTripHighlights(ownerId: string): Promise<JobStatus> {
    const candidates = await this.autoCreationRepository.getTripCandidates(ownerId, TRIP_MIN_DAY_ASSETS);
    const created: string[] = [];

    for (const candidate of candidates) {
      if (!candidate.city) {
        continue;
      }

      const albumName = `Trip to ${candidate.city}`;
      const existing = await this.autoCreationRepository.getAlbumByName(ownerId, albumName);
      if (existing) {
        continue;
      }

      const assets = await this.autoCreationRepository.getAssetsForTrip(
        ownerId,
        candidate.city,
        candidate.country,
        new Date(candidate.day),
        TRIP_ALBUM_ASSET_LIMIT,
      );
      if (assets.length === 0) {
        continue;
      }

      const album = await this.albumRepository.create(
        {
          // album names are titles, not file paths — filename sanitization would
          // mangle legitimate characters (anti-vibe audit m4); trim only
          albumName: albumName.trim(),
          albumType: AlbumType.Manual,
        },
        assets.map(({ id }) => id),
        [{ userId: ownerId, role: AlbumUserRole.Owner }],
        ownerId,
      );
      created.push(album.id);
      if (created.length >= MAX_TRIPS_PER_RUN) {
        break; // a few trips per run is plenty
      }
    }

    return created.length > 0 ? JobStatus.Success : JobStatus.Skipped;
  }

  /**
   * Writes a generated media file into the owner's upload tree, creates the
   * asset row (archived visibility) and hands it to the regular pipeline —
   * mirroring the takeout import path.
   */
  private async storeGeneratedImage(
    ownerId: string,
    kind: 'collage' | 'animation',
    generate: (output: string) => Promise<void>,
    fileCreatedAt: Date,
    type: AssetType = AssetType.Image,
  ): Promise<string> {
    const uuid = this.cryptoRepository.randomUUID();
    const extension = type === AssetType.Video ? '.mp4' : '.jpg';
    const folder = StorageCore.getNestedFolder(StorageFolder.Upload, ownerId, uuid);
    const path = join(folder, sanitize(`${uuid}${extension}`));

    this.storageRepository.mkdirSync(folder);
    try {
      await generate(path);

      const stats = await this.storageRepository.stat(path);
      const checksum = createHash('sha1')
        .update(await this.storageRepository.readFile(path))
        .digest();

      // deterministic inputs produce identical output — an unchanged re-run
      // would violate the (ownerId, checksum) unique constraint, so link the
      // existing asset instead of creating a duplicate
      const existing = await this.autoCreationRepository.getAssetByChecksum(ownerId, checksum);
      if (existing) {
        this.logger.log(`Auto-created ${kind} already exists for user ${ownerId} (asset ${existing.id}) — skipping`);
        await this.storageRepository.unlink(path);
        return existing.id;
      }

      const asset = await this.assetRepository.create({
        ownerId,
        libraryId: null,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: path,
        originalFileName: `Auto ${kind}${extension}`,
        fileCreatedAt,
        fileModifiedAt: new Date(),
        localDateTime: fileCreatedAt,
        type,
        visibility: AssetVisibility.Archive,
        livePhotoVideoId: null,
        duration: null,
      } satisfies Insertable<AssetTable>);

      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: stats.size, description: `Auto-created ${kind}` },
        lockedPropertiesBehavior: 'override',
      });

      await this.eventRepository.emit('AssetCreate', {
        asset: { id: asset.id, ownerId },
        file: {
          uuid,
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

      return asset.id;
    } catch (error) {
      // don't orphan a partial render in the user's upload tree
      await this.storageRepository.unlink(path).catch(() => {});
      throw error;
    }
  }
}
