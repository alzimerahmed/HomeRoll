import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { asUuid, withDefaultVisibility } from 'src/utils/database.js';

/**
 * Read-only asset listings backing the WebDAV tree (FG-09).
 * No @GenerateSql decorators: generated SQL files are committed artifacts
 * and must be produced by `bin/sync-sql.ts` in CI, not by hand.
 */
@Injectable()
export class WebDavRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Assets owned by `ownerId` that live in `libraryId`.
   * Scoped by owner: libraries are shared resources in the API surface,
   * but their assets must never leak across users.
   */
  getAssetsByLibraryId(ownerId: string, libraryId: string) {
    return this.assetSelection()
      .where('asset.libraryId', '=', asUuid(libraryId))
      .where('asset.ownerId', '=', asUuid(ownerId))
      .execute();
  }

  /**
   * Assets in `albumId`, visible because the user is a member of the album
   * (owned or shared). The membership check is enforced in SQL so assets in
   * albums the user cannot see are never returned.
   */
  getAssetsByAlbumId(ownerId: string, albumId: string) {
    return this.assetSelection()
      .innerJoin('album_asset', (join) =>
        join.onRef('album_asset.assetId', '=', 'asset.id').on('album_asset.albumId', '=', asUuid(albumId)),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .select('album_user.albumId')
            .where('album_user.albumId', '=', asUuid(albumId))
            .where('album_user.userId', '=', asUuid(ownerId)),
        ),
      )
      .execute();
  }

  private assetSelection() {
    return (
      this.db
        .selectFrom('asset')
        // timeline + archive only — hidden (live-photo motion) and locked assets are never exposed
        .$call(withDefaultVisibility)
        .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
        .select([
          'asset.id',
          'asset.originalFileName as fileName',
          'asset.originalPath',
          'asset.checksum',
          'asset.fileCreatedAt',
          'asset.fileModifiedAt',
          'asset_exif.fileSizeInByte as fileSize',
        ])
        .where('asset.deletedAt', 'is', null)
        .orderBy('asset.originalFileName', 'asc')
        .orderBy('asset.id', 'asc')
    );
  }
}
