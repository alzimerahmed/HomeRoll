import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid } from 'src/utils/database.js';
import type { ExportAssetMetadata } from 'src/utils/export-sidecar.js';

const builder = (db: Kysely<DB>) =>
  db
    .selectFrom('asset')
    .innerJoin('asset_exif', 'assetId', 'id')
    .select(['asset.id', 'asset.livePhotoVideoId', 'asset_exif.fileSizeInByte as size'])
    .where('asset.deletedAt', 'is', null);

@Injectable()
export class DownloadRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  downloadAssetIds(ids: string[]) {
    return builder(this.db).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadMotionAssetIds(ids: string[]) {
    return builder(this.db).select(['asset.originalPath']).where('asset.id', '=', anyUuid(ids)).stream();
  }

  downloadAlbumId(albumId: string) {
    return builder(this.db)
      .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .stream();
  }

  downloadUserId(userId: string) {
    return builder(this.db)
      .where('asset.ownerId', '=', userId)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .stream();
  }

  /**
   * FG-19: per-asset metadata for export sidecars (XMP / takeout JSON).
   * Albums and people come from LEFT JOINs + array_agg(DISTINCT) + GROUP BY —
   * one hash-aggregated plan per chunk instead of 2N correlated subplans
   * (perf audit M2). `ids` is chunked so peak memory stays bounded for large
   * archives. No @GenerateSql decorator (browse/quality repository precedent) —
   * no committed SQL artifact to regenerate.
   */
  async getExportMetadata(ids: string[]): Promise<Map<string, ExportAssetMetadata>> {
    if (ids.length === 0) {
      return new Map();
    }

    const EXPORT_METADATA_CHUNK = 500;
    const result = new Map<string, ExportAssetMetadata>();
    for (let offset = 0; offset < ids.length; offset += EXPORT_METADATA_CHUNK) {
      const chunk = ids.slice(offset, offset + EXPORT_METADATA_CHUNK);
      const rows = await this.db
        .selectFrom('asset')
        .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .leftJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .leftJoin('album', 'album.id', 'album_asset.albumId')
        .leftJoin('asset_face', (join) =>
          join.onRef('asset_face.assetId', '=', 'asset.id').on('asset_face.deletedAt', 'is', null),
        )
        .leftJoin('person', (join) =>
          join
            .onRef('person.personGroupId', '=', 'asset_face.personGroupId')
            .onRef('person.ownerId', '=', 'asset.ownerId')
            .on('person.name', '!=', ''),
        )
        .select((eb) => [
          'asset.id',
          'asset.originalFileName',
          'asset.type',
          'asset.fileCreatedAt',
          // FG-19: alias to `takenAt` — ExportAssetMetadata requires that name (B1)
          'asset_exif.dateTimeOriginal as takenAt',
          'asset_exif.latitude',
          'asset_exif.longitude',
          'asset_exif.description',
          'asset_exif.rating',
          'asset_exif.orientation',
          'asset_exif.make',
          'asset_exif.model',
          'asset_exif.lensModel',
          'asset_exif.fNumber',
          'asset_exif.focalLength',
          'asset_exif.iso',
          'asset_exif.exposureTime',
          'asset_exif.city',
          'asset_exif.state',
          'asset_exif.country',
          'asset_exif.timeZone',
          'asset_exif.tags',
          sql<
            string[]
          >`coalesce(array_agg(distinct "album"."albumName" order by "album"."albumName") filter (where "album"."albumName" is not null), '{}')`.as(
            'albums',
          ),
          sql<
            string[]
          >`coalesce(array_agg(distinct "person"."name" order by "person"."name") filter (where "person"."name" is not null), '{}')`.as(
            'people',
          ),
        ])
        .where('asset.id', '=', anyUuid(chunk))
        .where('asset.deletedAt', 'is', null)
        .groupBy([
          'asset.id',
          'asset.originalFileName',
          'asset.type',
          'asset.fileCreatedAt',
          'asset_exif.dateTimeOriginal',
          'asset_exif.latitude',
          'asset_exif.longitude',
          'asset_exif.description',
          'asset_exif.rating',
          'asset_exif.orientation',
          'asset_exif.make',
          'asset_exif.model',
          'asset_exif.lensModel',
          'asset_exif.fNumber',
          'asset_exif.focalLength',
          'asset_exif.iso',
          'asset_exif.exposureTime',
          'asset_exif.city',
          'asset_exif.state',
          'asset_exif.country',
          'asset_exif.timeZone',
          'asset_exif.tags',
        ])
        .execute();

      for (const row of rows) {
        result.set(row.id, {
          ...row,
          albums: row.albums ?? [],
          people: row.people ?? [],
        } satisfies ExportAssetMetadata);
      }
    }

    return result;
  }
}
