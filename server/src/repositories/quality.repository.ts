import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

/**
 * Queries backing the FG-12 image quality signals. The `asset_quality` row's
 * existence doubles as the "scored" marker, so the queue-all stream is a simple
 * anti-join — no `asset_job_status` column needed.
 *
 * No @GenerateSql decorators: generated SQL files are committed artifacts
 * produced by `bin/sync-sql.ts` in CI, not by hand (browse.repository precedent).
 */
@Injectable()
export class QualityRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Assets with a preview file that have not been scored yet. */
  streamForQualityJob(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['asset.id'])
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where('asset.type', '=', AssetType.Image)
      .$if(!force, (qb) =>
        qb.where((eb) => eb.not(eb.exists(eb.selectFrom('asset_quality').whereRef('assetId', '=', 'asset.id')))),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .stream();
  }

  /** Preview paths for a scoring batch — one query per batch. */
  getForQualityJobBatch(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .selectFrom('asset')
      .select((eb) => [
        'asset.id',
        'asset.visibility',
        eb
          .selectFrom('asset_file')
          .select('asset_file.path')
          .whereRef('asset_file.assetId', '=', 'asset.id')
          .where('asset_file.type', '=', AssetFileType.Preview)
          .limit(1)
          .as('previewFile'),
      ])
      .where('asset.id', 'in', ids)
      .execute();
  }

  /** Faces for a batch of assets, grouped by assetId — one query per scoring batch. */
  async getFacesForAssets(assetIds: string[]) {
    const map = new Map<string, { boundingBoxX1: number; boundingBoxY1: number; boundingBoxX2: number; boundingBoxY2: number; score: number }[]>();
    if (assetIds.length === 0) {
      return map;
    }

    const rows = await this.db
      .selectFrom('asset_face')
      .select(['asset_face.assetId', 'boundingBoxX1', 'boundingBoxY1', 'boundingBoxX2', 'boundingBoxY2', 'score'])
      .where('asset_face.assetId', 'in', assetIds)
      .where('asset_face.deletedAt', 'is', null)
      .execute();

    for (const row of rows) {
      const { assetId, ...face } = row;
      const list = map.get(assetId) ?? [];
      list.push(face);
      map.set(assetId, list);
    }
    return map;
  }

  async upsert(assetId: string, quality: Omit<Insertable<DB['asset_quality']>, 'assetId' | 'id'>) {
    await this.db
      .insertInto('asset_quality')
      .values({ ...quality, assetId })
      .onConflict((oc) =>
        oc.column('assetId').doUpdateSet({
          blur: quality.blur,
          exposure: quality.exposure,
          subject: quality.subject,
          eyesOpen: quality.eyesOpen,
          overall: quality.overall,
        }),
      )
      .execute();
  }

  /** Overall scores for a set of assets (missing rows absent from the map). */
  getOverallByAssetIds(assetIds: string[]) {
    if (assetIds.length === 0) {
      return Promise.resolve(new Map<string, number>());
    }

    return this.db
      .selectFrom('asset_quality')
      .select(['assetId', 'overall'])
      .where('assetId', 'in', assetIds)
      .execute()
      .then((rows) => new Map(rows.map(({ assetId, overall }) => [assetId, Number(overall)])));
  }

  deleteAll() {
    return this.db.transaction().execute(async (trx) => {
      await sql`truncate ${sql.table('asset_quality')}`.execute(trx);
    });
  }
}
