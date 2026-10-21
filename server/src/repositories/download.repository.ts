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
   * Albums and people are correlated array subqueries to avoid fan-out rows.
   * No @GenerateSql decorator (browse/quality repository precedent) — no committed
   * SQL artifact to regenerate.
   */
  async getExportMetadata(ids: string[]): Promise<Map<string, ExportAssetMetadata>> {
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select((eb) => [
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
        sql<string[]>`coalesce((select array_agg(al.albumName order by al.albumName) from album_asset aa join album al on al.id = aa.albumId where aa.assetId = asset.id), '{}')`.as(
          'albums',
        ),
        sql<string[]>`coalesce((select array_agg(distinct p.name) from asset_face af join person p on p.personGroupId = af.personGroupId where af.assetId = asset.id and af.deletedAt is null and p.ownerId = asset.ownerId and p.name <> ''), '{}')`.as(
          'people',
        ),
      ])
      .where('asset.id', '=', anyUuid(ids))
      .where('asset.deletedAt', 'is', null)
      .execute();

    return new Map(
      rows.map((row) => [
        row.id,
        {
          ...row,
          albums: row.albums ?? [],
          people: row.people ?? [],
        } satisfies ExportAssetMetadata,
      ]),
    );
  }
}
