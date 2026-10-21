import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * Per-asset image quality signals (FG-12, HomeRoll). One row per scored asset;
 * the row's existence doubles as the "scored" marker for the queue-all stream.
 * Not synced to clients — internal curation data.
 */
@UpdatedAtTrigger('asset_quality_updatedAt')
@Index({ columns: ['assetId'], unique: true })
@Table('asset_quality')
export class AssetQualityTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // one quality row per asset — the unique index backs the upsert's onConflict
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  /** Sharpness (normalized Laplacian variance), 0..1. */
  @Column({ type: 'double precision', comment: 'Sharpness (normalized Laplacian variance), 0..1' })
  blur!: number;

  /** Exposure quality (clipping penalty), 0..1. */
  @Column({ type: 'double precision', comment: 'Exposure quality (clipping penalty), 0..1' })
  exposure!: number;

  /** Subject presence (face-based), 0..1. */
  @Column({ type: 'double precision', comment: 'Subject presence (face-based), 0..1' })
  subject!: number;

  /** Eyes-open signal, 0..1 — null until a dedicated model exists (ADR-017). */
  @Column({ type: 'double precision', nullable: true, comment: 'Eyes-open signal, 0..1 — null until a dedicated model exists' })
  eyesOpen!: number | null;

  /** Weighted overall score used for ranking, 0..1. */
  @Column({ type: 'double precision', comment: 'Weighted overall score used for ranking, 0..1' })
  overall!: number;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;
}
