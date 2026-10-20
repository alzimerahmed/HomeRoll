import { Injectable } from '@nestjs/common';
import type { Insertable, Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { PushSubscriptionTable } from 'src/schema/tables/push-subscription.table.js';

/**
 * Push subscription persistence (FG-11).
 * No @GenerateSql decorators: generated SQL files are committed artifacts
 * produced by `bin/sync-sql.ts` in CI, not by hand.
 */
@Injectable()
export class PushRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getByUserId(userId: string) {
    return this.db
      .selectFrom('push_subscription')
      .selectAll()
      .where('userId', '=', userId)
      .orderBy('createdAt', 'desc')
      .execute();
  }

  getByUserIds(userIds: string[]) {
    if (userIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db.selectFrom('push_subscription').selectAll().where('userId', 'in', userIds).execute();
  }

  /**
   * Insert or refresh a subscription keyed on its endpoint. When the same
   * endpoint is re-registered (browser resubscribe, or a different account on
   * the same browser profile), ownership and keys are updated in place.
   */
  upsert(subscription: Insertable<PushSubscriptionTable>) {
    return this.db
      .insertInto('push_subscription')
      .values(subscription)
      .onConflict((oc) =>
        oc.column('endpoint').doUpdateSet({
          userId: subscription.userId,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          userAgent: subscription.userAgent,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Owner-scoped unsubscribe. */
  async delete(userId: string, endpoint: string) {
    await this.db
      .deleteFrom('push_subscription')
      .where('userId', '=', userId)
      .where('endpoint', '=', endpoint)
      .execute();
  }

  /** Unscoped removal for dead endpoints (404/410 from the push service). */
  async deleteByEndpoint(endpoint: string) {
    await this.db.deleteFrom('push_subscription').where('endpoint', '=', endpoint).execute();
  }
}
