import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * Per-asset image quality signals (FG-12, HomeRoll). One row per scored asset;
 * the row's existence doubles as the "scored" marker for the queue-all stream.
 * Not synced to clients — internal curation data.
 */
@Table('asset_quality')
export class AssetQualityTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: true })
  assetId!: string;

  /** Sharpness (normalized Laplacian variance), 0..1. */
  @Column({ type: 'double precision' })
  blur!: number;

  /** Exposure quality (clipping penalty), 0..1. */
  @Column({ type: 'double precision' })
  exposure!: number;

  /** Subject presence (face-based), 0..1. */
  @Column({ type: 'double precision' })
  subject!: number;

  /** Eyes-open signal, 0..1 — null until a dedicated model exists (ADR-017). */
  @Column({ type: 'double precision', nullable: true })
  eyesOpen!: number | null;

  /** Weighted overall score used for ranking, 0..1. */
  @Column({ type: 'double precision' })
  overall!: number;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
