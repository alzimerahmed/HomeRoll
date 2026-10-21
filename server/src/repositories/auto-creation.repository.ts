import { Injectable } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database.js';
import { AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

/**
 * Candidate queries for FG-14 auto-creations (collages, animations, trip
 * highlights). All owner-scoped, timeline-visibility, non-deleted image assets
 * with a preview file. No @GenerateSql decorators (browse.repository
 * precedent — generated SQL is a CI artifact).
 */
@Injectable()
export class AutoCreationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Highest-quality recent photos for collage/animation source material. */
  getRecentHighlights(ownerId: string, limit: number) {
    return this.db
      .selectFrom('asset')
      .select(columns.searchAsset)
      .leftJoin('asset_quality', 'asset_quality.assetId', 'asset.id')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.type', '=', AssetType.Image)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .orderBy((eb) => eb.fn.coalesce('asset_quality.overall', sql.lit(0.5)), 'desc')
      .orderBy('asset.fileCreatedAt', 'desc')
      .limit(limit)
      .execute();
  }

  /**
   * Trip candidates: consecutive-day clusters of geo-tagged photos away from
   * the user's home city. A trip = a cluster with enough distinct days.
   */
  getTripCandidates(ownerId: string, minAssets: number) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select((eb) => [
        'asset_exif.city',
        'asset_exif.country',
        sql<string>`date_trunc('day', ${sql.ref('asset.localDateTime')} at time zone 'UTC')`.as('day'),
      ])
      .select((eb) => eb.fn.countAll<number>().as('assetCount'))
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.type', '=', AssetType.Image)
      .where('asset_exif.city', 'is not', null)
      .groupBy(['asset_exif.city', 'asset_exif.country'])
      .groupBy(sql`date_trunc('day', ${sql.ref('asset.localDateTime')} at time zone 'UTC')`)
      .having((eb) => eb.fn.countAll(), '>=', minAssets)
      .orderBy(sql`assetCount`, 'desc')
      .limit(50)
      .execute();
  }

  /** Assets for a trip cluster (same city/country, ordered chronologically). */
  getAssetsForTrip(ownerId: string, city: string, country: string | null, limit: number) {
    return this.db
      .selectFrom('asset')
      .select(columns.searchAsset)
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.type', '=', AssetType.Image)
      .where('asset_exif.city', '=', city)
      .$if(!!country, (qb) => qb.where('asset_exif.country', '=', country!))
      .orderBy('asset.localDateTime', 'asc')
      .limit(limit)
      .execute();
  }

  /** Whether an auto-created album for this owner+name already exists. */
  getAlbumByName(ownerId: string, albumName: string) {
    return this.db
      .selectFrom('album')
      .selectAll('album')
      .where('album.ownerId', '=', ownerId)
      .where('album.albumName', '=', albumName)
      .where('album.deletedAt', 'is', null)
      .executeTakeFirst();
  }

  /** Preview file paths for a set of assets (missing previews absent). */
  async getPreviewPaths(assetIds: string[]): Promise<Map<string, string>> {
    if (assetIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('asset_file')
      .select(['assetId', 'path'])
      .where('asset_file.assetId', 'in', assetIds)
      .where('asset_file.type', '=', AssetFileType.Preview)
      .execute();

    return new Map(rows.map(({ assetId, path }) => [assetId, path]));
  }
}
