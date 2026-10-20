import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  type Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import type { SmartAlbumRules } from 'src/dtos/smart-album.dto.js';
import { AlbumType, AssetOrder } from 'src/enum.js';
import { album_type_enum } from 'src/schema/enums.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table({ name: 'album' })
@UpdatedAtTrigger('album_updatedAt')
export class AlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ default: 'Untitled Album' })
  albumName!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => AssetTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    comment: 'Asset ID to be used as thumbnail',
  })
  albumThumbnailAssetId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'boolean', default: true })
  isActivityEnabled!: Generated<boolean>;

  @Column({ default: AssetOrder.Desc })
  order!: Generated<AssetOrder>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @ForeignKeyColumn(() => AlbumTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    index: true,
    comment: 'Parent album ID for nested albums',
  })
  parentId!: string | null;

  @Column({ enum: album_type_enum, default: AlbumType.Manual })
  albumType!: Generated<AlbumType>;

  @Column({ type: 'jsonb', nullable: true })
  rules!: SmartAlbumRules | null;
}
