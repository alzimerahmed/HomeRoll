import { Injectable } from '@nestjs/common';
import { Kysely, sql, Transaction } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import z from 'zod';
import { columns } from 'src/database.js';
import { VectorIndex } from 'src/enum.js';
import { probes } from 'src/repositories/database.repository.js';
import { AssetSearchScope } from 'src/repositories/search.repository.js';
import { DB } from 'src/schema/index.js';
import { searchAssetBuilder } from 'src/utils/database.js';
import { PaginationOptions, paginationHelper } from 'src/utils/pagination.js';

export interface BrowseLabelSearchOptions {
  /** CLIP text embedding for the label prompt */
  embedding: string;
  /** cosine-distance cutoff for label membership */
  maxDistance: number;
}

/**
 * Queries backing the browsable CLIP-label taxonomy (FG-16). Reuses
 * `searchAssetBuilder` so ownership/visibility semantics stay identical to
 * smart search; trashed assets are excluded since they should not surface in
 * a discovery view.
 *
 * No @GenerateSql decorators: generated SQL files are committed artifacts
 * produced by `bin/sync-sql.ts` in CI, not by hand.
 */
@Injectable()
export class BrowseRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Count of in-scope assets within `maxDistance` of the label embedding, plus
   * the nearest asset ID as the label preview. The windowed count keeps this a
   * single LIMIT 1 query — the vector index still serves the ordering.
   */
  async countLabelMatches(
    options: BrowseLabelSearchOptions,
    scope: AssetSearchScope,
  ): Promise<{ count: number; previewAssetId: string | null }> {
    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
      const row = await this.labelQuery(trx, scope, options)
        .select((eb) => [eb.fn.countAll<number>().over().as('count'), 'asset.id as previewAssetId'])
        .orderBy(sql`smart_search.embedding <=> ${options.embedding}`)
        .limit(1)
        .executeTakeFirst();

      return { count: Number(row?.count ?? 0), previewAssetId: row?.previewAssetId ?? null };
    });
  }

  /** Assets within `maxDistance` of the label embedding, ordered by similarity. */
  async searchLabelAssets(pagination: PaginationOptions, options: BrowseLabelSearchOptions, scope: AssetSearchScope) {
    if (!z.int().min(1).max(1000).safeParse(pagination.take).success) {
      throw new Error(`Invalid value for 'take': ${pagination.take}`);
    }

    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Clip])}`.execute(trx);
      const items = await this.labelQuery(trx, scope, options)
        .select(columns.searchAsset)
        .orderBy(sql`smart_search.embedding <=> ${options.embedding}`)
        .orderBy('asset.id', 'asc')
        .limit(pagination.take + 1)
        .offset(pagination.skip ?? 0)
        .execute();
      return paginationHelper(items, pagination.take);
    });
  }

  private labelQuery(trx: Transaction<DB>, scope: AssetSearchScope, options: BrowseLabelSearchOptions) {
    return searchAssetBuilder(trx, {}, scope)
      .innerJoin('smart_search', 'asset.id', 'smart_search.assetId')
      .where(sql`smart_search.embedding <=> ${options.embedding}`, '<=', options.maxDistance)
      .where('asset.deletedAt', 'is', null);
  }
}
