import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
} from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * Web Push (RFC 8030) subscriptions (FG-11). Not synced to clients — no
 * updateId/createId columns, matching `cluster_group_request` conventions.
 */
@Table('push_subscription')
export class PushSubscriptionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  userId!: string;

  /** Push service endpoint URL; unique per subscription. */
  @Column({ type: 'text', unique: true })
  endpoint!: string;

  /** Subscriber public key (base64url, uncompressed P-256 point). */
  @Column({ type: 'text' })
  p256dh!: string;

  /** Subscriber auth secret (base64url). */
  @Column({ type: 'text' })
  auth!: string;

  @Column({ type: 'text', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
