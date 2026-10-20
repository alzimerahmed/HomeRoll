import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumResponseDto,
  AlbumStatisticsResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  MapAlbumDto,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
  mapAlbum,
} from 'src/dtos/album.dto.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto, isMetadataHidden } from 'src/dtos/auth.dto.js';
import { MapMarkerResponseDto } from 'src/dtos/map.dto.js';
import type { SmartAlbumRules } from 'src/dtos/smart-album.dto.js';
import { AlbumType, AlbumUserRole, Permission } from 'src/enum.js';
import { AlbumAssetCount } from 'src/repositories/album.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { findOrFail } from 'src/utils/misc.js';
import { getPreferences } from 'src/utils/preferences.js';

const MAX_ALBUM_DEPTH = 10;

const mapAlbumMetadata = (metadata?: AlbumAssetCount) => ({
  startDate: asDateTimeString(metadata?.startDate ?? undefined),
  endDate: asDateTimeString(metadata?.endDate ?? undefined),
  assetCount: metadata?.assetCount ?? 0,
  // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
  lastModifiedAssetTimestamp: asDateTimeString(metadata?.lastModifiedAssetTimestamp ?? undefined),
});

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll({ user: { id: ownerId } }: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId)
      : await this.albumRepository.getAll(ownerId, rest);

    if (albums.length === 0) {
      return [];
    }

    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(albums.map((album) => album.id));
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album) => ({
      ...mapAlbum(album),
      sharedLinks: undefined,
      ...mapAlbumMetadata(albumMetadata[album.id]),
    }));
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...(await this.mapWithMetadata(album)),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (isMetadataHidden(auth)) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id);
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumType = dto.albumType ?? (dto.rules ? AlbumType.Smart : AlbumType.Manual);
    if (albumType === AlbumType.Smart && !dto.rules) {
      throw new BadRequestException('Smart albums require rules');
    }
    if (dto.rules && albumType === AlbumType.Manual) {
      throw new BadRequestException('Cannot set rules on a manual album');
    }
    if (albumType === AlbumType.Smart && dto.assetIds && dto.assetIds.length > 0) {
      throw new BadRequestException('Smart album membership is rule-driven; assetIds are not allowed');
    }
    if (dto.parentId) {
      const ancestors = await this.validateParentId(auth, dto.parentId);
      if (ancestors.length + 1 > MAX_ALBUM_DEPTH) {
        throw new BadRequestException(`Albums cannot be nested more than ${MAX_ALBUM_DEPTH} levels deep`);
      }
    }

    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        parentId: dto.parentId ?? null,
        albumType,
        rules: albumType === AlbumType.Smart ? (dto.rules ?? null) : null,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    if (albumType === AlbumType.Smart && dto.rules) {
      await this.syncSmartAlbumAssets(album.id, auth.user.id, dto.rules);
    }

    return this.mapWithMetadata(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);

    // Structural changes modify the album owner's data; require ownership.
    // Permission.AlbumDelete is the owner-only album permission.
    if (dto.parentId !== undefined || dto.albumType !== undefined || dto.rules !== undefined) {
      await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    }

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }

    if (dto.parentId !== undefined && dto.parentId !== null && dto.parentId !== album.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('Cannot parent an album to itself');
      }
      const ancestors = await this.validateParentId(auth, dto.parentId);
      if (ancestors.includes(id)) {
        throw new BadRequestException('Cannot parent an album to one of its descendants');
      }
      const subtreeDepth = await this.albumRepository.getMaxSubtreeDepth(id);
      if (ancestors.length + 1 + subtreeDepth > MAX_ALBUM_DEPTH) {
        throw new BadRequestException(`Albums cannot be nested more than ${MAX_ALBUM_DEPTH} levels deep`);
      }
    }

    let recompute = false;
    let albumType = album.albumType;
    let rules = album.rules;
    if (dto.albumType !== undefined || dto.rules !== undefined) {
      albumType = dto.rules === null ? AlbumType.Manual : (dto.albumType ?? (dto.rules ? AlbumType.Smart : albumType));
      rules = albumType === AlbumType.Manual ? null : (dto.rules ?? (albumType === AlbumType.Smart ? rules : null));
      if (albumType === AlbumType.Smart && !rules) {
        throw new BadRequestException('Smart albums require rules');
      }
      recompute =
        albumType === AlbumType.Smart &&
        ((dto.rules !== undefined && dto.rules !== null) || album.albumType !== AlbumType.Smart);
    }

    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
        parentId: dto.parentId,
        albumType,
        rules,
      },
      auth.user.id,
    );

    if (recompute && rules) {
      const ownerId = this.getAlbumOwnerId(updatedAlbum) ?? auth.user.id;
      await this.syncSmartAlbumAssets(album.id, ownerId, rules);
      await this.albumRepository.updateThumbnails();
      return this.mapWithMetadata(await this.findOrFail(id, auth.user.id));
    }

    return this.mapWithMetadata(updatedAlbum);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });
    const album = await this.findOrFail(id, auth.user.id);
    if (album.albumType === AlbumType.Smart) {
      throw new BadRequestException('Cannot manually add assets to a smart album');
    }

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
    );

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id);
      // smart album membership is rule-driven; skip smart albums instead of failing the whole operation
      if (album.albumType === AlbumType.Smart) {
        continue;
      }
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);
    if (album.albumType === AlbumType.Smart) {
      throw new BadRequestException('Cannot manually remove assets from a smart album');
    }
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return this.mapWithMetadata(await this.findOrFail(id, auth.user.id));
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id);

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, userId);
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  /**
   * Recomputes the membership of a smart album from its stored rules.
   * Smart album rules are always evaluated against the album owner's assets.
   */
  async refreshSmartAlbum(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);
    if (album.albumType !== AlbumType.Smart || !album.rules) {
      throw new BadRequestException('Only smart albums can be refreshed');
    }

    const ownerId = this.getAlbumOwnerId(album) ?? auth.user.id;
    await this.syncSmartAlbumAssets(album.id, ownerId, album.rules);
    await this.albumRepository.updateThumbnails();

    return this.mapWithMetadata(await this.findOrFail(id, auth.user.id));
  }

  private findOrFail(id: string, authUserId: string) {
    return findOrFail(() => this.albumRepository.getById(id, authUserId), 'Album');
  }

  /**
   * Validates write access to a parent album candidate and returns its ancestor
   * chain (excluding the album itself), which callers use for cycle/depth checks.
   */
  private validateParentId(auth: AuthDto, parentId: string): Promise<string[]> {
    return this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [parentId] }).then(() =>
      this.albumRepository.getAncestorIds(parentId),
    );
  }

  private getAlbumOwnerId(album: MapAlbumDto): string | undefined {
    return album.albumUsers?.find(({ role }) => role === AlbumUserRole.Owner)?.user.id;
  }

  private async syncSmartAlbumAssets(albumId: string, ownerId: string, rules: SmartAlbumRules): Promise<void> {
    const assets = await this.albumRepository.getSmartAlbumAssetIds(albumId, ownerId, rules);
    await this.albumRepository.replaceAssets(
      albumId,
      assets.map(({ id }) => id),
    );
  }

  private async mapWithMetadata(album: MapAlbumDto): Promise<AlbumResponseDto> {
    const [metadata] = await this.albumRepository.getMetadataForIds([album.id]);
    return { ...mapAlbum(album), ...mapAlbumMetadata(metadata) };
  }
}
